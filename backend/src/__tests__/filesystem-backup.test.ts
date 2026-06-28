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
import { createHash } from 'crypto';

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

vi.mock('../utils/debug', () => ({
  isDebugEnabled: () => false,
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

  it('aborts backup creation when a destination write fails', async () => {
    const stackName = 'writefail';
    const stackDir = path.join(composeDir, stackName);
    const backupCompose = path.join(dataDir, 'backups', '1', stackName, 'compose.yaml');
    await fsPromises.mkdir(stackDir, { recursive: true });
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n', 'utf-8');

    const realWriteFile = fsPromises.writeFile.bind(fsPromises);
    const writeSpy = vi.spyOn(fsPromises, 'writeFile').mockImplementation(async (file, data, options) => {
      if (path.normalize(String(file)) === path.normalize(backupCompose)) {
        throw new Error('disk full');
      }
      return realWriteFile(file, data, options);
    });
    try {
      await expect(FileSystemService.getInstance().backupStackFiles(stackName)).rejects.toThrow(/Could not write backup compose.yaml/);
      await expect(fsPromises.access(backupCompose)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      writeSpy.mockRestore();
    }
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

  it('snapshotStackFiles reverts a restore so a policy-blocked rollback leaves current files in place', async () => {
    const stackName = 'revert';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    // The rollback target (older config) is captured into the backup slot.
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: old\n', 'utf-8');

    const service = FileSystemService.getInstance();
    await service.backupStackFiles(stackName);

    // The current in-use config differs from the backup and adds a managed file
    // (.env) the backup does not have.
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: current\n', 'utf-8');
    await fsPromises.writeFile(path.join(stackDir, '.env'), 'TOKEN=current\n', 'utf-8');

    // Snapshot current, then restore the backup, mirroring the rollback route.
    const revert = await service.snapshotStackFiles(stackName);
    await service.restoreStackFiles(stackName);
    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf-8')).toBe('name: old\n');
    await expect(fsPromises.access(path.join(stackDir, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });

    // The policy gate blocks the restored target: revert must put the current
    // files back exactly (content restored, the removed .env recreated).
    await revert();
    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf-8')).toBe('name: current\n');
    expect(await fsPromises.readFile(path.join(stackDir, '.env'), 'utf-8')).toBe('TOKEN=current\n');
  });

  it('snapshotStackFiles revert removes a managed file the snapshot did not have', async () => {
    const stackName = 'revert-orphan';
    const stackDir = path.join(composeDir, stackName);
    await fsPromises.mkdir(stackDir, { recursive: true });
    // Backup target has compose + .env; current has only compose.
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: target\n', 'utf-8');
    await fsPromises.writeFile(path.join(stackDir, '.env'), 'TOKEN=target\n', 'utf-8');

    const service = FileSystemService.getInstance();
    await service.backupStackFiles(stackName);

    await fsPromises.rm(path.join(stackDir, '.env'));
    await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: current\n', 'utf-8');

    const revert = await service.snapshotStackFiles(stackName);
    await service.restoreStackFiles(stackName); // brings back the .env from the backup
    await expect(fsPromises.access(path.join(stackDir, '.env'))).resolves.toBeUndefined();

    await revert();
    // The current state had no .env, so revert must remove the restored one.
    await expect(fsPromises.access(path.join(stackDir, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf-8')).toBe('name: current\n');
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

  // Integrity guard: a backup carries a .checksums manifest, and a restore
  // verifies each backed-up file against it before touching the live stack, so a
  // truncated or corrupted backup is rejected with a clear error instead of being
  // copied back silently. These reuse the outer mkdtemp/DATA_DIR harness.
  describe('backup integrity checksum', () => {
    // Independent oracle for the manifest hashes. Production hashes the raw file
    // Buffer; for the UTF-8 text fixtures used here that yields the same digest as
    // hashing Buffer.from(s, 'utf-8').
    const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf-8')).digest('hex');

    it('writes a .checksums manifest with the SHA-256 of each backed-up file', async () => {
      const stackName = 'sums';
      const stackDir = path.join(composeDir, stackName);
      await fsPromises.mkdir(stackDir, { recursive: true });
      const composeBody = 'services:\n  web: {}\n';
      const envBody = 'FOO=bar\n';
      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), composeBody, 'utf-8');
      await fsPromises.writeFile(path.join(stackDir, '.env'), envBody, 'utf-8');

      await FileSystemService.getInstance().backupStackFiles(stackName);

      const backupDir = path.join(dataDir, 'backups', '1', stackName);
      const manifest = JSON.parse(await fsPromises.readFile(path.join(backupDir, '.checksums'), 'utf-8'));
      expect(manifest['compose.yaml']).toBe(sha(composeBody));
      expect(manifest['.env']).toBe(sha(envBody));
    });

    it('aborts the restore and leaves the live file unchanged when a backed-up file is corrupt', async () => {
      const stackName = 'corrupt';
      const stackDir = path.join(composeDir, stackName);
      await fsPromises.mkdir(stackDir, { recursive: true });
      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: good\n', 'utf-8');

      const service = FileSystemService.getInstance();
      await service.backupStackFiles(stackName);

      // Corrupt the backed-up copy on disk (truncation or bit-rot after a clean backup).
      const backupDir = path.join(dataDir, 'backups', '1', stackName);
      await fsPromises.writeFile(path.join(backupDir, 'compose.yaml'), 'name: go', 'utf-8');

      // The live file is the post-deploy state a rollback would revert.
      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: current\n', 'utf-8');

      await expect(service.restoreStackFiles(stackName)).rejects.toThrow(/integrity|corrupt/i);

      // The live file must be untouched, not overwritten with the corrupt bytes.
      expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf-8')).toBe('name: current\n');
      // The manifest marker must never leak into the stack directory.
      await expect(fsPromises.access(path.join(stackDir, '.checksums'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('verifies before removing orphans, so a corrupt backup mutates nothing', async () => {
      const stackName = 'atomic';
      const stackDir = path.join(composeDir, stackName);
      await fsPromises.mkdir(stackDir, { recursive: true });
      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: good\n', 'utf-8');

      const service = FileSystemService.getInstance();
      await service.backupStackFiles(stackName); // backup has compose.yaml, no .env

      const backupDir = path.join(dataDir, 'backups', '1', stackName);
      await fsPromises.writeFile(path.join(backupDir, 'compose.yaml'), 'trunc', 'utf-8');

      // A post-backup deploy added a .env: a faithful restore would remove it as an
      // orphan. The integrity check must run first, so the corrupt backup leaves both
      // the orphan and the live compose exactly as they are.
      await fsPromises.writeFile(path.join(stackDir, '.env'), 'SECRET=x\n', 'utf-8');
      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: current\n', 'utf-8');

      await expect(service.restoreStackFiles(stackName)).rejects.toThrow(/integrity|corrupt/i);

      expect(await fsPromises.readFile(path.join(stackDir, '.env'), 'utf-8')).toBe('SECRET=x\n');
      expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf-8')).toBe('name: current\n');
    });

    it('restores faithfully when no .checksums manifest exists (pre-feature backup)', async () => {
      const stackName = 'legacy';
      const stackDir = path.join(composeDir, stackName);
      await fsPromises.mkdir(stackDir, { recursive: true });
      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: original\n', 'utf-8');

      const service = FileSystemService.getInstance();
      await service.backupStackFiles(stackName);

      // A backup taken before the integrity feature existed has no manifest.
      const backupDir = path.join(dataDir, 'backups', '1', stackName);
      await fsPromises.rm(path.join(backupDir, '.checksums'));

      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: mutated\n', 'utf-8');
      await service.restoreStackFiles(stackName);

      expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf-8')).toBe('name: original\n');
    });

    it('restores faithfully when the manifest is unparseable (degrades to no verification)', async () => {
      const stackName = 'garbled';
      const stackDir = path.join(composeDir, stackName);
      await fsPromises.mkdir(stackDir, { recursive: true });
      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: original\n', 'utf-8');

      const service = FileSystemService.getInstance();
      const backupDir = path.join(dataDir, 'backups', '1', stackName);

      // Both garbage JSON and an empty file are unparseable; neither proves the
      // data files are bad, so a needed rollback must still proceed.
      for (const garbage of ['not json', '']) {
        await service.backupStackFiles(stackName);
        await fsPromises.writeFile(path.join(backupDir, '.checksums'), garbage, 'utf-8');
        await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: mutated\n', 'utf-8');
        await service.restoreStackFiles(stackName);
        expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf-8')).toBe('name: original\n');
      }
    });

    it('copies a backup file that has no checksum entry without verifying it', async () => {
      const stackName = 'partial';
      const stackDir = path.join(composeDir, stackName);
      await fsPromises.mkdir(stackDir, { recursive: true });
      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: original\n', 'utf-8');

      const service = FileSystemService.getInstance();
      await service.backupStackFiles(stackName); // manifest records compose.yaml only

      // A managed file present in the backup slot but absent from the manifest
      // (e.g. its read failed during backup, so it was never recorded). It must
      // still be restored: the check is never stricter than what was recorded.
      const backupDir = path.join(dataDir, 'backups', '1', stackName);
      await fsPromises.writeFile(path.join(backupDir, '.env'), 'TOKEN=restored\n', 'utf-8');

      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: mutated\n', 'utf-8');
      await service.restoreStackFiles(stackName);

      expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf-8')).toBe('name: original\n');
      expect(await fsPromises.readFile(path.join(stackDir, '.env'), 'utf-8')).toBe('TOKEN=restored\n');
    });

    it('aborts the restore when the backed-up .env is corrupt, leaving the live .env intact', async () => {
      const stackName = 'envcorrupt';
      const stackDir = path.join(composeDir, stackName);
      await fsPromises.mkdir(stackDir, { recursive: true });
      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: good\n', 'utf-8');
      await fsPromises.writeFile(path.join(stackDir, '.env'), 'TOKEN=good\n', 'utf-8');

      const service = FileSystemService.getInstance();
      await service.backupStackFiles(stackName); // manifest covers compose.yaml and .env

      // Corrupt only the backed-up .env; compose.yaml stays valid. The .env's own
      // manifest entry must be checked, so the restore aborts on it.
      const backupDir = path.join(dataDir, 'backups', '1', stackName);
      await fsPromises.writeFile(path.join(backupDir, '.env'), 'TOKEN=go', 'utf-8');

      await fsPromises.writeFile(path.join(stackDir, '.env'), 'TOKEN=current\n', 'utf-8');
      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: current\n', 'utf-8');

      await expect(service.restoreStackFiles(stackName)).rejects.toThrow(/integrity|corrupt/i);

      // The abort must touch nothing: the live .env keeps its current contents, and
      // the valid-but-unrestored compose.yaml is left as-is rather than reverted to
      // the backup, proving the .env mismatch halts before any file is copied back.
      expect(await fsPromises.readFile(path.join(stackDir, '.env'), 'utf-8')).toBe('TOKEN=current\n');
      expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf-8')).toBe('name: current\n');
    });

    it('restores faithfully when a manifest entry is not a string (degrades to unverified)', async () => {
      const stackName = 'nonstring';
      const stackDir = path.join(composeDir, stackName);
      await fsPromises.mkdir(stackDir, { recursive: true });
      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: original\n', 'utf-8');

      const service = FileSystemService.getInstance();
      await service.backupStackFiles(stackName);

      // A parseable manifest whose value is not a hex string (tampered or
      // wrong-typed) must not block a rollback whose data files are intact: a
      // manifest problem is not proof the backup is corrupt.
      const backupDir = path.join(dataDir, 'backups', '1', stackName);
      await fsPromises.writeFile(path.join(backupDir, '.checksums'), JSON.stringify({ 'compose.yaml': 123 }), 'utf-8');

      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: mutated\n', 'utf-8');
      await service.restoreStackFiles(stackName);

      expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf-8')).toBe('name: original\n');
    });

    it('aborts the restore when a manifest-recorded file is missing from the backup, leaving the live file unchanged', async () => {
      const stackName = 'missingmember';
      const stackDir = path.join(composeDir, stackName);
      await fsPromises.mkdir(stackDir, { recursive: true });
      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: backed-up\n', 'utf-8');

      const service = FileSystemService.getInstance();
      await service.backupStackFiles(stackName); // manifest records compose.yaml

      // The backed-up compose.yaml is lost after the manifest was written, but the
      // manifest still names it. An items-only scan would not notice; the orphan
      // removal would then delete the live compose.yaml and the copy would restore
      // nothing, leaving the stack unrecoverable. The integrity check must catch
      // the missing member first.
      const backupDir = path.join(dataDir, 'backups', '1', stackName);
      await fsPromises.rm(path.join(backupDir, 'compose.yaml'));

      // The live file is the post-deploy state a rollback would revert.
      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: current\n', 'utf-8');

      await expect(service.restoreStackFiles(stackName)).rejects.toThrow(/missing/i);

      // The live compose.yaml must survive: not deleted as an orphan, not truncated.
      expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf-8')).toBe('name: current\n');
    });

    it('aborts on a missing recorded file even when its checksum entry is malformed', async () => {
      const stackName = 'missingnonstring';
      const stackDir = path.join(composeDir, stackName);
      await fsPromises.mkdir(stackDir, { recursive: true });
      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: backed-up\n', 'utf-8');

      const service = FileSystemService.getInstance();
      await service.backupStackFiles(stackName);

      // The manifest still names compose.yaml but with a non-string value, and the
      // backed-up copy is gone. The missing-file check must fire before the
      // value-type skip, otherwise the orphan removal would delete the live
      // compose.yaml and restore nothing.
      const backupDir = path.join(dataDir, 'backups', '1', stackName);
      await fsPromises.writeFile(path.join(backupDir, '.checksums'), JSON.stringify({ 'compose.yaml': 123 }), 'utf-8');
      await fsPromises.rm(path.join(backupDir, 'compose.yaml'));

      await fsPromises.writeFile(path.join(stackDir, 'compose.yaml'), 'name: current\n', 'utf-8');

      await expect(service.restoreStackFiles(stackName)).rejects.toThrow(/missing/i);
      expect(await fsPromises.readFile(path.join(stackDir, 'compose.yaml'), 'utf-8')).toBe('name: current\n');
    });

    it('fails the backup when a managed file exists but cannot be read', async () => {
      const stackName = 'readfail';
      const stackDir = path.join(composeDir, stackName);
      await fsPromises.mkdir(stackDir, { recursive: true });
      const composeSrc = path.join(stackDir, 'compose.yaml');
      await fsPromises.writeFile(composeSrc, 'name: present\n', 'utf-8');

      // The compose file exists but the read fails (e.g. EACCES on a chowned bind
      // mount). Silently skipping it would yield a "successful" backup that omits a
      // live managed file, so a later rollback would delete it as an orphan.
      const realReadFile = fsPromises.readFile.bind(fsPromises);
      const readSpy = vi.spyOn(fsPromises, 'readFile').mockImplementation((file, options) => {
        if (path.normalize(String(file)) === path.normalize(composeSrc)) {
          return Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
        }
        return realReadFile(file as Parameters<typeof realReadFile>[0], options);
      });
      try {
        await expect(FileSystemService.getInstance().backupStackFiles(stackName))
          .rejects.toThrow(/Could not read compose.yaml for backup/);
      } finally {
        readSpy.mockRestore();
      }
    });
  });
});
