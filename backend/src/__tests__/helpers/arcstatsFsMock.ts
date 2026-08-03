import { promises as fs } from 'fs';
import { vi } from 'vitest';
import { ARCSTATS_FIXED_PATHS, MEMINFO_FIXED_PATHS } from '../../helpers/hostMemory';

/**
 * Path-aware partial mock of `fs.promises` for ZFS arcstats and /proc/meminfo
 * reads.
 *
 * `helpers/hostMemory.ts` reads `/proc/spl/kstat/zfs/arcstats` (for ARC) and
 * `/proc/meminfo` (for VM ballooning). Tests may run on a ZFS host or a
 * ballooned VM, so real reads would make results host-dependent. This installs
 * a spy that intercepts ONLY registered/candidate paths and delegates every
 * other `readFile`/`stat` to the real filesystem, so `setupTestDb` and
 * `DatabaseService` keep working. Default behavior: candidates reject with
 * ENOENT, so consumers fall back to the plain `active/total` reading.
 */

// Sourced from the helper so the mock cannot silently drift from the paths the
// production code actually reads.
export const ARC_CANDIDATE_PATHS = ARCSTATS_FIXED_PATHS;

/** Second fixed ARC candidate; the default path ARC fixtures are served from. */
export const DEFAULT_ARC_PATH = ARC_CANDIDATE_PATHS[1];

/** Meminfo candidate paths (same source-of-truth import pattern as ARC). */
export const MEMINFO_CANDIDATE_PATHS = MEMINFO_FIXED_PATHS;

/** Default meminfo path for test fixtures. */
export const DEFAULT_MEMINFO_PATH = MEMINFO_CANDIDATE_PATHS[1];

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
  const isCandidatePath = (p: string): boolean =>
    ARC_CANDIDATE_PATHS.includes(p) || MEMINFO_CANDIDATE_PATHS.includes(p);

  vi.spyOn(fs, 'readFile').mockImplementation((async (p: unknown, ...rest: unknown[]) => {
    const key = String(p);
    if (reads.has(key)) {
      const v = reads.get(key)!;
      if (v instanceof Error) throw v;
      return v;
    }
    if (isCandidatePath(key)) throw enoent(key);
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
    if (isCandidatePath(key)) throw enoent(key);
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

/**
 * Build a realistic /proc/meminfo snippet with the given Balloon value in kB.
 * Pass undefined / a negative value to omit the Balloon line entirely.
 */
export function meminfoBody(balloonKb?: number): string {
  const balloonLine = balloonKb !== undefined && balloonKb >= 0
    ? `Balloon:           ${balloonKb} kB\n`
    : '';
  return [
    'MemTotal:       16433188 kB',
    'MemFree:          620452 kB',
    'MemAvailable:    3489624 kB',
    'Buffers:          158668 kB',
    'Cached:          3335960 kB',
    'SwapCached:            0 kB',
    'Active:          5280444 kB',
    'Inactive:        7478672 kB',
    balloonLine,
    'SwapTotal:       8388604 kB',
    'SwapFree:        8388604 kB',
    'Dirty:               124 kB',
    'Writeback:             0 kB',
    '',
  ].join('\n');
}
