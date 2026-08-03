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
  meminfoBody,
  DEFAULT_ARC_PATH,
  DEFAULT_MEMINFO_PATH,
  ARC_CANDIDATE_PATHS,
  MEMINFO_CANDIDATE_PATHS,
  type ArcstatsFsMock,
} from './helpers/arcstatsFsMock';

const mockMem = vi.fn();

vi.mock('systeminformation', () => ({
  default: { mem: (...args: unknown[]) => mockMem(...args) },
}));

import { getHostMemory, adjustForArc, adjustForBalloon, memoryToWire } from '../helpers/hostMemory';

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
  delete process.env.SENCHO_PROC_MEMINFO_PATH;
});

describe('adjustForArc', () => {
  it('reproduces active/total when reclaimable ARC is 0', () => {
    const result = adjustForArc(memSample(1000, 600), 0);
    expect(result).toEqual({ total: 1000, used: 400, free: 600, usagePercent: 40 });
    expect('arcReclaimable' in result).toBe(false);
  });

  it('adds reclaimable ARC back into available, lowering usage', () => {
    const result = adjustForArc(memSample(1000, 600), 200);
    expect(result).toEqual({ total: 1000, used: 200, free: 800, usagePercent: 20, arcReclaimable: 200 });
  });

  it('clamps effective available to total when ARC exceeds the gap', () => {
    const result = adjustForArc(memSample(1000, 600), 5000);
    expect(result).toEqual({ total: 1000, used: 0, free: 1000, usagePercent: 0, arcReclaimable: 5000 });
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
    expect(result).toEqual({ total: 1000, used: 200, free: 800, usagePercent: 20, arcReclaimable: 200 });
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

describe('adjustForBalloon', () => {
  const arcAdjusted = (total: number, used: number, free: number, usagePercent: number): ReturnType<typeof adjustForArc> =>
    ({ total, used, free, usagePercent });

  it('returns the input unchanged when ballooned is 0', () => {
    const input = arcAdjusted(1000, 400, 600, 40);
    const result = adjustForBalloon(input, 0);
    expect(result).toBe(input); // identity for zero
  });

  it('returns the input unchanged when ballooned is negative', () => {
    const input = arcAdjusted(1000, 400, 600, 40);
    const result = adjustForBalloon(input, -5);
    expect(result).toBe(input);
  });

  it('subtracts ballooned from used, adds to free, sets optional fields', () => {
    const input = arcAdjusted(1000, 400, 600, 40);
    const result = adjustForBalloon(input, 200);
    expect(result.ballooned).toBe(200);
    expect(result.effectiveTotal).toBe(1000);
    expect(result.effectiveUsed).toBe(200);  // 400 - 200
    expect(result.effectiveFree).toBe(800);  // 600 + 200
    expect(result.effectiveUsagePercent).toBe(20); // 200 / 1000 * 100
    expect(result.balloonSource).toBe('linux_proc_meminfo');
    // Base fields unchanged.
    expect(result.total).toBe(1000);
    expect(result.used).toBe(400);
    expect(result.free).toBe(600);
  });

  it('clamps effectiveUsed at 0 when balloon exceeds used', () => {
    const input = arcAdjusted(1000, 100, 900, 10);
    const result = adjustForBalloon(input, 5000);
    expect(result.effectiveUsed).toBe(0);
    expect(result.effectiveFree).toBe(1000);
    expect(result.effectiveUsagePercent).toBe(0);
  });

  it('handles zero total gracefully', () => {
    const input = arcAdjusted(0, 0, 0, 0);
    const result = adjustForBalloon(input, 100);
    expect(result.effectiveUsagePercent).toBe(0);
  });
});

describe('getHostMemory balloon discovery', () => {
  it('returns the base ARC-adjusted shape when no meminfo is present', async () => {
    mockMem.mockResolvedValue(memSample(1000, 600));
    const result = await getHostMemory();
    expect(result).toEqual({ total: 1000, used: 400, free: 600, usagePercent: 40 });
  });

  it('returns the base ARC-adjusted shape when Balloon is missing from meminfo', async () => {
    mockMem.mockResolvedValue(memSample(1000, 600));
    arcFs.setRead(DEFAULT_MEMINFO_PATH, meminfoBody()); // no Balloon line
    const result = await getHostMemory();
    expect(result).toEqual({ total: 1000, used: 400, free: 600, usagePercent: 40 });
  });

  it('returns the base ARC-adjusted shape when Balloon is 0 kB', async () => {
    mockMem.mockResolvedValue(memSample(1000, 600));
    arcFs.setRead(DEFAULT_MEMINFO_PATH, meminfoBody(0));
    const result = await getHostMemory();
    expect(result).toEqual({ total: 1000, used: 400, free: 600, usagePercent: 40 });
  });

  it('subtracts ballooned memory and sets optional fields', async () => {
    mockMem.mockResolvedValue(memSample(16000, 4000)); // 16 GB total, 4 GB available → 75% used
    // 4 GiB balloon = 4194304 kB
    arcFs.setRead(DEFAULT_MEMINFO_PATH, meminfoBody(4_194_304));
    const result = await getHostMemory();
    // ARC=0, available=4000: used=12000
    // ballooned=4194304*1024 = 4_294_967_296 bytes
    // effectiveUsed = 12000 - ballooned ≈ 7705 MB
    expect(result.used).toBe(12000);
    expect(typeof result.ballooned).toBe('number');
    expect(result.ballooned!).toBeGreaterThan(0);
    expect(result.effectiveUsed).toBeDefined();
    expect(result.effectiveFree).toBeDefined();
    expect(result.effectiveUsagePercent).toBeDefined();
    expect(result.effectiveUsed!).toBeLessThan(result.used);
    expect(result.balloonSource).toBe('linux_proc_meminfo');
  });

  it('combines ARC reclaim and balloon adjustment', async () => {
    mockMem.mockResolvedValue(memSample(16000, 2000)); // 12.5% available
    arcFs.setRead(DEFAULT_ARC_PATH, arcstatsBody(5000, 1000)); // reclaimable ARC = 4000
    arcFs.setRead(DEFAULT_MEMINFO_PATH, meminfoBody(2_097_152)); // 2 GiB balloon
    const result = await getHostMemory();
    // ARC-adjusted: used = 16000 - (2000 + 4000) = 10000
    expect(result.used).toBe(10000);
    expect(result.arcReclaimable).toBe(4000);
    // Balloon-adjusted: effectiveUsed = 10000 - 2GiB
    expect(result.effectiveUsed).toBeDefined();
    expect(result.effectiveUsed!).toBeLessThan(result.used);
  });

  it('prefers the meminfo override path', async () => {
    process.env.SENCHO_PROC_MEMINFO_PATH = '/custom/meminfo';
    mockMem.mockResolvedValue(memSample(16000, 4000));
    arcFs.setRead('/custom/meminfo', meminfoBody(4_194_304)); // 4 GiB balloon
    arcFs.setRead(DEFAULT_MEMINFO_PATH, meminfoBody(0));      // fixed path says no balloon
    const result = await getHostMemory();
    expect(result.ballooned).toBeGreaterThan(0); // override won
  });

  it('falls through to a fixed meminfo path when the override is unreadable', async () => {
    process.env.SENCHO_PROC_MEMINFO_PATH = '/custom/meminfo';
    mockMem.mockResolvedValue(memSample(16000, 4000));
    arcFs.setReadError('/custom/meminfo', Object.assign(new Error('nope'), { code: 'ENOENT' }));
    arcFs.setRead(DEFAULT_MEMINFO_PATH, meminfoBody(2_097_152)); // 2 GiB
    const result = await getHostMemory();
    expect(result.ballooned).toBeGreaterThan(0); // fell through to fixed
  });

  it('reads the host-mounted meminfo candidate and prefers it over /proc', async () => {
    mockMem.mockResolvedValue(memSample(16000, 4000));
    arcFs.setRead(MEMINFO_CANDIDATE_PATHS[0], meminfoBody(4_194_304)); // /host/proc: 4 GiB
    arcFs.setRead(MEMINFO_CANDIDATE_PATHS[1], meminfoBody(1_048_576)); // /proc: 1 GiB
    const result = await getHostMemory();
    // First candidate wins: 4 GiB balloon.
    expect(result.ballooned).toBeGreaterThan(0);
    expect(result.effectiveUsed).toBeDefined();
  });

  it('skips an override path that is not a regular file', async () => {
    process.env.SENCHO_PROC_MEMINFO_PATH = '/custom/meminfo';
    mockMem.mockResolvedValue(memSample(1000, 600));
    arcFs.setStat('/custom/meminfo', { isFile: false, size: 10 });
    arcFs.setRead('/custom/meminfo', meminfoBody(100));
    const result = await getHostMemory();
    expect(result.used).toBe(400); // override skipped, no meminfo on fixed
  });

  it('skips an override path that exceeds the size bound', async () => {
    process.env.SENCHO_PROC_MEMINFO_PATH = '/custom/meminfo';
    mockMem.mockResolvedValue(memSample(1000, 600));
    arcFs.setStat('/custom/meminfo', { isFile: true, size: 2 * 1024 * 1024 });
    arcFs.setRead('/custom/meminfo', meminfoBody(100));
    const result = await getHostMemory();
    expect(result.used).toBe(400);
  });

  it.each([
    ['non-numeric value', 'Balloon:       abc kB\n'],
    ['negative value', 'Balloon:       -100 kB\n'],
    ['no kB suffix', 'Balloon:       100\n'],
    ['wrong suffix', 'Balloon:       100 MB\n'],
    ['extra token', 'Balloon:       100 kB extra\n'],
  ])('treats a %s Balloon line as unusable and yields no balloon', async (_label, body) => {
    mockMem.mockResolvedValue(memSample(1000, 600));
    arcFs.setRead(DEFAULT_MEMINFO_PATH, body);
    const result = await getHostMemory();
    expect(result).toEqual({ total: 1000, used: 400, free: 600, usagePercent: 40 });
  });

  it('fails open (balloon 0) on a read error', async () => {
    mockMem.mockResolvedValue(memSample(1000, 600));
    arcFs.setReadError(DEFAULT_MEMINFO_PATH, Object.assign(new Error('nope'), { code: 'EACCES' }));
    const result = await getHostMemory();
    expect(result.used).toBe(400);
  });

  it('logs an unexpected meminfo read error once per code', async () => {
    mockMem.mockResolvedValue(memSample(1000, 600));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Expected fs error: silent fall-through.
    arcFs.setReadError(MEMINFO_CANDIDATE_PATHS[0], Object.assign(new Error('denied'), { code: 'EACCES' }));
    arcFs.setReadError(MEMINFO_CANDIDATE_PATHS[1], Object.assign(new Error('denied'), { code: 'EACCES' }));
    await getHostMemory();
    expect(warn).not.toHaveBeenCalled();

    // Unexpected fs error: logged once. Use EBADF to avoid collision with
    // the ARC test suite's own EIO trigger (loggedErrorCodes is shared).
    arcFs.setReadError(MEMINFO_CANDIDATE_PATHS[0], Object.assign(new Error('badf'), { code: 'EBADF' }));
    arcFs.setReadError(MEMINFO_CANDIDATE_PATHS[1], Object.assign(new Error('badf'), { code: 'EBADF' }));
    await getHostMemory();
    await getHostMemory();
    const unexpectedLogs = warn.mock.calls.filter(([msg]) => String(msg).includes('EBADF'));
    expect(unexpectedLogs).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('memoryToWire', () => {
  it('includes arcReclaimable when present on the HostMemory object', () => {
    const wire = memoryToWire({ total: 1000, used: 400, free: 600, usagePercent: 40, arcReclaimable: 300 });
    expect(wire.arcReclaimable).toBe(300);
    expect(wire.total).toBe(1000);
  });

  it('omits arcReclaimable when absent from the HostMemory object', () => {
    const wire = memoryToWire({ total: 1000, used: 400, free: 600, usagePercent: 40 });
    expect('arcReclaimable' in wire).toBe(false);
  });

  it('includes both arcReclaimable and balloon fields when both are present', () => {
    const hostMem = adjustForBalloon(
      { total: 16000, used: 10000, free: 6000, usagePercent: 62.5, arcReclaimable: 4000 },
      2_147_483_648, // 2 GiB
    );
    const wire = memoryToWire(hostMem);
    expect(wire.arcReclaimable).toBe(4000);
    expect(wire.ballooned).toBe(2_147_483_648);
    expect(wire.effectiveUsed).toBeDefined();
    expect(wire.effectiveUsagePercent).toBeDefined();
  });
});

describe('getHostMemory ARC surfacing end-to-end', () => {
  it('surfaces arcReclaimable through memoryToWire with mocked arcstats', async () => {
    mockMem.mockResolvedValue(memSample(1000, 600));
    arcFs.setRead(DEFAULT_ARC_PATH, arcstatsBody(300, 100)); // reclaimable 200
    const result = await getHostMemory();
    expect(result.arcReclaimable).toBe(200);
    const wire = memoryToWire(result);
    expect(wire.arcReclaimable).toBe(200);
  });

  it('surfaces both arcReclaimable and balloon fields through memoryToWire', async () => {
    mockMem.mockResolvedValue(memSample(16000, 2000));
    arcFs.setRead(DEFAULT_ARC_PATH, arcstatsBody(5000, 1000)); // reclaimable 4000
    arcFs.setRead(DEFAULT_MEMINFO_PATH, meminfoBody(2_097_152)); // 2 GiB balloon
    const result = await getHostMemory();
    expect(result.arcReclaimable).toBe(4000);
    const wire = memoryToWire(result);
    expect(wire.arcReclaimable).toBe(4000);
    expect(wire.ballooned).toBeGreaterThan(0);
    expect(wire.effectiveUsed).toBeDefined();
  });
});

afterEach(() => {
  delete process.env.SENCHO_ZFS_ARCSTATS_PATH;
  delete process.env.SENCHO_PROC_MEMINFO_PATH;
});
