/**
 * Git manifesto inventory: first-apply merge vs established fail-closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import os from 'os';
import net from 'net';
import { execFileSync } from 'child_process';
import { promises as fsPromises } from 'fs';

const mockGetGitSource = vi.fn();
const mockReadManifest = vi.fn();
const mockGetStackProjectEnvFiles = vi.fn().mockReturnValue([]);
const mockBuildAuthoredComposeArgs = vi.fn().mockResolvedValue(['compose', '-f', 'compose.yaml', 'config', '--quiet']);
const mockAuthoredComposeFileArgs = vi.fn().mockReturnValue(['-f', 'compose.yaml']);
const mockAuthoredComposeEnvFileArgs = vi.fn().mockResolvedValue([]);
const mockComposeFileEnvVarSelection = vi.fn().mockResolvedValue({ kind: 'absent', composeEnvFiles: [], loadedEnvFiles: [] });

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getGitSource: mockGetGitSource,
      getStackProjectEnvFiles: mockGetStackProjectEnvFiles,
      isMeshStackEnabled: () => false,
    }),
  },
}));

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getDefaultNodeId: () => 1,
    }),
  },
}));

vi.mock('../services/GitProjectManifestService', () => ({
  GitProjectManifestService: {
    getInstance: () => ({
      readManifest: mockReadManifest,
    }),
  },
}));

const mockState = { composeDir: '' };

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: () => ({
      getBaseDir: () => mockState.composeDir,
    }),
  },
}));

vi.mock('../services/ComposeService', () => ({
  ComposeService: {
    getInstance: () => ({
      buildAuthoredComposeArgs: mockBuildAuthoredComposeArgs,
    }),
  },
}));

vi.mock('../utils/authoredComposeArgs', () => ({
  authoredComposeFileArgs: (...args: unknown[]) => mockAuthoredComposeFileArgs(...args),
  authoredComposeEnvFileArgs: (...args: unknown[]) => mockAuthoredComposeEnvFileArgs(...args),
  DEFAULT_PATH_SEPARATOR: ':',
  composeFileEnvVarSelection: (...args: unknown[]) => mockComposeFileEnvVarSelection(...(args as [])),
}));

import { resolveRollbackInventory, selectedProjectEnvFile } from '../services/rollbackInventory';
import { storedRestoreCoverage } from '../services/updateGuard/readiness';

describe('resolveRollbackInventory', () => {
  let composeDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    composeDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-inv-'));
    mockState.composeDir = composeDir;
    mockGetStackProjectEnvFiles.mockReturnValue([]);
    mockBuildAuthoredComposeArgs.mockResolvedValue(['compose', '-f', 'compose.yaml', 'config', '--quiet']);
    mockAuthoredComposeFileArgs.mockReturnValue(['-f', 'compose.yaml']);
    mockAuthoredComposeEnvFileArgs.mockResolvedValue([]);
    mockComposeFileEnvVarSelection.mockResolvedValue({ kind: 'absent', composeEnvFiles: [], loadedEnvFiles: [] });
  });

  it('merges authored files with Git identity on first apply when manifesto is missing', async () => {
    const stackName = 'gitapp';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(stackDir, 'compose.yaml'),
      'services:\n  web:\n    image: nginx\n',
      'utf8',
    );

    mockGetGitSource.mockReturnValue({
      stack_name: stackName,
      repo_url: 'https://example.com/repo.git',
      branch: 'main',
      last_applied_commit_sha: null,
      last_applied_content_hash: null,
      applied_deploy_spec: null,
      sync_env: false,
      manifest_version: null,
      manifest_state: null,
      manifest_generation: null,
    });
    mockReadManifest.mockResolvedValue(null);

    const inventory = await resolveRollbackInventory(1, stackName);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.uncapturedInputs).toEqual([]);
    expect(inventory.entries.map((e) => e.relativePath)).toContain('compose.yaml');
    expect(inventory.git).toEqual({
      repoUrl: 'https://example.com/repo.git',
      branch: 'main',
      commitSha: '',
      manifestVersion: null,
    });
  });

  it('fails closed when an established Git stack is missing its manifesto and cannot rebuild from applied spec', async () => {
    const stackName = 'established';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');

    mockGetGitSource.mockReturnValue({
      stack_name: stackName,
      repo_url: 'https://example.com/repo.git',
      branch: 'main',
      last_applied_commit_sha: 'abc1234',
      last_applied_content_hash: 'hash',
      applied_deploy_spec: null,
      sync_env: false,
      manifest_version: 3,
      manifest_state: 'active',
      manifest_generation: 'generations/prior',
    });
    mockReadManifest.mockResolvedValue(null);

    const inventory = await resolveRollbackInventory(1, stackName);

    expect(inventory.coverageRefusal).toMatch(/missing/i);
    expect(inventory.git?.commitSha).toBe('abc1234');
  });

  it('fails closed for established missing manifesto instead of applied_deploy_spec exact coverage', async () => {
    const stackName = 'rebuild';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  a: {}\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'compose.prod.yaml'), 'services:\n  b: {}\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'app.env'), 'FOO=1\n', 'utf8');

    mockGetGitSource.mockReturnValue({
      stack_name: stackName,
      repo_url: 'https://example.com/repo.git',
      branch: 'main',
      last_applied_commit_sha: 'deadbeef',
      last_applied_content_hash: 'h1',
      applied_deploy_spec: { files: ['compose.yaml', 'compose.prod.yaml'], contextDir: null },
      sync_env: false,
      manifest_version: 3,
      manifest_state: 'active',
      manifest_generation: 'generations/x',
    });
    mockReadManifest.mockResolvedValue(null);

    const inventory = await resolveRollbackInventory(1, stackName);

    expect(inventory.coverageRefusal).toMatch(/missing/i);
    expect(inventory.git?.commitSha).toBe('deadbeef');
  });

  it('fails closed when the manifesto is corrupt even if applied_deploy_spec files exist', async () => {
    const stackName = 'corruptgit';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'app.env'), 'PASS=x\n', 'utf8');

    mockGetGitSource.mockReturnValue({
      stack_name: stackName,
      repo_url: 'https://example.com/repo.git',
      branch: 'main',
      last_applied_commit_sha: 'abc',
      last_applied_content_hash: 'h',
      applied_deploy_spec: { files: ['compose.yaml'], contextDir: null },
      sync_env: false,
      manifest_version: 3,
      manifest_state: 'active',
      manifest_generation: 'generations/x',
    });
    mockReadManifest.mockResolvedValue({ corrupt: 'identity mismatch' });

    const inventory = await resolveRollbackInventory(1, stackName);

    expect(inventory.coverageRefusal).toMatch(/unreadable/i);
    expect(inventory.git?.commitSha).toBe('abc');
  });

  it('fails closed when the manifesto is corrupt and applied_deploy_spec cannot be rebuilt', async () => {
    const stackName = 'corrupt-norebuild';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');

    mockGetGitSource.mockReturnValue({
      stack_name: stackName,
      repo_url: 'https://example.com/repo.git',
      branch: 'main',
      last_applied_commit_sha: 'abc',
      last_applied_content_hash: 'h',
      applied_deploy_spec: { files: ['compose.yaml', 'missing.override.yaml'], contextDir: null },
      sync_env: false,
      manifest_version: 3,
      manifest_state: 'active',
      manifest_generation: 'generations/x',
    });
    mockReadManifest.mockResolvedValue({ corrupt: 'identity mismatch' });

    const inventory = await resolveRollbackInventory(1, stackName);

    expect(inventory.coverageRefusal).toMatch(/unreadable/i);
  });

  it('fails closed for missing manifesto with include/env/config dependency files on disk', async () => {
    const stackName = 'deps-matrix';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(path.join(stackDir, 'configs'), { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  a:\n    env_file: [app.env]\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'compose.prod.yaml'), 'include:\n  - path: compose.yaml\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'app.env'), 'A=1\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'configs/app.conf'), 'x=1\n', 'utf8');

    mockGetGitSource.mockReturnValue({
      stack_name: stackName,
      repo_url: 'https://example.com/repo.git',
      branch: 'main',
      last_applied_commit_sha: 'cafebabe',
      last_applied_content_hash: 'h2',
      applied_deploy_spec: { files: ['compose.yaml', 'compose.prod.yaml'], contextDir: null },
      sync_env: false,
      manifest_version: 3,
      manifest_state: 'active',
      manifest_generation: 'generations/y',
    });
    mockReadManifest.mockResolvedValue(null);

    const inventory = await resolveRollbackInventory(1, stackName);

    expect(inventory.coverageRefusal).toMatch(/missing/i);
  });

  it('fails closed when the Git manifesto is corrupt even before first apply', async () => {
    const stackName = 'corrupt-first';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');

    mockGetGitSource.mockReturnValue({
      stack_name: stackName,
      repo_url: 'https://example.com/repo.git',
      branch: 'main',
      last_applied_commit_sha: null,
      last_applied_content_hash: null,
      applied_deploy_spec: null,
      sync_env: false,
      manifest_version: null,
      manifest_state: null,
      manifest_generation: null,
    });
    mockReadManifest.mockResolvedValue({ corrupt: 'identity mismatch' });

    const inventory = await resolveRollbackInventory(1, stackName);

    expect(inventory.coverageRefusal).toMatch(/unreadable/i);
  });

  it('refuses exact coverage when case-colliding managed paths exist', async () => {
    const stackName = 'casefold';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'App.conf'), 'A\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'app.conf'), 'B\n', 'utf8');

    mockGetGitSource.mockReturnValue(undefined);

    // Two configured project env files whose names collide only under
    // case-folding. Both exist on a case-sensitive filesystem, so both enter the
    // map and the collision has to be reported rather than silently merged.
    mockGetStackProjectEnvFiles.mockReturnValue(['App.conf', 'app.conf']);

    const inventory = await resolveRollbackInventory(1, stackName);
    // On case-sensitive FS both files exist; inventory should refuse collision.
    // On Windows case-folding FS the second write may overwrite the first.
    if (process.platform === 'win32') {
      expect(inventory).toBeTruthy();
      return;
    }
    expect(inventory.coverageRefusal).toMatch(/Case-colliding/i);
  });
});

/**
 * A Git generation's file inventory is the managed-project manifesto, and a
 * manifest does not hold the operator-level env files a run loads for
 * interpolation. Compose reads those on top of the -f list the manifest pins, so
 * coverage that claims completeness while they stay live is a false promise.
 */
describe('resolveRollbackInventory: the env files a Git run loads', () => {
  let composeDir: string;
  const STACK = 'gitapp';
  const REPO = 'https://example.com/repo.git';

  function manifest(extraInputs: unknown[] = []): unknown {
    return {
      schemaVersion: 1,
      manifestVersion: 4,
      state: 'active',
      repo: { url: REPO, branch: 'main' },
      resolvedRevision: { commitSha: 'abc1234', fetchedAt: 1 },
      project: {
        root: null,
        composeFiles: ['compose.yaml'],
        effectiveProjectDir: null,
        projectName: STACK,
        invocation: ['-f', 'compose.yaml', '-p', STACK],
      },
      inputs: [{
        sourcePath: 'compose.yaml',
        materializedPath: 'compose.yaml',
        role: 'compose-primary',
        dependencyKind: 'explicit',
        ownership: 'managed',
        provenance: 'fetch',
        sensitivity: 'low',
        contentSha256: null,
        sizeBytes: null,
        state: 'present',
        deletionAuthority: 'sencho',
        note: null,
      }, ...extraInputs],
      refusals: [],
      buildContexts: [],
      counts: { managed: 1 + extraInputs.length, unmanaged: 0, refused: 0 },
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    composeDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-inv-gitenv-'));
    mockState.composeDir = composeDir;
    const stackDir = path.join(composeDir, STACK);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'operator.env'), 'GREETING=old\n', 'utf8');
    mockGetGitSource.mockReturnValue({
      stack_name: STACK,
      repo_url: REPO,
      branch: 'main',
      last_applied_commit_sha: 'abc1234',
      last_applied_content_hash: 'hash',
      applied_deploy_spec: { files: ['compose.yaml'], contextDir: null },
      sync_env: false,
      manifest_version: 4,
      manifest_state: 'active',
      manifest_generation: null,
    });
    mockReadManifest.mockResolvedValue(manifest());
    mockGetStackProjectEnvFiles.mockReturnValue([]);
    mockAuthoredComposeFileArgs.mockReturnValue(['-f', 'compose.yaml', '-p', STACK]);
    mockAuthoredComposeEnvFileArgs.mockResolvedValue([]);
    mockComposeFileEnvVarSelection.mockResolvedValue({ kind: 'absent', composeEnvFiles: [], loadedEnvFiles: [] });
  });

  it('records an operator env file the manifest does not hold as not captured', async () => {
    const operatorEnv = path.join(composeDir, STACK, 'operator.env');
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'value',
      value: 'compose.yaml',
      pathSeparator: ':',
      composeEnvFiles: [operatorEnv],
      loadedEnvFiles: [operatorEnv],
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    // The manifest still decides the layers and the file set, and the operator
    // env file it cannot hold is recorded instead of being certified complete.
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.composeLayers).toEqual(['compose.yaml']);
    expect(inventory.entries.map((e) => e.relativePath)).toEqual(['compose.yaml']);
    expect(inventory.uncapturedRelativePaths).toContain('operator.env');
    expect(inventory.uncapturedInputs).toEqual([
      expect.stringContaining('operator.env'),
    ]);
  });

  it('records a live project .env the manifest does not hold as not captured', async () => {
    const projectEnv = path.join(composeDir, STACK, '.env');
    await fsPromises.writeFile(projectEnv, 'GREETING=old\n', 'utf8');
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'absent',
      composeEnvFiles: [],
      loadedEnvFiles: [projectEnv],
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.uncapturedRelativePaths).toContain('.env');
    expect(inventory.uncapturedInputs.join(' ')).toContain('.env');
  });

  it('leaves an env file the manifest holds out of the omissions', async () => {
    const projectEnv = path.join(composeDir, STACK, '.env');
    await fsPromises.writeFile(projectEnv, 'GREETING=old\n', 'utf8');
    mockReadManifest.mockResolvedValue(manifest([{
      sourcePath: '.env',
      materializedPath: '.env',
      role: 'env',
      dependencyKind: 'sync-env',
      ownership: 'managed',
      provenance: 'migration',
      sensitivity: 'high',
      contentSha256: null,
      sizeBytes: null,
      state: 'present',
      deletionAuthority: 'sencho',
      note: null,
    }]));
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'absent',
      composeEnvFiles: [],
      loadedEnvFiles: [projectEnv],
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    // The generation captures that file, so naming it as an input it does not
    // hold would be wrong.
    expect(inventory.uncapturedInputs).toEqual([]);
    expect(inventory.uncapturedRelativePaths).toEqual([]);
  });

  it('collects unmanaged static and dynamic bind paths from the manifest', async () => {
    mockReadManifest.mockResolvedValue(manifest([
      {
        sourcePath: 'data.env',
        materializedPath: 'data.env',
        role: 'bind-mount',
        dependencyKind: 'bind-mount',
        ownership: 'unmanaged',
        provenance: 'fetch',
        sensitivity: 'medium',
        contentSha256: null,
        sizeBytes: null,
        state: 'present',
        deletionAuthority: 'none',
        note: null,
      },
      {
        sourcePath: './${DATA_DIR}/private.env',
        materializedPath: null,
        role: 'bind-mount',
        dependencyKind: 'bind-mount',
        ownership: 'unmanaged',
        provenance: 'fetch',
        sensitivity: 'medium',
        contentSha256: null,
        sizeBytes: null,
        state: 'present',
        deletionAuthority: 'none',
        note: null,
      },
    ]));

    const inventory = await resolveRollbackInventory(1, STACK);

    // The managed file map excludes unmanaged inputs, but their application
    // data role still has to reach restore. A dynamic source activates the
    // global deletion safeguard; a static path is protected by name.
    expect(inventory.applicationDataPaths).toEqual(['data.env']);
    expect(inventory.dynamicApplicationDataSources).toEqual(['./${DATA_DIR}/private.env']);
  });

  it('resolves a host-form bind spelling that names a stack path', async () => {
    const inStack = path.join(composeDir, STACK, 'sub', 'data.env');
    const outside = path.join(composeDir, '..', 'data.env');
    const hostBind = (hostSourcePath: string): unknown => ({
      sourcePath: null,
      hostSourcePath,
      materializedPath: null,
      role: 'bind-mount',
      dependencyKind: 'bind-mount',
      ownership: 'unmanaged',
      provenance: 'fetch',
      sensitivity: 'medium',
      contentSha256: null,
      sizeBytes: null,
      state: 'present',
      deletionAuthority: 'none',
      note: 'Host path; provided by the node, not materialized from the repository',
    });
    mockReadManifest.mockResolvedValue(manifest([hostBind(inStack), hostBind(outside)]));

    const inventory = await resolveRollbackInventory(1, STACK);

    // Host manifests blank `sourcePath`, so the raw spelling is the only way
    // to see that the in-stack bind owns the same path as a managed env file.
    // A host path outside the stack must not be adopted.
    expect(inventory.applicationDataPaths).toEqual(['sub/data.env']);
  });

  it('records a bind-mounted directory as a prefix but not a build context', async () => {
    await fsPromises.mkdir(path.join(composeDir, STACK, 'data'), { recursive: true });
    await fsPromises.mkdir(path.join(composeDir, STACK, 'web'), { recursive: true });
    const silent = (sourcePath: string, dependencyKind: string): unknown => ({
      sourcePath,
      materializedPath: sourcePath,
      role: dependencyKind,
      dependencyKind,
      ownership: 'unmanaged',
      provenance: 'fetch',
      sensitivity: 'medium',
      contentSha256: null,
      sizeBytes: null,
      state: 'present',
      deletionAuthority: 'none',
      note: null,
    });
    mockReadManifest.mockResolvedValue(manifest([
      silent('data', 'bind-mount'),
      silent('web', 'build-context'),
    ]));

    const inventory = await resolveRollbackInventory(1, STACK);

    // A directory bind mounts everything beneath it. A build context is also a
    // directory, but its files are managed build inputs, not mounted data, so
    // it must not become a protected prefix.
    expect(inventory.applicationDataPaths).toEqual(['data', 'web']);
    expect(inventory.applicationDataPathPrefixes).toEqual(['data']);
  });

  it('treats a bind of the stack root as unresolved', async () => {
    const rootBind = (sourcePath: string | null, materializedPath: string | null, hostSourcePath?: string): unknown => ({
      sourcePath,
      ...(hostSourcePath ? { hostSourcePath } : {}),
      materializedPath,
      role: 'bind-mount',
      dependencyKind: 'bind-mount',
      ownership: 'unmanaged',
      provenance: 'fetch',
      sensitivity: 'medium',
      contentSha256: null,
      sizeBytes: null,
      state: 'present',
      deletionAuthority: 'none',
      note: null,
    });
    mockReadManifest.mockResolvedValue(manifest([
      rootBind('.', '.'),
      rootBind(null, null, path.join(composeDir, STACK)),
    ]));

    const inventory = await resolveRollbackInventory(1, STACK);

    // Mounting the root covers every managed path, so no live path is safe to
    // delete. Both the relative and absolute spellings must set the signal.
    expect(inventory.dynamicApplicationDataSources).toEqual(['<bind source contains the stack>']);
    expect(inventory.applicationDataPaths).toEqual([]);
  });

  it('treats a drive-relative bind source as unresolved', async () => {
    mockReadManifest.mockResolvedValue(manifest([{
      sourcePath: 'C:..',
      materializedPath: null,
      role: 'bind-mount',
      dependencyKind: 'bind-mount',
      ownership: 'unmanaged',
      provenance: 'fetch',
      sensitivity: 'medium',
      contentSha256: null,
      sizeBytes: null,
      state: 'present',
      deletionAuthority: 'none',
      note: null,
    }]));

    const inventory = await resolveRollbackInventory(1, STACK);

    // The host resolves a drive-relative spelling against the current
    // directory on that drive; it may name the stack or an ancestor.
    expect(inventory.dynamicApplicationDataSources).toEqual(['<bind source contains the stack>']);
  });

  it('resolves an outside alias whose target is a stack file', async () => {
    const target = path.join(composeDir, STACK, 'sub', 'data.env');
    await fsPromises.mkdir(path.dirname(target), { recursive: true });
    await fsPromises.writeFile(target, 'TOKEN=application-data\n', 'utf8');
    const alias = path.join(composeDir, 'data-alias.env');
    await fsPromises.symlink(target, alias);

    mockReadManifest.mockResolvedValue(manifest([{
      sourcePath: null,
      hostSourcePath: alias,
      materializedPath: null,
      role: 'bind-mount',
      dependencyKind: 'bind-mount',
      ownership: 'unmanaged',
      provenance: 'fetch',
      sensitivity: 'medium',
      contentSha256: null,
      sizeBytes: null,
      state: 'present',
      deletionAuthority: 'none',
      note: 'Host path; provided by the node, not materialized from the repository',
    }]));

    const inventory = await resolveRollbackInventory(1, STACK);

    // The bind names an alias outside the stack, but mounting it reads the
    // stack file. Deleting that managed path would delete the mounted data, so
    // the physical target supplies the ownership record.
    expect(inventory.applicationDataPaths).toEqual(['sub/data.env']);
  });

  it('treats a legacy host bind without a recorded path as unresolved', async () => {
    // Manifests written before host-source recording kept no spelling for a
    // host bind. It may name any stack path, so the capture must keep the
    // delete-none signal rather than assume the path is outside the stack.
    mockReadManifest.mockResolvedValue(manifest([{
      sourcePath: null,
      materializedPath: null,
      role: 'bind-mount',
      dependencyKind: 'bind-mount',
      ownership: 'unmanaged',
      provenance: 'fetch',
      sensitivity: 'medium',
      contentSha256: null,
      sizeBytes: null,
      state: 'present',
      deletionAuthority: 'none',
      note: 'Host path; provided by the node, not materialized from the repository',
    }]));

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.applicationDataPaths).toEqual([]);
    expect(inventory.dynamicApplicationDataSources).toEqual([
      '<legacy host declaration: path not recorded>',
    ]);
  });

  it('names an env file outside the stack without claiming it is protected', async () => {
    const outside = path.join(composeDir, '..', 'operator.env');
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'value',
      value: 'compose.yaml',
      pathSeparator: ':',
      composeEnvFiles: [outside],
      loadedEnvFiles: [outside],
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.uncapturedRelativePaths).toEqual([]);
    expect(inventory.uncapturedInputs.join(' ')).toContain('operator.env');
  });

  it('records nothing when the run\'s env files could not be read at all', async () => {
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'unknown',
      reason: 'the env file operator.env could not be read',
      loadedEnvFiles: [],
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    // Compose refuses to run with a file it cannot read, so there is no live
    // project whose coverage could be overstated.
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.uncapturedInputs).toEqual([]);
  });

  it('records every named env file when the reader could not decide', async () => {
    const operatorEnv = path.join(composeDir, STACK, 'operator.env');
    const outside = path.join(composeDir, '..', 'operator-outside.env');
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'unknown',
      reason: 'the env file operator-outside.env could not be read',
      loadedEnvFiles: [outside, operatorEnv],
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    // The reader could not decide, but Compose reads what it was given, so both
    // names are recorded and an omission never blocks the capture.
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.uncapturedRelativePaths).toContain('operator.env');
    expect(inventory.uncapturedInputs.join(' ')).toContain('operator-outside.env');
    expect(inventory.uncapturedInputs.join(' ')).toContain('operator.env');
  });

  it('blocks the capture instead of recording an established pinned stack\'s env list', async () => {
    const stackName = 'pinnedenv';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'operator.env'), 'GREETING=old\n', 'utf8');

    // An applied deploy spec is what pins files with -f, and it is also what
    // makes the Git inventory established. A missing manifesto therefore fails
    // closed here, so no capture can reach the authored inventory and claim
    // coverage of an operator env file it never recorded.
    mockGetGitSource.mockReturnValue({
      stack_name: stackName,
      repo_url: REPO,
      branch: 'main',
      last_applied_commit_sha: null,
      last_applied_content_hash: null,
      applied_deploy_spec: { files: ['compose.yaml'], contextDir: null },
      sync_env: false,
      manifest_version: null,
      manifest_state: null,
      manifest_generation: null,
    });
    mockReadManifest.mockResolvedValue(null);
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'unknown',
      reason: 'the env file operator.env could not be read',
      loadedEnvFiles: [path.join(stackDir, 'operator.env')],
    });

    const inventory = await resolveRollbackInventory(1, stackName);

    expect(inventory.coverageRefusal).toMatch(/missing/i);
    expect(inventory.uncapturedInputs).toEqual([]);
    expect(inventory.uncapturedRelativePaths).toEqual([]);
  });

  it('records a project-directory env file the manifest does not hold', async () => {
    const stackDir = path.join(composeDir, STACK);
    await fsPromises.mkdir(path.join(stackDir, 'sub'), { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'sub', 'compose.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'sub', '.env'), 'SUBVAR=from-sub\n', 'utf8');
    const body = manifest();
    const project = (body as { project: { composeFiles: string[]; invocation: string[] } }).project;
    project.composeFiles = ['sub/compose.yaml'];
    project.invocation = ['-f', 'sub/compose.yaml', '-p', STACK];
    mockReadManifest.mockResolvedValue(body);

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.entries.map((entry) => entry.relativePath)).not.toContain('sub/.env');
    expect(inventory.uncapturedRelativePaths).toContain('sub/.env');
    expect(inventory.uncapturedInputs.join(' ')).toContain('sub/.env');
    expect(storedRestoreCoverage({ uncapturedInputs: inventory.uncapturedInputs })).toBe('omits_inputs');
  });

  it('does not omit a project-directory env file the manifest already holds', async () => {
    const stackDir = path.join(composeDir, STACK);
    await fsPromises.mkdir(path.join(stackDir, 'sub'), { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'sub', '.env'), 'SUBVAR=from-sub\n', 'utf8');
    const body = manifest([{
      sourcePath: 'sub/.env',
      materializedPath: 'sub/.env',
      role: 'env',
      dependencyKind: 'interpolation-env',
      ownership: 'managed',
      provenance: 'fetch',
      sensitivity: 'medium',
      contentSha256: null,
      sizeBytes: null,
      state: 'present',
      deletionAuthority: 'sencho',
      note: null,
    }]);
    const project = (body as { project: { invocation: string[] } }).project;
    project.invocation = ['-f', 'sub/compose.yaml', '-p', STACK];
    mockReadManifest.mockResolvedValue(body);

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.uncapturedInputs.join(' ')).not.toContain('sub/.env');
    expect(inventory.entries.map((entry) => entry.relativePath)).toContain('sub/.env');
  });

  it('does not omit a project-directory env file under an absolute project directory', async () => {
    // A deploy spec with a context directory names it by absolute path, and
    // that path is inside the stack, so the file it loads is a stack file the
    // manifest can hold.
    const stackDir = path.join(composeDir, STACK);
    await fsPromises.mkdir(path.join(stackDir, 'sub'), { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'sub', '.env'), 'SUBVAR=from-sub\n', 'utf8');
    const body = manifest([{
      sourcePath: 'sub/.env',
      materializedPath: 'sub/.env',
      role: 'env',
      dependencyKind: 'interpolation-env',
      ownership: 'managed',
      provenance: 'fetch',
      sensitivity: 'medium',
      contentSha256: null,
      sizeBytes: null,
      state: 'present',
      deletionAuthority: 'sencho',
      note: null,
    }]);
    const project = (body as { project: { invocation: string[] } }).project;
    project.invocation = [
      '--project-directory', path.join(stackDir, 'sub'),
      '-f', 'sub/compose.yaml',
      '-p', STACK,
    ];
    mockReadManifest.mockResolvedValue(body);

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.uncapturedInputs).toEqual([]);
    expect(inventory.uncapturedRelativePaths).not.toContain('sub/.env');
    expect(inventory.entries.map((entry) => entry.relativePath)).toContain('sub/.env');
  });

  it('records an unheld project-directory env file under an absolute project directory', async () => {
    const stackDir = path.join(composeDir, STACK);
    await fsPromises.mkdir(path.join(stackDir, 'sub'), { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'sub', '.env'), 'SUBVAR=from-sub\n', 'utf8');
    const body = manifest();
    const project = (body as { project: { composeFiles: string[]; invocation: string[] } }).project;
    project.composeFiles = ['sub/compose.yaml'];
    project.invocation = [
      '--project-directory', path.join(stackDir, 'sub'),
      '-f', 'sub/compose.yaml',
      '-p', STACK,
    ];
    mockReadManifest.mockResolvedValue(body);

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.uncapturedRelativePaths).toContain('sub/.env');
    expect(inventory.uncapturedInputs.join(' ')).toContain('sub/.env');
    expect(storedRestoreCoverage({ uncapturedInputs: inventory.uncapturedInputs })).toBe('omits_inputs');
  });

  it('does not invent an omission when the project directory has no env file', async () => {
    const body = manifest();
    const project = (body as { project: { invocation: string[] } }).project;
    project.invocation = ['-f', 'sub/compose.yaml', '-p', STACK];
    mockReadManifest.mockResolvedValue(body);

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.uncapturedInputs.join(' ')).not.toContain('sub/.env');
    expect(inventory.uncapturedRelativePaths).not.toContain('sub/.env');
    expect(storedRestoreCoverage({ uncapturedInputs: inventory.uncapturedInputs })).toBe('complete');
  });

  describe('files the manifest does not own', () => {
    const implicitOverride = (name: string, over: Record<string, unknown> = {}) => ({
      sourcePath: name,
      materializedPath: name,
      role: 'compose-override',
      dependencyKind: 'implicit-override',
      ownership: 'managed',
      provenance: 'fetch',
      sensitivity: 'medium',
      contentSha256: null,
      sizeBytes: null,
      state: 'present',
      deletionAuthority: 'sencho',
      note: null,
      ...over,
    });

    function singleFile(extraInputs: unknown[] = []): unknown {
      const body = manifest(extraInputs);
      (body as { project: { invocation: string[] } }).project.invocation = [];
      return body;
    }

    it('offers none of its omitted env files as a cleanup candidate', async () => {
      const operatorEnv = path.join(composeDir, STACK, 'operator.env');
      const projectEnv = path.join(composeDir, STACK, '.env');
      await fsPromises.writeFile(projectEnv, 'GREETING=old\n', 'utf8');
      mockComposeFileEnvVarSelection.mockResolvedValue({
        kind: 'absent',
        composeEnvFiles: [operatorEnv],
        loadedEnvFiles: [operatorEnv, projectEnv],
      });

      const inventory = await resolveRollbackInventory(1, STACK);

      // Both are recorded as omissions, but neither is the inventory's to remove.
      expect(inventory.uncapturedRelativePaths).toEqual(['.env', 'operator.env']);
      expect(inventory.ownedUncapturedRelativePaths).toEqual([]);
    });

    it('pins the absence of a default env file the manifest does not hold', async () => {
      mockReadManifest.mockResolvedValue(singleFile());

      const inventory = await resolveRollbackInventory(1, STACK);

      expect(inventory.coverageRefusal).toBeNull();
      expect(inventory.invocation.interpolationEnvFiles).toEqual([]);
      expect(inventory.uncapturedInputs).toEqual([]);
    });

    it('leaves the env choice to Compose when a default env file exists', async () => {
      const projectEnv = path.join(composeDir, STACK, '.env');
      await fsPromises.writeFile(projectEnv, 'GREETING=old\n', 'utf8');
      mockReadManifest.mockResolvedValue(singleFile());
      mockComposeFileEnvVarSelection.mockResolvedValue({
        kind: 'absent',
        composeEnvFiles: [],
        loadedEnvFiles: [projectEnv],
      });

      const inventory = await resolveRollbackInventory(1, STACK);

      expect(inventory.invocation.interpolationEnvFiles).toBeUndefined();
      expect(inventory.uncapturedRelativePaths).toEqual(['.env']);
    });

    it('leaves the env choice to Compose when the manifest holds the env file', async () => {
      mockReadManifest.mockResolvedValue(singleFile([{
        sourcePath: '.env',
        materializedPath: '.env',
        role: 'env',
        dependencyKind: 'sync-env',
        ownership: 'managed',
        provenance: 'migration',
        sensitivity: 'high',
        contentSha256: null,
        sizeBytes: null,
        state: 'present',
        deletionAuthority: 'sencho',
        note: null,
      }]));
      await fsPromises.writeFile(path.join(composeDir, STACK, '.env'), 'GREETING=held\n', 'utf8');

      const inventory = await resolveRollbackInventory(1, STACK);

      expect(inventory.entries.map((e) => e.relativePath)).toContain('.env');
      expect(inventory.invocation.interpolationEnvFiles).toBeUndefined();
    });

    it('pins the absence of the project directory env file, not the stack root one', async () => {
      const stackDir = path.join(composeDir, STACK);
      await fsPromises.mkdir(path.join(stackDir, 'sub'), { recursive: true });
      await fsPromises.writeFile(path.join(stackDir, 'sub', 'compose.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf8');
      await fsPromises.writeFile(path.join(stackDir, '.env'), 'ROOT=1\n', 'utf8');
      const body = manifest();
      const project = (body as { project: { composeFiles: string[]; invocation: string[] } }).project;
      project.composeFiles = ['sub/compose.yaml'];
      project.invocation = ['-f', 'sub/compose.yaml', '-p', STACK];
      mockReadManifest.mockResolvedValue(body);

      const inventory = await resolveRollbackInventory(1, STACK);

      // Compose reads only the project directory's file here, and it is absent.
      expect(inventory.invocation.interpolationEnvFiles).toEqual([]);
      expect(inventory.uncapturedRelativePaths).toEqual([]);
    });

    it('leaves the env choice to Compose when the project directory env file exists', async () => {
      const stackDir = path.join(composeDir, STACK);
      await fsPromises.mkdir(path.join(stackDir, 'sub'), { recursive: true });
      await fsPromises.writeFile(path.join(stackDir, 'sub', 'compose.yaml'), 'services:\n  web:\n    image: nginx\n', 'utf8');
      await fsPromises.writeFile(path.join(stackDir, 'sub', '.env'), 'SUBVAR=1\n', 'utf8');
      const body = manifest();
      const project = (body as { project: { composeFiles: string[]; invocation: string[] } }).project;
      project.composeFiles = ['sub/compose.yaml'];
      project.invocation = ['-f', 'sub/compose.yaml', '-p', STACK];
      mockReadManifest.mockResolvedValue(body);

      const inventory = await resolveRollbackInventory(1, STACK);

      expect(inventory.invocation.interpolationEnvFiles).toBeUndefined();
      expect(inventory.uncapturedRelativePaths).toEqual(['sub/.env']);
    });

    it('refuses the capture when a default env path cannot be inspected', async () => {
      mockReadManifest.mockResolvedValue(singleFile());
      const realLstat = fsPromises.lstat.bind(fsPromises);
      const lstat = vi.spyOn(fsPromises, 'lstat').mockImplementation(async (target, ...rest) => {
        if (String(target).endsWith(`${path.sep}${STACK}${path.sep}.env`)) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        return realLstat(target, ...(rest as []));
      });
      try {
        const inventory = await resolveRollbackInventory(1, STACK);

        expect(inventory.coverageRefusal).toMatch(/Could not inspect the interpolation env files.*permission denied/);
        expect(inventory.uncapturedRelativePaths).toEqual([]);
        expect(inventory.ownedUncapturedRelativePaths).toEqual([]);
      } finally {
        lstat.mockRestore();
      }
    });

    it('does not pin an absence when the invocation already selects its env files', async () => {
      const body = singleFile();
      (body as { project: { invocation: string[] } }).project.invocation = ['--env-file', 'operator.env'];
      mockReadManifest.mockResolvedValue(body);

      const inventory = await resolveRollbackInventory(1, STACK);

      expect(inventory.invocation.interpolationEnvFiles).toBeUndefined();
    });

    it('pins the implicit override the manifest holds after the configured file', async () => {
      await fsPromises.writeFile(path.join(composeDir, STACK, 'compose.override.yml'), 'services: {}\n', 'utf8');
      mockReadManifest.mockResolvedValue(singleFile([implicitOverride('compose.override.yml')]));

      const inventory = await resolveRollbackInventory(1, STACK);

      expect(inventory.invocation.composeLayers).toEqual(['compose.yaml', 'compose.override.yml']);
      expect(inventory.invocation.explicitComposeFiles).toEqual(['compose.yaml']);
    });

    it.each([
      'compose.override.yaml',
      'docker-compose.override.yml',
      'docker-compose.override.yaml',
    ])('pins the override the manifest selected when it is %s', async (name) => {
      await fsPromises.writeFile(path.join(composeDir, STACK, name), 'services: {}\n', 'utf8');
      mockReadManifest.mockResolvedValue(singleFile([implicitOverride(name)]));

      const inventory = await resolveRollbackInventory(1, STACK);

      expect(inventory.invocation.composeLayers).toEqual(['compose.yaml', name]);
    });

    it('does not pin an override that is missing from disk', async () => {
      mockReadManifest.mockResolvedValue(singleFile([implicitOverride('compose.override.yml')]));

      const inventory = await resolveRollbackInventory(1, STACK);

      expect(inventory.invocation.composeLayers).toEqual(['compose.yaml']);
    });

    it('does not pin an override the manifest does not own or no longer holds', async () => {
      mockReadManifest.mockResolvedValue(singleFile([
        implicitOverride('compose.override.yml', { ownership: 'unmanaged', deletionAuthority: 'none' }),
        implicitOverride('compose.override.yaml', { state: 'absent' }),
      ]));

      const inventory = await resolveRollbackInventory(1, STACK);

      expect(inventory.invocation.composeLayers).toEqual(['compose.yaml']);
    });

    it('keeps an explicit multi-file selection in its configured order', async () => {
      const body = manifest([{
        ...implicitOverride('extra.yaml', { dependencyKind: 'explicit', role: 'compose-additional' }),
      }]);
      const project = (body as { project: { composeFiles: string[]; invocation: string[] } }).project;
      project.composeFiles = ['compose.yaml', 'extra.yaml'];
      project.invocation = ['-f', 'compose.yaml', '-f', 'extra.yaml', '-p', STACK];
      mockReadManifest.mockResolvedValue(body);

      const inventory = await resolveRollbackInventory(1, STACK);

      expect(inventory.invocation.composeLayers).toEqual(['compose.yaml', 'extra.yaml']);
    });
  });
});

describe('selectedProjectEnvFile', () => {
  const saved: Record<string, string | undefined> = {};
  const STACK_ROOT = path.join(os.tmpdir(), 'sencho-project-env');

  beforeEach(() => {
    for (const key of ['COMPOSE_ENV_FILES', 'COMPOSE_DISABLE_ENV_FILE']) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('names the env file of the first compose file directory', () => {
    expect(selectedProjectEnvFile(['-f', 'sub/compose.yaml', '-p', 'app'], ['compose.yaml'], STACK_ROOT))
      .toEqual({ kind: 'relative', relativePath: 'sub/.env' });
  });

  it('prefers an explicit project directory over the compose file directory', () => {
    expect(selectedProjectEnvFile(
      ['--project-directory', 'sub', '-f', 'compose.yaml'],
      ['compose.yaml'],
      STACK_ROOT,
    )).toEqual({ kind: 'relative', relativePath: 'sub/.env' });
  });

  it('names the env file of an absolute project directory inside the stack', () => {
    // A deploy spec with a context directory names it by absolute path.
    expect(selectedProjectEnvFile(
      ['--project-directory', path.join(STACK_ROOT, 'sub'), '-f', 'compose.yaml'],
      ['compose.yaml'],
      STACK_ROOT,
    )).toEqual({ kind: 'relative', relativePath: 'sub/.env' });
  });

  it('reports a project directory outside the stack', () => {
    expect(selectedProjectEnvFile(
      ['--project-directory', path.join(STACK_ROOT, '..', 'other'), '-f', 'compose.yaml'],
      ['compose.yaml'],
      STACK_ROOT,
    )).toEqual({ kind: 'outside' });
    expect(selectedProjectEnvFile(
      ['--project-directory', '/elsewhere/project', '-f', 'compose.yaml'],
      ['compose.yaml'],
      STACK_ROOT,
    )).toEqual({ kind: 'outside' });
  });

  it('returns null for the stack root and for a replaced default env file', () => {
    expect(selectedProjectEnvFile(['-f', 'compose.yaml'], [], STACK_ROOT)).toBeNull();
    expect(selectedProjectEnvFile([], ['compose.yaml'], STACK_ROOT)).toBeNull();
    expect(selectedProjectEnvFile(['--env-file', 'custom.env', '-f', 'sub/compose.yaml'], [], STACK_ROOT)).toBeNull();
    process.env.COMPOSE_ENV_FILES = 'custom.env';
    expect(selectedProjectEnvFile(['-f', 'sub/compose.yaml'], [], STACK_ROOT)).toBeNull();
    delete process.env.COMPOSE_ENV_FILES;
    process.env.COMPOSE_DISABLE_ENV_FILE = 'true';
    expect(selectedProjectEnvFile(['-f', 'sub/compose.yaml'], [], STACK_ROOT)).toBeNull();
  });

  it('uses the captured layer directory when the invocation pins no file', () => {
    expect(selectedProjectEnvFile([], ['sub/compose.yaml'], STACK_ROOT))
      .toEqual({ kind: 'relative', relativePath: 'sub/.env' });
  });
});

describe('resolveRollbackInventory: the layer set recovery pins', () => {
  let composeDir: string;
  const STACK = 'layers';

  beforeEach(async () => {
    vi.clearAllMocks();
    composeDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-inv-layers-'));
    mockState.composeDir = composeDir;
    await fsPromises.mkdir(path.join(composeDir, STACK), { recursive: true });
    mockGetGitSource.mockReturnValue(undefined);
    mockGetStackProjectEnvFiles.mockReturnValue([]);
    mockAuthoredComposeFileArgs.mockReturnValue([]);
    mockAuthoredComposeEnvFileArgs.mockResolvedValue([]);
    mockComposeFileEnvVarSelection.mockResolvedValue({ kind: 'absent', composeEnvFiles: [], loadedEnvFiles: [] });
  });

  async function write(name: string, body: string): Promise<void> {
    await fsPromises.writeFile(path.join(composeDir, STACK, name), body, 'utf8');
  }

  // docker compose does not resolve these families alphabetically or uniformly,
  // and pinning a layer a run never loaded restores a different project.
  it.each([
    ['compose.yaml over compose.yml', ['compose.yaml', 'compose.yml'], ['compose.yaml']],
    ['compose.yml over the legacy family', ['compose.yml', 'docker-compose.yml'], ['compose.yml']],
    ['docker-compose.yml over docker-compose.yaml', ['docker-compose.yml', 'docker-compose.yaml'], ['docker-compose.yml']],
  ])('selects %s', async (_label, present, expected) => {
    for (const name of present) await write(name, 'services:\n  web:\n    image: nginx\n');

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.composeLayers).toEqual(expected);
  });

  it.each([
    ['compose.override.yml over compose.override.yaml', ['compose.override.yml', 'compose.override.yaml'], 'compose.override.yml'],
    ['docker-compose.override.yml over docker-compose.override.yaml', ['docker-compose.override.yml', 'docker-compose.override.yaml'], 'docker-compose.override.yml'],
    ['compose.override.yml over the legacy override family', ['compose.override.yml', 'docker-compose.override.yml'], 'compose.override.yml'],
  ])('selects %s', async (_label, present, expected) => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    for (const name of present) await write(name, 'services:\n  web:\n    command: ["false"]\n');

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    // The selected override has to be the captured one, or recovery would pin a
    // layer the generation never held.
    expect(inventory.invocation.composeLayers).toEqual(['compose.yaml', expected]);
    expect(inventory.entries.map((e) => e.relativePath)).toContain(expected);
  });

  it('holds the env file of a project directory COMPOSE_FILE selects', async () => {
    await fsPromises.mkdir(path.join(composeDir, STACK, 'sub'), { recursive: true });
    await write('compose.yaml', [
      'services:',
      '  web:',
      '    extends:',
      '      file: sub/compose.yaml',
      '      service: web',
      '',
    ].join('\n'));
    await write('sub/compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('.env', 'COMPOSE_FILE=sub/compose.yaml\n');
    await write('sub/.env', 'SUBVAR=captured\n');
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'value',
      value: 'sub/compose.yaml',
      pathSeparator: ':',
      composeEnvFiles: [],
      loadedEnvFiles: [],
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.composeLayers).toEqual(['sub/compose.yaml']);
    expect(inventory.entries.map((entry) => entry.relativePath)).toEqual(
      expect.arrayContaining(['.env', 'compose.yaml', 'sub/compose.yaml', 'sub/.env']),
    );
    expect(inventory.uncapturedInputs).toEqual([]);
    expect(inventory.uncapturedRelativePaths).not.toContain('sub/.env');
    expect(storedRestoreCoverage({ uncapturedInputs: inventory.uncapturedInputs })).toBe('complete');
  });

  it('does not treat a missing project-directory env file as partial coverage', async () => {
    await fsPromises.mkdir(path.join(composeDir, STACK, 'sub'), { recursive: true });
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('sub/compose.yaml', 'services:\n  web:\n    image: nginx\n');
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'value',
      value: 'sub/compose.yaml',
      pathSeparator: ':',
      composeEnvFiles: [],
      loadedEnvFiles: [],
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.uncapturedInputs.join(' ')).not.toContain('sub/.env');
    expect(inventory.entries.map((entry) => entry.relativePath)).not.toContain('sub/.env');
  });

  it('holds the env file of an absolute project directory inside the stack', async () => {
    // A deploy spec with a context directory names it by absolute path, and
    // that path is inside the stack, so the env file it loads is a stack file.
    await fsPromises.mkdir(path.join(composeDir, STACK, 'sub'), { recursive: true });
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('sub/compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('sub/.env', 'SUBVAR=captured\n');
    mockAuthoredComposeFileArgs.mockReturnValue([
      '--project-directory', path.join(composeDir, STACK, 'sub'),
      '-f', 'sub/compose.yaml',
      '-p', STACK,
    ]);

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.entries.map((entry) => entry.relativePath)).toContain('sub/.env');
    expect(inventory.uncapturedInputs).toEqual([]);
    expect(inventory.uncapturedRelativePaths).not.toContain('sub/.env');
    expect(storedRestoreCoverage({ uncapturedInputs: inventory.uncapturedInputs })).toBe('complete');
  });

  it('records a project env file that links into the shared compose directory', async () => {
    // Compose reads the link, so the file stays loaded, but the bytes belong to
    // the shared target: the generation cannot hold them, so the omission keeps
    // readiness honest.
    await fsPromises.mkdir(path.join(composeDir, STACK, 'sub'), { recursive: true });
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('sub/compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await fsPromises.writeFile(path.join(composeDir, 'shared.env'), 'SUBVAR=shared\n', 'utf8');
    await fsPromises.symlink(
      path.join(composeDir, 'shared.env'),
      path.join(composeDir, STACK, 'sub', '.env'),
    );
    mockAuthoredComposeFileArgs.mockReturnValue([
      '--project-directory', path.join(composeDir, STACK, 'sub'),
      '-f', 'sub/compose.yaml',
      '-p', STACK,
    ]);

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.entries.map((entry) => entry.relativePath)).not.toContain('sub/.env');
    expect(inventory.uncapturedRelativePaths).toContain('sub/.env');
    expect(inventory.uncapturedInputs.join(' ')).toContain('sub/.env');
    expect(storedRestoreCoverage({ uncapturedInputs: inventory.uncapturedInputs })).toBe('omits_inputs');
  });

  it('pins the layer chain COMPOSE_FILE selects', async () => {
    // The captured root declares prod.yaml, so the generation holds it.
    await write('compose.yaml', 'include:\n  - ./prod.yaml\nservices:\n  web:\n    image: nginx\n');
    await write('prod.yaml', 'services:\n  web:\n    command: ["false"]\n');
    mockComposeFileEnvVarSelection.mockResolvedValue({ kind: 'value', value: 'compose.yaml:prod.yaml', pathSeparator: ':', composeEnvFiles: [], loadedEnvFiles: [] });

    const inventory = await resolveRollbackInventory(1, STACK);

    // A -f flag replaces COMPOSE_FILE, so pinning an inferred root would discard
    // the selection and restore a different stack.
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.uncapturedInputs).toEqual([]);
    expect(inventory.invocation.composeLayers).toEqual(['compose.yaml', 'prod.yaml']);
  });

  it('holds a COMPOSE_FILE layer the generation cannot capture as a partial input', async () => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('prod.yaml', 'services:\n  web:\n    command: ["false"]\n');
    mockComposeFileEnvVarSelection.mockResolvedValue({ kind: 'value', value: 'compose.yaml:prod.yaml', pathSeparator: ':', composeEnvFiles: [], loadedEnvFiles: [] });

    const inventory = await resolveRollbackInventory(1, STACK);

    // prod.yaml is the executing layer but no captured compose file declares it,
    // so the generation cannot hold it. It still pins it (otherwise recovery
    // would run the inferred root instead), reports the omission, and protects
    // the file from a restore that would otherwise delete it.
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.composeLayers).toEqual(['compose.yaml', 'prod.yaml']);
    expect(inventory.uncapturedInputs.join(' ')).toContain('prod.yaml');
    expect(inventory.uncapturedRelativePaths).toContain('prod.yaml');
  });

  it.each([
    ['a layer outside the stack', '/opt/compose/prod.yaml'],
    ['a layer that escapes the stack', '../shared/prod.yaml'],
  ])('refuses a COMPOSE_FILE chain naming %s', async (_label, value) => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    mockComposeFileEnvVarSelection.mockResolvedValue({ kind: 'value', value: `compose.yaml:${value}`, pathSeparator: ':', composeEnvFiles: [], loadedEnvFiles: [] });

    const inventory = await resolveRollbackInventory(1, STACK);

    // The recovery run always appends a recovery layer, which suppresses
    // discovery and with it COMPOSE_FILE, so a chain that cannot be pinned
    // would run a project the generation never held.
    expect(inventory.coverageRefusal).toMatch(/COMPOSE_FILE/);
    expect(inventory.invocation.composeLayers).toEqual(['compose.yaml']);
  });

  it('refuses a selected COMPOSE_FILE layer that links outside the compose directory', async () => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    // A regular file outside the compose directory, linked under a name the
    // chain selects. Compose follows the link live, but recovery refuses the
    // same target before Compose runs, so capture has to refuse first: an
    // accepted generation may not carry an invocation its own rollback
    // cannot launch.
    const outsideDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-layer-out-'));
    try {
      await fsPromises.writeFile(
        path.join(outsideDir, 'chosen.yaml'),
        'services:\n  web:\n    image: nginx\n',
        'utf8',
      );
      await fsPromises.symlink(path.join(outsideDir, 'chosen.yaml'), path.join(composeDir, STACK, 'chosen.yaml'));
      mockComposeFileEnvVarSelection.mockResolvedValue({
        kind: 'value',
        value: 'chosen.yaml',
        pathSeparator: ':',
        composeEnvFiles: [],
        loadedEnvFiles: [],
      });

      const inventory = await resolveRollbackInventory(1, STACK);

      expect(inventory.coverageRefusal).toContain('chosen.yaml links outside the compose directory');
    } finally {
      await fsPromises.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('holds a selected COMPOSE_FILE layer that links into the shared compose directory', async () => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
    await fsPromises.writeFile(
      path.join(composeDir, 'shared', 'chosen.yaml'),
      'services:\n  web:\n    image: nginx\n',
      'utf8',
    );
    await fsPromises.symlink(path.join(composeDir, 'shared', 'chosen.yaml'), path.join(composeDir, STACK, 'chosen.yaml'));
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'value',
      value: 'chosen.yaml',
      pathSeparator: ':',
      composeEnvFiles: [],
      loadedEnvFiles: [],
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    // A target inside the compose root stays an accepted omission: Compose
    // reads the link live and recovery allows the same target, so the partial
    // generation is one its own rollback can still launch.
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.composeLayers).toEqual(['chosen.yaml']);
    expect(inventory.uncapturedRelativePaths).toContain('chosen.yaml');
    expect(inventory.uncapturedInputs.join(' ')).toContain('chosen.yaml');
    expect(storedRestoreCoverage({ uncapturedInputs: inventory.uncapturedInputs })).toBe('omits_inputs');
  });

  it('refuses a shared COMPOSE_FILE layer that resolves to a directory without blocking', async () => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
    const target = path.join(composeDir, 'shared', 'target');
    await fsPromises.mkdir(target);
    await fsPromises.rm(path.join(composeDir, STACK, 'compose.yaml'));
    await fsPromises.symlink(target, path.join(composeDir, STACK, 'compose.yaml'));

    // Classification sees the target type before any read opens it.
    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toContain(
      'compose.yaml is a link to something that is not a regular file',
    );
    expect(inventory.invocation.composeLayers).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a shared COMPOSE_FILE layer that resolves to a fifo without blocking',
    async () => {
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
      await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
      const target = path.join(composeDir, 'shared', 'pipe.yaml');
      execFileSync('mkfifo', [target]);
      await fsPromises.rm(path.join(composeDir, STACK, 'compose.yaml'));
      await fsPromises.symlink(target, path.join(composeDir, STACK, 'compose.yaml'));

      // Classification sees the target type before any read opens it, so a FIFO
      // cannot hold the capture worker while it waits for a writer.
      const inventory = await resolveRollbackInventory(1, STACK);

      expect(inventory.coverageRefusal).toContain(
        'compose.yaml is a link to something that is not a regular file',
      );
      expect(inventory.invocation.composeLayers).toEqual([]);
    },
    3_000,
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a shared COMPOSE_FILE layer that resolves to a socket without blocking',
    async () => {
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
      await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
      const target = path.join(composeDir, 'shared', 'target.sock');
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(target, resolve);
      });
      try {
        await fsPromises.rm(path.join(composeDir, STACK, 'compose.yaml'));
        await fsPromises.symlink(target, path.join(composeDir, STACK, 'compose.yaml'));

        const inventory = await resolveRollbackInventory(1, STACK);

        expect(inventory.coverageRefusal).toContain(
          'compose.yaml is a link to something that is not a regular file',
        );
        expect(inventory.invocation.composeLayers).toEqual([]);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    3_000,
  );

  it.skipIf(process.platform === 'win32')(
    'refuses an implicit override that links to a shared fifo without blocking',
    async () => {
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
      await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
      const fifo = path.join(composeDir, 'shared', 'pipe.yaml');
      execFileSync('mkfifo', [fifo]);
      await fsPromises.symlink(fifo, path.join(composeDir, STACK, 'compose.override.yaml'));

      const inventory = await resolveRollbackInventory(1, STACK);

      // Compose's discovery would choose this override and then block reading
      // it, so the capture refuses the run rather than pinning a layer it cannot
      // load.
      expect(inventory.coverageRefusal).toContain(
        'compose.override.yaml is a link to something that is not a regular file',
      );
      expect(inventory.invocation.composeLayers).toEqual(['compose.yaml']);
    },
    3_000,
  );

  it('keeps a regular shared implicit override as a supported omission', async () => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
    await fsPromises.writeFile(
      path.join(composeDir, 'shared', 'override.yaml'),
      'services:\n  web:\n    command: ["true"]\n',
      'utf8',
    );
    await fsPromises.symlink(
      path.join(composeDir, 'shared', 'override.yaml'),
      path.join(composeDir, STACK, 'compose.override.yaml'),
    );

    const inventory = await resolveRollbackInventory(1, STACK);

    // The regular-file case the shared read policy exists to support must keep
    // working: the layer is pinned and its bytes are recorded as not held.
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.composeLayers).toEqual(['compose.yaml', 'compose.override.yaml']);
    expect(inventory.uncapturedRelativePaths).toContain('compose.override.yaml');
  });

  it('records the interpolation env files of a COMPOSE_FILE chain in a subdirectory', async () => {
    await fsPromises.mkdir(path.join(composeDir, STACK, 'sub'), { recursive: true });
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('sub/compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('.env', 'COMPOSE_FILE=sub/compose.yaml\nROOT_ONLY=captured\n');
    await write('sub/.env', 'SUBVAR=captured\n');
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'value',
      value: 'sub/compose.yaml',
      pathSeparator: ':',
      composeEnvFiles: [],
      loadedEnvFiles: [path.join(composeDir, STACK, '.env')],
      stackEnvRead: true,
      projectEnvDisabled: false,
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    // The live run applies the project file first and the stack root file
    // second, so the root file wins a key both define; recovery replays the
    // same order and the same winner.
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.composeLayers).toEqual(['sub/compose.yaml']);
    expect(inventory.invocation.interpolationEnvFiles).toEqual(['sub/.env', '.env']);
  });

  it('records an empty env list when the stack .env disables itself and the project one', async () => {
    await fsPromises.mkdir(path.join(composeDir, STACK, 'sub'), { recursive: true });
    // The conventional root holds the selected layer through an extends, so the
    // generation can capture it and the fixture has no unrelated omission.
    await write('compose.yaml', 'services:\n  web:\n    extends:\n      file: sub/compose.yaml\n      service: web\n');
    await write('sub/compose.yaml', 'services:\n  web:\n    image: nginx\n    environment:\n      MARKER: ${VALUE:-default}\n');
    // Compose evaluates COMPOSE_DISABLE_ENV_FILE from the environment it builds
    // while it reads this file, so the project directory's own `.env` is never
    // loaded even though the same run read this one.
    await write('.env', 'COMPOSE_FILE=sub/compose.yaml\nCOMPOSE_DISABLE_ENV_FILE=true\n');
    await write('sub/.env', 'VALUE=child\n');
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'value',
      value: 'sub/compose.yaml',
      pathSeparator: ':',
      composeEnvFiles: [],
      loadedEnvFiles: [path.join(composeDir, STACK, '.env')],
      stackEnvRead: true,
      projectEnvDisabled: true,
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    // The disabled file was not an input of the captured run, so the generation
    // must neither hold it nor replay it. Compose used the stack `.env` to
    // resolve COMPOSE_FILE but did not load its values for interpolation, so
    // the empty record pins that absence instead of letting recovery reload the
    // file and introduce values the live run never saw.
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.uncapturedInputs).toEqual([]);
    expect(inventory.invocation.composeLayers).toEqual(['sub/compose.yaml']);
    expect(inventory.invocation.interpolationEnvFiles).toEqual([]);
    expect(inventory.entries.map((e) => e.relativePath)).not.toContain('sub/.env');
  });

  it('records only the stack root env file when the selected project directory has none', async () => {
    await fsPromises.mkdir(path.join(composeDir, STACK, 'sub'), { recursive: true });
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('sub/compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('.env', 'COMPOSE_FILE=sub/compose.yaml\nROOT_ONLY=captured\n');
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'value',
      value: 'sub/compose.yaml',
      pathSeparator: ':',
      composeEnvFiles: [],
      loadedEnvFiles: [path.join(composeDir, STACK, '.env')],
      stackEnvRead: true,
      projectEnvDisabled: false,
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    // The project directory has no .env, so the live run loaded the stack
    // root file alone; without this record a pinned recovery would load none.
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.interpolationEnvFiles).toEqual(['.env']);
  });

  it('records no interpolation env files for a chain at the stack root', async () => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('.env', 'COMPOSE_FILE=compose.yaml\nROOT_ONLY=captured\n');
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'value',
      value: 'compose.yaml',
      pathSeparator: ':',
      composeEnvFiles: [],
      loadedEnvFiles: [],
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    // The project directory is the stack root, so the recovery's own default
    // loads the same file the live run loaded.
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.interpolationEnvFiles).toBeUndefined();
  });

  it('records no interpolation env files when the invocation selects its own env file', async () => {
    await fsPromises.mkdir(path.join(composeDir, STACK, 'sub'), { recursive: true });
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('sub/compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('select.env', 'COMPOSE_FILE=sub/compose.yaml\n');
    mockAuthoredComposeEnvFileArgs.mockResolvedValue([
      '--env-file', path.join(composeDir, STACK, 'select.env'),
    ]);
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'value',
      value: 'sub/compose.yaml',
      pathSeparator: ':',
      composeEnvFiles: [],
      loadedEnvFiles: [path.join(composeDir, STACK, 'select.env')],
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    // The captured prefix already names the env file, and recovery replays
    // it: the live run loaded nothing the replay misses.
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.interpolationEnvFiles).toBeUndefined();
  });

  it('records no interpolation env files when the project env file links outside the compose directory', async () => {
    await fsPromises.mkdir(path.join(composeDir, STACK, 'sub'), { recursive: true });
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('sub/compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('.env', 'COMPOSE_FILE=sub/compose.yaml\n');
    const outsideDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-env-out-'));
    try {
      await fsPromises.writeFile(path.join(outsideDir, 'sub.env'), 'SUBVAR=captured\n', 'utf8');
      await fsPromises.symlink(path.join(outsideDir, 'sub.env'), path.join(composeDir, STACK, 'sub', '.env'));
      mockComposeFileEnvVarSelection.mockResolvedValue({
        kind: 'value',
        value: 'sub/compose.yaml',
        pathSeparator: ':',
        composeEnvFiles: [],
        loadedEnvFiles: [],
      });

      const inventory = await resolveRollbackInventory(1, STACK);

      // The recovery resolver cannot name a file that links out of the
      // compose directory, so no reconstruction is recorded. The omission it
      // already records keeps the coverage claim partial.
      expect(inventory.coverageRefusal).toBeNull();
      expect(inventory.invocation.interpolationEnvFiles).toBeUndefined();
      expect(inventory.uncapturedInputs.join(' ')).toContain('sub/.env');
      expect(storedRestoreCoverage({ uncapturedInputs: inventory.uncapturedInputs })).toBe('omits_inputs');
    } finally {
      await fsPromises.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('refuses a chain project env link outside the compose directory when the stack .env was read', async () => {
    await fsPromises.mkdir(path.join(composeDir, STACK, 'sub'), { recursive: true });
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('sub/compose.yaml', 'services:\n  web:\n    image: nginx\n');
    // The stack .env selects the chain and wins a key both files define, so a
    // recovery has to replay it after the project env file.
    await write('.env', 'COMPOSE_FILE=sub/compose.yaml\nVALUE=from-root\n');
    const outsideDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-env-out-'));
    try {
      await fsPromises.writeFile(path.join(outsideDir, 'sub.env'), 'VALUE=from-project\n', 'utf8');
      await fsPromises.symlink(path.join(outsideDir, 'sub.env'), path.join(composeDir, STACK, 'sub', '.env'));
      mockComposeFileEnvVarSelection.mockResolvedValue({
        kind: 'value',
        value: 'sub/compose.yaml',
        pathSeparator: ':',
        composeEnvFiles: [],
        loadedEnvFiles: [path.join(composeDir, STACK, '.env')],
        stackEnvRead: true,
        projectEnvDisabled: false,
      });

      const inventory = await resolveRollbackInventory(1, STACK);

      // Recovery cannot name the linked target, and replaying only the stack
      // .env would drop a source the live run read while leaving the list
      // unrecorded hands the winning key to the project file. Neither is the
      // captured invocation, so the capture refuses before any mutation.
      expect(inventory.coverageRefusal).toContain('sub/.env');
      expect(inventory.coverageRefusal).toContain('leaves the compose directory');
      expect(inventory.invocation.interpolationEnvFiles).toBeUndefined();
      // A refusal writes nothing, so it carries no partial-capture lists.
      expect(inventory.uncapturedInputs).toEqual([]);
    } finally {
      await fsPromises.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('replays a chain project env link that stays inside the compose directory', async () => {
    await fsPromises.mkdir(path.join(composeDir, STACK, 'sub'), { recursive: true });
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('sub/compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('.env', 'COMPOSE_FILE=sub/compose.yaml\nVALUE=from-root\n');
    await fsPromises.writeFile(path.join(composeDir, 'shared.env'), 'VALUE=from-shared\n', 'utf8');
    await fsPromises.symlink(
      path.join(composeDir, 'shared.env'),
      path.join(composeDir, STACK, 'sub', '.env'),
    );
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'value',
      value: 'sub/compose.yaml',
      pathSeparator: ':',
      composeEnvFiles: [],
      loadedEnvFiles: [path.join(composeDir, STACK, '.env')],
      stackEnvRead: true,
      projectEnvDisabled: false,
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    // A shared env file is read live by a recovery resolver, so the ordered
    // replay names it and the root .env that wins after it. The file itself
    // stays an omission, which is what keeps the generation partial.
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.interpolationEnvFiles).toEqual(['sub/.env', '.env']);
    expect(inventory.uncapturedRelativePaths).toContain('sub/.env');
  });

  it('records an empty interpolation env list when no default env file exists at capture', async () => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');

    const inventory = await resolveRollbackInventory(1, STACK);

    // Recovery would otherwise leave the choice to discovery and read an
    // `.env` created after capture, so the absence is part of the invocation.
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.interpolationEnvFiles).toEqual([]);
  });

  it('records an empty interpolation env list for a subdirectory chain with neither env file', async () => {
    await fsPromises.mkdir(path.join(composeDir, STACK, 'sub'), { recursive: true });
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('sub/compose.yaml', 'services:\n  web:\n    image: nginx\n');
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'value',
      value: 'sub/compose.yaml',
      pathSeparator: ':',
      composeEnvFiles: [],
      loadedEnvFiles: [],
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.composeLayers).toEqual(['sub/compose.yaml']);
    expect(inventory.invocation.interpolationEnvFiles).toEqual([]);
  });

  it('records an empty env list when an explicit -f moves the project and only the root env file exists', async () => {
    await fsPromises.mkdir(path.join(composeDir, STACK, 'sub'), { recursive: true });
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('sub/compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('.env', 'VALUE=root\n');
    mockAuthoredComposeFileArgs.mockReturnValue(['-f', 'sub/compose.yaml', '-p', STACK]);

    const inventory = await resolveRollbackInventory(1, STACK);

    // Compose reads only the project directory's `.env` here, so the root file
    // is not an input and the missing project file is what recovery must pin.
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.interpolationEnvFiles).toEqual([]);
  });

  it('records no empty env list when an explicit -f moves the project and its env file exists', async () => {
    await fsPromises.mkdir(path.join(composeDir, STACK, 'sub'), { recursive: true });
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('sub/compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('sub/.env', 'VALUE=sub\n');
    mockAuthoredComposeFileArgs.mockReturnValue(['-f', 'sub/compose.yaml', '-p', STACK]);

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.invocation.interpolationEnvFiles).toBeUndefined();
  });

  it('keeps the project env file when an explicit -f starts outside the stack root', async () => {
    await fsPromises.mkdir(path.join(composeDir, STACK, 'sub'), { recursive: true });
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('sub/compose.yaml', 'services:\n  web:\n    image: nginx\n');
    // The stack root file would disable the project env if Compose read it, but
    // an explicit -f makes the project start in sub, so Compose never opens the
    // root file and loads sub/.env normally.
    await write('.env', 'COMPOSE_FILE=sub/compose.yaml\nCOMPOSE_DISABLE_ENV_FILE=true\n');
    await write('sub/.env', 'VALUE=sub\n');
    mockAuthoredComposeFileArgs.mockReturnValue(['-f', 'sub/compose.yaml', '-p', STACK]);
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'value',
      value: 'sub/compose.yaml',
      pathSeparator: ':',
      composeEnvFiles: [],
      loadedEnvFiles: [path.join(composeDir, STACK, '.env')],
      stackEnvRead: true,
      projectEnvDisabled: true,
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.entries.map((e) => e.relativePath)).toContain('sub/.env');
    expect(inventory.uncapturedInputs.join(' ')).not.toContain('sub/.env');
  });

  it('records an empty env list when the stack .env disables itself and no project file exists', async () => {
    await fsPromises.mkdir(path.join(composeDir, STACK, 'sub'), { recursive: true });
    await write('compose.yaml', 'services:\n  web:\n    extends:\n      file: sub/compose.yaml\n      service: web\n');
    await write('sub/compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('.env', 'COMPOSE_FILE=sub/compose.yaml\nCOMPOSE_DISABLE_ENV_FILE=true\n');
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'value',
      value: 'sub/compose.yaml',
      pathSeparator: ':',
      composeEnvFiles: [],
      loadedEnvFiles: [path.join(composeDir, STACK, '.env')],
      stackEnvRead: true,
      projectEnvDisabled: true,
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    // The self-disabled stack file selected the layers but supplied no
    // interpolation values, so recovery pins an empty input instead of
    // reloading the file.
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.composeLayers).toEqual(['sub/compose.yaml']);
    expect(inventory.invocation.interpolationEnvFiles).toEqual([]);
  });

  it('records no empty env list when the stack root env file exists', async () => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('.env', 'VALUE=captured\n');

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.invocation.interpolationEnvFiles).toBeUndefined();
  });

  it.each(['dangling', 'loop', 'outside', 'shared'] as const)(
    'records no empty env list when the default env path is a %s link',
    async (kind) => {
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
      const envPath = path.join(composeDir, STACK, '.env');
      const outsideDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-env-link-'));
      try {
        if (kind === 'dangling') {
          await fsPromises.symlink(path.join(composeDir, STACK, 'missing.env'), envPath);
        } else if (kind === 'loop') {
          await fsPromises.symlink(envPath, envPath);
        } else if (kind === 'outside') {
          await fsPromises.writeFile(path.join(outsideDir, 'target.env'), 'VALUE=outside\n', 'utf8');
          await fsPromises.symlink(path.join(outsideDir, 'target.env'), envPath);
        } else {
          await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
          await fsPromises.writeFile(path.join(composeDir, 'shared', 'shared.env'), 'VALUE=shared\n', 'utf8');
          await fsPromises.symlink(path.join(composeDir, 'shared', 'shared.env'), envPath);
        }

        const inventory = await resolveRollbackInventory(1, STACK);

        // Something is linked there, so the capture-time run may have read it.
        // The classifier's own accounting stands; no absence is replayed.
        expect(inventory.invocation.interpolationEnvFiles).toBeUndefined();
      } finally {
        await fsPromises.rm(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it('records no empty env list when the default env path holds a directory', async () => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await fsPromises.mkdir(path.join(composeDir, STACK, '.env'));

    const inventory = await resolveRollbackInventory(1, STACK);

    // Something exists there, so it is not an absence to replay; the restore
    // keeps refusing a non-regular env input instead of running around it.
    expect(inventory.invocation.interpolationEnvFiles).toBeUndefined();
  });

  it.each([
    ['COMPOSE_ENV_FILES', 'custom.env'],
    ['COMPOSE_DISABLE_ENV_FILE', 'true'],
  ])('records no empty env list when %s replaces the default env file', async (key, value) => {
    const previous = process.env[key];
    process.env[key] = value;
    try {
      await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');

      const inventory = await resolveRollbackInventory(1, STACK);

      // The process environment selects the env input here, and recovery
      // reads it live, so there is no default to pin.
      expect(inventory.invocation.interpolationEnvFiles).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it('pins an absolute COMPOSE_FILE chain that stays inside the stack', async () => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('prod.yaml', 'services:\n  web:\n    command: ["false"]\n');
    const stackDir = path.join(composeDir, STACK);
    // Compose takes an absolute entry as written and a relative one against its
    // working directory, so the two spellings are the same layer. The chain is
    // pinned by its stack-relative name, which is the form a recovery run can
    // rebuild under an overlay.
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'value',
      value: `${path.join(stackDir, 'compose.yaml')}:${path.join(stackDir, 'prod.yaml')}`,
      pathSeparator: ':',
      composeEnvFiles: [],
      loadedEnvFiles: [],
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.composeLayers).toEqual(['compose.yaml', 'prod.yaml']);
  });

  it('pins an absolute COMPOSE_FILE chain spelled through a relocated compose root', async () => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('prod.yaml', 'services:\n  web:\n    command: ["false"]\n');
    // A compose directory that is itself a link (a relocated data directory).
    // Compose loads the physical path a chain names, so that spelling has to be
    // accepted too, and the layer is still pinned by its stack-relative name.
    const linkedRoot = path.join(composeDir, 'relocated');
    await fsPromises.symlink(composeDir, linkedRoot, 'dir');
    mockState.composeDir = linkedRoot;
    const realRoot = await fsPromises.realpath(composeDir);
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'value',
      value: `${path.join(realRoot, STACK, 'compose.yaml')}:${path.join(realRoot, STACK, 'prod.yaml')}`,
      pathSeparator: ':',
      composeEnvFiles: [],
      loadedEnvFiles: [],
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.composeLayers).toEqual(['compose.yaml', 'prod.yaml']);
  });

  it('refuses an absolute COMPOSE_FILE chain that names another stack', async () => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    const otherStackDir = path.join(composeDir, 'other');
    await fsPromises.mkdir(otherStackDir, { recursive: true });
    await fsPromises.writeFile(path.join(otherStackDir, 'prod.yaml'), 'services: {}\n', 'utf8');
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'value',
      value: `compose.yaml:${path.join(otherStackDir, 'prod.yaml')}`,
      pathSeparator: ':',
      composeEnvFiles: [],
      loadedEnvFiles: [],
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    // An absolute path is not a licence to pin a layer outside the stack: the
    // recovery run could not rebuild it and the capture cannot hold it.
    expect(inventory.coverageRefusal).toMatch(/COMPOSE_FILE/);
  });

  it('splits the chain only on the separator Compose uses', async () => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    // A semicolon is a legal character in a filename on this platform, so a
    // stock ':' chain must not be split on it.
    await write('prod;staging.yaml', 'services:\n  web:\n    command: ["false"]\n');
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'value',
      value: 'compose.yaml:prod;staging.yaml',
      pathSeparator: ':',
      composeEnvFiles: [],
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.composeLayers).toEqual(['compose.yaml', 'prod;staging.yaml']);
  });

  it('honours a non-default chain separator', async () => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('prod', 'services:\n  web:\n    image: nginx\n');
    await write('staging', 'services:\n  web:\n    image: nginx\n');
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'value',
      value: 'compose.yaml;prod',
      pathSeparator: ';',
      composeEnvFiles: [],
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.composeLayers).toEqual(['compose.yaml', 'prod']);
  });

  it('refuses a chain whose unset variable leaves an empty layer', async () => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    // What the reader produces for `.env` holding
    // `COMPOSE_FILE=compose.yaml:${CHAIN_LAYER}` with the variable unset.
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'value',
      value: 'compose.yaml:',
      pathSeparator: ':',
      composeEnvFiles: [],
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    // Compose refuses to run a chain that names an empty entry, so a recovery
    // run that pinned one would load a project the capture never held.
    expect(inventory.coverageRefusal).toMatch(/empty compose layer/);
  });

  it('pins a layer whose name holds a literal dollar', async () => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('$prod.yaml', 'services:\n  web:\n    command: ["false"]\n');
    // `$$` is a literal dollar in Compose, and the reader expands it, so this is
    // a filename rather than an unresolved variable.
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'value',
      value: 'compose.yaml:$prod.yaml',
      pathSeparator: ':',
      composeEnvFiles: [],
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.composeLayers).toEqual(['compose.yaml', '$prod.yaml']);
  });

  it.each([
  ['a multi-character separator', '::', 'compose.yaml::prod'],
  ['an empty separator falling back to the default', '', 'compose.yaml:prod'],
])('accepts %s', async (_label, pathSeparator, value) => {
  await write('compose.yaml', 'include:\n  - ./prod\nservices:\n  web:\n    image: nginx\n');
  await write('prod', 'services:\n  web:\n    command: ["false"]\n');
  mockComposeFileEnvVarSelection.mockResolvedValue({ kind: 'value', value, pathSeparator, composeEnvFiles: [], loadedEnvFiles: [] });

  const inventory = await resolveRollbackInventory(1, STACK);

  expect(inventory.coverageRefusal).toBeNull();
  expect(inventory.invocation.composeLayers).toEqual(['compose.yaml', 'prod']);
});

it('records a COMPOSE_FILE layer that links outside the stack as not captured', async () => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
    await fsPromises.writeFile(path.join(composeDir, 'shared', 'prod.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.symlink(path.join(composeDir, 'shared', 'prod.yaml'), path.join(composeDir, STACK, 'prod.yaml'));
    mockComposeFileEnvVarSelection.mockResolvedValue({ kind: 'value', value: 'compose.yaml:prod.yaml', pathSeparator: ':', composeEnvFiles: [], loadedEnvFiles: [] });

    const inventory = await resolveRollbackInventory(1, STACK);

    // The layer is loaded whatever it is, so it stays pinned, but a generation
    // cannot hold bytes that live in another stack: the omission is what keeps
    // readiness honest and stops a restore from touching that link.
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.composeLayers).toEqual(['compose.yaml', 'prod.yaml']);
    expect(inventory.uncapturedInputs.join(' ')).toContain('prod.yaml');
    expect(inventory.uncapturedRelativePaths).toContain('prod.yaml');
  });

  it('refuses when the environment that selects the layers cannot be read', async () => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    mockComposeFileEnvVarSelection.mockResolvedValue({ kind: 'unknown', reason: 'the env file select.env could not be read', loadedEnvFiles: [] });

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toMatch(/COMPOSE_FILE/);
  });

  it('leaves COMPOSE_FILE alone when the captured prefix already pins files', async () => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('prod.yaml', 'services:\n  web:\n    command: ["false"]\n');
    await write('select.env', 'IMAGE=nginx\n');
    mockAuthoredComposeFileArgs.mockReturnValue(['-f', 'compose.yaml', '-f', 'prod.yaml', '-p', 'layers']);
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'value',
      value: 'compose.yaml:prod.yaml',
      pathSeparator: ':',
      composeEnvFiles: [path.join(composeDir, STACK, 'select.env')],
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    // Compose ignores the variable once -f is given, so there is nothing to
    // reconcile and nothing that could fail.
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.composeLayers).toEqual(['compose.yaml']);
    // A -f list does not suppress COMPOSE_ENV_FILES: Compose still loads those
    // files for interpolation, so they are still recorded as not captured.
    expect(inventory.uncapturedInputs.join(' ')).toContain('select.env');
    expect(inventory.uncapturedRelativePaths).toContain('select.env');
  });
});

describe('resolveRollbackInventory: inputs that cannot be captured', () => {
  let composeDir: string;
  let stackDir: string;
  const STACK = 'app';

  async function writeCompose(content: string): Promise<void> {
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), content, 'utf8');
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    composeDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-inv-unc-'));
    mockState.composeDir = composeDir;
    stackDir = path.join(composeDir, STACK);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.mkdir(path.join(composeDir, 'shared-common'), { recursive: true });
    mockGetGitSource.mockReturnValue(undefined);
    mockGetStackProjectEnvFiles.mockReturnValue([]);
    mockAuthoredComposeFileArgs.mockReturnValue(['-f', 'compose.yaml']);
    mockAuthoredComposeEnvFileArgs.mockResolvedValue([]);
    mockComposeFileEnvVarSelection.mockResolvedValue({ kind: 'absent', composeEnvFiles: [], loadedEnvFiles: [] });
  });

  it.each([
    ['a relative include', 'include:\n  - path: ../shared-common/base.yaml\nservices:\n  web:\n    image: nginx\n', /include \.\.\/shared-common\/base\.yaml/],
    ['a relative extends', 'services:\n  web:\n    extends:\n      file: ../shared-common/ext.yaml\n      service: base\n', /extends \.\.\/shared-common\/ext\.yaml/],
    ['an absolute include', 'include:\n  - path: /srv/shared/base.yaml\nservices:\n  web:\n    image: nginx\n', /include \/srv\/shared\/base\.yaml/],
    ['a URL include', 'include:\n  - path: https://example.com/base.yaml\nservices:\n  web:\n    image: nginx\n', /include https:\/\/example\.com\/base\.yaml/],
  ])('records %s outside the stack as not captured and does not refuse', async (_label, compose, note) => {
    await writeCompose(compose);

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.uncapturedInputs).toHaveLength(1);
    expect(inventory.uncapturedInputs[0]).toMatch(note);
    expect(inventory.uncapturedInputs[0]).not.toMatch(/host-absolute/i);
    expect(inventory.entries.map((e) => e.relativePath)).toEqual(['compose.yaml']);
  });

  it('records an env_file path that holds a variable as not captured', async () => {
    await writeCompose('services:\n  web:\n    image: nginx\n    env_file: ${ENV_FILE:-.env}\n');

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.uncapturedInputs).toHaveLength(1);
    expect(inventory.uncapturedInputs[0]).toContain('${ENV_FILE:-.env}');
  });

  it('stays silent about application data, build and name-only inputs', async () => {
    await writeCompose([
      'services:',
      '  web:',
      '    build:',
      '      context: ../shared-common',
      '      dockerfile: ../shared-common/Dockerfile',
      '    volumes:',
      '      - ${DATA}:/data',
      '      - ./data:/var/data',
      '      - /srv/media:/media',
      '    secrets:',
      '      - token',
      'secrets:',
      '  token:',
      '    external: true',
      '',
    ].join('\n'));

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.uncapturedInputs).toEqual([]);
  });

  it('does not adopt a home-relative bind as a stack path', async () => {
    await writeCompose([
      'services:',
      '  web:',
      '    image: nginx',
      '    volumes:',
      '      - ~/.cache/data.env:/data',
      '',
    ].join('\n'));

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    // The home spelling names a file outside the stack. It must not become a
    // literal `~` path that capture would snapshot from inside the stack.
    expect(inventory.applicationDataPaths).toEqual([]);
    expect(inventory.entries.map((e) => e.relativePath)).toEqual(['compose.yaml']);
  });

  it('excludes a managed file that links outside the stack without writing a tombstone', async () => {
    await writeCompose('services:\n  web:\n    image: nginx\n');
    await fsPromises.writeFile(path.join(composeDir, 'shared-common', 'shared.env'), 'A=1\n', 'utf8');
    await fsPromises.symlink(path.join(composeDir, 'shared-common', 'shared.env'), path.join(stackDir, '.env'));

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.entries.map((e) => e.relativePath)).toEqual(['compose.yaml']);
    expect(inventory.uncapturedRelativePaths).toEqual(['.env']);
    // An authored stack owns what it omits, so a link that became a file can
    // still be cleaned up.
    expect(inventory.ownedUncapturedRelativePaths).toEqual(['.env']);
    expect(inventory.uncapturedInputs).toEqual([expect.stringMatching(/^\.env links outside the stack directory/)]);
  });

  it('excludes a dangling managed link and notes it', async () => {
    await writeCompose('services:\n  web:\n    image: nginx\n');
    await fsPromises.symlink(path.join(composeDir, 'shared-common', 'gone.env'), path.join(stackDir, '.env'));

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.entries.map((e) => e.relativePath)).toEqual(['compose.yaml']);
    expect(inventory.uncapturedRelativePaths).toEqual(['.env']);
  });

  it('keeps a managed file whose link stays inside the stack', async () => {
    await writeCompose('services:\n  web:\n    image: nginx\n');
    await fsPromises.writeFile(path.join(stackDir, 'real.env'), 'A=1\n', 'utf8');
    await fsPromises.symlink('real.env', path.join(stackDir, '.env'));

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.uncapturedInputs).toEqual([]);
    expect(inventory.entries.map((e) => e.relativePath)).toContain('.env');
  });

  it('notes a project env file that is not a valid stack-relative path', async () => {
    await writeCompose('services:\n  web:\n    image: nginx\n');
    mockGetStackProjectEnvFiles.mockReturnValue(['../shared-common/shared.env']);

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.uncapturedInputs).toEqual([expect.stringContaining('../shared-common/shared.env')]);
  });

  it('excludes a file reached through a link on a parent directory', async () => {
    await writeCompose('services:\n  web:\n    image: nginx\n    env_file: ./config/app.env\n');
    await fsPromises.writeFile(path.join(composeDir, 'shared-common', 'app.env'), 'A=1\n', 'utf8');
    await fsPromises.symlink(path.join(composeDir, 'shared-common'), path.join(stackDir, 'config'));

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.entries.map((e) => e.relativePath)).toEqual(['compose.yaml']);
    expect(inventory.uncapturedRelativePaths).toEqual(['config/app.env']);
    expect(inventory.uncapturedInputs).toEqual([
      "config/app.env links outside the stack directory into the shared compose directory and is not captured; a rollback reads the linked file's current content",
    ]);
  });

  it('notes a link loop and a link to a directory with their own wording', async () => {
    await writeCompose('services:\n  web:\n    image: nginx\n    env_file: [./loop.env, ./dir.env]\n');
    await fsPromises.symlink('loop-b.env', path.join(stackDir, 'loop.env'));
    await fsPromises.symlink('loop.env', path.join(stackDir, 'loop-b.env'));
    await fsPromises.mkdir(path.join(stackDir, 'real-dir'));
    await fsPromises.symlink('real-dir', path.join(stackDir, 'dir.env'));

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.uncapturedInputs).toEqual(expect.arrayContaining([
      'loop.env is a link that never resolves and is not captured',
      'dir.env is a link to something that is not a regular file and is not captured',
    ]));
    expect(inventory.entries.map((e) => e.relativePath)).toEqual(['compose.yaml']);
  });

  it('keeps an application-data link out of the notes and out of the managed set', async () => {
    await writeCompose('services:\n  web:\n    image: nginx\n    volumes:\n      - ./data:/data\n');
    await fsPromises.mkdir(path.join(composeDir, 'shared-common', 'data'));
    await fsPromises.symlink(path.join(composeDir, 'shared-common', 'data'), path.join(stackDir, 'data'));

    const inventory = await resolveRollbackInventory(1, STACK);

    // Application data is not a managed path: no note, and no path a restore
    // could later treat as a file the generation owns or cleans up. A data
    // link that appears after capture survives the restore for the same
    // reason: it never travels with the managed inputs.
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.uncapturedInputs).toEqual([]);
    expect(inventory.uncapturedRelativePaths).toEqual([]);
  });

  it('lists only the non-silent input when silent kinds sit beside it', async () => {
    await writeCompose([
      'services:',
      '  web:',
      '    image: nginx',
      '    env_file: ${ENV_FILE}',
      '    volumes:',
      '      - ${DATA}:/data',
      '',
    ].join('\n'));

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.uncapturedInputs).toHaveLength(1);
    expect(inventory.uncapturedInputs[0]).toContain('${ENV_FILE}');
  });

  it('redacts credentials from an include URL in the notes', async () => {
    await writeCompose('include:\n  - path: https://deploy:s3cr3tpass@example.com/base.yaml\nservices:\n  web:\n    image: nginx\n');

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.uncapturedInputs).toHaveLength(1);
    expect(inventory.uncapturedInputs[0]).not.toContain('s3cr3tpass');
    expect(inventory.uncapturedInputs[0]).toContain('[redacted]');
  });

  it.each([
    ['a token as the user info', 'https://ghp_t0kenvalue123@example.com/base.yaml', 'ghp_t0kenvalue123', 'https://[redacted]@example.com/base.yaml'],
    ['a token in the query string', 'https://example.com/base.yaml?token=abc123secret', 'abc123secret', 'https://example.com/base.yaml?[redacted]'],
    ['a token in the fragment', 'https://example.com/base.yaml#access=abc123secret', 'abc123secret', 'https://example.com/base.yaml?[redacted]'],
  ])('redacts %s from the notes', async (_label, url, secret, shown) => {
    await writeCompose(`include:\n  - path: "${url}"\nservices:\n  web:\n    image: nginx\n`);

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.uncapturedInputs).toHaveLength(1);
    expect(inventory.uncapturedInputs[0]).not.toContain(secret);
    expect(inventory.uncapturedInputs[0]).toContain(shown);
  });

  // "@" is legal unencoded inside a password, so userinfo ends at the LAST one.
  // Stopping at the first leaves the tail of the password in a note that is
  // persisted, logged and returned by the readiness API.
  it.each([
    ['a raw @ in the password', 'https://alice:s3cr3t@pass@example.com/base.yaml', ['s3cr3t', 'pass'], 'https://[redacted]@example.com/base.yaml'],
    ['two raw @ in the password', 'https://alice:a@b@c@example.com/base.yaml', ['a@b@c'], 'https://[redacted]@example.com/base.yaml'],
    ['an encoded @ in the password', 'https://alice:s3cr3t%40pass@example.com/base.yaml', ['s3cr3t%40pass'], 'https://[redacted]@example.com/base.yaml'],
    ['a user and password pair', 'https://alice:s3cr3tpass@example.com/base.yaml', ['alice', 's3cr3tpass'], 'https://[redacted]@example.com/base.yaml'],
    ['a malformed userinfo with a query', 'https://alice:s3cr3tpass?x@example.com/base.yaml', ['alice', 's3cr3tpass'], 'https://[redacted]@example.com/base.yaml'],
  ])('redacts %s whole', async (_label, url, secrets, shown) => {
    await writeCompose(`include:\n  - path: "${url}"\nservices:\n  web:\n    image: nginx\n`);

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.uncapturedInputs).toHaveLength(1);
    for (const secret of secrets) expect(inventory.uncapturedInputs[0]).not.toContain(secret);
    expect(inventory.uncapturedInputs[0]).toContain(shown);
  });

  it('leaves an ordinary override file name readable in the notes', async () => {
    await writeCompose('include:\n  - path: ../shared-common/docker-compose.production.override.yml\nservices:\n  web:\n    image: nginx\n');

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.uncapturedInputs[0]).toContain('docker-compose.production.override.yml');
  });

  it('captures a main compose file that links into the shared compose directory as a partial input', async () => {
    await fsPromises.writeFile(path.join(composeDir, 'shared-common', 'base.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.symlink(path.join(composeDir, 'shared-common', 'base.yaml'), path.join(stackDir, 'compose.yaml'));
    await fsPromises.symlink(path.join(composeDir, 'shared-common', 'gone.env'), path.join(stackDir, '.env'));

    const inventory = await resolveRollbackInventory(1, STACK);

    // The stack opens and deploys: Compose follows the link. The generation
    // cannot hold bytes that belong to the shared target, so the main file is a
    // recorded omission and the layer it names is still pinned, or recovery
    // would fall back to discovery and lose the selection.
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.entries).toEqual([]);
    expect(inventory.invocation.composeLayers).toEqual(['compose.yaml']);
    expect(inventory.uncapturedRelativePaths).toEqual(['.env', 'compose.yaml']);
    expect(inventory.uncapturedInputs).toEqual(expect.arrayContaining([
      "compose.yaml links outside the stack directory into the shared compose directory and is not captured; a rollback reads the linked file's current content",
      '.env is a link to a missing file and is not captured',
    ]));
  });

  it('captures an override file that links into the shared compose directory as a partial input', async () => {
    await fsPromises.writeFile(path.join(composeDir, 'shared-common', 'base.yaml'), 'services: {}\n', 'utf8');
    await writeCompose('services: {}\n');
    await fsPromises.symlink(path.join(composeDir, 'shared-common', 'base.yaml'), path.join(stackDir, 'compose.override.yml'));

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.entries.map((e) => e.relativePath)).toEqual(['compose.yaml']);
    expect(inventory.invocation.composeLayers).toEqual(['compose.yaml', 'compose.override.yml']);
    expect(inventory.uncapturedRelativePaths).toContain('compose.override.yml');
  });

  it('refuses a stack directory that links to another location, like the compose file guard', async () => {
    const elsewhere = path.join(composeDir, 'elsewhere');
    await fsPromises.mkdir(elsewhere);
    await fsPromises.writeFile(path.join(elsewhere, 'compose.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.rm(stackDir, { recursive: true, force: true });
    await fsPromises.symlink(elsewhere, stackDir);

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toMatch(
      /^Compose file compose\.yaml is in a stack directory that links to another location/,
    );
  });

  it('refuses a dangling compose file and skips a dangling override file', async () => {
    await fsPromises.symlink(path.join(composeDir, 'shared-common', 'gone.yaml'), path.join(stackDir, 'compose.yaml'));

    const dangling = await resolveRollbackInventory(1, STACK);
    expect(dangling.coverageRefusal).toBe('Compose file compose.yaml is a link to a missing file');

    await fsPromises.rm(path.join(stackDir, 'compose.yaml'));
    await writeCompose('services: {}\n');
    // A dangling override is not a file docker compose can stat, so it skips it
    // exactly as Compose skips it and loads the next candidate. Refusing here
    // would reject a stack Compose itself deploys without the override.
    await fsPromises.symlink(path.join(composeDir, 'shared-common', 'gone.yaml'), path.join(stackDir, 'compose.override.yml'));
    await fsPromises.writeFile(
      path.join(stackDir, 'compose.override.yaml'),
      'services:\n  app:\n    image: nginx\n',
      'utf8',
    );

    const override = await resolveRollbackInventory(1, STACK);
    expect(override.coverageRefusal).toBeNull();
    expect(override.invocation.composeLayers).toEqual(['compose.yaml', 'compose.override.yaml']);
  });

  it('records every loaded env file when the layer-selection reader cannot decide', async () => {
    await writeCompose('services:\n  web:\n    image: nginx\n');
    const outside = path.join(composeDir, '..', 'operator.env');
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'unknown',
      reason: `the env file ${outside} could not be read`,
      loadedEnvFiles: [outside, path.join(stackDir, 'later.env')],
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    // A captured -f list is what lets this stack capture at all: the reader's
    // unknown state names the files the run still loads, so it is not itself a
    // refusal.
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.uncapturedInputs).toEqual([
      'operator.env is loaded by Compose for interpolation from outside the stack directory and is not captured',
      'later.env is loaded by Compose for interpolation and is not captured',
    ]);
    // An outside path cannot be protected by a stack-relative name, so only the
    // in-stack entry joins the list a restore never deletes.
    expect(inventory.uncapturedRelativePaths).toEqual(['later.env']);
  });

  it('skips a loaded env file the generation already holds when the reader cannot decide', async () => {
    await writeCompose('services:\n  web:\n    image: nginx\n');
    await fsPromises.writeFile(path.join(stackDir, '.env'), 'A=1\n', 'utf8');
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'unknown',
      reason: 'the env file select.env could not be read',
      loadedEnvFiles: [path.join(stackDir, '.env')],
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.entries.map((e) => e.relativePath)).toEqual(['.env', 'compose.yaml']);
    // The project .env is an entry, so it is held and is not an omission.
    expect(inventory.uncapturedInputs).toEqual([]);
    expect(inventory.uncapturedRelativePaths).toEqual([]);
    // The live selection still could not be decided, so a restore may not
    // delete live paths on evidence this reader cannot classify.
    expect(inventory.recoveryRefusal).toBe('the env file select.env could not be read');
  });

  it('fails closed when a first-apply Git stack also has a refused authored inventory', async () => {
    mockGetGitSource.mockReturnValue({
      stack_name: STACK,
      repo_url: 'https://example.com/repo.git',
      branch: 'main',
      last_applied_commit_sha: null,
      last_applied_content_hash: null,
      applied_deploy_spec: null,
      sync_env: false,
      manifest_version: null,
      manifest_state: null,
      manifest_generation: null,
    });
    mockReadManifest.mockResolvedValue(null);

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toMatch(/manifest is missing/i);
  });

  it('keeps the live interpolation refusal when a refused Git inventory is returned', async () => {
    await writeCompose('services:\n  web:\n    image: nginx\n');
    mockGetGitSource.mockReturnValue({
      stack_name: STACK,
      repo_url: 'https://example.com/repo.git',
      branch: 'main',
      last_applied_commit_sha: null,
      last_applied_content_hash: null,
      applied_deploy_spec: null,
      sync_env: false,
      manifest_version: null,
      manifest_state: null,
      manifest_generation: null,
    });
    mockReadManifest.mockResolvedValue(null);
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'invalid',
      reason: 'The project .env is not a regular file, so Compose cannot read it for interpolation',
      loadedEnvFiles: [path.join(composeDir, STACK, '.env')],
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    // The Git manifest refusal still owns the capture, but the live env input
    // is a restore-time condition the manifest says nothing about: dropping it
    // would let a restore write the project and then hand Compose a FIFO.
    expect(inventory.coverageRefusal).toMatch(/manifest is missing/i);
    expect(inventory.recoveryRefusal).toBe(
      'The project .env is not a regular file, so Compose cannot read it for interpolation',
    );
  });

  it('still refuses when the compose file cannot be parsed', async () => {
    await writeCompose('services: [unclosed\n');

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).not.toBeNull();
  });

  it('still refuses when no compose file exists', async () => {
    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toMatch(/No compose file/);
  });

  it('merges a first-apply Git stack with a variable path instead of failing closed', async () => {
    await writeCompose('services:\n  web:\n    image: nginx\n    env_file: ${ENV_FILE:-.env}\n');
    mockGetGitSource.mockReturnValue({
      stack_name: STACK,
      repo_url: 'https://example.com/repo.git',
      branch: 'main',
      last_applied_commit_sha: null,
      last_applied_content_hash: null,
      applied_deploy_spec: null,
      sync_env: false,
      manifest_version: null,
      manifest_state: null,
      manifest_generation: null,
    });
    mockReadManifest.mockResolvedValue(null);

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.git?.repoUrl).toBe('https://example.com/repo.git');
    expect(inventory.entries.map((e) => e.relativePath)).toContain('compose.yaml');
    expect(inventory.uncapturedInputs).toHaveLength(1);
  });
});
