/**
 * When a Git managed-project manifesto is missing or corrupt, inventory falls
 * back to authored rediscovery of the live stack so first apply can still
 * capture a disk preimage before promote.
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

  it('falls back to authored rediscovery when a Git source exists but manifesto is missing', async () => {
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
      last_applied_commit_sha: 'abc1234',
      applied_deploy_spec: null,
    });
    mockReadManifest.mockResolvedValue(null);

    const inventory = await resolveRollbackInventory(1, stackName);

    expect(inventory.exactCoverage).toBe(true);
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.entries.map((e) => e.relativePath)).toContain('compose.yaml');
    expect(inventory.git).toBeNull();
  });

  it('falls back to authored rediscovery when the Git manifesto is corrupt', async () => {
    const stackName = 'corruptgit';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');

    mockGetGitSource.mockReturnValue({
      stack_name: stackName,
      repo_url: 'https://example.com/repo.git',
      branch: 'main',
      last_applied_commit_sha: null,
      applied_deploy_spec: null,
    });
    mockReadManifest.mockResolvedValue({ corrupt: 'identity mismatch' });

    const inventory = await resolveRollbackInventory(1, stackName);

    expect(inventory.exactCoverage).toBe(true);
    expect(inventory.coverageRefusal).toBeNull();
    expect(inventory.entries.map((e) => e.relativePath)).toContain('compose.yaml');
  });
});
