/**
 * Resolve the authored-project file set that an atomic rollback generation
 * must capture. Git-managed stacks consume the managed-project manifest;
 * authored stacks rediscover against the live stack directory.
 */
import { promises as fsPromises, readFileSync } from 'fs';
import path from 'path';
import { DatabaseService, type StackGitSource } from './DatabaseService';
import { FileSystemService } from './FileSystemService';
import { GitProjectManifestService } from './GitProjectManifestService';
import { collectManifestFilePaths } from '../helpers/manifestFilePaths';
import { isHostAbsolutePath, parseDeclaredInputs } from '../helpers/composeInputParse';
import { isValidRelativeStackPath, isValidStackName } from '../utils/validation';
import { COMPOSE_OVERRIDE_FILENAMES, COMPOSE_ROOT_FILENAMES } from '../utils/composeFilenames';
import {
  authoredComposeEnvFileArgs,
  authoredComposeFileArgs,
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
  return real.startsWith(realBase + path.sep) ? 'shared' : 'outside';
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
 * A COMPOSE_FILE chain entry resolved the way the live run loads it. Compose
 * takes an absolute entry as written and resolves a relative one against its
 * working directory, which is the stack directory for every Sencho spawn, so an
 * absolute path that names a file inside the authorized stack is the same layer
 * as its relative spelling and is normalized to it: a recovery run pins layers
 * by their stack-relative name so an overlay can rebuild them. The real root is
 * matched as well, so a relocated (linked) compose directory resolves, the same
 * way every other containment check in the capture treats it. Only a path
 * proven inside the stack is normalized; anything else stays unpinnable and is
 * reported by the caller.
 */
async function resolveChainLayer(
  stackRoot: string,
  entry: string,
): Promise<{ relativePath: string; absolutePath: string } | null> {
  const direct = resolveStackRel(stackRoot, entry);
  if (direct) return direct;
  if (!isHostAbsolutePath(entry)) return null;
  const absolute = path.resolve(entry);
  const baseResolved = path.resolve(stackRoot);
  let realRoot: string;
  try {
    realRoot = await realStackRoot(baseResolved);
  } catch {
    // The compose root cannot be resolved, so nothing can be shown to live
    // inside it and the lexical comparison stands as the only one.
    realRoot = baseResolved;
  }
  for (const root of [baseResolved, realRoot]) {
    if (!absolute.startsWith(root + path.sep)) continue;
    const relative = posixRel(path.relative(root, absolute));
    const resolved = relative ? resolveStackRel(stackRoot, relative) : null;
    if (resolved) return resolved;
  }
  return null;
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
    uncapturedInputs: [],
    uncapturedRelativePaths: [],
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
    // The manifest's compose files are the deploy's own -f list, so they are
    // also its complete set of project-root layers.
    composeLayers: [...gitSourceLocalComposeFiles(read.project.composeFiles)],
    meshOverrideRelativePath: null,
    meshEnabled,
  };

  const refusal = coverageRefusal ?? meshReadFailed;
  const uncaptured = new Set<string>();
  const uncapturedPaths = new Set<string>();
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
    const selection = await composeFileEnvVarSelection(stackName, nodeId);
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
  }

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
    coverageRefusal: refusal,
    uncapturedInputs: refusal === null ? [...uncaptured] : [],
    uncapturedRelativePaths: refusal === null
      ? [...uncapturedPaths].sort((a, b) => a.localeCompare(b))
      : [],
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
 * The one stack-relative path a dynamic source path could still resolve to: the
 * literal suffix after its last interpolation, with the substituted value
 * standing in for the directory above it. A capture that cannot read the
 * substitution has to treat that name as an input it does not hold, because
 * Compose may point the input at it later. A source that escapes the stack, or
 * whose suffix does, names nothing a capture could have held. Over-reporting
 * only leaves a file the operator owns in place; it never widens what a
 * generation captures.
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
 *   The path joins `uncapturedRelativePaths` so a restore never deletes it, and
 *   a rollback uses its current content. `mode` decides how it is reported:
 *   'refuse' records a plain omission for a Compose layer (a shared main file
 *   the stack legitimately deploys), 'note' also adds an operator note, and
 *   'silent' skips the note for application data.
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
    if (mode === 'silent') {
      uncapturedPaths.add(relativePath);
    } else {
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
    uncapturedPaths.add(relativePath);
    if (mode !== 'silent') {
      addUncaptured(
        `${relativePath} ${LINK_PROBLEMS.shared} and is not captured; a rollback reads the linked file's current content`,
      );
    }
    return 'omitted';
  }
  const problem = LINK_PROBLEMS[state];
  if (mode === 'refuse') {
    const hint = state === 'outside' ? '. Use include: to share a file between stacks' : '';
    coverageNotes.push(`Compose file ${relativePath} ${problem}${hint}`);
    return 'absent';
  }
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
      return readFileSync(abs, 'utf8');
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
        const content = await fsPromises.readFile(abs, 'utf8');
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
        if (UNCAPTURED_SILENT_KINDS.has(dyn.kind)) continue;
        const refs = dyn.kind === 'include' || dyn.kind === 'extends' ? ' (and the files it references)' : '';
        addUncaptured(
          `${dyn.kind} ${dyn.sourcePath}${refs} is resolved by Compose at deploy time and is not captured`,
        );
        const candidate = literalTailCandidate(dyn.sourcePath);
        // A path that is interpolated end to end (`include: [ $FILE ]`) names
        // no filename a capture could protect by path, and Compose resolves it
        // to whatever the variable holds later. Any conventional compose file
        // could therefore be that dependency, so a restore must stop treating
        // an unrecorded one as disposable. Over-reporting only leaves an
        // operator-owned file in place.
        if (candidate) uncapturedPaths.add(candidate);
      }

      for (const input of parsed.inputs) {
        const hostAbs = (input.sourcePath !== null && isHostAbsolutePath(input.sourcePath))
          || input.baseDir === 'host'
          || input.materializedPath === null;

        if (hostAbs) {
          if (input.sourcePath !== null && !UNCAPTURED_SILENT_KINDS.has(input.kind)) {
            const refs = input.kind === 'include' || input.kind === 'extends'
              ? ' (and the files it references)'
              : '';
            addUncaptured(
              `${input.kind} ${input.sourcePath}${refs} is outside the stack directory and is not captured`,
            );
          }
          continue;
        }

        const candidate = input.materializedPath ?? input.sourcePath;
        if (!candidate) continue;
        const resolved = resolveStackRel(stackRoot, candidate);
        if (!resolved) continue;
        const kind = input.kind;
        const mode = UNCAPTURED_SILENT_KINDS.has(kind) ? 'silent' : 'note';
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
  const envFilesToAccount = selection.kind === 'unknown' ? selection.loadedEnvFiles : selection.composeEnvFiles;
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
    } else {
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
        const resolved = entry.length === 0 ? null : await resolveChainLayer(stackRoot, entry);
        if (!resolved) {
          // A layer that is not a stack-relative path cannot be pinned at all,
          // and Compose rejects a chain that names an empty entry.
          unusable = redactNoteCredentials(describeUnusableLayer(entry));
          break;
        }
        resolvedChain.push(resolved.relativePath);
        // The layer is loaded whatever it is, so it is pinned either way. What
        // the capture can hold is a separate question, asked the same way it
        // is for every other declared input: a link that leaves the stack, a
        // link to nothing, or a path no captured compose file declares is
        // recorded as not captured and never deleted by a restore.
        await capturable(resolved.relativePath, 'note');
        if (map.has(resolved.relativePath)) continue;
        // A regular file that no captured compose file declares: the
        // generation cannot hold it, so a restore must leave whatever is
        // there alone and read its current content.
        uncapturedPaths.add(resolved.relativePath);
        addUncaptured(`compose layer ${resolved.relativePath} is selected by COMPOSE_FILE and is not captured`);
      }
      if (unusable === null) composeLayers = resolvedChain;
      else coverageNotes.push(unusable);
    }
  }

  const coverageRefusal = coverageNotes[0]
    ?? (composePaths.length === 0 ? 'No compose file found in the stack directory' : null);

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
      meshOverrideRelativePath: null,
      meshEnabled,
    },
    git: null,
    appliedDeploySpec: null,
    lastAppliedContentHash: null,
    manifestState: null,
    manifestGeneration: null,
    coverageRefusal,
    // A refused capture writes nothing, so it carries no partial-capture lists.
    uncapturedInputs: coverageRefusal === null ? [...uncaptured] : [],
    uncapturedRelativePaths: coverageRefusal === null
      ? [...uncapturedPaths].sort((a, b) => a.localeCompare(b))
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
      // unreadable, or the authored inventory is refused. Otherwise merge the
      // Git identity onto the authored inventory for a true first apply.
      if (established || firstApplyCorrupt || authored.coverageRefusal !== null) {
        return gitInventory;
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
