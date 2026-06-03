/**
 * Verifies that FileSystemService stores stack backups under
 * <DATA_DIR>/backups/<nodeId>/<stackName>/ rather than inside the user's compose
 * folder. The old in-stack-folder location failed with EACCES whenever a
 * container had chowned the bind mount, breaking the atomic rollback
 * feature for those stacks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import { promises as fsPromises } from 'fs';

// Mutable state the mocked NodeRegistry reads. Each test rewrites these
// before instantiating FileSystemService.
const mockState = { composeDir: '', composeDirs: new Map<number, string>() };

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getComposeDir: (nodeId?: number) => mockState.composeDirs.get(nodeId ?? 1) ?? mockState.composeDir,
      getDefaultNodeId: () => 1,
    }),
  },
}));

import { FileSystemService } from '../services/FileSystemService';

describe('FileSystemService backup location', () => {
  let composeDir: string;
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    composeDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-compose-'));
    dataDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-data-'));
    mockState.composeDir = composeDir;
    mockState.composeDirs = new Map([[1, composeDir]]);
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    await fsPromises.rm(composeDir, { recursive: true, force: true });
    await fsPromises.rm(dataDir, { recursive: true, force: true });
  });

  it('writes backups under <DATA_DIR>/backups/<nodeId>/<stackName>/, not inside the stack folder', async () => {
    const stackName = 'web';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf-8');
    await fsPromises.writeFile(path.join(stackDir, '.env'), 'FOO=bar\n', 'utf-8');

    const service = FileSystemService.getInstance();
    await service.backupStackFiles(stackName);

    const newBackupDir = path.join(dataDir, 'backups', '1', stackName);
    const oldBackupDir = path.join(stackDir, '.sencho-backup');

    // New location has every backed-up file
    await expect(fsPromises.access(path.join(newBackupDir, 'compose.yaml'))).resolves.toBeUndefined();
    await expect(fsPromises.access(path.join(newBackupDir, '.env'))).resolves.toBeUndefined();
    const ts = await fsPromises.readFile(path.join(newBackupDir, '.timestamp'), 'utf-8');
    expect(parseInt(ts, 10)).toBeGreaterThan(0);

    // Old location must NOT be created
    await expect(fsPromises.access(oldBackupDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('getBackupInfo reads from the new location', async () => {
    const stackName = 'api';
    await fsPromises.mkdir(path.join(composeDir, stackName), { recursive: true });
    await fsPromises.writeFile(path.join(composeDir, stackName, 'compose.yaml'), 'services: {}\n', 'utf-8');

    const service = FileSystemService.getInstance();
    const before = await service.getBackupInfo(stackName);
    expect(before).toEqual({ exists: false, timestamp: null });

    await service.backupStackFiles(stackName);
    const after = await service.getBackupInfo(stackName);
    expect(after.exists).toBe(true);
    expect(typeof after.timestamp).toBe('number');
  });

  it('scopes backups by node id when stack names overlap', async () => {
    const stackName = 'web';
    const secondComposeDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'sencho-compose-'));
    mockState.composeDirs.set(2, secondComposeDir);
    try {
      const nodeOneStackDir = path.join(composeDir, stackName);
      const nodeTwoStackDir = path.join(secondComposeDir, stackName);
      await fsPromises.mkdir(nodeOneStackDir, { recursive: true });
      await fsPromises.mkdir(nodeTwoStackDir, { recursive: true });
      await fsPromises.writeFile(path.join(nodeOneStackDir, 'compose.yaml'), 'services:\n  one: {}\n', 'utf-8');
      await fsPromises.writeFile(path.join(nodeTwoStackDir, 'compose.yaml'), 'services:\n  two: {}\n', 'utf-8');

      await FileSystemService.getInstance(1).backupStackFiles(stackName);
      await FileSystemService.getInstance(2).backupStackFiles(stackName);

      await expect(
        fsPromises.readFile(path.join(dataDir, 'backups', '1', stackName, 'compose.yaml'), 'utf-8'),
      ).resolves.toContain('one');
      await expect(
        fsPromises.readFile(path.join(dataDir, 'backups', '2', stackName, 'compose.yaml'), 'utf-8'),
      ).resolves.toContain('two');
    } finally {
      await fsPromises.rm(secondComposeDir, { recursive: true, force: true });
    }
  });

  it('restoreStackFiles copies files from the new location back to the stack dir', async () => {
    const stackName = 'db';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'version: original\n', 'utf-8');

    const service = FileSystemService.getInstance();
    await service.backupStackFiles(stackName);

    // Mutate the live stack file, then restore
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'version: mutated\n', 'utf-8');
    await service.restoreStackFiles(stackName);

    const restored = await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf-8');
    expect(restored).toBe('version: original\n');
  });

  it('restoreStackFiles removes a managed file the backup does not contain', async () => {
    const stackName = 'noenv';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    // Backup captures a stack that has no .env.
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf-8');

    const service = FileSystemService.getInstance();
    await service.backupStackFiles(stackName);

    // A later deploy adds a .env the backup predates. A faithful revert must
    // remove it so the restored stack is not a hybrid of old + new config.
    await fsPromises.writeFile(path.join(stackDir, '.env'), 'SECRET=added-after-backup\n', 'utf-8');
    await service.restoreStackFiles(stackName);

    await expect(fsPromises.access(path.join(stackDir, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsPromises.access(path.join(stackDir, 'compose.yaml'))).resolves.toBeUndefined();
  });

  it('restoreStackFiles reverts a compose-variant switch', async () => {
    const stackName = 'variant';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: original\n', 'utf-8');

    const service = FileSystemService.getInstance();
    await service.backupStackFiles(stackName);

    // The failed deploy renamed the compose variant: it removed compose.yaml and
    // wrote docker-compose.yml instead. Restore must undo both halves.
    await fsPromises.rm(path.join(stackDir, 'compose.yaml'));
    await fsPromises.writeFile(path.join(stackDir, 'docker-compose.yml'), 'name: broken\n', 'utf-8');
    await service.restoreStackFiles(stackName);

    await expect(fsPromises.access(path.join(stackDir, 'docker-compose.yml'))).rejects.toMatchObject({ code: 'ENOENT' });
    const restored = await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf-8');
    expect(restored).toBe('name: original\n');
  });

  it('does not retain a managed file in the backup slot once the stack drops it', async () => {
    const stackName = 'slot';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: v1\n', 'utf-8');
    await fsPromises.writeFile(path.join(stackDir, '.env'), 'SECRET=v1\n', 'utf-8');

    const service = FileSystemService.getInstance();
    // Backup #1: stack has compose.yaml + .env.
    await service.backupStackFiles(stackName);

    // The stack drops the .env, then is backed up again. The reused slot must
    // not keep the stale .env from backup #1, or a later restore resurrects it.
    await fsPromises.rm(path.join(stackDir, '.env'));
    await service.backupStackFiles(stackName);

    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: mutated\n', 'utf-8');
    await service.restoreStackFiles(stackName);

    await expect(fsPromises.access(path.join(stackDir, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    const restored = await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf-8');
    expect(restored).toBe('name: v1\n');
  });

  it('restoreStackFiles removes multiple orphans in one restore', async () => {
    const stackName = 'multi';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: original\n', 'utf-8');

    const service = FileSystemService.getInstance();
    await service.backupStackFiles(stackName);

    // The failed deploy switched the compose variant AND added a .env at once.
    await fsPromises.rm(path.join(stackDir, 'compose.yaml'));
    await fsPromises.writeFile(path.join(stackDir, 'docker-compose.yml'), 'name: broken\n', 'utf-8');
    await fsPromises.writeFile(path.join(stackDir, '.env'), 'SECRET=x\n', 'utf-8');
    await service.restoreStackFiles(stackName);

    await expect(fsPromises.access(path.join(stackDir, 'docker-compose.yml'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsPromises.access(path.join(stackDir, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    const restored = await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf-8');
    expect(restored).toBe('name: original\n');
  });

  it('restoreStackFiles aborts instead of leaving a hybrid when an orphan cannot be removed', async () => {
    const stackName = 'blocked';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: original\n', 'utf-8');

    const service = FileSystemService.getInstance();
    await service.backupStackFiles(stackName);

    // An orphan managed name that is a directory: unlink fails with a non-ENOENT
    // code (EPERM/EISDIR), standing in for the EACCES/EBUSY cases on a real
    // chowned bind mount. The restore must reject rather than report success
    // with a stale file still present.
    await fsPromises.mkdir(path.join(stackDir, 'docker-compose.yml'));
    await expect(service.restoreStackFiles(stackName)).rejects.toThrow(/Rollback aborted/i);
  });

  it('restoreStackFiles leaves non-managed files untouched', async () => {
    const stackName = 'userdata';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf-8');

    const service = FileSystemService.getInstance();
    await service.backupStackFiles(stackName);

    // A file Sencho does not manage (user notes, mounted config) must survive a
    // rollback: the cleanup is scoped to the protected compose/.env set only.
    await fsPromises.writeFile(path.join(stackDir, 'notes.txt'), 'keep me\n', 'utf-8');
    await service.restoreStackFiles(stackName);

    const kept = await fsPromises.readFile(path.join(stackDir, 'notes.txt'), 'utf-8');
    expect(kept).toBe('keep me\n');
  });
});
