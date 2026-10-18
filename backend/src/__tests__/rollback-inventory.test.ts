/**
 * Git manifesto inventory: first-apply merge vs established fail-closed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { promises as fsPromises } from 'fs';

const mockGetGitSource = vi.fn();
const mockReadManifest = vi.fn();
const mockGetStackProjectEnvFiles = vi.fn().mockReturnValue([]);
const mockBuildAuthoredComposeArgs = vi.fn().mockResolvedValue(['compose', '-f', 'compose.yaml', 'config', '--quiet']);
const mockAuthoredComposeFileArgs = vi.fn().mockReturnValue(['-f', 'compose.yaml']);
const mockAuthoredComposeEnvFileArgs = vi.fn().mockResolvedValue([]);
const mockComposeFileEnvVarSelection = vi.fn().mockResolvedValue({ kind: 'absent' });

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

import { resolveRollbackInventory } from '../services/rollbackInventory';

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
    mockComposeFileEnvVarSelection.mockResolvedValue({ kind: 'absent' });
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
    mockComposeFileEnvVarSelection.mockResolvedValue({ kind: 'absent' });
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

  it('pins the layer chain COMPOSE_FILE selects', async () => {
    // The captured root declares prod.yaml, so the generation holds it.
    await write('compose.yaml', 'include:\n  - ./prod.yaml\nservices:\n  web:\n    image: nginx\n');
    await write('prod.yaml', 'services:\n  web:\n    command: ["false"]\n');
    mockComposeFileEnvVarSelection.mockResolvedValue({ kind: 'value', value: 'compose.yaml:prod.yaml', pathSeparator: ':' });

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
    mockComposeFileEnvVarSelection.mockResolvedValue({ kind: 'value', value: 'compose.yaml:prod.yaml', pathSeparator: ':' });

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
    mockComposeFileEnvVarSelection.mockResolvedValue({ kind: 'value', value: `compose.yaml:${value}`, pathSeparator: ':' });

    const inventory = await resolveRollbackInventory(1, STACK);

    // The recovery run always appends a recovery layer, which suppresses
    // discovery and with it COMPOSE_FILE, so a chain that cannot be pinned
    // would run a project the generation never held.
    expect(inventory.coverageRefusal).toMatch(/COMPOSE_FILE/);
    expect(inventory.invocation.composeLayers).toEqual(['compose.yaml']);
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
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.composeLayers).toEqual(['compose.yaml', 'prod']);
  });

  it('refuses a chain entry that still holds a variable', async () => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    mockComposeFileEnvVarSelection.mockResolvedValue({
      kind: 'value',
      value: 'compose.yaml:${CHAIN_LAYER}',
      pathSeparator: ':',
    });

    const inventory = await resolveRollbackInventory(1, STACK);

    // Reading the substitution here would pin whatever it happens to hold today,
    // so refuse instead of guessing.
    expect(inventory.coverageRefusal).toMatch(/unresolved variable/);
  });

  it.each([
  ['a multi-character separator', '::', 'compose.yaml::prod'],
  ['an empty separator falling back to the default', '', 'compose.yaml:prod'],
])('accepts %s', async (_label, pathSeparator, value) => {
  await write('compose.yaml', 'include:\n  - ./prod\nservices:\n  web:\n    image: nginx\n');
  await write('prod', 'services:\n  web:\n    command: ["false"]\n');
  mockComposeFileEnvVarSelection.mockResolvedValue({ kind: 'value', value, pathSeparator });

  const inventory = await resolveRollbackInventory(1, STACK);

  expect(inventory.coverageRefusal).toBeNull();
  expect(inventory.invocation.composeLayers).toEqual(['compose.yaml', 'prod']);
});

it('records a COMPOSE_FILE layer that links outside the stack as not captured', async () => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await fsPromises.mkdir(path.join(composeDir, 'shared'), { recursive: true });
    await fsPromises.writeFile(path.join(composeDir, 'shared', 'prod.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.symlink(path.join(composeDir, 'shared', 'prod.yaml'), path.join(composeDir, STACK, 'prod.yaml'));
    mockComposeFileEnvVarSelection.mockResolvedValue({ kind: 'value', value: 'compose.yaml:prod.yaml', pathSeparator: ':' });

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
    mockComposeFileEnvVarSelection.mockResolvedValue({ kind: 'unknown' });

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toMatch(/COMPOSE_FILE/);
  });

  it('leaves COMPOSE_FILE alone when the captured prefix already pins files', async () => {
    await write('compose.yaml', 'services:\n  web:\n    image: nginx\n');
    await write('prod.yaml', 'services:\n  web:\n    command: ["false"]\n');
    mockAuthoredComposeFileArgs.mockReturnValue(['-f', 'compose.yaml', '-f', 'prod.yaml', '-p', 'layers']);
    mockComposeFileEnvVarSelection.mockResolvedValue({ kind: 'value', value: 'compose.yaml:prod.yaml', pathSeparator: ':' });

    const inventory = await resolveRollbackInventory(1, STACK);

    // Compose ignores the variable once -f is given, so there is nothing to
    // reconcile and nothing that could fail.
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.invocation.composeLayers).toEqual(['compose.yaml']);
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
    mockComposeFileEnvVarSelection.mockResolvedValue({ kind: 'absent' });
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

  it('excludes a managed file that links outside the stack without writing a tombstone', async () => {
    await writeCompose('services:\n  web:\n    image: nginx\n');
    await fsPromises.writeFile(path.join(composeDir, 'shared-common', 'shared.env'), 'A=1\n', 'utf8');
    await fsPromises.symlink(path.join(composeDir, 'shared-common', 'shared.env'), path.join(stackDir, '.env'));

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.entries.map((e) => e.relativePath)).toEqual(['compose.yaml']);
    expect(inventory.uncapturedRelativePaths).toEqual(['.env']);
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
      'config/app.env links outside the stack directory and is not captured',
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

  it('keeps an application-data link out of the notes but protects its path from restore', async () => {
    await writeCompose('services:\n  web:\n    image: nginx\n    volumes:\n      - ./data:/data\n');
    await fsPromises.mkdir(path.join(composeDir, 'shared-common', 'data'));
    await fsPromises.symlink(path.join(composeDir, 'shared-common', 'data'), path.join(stackDir, 'data'));

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.uncapturedInputs).toEqual([]);
    expect(inventory.uncapturedRelativePaths).toEqual(['data']);
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

  it('refuses a compose file that links outside the stack and points at include', async () => {
    await fsPromises.writeFile(path.join(composeDir, 'shared-common', 'base.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.symlink(path.join(composeDir, 'shared-common', 'base.yaml'), path.join(stackDir, 'compose.yaml'));
    await fsPromises.symlink(path.join(composeDir, 'shared-common', 'gone.env'), path.join(stackDir, '.env'));

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toBe(
      'Compose file compose.yaml links outside the stack directory. Use include: to share a file between stacks',
    );
    expect(inventory.uncapturedInputs).toEqual([]);
    expect(inventory.uncapturedRelativePaths).toEqual([]);
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

  it('refuses an override file that links outside the stack', async () => {
    await fsPromises.writeFile(path.join(composeDir, 'shared-common', 'base.yaml'), 'services: {}\n', 'utf8');
    await writeCompose('services: {}\n');
    await fsPromises.symlink(path.join(composeDir, 'shared-common', 'base.yaml'), path.join(stackDir, 'compose.override.yml'));

    const inventory = await resolveRollbackInventory(1, STACK);
    expect(inventory.coverageRefusal).toBe(
      'Compose file compose.override.yml links outside the stack directory. Use include: to share a file between stacks',
    );
  });

  it('refuses a stack directory that links to another location, like the compose file guard', async () => {
    const elsewhere = path.join(composeDir, 'elsewhere');
    await fsPromises.mkdir(elsewhere);
    await fsPromises.writeFile(path.join(elsewhere, 'compose.yaml'), 'services: {}\n', 'utf8');
    await fsPromises.rm(stackDir, { recursive: true, force: true });
    await fsPromises.symlink(elsewhere, stackDir);

    const inventory = await resolveRollbackInventory(1, STACK);

    expect(inventory.coverageRefusal).toMatch(/^Compose file compose\.yaml links outside the stack directory/);
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
