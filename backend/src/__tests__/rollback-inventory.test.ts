/**
 * Git manifesto inventory: first-apply merge vs established fail-closed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { promises as fsPromises } from 'fs';

const mockGetGitSource = vi.fn();
const mockReadManifest = vi.fn();
const mockGetOverrideFilename = vi.fn().mockResolvedValue(null);
const mockGetStackProjectEnvFiles = vi.fn().mockReturnValue([]);
const mockBuildAuthoredComposeArgs = vi.fn().mockResolvedValue(['compose', '-f', 'compose.yaml', 'config', '--quiet']);
const mockAuthoredComposeFileArgs = vi.fn().mockReturnValue(['-f', 'compose.yaml']);
const mockAuthoredComposeEnvFileArgs = vi.fn().mockResolvedValue([]);

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
      getOverrideFilename: mockGetOverrideFilename,
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
}));

import { resolveRollbackInventory } from '../services/rollbackInventory';

describe('resolveRollbackInventory', () => {
  let composeDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    composeDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-inv-'));
    mockState.composeDir = composeDir;
    mockGetOverrideFilename.mockResolvedValue(null);
    mockGetStackProjectEnvFiles.mockReturnValue([]);
    mockBuildAuthoredComposeArgs.mockResolvedValue(['compose', '-f', 'compose.yaml', 'config', '--quiet']);
    mockAuthoredComposeFileArgs.mockReturnValue(['-f', 'compose.yaml']);
    mockAuthoredComposeEnvFileArgs.mockResolvedValue([]);
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

    // Force discovery to see both via include parse would be heavy; instead seed
    // by making them both compose roots is impossible. Use override + compose:
    mockGetOverrideFilename.mockResolvedValue('App.conf');
    // Also plant app.conf as project env so both enter the map.
    mockGetStackProjectEnvFiles.mockReturnValue(['app.conf']);

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
    mockGetOverrideFilename.mockResolvedValue(null);
    mockGetStackProjectEnvFiles.mockReturnValue([]);
    mockAuthoredComposeFileArgs.mockReturnValue(['-f', 'compose.yaml']);
    mockAuthoredComposeEnvFileArgs.mockResolvedValue([]);
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

  it('refuses a dangling compose file and a dangling override file', async () => {
    await fsPromises.symlink(path.join(composeDir, 'shared-common', 'gone.yaml'), path.join(stackDir, 'compose.yaml'));

    const dangling = await resolveRollbackInventory(1, STACK);
    expect(dangling.coverageRefusal).toBe('Compose file compose.yaml is a link to a missing file');

    await fsPromises.rm(path.join(stackDir, 'compose.yaml'));
    await writeCompose('services: {}\n');
    await fsPromises.symlink(path.join(composeDir, 'shared-common', 'gone.yaml'), path.join(stackDir, 'compose.override.yaml'));
    mockGetOverrideFilename.mockResolvedValue('compose.override.yaml');

    const override = await resolveRollbackInventory(1, STACK);
    expect(override.coverageRefusal).toBe('Compose file compose.override.yaml is a link to a missing file');
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
