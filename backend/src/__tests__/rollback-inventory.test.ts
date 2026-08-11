/**
 * Git-backed stacks must not fall back to authored rediscovery when the
 * managed-project manifest is missing or corrupt.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { promises as fsPromises } from 'fs';

const mockGetGitSource = vi.fn();
const mockReadManifest = vi.fn();
const mockGetOverrideFilename = vi.fn().mockResolvedValue(null);
const mockGetStackProjectEnvFiles = vi.fn().mockReturnValue([]);

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

import { resolveRollbackInventory } from '../services/rollbackInventory';

describe('resolveRollbackInventory', () => {
  let composeDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    composeDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-inv-'));
    mockState.composeDir = composeDir;
    mockGetOverrideFilename.mockResolvedValue(null);
    mockGetStackProjectEnvFiles.mockReturnValue([]);
  });

  it('does not fall back to authored rediscovery when a Git source exists but manifest is missing', async () => {
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
      applied_deploy_spec: { files: ['compose.yaml'], contextDir: null },
    });
    mockReadManifest.mockResolvedValue(null);

    const inventory = await resolveRollbackInventory(1, stackName);

    expect(inventory.exactCoverage).toBe(false);
    expect(inventory.coverageRefusal).toMatch(/manifest is missing/i);
    expect(inventory.entries).toEqual([]);
    expect(inventory.git).toEqual(
      expect.objectContaining({
        repoUrl: 'https://example.com/repo.git',
        branch: 'main',
        commitSha: 'abc1234',
      }),
    );
  });

  it('does not fall back to authored rediscovery when the Git manifest is corrupt', async () => {
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

    expect(inventory.exactCoverage).toBe(false);
    expect(inventory.coverageRefusal).toMatch(/unreadable/i);
    expect(inventory.coverageRefusal).toMatch(/identity mismatch/);
    expect(inventory.entries).toEqual([]);
  });
});
