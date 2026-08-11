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

    expect(inventory.exactCoverage).toBe(true);
    expect(inventory.coverageRefusal).toBeNull();
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

    expect(inventory.exactCoverage).toBe(false);
    expect(inventory.coverageRefusal).toMatch(/missing/i);
    expect(inventory.git?.commitSha).toBe('abc1234');
  });

  it('rebuilds exact coverage from applied_deploy_spec when manifesto is missing', async () => {
    const stackName = 'rebuild';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services:\n  a: {}\n', 'utf8');
    await fsPromises.writeFile(path.join(stackDir, 'compose.prod.yaml'), 'services:\n  b: {}\n', 'utf8');

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

    expect(inventory.exactCoverage).toBe(true);
    expect(inventory.git?.commitSha).toBe('deadbeef');
    expect(inventory.entries.map((e) => e.relativePath).sort()).toEqual([
      'compose.prod.yaml',
      'compose.yaml',
    ]);
    expect(inventory.invocation.explicitComposeFiles).toEqual(['compose.yaml', 'compose.prod.yaml']);
  });

  it('rebuilds from applied_deploy_spec when the manifesto is corrupt but files remain exact', async () => {
    const stackName = 'corruptgit';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf8');

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

    expect(inventory.exactCoverage).toBe(true);
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

    expect(inventory.exactCoverage).toBe(false);
    expect(inventory.coverageRefusal).toMatch(/unreadable/i);
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

    expect(inventory.exactCoverage).toBe(false);
    expect(inventory.coverageRefusal).toMatch(/unreadable/i);
  });
});
