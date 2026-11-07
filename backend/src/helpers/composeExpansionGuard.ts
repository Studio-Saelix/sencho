/**
 * Refuse a compose input before Docker Compose expands its YAML aliases.
 *
 * `docker compose` resolves every alias into a full structure, with no bound
 * on the result. A small file whose anchors reference each other (a "billion
 * laughs" file) therefore makes the CLI allocate until the host runs out of
 * memory: the reported symptom is a node that freezes and stays unreachable
 * until it is rebooted, then freezes again on the next render because the file
 * is still on disk.
 *
 * This module measures the files the invocation will hand to the CLI: the
 * `-f` files or, when none are named, the files Compose selects from
 * `COMPOSE_FILE` or its own discovery. It then follows the whole YAML
 * dependency graph Compose loads from them (`include:` and `extends.file`),
 * resolving paths in the same project directory Compose uses. It counts the
 * nodes each document expands to using the `yaml` package's AST. That package
 * keeps alias targets as shared references instead of copying them, so the
 * count is linear in the file and an over-budget expansion is refused before
 * it is materialized. A file over the budget is refused with a clear message
 * and the CLI is never started.
 *
 * Only alias expansion is measured. A syntax error or a missing file is left
 * for Compose to report, so this guard never changes how an ordinary broken
 * stack fails.
 */
import { createHash } from 'crypto';
import path from 'path';
import { isAlias, isCollection, isPair, parseAllDocuments, visit } from 'yaml';
import type { Document, Node } from 'yaml';
import {
  ComposeEnvFileError,
  ComposeEnvFiles,
  DEFAULT_PATH_SEPARATOR,
  expandComposeEnvTemplate,
  type ComposeEnvLookup,
} from '../utils/composeDotenv';
import { readComposeInputWithinCap } from './composeInputReadSink';

/**
 * Expanded-node budget per file. A compose file that reuses an anchor across a
 * few hundred services stays well below this; a nested alias bomb passes it by
 * many orders of magnitude (the reported file reaches 9^12 nodes).
 */
export const MAX_EXPANDED_NODES = 250_000;

/**
 * Expanded-node budget for one invocation across every input it resolves.
 * Compose merges all its inputs into one model, so a project of many
 * individually-acceptable files still grows with their sum; this bound keeps a
 * large graph from handing the CLI an unbounded total. Ordinary multi-file
 * stacks stay far below it.
 */
export const MAX_TOTAL_EXPANDED_NODES = MAX_EXPANDED_NODES * 4;

/**
 * Source cap for one input. A compose file this large is already unusable, and
 * refusing it keeps the read itself bounded.
 */
export const MAX_COMPOSE_INPUT_BYTES = 16 * 1024 * 1024;

/**
 * Bounds on the include/extends graph. An ordinary project is far below both;
 * a graph beyond them cannot be established safely, so it is refused rather
 * than walked without a limit.
 */
export const MAX_COMPOSE_DEPENDENCY_DEPTH = 32;
export const MAX_COMPOSE_DEPENDENCY_FILES = 512;

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

function totalRefusalForFile(label: string): ComposeExpansionRefusal {
  return new ComposeExpansionRefusal(
    `The compose inputs for this run expand to more than ${MAX_TOTAL_EXPANDED_NODES.toLocaleString('en-US')} nodes in total through nested YAML aliases, ` +
    `and "${label}" is the file that crossed the limit. Docker Compose expands aliases without a limit and can run the host out of memory, ` +
    'so Sencho refused to run it. Remove the alias chains or split the project so services do not reuse the same nested anchors.',
  );
}

function envFileRefusal(label: string): ComposeExpansionRefusal {
  return new ComposeExpansionRefusal(
    `Sencho could not read the env file "${label}" the way Docker Compose does, so it could not determine which compose files the run would load. ` +
    'Fix the env file, then try again.',
  );
}

function dependencyRefusal(label: string, detail: string): ComposeExpansionRefusal {
  return new ComposeExpansionRefusal(
    `Compose file "${label}" ${detail} Docker Compose expands aliases without a limit and can run the host out of memory, ` +
    'so Sencho refused to run a file whose expansion it cannot bound.',
  );
}

function remoteDependencyRefusal(label: string, kind: 'include' | 'extends'): ComposeExpansionRefusal {
  // The URL itself is not repeated: an include URL can carry credentials, and
  // this message reaches API and Doctor surfaces.
  return dependencyRefusal(
    label,
    `has a remote ${kind} that Sencho cannot read before Docker Compose does. ` +
    'Vendor the file beside the compose file and reference it locally.',
  );
}

function dependencyBoundRefusal(label: string, bound: string): ComposeExpansionRefusal {
  return dependencyRefusal(label, `crosses ${bound}.`);
}

function saturateAt(total: number, amount: number, limit: number): number {
  const sum = total + amount;
  return sum > limit ? limit + 1 : sum;
}

function saturateAdd(total: number, amount: number): number {
  return saturateAt(total, amount, MAX_EXPANDED_NODES);
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
 * not parse is left alone: Compose reports its own syntax error, and a parser
 * that stops on the stream never expands it.
 *
 * Compose accepts a stream of YAML documents, so every document is measured
 * and the file's budget covers their sum. A parser mismatch is never treated
 * as a safe syntax failure: this uses the same document-stream parser Compose
 * does, not a single-document one. Compose expands each valid document as it
 * reaches it, so a document before the first parse error is still measured;
 * the error itself and everything after it stop the stream.
 */
export function assertComposeSourceWithinExpansionLimits(source: string, label: string): void {
  const documents = parseAllDocuments(source, { prettyErrors: false, merge: true });
  let expanded = 0;
  for (const doc of documents) {
    if (doc.errors.length > 0) break;
    if (!doc.contents) continue;
    const targets = resolveAliasTargets(doc);
    expanded = saturateAdd(expanded, countExpandedNodes(doc.contents, targets, new Map(), new Set()));
    if (expanded > MAX_EXPANDED_NODES) throw refusalForFile(label);
  }
}

/** `-f` / `--file` values of a Compose invocation, in order. */
export function composeFileArgsFromInvocation(invocation: readonly string[]): string[] {
  return flagValues(invocation, '-f', '--file');
}

/** Values of one Compose global flag, in order, for `--flag value` and `--flag=value`. */
function flagValues(invocation: readonly string[], short: string, long: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < invocation.length; i += 1) {
    const arg = invocation[i];
    if (arg === short || arg === long) {
      const next = invocation[i + 1];
      if (next !== undefined && next !== '') values.push(next);
      i += 1;
    } else if (arg.startsWith(`${long}=`)) {
      const value = arg.slice(long.length + 1);
      if (value !== '') values.push(value);
    }
  }
  return values;
}

function lastFlagValue(invocation: readonly string[], long: string): string | undefined {
  const values = flagValues(invocation, long, long);
  return values.length > 0 ? values[values.length - 1] : undefined;
}

/** The interpolation environment Compose builds from a run's env files. */
interface GuardEnvContext {
  /** Process-level environment, which Compose always puts above file values. */
  processEnv: ComposeEnvLookup;
  /** Values the env files assigned, in read order (later files win). */
  values: Map<string, string>;
}

interface EnvFileText {
  text: string;
  label: string;
}

function lookupEnv(context: GuardEnvContext): ComposeEnvLookup {
  return (name) => {
    const fromProcess = context.processEnv(name);
    return fromProcess !== undefined ? fromProcess : context.values.get(name);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function asStringList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) {
    return value.map(asString).filter((item): item is string => item !== undefined);
  }
  return [];
}

/**
 * Add env files to an inherited environment. Compose lets the environment a
 * run already has win: a project `.env` (included projects included) and an
 * include entry's `env_file` only supply names that were not set before them.
 * Files added here still resolve references through the environment earlier
 * files and lines built, the same way Compose reads them.
 */
function withAdditionalEnvFiles(context: GuardEnvContext, contents: readonly EnvFileText[]): GuardEnvContext {
  if (contents.length === 0) return context;
  const reader = new ComposeEnvFiles(lookupEnv(context));
  for (const entry of contents) {
    try {
      reader.read(entry.text);
    } catch (err) {
      if (err instanceof ComposeEnvFileError) throw envFileRefusal(entry.label);
      throw err;
    }
  }
  const child: GuardEnvContext = {
    processEnv: context.processEnv,
    values: new Map(context.values),
  };
  const inherited = lookupEnv(context);
  for (const name of reader.assignedNames()) {
    if (inherited(name) === undefined) {
      const value = reader.assigned(name);
      if (value !== undefined) child.values.set(name, value);
    }
  }
  return child;
}

/** Parse a Go boolean the way Compose checks COMPOSE_DISABLE_ENV_FILE. */
function parseGoBoolean(raw: string): boolean | null {
  switch (raw) {
    case '1': case 't': case 'T': case 'TRUE': case 'true': case 'True':
      return true;
    case '0': case 'f': case 'F': case 'FALSE': case 'false': case 'False':
      return false;
    default:
      return null;
  }
}

/** Read one env input, or null when it is missing or not a regular file. */
async function readEnvFileEntry(filePath: string, label: string): Promise<EnvFileText | null> {
  const read = await readComposeInputWithinCap(filePath, MAX_COMPOSE_INPUT_BYTES);
  if (read.tooLarge) throw sizeRefusalForFile(label);
  if (read.content === null) return null;
  return { text: read.content, label };
}

interface LoadedSelectionEnv {
  context: GuardEnvContext;
  /** True when --env-file or COMPOSE_ENV_FILES picked the sources. */
  explicitSources: boolean;
  /**
   * True when the process environment disables Compose's own `.env` file. The
   * selected compose inputs are still read, and an included project's `.env`
   * is still loaded; only the top-level project `.env` is skipped.
   */
  disabled: boolean;
}

/**
 * Load the env files Compose reads before it selects the compose files: an
 * explicit `--env-file` list, then `COMPOSE_ENV_FILES`, then the project
 * directory's `.env`. A missing explicit file means Compose stops before it
 * reads any compose file, so there is nothing to measure. An invalid
 * COMPOSE_DISABLE_ENV_FILE value stops Compose the same way.
 */
async function loadSelectionEnv(
  cwd: string,
  selectionBase: string,
  envFileArgs: readonly string[],
  processEnv: ComposeEnvLookup,
): Promise<LoadedSelectionEnv | null> {
  const sources: Array<{ path: string; label: string; required: boolean }> = [];
  let explicitSources = false;
  if (envFileArgs.length > 0) {
    explicitSources = true;
    for (const file of envFileArgs) {
      sources.push({ path: path.resolve(cwd, file), label: file, required: true });
    }
  } else {
    const listed = (processEnv('COMPOSE_ENV_FILES') ?? '').split(',').filter((entry) => entry.length > 0);
    if (listed.length > 0) {
      explicitSources = true;
      for (const file of listed) {
        sources.push({ path: path.resolve(cwd, file), label: file, required: true });
      }
    } else {
      const disabledRaw = processEnv('COMPOSE_DISABLE_ENV_FILE');
      if (disabledRaw !== undefined) {
        const disabled = parseGoBoolean(disabledRaw);
        // An unparsable value makes Compose fail before it reads a compose
        // file. A valid `true` only skips the `.env`; Compose still selects and
        // reads the compose files, so they must still be measured.
        if (disabled === null) return null;
        if (disabled) {
          return {
            context: { processEnv, values: new Map() },
            explicitSources: false,
            disabled: true,
          };
        }
      }
      sources.push({ path: path.resolve(selectionBase, '.env'), label: '.env', required: false });
    }
  }

  const contents: EnvFileText[] = [];
  for (const source of sources) {
    const entry = await readEnvFileEntry(source.path, source.label);
    if (entry === null) {
      if (source.required) return null;
      continue;
    }
    contents.push(entry);
  }
  const base: GuardEnvContext = { processEnv, values: new Map() };
  return { context: withAdditionalEnvFiles(base, contents), explicitSources, disabled: false };
}

/**
 * True when a path names a remote include (`https://…`). It cannot be read
 * locally, so its expansion cannot be bounded.
 */
function isRemotePath(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}

function resolveDependencyPath(value: string, base: string): string {
  // A `~` prefix is a literal directory name to Compose's loader, not a home
  // reference, so it is resolved against the project base like any relative path.
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(base, value);
}

/** Interpolate one path declaration; null means Compose fails on it too. */
function interpolatePath(raw: string, context: GuardEnvContext): string | null {
  try {
    return expandComposeEnvTemplate(raw, lookupEnv(context));
  } catch (err) {
    if (err instanceof ComposeEnvFileError) return null;
    throw err;
  }
}

interface IncludeGroup {
  kind: 'include';
  paths: string[];
  envFiles: string[];
  projectDirectory: string | null;
}

interface ExtendsGroup {
  kind: 'extends';
  paths: string[];
}

type DependencyGroup = IncludeGroup | ExtendsGroup;

/**
 * Read the include/extends declarations from one parsed document. Returns null
 * when the document cannot be decoded: an unresolved alias or merge makes
 * Compose fail that document too, so it never expands it.
 */
function dependencyGroups(doc: Document): DependencyGroup[] | null {
  let data: unknown;
  try {
    // The expansion was already bounded above, so materializing it cannot
    // exceed the budget; disabling the library's alias cap keeps an ordinary
    // file with many anchors from turning into a false error.
    data = doc.toJS({ maxAliasCount: -1 });
  } catch {
    return null;
  }
  if (!isRecord(data)) return [];

  const groups: DependencyGroup[] = [];
  if (data.include !== undefined) {
    const entries = Array.isArray(data.include) ? data.include : [data.include];
    for (const entry of entries) {
      if (typeof entry === 'string') {
        groups.push({ kind: 'include', paths: [entry], envFiles: [], projectDirectory: null });
        continue;
      }
      if (!isRecord(entry)) continue;
      const paths = asStringList(entry.path);
      if (paths.length === 0) continue;
      groups.push({
        kind: 'include',
        paths,
        envFiles: asStringList(entry.env_file),
        projectDirectory: asString(entry.project_directory) ?? null,
      });
    }
  }

  if (isRecord(data.services)) {
    for (const service of Object.values(data.services)) {
      if (!isRecord(service) || !isRecord(service.extends)) continue;
      const file = service.extends.file;
      if (typeof file === 'string' && file.length > 0) {
        groups.push({ kind: 'extends', paths: [file] });
      }
    }
  }
  return groups;
}

interface ResolvedInputFile {
  path: string;
  /** Content already read during discovery, to avoid a second read. */
  content?: string;
}

interface PendingInput {
  path: string;
  /** Directory include/extends declarations in this file resolve against. */
  projectBase: string;
  env: GuardEnvContext;
  depth: number;
  content?: string;
}

function inputLabel(cwd: string, filePath: string): string {
  return path.relative(cwd, filePath) || path.basename(filePath);
}

/**
 * The parts of a file's traversal context that can change which dependencies it
 * declares. The same file reached twice with a different environment or
 * project directory is a different set of inputs, so it is not deduplicated.
 * The values are hashed rather than kept as text: a large env file read for a
 * project with many includes must not be duplicated once per visited file.
 */
function inputContextKey(filePath: string, projectBase: string, env: GuardEnvContext): string {
  const digest = createHash('sha256');
  digest.update(filePath);
  digest.update('\0');
  digest.update(projectBase);
  for (const [name, value] of env.values) {
    digest.update('\0');
    digest.update(name);
    digest.update('\0');
    digest.update(value);
  }
  return digest.digest('base64url');
}

/** Read the first auto-discovered input that exists, as Compose would. */
async function firstDiscoveredInput(base: string, names: readonly string[]): Promise<ResolvedInputFile | null> {
  for (const name of names) {
    const candidate = path.resolve(base, name);
    const read = await readComposeInputWithinCap(candidate, MAX_COMPOSE_INPUT_BYTES);
    if (read.tooLarge) throw sizeRefusalForFile(name);
    if (read.content !== null) return { path: candidate, content: read.content };
  }
  return null;
}

/** The files Compose discovers when the invocation names none. */
async function discoverInputFiles(base: string): Promise<ResolvedInputFile[]> {
  const baseFile = await firstDiscoveredInput(base, DISCOVERED_COMPOSE_NAMES);
  if (!baseFile) return [];
  const override = await firstDiscoveredInput(base, DISCOVERED_OVERRIDE_NAMES);
  return override ? [baseFile, override] : [baseFile];
}

/**
 * Walk the selected inputs and every YAML dependency they declare, refusing a
 * file whose expansion passes the budget and a dependency graph that cannot be
 * resolved within the traversal bounds.
 */
async function assertInputClosure(args: {
  cwd: string;
  rootEnv: GuardEnvContext;
  projectDir: string;
  files: readonly ResolvedInputFile[];
}): Promise<void> {
  const queue: PendingInput[] = args.files.map((file) => ({
    path: file.path,
    projectBase: args.projectDir,
    env: args.rootEnv,
    depth: 0,
    content: file.content,
  }));
  const visited = new Set<string>();
  let totalExpanded = 0;

  while (queue.length > 0) {
    const input = queue.shift() as PendingInput;
    const filePath = path.resolve(input.path);
    const contextKey = inputContextKey(filePath, input.projectBase, input.env);
    if (visited.has(contextKey)) continue;
    visited.add(contextKey);
    const label = inputLabel(args.cwd, filePath);
    if (visited.size > MAX_COMPOSE_DEPENDENCY_FILES) {
      throw dependencyBoundRefusal(label, `more than ${MAX_COMPOSE_DEPENDENCY_FILES} resolved compose inputs`);
    }
    if (input.depth > MAX_COMPOSE_DEPENDENCY_DEPTH) {
      throw dependencyBoundRefusal(label, `an include/extends chain deeper than ${MAX_COMPOSE_DEPENDENCY_DEPTH}`);
    }

    let content = input.content;
    if (content === undefined) {
      const read = await readComposeInputWithinCap(filePath, MAX_COMPOSE_INPUT_BYTES);
      if (read.tooLarge) throw sizeRefusalForFile(label);
      // Missing, unreadable as a file, or a non-regular input: Compose reports
      // it next, so there is no expansion to measure here.
      if (read.content === null) continue;
      content = read.content;
    }

    const documents = parseAllDocuments(content, { prettyErrors: false, merge: true });
    // Compose expands a valid document as it reaches it and stops at the first
    // document it cannot parse. Measuring up to that point catches a bomb in
    // an earlier document, which Compose expands before it reports the later
    // syntax error; a bomb after the error is never reached.
    let expanded = 0;
    for (const doc of documents) {
      if (doc.errors.length > 0) break;
      if (!doc.contents) continue;
      const targets = resolveAliasTargets(doc);
      expanded = saturateAdd(expanded, countExpandedNodes(doc.contents, targets, new Map(), new Set()));
      if (expanded > MAX_EXPANDED_NODES) throw refusalForFile(label);
    }
    totalExpanded = saturateAt(totalExpanded, expanded, MAX_TOTAL_EXPANDED_NODES);
    if (totalExpanded > MAX_TOTAL_EXPANDED_NODES) throw totalRefusalForFile(label);

    for (const doc of documents) {
      if (doc.errors.length > 0) break;
      const groups = dependencyGroups(doc);
      if (groups === null) continue;
      for (const group of groups) {
        if (group.kind === 'extends') {
          for (const raw of group.paths) {
            const target = interpolatePath(raw, input.env);
            if (target === null) continue;
            if (isRemotePath(target)) throw remoteDependencyRefusal(label, 'extends');
            const resolved = resolveDependencyPath(target, input.projectBase);
            queue.push({
              path: resolved,
              projectBase: path.dirname(resolved),
              env: input.env,
              depth: input.depth + 1,
            });
          }
          continue;
        }

        const targets: string[] = [];
        for (const raw of group.paths) {
          const target = interpolatePath(raw, input.env);
          if (target === null) continue;
          if (isRemotePath(target)) throw remoteDependencyRefusal(label, 'include');
          targets.push(resolveDependencyPath(target, input.projectBase));
        }
        if (targets.length === 0) continue;

        let childBase: string;
        if (group.projectDirectory !== null) {
          const rawDirectory = interpolatePath(group.projectDirectory, input.env);
          if (rawDirectory === null) continue;
          if (isRemotePath(rawDirectory)) throw remoteDependencyRefusal(label, 'include');
          childBase = resolveDependencyPath(rawDirectory, input.projectBase);
        } else {
          childBase = path.dirname(targets[0]);
        }

        const additionalEnv: EnvFileText[] = [];
        if (group.envFiles.length > 0) {
          for (const raw of group.envFiles) {
            const target = interpolatePath(raw, input.env);
            if (target === null) continue;
            const resolved = resolveDependencyPath(target, input.projectBase);
            const entry = await readEnvFileEntry(resolved, inputLabel(args.cwd, resolved));
            // A missing explicit include env file makes Compose fail before it
            // loads the included project.
            if (entry === null) continue;
            additionalEnv.push(entry);
          }
        } else {
          // An included project's interpolation env defaults to its own `.env`;
          // it only fills names the inherited environment leaves unset. Compose
          // loads it for an entry with `interpolation: false` too (the option
          // does not change which environment file the included project reads),
          // so the guard cannot skip it without missing a path it interpolates.
          const projectEnv = path.resolve(childBase, '.env');
          const entry = await readEnvFileEntry(projectEnv, inputLabel(args.cwd, projectEnv));
          if (entry !== null) additionalEnv.push(entry);
        }

        const childEnv = additionalEnv.length > 0
          ? withAdditionalEnvFiles(input.env, additionalEnv)
          : input.env;
        for (const target of targets) {
          queue.push({
            path: target,
            projectBase: childBase,
            env: childEnv,
            depth: input.depth + 1,
          });
        }
      }
    }
  }
}

/**
 * Refuse to run Docker Compose when one of the files it will read expands past
 * the alias budget. `invocation` is the exact argv (or its global-flag prefix)
 * the caller is about to spawn: its `-f`, `--env-file`, and
 * `--project-directory` values decide what Compose reads, together with the
 * `COMPOSE_FILE`, `COMPOSE_PATH_SEPARATOR`, `COMPOSE_ENV_FILES`, and
 * `COMPOSE_DISABLE_ENV_FILE` variables in `env`, which is the environment the
 * child receives.
 *
 * A missing or non-regular input is left for Compose to report, so an ordinary
 * broken stack fails exactly as it did. A dependency the guard cannot read
 * (a remote include or extends, or a graph past the traversal bounds) is
 * refused, because Compose would expand it unmeasured.
 *
 * The measurement is taken immediately before the caller spawns Compose, but a
 * file rewritten in the gap between the two is not re-checked. A writer who can
 * replace a stack's files can also write a bomb into them directly, which no
 * in-process check can prevent.
 */
export async function assertComposeInputsWithinExpansionLimits(opts: {
  cwd: string;
  invocation: readonly string[];
  /**
   * Values layered above this process's environment, matching a child spawned
   * with `{ ...process.env, ...overrides }`. A name the override leaves unset
   * comes from `process.env`, exactly as it does for the child.
   */
  env?: ComposeEnvLookup;
}): Promise<void> {
  const cwd = path.resolve(opts.cwd);
  const invocation = opts.invocation;
  const processEnv: ComposeEnvLookup = (name) => opts.env?.(name) ?? process.env[name];

  const explicitFiles = composeFileArgsFromInvocation(invocation).map((file) => path.resolve(cwd, file));
  const envFileArgs = flagValues(invocation, '--env-file', '--env-file');
  const projectDirectoryArg = lastFlagValue(invocation, '--project-directory');
  const configuredProjectDir = projectDirectoryArg !== undefined
    ? path.resolve(cwd, projectDirectoryArg)
    : null;

  // Compose decides the default env-file directory before it reads the env:
  // an explicit --project-directory, else the first -f file's directory, else
  // the working directory.
  const selectionBase = configuredProjectDir
    ?? (explicitFiles.length > 0 ? path.dirname(explicitFiles[0]) : cwd);
  const selection = await loadSelectionEnv(cwd, selectionBase, envFileArgs, processEnv);
  // A missing explicit env file, an unreadable env file, or an invalid
  // COMPOSE_DISABLE_ENV_FILE makes Compose fail before it reads a compose
  // input, so there is no expansion to measure.
  if (selection === null) return;

  const lookup = lookupEnv(selection.context);
  // A default `.env` that disables itself still selects the compose files, but
  // Compose drops its other assignments from interpolation and skips the
  // selected project's `.env`. An explicit --env-file or COMPOSE_ENV_FILES
  // source is unaffected by the setting, and a process environment that
  // disables the file is already reflected in `selection.disabled`. Keep only
  // the selection variables so dependency paths resolve with the same (mostly
  // empty) environment Compose uses.
  let rootEnv = selection.context;
  let skipProjectEnv = selection.explicitSources || selection.disabled;
  if (!selection.explicitSources && !selection.disabled && processEnv('COMPOSE_DISABLE_ENV_FILE') === undefined) {
    const disabledByFile = lookup('COMPOSE_DISABLE_ENV_FILE');
    if (disabledByFile !== undefined) {
      const disabled = parseGoBoolean(disabledByFile);
      // An invalid value makes Compose fail before any compose input is read.
      if (disabled === null) return;
      if (disabled) {
        const kept = new Map<string, string>();
        for (const name of ['COMPOSE_FILE', 'COMPOSE_PATH_SEPARATOR', 'COMPOSE_DISABLE_ENV_FILE']) {
          const value = lookup(name);
          if (value !== undefined) kept.set(name, value);
        }
        rootEnv = { processEnv, values: kept };
        skipProjectEnv = true;
      }
    }
  }

  let inputFiles: ResolvedInputFile[];
  if (explicitFiles.length > 0) {
    // Naming any -f file turns Compose discovery and COMPOSE_FILE off.
    inputFiles = explicitFiles.map((file) => ({ path: file }));
  } else {
    const composeFile = lookup('COMPOSE_FILE');
    if (composeFile !== undefined) {
      // An empty value makes Compose reject the run; `filepath.SplitList` drops
      // empty entries, so a list of only separators has nothing to measure.
      const separator = lookup('COMPOSE_PATH_SEPARATOR') || DEFAULT_PATH_SEPARATOR;
      const entries = composeFile.split(separator).filter((entry) => entry.length > 0);
      if (entries.length === 0) return;
      // COMPOSE_FILE entries resolve against the working directory, not the
      // project directory (the project directory is derived from them).
      inputFiles = entries.map((entry) => ({ path: path.resolve(cwd, entry) }));
    } else {
      inputFiles = await discoverInputFiles(selectionBase);
    }
  }

  const projectDir = configuredProjectDir
    ?? (inputFiles.length > 0 ? path.dirname(inputFiles[0].path) : selectionBase);

  // A selected project directory other than the one the env files came from
  // adds that directory's `.env` for interpolation, but only names the earlier
  // environment leaves unset. An explicit env source replaces it, and a process
  // environment or file that disabled the env file skips it too.
  if (!skipProjectEnv && projectDir !== selectionBase) {
    const projectEnv = path.resolve(projectDir, '.env');
    const entry = await readEnvFileEntry(projectEnv, inputLabel(cwd, projectEnv));
    if (entry !== null) rootEnv = withAdditionalEnvFiles(rootEnv, [entry]);
  }

  await assertInputClosure({ cwd, rootEnv, projectDir, files: inputFiles });
}
