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

const { mockRm, mockReaddir, mockAccess, mockRealpath } = vi.hoisted(() => ({
  mockRm: vi.fn(),
  mockReaddir: vi.fn(),
  mockAccess: vi.fn(),
  mockRealpath: vi.fn(),
}));

vi.mock('fs', () => ({
  promises: {
    rm: mockRm,
    mkdir: vi.fn(),
    readdir: mockReaddir,
    readFile: vi.fn(),
    writeFile: vi.fn(),
    access: mockAccess,
    stat: vi.fn(),
    rename: vi.fn(),
    copyFile: vi.fn(),
    unlink: vi.fn(),
    // deleteStack and the compose/override resolvers realpath-check the stack dir
    // against the compose root before touching it. realpath resolves to the absolute
    // path (no symlink) so the containment guard passes; getOverrideFilename tests drive
    // `access` per-path. The guard's symlink-escape behaviour is covered in
    // filesystem-symlink-escape.test.ts. clearAllMocks() preserves this implementation,
    // so it stays set across every test (set just below the imports).
    realpath: mockRealpath,
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

// realpath resolves any path to its absolute form (no symlink), so the containment
// guard passes for the in-base stack dirs these tests use. Defined here (not in the
// hoisted block, which runs before `path` is bound) and preserved across clearAllMocks().
mockRealpath.mockImplementation((p: string) => Promise.resolve(path.resolve(p)));

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

describe('FileSystemService.getOverrideFilename', () => {
  let service: FileSystemService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-assert the in-base realpath default after clearAllMocks so the symlink-escape
    // case below (which overrides realpath) cannot leak its escape into a later test.
    mockRealpath.mockImplementation((p: string) => Promise.resolve(path.resolve(p)));
    service = FileSystemService.getInstance();
  });

  // Make fsPromises.access resolve only for the named basenames (file exists) and
  // reject with ENOENT otherwise, so a test controls exactly which variants are present.
  function existing(...names: string[]): void {
    const present = new Set(names);
    mockAccess.mockImplementation((p: string) =>
      present.has(path.basename(p))
        ? Promise.resolve(undefined)
        : Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    );
  }

  it('returns the first existing override variant in priority order', async () => {
    // compose.override.yaml is absent, so the next priority (.yml) wins over the
    // lower-priority docker-compose.override.yml that also exists.
    existing('compose.override.yml', 'docker-compose.override.yml');
    await expect(service.getOverrideFilename('my-stack')).resolves.toBe('compose.override.yml');
  });

  it('prefers compose.override.yaml over all lower-priority variants', async () => {
    existing('compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yml');
    await expect(service.getOverrideFilename('my-stack')).resolves.toBe('compose.override.yaml');
  });

  it('returns null when no override variant exists', async () => {
    existing();
    await expect(service.getOverrideFilename('my-stack')).resolves.toBeNull();
  });

  it('returns a bare basename, never an absolute path', async () => {
    existing('docker-compose.override.yaml');
    const result = await service.getOverrideFilename('my-stack');
    expect(result).toBe('docker-compose.override.yaml');
    expect(path.isAbsolute(result as string)).toBe(false);
  });

  it('rejects an invalid stack name before probing the disk', async () => {
    await expect(service.getOverrideFilename('../evil')).rejects.toMatchObject({ code: 'INVALID_STACK_NAME' });
    expect(mockAccess).not.toHaveBeenCalled();
  });

  it('rejects a stack dir whose realpath escapes the compose root (symlink escape)', async () => {
    // The symlink-containment guard runs before any override probe, so a symlinked
    // stack dir cannot pull an override file from outside the compose root.
    const escaped = path.resolve('/totally/outside/evil');
    mockRealpath.mockImplementation((p: string) =>
      path.basename(p) === 'my-stack' ? Promise.resolve(escaped) : Promise.resolve(path.resolve(p)),
    );
    await expect(service.getOverrideFilename('my-stack')).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    expect(mockAccess).not.toHaveBeenCalled();
  });
});
