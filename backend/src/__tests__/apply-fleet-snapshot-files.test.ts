import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyFleetSnapshotFiles, selectFleetSnapshotApplyFiles, type FleetSnapshotApplyFile } from '../helpers/applyFleetSnapshotFiles';
import { StackOpLockService } from '../services/StackOpLockService';

const mocks = vi.hoisted(() => ({
  hasComposeFile: vi.fn(),
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
    expect(mocks.saveStackContent).toHaveBeenCalledWith('fresh', FILES[0].content);
    expect(mocks.saveEnvContent).toHaveBeenCalledWith('fresh', FILES[1].content);
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
});
