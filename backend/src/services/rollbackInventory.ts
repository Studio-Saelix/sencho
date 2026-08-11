/**
 * Resolve the authored-project file set that an atomic rollback generation
 * must capture. Git-managed stacks consume the managed-project manifest;
 * authored stacks rediscover against the live stack directory.
 */
import { promises as fsPromises, readFileSync } from 'fs';
import path from 'path';
import { DatabaseService } from './DatabaseService';
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

function caseKey(rel: string): string {
  return posixRel(rel).toLowerCase();
}

/**
 * Authored discovery sensitivity. Secrets/configs are high; env-like inputs
 * are medium; compose and everything else are low. Git-managed inventories
 * keep the sensitivity already recorded on the manifest entry.
 */
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

function upsertEntry(map: Map<string, InventoryAccum>, entry: InventoryAccum): void {
  const key = caseKey(entry.relativePath);
  const prev = map.get(key);
  if (!prev) {
    map.set(key, entry);
    return;
  }
  // Prefer an existing absolute path; keep the more specific dependency kind
  // when replacing a generic compose-root with a declared kind.
  if (prev.absolutePath !== null && entry.absolutePath === null) return;
  map.set(key, {
    ...entry,
    absolutePath: entry.absolutePath ?? prev.absolutePath,
    dependencyKind: prev.dependencyKind === 'compose-root' && entry.dependencyKind !== 'compose-root'
      ? entry.dependencyKind
      : entry.dependencyKind,
    sensitivity: higherSensitivity(entry.sensitivity, prev.sensitivity),
  });
}

function appliedDeploySpecString(
  spec: { files: string[]; contextDir: string | null } | null | undefined,
): string | null {
  if (!spec) return null;
  return JSON.stringify(spec);
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
  const key = caseKey(rel);
  const input = manifest.inputs.find(
    (i: ComposeInputEntry) => i.materializedPath !== null && caseKey(i.materializedPath) === key,
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
  };

  const read = await GitProjectManifestService.getInstance().readManifest(
    stackName,
    gitSource.repo_url,
    gitSource.branch,
  );
  if (!isGitManifest(read)) {
    const reason = read && 'corrupt' in read
      ? `Managed-project manifest is unreadable (${read.corrupt}). Fix or re-link the Git source before capturing rollback coverage.`
      : 'Managed-project manifest is missing. Pull or re-link the Git source before capturing rollback coverage.';
    return {
      entries: [],
      invocation: emptyInvocation,
      git: {
        repoUrl: gitSource.repo_url,
        branch: gitSource.branch,
        commitSha: gitSource.last_applied_commit_sha || '',
        manifestVersion: null,
      },
      appliedDeploySpec: appliedDeploySpecString(gitSource.applied_deploy_spec),
      lastAppliedContentHash: gitSource.last_applied_content_hash,
      manifestState: gitSource.manifest_state,
      manifestGeneration: gitSource.manifest_generation,
      exactCoverage: false,
      coverageRefusal: reason,
    };
  }

  const map = new Map<string, InventoryAccum>();
  for (const rel of collectManifestFilePaths(read)) {
    const resolved = resolveStackRel(stackRoot, rel);
    if (!resolved) continue;
    const meta = sensitivityForManifestPath(read, resolved.relativePath);
    const exists = await pathExistsAsFile(stackRoot, resolved.relativePath);
    upsertEntry(map, {
      relativePath: resolved.relativePath,
      dependencyKind: meta.kind,
      provenance: meta.provenance,
      sensitivity: meta.sensitivity,
      absolutePath: exists ? resolved.absolutePath : null,
    });
  }

  const refused = read.refusals.length > 0
    || read.counts.refused > 0
    || read.state === 'unsupported'
    || read.state === 'partial';
  const coverageRefusal = refused
    ? (read.refusals[0]?.reason
      ?? `Managed-project manifest state "${read.state}" does not claim exact coverage`)
    : null;

  const invocation: RollbackInvocationRecord = {
    composeArgsPrefix: [...read.project.invocation],
    projectDirectory: read.project.effectiveProjectDir,
    projectName: read.project.projectName || stackName,
    explicitComposeFiles: [...read.project.composeFiles],
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
    exactCoverage: !refused,
    coverageRefusal,
  };
}

async function resolveAuthoredInventory(
  nodeId: number,
  stackName: string,
  stackRoot: string,
  fsSvc: FileSystemService,
): Promise<ResolvedRollbackInventory> {
  const map = new Map<string, InventoryAccum>();
  const coverageNotes: string[] = [];

  const composePaths: string[] = [];
  for (const name of ROOT_COMPOSE_FILENAMES) {
    const resolved = resolveStackRel(stackRoot, name);
    if (!resolved) continue;
    if (!(await pathExistsAsFile(stackRoot, resolved.relativePath))) continue;
    composePaths.push(resolved.relativePath);
    upsertEntry(map, {
      relativePath: resolved.relativePath,
      dependencyKind: 'compose-root',
      provenance: 'authored',
      sensitivity: 'low',
      absolutePath: resolved.absolutePath,
    });
  }

  const overrideName = await fsSvc.getOverrideFilename(stackName);
  if (overrideName) {
    const resolved = resolveStackRel(stackRoot, overrideName);
    if (resolved && await pathExistsAsFile(stackRoot, resolved.relativePath)) {
      if (!composePaths.includes(resolved.relativePath)) {
        composePaths.push(resolved.relativePath);
      }
      upsertEntry(map, {
        relativePath: resolved.relativePath,
        dependencyKind: 'implicit-override',
        provenance: 'authored',
        sensitivity: 'low',
        absolutePath: resolved.absolutePath,
      });
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
    upsertEntry(map, {
      relativePath: resolved.relativePath,
      dependencyKind: envFile === DOT_ENV ? 'interpolation-env' : 'project-env',
      provenance: 'authored',
      sensitivity: authoredSensitivity(envFile === DOT_ENV ? 'interpolation-env' : 'project-env'),
      absolutePath: resolved.absolutePath,
    });
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
        upsertEntry(map, {
          relativePath: resolved.relativePath,
          dependencyKind: kind,
          provenance: 'authored',
          sensitivity: authoredSensitivity(kind),
          absolutePath: resolved.absolutePath,
        });
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
 * Build the rollback capture inventory for one stack on one node.
 * Prefers a valid Git managed-project manifest when the stack is Git-backed;
 * otherwise rediscovers against the live authored stack directory.
 * When a Git source exists, never falls back to authored rediscovery.
 */
export async function resolveRollbackInventory(
  nodeId: number,
  stackName: string,
): Promise<ResolvedRollbackInventory> {
  const fsSvc = FileSystemService.getInstance(nodeId);
  const stackRoot = resolveStackRoot(fsSvc, stackName);

  try {
    const gitInventory = await resolveGitInventory(stackName, stackRoot);
    if (gitInventory) return gitInventory;
    return await resolveAuthoredInventory(nodeId, stackName, stackRoot, fsSvc);
  } catch (e) {
    console.error(
      '[rollbackInventory] Failed to resolve inventory:',
      (e as Error).message,
    );
    throw e;
  }
}
