import { describe, it, expect, vi, afterEach } from 'vitest';
import { FileRootGateway } from '../services/FileRootGateway';
import { stackSourceFileRoot, type StackFileRoot } from '../services/StackFileRootsService';
import { DOWNLOAD_MAX_BYTES, VolumeBrowserService, type VolumeEntry } from '../services/VolumeBrowserService';
import type { FileEntry } from '../services/FileSystemService';

// assertArchivable is a pure guard (no docker/fs), so it is unit-testable on any
// host even though the helper backend itself only runs on Linux.
const gateway = FileRootGateway.getInstance(1);

const fsRoot = stackSourceFileRoot();
const helperRoot: StackFileRoot = {
  ...stackSourceFileRoot('myvol'),
  id: 'vol-1',
  kind: 'volume',
  backend: 'helper',
};

const entry = (over: Partial<FileEntry>): FileEntry => ({
  name: 'f', type: 'file', size: 10, mtime: 0, isProtected: false, ...over,
});

describe('FileRootGateway.assertArchivable', () => {
  it('never rejects on the fs backend (it streams any in-root file and follows symlinks)', () => {
    expect(() => gateway.assertArchivable(fsRoot, 'a', entry({ type: 'symlink' }))).not.toThrow();
    expect(() => gateway.assertArchivable(fsRoot, 'big', entry({ size: DOWNLOAD_MAX_BYTES * 4 }))).not.toThrow();
  });

  it('allows a normal regular file under the cap on the helper backend', () => {
    expect(() => gateway.assertArchivable(helperRoot, 'a.txt', entry({ size: DOWNLOAD_MAX_BYTES }))).not.toThrow();
  });

  it('rejects a helper symlink as unsupported (the helper download refuses to follow it)', () => {
    expect(() => gateway.assertArchivable(helperRoot, 'link', entry({ type: 'symlink' })))
      .toThrowError(expect.objectContaining({ code: 'ARCHIVE_UNSUPPORTED' }));
  });

  it('rejects a helper non-regular (other) entry as unsupported', () => {
    // fifo/socket/device entries the helper download path refuses as "not a
    // regular file"; they must be caught here too, not just symlinks.
    expect(() => gateway.assertArchivable(helperRoot, 'dev', entry({ type: 'other' })))
      .toThrowError(expect.objectContaining({ code: 'ARCHIVE_UNSUPPORTED' }));
  });

  it('rejects a helper file above the per-file download cap as too large', () => {
    expect(() => gateway.assertArchivable(helperRoot, 'big.bin', entry({ size: DOWNLOAD_MAX_BYTES + 1 })))
      .toThrowError(expect.objectContaining({ code: 'ARCHIVE_TOO_LARGE' }));
  });
});

describe('FileRootGateway.listDir helper truncation', () => {
  afterEach(() => vi.restoreAllMocks());

  const volEntry = (name: string): VolumeEntry => ({ name, type: 'file', size: 1, mtime: 0, isProtected: false });

  it('reports truncated when the helper returns the overflow row, trimming to the limit', async () => {
    // The gateway asks the helper for limit+1; receiving limit+1 means there
    // were more entries than the limit.
    vi.spyOn(VolumeBrowserService.prototype, 'listDir').mockResolvedValue(
      Array.from({ length: 4 }, (_, i) => volEntry(`f${i}`)),
    );
    const res = await gateway.listDir(helperRoot, 'stack', '', 3);
    expect(res.truncated).toBe(true);
    expect(res.entries).toHaveLength(3);
  });

  it('reports not truncated when the helper returns at most the limit', async () => {
    vi.spyOn(VolumeBrowserService.prototype, 'listDir').mockResolvedValue(
      Array.from({ length: 3 }, (_, i) => volEntry(`f${i}`)),
    );
    const res = await gateway.listDir(helperRoot, 'stack', '', 3);
    expect(res.truncated).toBe(false);
    expect(res.entries).toHaveLength(3);
  });
});
