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
 * `COMPOSE_FILE` (process environment, an env file, or the project `.env`) or
 * its own discovery. It then follows the YAML dependency graph Compose loads
 * from them (`include:` and `extends.file`), resolving paths in the same
 * project directory Compose uses. It counts the nodes each document expands to
 * using the `yaml` package's AST. That package keeps alias targets as shared
 * references instead of copying them, so the count is linear in the file and an
 * over-budget expansion is refused before it is materialized. Compose loads a
 * file again for every include or extends that names it and copies an extended
 * service into each service that extends it, so those repeats count too. A
 * file over the budget is refused with a clear message and the CLI is never
 * started.
 *
 * The guard also refuses what it cannot bound: an input over the byte cap, a
 * remote input, a device or pipe, an include/extends graph past its limits, a
 * relative path inside an included project, an env file it cannot read, and a
 * document its parser rejects that uses aliases, include, or extends. A syntax
 * error elsewhere, an unresolved alias, or a missing compose file is left for
 * Compose to report, so an ordinary broken stack still fails as it did.
 *
 * Not covered: Sencho's own deployment project (self-update and the endpoint
 * provider helper). Those render operator-owned files, not a managed stack's.
 */
import { createHash } from 'crypto';
import path from 'path';
import { isAlias, isCollection, isMap, isPair, isScalar, isSeq, parseAllDocuments, visit } from 'yaml';
import type { Document, Node, YAMLMap } from 'yaml';
import {
  ComposeEnvFileError,
  ComposeEnvFiles,
  DEFAULT_PATH_SEPARATOR,
  expandComposeEnvTemplate,
  type ComposeEnvLookup,
} from '../utils/composeDotenv';
import { COMPOSE_OVERRIDE_FILENAMES, COMPOSE_ROOT_FILENAMES } from '../utils/composeFilenames';
import { inspectComposeInput, readComposeInputWithinCap, resolvePhysicalDirectory } from './composeInputReadSink';

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
 * Source cap for one input, the same 1 MiB the compose parser elsewhere in
 * Sencho applies. Building the syntax tree costs several hundred bytes of heap
 * per byte of a dense file, so a larger cap would let the guard itself exhaust
 * the process it protects. A real compose file is a few kilobytes.
 */
export const MAX_COMPOSE_INPUT_BYTES = 1024 * 1024;

/**
 * Bounds on the include/extends graph. An ordinary project is far below both;
 * a graph beyond them cannot be established safely, so it is refused rather
 * than walked without a limit.
 */
export const MAX_COMPOSE_DEPENDENCY_DEPTH = 32;
export const MAX_COMPOSE_DEPENDENCY_FILES = 512;
/**
 * Include, extends, and env-file mentions walked per invocation, repeats
 * included. A mention costs a map lookup at least, and an env file costs a
 * parse, so the count is bounded rather than left to the file's size.
 */
export const MAX_COMPOSE_DEPENDENCY_REFERENCES = 4096;
/** Distinct include environments built per invocation. */
export const MAX_COMPOSE_ENV_CONTEXTS = 512;
/** Compose text parsed per invocation, repeats under another context included. */
export const MAX_COMPOSE_PARSED_BYTES = 8 * 1024 * 1024;
/** Env-file text parsed to build those environments, across the invocation. */
export const MAX_COMPOSE_ENV_PARSE_BYTES = 8 * 1024 * 1024;

const DISCOVERED_COMPOSE_NAMES = COMPOSE_ROOT_FILENAMES;
const DISCOVERED_OVERRIDE_NAMES = COMPOSE_OVERRIDE_FILENAMES;

/** Raised when an input cannot be handed to Docker Compose safely. */
export class ComposeExpansionRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComposeExpansionRefusal';
  }
}

function refusalForFile(label: string): ComposeExpansionRefusal {
  return new ComposeExpansionRefusal(
    `Compose file "${label}" expands to more than ${MAX_EXPANDED_NODES.toLocaleString('en-US')} nodes, normally through nested YAML aliases. ` +
    'Docker Compose expands aliases without a limit and can run the host out of memory, so Sencho refused to run it. ' +
    'Remove the alias chain or split the file so services do not reuse the same nested anchors.',
  );
}

function sizeRefusalForInput(label: string, kind: 'Compose file' | 'Env file'): ComposeExpansionRefusal {
  return new ComposeExpansionRefusal(
    `${kind} "${label}" is larger than ${MAX_COMPOSE_INPUT_BYTES / (1024 * 1024)} MiB, so Sencho did not hand it to Docker Compose. ` +
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

function unboundedInputRefusal(label: string): ComposeExpansionRefusal {
  return new ComposeExpansionRefusal(
    `"${label}" is not a regular file (for example a device or a pipe), and Docker Compose would read it with no size limit. ` +
    'Sencho refused to run it. Replace it with a regular file, then try again.',
  );
}

function unparsableRefusal(label: string): ComposeExpansionRefusal {
  return new ComposeExpansionRefusal(
    `Compose file "${label}" has YAML that Sencho's parser rejects, and it uses aliases, include, extends, or syntax that Sencho cannot read past that point. ` +
    'Docker Compose may still read it and expand its aliases without a limit, so Sencho refused to run it. Fix the syntax error, then try again.',
  );
}

function envFileRefusal(label: string): ComposeExpansionRefusal {
  return new ComposeExpansionRefusal(
    `Sencho could not read the env file "${label}" the way Docker Compose does, so it could not determine which compose files the run would load. ` +
    'Fix the env file, then try again.',
  );
}

function envFileHomeRefusal(label: string): ComposeExpansionRefusal {
  return new ComposeExpansionRefusal(
    `Sencho cannot resolve the env file path "${label}" the way Docker Compose does, so it could not determine which compose files the run would load. ` +
    'Use an absolute path, then try again.',
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
    `uses a remote ${kind} reference that Sencho cannot read before Docker Compose does. ` +
    'Vendor the file beside the compose file and reference it locally.',
  );
}

function unresolvedIncludePathRefusal(label: string, detail: string): ComposeExpansionRefusal {
  return new ComposeExpansionRefusal(
    `Compose file "${label}" ${detail} Sencho cannot establish the path Docker Compose resolves it to, so it refused to run a file whose expansion it cannot bound.`,
  );
}

function remoteInputRefusal(): ComposeExpansionRefusal {
  // The reference itself is not repeated: a git URL can carry credentials.
  return new ComposeExpansionRefusal(
    'A compose input for this run is a remote Git or OCI reference, and Sencho cannot read it before Docker Compose does. ' +
    'Vendor the file locally and reference it, then try again.',
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
 * A parsed document the guard measured. `sizes` is the memo the expansion
 * count filled in, reused to size individual services.
 */
interface MeasuredDocument {
  doc: Document;
  targets: Map<Node, Node>;
  sizes: Map<object, number>;
}

/**
 * Parse errors that leave the document's structure complete: an alias with no
 * anchor and a repeated key both leave every node in place, so the document can
 * still be measured. Every other error means the `yaml` package stopped
 * building the tree, and what it dropped is unknown.
 */
const COMPLETE_STRUCTURE_ERROR_CODES = new Set(['BAD_ALIAS', 'DUPLICATE_KEY']);

/**
 * True when a document the parser rejected could still hold what the guard
 * exists to bound. Compose's YAML parser accepts some inputs the `yaml` package
 * rejects (an unspaced comment after a quoted value, a key over 1,024
 * characters, a tab inside a flow collection), so a bomb or an `include` can
 * sit in a document this guard could not read. It needs an anchor and an alias
 * to expand, or an include/extends to pull in another file; a document with
 * none of those cannot, and its syntax error is left to Compose. The words
 * `include` and `extends` count wherever they appear, and so does a backslash
 * (an escape in a quoted key can spell them) or an explicit `? ` key, because
 * the text of a rejected document cannot be trusted to show a key as written.
 */
function usesUnmeasurableConstructs(text: string): boolean {
  const hasAnchor = /(?:^|[\s,[{:-])&[^\s,[\]{}]/m.test(text);
  const hasAlias = /(?:^|[\s,[{:-])\*[^\s,[\]{}]/m.test(text);
  if (hasAnchor && hasAlias) return true;
  // The words themselves, quoted or not, and the two ways to hide them: a
  // backslash escape inside a double-quoted key, and an explicit `? ` key.
  return /\b(?:include|extends)\b/.test(text) || text.includes('\\') || /^\s*\?\s/m.test(text);
}

/**
 * Parse a stream of YAML documents and measure each against the per-file
 * budget, returning the documents that were measured.
 *
 * Compose accepts a stream, so every document counts toward the file's budget.
 * Compose expands a valid document as it reaches it, so documents before the
 * first one the `yaml` package rejects are measured. What follows a rejected
 * document is not measured, because this parser stops there. When the rejected
 * document or anything after it uses aliases, include, or extends, the guard
 * cannot tell what Compose's parser would make of it (it may accept the
 * document and go on to read what follows), so it refuses instead of passing
 * it; a stream with none of those is left to Compose to report.
 */
function measureDocumentStream(rawSource: string, label: string): MeasuredDocument[] {
  // Compose's YAML parser reads a lone CR, U+0085, U+2028, and U+2029 as line
  // breaks; the `yaml` package reads them as text, which would hide an alias or
  // an include that follows one (CRLF is one break either way). Unique keys are
  // not checked: that check is quadratic in the keys of one map, and a repeated
  // key is Compose's error to report.
  const source = rawSource.replace(/\r\n?|[\u0085\u2028\u2029]/g, '\n');
  const documents = parseAllDocuments(source, { prettyErrors: false, merge: true, uniqueKeys: false });
  const measured: MeasuredDocument[] = [];
  let expanded = 0;
  for (const doc of documents) {
    const hasErrors = doc.errors.length > 0;
    if (hasErrors && !doc.errors.every((error) => COMPLETE_STRUCTURE_ERROR_CODES.has(error.code))) {
      if (usesUnmeasurableConstructs(source.slice(doc.range?.[0] ?? 0))) throw unparsableRefusal(label);
      break;
    }
    if (doc.contents) {
      const targets = resolveAliasTargets(doc);
      const sizes = new Map<object, number>();
      expanded = saturateAdd(expanded, countExpandedNodes(doc.contents, targets, sizes, new Set()));
      if (expanded > MAX_EXPANDED_NODES) throw refusalForFile(label);
      measured.push({ doc, targets, sizes });
    }
    if (hasErrors) break;
  }
  return measured;
}

/**
 * Throw when one compose source expands past the budget. The source is a
 * string the caller already decoded, so this checks the stream only; the
 * dependency graph needs files on disk and is checked by
 * `assertComposeInputsWithinExpansionLimits`.
 */
export function assertComposeSourceWithinExpansionLimits(source: string, label: string): void {
  // The same byte cap a file on disk gets: building the syntax tree of a dense
  // file costs several hundred bytes of heap per byte.
  if (Buffer.byteLength(source, 'utf8') > MAX_COMPOSE_INPUT_BYTES) throw sizeRefusalForInput(label, 'Compose file');
  measureDocumentStream(source, label);
}

/** `-f` / `--file` values of a Compose invocation, in order. */
export function composeFileArgsFromInvocation(invocation: readonly string[]): string[] {
  return flagValues(invocation, '-f', '--file');
}

/**
 * Compose global flags that take a separate value. They are skipped so their
 * value is not mistaken for the subcommand, which ends the global prefix.
 */
const GLOBAL_VALUE_FLAGS = new Set([
  '-f', '--file', '--env-file', '--project-directory',
  '-p', '--project-name', '-c', '--context',
  '--profile', '--ansi', '--progress', '--log-level', '--parallel',
]);

/**
 * Values of one Compose global flag, in order. Accepts `--flag value`,
 * `--flag=value`, and the short forms `-f value`, `-f=value`, and `-fvalue`.
 * Scanning stops at the subcommand so a command flag such as `logs -f` is not
 * mistaken for a compose file.
 */
function flagValues(invocation: readonly string[], short: string, long: string): string[] {
  const values: string[] = [];
  const start = invocation[0] === 'compose' ? 1 : 0;
  for (let i = start; i < invocation.length; i += 1) {
    const arg = invocation[i];
    if (!arg.startsWith('-')) break;
    if (arg === short || arg === long) {
      const next = invocation[i + 1];
      if (next !== undefined && next !== '') values.push(next);
      i += 1;
      continue;
    }
    if (arg.startsWith(`${long}=`)) {
      const value = arg.slice(long.length + 1);
      if (value !== '') values.push(value);
      continue;
    }
    if (short.length === 2 && arg.startsWith(short) && arg.length > short.length) {
      const attached = arg.slice(short.length);
      const value = attached.startsWith('=') ? attached.slice(1) : attached;
      if (value !== '') values.push(value);
      continue;
    }
    if (GLOBAL_VALUE_FLAGS.has(arg)) i += 1;
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
  /** Values the env files of this layer assigned, in read order (later files win). */
  values: Map<string, string>;
  /**
   * The context this one adds to. A layer holds only the names it assigned, so
   * a deep include chain or many includes do not each copy every inherited
   * value.
   */
  parent?: GuardEnvContext;
}

interface EnvFileText {
  text: string;
  label: string;
}

function lookupEnv(context: GuardEnvContext): ComposeEnvLookup {
  return (name) => {
    const fromProcess = context.processEnv(name);
    if (fromProcess !== undefined) return fromProcess;
    for (let layer: GuardEnvContext | undefined = context; layer; layer = layer.parent) {
      const value = layer.values.get(name);
      if (value !== undefined) return value;
    }
    return undefined;
  };
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
    values: new Map(),
    parent: context,
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

/**
 * Read one env input, or null when it is missing. `/dev/null` is an empty env
 * file: Compose accepts `--env-file /dev/null` and reads it as empty, so
 * returning null here would skip every compose input the run is about to load.
 * A directory also yields empty text, which only declines to refuse it (Compose
 * reports the error). Any other device or a pipe is refused, because Compose
 * reads it with no size limit.
 */
async function readEnvFileEntry(filePath: string, label: string): Promise<EnvFileText | null> {
  const read = await readComposeInputWithinCap(filePath, MAX_COMPOSE_INPUT_BYTES);
  if (read.tooLarge) throw sizeRefusalForInput(label, 'Env file');
  if (read.nonRegular === 'unbounded') throw unboundedInputRefusal(label);
  if (read.content !== null) return { text: read.content, label };
  if (read.nonRegular) return { text: '', label };
  return null;
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
      if (file.startsWith('~')) throw envFileHomeRefusal(file);
      sources.push({ path: path.resolve(cwd, file), label: file, required: true });
    }
  } else {
    const listed = (processEnv('COMPOSE_ENV_FILES') ?? '').split(',').filter((entry) => entry.length > 0);
    if (listed.length > 0) {
      explicitSources = true;
      for (const file of listed) {
        if (file.startsWith('~')) throw envFileHomeRefusal(file);
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
 * True when a value names a remote Compose input: a URL with a scheme, an
 * SCP-like git ref, or a `github.com/` ref. Compose's git loader accepts all
 * three for `include`, `extends.file`, `-f`, and `COMPOSE_FILE`; none can be
 * read locally, so their expansion cannot be bounded.
 */
function isRemoteComposeRef(value: string): boolean {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) return true;
  if (/^[^/@\s]+@[^/:\s]+:/.test(value)) return true;
  // Compose's git loader accepts a bare `github.com/owner/repo` ref. Other
  // dotted first segments (`apps.web/dep.yaml`, `gitlab.com/...`) are local
  // paths, so they must stay local here too.
  return /^github\.com\//.test(value);
}

function resolveDependencyPath(value: string, base: string): string {
  // A `~` prefix is a literal directory name to Compose's loader for an
  // include, the main file, and an included project's main file, so it is
  // resolved against the project base like any relative path.
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(base, value);
}

/** Expand a leading `~` the way Compose's extends path expansion does. */
function expandUserPath(value: string, home: string | undefined): string {
  if (home && value.startsWith('~')) {
    // Compose joins the rest as-is: on Linux a backslash stays a filename
    // character, so `~\b.yaml` is not the same file as `~/b.yaml`.
    return path.join(home, value.slice(1));
  }
  return value;
}

/**
 * Resolve one `extends.file` value. Compose expands a leading `~` in a path
 * declared by a file it reached through `extends`, but keeps it literal in the
 * main file and in an included project's main file.
 */
function resolveExtendsPath(
  value: string,
  base: string,
  expandHome: boolean,
  home: string | undefined,
): string {
  if (expandHome && value.startsWith('~') && home) {
    return expandUserPath(value, home);
  }
  // With no HOME, Compose warns and keeps the path literal, so it is resolved
  // against the declaring file's project base like any relative path.
  return resolveDependencyPath(value, base);
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
  /** The service or job that declared it, so its copy can be charged. */
  owner: string;
}

/**
 * Files a service or job names that `docker compose config` reads whole (an
 * `env_file` or `label_file`). They are not YAML to measure, but a device or a
 * pipe there would be read with no limit.
 */
interface ReadFilesGroup {
  kind: 'readFiles';
  paths: string[];
}

type DependencyGroup = IncludeGroup | ExtendsGroup | ReadFilesGroup;

/** One service or job, with what Compose copies into every service that extends it. */
interface ServiceInfo {
  /** Expanded nodes of its own definition. */
  size: number;
  /** The same-file service it extends, or null. */
  parent: string | null;
}

interface DocumentDependencies {
  groups: DependencyGroup[];
  services: Map<string, ServiceInfo>;
}

function deref(node: unknown, targets: Map<Node, Node>): unknown {
  let current = node;
  for (let hops = 0; hops < 64 && isAlias(current); hops += 1) {
    current = targets.get(current);
  }
  return isAlias(current) ? undefined : current;
}

function textOf(node: unknown, targets: Map<Node, Node>): string | undefined {
  const resolved = deref(node, targets);
  if (!isScalar(resolved)) return undefined;
  if (typeof resolved.value === 'string') return resolved.value;
  if (typeof resolved.value === 'number') return String(resolved.value);
  return undefined;
}

function textListOf(node: unknown, targets: Map<Node, Node>): string[] {
  const resolved = deref(node, targets);
  if (isSeq(resolved)) {
    return resolved.items
      .map((item) => textOf(item, targets))
      .filter((item): item is string => item !== undefined);
  }
  const single = textOf(resolved, targets);
  return single === undefined ? [] : [single];
}

function isMergeKey(key: unknown): boolean {
  if (!isScalar(key)) return false;
  // With `merge: true` the parser stores the merge key as a symbol; a plain
  // `<<` scalar is the same key before that tag resolves.
  const value: unknown = key.value;
  const isMarker = value === '<<' || (typeof value === 'symbol' && value.description === '<<');
  return isMarker && (!key.type || key.type === 'PLAIN');
}

/**
 * The entries of a mapping with its `<<` merges applied. An explicit key wins
 * over a merged one, and an earlier merge source over a later one, the way
 * Compose's YAML decoder resolves them.
 */
function mapEntries(map: YAMLMap, targets: Map<Node, Node>, seen = new Set<unknown>()): Map<string, unknown> {
  const entries = new Map<string, unknown>();
  const merges: unknown[] = [];
  for (const pair of map.items) {
    if (isMergeKey(pair.key)) {
      merges.push(pair.value);
      continue;
    }
    const key = textOf(pair.key, targets);
    if (key !== undefined && !entries.has(key)) entries.set(key, pair.value);
  }
  if (seen.has(map)) return entries;
  seen.add(map);
  for (const merge of merges) {
    const resolved = deref(merge, targets);
    for (const source of isSeq(resolved) ? resolved.items : [resolved]) {
      const sourceMap = deref(source, targets);
      if (!isMap(sourceMap)) continue;
      for (const [key, value] of mapEntries(sourceMap, targets, seen)) {
        if (!entries.has(key)) entries.set(key, value);
      }
    }
  }
  return entries;
}

function entriesOf(node: unknown, targets: Map<Node, Node>): Map<string, unknown> | null {
  const resolved = deref(node, targets);
  return isMap(resolved) ? mapEntries(resolved, targets) : null;
}

/** The paths of a service's `env_file` or `label_file`: a string, a list, or maps with a `path`. */
function readFilePaths(node: unknown, targets: Map<Node, Node>): string[] {
  const resolved = deref(node, targets);
  const out: string[] = [];
  for (const item of isSeq(resolved) ? resolved.items : [resolved]) {
    const text = textOf(item, targets);
    if (text !== undefined) {
      out.push(text);
      continue;
    }
    const fields = entriesOf(item, targets);
    const mapped = fields === null ? undefined : textOf(fields.get('path'), targets);
    if (mapped !== undefined) out.push(mapped);
  }
  return out;
}

/**
 * Read the include/extends declarations of one parsed document straight from
 * its syntax tree, and the size of each service and job. The tree is read
 * through the alias targets already resolved for the count. Converting the
 * document to plain data would re-scan the whole file for every alias, which
 * costs more than the count itself on a file with many aliases.
 */
function extractDependencies(measured: MeasuredDocument): DocumentDependencies {
  const { doc, targets, sizes } = measured;
  const groups: DependencyGroup[] = [];
  const services = new Map<string, ServiceInfo>();
  const root = entriesOf(doc.contents, targets);
  if (root === null) return { groups, services };

  const include = root.get('include');
  if (include !== undefined) {
    const resolved = deref(include, targets);
    for (const raw of isSeq(resolved) ? resolved.items : [resolved]) {
      const entry = deref(raw, targets);
      const single = textOf(entry, targets);
      if (single !== undefined) {
        groups.push({ kind: 'include', paths: [single], envFiles: [], projectDirectory: null });
        continue;
      }
      const fields = entriesOf(entry, targets);
      if (fields === null) continue;
      const paths = textListOf(fields.get('path'), targets);
      if (paths.length === 0) continue;
      const projectDirectory = textOf(fields.get('project_directory'), targets);
      groups.push({
        kind: 'include',
        paths,
        envFiles: textListOf(fields.get('env_file'), targets),
        // An empty project_directory is absent to Compose: the included file's
        // own directory becomes the project base.
        projectDirectory: projectDirectory !== undefined && projectDirectory !== '' ? projectDirectory : null,
      });
    }
  }

  // Services and jobs both accept `extends`; Compose applies the same loader
  // to a job definition, so a job's dependency has to be measured too.
  for (const section of ['services', 'jobs'] as const) {
    const definitions = entriesOf(root.get(section), targets);
    if (definitions === null) continue;
    for (const [name, definition] of definitions) {
      const owner = `${section}\0${name}`;
      const size = countExpandedNodes(definition, targets, sizes, new Set());
      const fields = entriesOf(definition, targets);
      if (fields !== null) {
        const readFiles = [
          ...readFilePaths(fields.get('env_file'), targets),
          ...readFilePaths(fields.get('label_file'), targets),
        ];
        if (readFiles.length > 0) groups.push({ kind: 'readFiles', paths: readFiles });
      }
      const extendsNode = fields?.get('extends');
      let parent: string | null = null;
      if (extendsNode !== undefined) {
        const shorthand = textOf(extendsNode, targets);
        const extendsFields = shorthand === undefined ? entriesOf(extendsNode, targets) : null;
        const file = extendsFields === null ? undefined : textOf(extendsFields.get('file'), targets);
        const service = shorthand ?? (extendsFields === null ? undefined : textOf(extendsFields.get('service'), targets));
        if (file !== undefined && file.length > 0) {
          groups.push({ kind: 'extends', paths: [file], owner });
        } else if (service !== undefined && service.length > 0) {
          parent = `${section}\0${service}`;
        }
      }
      services.set(owner, { size, parent });
    }
  }
  return { groups, services };
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
  /**
   * True when this file was reached through `extends.file`. Compose expands a
   * `~` in an extends path declared by such a file but keeps it literal in the
   * main file and in an included project's main file.
   */
  viaExtends: boolean;
  content?: string;
}

function inputLabel(cwd: string, filePath: string): string {
  const relative = path.relative(cwd, filePath);
  // An input outside the stack directory reads better as its own path than as
  // a run of `..` segments.
  if (relative.startsWith('..')) return filePath;
  return relative || path.basename(filePath);
}

const envContextIds = new WeakMap<GuardEnvContext, string>();

/**
 * A digest of the values an environment context holds, computed once per
 * context. The same file reached under a different environment is a different
 * set of inputs, but the values are hashed rather than kept as text so a large
 * env file does not travel with every visited file.
 */
function envContextId(context: GuardEnvContext): string {
  let id = envContextIds.get(context);
  if (id === undefined) {
    const digest = createHash('sha256');
    if (context.parent) {
      digest.update(envContextId(context.parent));
      digest.update('\0');
    }
    for (const [name, value] of context.values) {
      digest.update(name);
      digest.update('\0');
      digest.update(value);
      digest.update('\0');
    }
    id = digest.digest('base64url');
    envContextIds.set(context, id);
  }
  return id;
}

/**
 * The parts of a file's traversal context that can change which dependencies it
 * declares. The same file reached twice with a different environment or
 * project directory is a different set of inputs, so it is measured separately.
 */
function inputContextKey(filePath: string, projectBase: string, env: GuardEnvContext, viaExtends: boolean): string {
  return [filePath, projectBase, viaExtends ? 'extends' : 'main', envContextId(env)].join('\0');
}

/** Read the first auto-discovered input that exists, as Compose would. */
async function firstDiscoveredInput(base: string, names: readonly string[]): Promise<ResolvedInputFile | null> {
  for (const name of names) {
    const candidate = path.resolve(base, name);
    const read = await readComposeInputWithinCap(candidate, MAX_COMPOSE_INPUT_BYTES);
    if (read.tooLarge) throw sizeRefusalForInput(name, 'Compose file');
    if (read.nonRegular === 'unbounded') throw unboundedInputRefusal(name);
    // Compose takes the first name that exists. A directory or `/dev/null`
    // named like a compose file is the pick, and Compose reports it, so the
    // search stops there with nothing to measure.
    if (read.nonRegular) return { path: candidate, content: '' };
    if (read.content !== null) return { path: candidate, content: read.content };
  }
  return null;
}

/**
 * The files Compose discovers when the invocation names none. Compose searches
 * the working directory and then each parent until it finds a base file, and
 * reads the override from the same directory.
 */
async function discoverInputFiles(base: string): Promise<ResolvedInputFile[]> {
  let current = path.resolve(base);
  for (;;) {
    const baseFile = await firstDiscoveredInput(current, DISCOVERED_COMPOSE_NAMES);
    if (baseFile) {
      const override = await firstDiscoveredInput(current, DISCOVERED_OVERRIDE_NAMES);
      return override ? [baseFile, override] : [baseFile];
    }
    const parent = path.dirname(current);
    if (parent === current) return [];
    current = parent;
  }
}

/**
 * Walk the selected inputs and every YAML dependency they declare, refusing a
 * file whose expansion passes the budget and a dependency graph that cannot be
 * resolved within the traversal bounds.
 *
 * Compose loads a file again for every include or extends that names it, and
 * copies an extended service into each service that extends it, so what
 * counts toward the invocation's budget is the number of nodes Compose builds,
 * not the number of distinct files: each occurrence adds the whole subtree of
 * the file it names, and each service that extends another service of its own
 * file adds that service's definition. Subtree sizes are memoized per file and
 * context, which keeps the walk linear in the number of distinct inputs while
 * a fan-out that doubles at every level still saturates the budget.
 */
async function assertInputClosure(args: {
  cwd: string;
  rootEnv: GuardEnvContext;
  projectDir: string;
  files: readonly ResolvedInputFile[];
}): Promise<void> {
  // Env files and the contexts they build are shared by every include that
  // names them, so a project with many includes reads and parses each once.
  const envEntries = new Map<string, Promise<EnvFileText | null>>();
  const readEnvEntry = (filePath: string): Promise<EnvFileText | null> => {
    let entry = envEntries.get(filePath);
    if (entry === undefined) {
      if (envEntries.size >= MAX_COMPOSE_DEPENDENCY_FILES) {
        throw dependencyBoundRefusal(inputLabel(args.cwd, filePath), `more than ${MAX_COMPOSE_DEPENDENCY_FILES} env files`);
      }
      entry = readEnvFileEntry(filePath, inputLabel(args.cwd, filePath));
      envEntries.set(filePath, entry);
    }
    return entry;
  };
  const childEnvs = new Map<string, GuardEnvContext>();
  let envParseBytes = 0;
  const childEnvFor = (parent: GuardEnvContext, entries: Array<{ path: string; entry: EnvFileText }>): GuardEnvContext => {
    if (entries.length === 0) return parent;
    const key = [envContextId(parent), ...entries.map((item) => item.path)].join('\0');
    let child = childEnvs.get(key);
    if (child === undefined) {
      const label = entries[0].entry.label;
      if (childEnvs.size >= MAX_COMPOSE_ENV_CONTEXTS) {
        throw dependencyBoundRefusal(label, `more than ${MAX_COMPOSE_ENV_CONTEXTS} distinct include environments`);
      }
      for (const item of entries) {
        envParseBytes += item.entry.text.length;
      }
      if (envParseBytes > MAX_COMPOSE_ENV_PARSE_BYTES) {
        throw dependencyBoundRefusal(label, `env files totalling more than ${MAX_COMPOSE_ENV_PARSE_BYTES / (1024 * 1024)} MiB`);
      }
      child = withAdditionalEnvFiles(parent, entries.map((item) => item.entry));
      childEnvs.set(key, child);
    }
    return child;
  };

  const subtotals = new Map<string, number>();
  // A file's own nodes, known before its dependencies are walked: a cycle
  // back to a file in progress charges these, not nothing.
  const ownNodes = new Map<string, number>();
  const active = new Set<string>();
  let references = 0;
  let measuredNodes = 0;
  let parsedBytes = 0;
  const countReference = (label: string): void => {
    references += 1;
    if (references > MAX_COMPOSE_DEPENDENCY_REFERENCES) {
      throw dependencyBoundRefusal(label, `more than ${MAX_COMPOSE_DEPENDENCY_REFERENCES} include, extends, and env file references`);
    }
  };

  const measure = async (input: PendingInput): Promise<number> => {
    const filePath = path.resolve(input.path);
    const label = inputLabel(args.cwd, filePath);
    countReference(label);
    const contextKey = inputContextKey(filePath, input.projectBase, input.env, input.viaExtends);
    const known = subtotals.get(contextKey);
    if (known !== undefined) return known;
    // Compose rejects an include or extends cycle itself, but only once it
    // reaches the back edge, so the file the edge points at is charged again.
    if (active.has(contextKey)) return ownNodes.get(contextKey) ?? 1;
    if (subtotals.size + active.size >= MAX_COMPOSE_DEPENDENCY_FILES) {
      throw dependencyBoundRefusal(label, `more than ${MAX_COMPOSE_DEPENDENCY_FILES} resolved compose inputs`);
    }
    if (input.depth > MAX_COMPOSE_DEPENDENCY_DEPTH) {
      throw dependencyBoundRefusal(label, `an include/extends chain deeper than ${MAX_COMPOSE_DEPENDENCY_DEPTH}`);
    }

    let content = input.content;
    if (content === undefined) {
      const read = await readComposeInputWithinCap(filePath, MAX_COMPOSE_INPUT_BYTES);
      if (read.tooLarge) throw sizeRefusalForInput(label, 'Compose file');
      if (read.nonRegular === 'unbounded') throw unboundedInputRefusal(label);
      // Missing, unreadable as a file, a directory, or `/dev/null`: Compose
      // reports it next, so there is no expansion to measure here.
      if (read.content === null) {
        subtotals.set(contextKey, 0);
        return 0;
      }
      content = read.content;
    }

    parsedBytes += content.length;
    if (parsedBytes > MAX_COMPOSE_PARSED_BYTES) {
      throw dependencyBoundRefusal(label, `more than ${MAX_COMPOSE_PARSED_BYTES / (1024 * 1024)} MiB of compose text in total`);
    }
    active.add(contextKey);
    try {
      // The parsed documents are dropped before the walk descends: a chain of
      // large files must not keep every ancestor's syntax tree alive.
      const { own, extracted } = (() => {
        const measured = measureDocumentStream(content, label);
        let nodes = 0;
        for (const item of measured) {
          nodes = saturateAt(nodes, countExpandedNodes(item.doc.contents, item.targets, item.sizes, new Set()), MAX_TOTAL_EXPANDED_NODES);
        }
        // Every load is at least one node, so a graph of empty files that fans
        // out at each level cannot walk past the budget for free.
        return { own: Math.max(nodes, 1), extracted: measured.map(extractDependencies) };
      })();
      let subtotal = own;
      ownNodes.set(contextKey, own);
      // A run's total is at least the sum of its distinct files, so the
      // refusal can come as soon as that sum passes the budget, before the
      // next file is parsed.
      measuredNodes = saturateAt(measuredNodes, own, MAX_TOTAL_EXPANDED_NODES);
      if (measuredNodes > MAX_TOTAL_EXPANDED_NODES) throw totalRefusalForFile(label);
      const add = (amount: number): void => {
        subtotal = saturateAt(subtotal, amount, MAX_TOTAL_EXPANDED_NODES);
        if (subtotal > MAX_TOTAL_EXPANDED_NODES) throw totalRefusalForFile(label);
      };

      for (const { groups, services } of extracted) {
        const crossFileCharge = new Map<string, number>();
        for (const group of groups) {
          for (const child of await childInputs(input, group, label)) {
            const childSubtotal = await measure(child);
            add(childSubtotal);
            if (group.kind === 'extends') {
              crossFileCharge.set(group.owner, saturateAt(crossFileCharge.get(group.owner) ?? 0, childSubtotal, MAX_TOTAL_EXPANDED_NODES));
            }
          }
        }
        add(sameFileExtendsCharge(services, crossFileCharge, label));
      }
      subtotals.set(contextKey, subtotal);
      return subtotal;
    } finally {
      active.delete(contextKey);
    }
  };

  const childInputs = async (input: PendingInput, group: DependencyGroup, label: string): Promise<PendingInput[]> => {
    if (group.kind === 'readFiles') {
      for (const raw of group.paths) {
        countReference(label);
        const target = interpolatePath(raw, input.env);
        if (target === null || target === '') continue;
        // Compose expands a leading `~` in these paths and reads a relative one
        // from the project directory, so both spellings are checked.
        const candidates = new Set([resolveDependencyPath(target, input.projectBase)]);
        const home = input.env.processEnv('HOME');
        if (home && target.startsWith('~')) candidates.add(path.resolve(expandUserPath(target, home)));
        for (const resolved of candidates) {
          if ((await inspectComposeInput(resolved)) === 'unbounded') throw unboundedInputRefusal(inputLabel(args.cwd, resolved));
        }
      }
      return [];
    }
    if (group.kind === 'extends') {
      const children: PendingInput[] = [];
      for (const raw of group.paths) {
        const target = interpolatePath(raw, input.env);
        if (target === null) continue;
        if (isRemoteComposeRef(target)) throw remoteDependencyRefusal(label, 'extends');
        const resolved = resolveExtendsPath(target, input.projectBase, input.viaExtends, input.env.processEnv('HOME'));
        children.push({
          path: resolved,
          projectBase: path.dirname(resolved),
          env: input.env,
          depth: input.depth + 1,
          viaExtends: true,
        });
      }
      return children;
    }

    const targets: string[] = [];
    for (const raw of group.paths) {
      const target = interpolatePath(raw, input.env);
      if (target === null) continue;
      if (isRemoteComposeRef(target)) throw remoteDependencyRefusal(label, 'include');
      targets.push(resolveDependencyPath(target, input.projectBase));
    }
    if (targets.length === 0) return [];

    let childBase: string;
    if (group.projectDirectory !== null) {
      const rawDirectory = interpolatePath(group.projectDirectory, input.env);
      if (rawDirectory === null) return [];
      if (rawDirectory === '') {
        // An interpolated empty value is absent to Compose, the same as an
        // empty literal in the include entry.
        childBase = path.dirname(targets[0]);
      } else {
        if (isRemoteComposeRef(rawDirectory)) throw remoteDependencyRefusal(label, 'include');
        // Compose resolves a relative project_directory in an included
        // project against a working directory derived from the include
        // chain, which can differ from the absolute project base here.
        // Refuse rather than measure a different file than Compose loads.
        if (input.depth > 0 && !path.isAbsolute(rawDirectory)) {
          throw unresolvedIncludePathRefusal(label, 'has a relative project_directory inside an included project.');
        }
        childBase = resolveDependencyPath(rawDirectory, input.projectBase);
      }
    } else {
      childBase = path.dirname(targets[0]);
    }

    const additionalEnv: Array<{ path: string; entry: EnvFileText }> = [];
    if (group.envFiles.length > 0) {
      const seenEnvFiles = new Set<string>();
      for (const raw of group.envFiles) {
        countReference(label);
        const target = interpolatePath(raw, input.env);
        if (target === null) continue;
        if (input.depth > 0 && !path.isAbsolute(target)) {
          throw unresolvedIncludePathRefusal(label, 'has a relative env_file inside an included project.');
        }
        const resolved = resolveDependencyPath(target, input.projectBase);
        // Compose reads a path listed twice twice and the later assignment
        // wins, but the values are the same, so one read gives the same
        // environment.
        if (seenEnvFiles.has(resolved)) continue;
        seenEnvFiles.add(resolved);
        const entry = await readEnvEntry(resolved);
        // A missing explicit include env file makes Compose fail before it
        // loads the included project.
        if (entry === null) continue;
        additionalEnv.push({ path: resolved, entry });
      }
    } else {
      // An included project's interpolation env defaults to its own `.env`;
      // it only fills names the inherited environment leaves unset. Compose
      // loads it for an entry with `interpolation: false` too (the option
      // does not change which environment file the included project reads),
      // so the guard cannot skip it without missing a path it interpolates.
      const projectEnv = path.resolve(childBase, '.env');
      const entry = await readEnvEntry(projectEnv);
      if (entry !== null) additionalEnv.push({ path: projectEnv, entry });
    }

    const childEnv = childEnvFor(input.env, additionalEnv);
    return targets.map((target) => ({
      path: target,
      projectBase: childBase,
      env: childEnv,
      depth: input.depth + 1,
      viaExtends: false,
    }));
  };

  let total = 0;
  for (const file of args.files) {
    const subtotal = await measure({
      path: file.path,
      projectBase: args.projectDir,
      env: args.rootEnv,
      depth: 0,
      viaExtends: false,
      content: file.content,
    });
    total = saturateAt(total, subtotal, MAX_TOTAL_EXPANDED_NODES);
    if (total > MAX_TOTAL_EXPANDED_NODES) throw totalRefusalForFile(inputLabel(args.cwd, path.resolve(file.path)));
  }
}

/**
 * The nodes Compose adds by copying an extended service of the same file into
 * each service that extends it. A copy carries the extended service's own
 * definition, whatever it pulled in from another file, and whatever it extends
 * in turn.
 */
function sameFileExtendsCharge(
  services: Map<string, ServiceInfo>,
  crossFileCharge: Map<string, number>,
  label: string,
): number {
  const effective = new Map<string, { total: number; chain: number }>();
  const active = new Set<string>();
  const effectiveOf = (id: string): { total: number; chain: number } => {
    const known = effective.get(id);
    if (known !== undefined) return known;
    const info = services.get(id);
    if (!info || active.has(id)) return { total: 0, chain: 0 };
    active.add(id);
    let total = saturateAt(info.size, crossFileCharge.get(id) ?? 0, MAX_TOTAL_EXPANDED_NODES);
    let chain = 1;
    if (info.parent !== null) {
      const parent = effectiveOf(info.parent);
      total = saturateAt(total, parent.total, MAX_TOTAL_EXPANDED_NODES);
      chain += parent.chain;
    }
    active.delete(id);
    // The check sits on the chain length, not the recursion, so it does not
    // depend on the order the services are visited in.
    if (chain > MAX_COMPOSE_DEPENDENCY_DEPTH) {
      throw dependencyBoundRefusal(label, `an extends chain deeper than ${MAX_COMPOSE_DEPENDENCY_DEPTH}`);
    }
    const result = { total, chain };
    effective.set(id, result);
    return result;
  };
  let extra = 0;
  for (const info of services.values()) {
    if (info.parent !== null) extra = saturateAt(extra, effectiveOf(info.parent).total, MAX_TOTAL_EXPANDED_NODES);
  }
  return extra;
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
 * A missing compose input is left for Compose to report, so an ordinary broken
 * stack fails exactly as it did. `/dev/null` given as an env file is read as
 * empty, the way Compose reads it. A dependency or selected input the guard
 * cannot read (a remote Git or OCI reference, a device or pipe, or a graph past
 * the traversal bounds) is refused, because Compose would read it unmeasured.
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
   * The child's whole environment, for a caller that builds it (a name it
   * leaves unset is unset for the child, whatever this process holds). Omit it
   * when the child inherits this process's environment unchanged.
   */
  env?: ComposeEnvLookup;
}): Promise<void> {
  // Compose runs in the physical directory, so a symlinked stack directory
  // resolves `..` (and every relative path) from the real location.
  const cwd = await resolvePhysicalDirectory(path.resolve(opts.cwd));
  const invocation = opts.invocation;
  const processEnv: ComposeEnvLookup = opts.env ?? ((name) => process.env[name]);

  const explicitFileValues = composeFileArgsFromInvocation(invocation);
  for (const file of explicitFileValues) {
    if (isRemoteComposeRef(file)) throw remoteInputRefusal();
  }
  const explicitFiles = explicitFileValues.map((file) => path.resolve(cwd, file));
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
        // Compose exports every COMPOSE_* assignment from a file that disables
        // itself, and only those, into the environment the compose files are
        // interpolated with. Keep the same names so a path like
        // `${COMPOSE_DIR}/base.yaml` resolves as Compose resolves it.
        const kept = new Map<string, string>();
        for (const [name, value] of selection.context.values) {
          if (name.startsWith('COMPOSE_')) kept.set(name, value);
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
      for (const entry of entries) {
        if (isRemoteComposeRef(entry)) throw remoteInputRefusal();
      }
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
