/**
 * Unit tests for the host-scoped CPU / memory sample.
 *
 * The interesting case is a Sencho container nested inside an LXC: the kernel
 * it can see belongs to the outer machine, while `docker info` describes the
 * LXC. These tests pin the agreement rule for each dimension, the cgroup v2
 * fallback, and the unknown state (never a number from the outer machine).
 *
 * Reads go through the path-aware fs mock shared with host-memory tests, so
 * both `/proc/meminfo` and the cgroup fixture tree are deterministic.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import {
  installArcstatsFsMock,
  type ArcstatsFsMock,
} from './helpers/arcstatsFsMock';

const { mockCurrentLoad, mockMem, mockFsSize, mockDockerInfo } = vi.hoisted(() => ({
  mockCurrentLoad: vi.fn(),
  mockMem: vi.fn(),
  mockFsSize: vi.fn(),
  mockDockerInfo: vi.fn(),
}));

vi.mock('systeminformation', () => ({
  default: {
    currentLoad: (...args: unknown[]) => mockCurrentLoad(...args),
    mem: (...args: unknown[]) => mockMem(...args),
    fsSize: (...args: unknown[]) => mockFsSize(...args),
  },
}));

vi.mock('../services/NodeRegistry', () => ({
  NodeRegistry: {
    getInstance: () => ({
      getDocker: () => ({ info: mockDockerInfo }),
    }),
  },
}));

import {
  readLocalHostSample,
  hostSampleToWire,
  readDockerCapacity,
  computeCpuPercent,
  countCpusetCpus,
  _resetHostSampleStateForTests,
  HOST_CGROUP_FIXED_PATH,
} from '../helpers/hostSample';
import { CacheService } from '../services/CacheService';

const GiB = 1024 ** 3;
const KERNEL_TOTAL = 16 * GiB;
const NODE_ID = 7;

const CGROUP = '/fixture/cgroup';

function setKernel(opts: { cores?: number; total?: number; cpuPercent?: number } = {}) {
  const cores = opts.cores ?? 8;
  mockCurrentLoad.mockResolvedValue({
    currentLoad: opts.cpuPercent ?? 12.34,
    cpus: Array.from({ length: cores }, () => ({})),
  });
  const total = opts.total ?? KERNEL_TOTAL;
  mockMem.mockResolvedValue({
    total,
    available: total * 0.75,
    active: total * 0.25,
    used: total * 0.25,
    free: total * 0.75,
    buffcache: 0,
  });
  mockFsSize.mockResolvedValue([
    { fs: '/dev/sda1', mount: '/', size: 100 * GiB, used: 40 * GiB, available: 60 * GiB, use: 40 },
  ]);
}

/** A cgroup v2 tree with CPU and memory counters. */
function setCgroup(opts: {
  cpus?: string;
  cpuUsecSequence?: number[];
  memoryMax?: string;
  memoryCurrent?: number;
  inactiveFile?: number;
  omit?: Array<'controllers' | 'cpu.stat' | 'cpuset' | 'memory.max' | 'memory.current' | 'memory.stat' | 'inactive_file'>;
} = {}) {
  const omit = new Set(opts.omit ?? []);
  if (!omit.has('controllers')) arcFs.setRead(`${CGROUP}/cgroup.controllers`, 'cpuset cpu memory\n');
  if (!omit.has('cpuset')) arcFs.setRead(`${CGROUP}/cpuset.cpus.effective`, `${opts.cpus ?? '0-1'}\n`);
  if (!omit.has('cpu.stat')) {
    const sequence = opts.cpuUsecSequence ?? [1_000_000, 1_000_000];
    arcFs.setReadSequence(`${CGROUP}/cpu.stat`, sequence.map((usec) => `usage_usec ${usec}\nuser_usec 0\n`));
  }
  if (!omit.has('memory.max')) arcFs.setRead(`${CGROUP}/memory.max`, `${opts.memoryMax ?? String(4 * GiB)}\n`);
  if (!omit.has('memory.current')) arcFs.setRead(`${CGROUP}/memory.current`, `${opts.memoryCurrent ?? 2 * GiB}\n`);
  if (!omit.has('memory.stat')) {
    const inactiveLine = omit.has('inactive_file') ? '' : `inactive_file ${opts.inactiveFile ?? 512 * 1024 * 1024}\n`;
    arcFs.setRead(`${CGROUP}/memory.stat`, `anon ${GiB}\n${inactiveLine}active_file ${GiB}\n`);
  }
}

let arcFs: ArcstatsFsMock;

beforeAll(() => {
  arcFs = installArcstatsFsMock();
});

beforeEach(() => {
  mockCurrentLoad.mockReset();
  mockMem.mockReset();
  mockFsSize.mockReset();
  mockDockerInfo.mockReset();
  arcFs.clear();
  CacheService.getInstance().flush();
  _resetHostSampleStateForTests();
  delete process.env.SENCHO_HOST_CGROUP_PATH;
  setKernel();
  mockDockerInfo.mockResolvedValue({ NCPU: 8, MemTotal: KERNEL_TOTAL });
});

afterEach(() => {
  delete process.env.SENCHO_HOST_CGROUP_PATH;
});

describe('readLocalHostSample when Docker and the kernel agree', () => {
  it('keeps the kernel numbers and the exact wire shape', async () => {
    const wire = hostSampleToWire(await readLocalHostSample(NODE_ID));
    expect(wire).toEqual({
      cpu: { usage: '12.3', cores: 8 },
      memory: { total: KERNEL_TOTAL, used: 4 * GiB, free: 12 * GiB, usagePercent: '25.0' },
      disk: {
        fs: '/dev/sda1',
        mount: '/',
        total: 100 * GiB,
        used: 40 * GiB,
        free: 60 * GiB,
        usagePercent: '40.0',
      },
    });
  });

  it('treats a memory total within 2% as agreement', async () => {
    mockDockerInfo.mockResolvedValue({ NCPU: 8, MemTotal: Math.round(KERNEL_TOTAL * 1.01) });
    const wire = hostSampleToWire(await readLocalHostSample(NODE_ID));
    expect(wire.cpu.cores).toBe(8);
    expect(wire.memory.total).toBe(KERNEL_TOTAL);
    expect(wire.memory.usagePercent).toBe('25.0');
  });

  it('treats an exact 2% difference as agreement', async () => {
    setKernel({ total: 1000 });
    mockDockerInfo.mockResolvedValue({ NCPU: 8, MemTotal: 1020 });
    const wire = hostSampleToWire(await readLocalHostSample(NODE_ID));
    expect(wire.memory.total).toBe(1000);
  });

  it('treats a memory total beyond 2% as a nested host', async () => {
    mockDockerInfo.mockResolvedValue({ NCPU: 8, MemTotal: Math.round(KERNEL_TOTAL * 1.03) });
    const wire = hostSampleToWire(await readLocalHostSample(NODE_ID));
    expect(wire.memory.total).toBe(Math.round(KERNEL_TOTAL * 1.03));
    expect(wire.memory.used).toBeNull();
    expect(wire.memory.usagePercent).toBeNull();
  });

  it('keeps the raw disk percentage internal and the wire one-decimal', async () => {
    mockFsSize.mockResolvedValue([
      { fs: '/dev/sda1', mount: '/', size: 100 * GiB, used: 85.04 * GiB, available: 14.96 * GiB, use: 85.04 },
    ]);
    const sample = await readLocalHostSample(NODE_ID);
    // Threshold alerts compare the raw value so 85.04% trips an 85% limit.
    expect(sample.disk?.use).toBe(85.04);
    const wire = hostSampleToWire(sample);
    expect(wire.disk?.usagePercent).toBe('85.0');
    expect(wire.disk).not.toHaveProperty('use');
  });
});

describe('readDockerCapacity', () => {
  it('falls back to the kernel view when the first docker info probe rejects, logging once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mockDockerInfo.mockRejectedValue(Object.assign(new Error('no socket'), { name: 'Enoent' }));
      const wire = hostSampleToWire(await readLocalHostSample(NODE_ID));
      expect(wire.cpu.cores).toBe(8);
      expect(wire.cpu.usage).toBe('12.3');
      expect(wire.memory.total).toBe(KERNEL_TOTAL);

      // The failure is not cached: a later poll retries the daemon instead of
      // replaying a 30s-old failure, while the warning stays one per code.
      await readLocalHostSample(NODE_ID);
      expect(mockDockerInfo).toHaveBeenCalledTimes(2);
      const failureLogs = warn.mock.calls.filter((call) => String(call[0]).includes('docker info unavailable'));
      expect(failureLogs).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('falls back when docker info never answers inside the bound', async () => {
    vi.useFakeTimers();
    try {
      mockDockerInfo.mockReturnValue(new Promise(() => {}));
      const pending = readLocalHostSample(NODE_ID);
      await vi.advanceTimersByTimeAsync(3_001);
      const wire = hostSampleToWire(await pending);
      expect(wire.cpu.cores).toBe(8);
      expect(wire.cpu.usage).toBe('12.3');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last good nested capacity through a daemon stall', async () => {
    // The host was nested when the daemon last answered: 2 cores, 4 GiB.
    mockDockerInfo.mockResolvedValue({ NCPU: 2, MemTotal: 4 * GiB });
    const first = hostSampleToWire(await readLocalHostSample(NODE_ID));
    expect(first.cpu).toEqual({ usage: null, cores: 2 });
    expect(first.memory).toEqual({ total: 4 * GiB, used: null, free: null, usagePercent: null });

    const startedAt = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(startedAt + 31_000);
    try {
      mockDockerInfo.mockRejectedValue(Object.assign(new Error('stalled'), { name: 'TimeoutError' }));

      // A stalled daemon must not flip the node back to the 8-core, 16 GiB
      // kernel view, and must not alert on those numbers.
      const stalled = hostSampleToWire(await readLocalHostSample(NODE_ID));
      expect(stalled.cpu).toEqual({ usage: null, cores: 2 });
      expect(stalled.memory).toEqual({ total: 4 * GiB, used: null, free: null, usagePercent: null });

      // The failure is not cached as a null fallback: while the probe is
      // throttled, the last good capacity keeps being served, and once the
      // short retry window passes the daemon is probed again.
      await readLocalHostSample(NODE_ID);
      expect(mockDockerInfo).toHaveBeenCalledTimes(2);

      nowSpy.mockReturnValue(startedAt + 31_000 + 6_000);
      mockDockerInfo.mockResolvedValue({ NCPU: 4, MemTotal: 8 * GiB });
      const recovered = hostSampleToWire(await readLocalHostSample(NODE_ID));
      expect(mockDockerInfo).toHaveBeenCalledTimes(3);
      expect(recovered.cpu.cores).toBe(4);
      expect(recovered.memory.total).toBe(8 * GiB);
    } finally {
      nowSpy.mockRestore();
    }
  });


  it('does not let a joined stale read clear the retry throttle', async () => {
    mockDockerInfo.mockResolvedValue({ NCPU: 2, MemTotal: 4 * GiB });
    await readLocalHostSample(NODE_ID); // one good probe

    const startedAt = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(startedAt + 31_000);
    try {
      mockDockerInfo.mockRejectedValue(Object.assign(new Error('stalled'), { name: 'TimeoutError' }));
      const [first, joined] = await Promise.all([
        readLocalHostSample(NODE_ID),
        readLocalHostSample(NODE_ID),
      ]);
      expect(first.cpu.usage.kind).toBe('unknown');
      expect(joined.cpu.usage.kind).toBe('unknown');
      // One failed probe served both callers.
      expect(mockDockerInfo).toHaveBeenCalledTimes(2);

      // The joining caller must not clear the throttle the owner set.
      await readLocalHostSample(NODE_ID);
      expect(mockDockerInfo).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('caches capacity for 30s per node', async () => {
    await readDockerCapacity(NODE_ID);
    await readDockerCapacity(NODE_ID);
    expect(mockDockerInfo).toHaveBeenCalledTimes(1);
  });

  it('falls through when NCPU or MemTotal is unusable', async () => {
    mockDockerInfo.mockResolvedValue({ NCPU: 0, MemTotal: 0 });
    expect(await readDockerCapacity(NODE_ID)).toBeNull();
    const wire = hostSampleToWire(await readLocalHostSample(NODE_ID));
    expect(wire.cpu.cores).toBe(8);
  });
});

describe('nested host: capacity from Docker, usage from the cgroup', () => {
  beforeEach(() => {
    // The Docker host is a 2-core, 4 GiB LXC; the kernel view is the 8-core,
    // 16 GiB Proxmox machine.
    mockDockerInfo.mockResolvedValue({ NCPU: 2, MemTotal: 4 * GiB });
    process.env.SENCHO_HOST_CGROUP_PATH = CGROUP;
  });

  it('reports Docker cores and memory total with no trusted usage source', async () => {
    setKernel(); // no cgroup fixture registered
    const wire = hostSampleToWire(await readLocalHostSample(NODE_ID));
    expect(wire.cpu).toEqual({ usage: null, cores: 2 });
    expect(wire.memory).toEqual({ total: 4 * GiB, used: null, free: null, usagePercent: null });
  });

  it('serves the kernel view to a reader that cannot render unknown', async () => {
    setKernel(); // no cgroup fixture registered
    const wire = hostSampleToWire(await readLocalHostSample(NODE_ID), { allowUnknown: false });
    // A hub older than nullable usage keeps today's numeric shape instead of
    // rendering null as NaN%/Critical; the scoped dimensions are still used
    // when they can be measured.
    expect(wire.cpu).toEqual({ usage: '12.3', cores: 8 });
    expect(wire.memory).toEqual({
      total: KERNEL_TOTAL,
      used: 4 * GiB,
      free: 12 * GiB,
      usagePercent: '25.0',
    });
  });

  it('keeps measured nested usage for a legacy reader', async () => {
    setCgroup({ cpuUsecSequence: [1_000_000, 1_050_000], memoryCurrent: 2 * GiB });
    const wire = hostSampleToWire(await readLocalHostSample(NODE_ID), { allowUnknown: false });
    expect(wire.cpu.cores).toBe(2);
    expect(wire.memory.total).toBe(4 * GiB);
    expect(wire.memory.usagePercent).toBe('37.5');
  });


  it('measures CPU from the cgroup counter, taking a second reading on the first call', async () => {
    setCgroup({ cpuUsecSequence: [1_000_000, 1_050_000] });
    const sample = await readLocalHostSample(NODE_ID);
    expect(sample.cpu.cores).toBe(2);
    expect(sample.cpu.usage.kind).toBe('measured');
    if (sample.cpu.usage.kind !== 'measured') throw new Error('expected a measured CPU reading');
    expect(sample.cpu.usage.source).toBe('cgroup');
    // 50ms of CPU time over a ~250ms window across 2 cores is ~10%.
    expect(sample.cpu.usage.value).toBeGreaterThan(0);
    expect(sample.cpu.usage.value).toBeLessThan(50);
    expect(arcFs.readCount(`${CGROUP}/cpu.stat`)).toBe(2);
  });

  it('reuses the shared window on the next call instead of sampling twice', async () => {
    setCgroup({ cpuUsecSequence: [1_000_000, 1_050_000, 1_100_000] });
    await readLocalHostSample(NODE_ID);
    expect(arcFs.readCount(`${CGROUP}/cpu.stat`)).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = await readLocalHostSample(NODE_ID);
    expect(arcFs.readCount(`${CGROUP}/cpu.stat`)).toBe(3);
    if (second.cpu.usage.kind !== 'measured') throw new Error('expected a measured CPU reading');
    expect(second.cpu.usage.value).toBeGreaterThan(0);
  });

  it('measures memory as current minus inactive page cache', async () => {
    setCgroup({ memoryCurrent: 2 * GiB, inactiveFile: 512 * 1024 * 1024 });
    const wire = hostSampleToWire(await readLocalHostSample(NODE_ID));
    expect(wire.memory.total).toBe(4 * GiB);
    expect(wire.memory.used).toBe(1.5 * GiB);
    expect(wire.memory.free).toBe(2.5 * GiB);
    expect(wire.memory.usagePercent).toBe('37.5');
    // ARC and balloon adjustments describe the outer machine and are absent.
    expect(wire.memory.arcReclaimable).toBeUndefined();
    expect(wire.memory.ballooned).toBeUndefined();
  });
});

describe('nested host: unknown usage is reported, never the outer machine', () => {
  beforeEach(() => {
    mockDockerInfo.mockResolvedValue({ NCPU: 2, MemTotal: 4 * GiB });
    process.env.SENCHO_HOST_CGROUP_PATH = CGROUP;
  });

  it('reports unknown when memory.max is "max"', async () => {
    setCgroup({ memoryMax: 'max' });
    const wire = hostSampleToWire(await readLocalHostSample(NODE_ID));
    expect(wire.memory.used).toBeNull();
    expect(wire.memory.usagePercent).toBeNull();
  });

  it('reports unknown when the cgroup limit does not match the Docker host', async () => {
    // A container limit inside the LXC, not the LXC itself.
    setCgroup({ memoryMax: String(1 * GiB) });
    const wire = hostSampleToWire(await readLocalHostSample(NODE_ID));
    expect(wire.memory.used).toBeNull();
  });

  it('reports unknown when memory.stat is missing inactive_file', async () => {
    setCgroup({ omit: ['inactive_file'] });
    const wire = hostSampleToWire(await readLocalHostSample(NODE_ID));
    expect(wire.memory.used).toBeNull();
  });

  it('reports unknown when memory.current is blank', async () => {
    // Number('') is 0, which would otherwise read as a measured 0%.
    setCgroup();
    arcFs.setRead(`${CGROUP}/memory.current`, '\n');
    const wire = hostSampleToWire(await readLocalHostSample(NODE_ID));
    expect(wire.memory.used).toBeNull();
    expect(wire.memory.usagePercent).toBeNull();
  });

  it('reports unknown when the cgroup root is not a directory', async () => {
    arcFs.setRead(`${CGROUP}/cgroup.controllers`, 'cpuset cpu memory\n');
    arcFs.setRead(`${CGROUP}/cpuset.cpus.effective`, '0-1\n');
    arcFs.setReadError(`${CGROUP}/cpu.stat`, Object.assign(new Error('not a directory'), { code: 'ENOTDIR' }));
    const wire = hostSampleToWire(await readLocalHostSample(NODE_ID));
    expect(wire.cpu.usage).toBeNull();
  });

  it('reports unknown when memory.stat is missing', async () => {
    setCgroup({ omit: ['memory.stat'] });
    const wire = hostSampleToWire(await readLocalHostSample(NODE_ID));
    expect(wire.memory.used).toBeNull();
  });

  it('reports unknown on cgroup v1 (no cgroup.controllers)', async () => {
    setCgroup({ omit: ['controllers'] });
    const wire = hostSampleToWire(await readLocalHostSample(NODE_ID));
    expect(wire.cpu.usage).toBeNull();
    expect(wire.memory.used).toBeNull();
  });

  it('reports unknown when cpu.stat is missing', async () => {
    setCgroup({ omit: ['cpu.stat'] });
    const wire = hostSampleToWire(await readLocalHostSample(NODE_ID));
    expect(wire.cpu.usage).toBeNull();
    // Memory is still measurable on the same tree.
    expect(wire.memory.usagePercent).toBe('37.5');
  });

  it('reports unknown when the cgroup cpuset does not match NCPU', async () => {
    setCgroup({ cpus: '0-3' });
    const wire = hostSampleToWire(await readLocalHostSample(NODE_ID));
    expect(wire.cpu.usage).toBeNull();
  });

  it('treats an EACCES read as unknown rather than failing the sample', async () => {
    setCgroup();
    arcFs.setReadError(`${CGROUP}/memory.current`, Object.assign(new Error('denied'), { code: 'EACCES' }));
    const wire = hostSampleToWire(await readLocalHostSample(NODE_ID));
    expect(wire.memory.used).toBeNull();
  });

  it('prefers the SENCHO_HOST_CGROUP_PATH override and ignores the fixed path', async () => {
    // The fixed path has a full, matching tree; the override does not. If the
    // fixed path were read, usage would be measured.
    arcFs.setRead(`${HOST_CGROUP_FIXED_PATH}/cgroup.controllers`, 'cpuset cpu memory\n');
    arcFs.setRead(`${HOST_CGROUP_FIXED_PATH}/cpuset.cpus.effective`, '0-1\n');
    arcFs.setRead(`${HOST_CGROUP_FIXED_PATH}/cpu.stat`, 'usage_usec 1\n');
    arcFs.setRead(`${HOST_CGROUP_FIXED_PATH}/memory.max`, String(4 * GiB));
    arcFs.setRead(`${HOST_CGROUP_FIXED_PATH}/memory.current`, String(2 * GiB));
    arcFs.setRead(`${HOST_CGROUP_FIXED_PATH}/memory.stat`, 'inactive_file 0\n');
    const wire = hostSampleToWire(await readLocalHostSample(NODE_ID));
    expect(wire.cpu.usage).toBeNull();
    expect(wire.memory.used).toBeNull();
  });
});

describe('computeCpuPercent', () => {
  it('divides CPU time by wall time across the reported cores', () => {
    // 1s of CPU time over a 2s window on 4 cores: 12.5% of the host.
    expect(computeCpuPercent(0, 1_000, 1_000_000, 3_000, 4)).toBe(12.5);
  });

  it('returns null for a reset counter, a zero window, or no cores', () => {
    expect(computeCpuPercent(2_000_000, 1_000, 1_000_000, 2_000, 2)).toBeNull();
    expect(computeCpuPercent(0, 1_000, 1_000_000, 1_000, 2)).toBeNull();
    expect(computeCpuPercent(0, 1_000, 1_000_000, 2_000, 0)).toBeNull();
  });

  it('clamps sampling jitter to 100%', () => {
    expect(computeCpuPercent(0, 1_000, 10_000_000, 2_000, 2)).toBe(100);
  });
});

describe('countCpusetCpus', () => {
  it('counts ranges and single entries', () => {
    expect(countCpusetCpus('0-3,8,10-11')).toBe(7);
    expect(countCpusetCpus('0\n')).toBe(1);
  });

  it('rejects a malformed or empty list', () => {
    expect(countCpusetCpus('')).toBeUndefined();
    expect(countCpusetCpus('3-1')).toBeUndefined();
    expect(countCpusetCpus('a-b')).toBeUndefined();
  });
});
