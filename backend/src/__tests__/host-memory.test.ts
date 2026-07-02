/**
 * Unit tests for the ZFS ARC-aware host-memory helper.
 *
 * `adjustForArc` is exercised directly; `readReclaimableArc` and
 * `parseArcstats` stay module-internal and are exercised through
 * `getHostMemory` with a path-aware fs mock (see helpers/arcstatsFsMock.ts).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import {
  installArcstatsFsMock,
  arcstatsBody,
  DEFAULT_ARC_PATH,
  ARC_CANDIDATE_PATHS,
  type ArcstatsFsMock,
} from './helpers/arcstatsFsMock';

const mockMem = vi.fn();

vi.mock('systeminformation', () => ({
  default: { mem: (...args: unknown[]) => mockMem(...args) },
}));

import { getHostMemory, adjustForArc } from '../helpers/hostMemory';

// mem.active === total - available on Linux, so used/free below mirror the
// real systeminformation shape the helper consumes.
const memSample = (total: number, available: number) => ({
  total,
  available,
  active: total - available,
  used: total - available,
  free: available,
  buffcache: 0,
});

let arcFs: ArcstatsFsMock;

beforeAll(() => {
  arcFs = installArcstatsFsMock();
});

beforeEach(() => {
  arcFs.clear();
  mockMem.mockReset();
  delete process.env.SENCHO_ZFS_ARCSTATS_PATH;
});

describe('adjustForArc', () => {
  it('reproduces active/total when reclaimable ARC is 0', () => {
    const result = adjustForArc(memSample(1000, 600), 0);
    expect(result).toEqual({ total: 1000, used: 400, free: 600, usagePercent: 40 });
  });

  it('adds reclaimable ARC back into available, lowering usage', () => {
    const result = adjustForArc(memSample(1000, 600), 200);
    expect(result).toEqual({ total: 1000, used: 200, free: 800, usagePercent: 20 });
  });

  it('clamps effective available to total when ARC exceeds the gap', () => {
    const result = adjustForArc(memSample(1000, 600), 5000);
    expect(result).toEqual({ total: 1000, used: 0, free: 1000, usagePercent: 0 });
  });

  it('guards against a zero total', () => {
    const result = adjustForArc(memSample(0, 0), 0);
    expect(result.usagePercent).toBe(0);
  });
});

describe('getHostMemory ARC discovery', () => {
  it('falls back to active/total when no ARC stats are present', async () => {
    mockMem.mockResolvedValue(memSample(1000, 600));
    const result = await getHostMemory();
    expect(result).toEqual({ total: 1000, used: 400, free: 600, usagePercent: 40 });
  });

  it('subtracts reclaimable ARC (size - c_min) from used', async () => {
    mockMem.mockResolvedValue(memSample(1000, 600));
    arcFs.setRead(DEFAULT_ARC_PATH, arcstatsBody(300, 100)); // reclaimable 200
    const result = await getHostMemory();
    expect(result).toEqual({ total: 1000, used: 200, free: 800, usagePercent: 20 });
  });

  it('prefers the operator override path over the fixed candidates', async () => {
    process.env.SENCHO_ZFS_ARCSTATS_PATH = '/custom/arcstats';
    mockMem.mockResolvedValue(memSample(2000, 600));
    arcFs.setRead('/custom/arcstats', arcstatsBody(500, 100)); // reclaimable 400
    arcFs.setRead(DEFAULT_ARC_PATH, arcstatsBody(300, 100));   // fixed would be 200
    const result = await getHostMemory();
    expect(result.used).toBe(1000); // 2000 - (600 + 400 override); fixed would give 1200
    expect(result.free).toBe(1000);
  });

  it('reads the host-mounted candidate and prefers it over /proc', async () => {
    // ARC_CANDIDATE_PATHS[0] is /host/proc/..., the path docker-compose mounts
    // into the container, so this covers the real deployment path and precedence.
    mockMem.mockResolvedValue(memSample(2000, 600));
    arcFs.setRead(ARC_CANDIDATE_PATHS[0], arcstatsBody(500, 100)); // /host/proc: reclaimable 400
    arcFs.setRead(ARC_CANDIDATE_PATHS[1], arcstatsBody(300, 100)); // /proc: would be 200
    const result = await getHostMemory();
    expect(result.used).toBe(1000); // 2000 - (600 + 400); /proc winning would give 1200
  });

  it('falls through to a fixed candidate when the override is unreadable', async () => {
    process.env.SENCHO_ZFS_ARCSTATS_PATH = '/custom/arcstats';
    mockMem.mockResolvedValue(memSample(1000, 600));
    arcFs.setReadError('/custom/arcstats', Object.assign(new Error('nope'), { code: 'ENOENT' }));
    arcFs.setRead(DEFAULT_ARC_PATH, arcstatsBody(300, 100)); // reclaimable 200
    const result = await getHostMemory();
    expect(result.used).toBe(200);
  });

  it('resolves immediately to 0 reclaimable when size < c_min (ARC at floor)', async () => {
    mockMem.mockResolvedValue(memSample(1000, 600));
    arcFs.setRead(DEFAULT_ARC_PATH, arcstatsBody(50, 100)); // size < c_min
    const result = await getHostMemory();
    expect(result).toEqual({ total: 1000, used: 400, free: 600, usagePercent: 40 });
  });

  it.each([
    ['non-numeric size', arcstatsBody('abc', 100)],
    ['negative size', arcstatsBody(-5, 100)],
    ['non-numeric c_min', arcstatsBody(300, 'xyz')],
    ['negative c_min', arcstatsBody(300, -5)],
    ['missing c_min', 'size                            4    300\n'],
    ['missing size', 'c_min                           4    100\n'],
    ['empty file', '   \n'],
  ])('treats a %s record as unusable and yields no ARC', async (_label, body) => {
    mockMem.mockResolvedValue(memSample(1000, 600));
    arcFs.setRead(DEFAULT_ARC_PATH, body);
    const result = await getHostMemory();
    expect(result.used).toBe(400); // fell through to active/total
  });

  it.each([
    ['EACCES', 'EACCES'],
    ['EIO', 'EIO'],
    ['EMFILE', 'EMFILE'],
  ])('fails open (ARC 0) on a %s read error', async (_label, code) => {
    mockMem.mockResolvedValue(memSample(1000, 600));
    arcFs.setReadError(DEFAULT_ARC_PATH, Object.assign(new Error(code), { code }));
    const result = await getHostMemory();
    expect(result.used).toBe(400);
  });

  it('logs an unexpected read error (once per code) but stays silent on an expected one', async () => {
    mockMem.mockResolvedValue(memSample(1000, 600));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Expected fs error: silent fall-through.
    arcFs.setReadError(ARC_CANDIDATE_PATHS[0], Object.assign(new Error('denied'), { code: 'EACCES' }));
    arcFs.setReadError(ARC_CANDIDATE_PATHS[1], Object.assign(new Error('denied'), { code: 'EACCES' }));
    await getHostMemory();
    expect(warn).not.toHaveBeenCalled();

    // Unexpected fs error: logged, but only once per error code across calls.
    // Uses a code no other test triggers, since the once-per-code memo is
    // process-global.
    arcFs.setReadError(ARC_CANDIDATE_PATHS[0], Object.assign(new Error('stale'), { code: 'ESTALE' }));
    arcFs.setReadError(ARC_CANDIDATE_PATHS[1], Object.assign(new Error('stale'), { code: 'ESTALE' }));
    await getHostMemory();
    await getHostMemory();
    const unexpectedLogs = warn.mock.calls.filter(([msg]) => String(msg).includes('ESTALE'));
    expect(unexpectedLogs).toHaveLength(1);
    warn.mockRestore();
  });

  it('skips an override path that is not a regular file', async () => {
    process.env.SENCHO_ZFS_ARCSTATS_PATH = '/custom/arcstats';
    mockMem.mockResolvedValue(memSample(1000, 600));
    arcFs.setStat('/custom/arcstats', { isFile: false, size: 10 });
    arcFs.setRead('/custom/arcstats', arcstatsBody(500, 100));
    const result = await getHostMemory();
    expect(result.used).toBe(400); // override skipped, no fixed ARC present
  });

  it('skips an override path that exceeds the size bound', async () => {
    process.env.SENCHO_ZFS_ARCSTATS_PATH = '/custom/arcstats';
    mockMem.mockResolvedValue(memSample(1000, 600));
    arcFs.setStat('/custom/arcstats', { isFile: true, size: 2 * 1024 * 1024 });
    arcFs.setRead('/custom/arcstats', arcstatsBody(500, 100));
    const result = await getHostMemory();
    expect(result.used).toBe(400);
  });

  it('logs the selected path once and never the file contents', async () => {
    process.env.SENCHO_ZFS_ARCSTATS_PATH = '/log-once/arcstats';
    mockMem.mockResolvedValue(memSample(1000, 600));
    arcFs.setRead('/log-once/arcstats', arcstatsBody(300, 100));
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    await getHostMemory();
    await getHostMemory();
    const pathLogs = debug.mock.calls.filter(([msg]) => String(msg).includes('/log-once/arcstats'));
    expect(pathLogs).toHaveLength(1);
    // The log names the path, never the kstat contents (size / c_min values).
    expect(String(pathLogs[0][0])).not.toContain('300');
    expect(String(pathLogs[0][0])).not.toContain('100');
    debug.mockRestore();
  });
});

afterEach(() => {
  delete process.env.SENCHO_ZFS_ARCSTATS_PATH;
});
