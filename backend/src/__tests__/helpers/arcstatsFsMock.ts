import { promises as fs } from 'fs';
import { vi } from 'vitest';
import { ARCSTATS_FIXED_PATHS } from '../../helpers/hostMemory';

/**
 * Path-aware partial mock of `fs.promises` for ZFS arcstats reads.
 *
 * `helpers/hostMemory.ts` reads `/proc/spl/kstat/zfs/arcstats` (and optional
 * variants) to compute reclaimable ARC. Tests may run on a ZFS host, so a real
 * read would make results host-dependent. This installs a spy that intercepts
 * ONLY registered/ARC-candidate paths and delegates every other
 * `readFile`/`stat` to the real filesystem, so `setupTestDb` and
 * `DatabaseService` keep working. Default behavior: ARC candidates reject with
 * ENOENT (no ARC), so consumers fall back to the plain `active/total` reading.
 */

// Sourced from the helper so the mock cannot silently drift from the paths the
// production code actually reads.
export const ARC_CANDIDATE_PATHS = ARCSTATS_FIXED_PATHS;

/** Second fixed candidate; the default path fixtures are served from. */
export const DEFAULT_ARC_PATH = ARC_CANDIDATE_PATHS[1];

type StatDescriptor = { isFile: boolean; size: number };

export interface ArcstatsFsMock {
  /** Serve `content` when `path` is read. */
  setRead(path: string, content: string): void;
  /** Reject a read of `path` with `err` (e.g. an EACCES/EIO error). */
  setReadError(path: string, err: NodeJS.ErrnoException): void;
  /** Control `stat(path)` result (for override-path guard tests). */
  setStat(path: string, descriptor: StatDescriptor | NodeJS.ErrnoException): void;
  /** Forget all registered paths (back to default no-ARC). */
  clear(): void;
}

function enoent(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: 'ENOENT' });
}

/**
 * Install the spy. Call once per test file (e.g. in `beforeAll`); use the
 * returned setters per test and `clear()` in `beforeEach`.
 */
export function installArcstatsFsMock(): ArcstatsFsMock {
  const realReadFile = fs.readFile.bind(fs);
  const realStat = fs.stat.bind(fs);
  const reads = new Map<string, string | NodeJS.ErrnoException>();
  const stats = new Map<string, StatDescriptor | NodeJS.ErrnoException>();
  const isArcCandidate = (p: string): boolean => ARC_CANDIDATE_PATHS.includes(p);

  vi.spyOn(fs, 'readFile').mockImplementation((async (p: unknown, ...rest: unknown[]) => {
    const key = String(p);
    if (reads.has(key)) {
      const v = reads.get(key)!;
      if (v instanceof Error) throw v;
      return v;
    }
    if (isArcCandidate(key)) throw enoent(key);
    return (realReadFile as (...a: unknown[]) => unknown)(p, ...rest);
  }) as unknown as typeof fs.readFile);

  vi.spyOn(fs, 'stat').mockImplementation((async (p: unknown, ...rest: unknown[]) => {
    const key = String(p);
    if (stats.has(key)) {
      const v = stats.get(key)!;
      if (v instanceof Error) throw v;
      return { isFile: () => v.isFile, size: v.size };
    }
    // A registered read with no explicit stat implies a small regular file.
    if (reads.has(key)) {
      const v = reads.get(key);
      const size = typeof v === 'string' ? Buffer.byteLength(v) : 0;
      return { isFile: () => true, size };
    }
    if (isArcCandidate(key)) throw enoent(key);
    return (realStat as (...a: unknown[]) => unknown)(p, ...rest);
  }) as unknown as typeof fs.stat);

  return {
    setRead: (path, content) => reads.set(path, content),
    setReadError: (path, err) => reads.set(path, err),
    setStat: (path, descriptor) => stats.set(path, descriptor),
    clear: () => { reads.clear(); stats.clear(); },
  };
}

/** Build a minimal arcstats kstat body with the given `size` and `c_min` rows. */
export function arcstatsBody(sizeRow: string | number, cMinRow: string | number): string {
  return [
    'name                            type data',
    `hits                            4    123456`,
    `c_min                           4    ${cMinRow}`,
    `size                            4    ${sizeRow}`,
    `c_max                           4    9999999999`,
    '',
  ].join('\n');
}
