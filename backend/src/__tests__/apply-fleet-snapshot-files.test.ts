import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyFleetSnapshotFiles, fleetSnapshotApplyConflictCode, selectFleetSnapshotApplyFiles, type FleetSnapshotApplyFile } from '../helpers/applyFleetSnapshotFiles';
import { DatabaseService } from '../services/DatabaseService';
import { StackOpLockService } from '../services/StackOpLockService';

const mocks = vi.hoisted(() => ({
  hasComposeFile: vi.fn(),
  ensureStackDir: vi.fn(),
  deleteStack: vi.fn(),
  saveStackContent: vi.fn(),
  saveEnvContent: vi.fn(),
  getBaseDir: vi.fn(() => '/tmp/compose'),
  captureCurrentBackup: vi.fn(),
  invalidateNodeCaches: vi.fn(),
}));

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: () => ({
      getBaseDir: mocks.getBaseDir,
      hasComposeFile: mocks.hasComposeFile,
      ensureStackDir: mocks.ensureStackDir,
      deleteStack: mocks.deleteStack,
      saveStackContent: mocks.saveStackContent,
      saveEnvContent: mocks.saveEnvContent,
    }),
  },
}));

vi.mock('../helpers/cacheInvalidation', () => ({
  invalidateNodeCaches: mocks.invalidateNodeCaches,
}));

vi.mock('../services/StackUpdateRecoveryService', () => ({
  StackUpdateRecoveryService: {
    getInstance: () => ({
      captureCurrentBackup: mocks.captureCurrentBackup,
    }),
  },
}));

const FILES: FleetSnapshotApplyFile[] = [
  { filename: 'compose.yaml', content: 'services:\n  snap: {}\n' },
  { filename: '.env', content: 'SNAP=1\n' },
];

function applyWeb(overrides: Partial<{
  stackName: string;
  files: FleetSnapshotApplyFile[];
  actor: string;
}> = {}) {
  return applyFleetSnapshotFiles({
    nodeId: 1,
    stackName: 'web',
    files: FILES,
    actor: 'system:fleet-snapshot',
    ...overrides,
  });
}

describe('applyFleetSnapshotFiles', () => {
  beforeEach(() => {
    StackOpLockService.resetForTests();
    mocks.hasComposeFile.mockReset().mockResolvedValue(true);
    mocks.ensureStackDir.mockReset().mockResolvedValue(true);
    mocks.deleteStack.mockReset().mockResolvedValue(undefined);
    mocks.saveStackContent.mockReset().mockResolvedValue(undefined);
    mocks.saveEnvContent.mockReset().mockResolvedValue(undefined);
    mocks.captureCurrentBackup.mockReset().mockResolvedValue({ id: 'gen-pre' });
    mocks.invalidateNodeCaches.mockReset();
  });

  afterEach(() => {
    StackOpLockService.resetForTests();
  });

  it('captures a recovery generation before writing when the stack already exists', async () => {
    const order: string[] = [];
    mocks.captureCurrentBackup.mockImplementation(async () => {
      order.push('capture');
      return { id: 'gen-pre' };
    });
    mocks.saveStackContent.mockImplementation(async () => {
      order.push('compose');
    });
    mocks.saveEnvContent.mockImplementation(async () => {
      order.push('env');
    });

    const result = await applyWeb();

    expect(result.capturedGenerationId).toBe('gen-pre');
    expect(order).toEqual(['capture', 'compose', 'env']);
    expect(mocks.ensureStackDir).not.toHaveBeenCalled();
    expect(mocks.invalidateNodeCaches).toHaveBeenCalledWith(1);
    expect(mocks.captureCurrentBackup).toHaveBeenCalledWith({
      nodeId: 1,
      stackName: 'web',
      createdBy: 'system:fleet-snapshot',
    });
  });

  it('skips capture for a new stack with no compose file', async () => {
    mocks.hasComposeFile.mockResolvedValue(false);

    const result = await applyWeb({ stackName: 'fresh' });

    expect(result.capturedGenerationId).toBeNull();
    expect(mocks.captureCurrentBackup).not.toHaveBeenCalled();
    expect(mocks.ensureStackDir).toHaveBeenCalledWith('fresh');
    expect(mocks.saveStackContent).toHaveBeenCalledWith('fresh', FILES[0].content);
    expect(mocks.saveEnvContent).toHaveBeenCalledWith('fresh', FILES[1].content);
  });

  it('creates the missing stack directory before the first snapshot file is written', async () => {
    const order: string[] = [];
    mocks.hasComposeFile.mockResolvedValue(false);
    mocks.ensureStackDir.mockImplementation(async () => {
      order.push('mkdir');
      return true;
    });
    mocks.saveStackContent.mockImplementation(async () => {
      order.push('compose');
    });
    mocks.saveEnvContent.mockImplementation(async () => {
      order.push('env');
    });

    const result = await applyWeb({ stackName: 'restored-on-fresh-instance' });

    expect(result.capturedGenerationId).toBeNull();
    expect(order).toEqual(['mkdir', 'compose', 'env']);
  });

  it('refuses an absent stack whose snapshot has no compose.yaml, before creating a directory', async () => {
    mocks.hasComposeFile.mockResolvedValue(false);

    await expect(applyWeb({ stackName: 'env-only', files: [FILES[1]] }))
      .rejects.toMatchObject({ code: 'snapshot_compose_missing' });

    expect(mocks.ensureStackDir).not.toHaveBeenCalled();
    expect(mocks.saveEnvContent).not.toHaveBeenCalled();
    expect(mocks.saveStackContent).not.toHaveBeenCalled();
    expect(mocks.invalidateNodeCaches).not.toHaveBeenCalled();
  });

  it('refuses a compose-less existing directory the same way and leaves it alone', async () => {
    mocks.hasComposeFile.mockResolvedValue(false);

    await expect(applyWeb({ stackName: 'leftover', files: [FILES[1]] }))
      .rejects.toMatchObject({ code: 'snapshot_compose_missing' });

    expect(mocks.ensureStackDir).not.toHaveBeenCalled();
    expect(mocks.saveEnvContent).not.toHaveBeenCalled();
    expect(mocks.deleteStack).not.toHaveBeenCalled();
  });

  it('still restores an existing stack from an env-only snapshot', async () => {
    const result = await applyWeb({ files: [FILES[1]] });

    expect(result.capturedGenerationId).toBe('gen-pre');
    expect(mocks.saveEnvContent).toHaveBeenCalledWith('web', FILES[1].content);
    expect(mocks.deleteStack).not.toHaveBeenCalled();
  });

  it('removes the directory it created when a later file write fails', async () => {
    mocks.hasComposeFile.mockResolvedValue(false);
    mocks.saveEnvContent.mockRejectedValue(new Error('disk full'));

    await expect(applyWeb({ stackName: 'half-written' })).rejects.toThrow('disk full');

    expect(mocks.deleteStack).toHaveBeenCalledWith('half-written');
    expect(mocks.invalidateNodeCaches).toHaveBeenCalledWith(1);
  });

  it('removes the created directory when the compose write itself fails', async () => {
    mocks.hasComposeFile.mockResolvedValue(false);
    mocks.saveStackContent.mockRejectedValue(new Error('read-only'));

    await expect(applyWeb({ stackName: 'never-written' })).rejects.toThrow('read-only');

    expect(mocks.deleteStack).toHaveBeenCalledWith('never-written');
  });

  it('keeps a directory it did not create when a write fails', async () => {
    mocks.hasComposeFile.mockResolvedValue(false);
    mocks.ensureStackDir.mockResolvedValue(false);
    mocks.saveStackContent.mockRejectedValue(new Error('read-only'));

    await expect(applyWeb({ stackName: 'preexisting-dir' })).rejects.toThrow('read-only');

    expect(mocks.deleteStack).not.toHaveBeenCalled();
  });

  it('reports the write failure even when removing the created directory also fails', async () => {
    mocks.hasComposeFile.mockResolvedValue(false);
    mocks.saveStackContent.mockRejectedValue(new Error('read-only'));
    mocks.deleteStack.mockRejectedValue(new Error('cannot remove'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(applyWeb({ stackName: 'cleanup-fails' })).rejects.toThrow('read-only');

    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('reports a pending deletion before the missing-compose refusal and creates nothing', async () => {
    mocks.hasComposeFile.mockResolvedValue(false);
    const intent = vi.spyOn(DatabaseService.getInstance(), 'hasBlockingDeletionIntent').mockReturnValue(true);

    try {
      await expect(applyWeb({ stackName: 'deleting', files: [FILES[1]] }))
        .rejects.toMatchObject({ code: 'stack_deletion_in_progress' });
    } finally {
      intent.mockRestore();
    }

    expect(mocks.ensureStackDir).not.toHaveBeenCalled();
    expect(mocks.deleteStack).not.toHaveBeenCalled();
  });

  it('aborts without writing when capture fails', async () => {
    mocks.captureCurrentBackup.mockRejectedValue(Object.assign(new Error('capture failed'), { code: 'CAPTURE_FAILED' }));

    await expect(applyWeb()).rejects.toThrow('capture failed');

    expect(mocks.saveStackContent).not.toHaveBeenCalled();
    expect(mocks.saveEnvContent).not.toHaveBeenCalled();
    expect(mocks.invalidateNodeCaches).not.toHaveBeenCalled();
  });

  it('refuses to mutate when another stack operation holds the lock', async () => {
    StackOpLockService.getInstance().tryAcquire(1, 'web', 'deploy', 'other');

    await expect(applyWeb()).rejects.toMatchObject({ code: 'stack_op_in_progress' });

    expect(mocks.captureCurrentBackup).not.toHaveBeenCalled();
    expect(mocks.saveStackContent).not.toHaveBeenCalled();
  });

  it('leaves the captured generation in place when a later file write fails', async () => {
    mocks.saveEnvContent.mockRejectedValue(new Error('disk full'));

    await expect(applyWeb()).rejects.toThrow('disk full');

    expect(mocks.captureCurrentBackup).toHaveBeenCalledTimes(1);
    expect(mocks.saveStackContent).toHaveBeenCalledWith('web', FILES[0].content);
    expect(mocks.invalidateNodeCaches).not.toHaveBeenCalled();
  });

  it('rejects an empty apply file list before locking', async () => {
    await expect(applyWeb({ files: [] })).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT_FILES' });

    expect(mocks.captureCurrentBackup).not.toHaveBeenCalled();
    expect(mocks.saveStackContent).not.toHaveBeenCalled();
  });

  it('rejects an invalid stack name before locking or writing', async () => {
    await expect(applyWeb({ stackName: '../escape' })).rejects.toMatchObject({ code: 'INVALID_STACK_NAME' });

    expect(mocks.captureCurrentBackup).not.toHaveBeenCalled();
    expect(mocks.saveStackContent).not.toHaveBeenCalled();
  });

  it('drops snapshot filenames other than compose.yaml and .env', () => {
    expect(selectFleetSnapshotApplyFiles([
      { filename: 'compose.yaml', content: 'a' },
      { filename: 'notes.txt', content: 'nope' },
      { filename: '.env', content: 'b' },
    ])).toEqual([
      { filename: 'compose.yaml', content: 'a' },
      { filename: '.env', content: 'b' },
    ]);
  });

  it('reports a missing compose file as a restore conflict', () => {
    expect(fleetSnapshotApplyConflictCode(
      Object.assign(new Error('no compose'), { code: 'snapshot_compose_missing' }),
    )).toBe('snapshot_compose_missing');
  });

  it('reports a deletion in progress as a restore conflict', () => {
    expect(fleetSnapshotApplyConflictCode(
      Object.assign(new Error('deletion in progress'), { code: 'stack_deletion_in_progress' }),
    )).toBe('stack_deletion_in_progress');
  });

  it('refuses restore when a deletion intent exists even if compose is still on disk', async () => {
    vi.spyOn(DatabaseService.getInstance(), 'hasBlockingDeletionIntent').mockReturnValue(true);
    await expect(applyWeb()).rejects.toMatchObject({ code: 'stack_deletion_in_progress' });
    expect(mocks.captureCurrentBackup).not.toHaveBeenCalled();
    expect(mocks.saveStackContent).not.toHaveBeenCalled();
    expect(mocks.ensureStackDir).not.toHaveBeenCalled();
  });
});
