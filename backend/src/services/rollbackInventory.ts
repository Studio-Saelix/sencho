/**
 * Resolve the authored-project file set that an atomic rollback generation
 * must capture. Git-managed stacks consume the managed-project manifest;
 * authored stacks rediscover against the live stack directory.
 */
import {
  promises as fsPromises,
  readFileSync,
  openSync,
  fstatSync,
  closeSync,
  constants as fsConstants,
} from 'fs';
import path from 'path';
import { DatabaseService, type StackGitSource } from './DatabaseService';
import { FileSystemService } from './FileSystemService';
import { GitProjectManifestService } from './GitProjectManifestService';
import { collectManifestFilePaths } from '../helpers/manifestFilePaths';
import { isDynamicPath, isHostAbsolutePath, parseDeclaredInputs } from '../helpers/composeInputParse';
import { isValidRelativeStackPath, isValidStackName } from '../utils/validation';
import { COMPOSE_OVERRIDE_FILENAMES, COMPOSE_ROOT_FILENAMES } from '../utils/composeFilenames';
import {
  authoredComposeEnvFileArgs,
  authoredComposeFileArgs,
  composeEnvFilesFromProcess,
  composeFileEnvVarSelection,
  DEFAULT_PATH_SEPARATOR,
} from '../utils/authoredComposeArgs';
import { gitSourceLocalComposeFiles } from '../utils/gitComposeFiles';
import type {
  ComposeInputEntry,
  GitProjectManifest,
  InputSensitivity,
} from '../types/gitProjectManifest';
import type {
  ResolvedRollbackInventory,
  RollbackEntryKind,
  RollbackEntryProvenance,
  RollbackInvocationRecord,
} from '../types/rollbackGeneration';

const DOT_ENV = '.' + 'env';

/**
 * A URL token inside a note: scheme, "://", and everything up to whitespace.
 * Redaction rewrites the whole token rather than matching credentials in place,
 * so the authority is parsed as an authority instead of scanned for "@".
 */
const URL_TOKEN_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/**
 * Strip everything before the host from a URL authority, plus the query and
 * fragment. Userinfo ends at the LAST "@" of the authority, because "@" is legal
 * unencoded inside a password (`https://user:p@ss@host`): stopping at the first
 * one leaves the rest of the password in the note. A "?" or "#" that appears
 * inside the authority is malformed, so it is kept with the userinfo instead of
 * being treated as the start of a query, which keeps nothing before the host.
 */
function redactUrlCredentials(token: string): string {
  const schemeEnd = token.indexOf('://') + 3;
  const scheme = token.slice(0, schemeEnd);
  const rest = token.slice(schemeEnd);
  const pathStart = rest.indexOf('/');
  const authority = pathStart === -1 ? rest : rest.slice(0, pathStart);
  const userinfoEnd = authority.lastIndexOf('@');
  const visible = (userinfoEnd === -1 ? authority : authority.slice(userinfoEnd + 1))
    + (pathStart === -1 ? '' : rest.slice(pathStart));
  const queryStart = visible.search(/[?#]/);
  const kept = queryStart === -1 ? visible : visible.slice(0, queryStart);
  return `${scheme}${userinfoEnd === -1 ? '' : '[redacted]@'}${kept}${queryStart === -1 ? '' : '?[redacted]'}`;
}

/**
 * Remove credentials from any URL in a note. Notes reach the generation
 * manifest, the capture log and the readiness API, so a URL include's userinfo,
 * query and fragment must be gone before the text leaves the inventory.
 */
function redactNoteCredentials(note: string): string {
  return note.replace(URL_TOKEN_PATTERN, redactUrlCredentials);
}

const COMPOSE_INVOCATION_KINDS = new Set<RollbackEntryKind>([
  'compose-root',
  'implicit-override',
  'explicit',
  'include',
  'extends',
]);

type InventoryAccum = {
  relativePath: string;
  dependencyKind: RollbackEntryKind;
  provenance: RollbackEntryProvenance;
  sensitivity: InputSensitivity;
  absolutePath: string | null;
};

function posixRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\.\//, '');
}

function foldedKey(rel: string): string {
  return posixRel(rel).toLowerCase();
}

/**
 * Prefer exact POSIX paths as map keys so case-distinct Linux paths are kept.
 * When two different paths collide under case-folding, record a refusal note
 * instead of silently merging them.
 */
function upsertEntry(
  map: Map<string, InventoryAccum>,
  foldedOwners: Map<string, string>,
  entry: InventoryAccum,
  caseCollisions: string[],
): void {
  const exact = posixRel(entry.relativePath);
  const folded = foldedKey(exact);
  const owner = foldedOwners.get(folded);
  if (owner !== undefined && owner !== exact) {
    caseCollisions.push(`Case-colliding managed paths "${owner}" and "${exact}"`);
    return;
  }
  const prev = map.get(exact);
  if (!prev) {
    map.set(exact, { ...entry, relativePath: exact });
    foldedOwners.set(folded, exact);
    return;
  }
  if (prev.absolutePath !== null && entry.absolutePath === null) return;
  map.set(exact, {
    ...entry,
    relativePath: exact,
    absolutePath: entry.absolutePath ?? prev.absolutePath,
    dependencyKind: prev.dependencyKind === 'compose-root' && entry.dependencyKind !== 'compose-root'
      ? entry.dependencyKind
      : entry.dependencyKind,
    sensitivity: higherSensitivity(entry.sensitivity, prev.sensitivity),
  });
}

function resolveStackRoot(fsSvc: FileSystemService, stackName: string): string {
  if (!isValidStackName(stackName)) {
    throw Object.assign(new Error('Invalid stack name'), { code: 'INVALID_STACK_NAME' });
  }
  // Canonical js/path-injection barrier: resolve + startsWith.
  // CodeQL does not credit isPathWithinBase helpers at later sinks.
  const base = path.resolve(fsSvc.getBaseDir());
  const stackRoot = path.resolve(base, stackName);
  if (!stackRoot.startsWith(base + path.sep)) {
    throw Object.assign(new Error('Stack name escapes compose directory'), { code: 'INVALID_PATH' });
  }
  return stackRoot;
}

function resolveStackRel(
  stackRoot: string,
  relRaw: string,
): { relativePath: string; absolutePath: string } | null {
  const relativePath = posixRel(relRaw);
  if (!relativePath || !isValidRelativeStackPath(relativePath)) return null;
  // Join-time containment; callers still re-check at each fs sink.
  const baseResolved = path.resolve(stackRoot);
  const absolutePath = path.resolve(baseResolved, relativePath);
  if (!absolutePath.startsWith(baseResolved + path.sep)) return null;
  return { relativePath, absolutePath };
}

/** Go's strconv.ParseBool true set, which is what Compose accepts for COMPOSE_DISABLE_ENV_FILE. */
const GO_BOOL_TRUE = new Set(['1', 't', 'T', 'TRUE', 'true', 'True']);

const PROJECT_ENV_OUTSIDE_NOTE =
  'a project env file is loaded by Compose from the selected project directory outside the stack and is not captured';

function flagValue(args: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag) return args[i + 1];
  }
  return undefined;
}

/** Every value of a repeated flag, in order: `--env-file` is applied per file. */
function flagValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag) values.push(args[i + 1]);
  }
  return values;
}

/**
 * Compose replaces the default project `.env` when the invocation names
 * `--env-file`, when COMPOSE_ENV_FILES lists a file, or when
 * COMPOSE_DISABLE_ENV_FILE is true. Those cases are accounted for elsewhere.
 */
function defaultProjectEnvSuppressed(args: readonly string[]): boolean {
  if (flagValue(args, '--env-file') !== undefined) return true;
  const listed = process.env.COMPOSE_ENV_FILES;
  if (listed !== undefined && listed.split(',').some((entry) => entry.length > 0)) return true;
  const disabled = process.env.COMPOSE_DISABLE_ENV_FILE;
  return disabled !== undefined && GO_BOOL_TRUE.has(disabled);
}

/** The directory whose `.env` Compose loads once the project directory is chosen. */
function selectedProjectDirectory(
  args: readonly string[],
  composeLayers: readonly string[],
): string | null {
  const explicit = flagValue(args, '--project-directory');
  if (explicit !== undefined && explicit.length > 0) return explicit.replace(/\\/g, '/');
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== '-f' && args[i] !== '--file') continue;
    return path.posix.dirname(args[i + 1].replace(/\\/g, '/'));
  }
  if (composeLayers.length === 0) return null;
  return path.posix.dirname(composeLayers[0].replace(/\\/g, '/'));
}

/**
 * The project `.env` Compose loads after it selects a project directory, when
 * that file is not the stack-root `.env` already in the inventory.
 *
 * The project directory is `--project-directory` when the invocation sets it,
 * otherwise the directory of the first `-f` / `--file`, otherwise the directory
 * of the first captured layer. A root project loads only the stack `.env`.
 * An explicit env file, COMPOSE_ENV_FILES, or COMPOSE_DISABLE_ENV_FILE replaces
 * that default, so this returns null and the other accounting stands.
 *
 * The project directory is resolved against the stack root, so a directory that
 * lands inside the stack names a file the generation can hold. A deploy spec
 * with a context directory names it by absolute path, and that path is inside
 * the stack, so it is a stack file rather than an outside one.
 * `outside` is a directory that lands outside the stack; the caller records an
 * omission without the absolute path.
 */
export function selectedProjectEnvFile(
  composeArgs: readonly string[],
  composeLayers: readonly string[] | undefined,
  stackRoot: string,
): { kind: 'relative'; relativePath: string } | { kind: 'outside' } | null {
  if (defaultProjectEnvSuppressed(composeArgs)) return null;
  const projectDir = selectedProjectDirectory(composeArgs, composeLayers ?? []);
  if (projectDir === null || projectDir === '.' || projectDir === '') return null;
  const baseResolved = path.resolve(stackRoot);
  const absoluteDir = path.resolve(baseResolved, projectDir);
  if (!absoluteDir.startsWith(baseResolved + path.sep)) return { kind: 'outside' };
  const relativeDir = posixRel(path.relative(baseResolved, absoluteDir));
  if (!relativeDir) return null;
  const relativePath = posixRel(`${relativeDir}/${DOT_ENV}`);
  if (relativePath === DOT_ENV) return null;
  if (!isValidRelativeStackPath(relativePath)) return { kind: 'outside' };
  return { kind: 'relative', relativePath };
}

/**
 * One env file a stored recovery invocation reads for interpolation.
 */
export interface RecoveryEnvInput {
  /** Absolute path of the file the run opens, in read order. */
  absolutePath: string;
  /**
   * True when the operator's own process environment selected the file
   * (COMPOSE_ENV_FILES). That value is handed to the child unchanged and is not
   * stored-invocation or request data, so a restore may classify the target
   * outside the compose root, as the spawn guard does.
   */
  fromProcessEnv: boolean;
}

/**
 * The interpolation env files a stored recovery invocation reads, in read order.
 *
 * Recovery replays the captured global-flag prefix instead of the live project
 * selection, and Compose reads one set: an explicit `--env-file` wins over
 * COMPOSE_ENV_FILES, which wins over the project `.env`. So an invocation that
 * names a file reads that file and nothing the current settings select. A
 * COMPOSE_FILE chain pin is replayed as the recorded `--env-file` list, which is
 * why the recorded list ranks with the captured flags. Only an invocation that
 * names no file falls back to the process list and the project `.env`. An
 * empty recorded list counts as naming an empty input, so it reads nothing.
 *
 * `stackRoot` is the working directory the recovery spawns in: a relative
 * COMPOSE_ENV_FILES entry resolves against it, and an unnamed project `.env` is
 * looked for there or in the selected project directory below it.
 */
export function recoveryInvocationEnvFiles(
  invocation: RollbackInvocationRecord,
  stackRoot: string,
): RecoveryEnvInput[] {
  const explicit = flagValues(invocation.composeArgsPrefix, '--env-file');
  if (explicit.length > 0) {
    return explicit.map((envPath) => ({
      absolutePath: path.resolve(envPath),
      fromProcessEnv: false,
    }));
  }
  const recorded = invocation.interpolationEnvFiles;
  if (recorded !== undefined) {
    // An empty record is replayed as an empty env input, which also replaces a
    // COMPOSE_ENV_FILES list and the project `.env`, so nothing is read.
    return recorded.map((rel) => ({
      absolutePath: path.resolve(stackRoot, rel),
      fromProcessEnv: false,
    }));
  }
  const listed = composeEnvFilesFromProcess();
  if (listed.length > 0) {
    return listed.map((entry) => ({
      absolutePath: path.resolve(stackRoot, entry),
      fromProcessEnv: true,
    }));
  }
  const disabled = process.env.COMPOSE_DISABLE_ENV_FILE;
  if (disabled !== undefined && GO_BOOL_TRUE.has(disabled)) return [];
  const projectEnv = selectedProjectEnvFile(
    invocation.composeArgsPrefix,
    invocation.composeLayers,
    stackRoot,
  );
  if (projectEnv?.kind === 'relative') {
    return [{
      absolutePath: path.resolve(stackRoot, projectEnv.relativePath),
      fromProcessEnv: false,
    }];
  }
  // An outside project directory names a file no stack-relative check can
  // classify; Compose reports it itself, so it is not this refusal.
  if (projectEnv?.kind === 'outside') return [];
  return [{ absolutePath: path.resolve(stackRoot, DOT_ENV), fromProcessEnv: false }];
}

/**
 * The env files a recovery run must name so a pinned COMPOSE_FILE selection
 * renders with the interpolation values the live run rendered with.
 *
 * Compose keeps the working directory's env file in the interpolation
 * environment while it resolves a COMPOSE_FILE chain, on top of the project
 * directory's default, with the working-directory file winning a key both
 * define. An explicit `-f` list, which is what recovery pins, replaces that
 * variable and drops the working-directory file, so a value only the stack
 * root `.env` holds would fall back or flip after a rollback that reports
 * complete coverage. The flags below reproduce the live order: Compose
 * applies repeated `--env-file` arguments in sequence, the last one winning.
 *
 * Only files a recovery resolver can name are listed: a regular file, or a
 * link whose target stays inside the compose root. An env file that links
 * out of the compose root is left to the omission its classifier already
 * records, because naming it would make recovery refuse the generation
 * before Compose could read the file. `undefined` means this function names
 * no file: either every default env file is absent, which the caller records
 * as an empty list (see defaultEnvFilesAbsent), or one cannot be named, which
 * leaves the invocation recorded without a list. A file this reader cannot inspect throws, and the
 * caller refuses the capture: a list built around an unreadable file could
 * omit one the live run loaded, which is the silent divergence this field
 * exists to prevent.
 */
async function capturedInterpolationEnvFiles(
  stackRoot: string,
  projectEnvRel: string,
): Promise<string[] | undefined> {
  const projectEnvState = await classifyAuthoredFile(stackRoot, projectEnvRel);
  const rootEnvState = await classifyAuthoredFile(stackRoot, DOT_ENV);
  if (projectEnvState === 'outside' || rootEnvState === 'outside') return undefined;
  const files: string[] = [];
  if (projectEnvState === 'file' || projectEnvState === 'shared') files.push(projectEnvRel);
  if (rootEnvState === 'file' || rootEnvState === 'shared') files.push(DOT_ENV);
  return files.length > 0 ? files : undefined;
}

/**
 * True when nothing exists at any default env path the captured invocation
 * leaves to Compose: the stack root `.env`, and the selected project
 * directory's `.env` when the layers moved the project off the root. A
 * pinned `COMPOSE_FILE` chain keeps the working directory's `.env` in the
 * interpolation environment beside the project directory's, so both count
 * there; an explicit `-f` or `--project-directory` moves the project and
 * Compose reads only the project directory's file. Recovery
 * cannot pin a file that does not exist, so the absence is recorded and
 * replayed instead. Anything present (a file, a link, a directory, a special
 * file) is not an absence: the inventory entry, the classifier's omission
 * notes, or the restore-time type check already accounts for it.
 */
async function defaultEnvFilesAbsent(
  stackRoot: string,
  projectEnvRel: string | null,
  chainPinned: boolean,
): Promise<boolean> {
  const candidates = projectEnvRel === null
    ? [DOT_ENV]
    : chainPinned ? [projectEnvRel, DOT_ENV] : [projectEnvRel];
  const baseResolved = path.resolve(stackRoot);
  for (const rel of candidates) {
    // Inline barrier at the lstat sink.
    const abs = path.resolve(baseResolved, rel);
    if (!abs.startsWith(baseResolved + path.sep)) return false;
    try {
      await fsPromises.lstat(abs);
      return false;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
    }
  }
  return true;
}

async function pathExistsAsFile(stackRoot: string, relativePath: string): Promise<boolean> {
  // Inline barrier at the lstat sink.
  const baseResolved = path.resolve(stackRoot);
  const abs = path.resolve(baseResolved, relativePath);
  if (!abs.startsWith(baseResolved + path.sep)) return false;
  try {
    const st = await fsPromises.lstat(abs);
    return st.isFile() || st.isSymbolicLink();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

/**
 * Read a compose input as text only when the descriptor is a regular file.
 * O_NONBLOCK returns immediately for a FIFO; the descriptor's own type then
 * decides, so a target swapped after classification cannot hold this worker in
 * a blocking open. A FIFO with no writer would otherwise wait forever.
 */
async function readComposeText(absolutePath: string): Promise<string> {
  const fh = await fsPromises.open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    if (!(await fh.stat()).isFile()) {
      throw Object.assign(new Error('not a regular file'), { code: 'NOT_A_FILE' });
    }
    return await fh.readFile('utf-8');
  } finally {
    await fh.close();
  }
}

/** The synchronous form used by the declared-input walker; null when unreadable. */
function readComposeTextSync(absolutePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return null;
    return readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * What an authored candidate path is, resolved the way capture will read it.
 * - file: a regular file, or a link to one, that stays inside the stack.
 * - absent: nothing there, or a directory or special file.
 * - shared: a link whose target is inside the shared compose directory but
 *   outside this stack. A read or a deploy follows it, a save and a restore do
 *   not, so it is recorded as an input the generation cannot hold.
 * - outside: resolves outside the compose directory (a link on the path itself
 *   or on any parent directory).
 * - relocated: the stack directory itself is a link to another location, so the
 *   file belongs to whatever directory it really lives in.
 * - dangling / loop: a link that reaches nothing, or never ends.
 * - not-a-file: a link whose target is a directory or special file.
 */
type AuthoredFileState =
  | 'file'
  | 'absent'
  | 'shared'
  | 'outside'
  | 'relocated'
  | 'dangling'
  | 'loop'
  | 'not-a-file';

const LINK_PROBLEMS: Record<Exclude<AuthoredFileState, 'file' | 'absent'>, string> = {
  shared: 'links outside the stack directory into the shared compose directory',
  outside: 'links outside the compose directory',
  relocated: 'is in a stack directory that links to another location',
  dangling: 'is a link to a missing file',
  loop: 'is a link that never resolves',
  'not-a-file': 'is a link to something that is not a regular file',
};

/**
 * Classify an authored candidate before capture reads it, so a link that a
 * generation cannot hold is reported instead of making capture throw.
 */
async function classifyAuthoredFile(stackRoot: string, relativePath: string): Promise<AuthoredFileState> {
  // Inline containment barrier before every fs sink below.
  const baseResolved = path.resolve(stackRoot);
  const abs = path.resolve(baseResolved, relativePath);
  if (!abs.startsWith(baseResolved + path.sep)) return 'absent';
  let st;
  try {
    st = await fsPromises.lstat(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'absent';
    if (code === 'ELOOP') return 'loop';
    throw e;
  }
  if (!st.isFile() && !st.isSymbolicLink()) return 'absent';
  // Always resolve: lstat does not see a link on a parent directory.
  let real: string;
  try {
    real = await fsPromises.realpath(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'dangling';
    if (code === 'ELOOP') return 'loop';
    throw e;
  }
  // Same root capture uses: the real compose dir plus the stack name, so a
  // stack dir that links elsewhere is refused and a linked compose dir is not.
  const realBase = await fsPromises.realpath(path.dirname(baseResolved));
  const realRoot = path.join(realBase, path.basename(baseResolved));
  if (real.startsWith(realRoot + path.sep)) {
    return (await fsPromises.stat(real)).isFile() ? 'file' : 'not-a-file';
  }
  // A stack directory that is itself a link is a different stack's directory,
  // not a shared file, so it keeps the refusal the read and write guards raise.
  if ((await fsPromises.realpath(baseResolved)) !== realRoot) return 'relocated';
  if (!real.startsWith(realBase + path.sep)) return 'outside';
  // The shared directory may hold a directory, FIFO, or socket under a name a
  // stack links to. Compose can read only a regular target; classifying one as
  // `shared` would list it as an omission and then try to read it, blocking on a
  // FIFO. A shared regular file stays `shared` and keeps its supported read path.
  return (await fsPromises.stat(real)).isFile() ? 'shared' : 'not-a-file';
}

/**
 * The layers a COMPOSE_FILE value names, in order. Split on the active
 * separator only, because Compose does: on a stock configuration a layer may
 * legitimately contain a semicolon, and splitting on both would turn one valid
 * name into two unresolvable ones. Compose applies the same naive split to
 * whatever separator it is given, so matching it exactly is what reproduces the
 * chain. An empty COMPOSE_PATH_SEPARATOR falls back to the default, as it does
 * there. An empty entry is kept: Compose rejects a chain that names one, so
 * dropping it here would pin a layer set the live run never loaded.
 */
function parseComposeFileChain(value: string, separator: string): string[] {
  return value.split(separator.length > 0 ? separator : DEFAULT_PATH_SEPARATOR);
}

/**
 * The stack directory's physical path, for a compose root that is itself a
 * link (a relocated data directory). Only the parent is resolved and the stack
 * name is re-joined, so a stack directory that links elsewhere is not followed.
 * Mirrors the rule `classifyAuthoredFile` applies to a captured candidate.
 */
async function realStackRoot(stackRoot: string): Promise<string> {
  const baseResolved = path.resolve(stackRoot);
  const realBase = await fsPromises.realpath(path.dirname(baseResolved));
  return path.join(realBase, path.basename(baseResolved));
}

/**
 * The physical path a binding target resolves to. An existing target is
 * resolved in full; a target that does not exist yet is resolved through its
 * real parent, so a symlink alias into the stack is still recognized once the
 * file it names appears. A path whose parent cannot be resolved keeps no
 * physical form. This is what makes an alias transparent: a bind may name a
 * symlink outside the stack whose target is a managed file inside it, and
 * deleting that target would delete the mounted data.
 */
async function physicalEntry(absolute: string): Promise<string | null> {
  try {
    return await fsPromises.realpath(absolute);
  } catch {
    try {
      const parent = await fsPromises.realpath(path.dirname(absolute));
      return path.join(parent, path.basename(absolute));
    } catch {
      return null;
    }
  }
}

/**
 * A Compose source spelling resolved the way the live run loads it. Compose
 * takes an absolute entry as written and resolves a relative one against its
 * working directory, which is the stack directory for every Sencho spawn, so a
 * spelling that names a file inside the authorized stack is the same source as
 * its plain relative form and is normalized to it: a recovery run pins layers
 * by their stack-relative name, and application-data ownership must see one
 * path, not two spellings. A relative `..` that leaves and re-enters the stack
 * resolves too, and so does an alias outside the stack whose physical target
 * is inside it. The real root is matched as well, so a relocated (linked)
 * compose directory resolves, the same way every other containment check in the
 * capture treats it. Only a path proven inside the stack is normalized;
 * anything else stays unpinnable and is reported by the caller.
 */
async function resolveStackSource(
  stackRoot: string,
  entry: string,
): Promise<{ relativePath: string; absolutePath: string } | null> {
  const hostSpelling = isHostAbsolutePath(entry);
  // Home-relative, drive-relative, and non-native absolute forms are host
  // spellings, not relative names. They must not fall through to the lexical
  // relative resolver, which would adopt a literal `~` directory in the stack.
  if (hostSpelling && !path.isAbsolute(entry)) return null;
  const direct = hostSpelling ? null : resolveStackRel(stackRoot, entry);
  if (direct) return direct;
  const baseResolved = path.resolve(stackRoot);
  let realRoot: string;
  try {
    realRoot = await realStackRoot(baseResolved);
  } catch {
    // The compose root cannot be resolved, so nothing can be shown to live
    // inside it and the lexical comparison stands as the only one.
    realRoot = baseResolved;
  }
  // An absolute spelling is taken as written. A relative one is resolved
  // against the stack working directory, and against the physical root too
  // when the root is a link; `..` is allowed as long as the result stays
  // inside. Each spelling is also resolved through its physical form, so an
  // alias whose target is a stack file is normalized to that file's path.
  const spellings = isHostAbsolutePath(entry)
    ? [path.resolve(entry)]
    : [path.resolve(baseResolved, entry), path.resolve(realRoot, entry)];
  const candidates: string[] = [];
  for (const absolute of spellings) {
    candidates.push(absolute);
    const physical = await physicalEntry(absolute);
    if (physical && physical !== absolute) candidates.push(physical);
  }
  for (const root of [baseResolved, realRoot]) {
    for (const absolute of candidates) {
      if (!absolute.startsWith(root + path.sep)) continue;
      const relative = posixRel(path.relative(root, absolute));
      const resolved = relative ? resolveStackRel(stackRoot, relative) : null;
      if (resolved) return resolved;
    }
  }
  return null;
}

/**
 * The stack-relative name of the physical file a resolved source points to,
 * when that file is itself inside the stack. A relative bind can name a symlink
 * inside the stack (`./alias.env` -> `./data.env`); both names must carry the
 * ownership record, because deleting the target deletes the data the bind
 * mounts even though the spelling named the link. A source with no physical
 * form, or one whose target is outside, adds nothing.
 */
async function physicalStackPath(
  stackRoot: string,
  absolutePath: string,
): Promise<string | null> {
  const physical = await physicalEntry(absolutePath);
  if (!physical) return null;
  const baseResolved = path.resolve(stackRoot);
  let realRoot: string;
  try {
    realRoot = await realStackRoot(baseResolved);
  } catch {
    realRoot = baseResolved;
  }
  for (const root of [baseResolved, realRoot]) {
    if (!physical.startsWith(root + path.sep)) continue;
    const relative = posixRel(path.relative(root, physical));
    const resolved = relative ? resolveStackRel(stackRoot, relative) : null;
    if (resolved) return resolved.relativePath;
  }
  return null;
}

/** Whether a source stats as a directory, following links; false if absent. */
async function isDirectoryPath(absolutePath: string): Promise<boolean> {
  try {
    return (await fsPromises.stat(absolutePath)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether a bind source is the stack root or an ancestor of it. Such a source
 * mounts every stack path, so no live file is provably disposable. The source
 * is checked in both coordinate systems and through its physical form, which
 * covers `.`, `..`, an absolute root spelling, and an alias to the root or an
 * ancestor.
 */
async function bindContainsStack(
  stackRoot: string,
  sourcePath: string | null,
  materializedPath: string | null,
): Promise<boolean> {
  const baseResolved = path.resolve(stackRoot);
  let realRoot: string;
  try {
    realRoot = await realStackRoot(baseResolved);
  } catch {
    realRoot = baseResolved;
  }
  const roots = [baseResolved, realRoot];
  const spellings = new Set<string>();
  let unresolvedDrive = false;
  const addSpelling = (raw: string | null, base: string): void => {
    if (raw === null) return;
    if (isHostAbsolutePath(raw)) {
      if (path.isAbsolute(raw)) spellings.add(path.resolve(raw));
      // A drive-relative spelling (`C:.`, `C:..`, `C:foo`) is resolved by the
      // host against the current directory on that drive. The stack may be
      // there, so it is unresolved rather than provably outside.
      else if (/^[A-Za-z]:/.test(raw)) unresolvedDrive = true;
      return;
    }
    spellings.add(path.resolve(base, raw));
  };
  for (const base of roots) {
    addSpelling(sourcePath, base);
    addSpelling(materializedPath, base);
  }
  if (unresolvedDrive) return true;
  for (const spelling of spellings) {
    if (roots.some((root) => spelling === root || root.startsWith(spelling + path.sep))) return true;
    const physical = await physicalEntry(spelling);
    if (physical && roots.some((root) => physical === root || root.startsWith(physical + path.sep))) {
      return true;
    }
  }
  return false;
}

/**
 * The implicit override docker compose would auto-discover: the first candidate
 * whose target stats as something, which is compose's own rule. A dangling link
 * is skipped exactly as Compose skips it, while a link to a real file elsewhere
 * is returned so the capture refuses the file a run would actually load instead
 * of quietly selecting a lower-priority name Compose never reads.
 */
async function firstSelectedLayer(
  stackRoot: string,
  names: readonly string[],
): Promise<string | null> {
  for (const name of names) {
    const resolved = resolveStackRel(stackRoot, name);
    if (!resolved) continue;
    const state = await classifyAuthoredFile(stackRoot, resolved.relativePath);
    if (state === 'absent' || state === 'dangling' || state === 'loop') continue;
    return resolved.relativePath;
  }
  return null;
}

/**
 * Why a COMPOSE_FILE chain entry cannot be pinned. Compose rejects a chain that
 * names an empty entry, so that case is named as such rather than described as a
 * path. A dollar sign is not itself a reason to refuse: the reader expands every
 * template Compose would expand, so a `$` that survives is a literal character
 * in a filename, which Compose loads.
 */
function describeUnusableLayer(entry: string): string {
  if (entry.length === 0) {
    return 'COMPOSE_FILE names an empty compose layer, which Compose rejects';
  }
  return `Compose layer "${entry}" is selected by COMPOSE_FILE and is not a path inside the stack directory`;
}

/** Kinds that are application data or build inputs, never part of a generation. */
const UNCAPTURED_SILENT_KINDS = new Set<RollbackEntryKind>([
  'bind-mount',
  'build-context',
  'build-additional-context',
  'dockerfile',
]);

/**
 * Stand-in for a silent host declaration in a Git manifest written before
 * host-form source spellings were recorded. The manifest kept no path, so the
 * live inventory cannot tell whether the declaration names a stack path. The
 * value travels in `dynamicApplicationDataSources`, whose consumer only asks
 * whether the set is non-empty, and keeps a restore from deleting anything.
 */
const LEGACY_HOST_SOURCE_MARKER = '<legacy host declaration: path not recorded>';

/**
 * A bind source that is the stack root itself or an ancestor of it mounts
 * every stack path. No live path is provably disposable, so the same
 * delete-none signal as a dynamic source is recorded.
 */
const STACK_CONTAINING_BIND_MARKER = '<bind source contains the stack>';

/**
 * True for entry kinds that are application data or build inputs. A restore
 * forwards live entries as managed cleanup candidates; these kinds are not
 * managed paths, so a live entry of one never travels, and a data file or
 * link that appeared after capture survives the restore. Captured entries of
 * these kinds are still held files the restore writes back.
 */
export function isApplicationDataKind(kind: RollbackEntryKind): boolean {
  return UNCAPTURED_SILENT_KINDS.has(kind);
}

function authoredSensitivity(kind: RollbackEntryKind): InputSensitivity {
  if (kind === 'secret' || kind === 'config' || kind === 'build-secret') return 'high';
  if (
    kind === 'env_file'
    || kind === 'include-env'
    || kind === 'interpolation-env'
    || kind === 'sync-env'
    || kind === 'project-env'
    || kind === 'label_file'
  ) {
    return 'medium';
  }
  return 'low';
}

function higherSensitivity(a: InputSensitivity, b: InputSensitivity): InputSensitivity {
  if (a === 'high' || b === 'high') return 'high';
  if (a === 'medium' || b === 'medium') return 'medium';
  return 'low';
}

function appliedDeploySpecString(
  spec: { files: string[]; contextDir: string | null } | null | undefined,
): string | null {
  if (!spec) return null;
  return JSON.stringify(spec);
}

function refusedGitInventory(
  gitSource: StackGitSource,
  emptyInvocation: RollbackInvocationRecord,
  coverageRefusal: string,
  manifestVersion: number | null = gitSource.manifest_version,
): ResolvedRollbackInventory {
  return {
    entries: [],
    invocation: emptyInvocation,
    git: {
      repoUrl: gitSource.repo_url,
      branch: gitSource.branch,
      commitSha: gitSource.last_applied_commit_sha || '',
      manifestVersion,
    },
    appliedDeploySpec: appliedDeploySpecString(gitSource.applied_deploy_spec),
    lastAppliedContentHash: gitSource.last_applied_content_hash,
    manifestState: gitSource.manifest_state,
    manifestGeneration: gitSource.manifest_generation,
    coverageRefusal,
    recoveryRefusal: null,
    uncapturedInputs: [],
    uncapturedRelativePaths: [],
    ownedUncapturedRelativePaths: [],
    applicationDataPaths: [],
    applicationDataPathPrefixes: [],
    dynamicApplicationDataSources: [],
    unparsedComposeSources: [],
  };
}

function isGitManifest(
  value: GitProjectManifest | { corrupt: string } | null,
): value is GitProjectManifest {
  return value !== null && !('corrupt' in value);
}

function sensitivityForManifestPath(
  manifest: GitProjectManifest,
  rel: string,
): { kind: RollbackEntryKind; sensitivity: InputSensitivity; provenance: RollbackEntryProvenance } {
  const key = foldedKey(rel);
  const input = manifest.inputs.find(
    (i: ComposeInputEntry) => i.materializedPath !== null && foldedKey(i.materializedPath) === key,
  );
  if (input) {
    return {
      kind: input.dependencyKind,
      sensitivity: input.sensitivity,
      provenance: input.provenance,
    };
  }
  return { kind: 'other', sensitivity: 'low', provenance: 'fetch' };
}

async function resolveGitInventory(
  nodeId: number,
  stackName: string,
  stackRoot: string,
): Promise<ResolvedRollbackInventory | null> {
  const gitSource = DatabaseService.getInstance().getGitSource(stackName);
  if (!gitSource) return null;

  const emptyInvocation: RollbackInvocationRecord = {
    composeArgsPrefix: [],
    projectDirectory: null,
    projectName: stackName,
    explicitComposeFiles: [],
    composeLayers: [],
    meshOverrideRelativePath: null,
    meshEnabled: false,
  };

  const read = await GitProjectManifestService.getInstance().readManifest(
    stackName,
    gitSource.repo_url,
    gitSource.branch,
  );
  if (!isGitManifest(read)) {
    const corrupt = Boolean(read && 'corrupt' in read);
    const reason = corrupt
      ? `Managed-project manifest is unreadable (${(read as { corrupt: string }).corrupt}). Fix or re-link the Git source before capturing rollback coverage.`
      : 'Managed-project manifest is missing. Pull or re-link the Git source before capturing rollback coverage.';

    const established = Boolean(
      gitSource.applied_deploy_spec
      || gitSource.last_applied_content_hash
      || gitSource.last_applied_commit_sha,
    );

    // Established missing/corrupt manifesto: fail closed. applied_deploy_spec
    // alone cannot claim exact managed-input coverage (includes, extends, env,
    // labels, configs, secrets, and build inputs are omitted).
    if (established || corrupt) {
      return refusedGitInventory(gitSource, emptyInvocation, reason);
    }

    // First apply (no applied revision yet): signal incomplete Git coverage so
    // resolveRollbackInventory can merge authored disk files with this identity.
    return refusedGitInventory(gitSource, emptyInvocation, reason, null);
  }

  const map = new Map<string, InventoryAccum>();
  const foldedOwners = new Map<string, string>();
  const caseCollisions: string[] = [];
  for (const rel of collectManifestFilePaths(read)) {
    const resolved = resolveStackRel(stackRoot, rel);
    if (!resolved) continue;
    const meta = sensitivityForManifestPath(read, resolved.relativePath);
    const exists = await pathExistsAsFile(stackRoot, resolved.relativePath);
    upsertEntry(map, foldedOwners, {
      relativePath: resolved.relativePath,
      dependencyKind: meta.kind,
      provenance: meta.provenance,
      sensitivity: meta.sensitivity,
      absolutePath: exists ? resolved.absolutePath : null,
    }, caseCollisions);
  }

  // The manifest persists application-data declarations separately from the
  // managed file list: host forms have no path, dynamic forms keep only the
  // source template, and an in-repo bind is an unmanaged or managed input. The
  // generation's managed-path record is not enough to keep a restore from
  // treating one of those paths as disposable, so collect their ownership here
  // the same way the authored inventory does.
  const gitAppDataPaths = new Set<string>();
  const gitAppDataPathPrefixes = new Set<string>();
  const gitDynamicAppDataSources = new Set<string>();
  for (const input of read.inputs) {
    if (!UNCAPTURED_SILENT_KINDS.has(input.dependencyKind)) continue;
    if (input.sourcePath !== null && isDynamicPath(input.sourcePath)) {
      gitDynamicAppDataSources.add(input.sourcePath);
      continue;
    }
    const hostSourcePath = input.hostSourcePath ?? null;
    if (input.sourcePath === null && input.materializedPath === null && hostSourcePath === null) {
      // A manifest from before host-source recording has no spelling for a
      // host bind or build input. It may name any stack path, so record the
      // same delete-none signal a dynamic source uses.
      gitDynamicAppDataSources.add(LEGACY_HOST_SOURCE_MARKER);
      continue;
    }
    // A host-form declaration keeps its raw spelling separately because the
    // manifest's sourcePath is null for every host reference. Resolve that
    // spelling too, so an absolute or `..` bind that names a stack path is
    // protected exactly like a relative bind.
    const candidate = hostSourcePath ?? input.materializedPath ?? input.sourcePath;
    if (
      input.dependencyKind === 'bind-mount'
      && await bindContainsStack(stackRoot, candidate, input.materializedPath)
    ) {
      // Mounting the stack root or an ancestor mounts every managed path.
      gitDynamicAppDataSources.add(STACK_CONTAINING_BIND_MARKER);
      continue;
    }
    if (!candidate) continue;
    const resolved = await resolveStackSource(stackRoot, candidate);
    if (resolved) {
      gitAppDataPaths.add(resolved.relativePath);
      const physical = await physicalStackPath(stackRoot, resolved.absolutePath);
      if (physical) gitAppDataPaths.add(physical);
      // A directory bind mounts everything beneath it. A managed env file that
      // appears under that directory later is data, not a stale file.
      if (input.dependencyKind === 'bind-mount' && await isDirectoryPath(resolved.absolutePath)) {
        gitAppDataPathPrefixes.add(resolved.relativePath);
        if (physical) gitAppDataPathPrefixes.add(physical);
      }
    }
  }

  const refused = read.refusals.length > 0
    || read.counts.refused > 0
    || read.state === 'unsupported'
    || read.state === 'partial'
    || caseCollisions.length > 0;
  const coverageRefusal = refused
    ? (caseCollisions[0]
      ?? read.refusals[0]?.reason
      ?? `Managed-project manifest state "${read.state}" does not claim exact coverage`)
    : null;

  let meshEnabled = false;
  let meshReadFailed: string | null = null;
  try {
    meshEnabled = DatabaseService.getInstance().isMeshStackEnabled(nodeId, stackName);
  } catch (e) {
    meshReadFailed = `Could not read Mesh enablement: ${(e as Error).message}`;
  }

  const invocation: RollbackInvocationRecord = {
    composeArgsPrefix: [...read.project.invocation],
    projectDirectory: read.project.effectiveProjectDir,
    projectName: read.project.projectName || stackName,
    explicitComposeFiles: [...gitSourceLocalComposeFiles(read.project.composeFiles)],
    // The manifest's compose files are the deploy's own -f list. A single-file
    // project with no context directory leaves the invocation to Compose's
    // discovery, which also loads the implicit override the manifest holds, so
    // that override is a layer of the project too. Pinning only the configured
    // file would drop it from every recovery run. An override missing from disk
    // is not pinned: Compose skips an absent optional override, but an explicit
    // -f for it would fail the run.
    composeLayers: [
      ...gitSourceLocalComposeFiles(read.project.composeFiles),
      ...read.inputs.flatMap((input) => (
        input.dependencyKind === 'implicit-override'
        && input.ownership === 'managed'
        && input.state === 'present'
        && input.materializedPath !== null
        && map.get(posixRel(input.materializedPath))?.absolutePath != null
          ? [input.materializedPath]
          : []
      )),
    ],
    meshOverrideRelativePath: null,
    meshEnabled,
  };

  const refusal = coverageRefusal ?? meshReadFailed;
  const uncaptured = new Set<string>();
  const uncapturedPaths = new Set<string>();
  let recoveryRefusal: string | null = null;
  // Only an invalid selection, or env files this reader cannot inspect, refuse
  // the capture here; an unknown selection is an accepted partial input the
  // manifest can still pin layers over.
  let invalidSelectionRefusal: string | null = null;
  if (refusal === null) {
    // The manifest is this generation's canonical file inventory, so it is also
    // its coverage boundary: an env file the run loads for interpolation that the
    // manifest does not hold can never be captured here. Compose reads those on
    // top of the -f list the manifest pins, so a -f pin says which layers the
    // project has, not which environment renders it. Recording them keeps the
    // generation from claiming an exact restore it cannot make; a partial restore
    // reads their current content, which is what the note says.
    //
    // This runs for an unknown selection too, because unknown means this reader
    // could not decide rather than that the run failed: a path the compose-root
    // containment refused here is one Compose can still read, so skipping it would
    // certify coverage the generation does not have. Only a selection with no
    // nameable file at all (a file list Compose would refuse, or env args Sencho
    // could not build) leaves nothing to record. An omission never blocks a
    // capture, so over-reporting here is the safe direction.
    //
    // A selected file that is not a regular file is the one case that is not an
    // omission: Compose cannot read it, so a run would wait on it or fail on it
    // instead of rendering the project. Refuse, whatever pinned the layer set.
    // An undecidable selection is not a refusal but still leaves the live
    // project's resolved paths unprovable, so both keep a restore from deleting
    // live paths on evidence it cannot classify.
    const selection = await composeFileEnvVarSelection(stackName, nodeId);
    if (selection.kind === 'invalid') invalidSelectionRefusal = selection.reason;
    if (selection.kind === 'invalid' || selection.kind === 'unknown') {
      recoveryRefusal = selection.reason;
    }
    if (selection.kind !== 'invalid') {
      for (const envPath of selection.loadedEnvFiles) {
        const resolved = resolveStackRel(stackRoot, posixRel(path.relative(stackRoot, envPath)));
        if (!resolved) {
          uncaptured.add(redactNoteCredentials(
            `${path.basename(envPath)} is loaded by Compose for interpolation from outside the stack directory and is not captured`,
          ));
          continue;
        }
        if (map.has(resolved.relativePath)) continue;
        uncapturedPaths.add(resolved.relativePath);
        uncaptured.add(redactNoteCredentials(
          `${resolved.relativePath} is loaded by Compose for interpolation and is not captured`,
        ));
      }
      // A `-f` or COMPOSE_FILE chain moves the project directory, and Compose then
      // loads that directory's `.env` as well as any file the invocation named.
      // The manifest is still the coverage boundary, so a file it does not hold
      // is an omission rather than a capture.
      const projectEnv = selectedProjectEnvFile(
        invocation.composeArgsPrefix,
        invocation.composeLayers,
        stackRoot,
      );
      if (projectEnv?.kind === 'outside') {
        uncaptured.add(redactNoteCredentials(PROJECT_ENV_OUTSIDE_NOTE));
      } else if (
        projectEnv?.kind === 'relative'
        && !map.has(projectEnv.relativePath)
        && await pathExistsAsFile(stackRoot, projectEnv.relativePath)
      ) {
        uncapturedPaths.add(projectEnv.relativePath);
        uncaptured.add(redactNoteCredentials(
          `${projectEnv.relativePath} is loaded by Compose from the selected project directory and is not captured`,
        ));
      }
      // A default env file the manifest does not hold and that does not exist
      // is part of the captured project, not a gap in it. A recovery that left
      // discovery to Compose would read a file the operator creates afterwards,
      // which a restore keeps because the manifest never owned it, so the
      // absence is recorded and replayed as an empty env input. A file that
      // exists is the omission recorded above and its current content is read.
      const projectEnvRel = projectEnv?.kind === 'relative' ? projectEnv.relativePath : null;
      if (
        projectEnv?.kind !== 'outside'
        && !defaultProjectEnvSuppressed(invocation.composeArgsPrefix)
        && !map.has(projectEnvRel ?? DOT_ENV)
      ) {
        try {
          if (await defaultEnvFilesAbsent(stackRoot, projectEnvRel, false)) invocation.interpolationEnvFiles = [];
        } catch (e) {
          invalidSelectionRefusal = `Could not inspect the interpolation env files for rollback capture: ${(e as Error).message}`;
        }
      }
    }
  }
  const liveRefusal = refusal ?? invalidSelectionRefusal;

  return {
    entries: [...map.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    invocation,
    git: {
      repoUrl: read.repo.url,
      branch: read.repo.branch,
      commitSha: read.resolvedRevision.commitSha || gitSource.last_applied_commit_sha || '',
      manifestVersion: read.manifestVersion,
    },
    appliedDeploySpec: appliedDeploySpecString(gitSource.applied_deploy_spec),
    lastAppliedContentHash: gitSource.last_applied_content_hash,
    manifestState: gitSource.manifest_state,
    manifestGeneration: gitSource.manifest_generation,
    coverageRefusal: liveRefusal,
    recoveryRefusal,
    uncapturedInputs: liveRefusal === null ? [...uncaptured] : [],
    uncapturedRelativePaths: liveRefusal === null
      ? [...uncapturedPaths].sort((a, b) => a.localeCompare(b))
      : [],
    // Every path above is an env file the manifest deliberately does not own
    // (deletionAuthority 'none'), so none is a cleanup candidate: the operator's
    // file stays whether it existed at capture or appeared afterwards.
    ownedUncapturedRelativePaths: [],
    // The manifest names one input per path, so a path's kind is its only
    // role here; there is no merged-kind ambiguity to protect against. An
    // unmanaged bind may not appear in the managed file map, so the collected
    // set is unioned in.
    applicationDataPaths: liveRefusal === null
      ? [...new Set([
        ...[...map.values()]
          .filter((entry) => isApplicationDataKind(entry.dependencyKind))
          .map((entry) => entry.relativePath),
        ...gitAppDataPaths,
      ])].sort((a, b) => a.localeCompare(b))
      : [],
    applicationDataPathPrefixes: liveRefusal === null
      ? [...gitAppDataPathPrefixes].sort((a, b) => a.localeCompare(b))
      : [],
    // A dynamic managed input has no path to hold; the manifest preserves its
    // source template as an unmanaged entry, so a restore knows it cannot
    // prove any remaining live path is disposable. A legacy host declaration
    // with no recorded spelling is reported the same way.
    dynamicApplicationDataSources: liveRefusal === null
      ? [...gitDynamicAppDataSources].sort((a, b) => a.localeCompare(b))
      : [],
    unparsedComposeSources: [],
  };
}

async function resolveAuthoredInventory(
  nodeId: number,
  stackName: string,
  stackRoot: string,
): Promise<ResolvedRollbackInventory> {
  const map = new Map<string, InventoryAccum>();
  const foldedOwners = new Map<string, string>();
  const coverageNotes: string[] = [];
  const caseCollisions: string[] = [];
  const uncaptured = new Set<string>();
  const uncapturedPaths = new Set<string>();
  // Paths any silent-kind input references, whatever their file state and
  // whatever managed input also names them: the sticky ownership record a
  // restore reads to keep application data out of live cleanup.
  const appDataPaths = new Set<string>();
  const appDataPathPrefixes = new Set<string>();
  // Application-data sources whose path holds a variable. The resolved path is
  // unknown and can change before restore, so a suffix is no proof of ownership;
  // a generation that records one deletes nothing from the live discovery set.
  const dynamicAppDataSources = new Set<string>();
  // Compose declarations whose referenced content was not parsed: a selected
  // COMPOSE_FILE layer outside the conventional root candidates, or an
  // include/extends source outside the stack or selected through a variable.
  // A restore cannot treat the live project as complete while one exists.
  const unparsedComposeSources = new Set<string>();
  // Set when the live project loads an interpolation env file that is not a
  // regular file. Capture refuses through coverageNotes below. A restore keeps it
  // as a live-ownership signal: the stored invocation may read a different file,
  // so the restore decides the refusal from that file and keeps every live path
  // when this one is unusable.
  let recoveryRefusal: string | null = null;

  /**
   * Notes reach logs and the readiness API, and a URL include can carry
   * credentials in its authority, query string or fragment, so they are removed
   * here rather than at each consumer.
   */
  const addUncaptured = (note: string): void => {
    uncaptured.add(redactNoteCredentials(note));
  };

  /** Both Compose interpolation forms, matching isDynamicPath's own definition. */
const INTERPOLATION_PATTERN = /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * The one stack-relative path a dynamic managed input could still resolve to:
 * the literal suffix after its last interpolation, with the substituted value
 * standing in for the directory above it. A capture that cannot read the
 * substitution has to treat that name as an input it does not hold, because
 * Compose may point the input at it later. A source that escapes the stack, or
 * whose suffix does, names nothing a capture could have held. Over-reporting
 * only leaves a file the operator owns in place; it never widens what a
 * generation captures.
 *
 * This is deliberately not used for application data: the substituted value may
 * contain a directory (`sub/data.env`) or be the whole path, so a suffix is not
 * proof of the resolved bind source and a restore must not delete on it.
 */
function literalTailCandidate(sourcePath: string): string | null {
  if (isHostAbsolutePath(sourcePath)) return null;
  if (sourcePath.split('/').some((seg) => seg === '..')) return null;
  let afterInterpolation = -1;
  for (const match of sourcePath.matchAll(INTERPOLATION_PATTERN)) {
    afterInterpolation = match.index + match[0].length;
  }
  if (afterInterpolation === -1) return null;
  // The leading separator is the join with the substituted directory, which may
  // be empty or ".", so it is dropped before the tail is validated.
  const tail = posixRel(sourcePath.slice(afterInterpolation).replace(/^\/+/, ''));
  if (!tail || !isValidRelativeStackPath(tail)) return null;
  return tail;
}

/**
 * What capture can do with one authored candidate.
 * - captured: a regular file, or a link to one inside the stack, whose bytes
 *   the generation holds.
 * - omitted: present and selected by Compose, but left out of the generation.
 *   For a managed input the path joins `uncapturedRelativePaths` so readiness
 *   lists it and a restore never deletes it, and a rollback uses its current
 *   content. `mode` decides how it is reported: 'refuse' records a plain
 *   omission for a Compose layer (a shared main file the stack legitimately
 *   deploys), 'note' also adds an operator note, and 'silent' records neither
 *   the note nor the path, because application data and build inputs are not
 *   managed paths: no restore may ever treat them as files a generation owns
 *   or cleans up, so a data link that appears after capture survives it.
 * - absent: nothing usable there. For 'refuse' that is either no file at all or
 *   a link a capture must stop on, which pushes a coverage note.
 */
type CapturableState = 'captured' | 'omitted' | 'absent';

const capturable = async (
  relativePath: string,
  mode: 'refuse' | 'note' | 'silent',
): Promise<CapturableState> => {
  let state: AuthoredFileState;
  try {
    state = await classifyAuthoredFile(stackRoot, relativePath);
  } catch (e) {
    if (mode !== 'silent') {
      coverageNotes.push(`Could not inspect ${relativePath} for rollback capture: ${(e as Error).message}`);
    }
    return 'absent';
  }
  if (state === 'file') return 'captured';
  if (state === 'absent') return 'absent';
  if (state === 'shared') {
    // Compose reads the link, so the layer stays selected, but the bytes belong
    // to the shared target: the generation cannot hold them and a restore must
    // never write through the link. The omission is what keeps readiness honest.
    if (mode === 'silent') return 'omitted';
    uncapturedPaths.add(relativePath);
    addUncaptured(
      `${relativePath} ${LINK_PROBLEMS.shared} and is not captured; a rollback reads the linked file's current content`,
    );
    return 'omitted';
  }
  const problem = LINK_PROBLEMS[state];
  if (mode === 'refuse') {
    const hint = state === 'outside' ? '. Use include: to share a file between stacks' : '';
    coverageNotes.push(`Compose file ${relativePath} ${problem}${hint}`);
    return 'absent';
  }
  if (mode === 'silent') return 'omitted';
  uncapturedPaths.add(relativePath);
  if (mode === 'note') addUncaptured(`${relativePath} ${problem} and is not captured`);
  return 'omitted';
};

  // Every root Compose could select is recorded, but Compose loads exactly one
  // and adds its implicit override. composePaths holds the whole selected set;
  // selectedLayers holds what a run with no explicit -f would load. A root that
  // links into the shared compose directory is selected and pinned without being
  // captured, so the stack deploys and a rollback reads the link's target.
  const composePaths: string[] = [];
  const selectedLayers: string[] = [];
  for (const name of COMPOSE_ROOT_FILENAMES) {
    const resolved = resolveStackRel(stackRoot, name);
    if (!resolved) continue;
    const state = await capturable(resolved.relativePath, 'refuse');
    if (state === 'absent') continue;
    composePaths.push(resolved.relativePath);
    if (selectedLayers.length === 0) selectedLayers.push(resolved.relativePath);
    if (state === 'captured') {
      upsertEntry(map, foldedOwners, {
        relativePath: resolved.relativePath,
        dependencyKind: 'compose-root',
        provenance: 'authored',
        sensitivity: 'low',
        absolutePath: resolved.absolutePath,
      }, caseCollisions);
    }
  }

  const overrideName = await firstSelectedLayer(stackRoot, COMPOSE_OVERRIDE_FILENAMES);
  if (overrideName) {
    const resolved = resolveStackRel(stackRoot, overrideName);
    if (resolved) {
      const state = await capturable(resolved.relativePath, 'refuse');
      if (state !== 'absent') {
        if (!composePaths.includes(resolved.relativePath)) {
          composePaths.push(resolved.relativePath);
          // Same first-match-wins rule, so a stack holding both compose.yaml and
          // docker-compose.yml pins only the one Compose would have discovered.
          if (selectedLayers.length === 1) selectedLayers.push(resolved.relativePath);
        }
        if (state === 'captured') {
          upsertEntry(map, foldedOwners, {
            relativePath: resolved.relativePath,
            dependencyKind: 'implicit-override',
            provenance: 'authored',
            sensitivity: 'low',
            absolutePath: resolved.absolutePath,
          }, caseCollisions);
        }
      }
    }
  }

  const envCandidates = new Set<string>([DOT_ENV]);
  for (const f of DatabaseService.getInstance().getStackProjectEnvFiles(nodeId, stackName)) {
    envCandidates.add(posixRel(f));
  }
  for (const envFile of envCandidates) {
    const resolved = resolveStackRel(stackRoot, envFile);
    if (!resolved) {
      addUncaptured(`${envFile} is not a path inside the stack directory and is not captured`);
      continue;
    }
    if ((await capturable(resolved.relativePath, 'note')) !== 'captured') continue;
    upsertEntry(map, foldedOwners, {
      relativePath: resolved.relativePath,
      dependencyKind: envFile === DOT_ENV ? 'interpolation-env' : 'project-env',
      provenance: 'authored',
      sensitivity: authoredSensitivity(envFile === DOT_ENV ? 'interpolation-env' : 'project-env'),
      absolutePath: resolved.absolutePath,
    }, caseCollisions);
  }

  const readCallback = (repoPath: string): string | null => {
    const relativePath = posixRel(repoPath);
    if (!relativePath || !isValidRelativeStackPath(relativePath)) return null;
    // Inline barrier at the readFileSync sink.
    const baseResolved = path.resolve(stackRoot);
    const abs = path.resolve(baseResolved, relativePath);
    if (!abs.startsWith(baseResolved + path.sep)) return null;
    try {
      return readComposeTextSync(abs);
    } catch {
      return null;
    }
  };

  if (composePaths.length > 0) {
    const orderedContents: Array<{ path: string; content: string }> = [];
    for (const rel of composePaths) {
      if (!isValidRelativeStackPath(rel)) continue;
      // Inline barrier at the readFile sink (same form as readCallback).
      const baseResolved = path.resolve(stackRoot);
      const abs = path.resolve(baseResolved, rel);
      if (!abs.startsWith(baseResolved + path.sep)) continue;
      try {
        const content = await readComposeText(abs);
        orderedContents.push({ path: rel, content });
      } catch (e) {
        coverageNotes.push(`Could not read compose file ${rel}: ${(e as Error).message}`);
      }
    }

    if (orderedContents.length > 0) {
      const parsed = parseDeclaredInputs(orderedContents, {
        projectRoot: null,
        read: readCallback,
        reportUnenumerable: true,
      });

      if (parsed.parseErrors.length > 0) {
        coverageNotes.push(...parsed.parseErrors);
      }
      for (const dyn of parsed.dynamic) {
        if (UNCAPTURED_SILENT_KINDS.has(dyn.kind)) {
          // Application data Compose resolves at deploy time. The capture cannot
          // read the substitution, and the literal suffix is not the resolved
          // path: the variable may name a directory above the suffix or the
          // whole source. Record the declared source so a restore knows its
          // ownership of every unrecorded live path is unknown, and delete none
          // of them rather than guess.
          dynamicAppDataSources.add(dyn.sourcePath);
          continue;
        }
        const candidate = literalTailCandidate(dyn.sourcePath);
        const refs = dyn.kind === 'include' || dyn.kind === 'extends' ? ' (and the files it references)' : '';
        addUncaptured(
          `${dyn.kind} ${dyn.sourcePath}${refs} is resolved by Compose at deploy time and is not captured`,
        );
        if (dyn.kind === 'include' || dyn.kind === 'extends') {
          // A dynamic composition source can declare any input, and its
          // declarations were not read. Recovery pins the captured layers, but
          // a live restore must not forward other live paths as disposable.
          unparsedComposeSources.add(redactNoteCredentials(dyn.sourcePath));
        }
        // A path that is interpolated end to end (`include: [ $FILE ]`) names
        // no filename a capture could protect by path, and Compose resolves it
        // to whatever the variable holds later. Any conventional compose file
        // could therefore be that dependency, so a restore must stop treating
        // an unrecorded one as disposable. Over-reporting only leaves an
        // operator-owned file in place.
        if (candidate) uncapturedPaths.add(candidate);
      }

      for (const input of parsed.inputs) {
        if (
          input.kind === 'bind-mount'
          && await bindContainsStack(stackRoot, input.sourcePath, input.materializedPath)
        ) {
          // Mounting the stack root or an ancestor mounts every managed path.
          dynamicAppDataSources.add(STACK_CONTAINING_BIND_MARKER);
          continue;
        }
        // A host spelling can still name a file inside this stack: an absolute
        // path under the lexical or physical root of a relocated compose
        // directory, or a `..` path that leaves and re-enters the stack.
        // Resolve it to the same stack-relative path its plain relative
        // spelling would use, so one file has one ownership and capture record.
        // Only silent kinds are rewritten; managed host inputs keep their
        // existing outside-the-stack accounting.
        const absoluteSource = UNCAPTURED_SILENT_KINDS.has(input.kind)
          && input.sourcePath !== null
          && (
            input.baseDir === 'host'
            || input.materializedPath === null
            || isHostAbsolutePath(input.sourcePath)
          )
          ? await resolveStackSource(stackRoot, input.sourcePath)
          : null;

        const hostAbs = absoluteSource === null && (
          (input.sourcePath !== null && isHostAbsolutePath(input.sourcePath))
          || input.baseDir === 'host'
          || input.materializedPath === null
        );

        if (hostAbs) {
          if (input.sourcePath !== null && !UNCAPTURED_SILENT_KINDS.has(input.kind)) {
            const refs = input.kind === 'include' || input.kind === 'extends'
              ? ' (and the files it references)'
              : '';
            addUncaptured(
              `${input.kind} ${input.sourcePath}${refs} is outside the stack directory and is not captured`,
            );
          }
          if (input.kind === 'include' || input.kind === 'extends') {
            // The referenced file was not read, so it can declare a bind or env
            // file the live inventory never saw. Keep every live path out of
            // cleanup until the layer set no longer has an outside source.
            unparsedComposeSources.add(
              redactNoteCredentials(input.sourcePath ?? `${input.kind} without a path`),
            );
          }
          continue;
        }

        const candidate = absoluteSource?.relativePath ?? input.materializedPath ?? input.sourcePath;
        if (!candidate) continue;
        const resolved = absoluteSource ?? resolveStackRel(stackRoot, candidate);
        if (!resolved) continue;
        const kind = input.kind;
        const mode = UNCAPTURED_SILENT_KINDS.has(kind) ? 'silent' : 'note';
        if (mode === 'silent') {
          appDataPaths.add(resolved.relativePath);
          const physical = await physicalStackPath(stackRoot, resolved.absolutePath);
          if (physical) appDataPaths.add(physical);
          // A directory bind mounts everything beneath it. A managed env file
          // that appears under that directory later is data, not a stale file.
          if (kind === 'bind-mount' && await isDirectoryPath(resolved.absolutePath)) {
            appDataPathPrefixes.add(resolved.relativePath);
            if (physical) appDataPathPrefixes.add(physical);
          }
        }
        if ((await capturable(resolved.relativePath, mode)) !== 'captured') continue;

        upsertEntry(map, foldedOwners, {
          relativePath: resolved.relativePath,
          dependencyKind: kind,
          provenance: 'authored',
          sensitivity: authoredSensitivity(kind),
          absolutePath: resolved.absolutePath,
        }, caseCollisions);
      }
    }
  }

  let composeArgsPrefix: string[] = [];
  try {
    composeArgsPrefix = [
      ...authoredComposeFileArgs(stackName, nodeId),
      ...(await authoredComposeEnvFileArgs(stackName, nodeId)),
    ];
  } catch (e) {
    coverageNotes.push(`Could not build compose invocation args: ${(e as Error).message}`);
  }

  const explicitComposeFiles = [...map.values()]
    .filter((e) => COMPOSE_INVOCATION_KINDS.has(e.dependencyKind))
    .map((e) => e.relativePath)
    .sort((a, b) => a.localeCompare(b));

  if (caseCollisions.length > 0) {
    coverageNotes.push(caseCollisions[0]);
  }

  let meshEnabled = false;
  try {
    meshEnabled = DatabaseService.getInstance().isMeshStackEnabled(nodeId, stackName);
  } catch (e) {
    coverageNotes.push(`Could not read Mesh enablement: ${(e as Error).message}`);
  }

  // A `-f` flag replaces Compose's own file discovery, and Compose ignores
  // COMPOSE_FILE entirely once a `-f` list is given, so a run that carries one
  // leaves the layer choice alone. Mesh injects its own `-f` list whenever it is
  // enabled (the base file, the implicit override it would otherwise suppress,
  // and the Mesh layer), so an enabled stack is a run that pins files even
  // though the captured prefix holds none. It does not leave the environment
  // alone: Compose loads COMPOSE_ENV_FILES for interpolation either way, so the
  // files it names are read in both cases.
  const capturedPinsFiles = composeArgsPrefix.some((t) => t === '-f' || t === '--file') || meshEnabled;
  const selection = await composeFileEnvVarSelection(stackName, nodeId);
  // COMPOSE_ENV_FILES names files Compose loads for interpolation that the
  // capture never holds (the inventory captures the project .env and the
  // configured project env files, not this operator-level list). Recording them
  // keeps a generation that pins its layers correctly from claiming exact
  // coverage of the environment those layers are rendered with.
  //
  // A selection this reader cannot decide names its files anyway, and that is
  // the case where the accounting matters most: a path the compose-root
  // containment refuses here is one Compose can still read, so the run renders
  // the captured layers with a file the generation never held. Leaving it out
  // would certify complete coverage of an input the rollback cannot reproduce.
  // Only a selection that names no file at all (env args Sencho could not
  // build) leaves nothing to record. An omission never blocks a capture, so
  // over-reporting is the safe direction, and the Git inventory applies the
  // same rule to its manifest.
  // A selected file that is not a regular file is not an omission: Compose
  // cannot read it, so it would wait on it or fail on it instead of rendering
  // the project. Refuse, whatever pinned the layer set. Either an invalid or an
  // undecidable selection leaves the live project's resolved paths unprovable,
  // so the reason also keeps a restore from deleting live paths it cannot
  // classify.
  if (selection.kind === 'invalid') {
    coverageNotes.push(selection.reason);
  }
  if (selection.kind === 'invalid' || selection.kind === 'unknown') {
    recoveryRefusal = selection.reason;
  }
  const envFilesToAccount = selection.kind === 'unknown'
    ? selection.loadedEnvFiles
    : selection.kind === 'invalid'
      ? []
      : selection.composeEnvFiles;
  // The source is named only where it is known: an undecided selection is a set
  // of paths, not a statement about which variable supplied them.
  const loadedBy = selection.kind === 'unknown' ? ' for interpolation' : ' through COMPOSE_ENV_FILES';
  for (const envPath of envFilesToAccount) {
    const resolved = resolveStackRel(stackRoot, posixRel(path.relative(stackRoot, envPath)));
    if (!resolved) {
      addUncaptured(
        `${path.basename(envPath)} is loaded by Compose${loadedBy} from outside the stack directory and is not captured`,
      );
      continue;
    }
    if (map.has(resolved.relativePath)) continue;
    uncapturedPaths.add(resolved.relativePath);
    addUncaptured(
      `${resolved.relativePath} is loaded by Compose${loadedBy} and is not captured`,
    );
  }
  let composeLayers: string[] = [...selectedLayers];
  // Set when the COMPOSE_FILE translation produced the layer set above, so the
  // project-env accounting below knows a recovery invocation will pin these
  // layers as an explicit -f list and has to reconstruct the interpolation
  // environment that translation would otherwise drop.
  let chainPinned = false;
  let interpolationEnvFiles: string[] | undefined;
  if (!capturedPinsFiles) {
    if (selection.kind === 'absent') {
      // Compose's own discovery decides, and selectedLayers already holds it.
    } else if (selection.kind === 'unknown') {
      // Nothing here can say what the variable holds, and a recovery run always
      // appends a layer of its own, which suppresses the variable along with
      // discovery. Guessing the chain would restore a project the capture never
      // held. The reason names the file, so the operator can fix it.
      coverageNotes.push(
        `Could not read the environment that selects the compose layers through COMPOSE_FILE: ${selection.reason}`,
      );
    } else if (selection.kind === 'value') {
      // COMPOSE_FILE replaces discovery, and `-f a -f b` loads exactly the layers
      // `COMPOSE_FILE=a:b` does, so pinning the chain reproduces the capture-time
      // project and still layers a trailing recovery override on top of it.
      // Inferring a root instead would override the variable and restore a
      // different stack. An entry that does not resolve refuses below, which
      // also covers a value this reader could not reproduce in full.
      const chain = parseComposeFileChain(selection.value, selection.pathSeparator);
      const resolvedChain: string[] = [];
      let unusable: string | null = null;
      for (const entry of chain) {
        const resolved = entry.length === 0 ? null : await resolveStackSource(stackRoot, entry);
        if (!resolved) {
          // A layer that is not a stack-relative path cannot be pinned at all,
          // and Compose rejects a chain that names an empty entry.
          unusable = redactNoteCredentials(describeUnusableLayer(entry));
          break;
        }
        resolvedChain.push(resolved.relativePath);
        if (!composePaths.includes(resolved.relativePath)) {
          unparsedComposeSources.add(resolved.relativePath);
        }
        // The layer is loaded whatever it is, so it is pinned either way. The
        // capture question uses the compose-layer policy, the same one the
        // root and override candidates and the recovery layer validator
        // apply: a target inside the compose root stays a recorded omission
        // the generation cannot hold, while a layer that leaves the compose
        // root, dangles, or is not a file is a refusal, because recovery
        // refuses that same target before Compose runs and an accepted
        // generation must never carry an invocation its own rollback cannot
        // launch.
        await capturable(resolved.relativePath, 'refuse');
        if (map.has(resolved.relativePath)) continue;
        // A regular file that no captured compose file declares: the
        // generation cannot hold it, so a restore must leave whatever is
        // there alone and read its current content.
        uncapturedPaths.add(resolved.relativePath);
        addUncaptured(`compose layer ${resolved.relativePath} is selected by COMPOSE_FILE and is not captured`);
      }
      if (unusable === null) {
        composeLayers = resolvedChain;
        chainPinned = true;
      } else {
        coverageNotes.push(unusable);
      }
    }
  }

  // After the layer set is final: a project directory other than the stack root
  // loads its own `.env`. Hold a regular file inside the stack so a restore
  // puts it back. A link that cannot be held is already an omission. A directory
  // outside the stack is recorded without its path.
  const projectEnv = selectedProjectEnvFile(composeArgsPrefix, composeLayers, stackRoot);
  if (projectEnv?.kind === 'outside') {
    addUncaptured(PROJECT_ENV_OUTSIDE_NOTE);
  } else if (projectEnv?.kind === 'relative') {
    const resolved = resolveStackRel(stackRoot, projectEnv.relativePath);
    if (!resolved) {
      addUncaptured(PROJECT_ENV_OUTSIDE_NOTE);
    } else {
      if ((await capturable(resolved.relativePath, 'note')) === 'captured') {
        upsertEntry(map, foldedOwners, {
          relativePath: resolved.relativePath,
          dependencyKind: 'interpolation-env',
          provenance: 'authored',
          sensitivity: authoredSensitivity('interpolation-env'),
          absolutePath: resolved.absolutePath,
        }, caseCollisions);
      }
      if (chainPinned && !defaultProjectEnvSuppressed(composeArgsPrefix)) {
        try {
          interpolationEnvFiles = await capturedInterpolationEnvFiles(stackRoot, resolved.relativePath);
        } catch (e) {
          // Same rule the capturable pass applies to a file it cannot inspect:
          // refuse rather than reconstruct an invocation around an unreadable
          // env file.
          coverageNotes.push(
            `Could not inspect the interpolation env files for rollback capture: ${(e as Error).message}`,
          );
        }
      }
    }
  }
  // The chain pinned no env files, nothing in the captured flags or the
  // process environment selects any, and none exists for Compose to discover.
  // A recovery that left the choice to discovery would read an `.env` created
  // after capture, which a restore leaves in place whenever it cannot prove the
  // file is disposable, so the absence is part of the invocation.
  if (
    interpolationEnvFiles === undefined
    && projectEnv?.kind !== 'outside'
    && !defaultProjectEnvSuppressed(composeArgsPrefix)
  ) {
    try {
      const projectEnvRel = projectEnv?.kind === 'relative' ? projectEnv.relativePath : null;
      if (await defaultEnvFilesAbsent(stackRoot, projectEnvRel, chainPinned)) interpolationEnvFiles = [];
    } catch (e) {
      coverageNotes.push(
        `Could not inspect the interpolation env files for rollback capture: ${(e as Error).message}`,
      );
    }
  }
  if (caseCollisions.length > 0 && !coverageNotes.includes(caseCollisions[0])) {
    coverageNotes.push(caseCollisions[0]);
  }

  const coverageRefusal = coverageNotes[0]
    ?? (composeLayers.length === 0 ? 'No compose file found in the stack directory' : null);

  return {
    entries: [...map.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    invocation: {
      composeArgsPrefix,
      projectDirectory: null,
      projectName: stackName,
      explicitComposeFiles: explicitComposeFiles.length > 0 ? explicitComposeFiles : composePaths,
      // The layer set Compose actually loaded, so recovery pins exactly that
      // rather than a root chosen from the stack directory alone.
      composeLayers,
      interpolationEnvFiles,
      meshOverrideRelativePath: null,
      meshEnabled,
    },
    git: null,
    appliedDeploySpec: null,
    lastAppliedContentHash: null,
    manifestState: null,
    manifestGeneration: null,
    coverageRefusal,
    recoveryRefusal,
    // A refused capture writes nothing, so it carries no partial-capture lists.
    uncapturedInputs: coverageRefusal === null ? [...uncaptured] : [],
    uncapturedRelativePaths: coverageRefusal === null
      ? [...uncapturedPaths].sort((a, b) => a.localeCompare(b))
      : [],
    ownedUncapturedRelativePaths: coverageRefusal === null
      ? [...uncapturedPaths].sort((a, b) => a.localeCompare(b))
      : [],
    applicationDataPaths: coverageRefusal === null
      ? [...appDataPaths].sort((a, b) => a.localeCompare(b))
      : [],
    applicationDataPathPrefixes: coverageRefusal === null
      ? [...appDataPathPrefixes].sort((a, b) => a.localeCompare(b))
      : [],
    dynamicApplicationDataSources: coverageRefusal === null
      ? [...dynamicAppDataSources].sort((a, b) => a.localeCompare(b))
      : [],
    unparsedComposeSources: coverageRefusal === null
      ? [...unparsedComposeSources].sort((a, b) => a.localeCompare(b))
      : [],
  };
}

/**
 * Prefer a Git-managed inventory that has no coverage refusal. When the
 * manifest is missing on a true first apply (no applied revision yet), merge
 * authored disk discovery with the Git identity fields so capture preserves
 * nullable Git state. Established missing or corrupt manifests fail closed via
 * resolveGitInventory and are not overwritten by the authored inventory, and
 * neither is a first apply whose authored inventory is itself refused. A stack
 * with no Git source gets the authored inventory.
 */
export async function resolveRollbackInventory(
  nodeId: number,
  stackName: string,
): Promise<ResolvedRollbackInventory> {
  const fsSvc = FileSystemService.getInstance(nodeId);
  const stackRoot = resolveStackRoot(fsSvc, stackName);

  try {
    const gitInventory = await resolveGitInventory(nodeId, stackName, stackRoot);
    if (gitInventory && gitInventory.coverageRefusal === null) return gitInventory;

    const authored = await resolveAuthoredInventory(nodeId, stackName, stackRoot);

    if (gitInventory) {
      const established = Boolean(
        gitInventory.appliedDeploySpec
        || gitInventory.lastAppliedContentHash
        || gitInventory.git?.commitSha,
      );
      const firstApplyCorrupt = Boolean(gitInventory.coverageRefusal?.includes('unreadable'));
      // Fail closed when the Git state is established, the manifest is
      // unreadable, or the authored inventory is refused. The live
      // interpolation refusal still travels: a restore reads the live
      // environment before it launches Compose, and the Git manifest says
      // nothing about whether an env file it does not hold is readable now.
      if (established || firstApplyCorrupt || authored.coverageRefusal !== null) {
        return authored.recoveryRefusal === null
          ? gitInventory
          : { ...gitInventory, recoveryRefusal: authored.recoveryRefusal };
      }
      return {
        ...authored,
        git: gitInventory.git,
        appliedDeploySpec: gitInventory.appliedDeploySpec,
        lastAppliedContentHash: gitInventory.lastAppliedContentHash,
        manifestState: gitInventory.manifestState,
        manifestGeneration: gitInventory.manifestGeneration,
      };
    }

    return authored;
  } catch (e) {
    console.error(
      '[rollbackInventory] Failed to resolve inventory:',
      (e as Error).message,
    );
    throw e;
  }
}
