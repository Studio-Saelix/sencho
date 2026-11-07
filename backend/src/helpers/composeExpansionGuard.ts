/**
 * Refuse a compose file before Docker Compose expands its YAML aliases.
 *
 * `docker compose` resolves every alias into a full structure, with no bound
 * on the result. A small file whose anchors reference each other (a "billion
 * laughs" file) therefore makes the CLI allocate until the host runs out of
 * memory: the reported symptom is a node that freezes and stays unreachable
 * until it is rebooted, then freezes again on the next render because the file
 * is still on disk.
 *
 * This module reads the top-level files the invocation names, the same inputs
 * the CLI is handed, and counts the nodes their expansion produces using the
 * `yaml` package's AST. That package keeps alias targets as shared references
 * instead of copying them, so the count is linear in the file and never
 * materializes the expansion itself. A file over the budget is refused with a
 * clear message and the CLI is never started.
 *
 * Only alias expansion is measured. A syntax error or a missing file is left
 * for Compose to report, so this guard never changes how an ordinary broken
 * stack fails.
 */
import { promises as fsPromises } from 'fs';
import path from 'path';
import { isAlias, isCollection, isPair, parseDocument, visit } from 'yaml';
import type { Document, Node } from 'yaml';

/**
 * Expanded-node budget per file. A compose file that reuses an anchor across a
 * few hundred services stays well below this; a nested alias bomb passes it by
 * many orders of magnitude (the reported file reaches 9^12 nodes).
 */
export const MAX_EXPANDED_NODES = 250_000;

/**
 * Source cap for one input. A compose file this large is already unusable, and
 * refusing it keeps the read itself bounded.
 */
export const MAX_COMPOSE_INPUT_BYTES = 16 * 1024 * 1024;

/** Compose's auto-discovery names, in the order Compose looks for them. */
const DISCOVERED_COMPOSE_NAMES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
] as const;

/** Auto-discovered override names, matching FileSystemService and Compose. */
const DISCOVERED_OVERRIDE_NAMES = [
  'compose.override.yaml',
  'compose.override.yml',
  'docker-compose.override.yaml',
  'docker-compose.override.yml',
] as const;

/** Raised when an input cannot be handed to Docker Compose safely. */
export class ComposeExpansionRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComposeExpansionRefusal';
  }
}

function refusalForFile(label: string): ComposeExpansionRefusal {
  return new ComposeExpansionRefusal(
    `Compose file "${label}" expands to more than ${MAX_EXPANDED_NODES.toLocaleString('en-US')} nodes through nested YAML aliases. ` +
    'Docker Compose expands aliases without a limit and can run the host out of memory, so Sencho refused to run it. ' +
    'Remove the alias chain or split the file so services do not reuse the same nested anchors.',
  );
}

function sizeRefusalForFile(label: string): ComposeExpansionRefusal {
  return new ComposeExpansionRefusal(
    `Compose file "${label}" is larger than ${MAX_COMPOSE_INPUT_BYTES / (1024 * 1024)} MiB, so Sencho did not hand it to Docker Compose. ` +
    'Split it into smaller files or reduce its size, then try again.',
  );
}

function saturateAdd(total: number, amount: number): number {
  const sum = total + amount;
  return sum > MAX_EXPANDED_NODES ? MAX_EXPANDED_NODES + 1 : sum;
}

/**
 * Resolve every alias to the node it names in one document-order pass. The
 * `yaml` library re-walks the document for each alias when no cache is passed,
 * so a file with many aliases would otherwise cost more in this guard than in
 * Compose. Anchor names can be reused, and only the last definition before the
 * alias counts, hence the single ordered walk.
 */
function resolveAliasTargets(doc: Document): Map<Node, Node> {
  const targets = new Map<Node, Node>();
  const lastByName = new Map<string, Node>();
  visit(doc, {
    Node: (_key, node) => {
      if (isAlias(node)) {
        const target = lastByName.get(node.source);
        if (target) targets.set(node, target);
      } else {
        const anchor = node.anchor;
        if (typeof anchor === 'string' && anchor.length > 0) lastByName.set(anchor, node);
      }
    },
  });
  return targets;
}

/**
 * Count the nodes one value expands to, saturating just past the budget so a
 * bomb is rejected without computing its full size. Sizes are memoized per
 * node, which keeps the walk linear over the shared (DAG) structure.
 */
function countExpandedNodes(
  item: unknown,
  targets: Map<Node, Node>,
  sizes: Map<object, number>,
  active: Set<object>,
): number {
  if (!item || typeof item !== 'object') return 1;

  if (isAlias(item)) {
    const target = targets.get(item);
    // An unresolved alias is Compose's error to report, not a bomb.
    if (!target) return 1;
    return countExpandedNodes(target, targets, sizes, active);
  }

  const cached = sizes.get(item);
  if (cached !== undefined) return cached;
  // Valid YAML cannot be cyclic (an anchor resolves from a previous node), but
  // a malformed structure must not spin here.
  if (active.has(item)) return MAX_EXPANDED_NODES + 1;

  active.add(item);
  let total = 1;
  try {
    if (isPair(item)) {
      total = saturateAdd(
        countExpandedNodes(item.key, targets, sizes, active),
        countExpandedNodes(item.value, targets, sizes, active),
      );
    } else if (isCollection(item)) {
      for (const child of item.items) {
        total = saturateAdd(total, countExpandedNodes(child, targets, sizes, active));
        if (total > MAX_EXPANDED_NODES) break;
      }
    }
    // A scalar, or a node shape this walk does not model, is one node.
  } finally {
    active.delete(item);
  }
  sizes.set(item, total);
  return total;
}

/**
 * Throw when one compose source expands past the budget. A source that does
 * not parse is left alone: Compose reports its own syntax error.
 */
export function assertComposeSourceWithinExpansionLimits(source: string, label: string): void {
  const doc = parseDocument(source, { prettyErrors: false });
  const root = doc.contents;
  if (!root) return;
  const targets = resolveAliasTargets(doc);
  const expanded = countExpandedNodes(root, targets, new Map(), new Set());
  if (expanded > MAX_EXPANDED_NODES) {
    throw refusalForFile(label);
  }
}

/** `-f` / `--file` values of a Compose invocation, in order. */
export function composeFileArgsFromInvocation(invocation: readonly string[]): string[] {
  const files: string[] = [];
  for (let i = 0; i < invocation.length; i += 1) {
    const arg = invocation[i];
    if (arg === '-f' || arg === '--file') {
      const next = invocation[i + 1];
      if (next) files.push(next);
      i += 1;
    } else if (arg.startsWith('--file=')) {
      files.push(arg.slice('--file='.length));
    }
  }
  return files;
}

/**
 * The files Compose will read for this invocation: the explicit `-f` values,
 * or its auto-discovery names when none is named (plus the default override,
 * which Compose still loads next to a default base file).
 */
function resolveInputFiles(cwd: string, explicitFiles: readonly string[]): string[] {
  if (explicitFiles.length === 0) {
    return [...DISCOVERED_COMPOSE_NAMES, ...DISCOVERED_OVERRIDE_NAMES]
      .map((name) => path.resolve(cwd, name));
  }
  const resolved = explicitFiles.map((file) => path.resolve(cwd, file));
  const namesSingleDefaultBase = explicitFiles.length === 1
    && (DISCOVERED_COMPOSE_NAMES as readonly string[]).includes(path.basename(explicitFiles[0]));
  if (namesSingleDefaultBase) {
    for (const name of DISCOVERED_OVERRIDE_NAMES) {
      const candidate = path.resolve(cwd, name);
      if (!resolved.includes(candidate)) resolved.push(candidate);
    }
  }
  return resolved;
}

const SKIPPABLE_READ_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM']);

async function readIfRegularFile(filePath: string, label: string): Promise<string | null> {
  let stat: Awaited<ReturnType<typeof fsPromises.stat>>;
  try {
    stat = await fsPromises.stat(filePath);
  } catch (err) {
    // An input this process cannot stat is one Compose will report on its own;
    // the guard never turns an ordinary file error into a render failure.
    if (SKIPPABLE_READ_ERRORS.has((err as NodeJS.ErrnoException).code ?? '')) return null;
    throw err;
  }
  if (!stat.isFile()) return null;
  // Checked before the read so a huge file is refused without allocating it.
  if (stat.size > MAX_COMPOSE_INPUT_BYTES) throw sizeRefusalForFile(label);
  let content: string;
  try {
    content = await fsPromises.readFile(filePath, 'utf8');
  } catch (err) {
    if (SKIPPABLE_READ_ERRORS.has((err as NodeJS.ErrnoException).code ?? '')) return null;
    throw err;
  }
  // The file can grow between the stat and the read; bound what was actually read.
  if (Buffer.byteLength(content, 'utf8') > MAX_COMPOSE_INPUT_BYTES) throw sizeRefusalForFile(label);
  return content;
}

/**
 * Refuse to run Docker Compose when one of the files it will read expands past
 * the alias budget. `files` are the invocation's `-f` values (relative to
 * `cwd`); an empty list means Compose discovers its own files.
 *
 * Only a regular file is read. A missing or non-regular input is left for
 * Compose to report, so an ordinary broken stack fails exactly as it did.
 */
export async function assertComposeInputsWithinExpansionLimits(opts: {
  cwd: string;
  files?: readonly string[];
}): Promise<void> {
  const cwd = path.resolve(opts.cwd);
  for (const filePath of resolveInputFiles(cwd, opts.files ?? [])) {
    const label = path.relative(cwd, filePath) || path.basename(filePath);
    const content = await readIfRegularFile(filePath, label);
    if (content === null) continue;
    assertComposeSourceWithinExpansionLimits(content, label);
  }
}
