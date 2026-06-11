import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Mutable state the mocked NodeRegistry reads (same harness as
// filesystem-backup.test.ts) so FileSystemService can be constructed against
// temp directories.
const mockState = { composeDir: '' };

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getComposeDir: () => mockState.composeDir,
      getDefaultNodeId: () => 1,
    }),
  },
}));

import {
  aggregateRollbackOverall,
  buildRollbackItems,
  type RollbackInputs,
} from '../services/updateGuard/readiness';
import type { ContainerProbe } from '../services/updateGuard/types';

const NOW = 1_750_000_000_000;

const baseInputs = (over: Partial<RollbackInputs> = {}): RollbackInputs => ({
  backup: { exists: true, timestamp: NOW - 3_600_000 },
  envSummary: { exists: true, envPresent: true, keys: ['DB_HOST', 'DB_PASS'] },
  stackHasEnv: true,
  rollbackTarget: { target: 'nginx:1.27.1' },
  lastDeployAt: NOW - 3_600_000,
  containers: [{
    name: 'app-web-1', state: 'running', health: 'healthy', exitCode: null,
    hasHealthcheck: true, restartPolicy: 'unless-stopped', mounts: ['volume app_data'],
  }],
  ...over,
});

const itemById = (inputs: RollbackInputs, id: string) =>
  buildRollbackItems(inputs, NOW).find(i => i.id === id)!;

describe('buildRollbackItems', () => {
  it('reports a full set of six items', () => {
    const items = buildRollbackItems(baseInputs(), NOW);
    expect(items.map(i => i.id)).toEqual([
      'compose_source', 'env_keys', 'previous_images', 'last_deploy', 'healthchecks', 'volume_data',
    ]);
  });

  it('marks the volume row not_covered unconditionally and names the mounts', () => {
    const item = itemById(baseInputs(), 'volume_data');
    expect(item.state).toBe('not_covered');
    expect(item.detail).toContain('not included in file backups');
    expect(item.detail).toContain('volume app_data');

    const noMounts = itemById(baseInputs({ containers: [] }), 'volume_data');
    expect(noMounts.state).toBe('not_covered');

    const dockerDown = itemById(baseInputs({ containers: 'error' }), 'volume_data');
    expect(dockerDown.state).toBe('not_covered');
  });

  it('exposes env coverage as names only', () => {
    const item = itemById(baseInputs(), 'env_keys');
    expect(item.state).toBe('ready');
    expect(item.detail).toContain('2 variable names');
    expect(item.detail).not.toContain('DB_HOST');
    expect(item.detail).not.toContain('DB_PASS');
  });

  it('treats a stack without an env file as covered', () => {
    const item = itemById(baseInputs({
      envSummary: { exists: true, envPresent: false, keys: [] },
      stackHasEnv: false,
    }), 'env_keys');
    expect(item.state).toBe('ready');
    expect(item.detail).toContain('no env file');
  });

  it('flags an env file the backup predates', () => {
    const item = itemById(baseInputs({
      envSummary: { exists: true, envPresent: false, keys: [] },
      stackHasEnv: true,
    }), 'env_keys');
    expect(item.state).toBe('missing');
  });

  it('marks the previous image unknown when no rollback target is known', () => {
    expect(itemById(baseInputs({ rollbackTarget: { target: null } }), 'previous_images').state).toBe('unknown');
    expect(itemById(baseInputs({ rollbackTarget: 'error' }), 'previous_images').state).toBe('unknown');
    const known = itemById(baseInputs(), 'previous_images');
    expect(known.state).toBe('ready');
    expect(known.detail).toContain('nginx:1.27.1');
  });

  it('does not mistake an image literally named error for a failed preview', () => {
    const item = itemById(baseInputs({ rollbackTarget: { target: 'error' } }), 'previous_images');
    expect(item.state).toBe('ready');
    expect(item.detail).toContain('error');
  });

  it('reports last deploy and healthcheck coverage', () => {
    expect(itemById(baseInputs(), 'last_deploy').state).toBe('ready');
    expect(itemById(baseInputs({ lastDeployAt: null }), 'last_deploy').state).toBe('missing');
    expect(itemById(baseInputs(), 'healthchecks').state).toBe('ready');
    const none: ContainerProbe[] = [{
      name: 'a', state: 'running', health: null, exitCode: null,
      hasHealthcheck: false, restartPolicy: null, mounts: [],
    }];
    expect(itemById(baseInputs({ containers: none }), 'healthchecks').state).toBe('missing');
  });
});

describe('aggregateRollbackOverall', () => {
  it('is ready when compose, env, and previous image are all covered', () => {
    expect(aggregateRollbackOverall(buildRollbackItems(baseInputs(), NOW))).toBe('ready');
  });

  it('is not_ready without a backup slot', () => {
    const items = buildRollbackItems(baseInputs({
      backup: { exists: false, timestamp: null },
      envSummary: { exists: false, envPresent: false, keys: [] },
    }), NOW);
    expect(aggregateRollbackOverall(items)).toBe('not_ready');
  });

  it('is partial when the previous image tag is unknown', () => {
    const items = buildRollbackItems(baseInputs({ rollbackTarget: { target: null } }), NOW);
    expect(aggregateRollbackOverall(items)).toBe('partial');
  });

  it('is partial when env coverage is missing', () => {
    const items = buildRollbackItems(baseInputs({
      envSummary: { exists: true, envPresent: false, keys: [] },
      stackHasEnv: true,
    }), NOW);
    expect(aggregateRollbackOverall(items)).toBe('partial');
  });

  it('never gates on the volume or healthcheck disclosures', () => {
    const items = buildRollbackItems(baseInputs({ containers: 'error' }), NOW);
    expect(aggregateRollbackOverall(items)).toBe('ready');
  });
});

describe('FileSystemService.getBackupEnvSummary', () => {
  let tmpDir: string;
  let composeDir: string;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-envsum-'));
    composeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-envsum-compose-'));
    mockState.composeDir = composeDir;
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tmpDir;
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(composeDir, { recursive: true, force: true });
  });

  async function getService() {
    const { FileSystemService } = await import('../services/FileSystemService');
    return FileSystemService.getInstance();
  }

  function writeBackupEnv(stackName: string, content: string | null) {
    const dir = path.join(tmpDir, 'backups', '1', stackName);
    fs.mkdirSync(dir, { recursive: true });
    if (content !== null) fs.writeFileSync(path.join(dir, '.env'), content, 'utf-8');
  }

  it('returns key names only, never values', async () => {
    writeBackupEnv('web', 'DB_HOST=db.internal\nDB_PASS=s3cret-value\n# comment\nEMPTY=\n  INDENTED=ok\nnot a var line\n');
    const svc = await getService();
    const summary = await svc.getBackupEnvSummary('web');
    expect(summary).toEqual({
      exists: true,
      envPresent: true,
      keys: ['DB_HOST', 'DB_PASS', 'EMPTY', 'INDENTED'],
    });
    expect(JSON.stringify(summary)).not.toContain('s3cret-value');
    expect(JSON.stringify(summary)).not.toContain('db.internal');
  });

  it('reports a backup without an env file', async () => {
    writeBackupEnv('web', null);
    const svc = await getService();
    expect(await svc.getBackupEnvSummary('web')).toEqual({ exists: true, envPresent: false, keys: [] });
  });

  it('reports a missing backup slot', async () => {
    const svc = await getService();
    expect(await svc.getBackupEnvSummary('web')).toEqual({ exists: false, envPresent: false, keys: [] });
  });

  it('rejects traversal-shaped stack names without touching the filesystem', async () => {
    const svc = await getService();
    expect(await svc.getBackupEnvSummary('../../etc')).toEqual({ exists: false, envPresent: false, keys: [] });
    expect(await svc.getBackupEnvSummary('..')).toEqual({ exists: false, envPresent: false, keys: [] });
  });

  it('propagates a non-ENOENT env read failure instead of reporting "no env in backup"', async () => {
    // An unreadable .env (here: a directory, EISDIR) must throw so callers
    // degrade the item to unknown rather than falsely claiming the backup
    // contains no env file.
    const dir = path.join(tmpDir, 'backups', '1', 'web');
    fs.mkdirSync(path.join(dir, '.env'), { recursive: true });
    const svc = await getService();
    await expect(svc.getBackupEnvSummary('web')).rejects.toThrow();
  });
});
