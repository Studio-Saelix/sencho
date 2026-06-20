/**
 * probeHostPath: the lstat/readlink/realpath logic behind the storage
 * inventory's bind-source classification. fs is mocked (real symlinks need
 * privileges on Windows and are flaky), so these tests pin the kind taxonomy,
 * the within-stack gate, and symlink-escape detection for both resolvable and
 * broken links.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

const m = vi.hoisted(() => ({ lstat: vi.fn(), realpath: vi.fn(), readlink: vi.fn() }));
vi.mock('fs', () => ({
  default: { promises: { lstat: m.lstat, realpath: m.realpath, readlink: m.readlink } },
}));

import { probeHostPath } from '../services/storage/probeHostPath';

const STACK = path.resolve('/app/compose/mystack');
const enoent = () => Object.assign(new Error('not found'), { code: 'ENOENT' });

function stat(kind: 'dir' | 'file' | 'socket' | 'symlink', extra: { uid?: number; gid?: number; mode?: number } = {}) {
  return {
    isSymbolicLink: () => kind === 'symlink',
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
    isSocket: () => kind === 'socket',
    uid: extra.uid,
    gid: extra.gid,
    mode: extra.mode,
  };
}

beforeEach(() => {
  m.lstat.mockReset();
  m.realpath.mockReset();
  m.readlink.mockReset();
});

describe('probeHostPath', () => {
  it('classifies a within-stack directory, file, and socket', async () => {
    m.lstat.mockResolvedValueOnce(stat('dir'));
    expect(await probeHostPath(path.join(STACK, 'data'), STACK)).toMatchObject({ exists: true, kind: 'directory', withinStackDir: true });
    m.lstat.mockResolvedValueOnce(stat('file'));
    expect((await probeHostPath(path.join(STACK, 'cfg'), STACK)).kind).toBe('file');
    m.lstat.mockResolvedValueOnce(stat('socket'));
    expect((await probeHostPath(path.join(STACK, 'sock'), STACK)).kind).toBe('socket');
  });

  it('reports a within-stack path that does not exist as missing', async () => {
    m.lstat.mockRejectedValue(enoent());
    const p = await probeHostPath(path.join(STACK, 'gone'), STACK);
    expect(p).toMatchObject({ exists: false, kind: 'missing', withinStackDir: true, lexicalWithinStackDir: true });
  });

  it('never probes an external absolute path', async () => {
    const p = await probeHostPath(path.resolve('/mnt/media'), STACK);
    expect(p).toMatchObject({ lexicalWithinStackDir: false, withinStackDir: false, exists: false, kind: 'unknown' });
    expect(m.lstat).not.toHaveBeenCalled();
  });

  it('flags a resolvable symlink that escapes the stack dir', async () => {
    m.lstat.mockResolvedValue(stat('symlink'));
    m.realpath.mockResolvedValue(path.resolve('/mnt/data'));
    const p = await probeHostPath(path.join(STACK, 'link'), STACK);
    expect(p).toMatchObject({ kind: 'symlink', exists: true, escapes: true, withinStackDir: false });
  });

  it('flags a broken symlink whose readlink target escapes the stack dir', async () => {
    m.lstat.mockResolvedValue(stat('symlink'));
    m.realpath.mockRejectedValue(enoent());
    m.readlink.mockResolvedValue('/mnt/data');
    const p = await probeHostPath(path.join(STACK, 'broken'), STACK);
    expect(p).toMatchObject({ kind: 'symlink', escapes: true, withinStackDir: false });
  });

  it('keeps a broken symlink whose target stays inside the stack dir within-stack', async () => {
    m.lstat.mockResolvedValue(stat('symlink'));
    m.realpath.mockRejectedValue(enoent());
    m.readlink.mockResolvedValue('./sub');
    const p = await probeHostPath(path.join(STACK, 'broken'), STACK);
    expect(p).toMatchObject({ kind: 'symlink', escapes: false, withinStackDir: true });
  });

  it('populates uid/gid/mode from stat on POSIX', async () => {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      m.lstat.mockResolvedValue(stat('dir', { uid: 1000, gid: 1000, mode: 0o40755 }));
      const p = await probeHostPath(path.join(STACK, 'data'), STACK);
      expect(p).toMatchObject({ uid: 1000, gid: 1000, mode: '755' });
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true });
    }
  });
});
