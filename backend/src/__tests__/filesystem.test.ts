/**
 * Unit tests for FileSystemService.deleteStack().
 *
 * Sencho runs as root inside the container by default, so deleteStack only
 * needs to wrap fsPromises.rm and translate ENOENT into a silent no-op.
 * Permission errors are surfaced to the caller like any other failure
 * (no Docker-helper fallback).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';

const { mockRm, mockReaddir } = vi.hoisted(() => ({
  mockRm: vi.fn(),
  mockReaddir: vi.fn(),
}));

vi.mock('fs', () => ({
  promises: {
    rm: mockRm,
    mkdir: vi.fn(),
    readdir: mockReaddir,
    readFile: vi.fn(),
    writeFile: vi.fn(),
    access: vi.fn(),
    stat: vi.fn(),
    rename: vi.fn(),
    copyFile: vi.fn(),
    unlink: vi.fn(),
    // deleteStack now realpath-checks the stack dir against the compose root
    // before rm. Resolve to the absolute path (no symlink) so the containment
    // guard passes and these tests still exercise the rm error translation;
    // the guard's symlink-escape behaviour is covered in
    // filesystem-symlink-escape.test.ts.
    realpath: vi.fn((p: string) => Promise.resolve(path.resolve(p))),
  },
}));

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getComposeDir: () => '/test/compose',
      getDefaultNodeId: () => 1,
    }),
  },
}));

import { FileSystemService } from '../services/FileSystemService';

const expectedDir = path.join('/test/compose', 'my-stack');

describe('FileSystemService.deleteStack', () => {
  let service: FileSystemService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = FileSystemService.getInstance();
  });

  it('deletes a stack directory successfully via fsPromises.rm', async () => {
    mockRm.mockResolvedValueOnce(undefined);
    await service.deleteStack('my-stack');
    expect(mockRm).toHaveBeenCalledWith(expectedDir, { recursive: true, force: true });
  });

  it('silently ignores ENOENT (directory already gone)', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockRm.mockRejectedValueOnce(err);
    await expect(service.deleteStack('gone-stack')).resolves.toBeUndefined();
  });

  it('throws on EACCES (running as root should make this rare)', async () => {
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    mockRm.mockRejectedValueOnce(err);
    await expect(service.deleteStack('restricted-stack')).rejects.toThrow(/permission denied/);
  });

  it('throws on EPERM', async () => {
    const err = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    mockRm.mockRejectedValueOnce(err);
    await expect(service.deleteStack('eperm-stack')).rejects.toThrow(/operation not permitted/);
  });

  it('throws on unexpected errors (e.g. EIO)', async () => {
    const err = Object.assign(new Error('disk I/O error'), { code: 'EIO' });
    mockRm.mockRejectedValueOnce(err);
    await expect(service.deleteStack('io-error-stack')).rejects.toThrow(/disk I\/O error/);
  });
});

describe('FileSystemService.getStacks', () => {
  let service: FileSystemService;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    service = FileSystemService.getInstance();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns [] and logs ENOMEM-specific message with host free memory', async () => {
    const err = Object.assign(
      new Error("ENOMEM: not enough memory, scandir '/test/compose'"),
      { code: 'ENOMEM' },
    );
    mockReaddir.mockRejectedValueOnce(err);
    const freememSpy = vi.spyOn(os, 'freemem').mockReturnValue(37 * 1024 * 1024);

    try {
      const result = await service.getStacks();
      expect(result).toEqual([]);
      const warning = warnSpy.mock.calls[0]?.[0] as string;
      expect(warning).toContain('ENOMEM');
      expect(warning).toContain('host free memory: 37 MiB');
      expect(warning).toContain('Returning empty list');
    } finally {
      freememSpy.mockRestore();
    }
  });

  it('returns [] and logs the raw error message for non-ENOMEM errors', async () => {
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    mockReaddir.mockRejectedValueOnce(err);

    const result = await service.getStacks();
    expect(result).toEqual([]);
    const warning = warnSpy.mock.calls[0]?.[0] as string;
    expect(warning).toContain('EACCES: permission denied');
    expect(warning).not.toContain('host free memory');
  });
});
