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
import { readComposeInputWithinCap } from './composeInputReadSink';

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
  'docker-compose.yml',
  'docker-compose.yaml',
] as const;

/**
 * Auto-discovered override names, in Compose's own order. The `docker-compose`
 * family and both override pairs prefer `.yml` over `.yaml`; only the
 * `compose.yaml` base name prefers `.yaml`.
 */
const DISCOVERED_OVERRIDE_NAMES = [
  'compose.override.yml',
  'compose.override.yaml',
  'docker-compose.override.yml',
  'docker-compose.override.yaml',
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
  // A document with syntax errors is Compose's to report. Its parser stops on
  // them too, so there is no expansion to measure.
  if (doc.errors.length > 0) return;
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

async function firstExisting(cwd: string, names: readonly string[]): Promise<string | null> {
  for (const name of names) {
    const candidate = path.resolve(cwd, name);
    // Canonical inline js/path-injection barrier at the access sink: the
    // candidate must stay inside the directory Compose is invoked in. The name
    // is a constant, so this only states the invariant CodeQL cannot infer.
    if (!candidate.startsWith(cwd + path.sep)) continue;
    try {
      await fsPromises.access(candidate);
      return candidate;
    } catch {
      // The next candidate is the one Compose would pick.
    }
  }
  return null;
}

/**
 * The files Compose will read for this invocation. Naming any `-f` file turns
 * off Compose's discovery, override included, so an explicit list is measured
 * exactly as given. With no `-f`, Compose selects the first existing base name
 * and the first existing override name; a same-named file it does not select is
 * not read here either.
 */
async function resolveInputFiles(cwd: string, explicitFiles: readonly string[]): Promise<string[]> {
  if (explicitFiles.length > 0) {
    return explicitFiles.map((file) => path.resolve(cwd, file));
  }
  const base = await firstExisting(cwd, DISCOVERED_COMPOSE_NAMES);
  if (!base) return [];
  const override = await firstExisting(cwd, DISCOVERED_OVERRIDE_NAMES);
  return override ? [base, override] : [base];
}

/**
 * Read at most the source cap from one file inside `allowedRoot`. The byte-level
 * read lives in `composeInputReadSink`; this function owns the containment
 * decision and the refusal, so the guard's own module shapes the message.
 */
async function readIfRegularFile(filePath: string, label: string, allowedRoot: string): Promise<string | null> {
  // Canonical inline js/path-injection barrier, kept in the same scope as the
  // filesystem access below. CodeQL credits a check that dominates the sink and
  // not one separated from it by a function boundary, so the resolution and the
  // containment test are repeated here even though the caller also validates.
  const target = path.resolve(filePath);
  if (!target.startsWith(allowedRoot + path.sep)) return null;

  const read = await readComposeInputWithinCap(target, MAX_COMPOSE_INPUT_BYTES);
  if (read.tooLarge) throw sizeRefusalForFile(label);
  return read.content;
}

/**
 * Refuse to run Docker Compose when one of the files it will read expands past
 * the alias budget. `files` are the invocation's `-f` values (relative to
 * `cwd`); an empty list means Compose discovers its own files.
 *
 * Only a regular file is read. A missing or non-regular input is left for
 * Compose to report, so an ordinary broken stack fails exactly as it did.
 *
 * The measurement is taken immediately before the caller spawns Compose, but a
 * file rewritten in the gap between the two is not re-checked. A writer who can
 * replace a stack's files can also write a bomb into them directly, which no
 * in-process check can prevent.
 */
export async function assertComposeInputsWithinExpansionLimits(opts: {
  cwd: string;
  files?: readonly string[];
}): Promise<void> {
  const cwd = path.resolve(opts.cwd);
  for (const filePath of await resolveInputFiles(cwd, opts.files ?? [])) {
    const label = path.relative(cwd, filePath) || path.basename(filePath);
    const content = await readIfRegularFile(filePath, label, cwd);
    if (content === null) continue;
    assertComposeSourceWithinExpansionLimits(content, label);
  }
}
