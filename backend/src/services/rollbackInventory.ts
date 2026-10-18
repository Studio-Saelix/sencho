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
import { authoredComposeEnvFileArgs, authoredComposeFileArgs } from '../utils/authoredComposeArgs';
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

const ROOT_COMPOSE_FILENAMES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
] as const;

const DOT_ENV = '.' + 'env';

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
 * - outside: resolves outside the stack directory (a link on the path itself
 *   or on any parent directory).
 * - dangling / loop: a link that reaches nothing, or never ends.
 * - not-a-file: a link whose target is a directory or special file.
 */
type AuthoredFileState = 'file' | 'absent' | 'outside' | 'dangling' | 'loop' | 'not-a-file';

const LINK_PROBLEMS: Record<Exclude<AuthoredFileState, 'file' | 'absent'>, string> = {
  outside: 'links outside the stack directory',
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
  const realRoot = path.join(await fsPromises.realpath(path.dirname(baseResolved)), path.basename(baseResolved));
  if (!real.startsWith(realRoot + path.sep)) return 'outside';
  return (await fsPromises.stat(real)).isFile() ? 'file' : 'not-a-file';
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
    coverageRefusal: coverageRefusal ?? meshReadFailed,
    uncapturedInputs: [],
    uncapturedRelativePaths: [],
  };
}

async function resolveAuthoredInventory(
  nodeId: number,
  stackName: string,
  stackRoot: string,
  fsSvc: FileSystemService,
): Promise<ResolvedRollbackInventory> {
  const map = new Map<string, InventoryAccum>();
  const foldedOwners = new Map<string, string>();
  const coverageNotes: string[] = [];
  const caseCollisions: string[] = [];
  const uncaptured = new Set<string>();
  const uncapturedPaths = new Set<string>();

  /**
   * Notes reach logs and the readiness API, and a URL include can carry
   * credentials in its user info (`https://token@host`) or its query string.
   */
  const addUncaptured = (note: string): void => {
    uncaptured.add(
      note
        .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1[redacted]@')
        .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/gi, '$1?[redacted]'),
    );
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
 * True only for a regular file, or a link to one that stays inside the stack.
   * Anything else returns false. A link capture cannot hold is recorded by
   * `mode`: 'refuse' stops the capture (compose files), 'note' lists it as not
   * captured, 'silent' skips the note for application data. In the last two its
   * path joins `uncapturedRelativePaths`, so a restore never deletes it.
   */
  const capturable = async (
    relativePath: string,
    mode: 'refuse' | 'note' | 'silent',
  ): Promise<boolean> => {
    let state: AuthoredFileState;
    try {
      state = await classifyAuthoredFile(stackRoot, relativePath);
    } catch (e) {
      if (mode === 'silent') {
        uncapturedPaths.add(relativePath);
      } else {
        coverageNotes.push(`Could not inspect ${relativePath} for rollback capture: ${(e as Error).message}`);
      }
      return false;
    }
    if (state === 'file') return true;
    if (state === 'absent') return false;
    const problem = LINK_PROBLEMS[state];
    if (mode === 'refuse') {
      const hint = state === 'outside' ? '. Use include: to share a file between stacks' : '';
      coverageNotes.push(`Compose file ${relativePath} ${problem}${hint}`);
      return false;
    }
    uncapturedPaths.add(relativePath);
    if (mode === 'note') addUncaptured(`${relativePath} ${problem} and is not captured`);
    return false;
  };

  // Every capturable root is captured, but Compose selects exactly one and adds
// its implicit override. composePaths holds the whole captured set;
// selectedLayers holds what a compose run with no explicit -f would load.
const composePaths: string[] = [];
  const selectedLayers: string[] = [];
  for (const name of ROOT_COMPOSE_FILENAMES) {
    const resolved = resolveStackRel(stackRoot, name);
    if (!resolved) continue;
    if (!(await capturable(resolved.relativePath, 'refuse'))) continue;
    composePaths.push(resolved.relativePath);
    if (selectedLayers.length === 0) selectedLayers.push(resolved.relativePath);
    upsertEntry(map, foldedOwners, {
      relativePath: resolved.relativePath,
      dependencyKind: 'compose-root',
      provenance: 'authored',
      sensitivity: 'low',
      absolutePath: resolved.absolutePath,
    }, caseCollisions);
  }

  const overrideName = await fsSvc.getOverrideFilename(stackName);
  if (overrideName) {
    const resolved = resolveStackRel(stackRoot, overrideName);
    if (resolved && await capturable(resolved.relativePath, 'refuse')) {
      if (!composePaths.includes(resolved.relativePath)) {
        composePaths.push(resolved.relativePath);
        // Same first-match-wins rule getOverrideFilename already resolved, so a
        // stack holding both compose.yaml and docker-compose.yml pins only the
        // one Compose would have discovered.
        if (selectedLayers.length === 1) selectedLayers.push(resolved.relativePath);
      }
      upsertEntry(map, foldedOwners, {
        relativePath: resolved.relativePath,
        dependencyKind: 'implicit-override',
        provenance: 'authored',
        sensitivity: 'low',
        absolutePath: resolved.absolutePath,
      }, caseCollisions);
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
    if (!(await capturable(resolved.relativePath, 'note'))) continue;
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
        if (!(await capturable(resolved.relativePath, mode))) continue;

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

  const coverageRefusal = coverageNotes[0]
    ?? (composePaths.length === 0 ? 'No compose file found in the stack directory' : null);

  return {
    entries: [...map.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    invocation: {
      composeArgsPrefix,
      projectDirectory: null,
      projectName: stackName,
      explicitComposeFiles: explicitComposeFiles.length > 0 ? explicitComposeFiles : composePaths,
      // The layer set Compose would auto-select, so recovery pins exactly what
      // the capture-time run loaded rather than merging every root that exists.
      composeLayers: [...selectedLayers],
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

    const authored = await resolveAuthoredInventory(nodeId, stackName, stackRoot, fsSvc);

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
