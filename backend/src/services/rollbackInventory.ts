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
    exactCoverage: false,
    coverageRefusal,
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
    explicitComposeFiles: [...read.project.composeFiles],
    meshOverrideRelativePath: null,
    meshEnabled,
  };

  const meshRefused = meshReadFailed !== null;
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
    exactCoverage: !refused && !meshRefused,
    coverageRefusal: coverageRefusal ?? meshReadFailed,
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

  const composePaths: string[] = [];
  for (const name of ROOT_COMPOSE_FILENAMES) {
    const resolved = resolveStackRel(stackRoot, name);
    if (!resolved) continue;
    if (!(await pathExistsAsFile(stackRoot, resolved.relativePath))) continue;
    composePaths.push(resolved.relativePath);
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
    if (resolved && await pathExistsAsFile(stackRoot, resolved.relativePath)) {
      if (!composePaths.includes(resolved.relativePath)) {
        composePaths.push(resolved.relativePath);
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
    if (!resolved) continue;
    if (!(await pathExistsAsFile(stackRoot, resolved.relativePath))) continue;
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
      });

      if (parsed.parseErrors.length > 0) {
        coverageNotes.push(...parsed.parseErrors);
      }
      if (parsed.dynamic.length > 0) {
        coverageNotes.push(
          `${parsed.dynamic.length} dynamic path declaration(s) cannot be captured exactly`,
        );
      }

      for (const input of parsed.inputs) {
        const hostAbs = (input.sourcePath !== null && isHostAbsolutePath(input.sourcePath))
          || input.baseDir === 'host'
          || input.materializedPath === null;

        if (hostAbs) {
          if (input.kind === 'include' || input.kind === 'extends') {
            coverageNotes.push(
              `Host-absolute ${input.kind} path cannot be captured for exact rollback`,
            );
          }
          continue;
        }

        const candidate = input.materializedPath ?? input.sourcePath;
        if (!candidate) continue;
        const resolved = resolveStackRel(stackRoot, candidate);
        if (!resolved) continue;
        if (!(await pathExistsAsFile(stackRoot, resolved.relativePath))) continue;

        const kind = input.kind;
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

  const exactCoverage = coverageNotes.length === 0 && composePaths.length > 0;
  const coverageRefusal = exactCoverage
    ? null
    : (coverageNotes[0]
      ?? (composePaths.length === 0
        ? 'No compose file found in the stack directory'
        : 'Exact coverage unavailable'));

  return {
    entries: [...map.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    invocation: {
      composeArgsPrefix,
      projectDirectory: null,
      projectName: stackName,
      explicitComposeFiles: explicitComposeFiles.length > 0 ? explicitComposeFiles : composePaths,
      meshOverrideRelativePath: null,
      meshEnabled,
    },
    git: null,
    appliedDeploySpec: null,
    lastAppliedContentHash: null,
    manifestState: null,
    manifestGeneration: null,
    exactCoverage,
    coverageRefusal,
  };
}

/**
 * Prefer an exact Git-managed inventory when available. When the manifesto is
 * missing on a true first apply (no applied revision yet), merge authored disk
 * discovery with the Git identity fields so capture preserves nullable Git
 * state. Established missing/corrupt manifesto cases fail closed via
 * resolveGitInventory and are not overwritten by authored exactCoverage.
 */
export async function resolveRollbackInventory(
  nodeId: number,
  stackName: string,
): Promise<ResolvedRollbackInventory> {
  const fsSvc = FileSystemService.getInstance(nodeId);
  const stackRoot = resolveStackRoot(fsSvc, stackName);

  try {
    const gitInventory = await resolveGitInventory(nodeId, stackName, stackRoot);
    if (gitInventory?.exactCoverage) return gitInventory;

    const authored = await resolveAuthoredInventory(nodeId, stackName, stackRoot, fsSvc);

    if (gitInventory && !gitInventory.exactCoverage) {
      const established = Boolean(
        gitInventory.appliedDeploySpec
        || gitInventory.lastAppliedContentHash
        || gitInventory.git?.commitSha,
      );
      const firstApplyCorrupt = Boolean(gitInventory.coverageRefusal?.includes('unreadable'));
      // Established or corrupt first-apply: fail closed. Otherwise merge Git
      // identity onto authored exact coverage for a true first apply.
      if (established || firstApplyCorrupt || !authored.exactCoverage) {
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

    if (authored.exactCoverage) return authored;
    return gitInventory ?? authored;
  } catch (e) {
    console.error(
      '[rollbackInventory] Failed to resolve inventory:',
      (e as Error).message,
    );
    throw e;
  }
}
