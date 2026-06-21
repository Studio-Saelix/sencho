/**
 * Tests for isValidRelativeStackPath (pure function) and the stack-scoped
 * file methods on FileSystemService (listStackDirectory, readStackFile,
 * writeStackFile, writeStackFileBuffer, deleteStackPath, mkdirStackPath).
 *
 * FileSystemService stack methods are tested against a real temp directory so
 * that realpath, stat, and fs I/O all run with actual OS semantics.
 * NodeRegistry is mocked to redirect the composeDir to our temp location.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { isValidRelativeStackPath } from '../utils/validation';

// On Windows, fs.unlink on a directory returns EPERM rather than EISDIR.
// The deleteStackPath empty-dir and NOT_EMPTY paths rely on EISDIR (Linux/macOS).
// Skip those specific cases on Windows.
const isWindows = process.platform === 'win32';

// Mutable state the mocked NodeRegistry reads. Each beforeEach updates it
// before any FileSystemService method runs.
const mockState = { composeDir: '' };

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getComposeDir: () => mockState.composeDir,
      getDefaultNodeId: () => 1,
    }),
  },
}));

vi.mock('../utils/debug', () => ({ isDebugEnabled: () => false }));

import { FileSystemService } from '../services/FileSystemService';

// ── isValidRelativeStackPath ──────────────────────────────────────────────────

describe('isValidRelativeStackPath', () => {
  // Accepted inputs
  it('accepts empty string (stack root)', () => expect(isValidRelativeStackPath('')).toBe(true));
  it('accepts simple filename', () => expect(isValidRelativeStackPath('compose.yaml')).toBe(true));
  it('accepts dotfile', () => expect(isValidRelativeStackPath('.env')).toBe(true));
  it('accepts nested path', () => expect(isValidRelativeStackPath('config/app.conf')).toBe(true));
  it('accepts deeply nested path', () => expect(isValidRelativeStackPath('a/b/c/d.txt')).toBe(true));

  // Rejected inputs
  it('rejects ..', () => expect(isValidRelativeStackPath('..')).toBe(false));
  it('rejects ../etc/passwd traversal', () => expect(isValidRelativeStackPath('../etc/passwd')).toBe(false));
  it('rejects a/../b', () => expect(isValidRelativeStackPath('a/../b')).toBe(false));
  it('rejects absolute path', () => expect(isValidRelativeStackPath('/etc/passwd')).toBe(false));
  it('rejects Windows drive path', () => expect(isValidRelativeStackPath('C:/windows')).toBe(false));
  it('rejects NUL byte', () => expect(isValidRelativeStackPath('file\x00name')).toBe(false));
  it('rejects backslash', () => expect(isValidRelativeStackPath('path\\file')).toBe(false));
  it('rejects double-slash', () => expect(isValidRelativeStackPath('a//b')).toBe(false));
  it('rejects bare dot segment', () => expect(isValidRelativeStackPath('a/./b')).toBe(false));
});

// ── FileSystemService stack methods ──────────────────────────────────────────

describe('FileSystemService stack methods', () => {
  const STACK = 'mystack';
  let tmpBase: string;
  let stackDir: string;

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-fsp-'));
    stackDir = path.join(tmpBase, STACK);
    mockState.composeDir = tmpBase;
    await fs.mkdir(stackDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  // ── listStackDirectory ──────────────────────────────────────────────────

  describe('listStackDirectory', () => {
    it('returns entries with directories sorted before files', async () => {
      await fs.mkdir(path.join(stackDir, 'config'));
      await fs.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n');
      await fs.writeFile(path.join(stackDir, '.env'), 'KEY=val\n');

      const service = FileSystemService.getInstance();
      const entries = await service.listStackDirectory(STACK, '');

      // Directories come first
      expect(entries[0].type).toBe('directory');
      expect(entries[0].name).toBe('config');

      // Files follow, sorted alphabetically (case-insensitive)
      const fileNames = entries.filter(e => e.type === 'file').map(e => e.name);
      expect(fileNames).toEqual(['.env', 'compose.yaml']);
    });

    it('marks compose.yaml and .env as protected', async () => {
      await fs.writeFile(path.join(stackDir, 'compose.yaml'), '');
      await fs.writeFile(path.join(stackDir, '.env'), '');
      await fs.writeFile(path.join(stackDir, 'custom.conf'), '');

      const service = FileSystemService.getInstance();
      const entries = await service.listStackDirectory(STACK, '');

      const byName = Object.fromEntries(entries.map(e => [e.name, e]));
      expect(byName['compose.yaml'].isProtected).toBe(true);
      expect(byName['.env'].isProtected).toBe(true);
      expect(byName['custom.conf'].isProtected).toBe(false);
    });

    it('includes size and mtime for files', async () => {
      await fs.writeFile(path.join(stackDir, 'test.txt'), 'hello');

      const service = FileSystemService.getInstance();
      const entries = await service.listStackDirectory(STACK, '');

      const file = entries.find(e => e.name === 'test.txt');
      expect(file).toBeDefined();
      expect(file!.size).toBe(5);
      expect(file!.mtime).toBeGreaterThan(0);
    });

    it('returns empty array for an empty stack directory', async () => {
      const service = FileSystemService.getInstance();
      const entries = await service.listStackDirectory(STACK, '');
      expect(entries).toEqual([]);
    });

    it('lists a subdirectory when relPath is provided', async () => {
      await fs.mkdir(path.join(stackDir, 'sub'));
      await fs.writeFile(path.join(stackDir, 'sub', 'child.txt'), 'data');

      const service = FileSystemService.getInstance();
      const entries = await service.listStackDirectory(STACK, 'sub');
      expect(entries.length).toBe(1);
      expect(entries[0].name).toBe('child.txt');
    });
  });

  // ── readStackFile ───────────────────────────────────────────────────────

  describe('readStackFile', () => {
    it('returns text content for a UTF-8 file', async () => {
      await fs.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n');

      const service = FileSystemService.getInstance();
      const result = await service.readStackFile(STACK, 'compose.yaml');
      expect(result.binary).toBe(false);
      expect(result.oversized).toBe(false);
      expect(result.content).toBe('services: {}\n');
    });

    it('returns binary:true and no content for a binary file', async () => {
      // PNG magic bytes followed by non-printable data
      const pngMagic = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(50, 0xff),
      ]);
      await fs.writeFile(path.join(stackDir, 'icon.png'), pngMagic);

      const service = FileSystemService.getInstance();
      const result = await service.readStackFile(STACK, 'icon.png');
      expect(result.binary).toBe(true);
      expect(result.oversized).toBe(false);
      expect(result.content).toBeUndefined();
    });

    it('returns oversized:true for files exceeding maxBytes', async () => {
      // Write a text file larger than our small maxBytes limit
      await fs.writeFile(path.join(stackDir, 'big.txt'), 'a'.repeat(200));

      const service = FileSystemService.getInstance();
      // maxBytes=100 forces the oversized path
      const result = await service.readStackFile(STACK, 'big.txt', 100);
      expect(result.oversized).toBe(true);
      expect(result.size).toBe(200);
    });

    it('throws IS_DIRECTORY when path points to a directory', async () => {
      await fs.mkdir(path.join(stackDir, 'subdir'));

      const service = FileSystemService.getInstance();
      await expect(service.readStackFile(STACK, 'subdir')).rejects.toMatchObject({ code: 'IS_DIRECTORY' });
    });
  });

  // ── writeStackFile ──────────────────────────────────────────────────────

  describe('writeStackFile', () => {
    it('creates a new file with the given content', async () => {
      const service = FileSystemService.getInstance();
      await service.writeStackFile(STACK, 'new.txt', 'hello world');

      const content = await fs.readFile(path.join(stackDir, 'new.txt'), 'utf-8');
      expect(content).toBe('hello world');
    });

    it('overwrites an existing file', async () => {
      await fs.writeFile(path.join(stackDir, 'data.txt'), 'original');

      const service = FileSystemService.getInstance();
      await service.writeStackFile(STACK, 'data.txt', 'updated');

      const content = await fs.readFile(path.join(stackDir, 'data.txt'), 'utf-8');
      expect(content).toBe('updated');
    });

    it('creates parent directories if they do not exist', async () => {
      const service = FileSystemService.getInstance();
      await service.writeStackFile(STACK, 'deep/nested/file.txt', 'content');

      const content = await fs.readFile(path.join(stackDir, 'deep', 'nested', 'file.txt'), 'utf-8');
      expect(content).toBe('content');
    });
  });

  // ── writeStackFileBuffer ────────────────────────────────────────────────

  describe('writeStackFileBuffer', () => {
    it('writes raw bytes correctly', async () => {
      const data = Buffer.from([0x01, 0x02, 0x03, 0xff]);
      const service = FileSystemService.getInstance();
      await service.writeStackFileBuffer(STACK, 'binary.bin', data);

      const read = await fs.readFile(path.join(stackDir, 'binary.bin'));
      expect(read).toEqual(data);
    });

    it('creates parent directories when needed', async () => {
      const payload = Buffer.from([0xde, 0xad]);
      const service = FileSystemService.getInstance();
      await service.writeStackFileBuffer(STACK, 'sub/img.bin', payload);

      const read = await fs.readFile(path.join(stackDir, 'sub', 'img.bin'));
      expect(read).toEqual(payload);
    });
  });

  // ── atomic write semantics ──────────────────────────────────────────────

  describe('atomic write semantics', () => {
    it('does not leak .sencho-tmp-* files after a successful write', async () => {
      const service = FileSystemService.getInstance();
      await service.writeStackFile(STACK, 'clean.txt', 'final');
      const dirEntries = await fs.readdir(stackDir);
      const leftovers = dirEntries.filter(name => name.startsWith('clean.txt.sencho-tmp-'));
      expect(leftovers).toEqual([]);
    });

    it('preserves the original target when the rename step throws', async () => {
      const target = path.join(stackDir, 'crash.txt');
      await fs.writeFile(target, 'ORIGINAL');

      const fsModule = await import('fs');
      const renameSpy = vi
        .spyOn(fsModule.promises, 'rename')
        .mockRejectedValueOnce(Object.assign(new Error('disk yanked'), { code: 'EIO' }));

      const service = FileSystemService.getInstance();
      await expect(service.writeStackFile(STACK, 'crash.txt', 'NEW')).rejects.toThrow(/disk yanked/);

      // Target keeps its original content.
      const content = await fs.readFile(target, 'utf-8');
      expect(content).toBe('ORIGINAL');

      // Tmp file is cleaned up.
      const dirEntries = await fs.readdir(stackDir);
      const leftovers = dirEntries.filter(name => name.startsWith('crash.txt.sencho-tmp-'));
      expect(leftovers).toEqual([]);

      renameSpy.mockRestore();
    });

    it('exclusive write to a fresh target succeeds', async () => {
      const service = FileSystemService.getInstance();
      await service.writeStackFile(STACK, 'first.txt', 'hello', { exclusive: true });
      const content = await fs.readFile(path.join(stackDir, 'first.txt'), 'utf-8');
      expect(content).toBe('hello');
    });

    it('exclusive write to an existing target throws FILE_EXISTS and preserves the original', async () => {
      const target = path.join(stackDir, 'taken.txt');
      await fs.writeFile(target, 'KEEP');

      const service = FileSystemService.getInstance();
      let caught: unknown = null;
      try {
        await service.writeStackFile(STACK, 'taken.txt', 'OVERWRITE', { exclusive: true });
      } catch (err) {
        caught = err;
      }
      expect((caught as { code?: string })?.code).toBe('FILE_EXISTS');

      const content = await fs.readFile(target, 'utf-8');
      expect(content).toBe('KEEP');

      // Tmp file cleaned up after the link failure.
      const dirEntries = await fs.readdir(stackDir);
      const leftovers = dirEntries.filter(name => name.startsWith('taken.txt.sencho-tmp-'));
      expect(leftovers).toEqual([]);
    });

    it('cleans up the tmp file when the write step throws', async () => {
      const fsModule = await import('fs');
      const originalOpen = fsModule.promises.open;
      const openSpy = vi
        .spyOn(fsModule.promises, 'open')
        .mockImplementationOnce(async (...args) => {
          const fh = await originalOpen.apply(fsModule.promises, args as Parameters<typeof originalOpen>);
          // Patch writeFile to throw, the close still runs via the inner finally.
          (fh as unknown as { writeFile: () => Promise<void> }).writeFile = () =>
            Promise.reject(Object.assign(new Error('write blew up'), { code: 'EIO' }));
          return fh;
        });

      const service = FileSystemService.getInstance();
      await expect(service.writeStackFile(STACK, 'wfail.txt', 'NEW')).rejects.toThrow(/write blew up/);

      // Target was never created and the tmp was cleaned.
      const dirEntries = await fs.readdir(stackDir);
      expect(dirEntries).not.toContain('wfail.txt');
      const leftovers = dirEntries.filter(name => name.startsWith('wfail.txt.sencho-tmp-'));
      expect(leftovers).toEqual([]);

      openSpy.mockRestore();
    });

    it('concurrent non-exclusive writers to the same path leave one winning content and no tmp leaks', async () => {
      const service = FileSystemService.getInstance();
      const inputs = ['A', 'B', 'C', 'D', 'E'].map(l => l.repeat(32));
      // POSIX rename is atomic and silently overwrites: every writer succeeds and
      // the last-to-rename wins. Windows rename throws EPERM if the destination
      // is open or being renamed by another process. Both are acceptable: the
      // contract is "the final file is always exactly one of the inputs, never
      // torn, and no tmp files leak". Settle individually and require at least
      // one writer to have succeeded.
      const results = await Promise.allSettled(
        inputs.map(content => service.writeStackFile(STACK, 'race.txt', content)),
      );
      expect(results.some(r => r.status === 'fulfilled')).toBe(true);

      const finalContent = await fs.readFile(path.join(stackDir, 'race.txt'), 'utf-8');
      expect(inputs).toContain(finalContent);

      const dirEntries = await fs.readdir(stackDir);
      const leftovers = dirEntries.filter(name => name.startsWith('race.txt.sencho-tmp-'));
      expect(leftovers).toEqual([]);
    });
  });

  // ── deleteStackPath ─────────────────────────────────────────────────────

  describe('deleteStackPath', () => {
    it('deletes a file', async () => {
      await fs.writeFile(path.join(stackDir, 'todelete.txt'), '');

      const service = FileSystemService.getInstance();
      await service.deleteStackPath(STACK, 'todelete.txt');

      await expect(fs.access(path.join(stackDir, 'todelete.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.skipIf(isWindows)('deletes an empty directory (Linux/macOS only: Windows unlink returns EPERM)', async () => {
      await fs.mkdir(path.join(stackDir, 'emptydir'));

      const service = FileSystemService.getInstance();
      await service.deleteStackPath(STACK, 'emptydir');

      await expect(fs.access(path.join(stackDir, 'emptydir'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.skipIf(isWindows)('throws NOT_EMPTY for non-empty directory without recursive flag (Linux/macOS only)', async () => {
      await fs.mkdir(path.join(stackDir, 'nonempty'));
      await fs.writeFile(path.join(stackDir, 'nonempty', 'child.txt'), '');

      const service = FileSystemService.getInstance();
      await expect(service.deleteStackPath(STACK, 'nonempty', false)).rejects.toMatchObject({ code: 'NOT_EMPTY' });
    });

    it('recursively deletes a non-empty directory when recursive=true', async () => {
      await fs.mkdir(path.join(stackDir, 'tree'));
      await fs.writeFile(path.join(stackDir, 'tree', 'child.txt'), '');

      const service = FileSystemService.getInstance();
      await service.deleteStackPath(STACK, 'tree', true);

      await expect(fs.access(path.join(stackDir, 'tree'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  // ── mkdirStackPath ──────────────────────────────────────────────────────

  describe('mkdirStackPath', () => {
    it('creates a new directory', async () => {
      const service = FileSystemService.getInstance();
      await service.mkdirStackPath(STACK, 'newdir');

      const stat = await fs.stat(path.join(stackDir, 'newdir'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('creates nested directories', async () => {
      const service = FileSystemService.getInstance();
      await service.mkdirStackPath(STACK, 'a/b/c');

      const stat = await fs.stat(path.join(stackDir, 'a', 'b', 'c'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('does not throw when directory already exists', async () => {
      await fs.mkdir(path.join(stackDir, 'existing'));

      const service = FileSystemService.getInstance();
      await expect(service.mkdirStackPath(STACK, 'existing')).resolves.toBeUndefined();
    });
  });

  // ── renameStackPath (rename + cross-directory move) ──────────────────────

  describe('renameStackPath', () => {
    it('moves a file from the stack root into a subdirectory', async () => {
      await fs.writeFile(path.join(stackDir, 'app.conf'), 'data');
      await fs.mkdir(path.join(stackDir, 'configs'));

      const service = FileSystemService.getInstance();
      await service.renameStackPath(STACK, 'app.conf', 'configs/app.conf');

      await expect(fs.access(path.join(stackDir, 'app.conf'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(path.join(stackDir, 'configs', 'app.conf'), 'utf-8')).toBe('data');
    });

    it('moves a file from a subdirectory back to the stack root', async () => {
      await fs.mkdir(path.join(stackDir, 'configs'));
      await fs.writeFile(path.join(stackDir, 'configs', 'app.conf'), 'data');

      const service = FileSystemService.getInstance();
      await service.renameStackPath(STACK, 'configs/app.conf', 'app.conf');

      await expect(fs.access(path.join(stackDir, 'configs', 'app.conf'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(path.join(stackDir, 'app.conf'), 'utf-8')).toBe('data');
    });

    it('moves a directory into another directory', async () => {
      await fs.mkdir(path.join(stackDir, 'src'));
      await fs.writeFile(path.join(stackDir, 'src', 'child.txt'), 'inner');
      await fs.mkdir(path.join(stackDir, 'dest'));

      const service = FileSystemService.getInstance();
      await service.renameStackPath(STACK, 'src', 'dest/src');

      await expect(fs.access(path.join(stackDir, 'src'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(path.join(stackDir, 'dest', 'src', 'child.txt'), 'utf-8')).toBe('inner');
    });

    it('renames a file in place (same directory)', async () => {
      await fs.writeFile(path.join(stackDir, 'old.txt'), 'x');

      const service = FileSystemService.getInstance();
      await service.renameStackPath(STACK, 'old.txt', 'new.txt');

      await expect(fs.access(path.join(stackDir, 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(path.join(stackDir, 'new.txt'), 'utf-8')).toBe('x');
    });

    it('rejects moving a directory into its own descendant', async () => {
      await fs.mkdir(path.join(stackDir, 'parent', 'child'), { recursive: true });

      const service = FileSystemService.getInstance();
      await expect(service.renameStackPath(STACK, 'parent', 'parent/child/parent')).rejects.toMatchObject({
        code: 'INVALID_PATH',
      });
    });

    it('rejects overwriting an existing destination', async () => {
      await fs.writeFile(path.join(stackDir, 'source.txt'), 'a');
      await fs.mkdir(path.join(stackDir, 'sub'));
      await fs.writeFile(path.join(stackDir, 'sub', 'source.txt'), 'b');

      const service = FileSystemService.getInstance();
      await expect(service.renameStackPath(STACK, 'source.txt', 'sub/source.txt')).rejects.toMatchObject({
        code: 'EEXIST',
      });
    });

    it('rejects an in-place rename onto an existing sibling name', async () => {
      await fs.writeFile(path.join(stackDir, 'old.txt'), 'a');
      await fs.writeFile(path.join(stackDir, 'existing.txt'), 'b');

      const service = FileSystemService.getInstance();
      await expect(service.renameStackPath(STACK, 'old.txt', 'existing.txt')).rejects.toMatchObject({
        code: 'EEXIST',
      });
    });

    it('rejects moving a protected root file out of the stack root', async () => {
      await fs.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n');
      await fs.mkdir(path.join(stackDir, 'sub'));

      const service = FileSystemService.getInstance();
      await expect(service.renameStackPath(STACK, 'compose.yaml', 'sub/compose.yaml')).rejects.toMatchObject({
        code: 'PROTECTED_FILE',
      });
    });

    it('rejects a destination that becomes a protected root name', async () => {
      await fs.mkdir(path.join(stackDir, 'sub'));
      await fs.writeFile(path.join(stackDir, 'sub', 'compose.yaml'), 'services: {}\n');

      const service = FileSystemService.getInstance();
      await expect(service.renameStackPath(STACK, 'sub/compose.yaml', 'compose.yaml')).rejects.toMatchObject({
        code: 'PROTECTED_FILE',
      });
    });

    // On a case-insensitive filesystem a differently-cased request resolves to the
    // real protected file, so the gate must fold case. These only reproduce the
    // bypass on Windows/macOS; on Linux the cased name is a distinct, unprotected
    // file and the scenario does not arise.
    it.skipIf(!isWindows)('rejects moving a protected root file referenced by a different case', async () => {
      await fs.writeFile(path.join(stackDir, 'compose.yaml'), 'services: {}\n');
      await fs.mkdir(path.join(stackDir, 'sub'));

      const service = FileSystemService.getInstance();
      await expect(service.renameStackPath(STACK, 'COMPOSE.YAML', 'sub/COMPOSE.YAML')).rejects.toMatchObject({
        code: 'PROTECTED_FILE',
      });
    });

    it.skipIf(!isWindows)('rejects moving a directory into its own descendant when the source case differs', async () => {
      await fs.mkdir(path.join(stackDir, 'parent', 'child'), { recursive: true });

      const service = FileSystemService.getInstance();
      await expect(service.renameStackPath(STACK, 'Parent', 'parent/child/x')).rejects.toMatchObject({
        code: 'INVALID_PATH',
      });
    });
  });

  // ── path traversal ──────────────────────────────────────────────────────

  describe('path traversal protection', () => {
    it('throws INVALID_PATH when relPath escapes stack directory via ..', async () => {
      // isValidRelativeStackPath rejects ".." before it reaches the service,
      // but we also test the service-level guard with a stack name that would
      // escape the compose dir (isPathWithinBase check in resolveSafeStackPath).
      const service = FileSystemService.getInstance();
      await expect(service.listStackDirectory('..', '')).rejects.toMatchObject({ code: 'INVALID_PATH' });
    });

    it('throws INVALID_PATH for a stack name with path separator', async () => {
      const service = FileSystemService.getInstance();
      await expect(service.readStackFile('../other', 'file.txt')).rejects.toMatchObject({ code: 'INVALID_PATH' });
    });

    it.skipIf(isWindows)('throws SYMLINK_ESCAPE when a symlink inside the stack points outside it (Linux/macOS only)', async () => {
      const externalFile = path.join(tmpBase, 'secret.txt');
      await fs.writeFile(externalFile, 'secret');
      await fs.symlink(externalFile, path.join(stackDir, 'escape-link'));

      const service = FileSystemService.getInstance();
      await expect(service.readStackFile(STACK, 'escape-link')).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    });
  });

  // ── symlink semantics ────────────────────────────────────────────────────
  // Symlink creation requires admin/developer-mode on Windows; skip the
  // whole block there to avoid spurious EPERM failures unrelated to the
  // behaviour being tested.

  describe.skipIf(isWindows)('symlink semantics (Linux/macOS only)', () => {
    it('delete on a symlink removes the link entry and leaves the target intact', async () => {
      const targetPath = path.join(stackDir, 'target.txt');
      const linkPath = path.join(stackDir, 'link.txt');
      await fs.writeFile(targetPath, 'payload');
      await fs.symlink(targetPath, linkPath);

      const service = FileSystemService.getInstance();
      await service.deleteStackPath(STACK, 'link.txt');

      await expect(fs.lstat(linkPath)).rejects.toMatchObject({ code: 'ENOENT' });
      const targetContent = await fs.readFile(targetPath, 'utf-8');
      expect(targetContent).toBe('payload');
    });

    it('delete on a symlink that points outside the stack removes only the link entry', async () => {
      const externalFile = path.join(tmpBase, 'outside.txt');
      await fs.writeFile(externalFile, 'external');
      const linkPath = path.join(stackDir, 'escape-link');
      await fs.symlink(externalFile, linkPath);

      const service = FileSystemService.getInstance();
      await service.deleteStackPath(STACK, 'escape-link');

      await expect(fs.lstat(linkPath)).rejects.toMatchObject({ code: 'ENOENT' });
      const externalContent = await fs.readFile(externalFile, 'utf-8');
      expect(externalContent).toBe('external');
    });

    it('chmod on a symlink rejects with LINK_CHMOD_UNSUPPORTED and leaves the target mode unchanged', async () => {
      const targetPath = path.join(stackDir, 'target.txt');
      await fs.writeFile(targetPath, 'payload');
      await fs.chmod(targetPath, 0o644);
      await fs.symlink(targetPath, path.join(stackDir, 'link.txt'));

      const service = FileSystemService.getInstance();
      await expect(service.chmodStackPath(STACK, 'link.txt', 0o600)).rejects.toMatchObject({
        code: 'LINK_CHMOD_UNSUPPORTED',
      });

      const stat = await fs.stat(targetPath);
      expect(stat.mode & 0o777).toBe(0o644);
    });

    it('chmod on a regular file still succeeds (symlink branch does not regress non-symlink paths)', async () => {
      const filePath = path.join(stackDir, 'plain.txt');
      await fs.writeFile(filePath, 'data');
      await fs.chmod(filePath, 0o644);

      const service = FileSystemService.getInstance();
      await service.chmodStackPath(STACK, 'plain.txt', 0o600);

      const stat = await fs.stat(filePath);
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it('delete on a regular file still succeeds (symlink branch does not regress non-symlink paths)', async () => {
      const filePath = path.join(stackDir, 'plain.txt');
      await fs.writeFile(filePath, 'data');

      const service = FileSystemService.getInstance();
      await service.deleteStackPath(STACK, 'plain.txt');

      await expect(fs.access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('delete on a broken symlink (target already removed) removes the dangling link entry', async () => {
      const targetPath = path.join(stackDir, 'gone.txt');
      const linkPath = path.join(stackDir, 'broken-link.txt');
      await fs.writeFile(targetPath, '');
      await fs.symlink(targetPath, linkPath);
      await fs.unlink(targetPath);

      const service = FileSystemService.getInstance();
      await service.deleteStackPath(STACK, 'broken-link.txt');

      await expect(fs.lstat(linkPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('chmod on a broken symlink rejects with LINK_CHMOD_UNSUPPORTED rather than ENOENT', async () => {
      const targetPath = path.join(stackDir, 'gone-chmod.txt');
      const linkPath = path.join(stackDir, 'broken-link-chmod.txt');
      await fs.writeFile(targetPath, '');
      await fs.symlink(targetPath, linkPath);
      await fs.unlink(targetPath);

      const service = FileSystemService.getInstance();
      await expect(service.chmodStackPath(STACK, 'broken-link-chmod.txt', 0o600)).rejects.toMatchObject({
        code: 'LINK_CHMOD_UNSUPPORTED',
      });
    });

    it('delete on a symlink to a directory removes only the link entry, not the target directory', async () => {
      const targetDir = path.join(stackDir, 'real-dir');
      const linkPath = path.join(stackDir, 'link-to-dir');
      await fs.mkdir(targetDir);
      await fs.writeFile(path.join(targetDir, 'kept.txt'), 'preserve');
      await fs.symlink(targetDir, linkPath);

      const service = FileSystemService.getInstance();
      await service.deleteStackPath(STACK, 'link-to-dir');

      await expect(fs.lstat(linkPath)).rejects.toMatchObject({ code: 'ENOENT' });
      const kept = await fs.readFile(path.join(targetDir, 'kept.txt'), 'utf-8');
      expect(kept).toBe('preserve');
    });

    it('move on a symlink relocates the link entry and leaves an internal target intact', async () => {
      const targetPath = path.join(stackDir, 'target.txt');
      const linkPath = path.join(stackDir, 'link.txt');
      await fs.writeFile(targetPath, 'payload');
      await fs.symlink(targetPath, linkPath);
      await fs.mkdir(path.join(stackDir, 'sub'));

      const service = FileSystemService.getInstance();
      await service.renameStackPath(STACK, 'link.txt', 'sub/link.txt');

      // The link entry moved; the old location is gone and the target is untouched.
      await expect(fs.lstat(linkPath)).rejects.toMatchObject({ code: 'ENOENT' });
      const movedLink = await fs.lstat(path.join(stackDir, 'sub', 'link.txt'));
      expect(movedLink.isSymbolicLink()).toBe(true);
      expect(await fs.readFile(targetPath, 'utf-8')).toBe('payload');
      // Following the moved link still resolves to the original target content.
      expect(await fs.readFile(path.join(stackDir, 'sub', 'link.txt'), 'utf-8')).toBe('payload');
    });

    it('rejects a move whose destination is occupied by a dangling symlink', async () => {
      await fs.writeFile(path.join(stackDir, 'real.txt'), 'payload');
      await fs.mkdir(path.join(stackDir, 'sub'));
      // A symlink to a now-removed target: lstat sees the link, so the slot is occupied.
      await fs.symlink(path.join(stackDir, 'sub', 'gone-target'), path.join(stackDir, 'sub', 'real.txt'));

      const service = FileSystemService.getInstance();
      await expect(service.renameStackPath(STACK, 'real.txt', 'sub/real.txt')).rejects.toMatchObject({
        code: 'EEXIST',
      });
    });

    it('move on a symlink whose target is outside the stack relocates only the link, not the target', async () => {
      const externalFile = path.join(tmpBase, 'outside.txt');
      await fs.writeFile(externalFile, 'external');
      const linkPath = path.join(stackDir, 'escape-link');
      await fs.symlink(externalFile, linkPath);
      await fs.mkdir(path.join(stackDir, 'sub'));

      const service = FileSystemService.getInstance();
      await service.renameStackPath(STACK, 'escape-link', 'sub/escape-link');

      await expect(fs.lstat(linkPath)).rejects.toMatchObject({ code: 'ENOENT' });
      const moved = await fs.lstat(path.join(stackDir, 'sub', 'escape-link'));
      expect(moved.isSymbolicLink()).toBe(true);
      expect(await fs.readFile(externalFile, 'utf-8')).toBe('external');
    });
  });
});

// Root-scoped (bind-mount) behaviour: the file methods accept an arbitrary
// absolute root that may sit OUTSIDE the compose dir, contain paths within it,
// and disable compose/.env protection.
describe('FileSystemService root-scoped methods', () => {
  let tmpBase: string;
  let rootDir: string;

  beforeEach(async () => {
    tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-fsr-'));
    // A bind root that is deliberately not under the compose dir.
    mockState.composeDir = path.join(tmpBase, 'compose');
    rootDir = path.join(tmpBase, 'volume-root');
    await fs.mkdir(rootDir, { recursive: true });
    await fs.mkdir(mockState.composeDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it('lists, reads, and writes within an arbitrary root outside the compose dir', async () => {
    await fs.writeFile(path.join(rootDir, 'app.conf'), 'listen 80;');
    const scope = { rootAbsDir: rootDir, protectedEnabled: false };
    const service = FileSystemService.getInstance();

    const entries = await service.listStackDirectory('ignored', '', scope);
    expect(entries.map(e => e.name)).toContain('app.conf');

    const read = await service.readStackFile('ignored', 'app.conf', undefined, { scope });
    expect(read.content).toBe('listen 80;');

    const write = await service.writeStackFileIfUnchanged('ignored', 'app.conf', 'listen 8080;', read.mtimeMs, scope);
    expect(write.ok).toBe(true);
    expect(await fs.readFile(path.join(rootDir, 'app.conf'), 'utf-8')).toBe('listen 8080;');
  });

  it('rejects a path that escapes the root via ..', async () => {
    const scope = { rootAbsDir: rootDir, protectedEnabled: false };
    const service = FileSystemService.getInstance();
    await expect(service.readStackFile('ignored', '../compose/secret', undefined, { scope }))
      .rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('does not mark a volume compose.yaml/.env as protected when protection is disabled', async () => {
    await fs.writeFile(path.join(rootDir, 'compose.yaml'), '');
    await fs.writeFile(path.join(rootDir, '.env'), '');
    const service = FileSystemService.getInstance();
    const entries = await service.listStackDirectory('ignored', '', { rootAbsDir: rootDir, protectedEnabled: false });
    expect(entries.every(e => !e.isProtected)).toBe(true);
    // A delete of a volume .env is allowed (not blocked as a protected stack file).
    await service.deleteStackPath('ignored', '.env', false, { rootAbsDir: rootDir, protectedEnabled: false });
    await expect(fs.lstat(path.join(rootDir, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symlink leaf whose target escapes the root', async () => {
    if (isWindows) return; // POSIX symlink semantics
    const outside = path.join(tmpBase, 'outside.txt');
    await fs.writeFile(outside, 'secret');
    await fs.symlink(outside, path.join(rootDir, 'escape'));
    const service = FileSystemService.getInstance();
    await expect(service.readStackFile('ignored', 'escape', undefined, { scope: { rootAbsDir: rootDir, protectedEnabled: false } }))
      .rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
  });
});
