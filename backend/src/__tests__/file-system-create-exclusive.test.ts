/**
 * Direct tests for FileSystemService.createFileExclusive, the exclusive-create
 * primitive behind the editor's first env save. These use a real temp compose
 * root because the contract is about filesystem edge cases: an existing file,
 * a directory, symlinks, and a failed write after the exclusive open.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { promises as fsPromises } from 'fs';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { FileSystemService } from '../services/FileSystemService';

let tmpDir: string;
let composeDir: string;
let fsService: FileSystemService;

const STACK_DIR = 'edge';
const targetPath = () => path.join(composeDir, STACK_DIR, '.env');

beforeAll(async () => {
  tmpDir = await setupTestDb();
  composeDir = process.env.COMPOSE_DIR as string;
  fsService = FileSystemService.getInstance();
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  const stackDir = path.join(composeDir, STACK_DIR);
  if (fs.existsSync(stackDir)) {
    fs.rmSync(stackDir, { recursive: true, force: true });
  }
  fs.mkdirSync(stackDir, { recursive: true });
});

describe('FileSystemService.createFileExclusive', () => {
  it('creates a missing file and returns its mtime', async () => {
    const res = await fsService.createFileExclusive(targetPath(), 'FOO=1');

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.mtimeMs).toBeGreaterThan(0);
    expect(fs.readFileSync(targetPath(), 'utf-8')).toBe('FOO=1');
  });

  it('refuses a target under a missing stack directory and creates nothing', async () => {
    // A stack directory deleted between the caller's existence check and this
    // create (a concurrent deleteStack) must not be resurrected by a recursive
    // mkdir: the exclusive open fails with ENOENT and the route reports the
    // stack as gone. The parent path is deliberately absent.
    const missingStackDir = path.join(composeDir, 'gone-stack');

    await expect(fsService.createFileExclusive(path.join(missingStackDir, '.env'), 'FOO=1'))
      .rejects.toMatchObject({ code: 'ENOENT' });

    expect(fs.existsSync(missingStackDir)).toBe(false);
  });

  it('returns the existing content instead of overwriting it', async () => {
    fs.writeFileSync(targetPath(), 'SECRET=keepme', 'utf-8');

    const res = await fsService.createFileExclusive(targetPath(), 'FOO=2');

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.currentContent).toBe('SECRET=keepme');
      expect(res.currentMtimeMs).toBeGreaterThan(0);
    }
    expect(fs.readFileSync(targetPath(), 'utf-8')).toBe('SECRET=keepme');
  });

  it('throws EISDIR when the target is a directory', async () => {
    fs.mkdirSync(targetPath());

    await expect(fsService.createFileExclusive(targetPath(), 'FOO=1'))
      .rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('refuses a symlink that points outside the base and never reads it', async () => {
    const outsidePath = path.join(tmpDir, 'outside.env');
    fs.writeFileSync(outsidePath, 'OUTSIDE=secret', 'utf-8');
    fs.symlinkSync(outsidePath, targetPath());

    await expect(fsService.createFileExclusive(targetPath(), 'FOO=1'))
      .rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    expect(fs.readFileSync(outsidePath, 'utf-8')).toBe('OUTSIDE=secret');
  });

  it('refuses an in-root symlink at the target as an invalid path', async () => {
    const realPath = path.join(composeDir, STACK_DIR, 'real.env');
    fs.writeFileSync(realPath, 'REAL=1', 'utf-8');
    fs.symlinkSync(realPath, targetPath());

    await expect(fsService.createFileExclusive(targetPath(), 'FOO=1'))
      .rejects.toMatchObject({ code: 'INVALID_PATH' });
    expect(fs.readFileSync(realPath, 'utf-8')).toBe('REAL=1');
  });

  it('refuses a dangling symlink', async () => {
    fs.symlinkSync(path.join(composeDir, STACK_DIR, 'missing.env'), targetPath());

    await expect(fsService.createFileExclusive(targetPath(), 'FOO=1'))
      .rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
  });

  it('removes the zero-byte leftover when the write fails after the exclusive open', async () => {
    // Grab the prototype from a real FileHandle: the exported class is not a
    // dependable runtime import across Node/vitest interop.
    const probePath = path.join(tmpDir, 'probe.tmp');
    const probe = await fsPromises.open(probePath, 'wx');
    const handleProto = Object.getPrototypeOf(probe) as { writeFile: (...args: unknown[]) => Promise<void> };
    await probe.close();
    fs.rmSync(probePath, { force: true });

    const writeSpy = vi
      .spyOn(handleProto, 'writeFile')
      .mockRejectedValueOnce(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }));

    try {
      await expect(fsService.createFileExclusive(targetPath(), 'FOO=1'))
        .rejects.toMatchObject({ code: 'ENOSPC' });
      expect(fs.existsSync(targetPath())).toBe(false);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('does not delete a replacement when the write fails after the exclusive open', async () => {
    const probePath = path.join(tmpDir, 'probe-replaced.tmp');
    const probe = await fsPromises.open(probePath, 'wx');
    const handleProto = Object.getPrototypeOf(probe) as { writeFile: (...args: unknown[]) => Promise<void> };
    await probe.close();
    fs.rmSync(probePath, { force: true });

    const writeSpy = vi.spyOn(handleProto, 'writeFile').mockImplementationOnce(async () => {
      // Simulate another actor replacing the target before the cleanup runs.
      fs.rmSync(targetPath(), { force: true });
      fs.writeFileSync(targetPath(), 'REPLACEMENT=1', 'utf-8');
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    });

    try {
      await expect(fsService.createFileExclusive(targetPath(), 'FOO=1'))
        .rejects.toMatchObject({ code: 'ENOSPC' });
      expect(fs.readFileSync(targetPath(), 'utf-8')).toBe('REPLACEMENT=1');
    } finally {
      writeSpy.mockRestore();
    }
  });
});
