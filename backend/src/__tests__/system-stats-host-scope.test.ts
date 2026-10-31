/**
 * GET /api/system/stats host scoping, end to end through the route.
 *
 * Three cases:
 *  - Docker and the kernel agree (bare metal, VM, Docker Desktop): today's
 *    exact wire shape;
 *  - they disagree and the Docker host's cgroup v2 root is mounted: capacity
 *    and usage both describe the Docker host;
 *  - they disagree with no cgroup mount: usage is null, never the outer
 *    machine's numbers.
 */
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { installArcstatsFsMock, type ArcstatsFsMock } from './helpers/arcstatsFsMock';

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

import { CacheService } from '../services/CacheService';
import { NodeRegistry } from '../services/NodeRegistry';
import { _resetHostSampleStateForTests } from '../helpers/hostSample';
import { HOST_USAGE_UNKNOWN_HEADER } from '../services/CapabilityRegistry';

const GiB = 1024 ** 3;
const KERNEL_TOTAL = 16 * GiB;
const CGROUP = '/fixture/route-cgroup';

let tmpDir: string;
let app: import('express').Express;
let adminCookie: string;
let machineAuth: () => string;
let arcFs: ArcstatsFsMock;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  arcFs = installArcstatsFsMock();
  vi.spyOn(NodeRegistry.prototype, 'getDocker').mockReturnValue({
    info: () => mockDockerInfo(),
  } as unknown as ReturnType<typeof NodeRegistry.prototype.getDocker>);
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
  machineAuth = () => `Bearer ${jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  arcFs.clear();
  CacheService.getInstance().flush();
  _resetHostSampleStateForTests();
  delete process.env.SENCHO_HOST_CGROUP_PATH;

  mockCurrentLoad.mockResolvedValue({ currentLoad: 12.34, cpus: Array.from({ length: 8 }, () => ({})) });
  mockMem.mockResolvedValue({
    total: KERNEL_TOTAL,
    available: KERNEL_TOTAL * 0.75,
    active: KERNEL_TOTAL * 0.25,
    used: KERNEL_TOTAL * 0.25,
    free: KERNEL_TOTAL * 0.75,
    buffcache: 0,
  });
  mockFsSize.mockResolvedValue([
    { fs: '/dev/sda1', mount: '/', size: 100 * GiB, used: 40 * GiB, available: 60 * GiB, use: 40 },
  ]);
  mockDockerInfo.mockResolvedValue({ NCPU: 8, MemTotal: KERNEL_TOTAL });
});

describe('GET /api/system/stats with an agreeing host', () => {
  it('returns today\'s exact shape', async () => {
    const res = await request(app).get('/api/system/stats').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.cpu).toEqual({ usage: '12.3', cores: 8 });
    expect(res.body.memory).toEqual({
      total: KERNEL_TOTAL,
      used: 4 * GiB,
      free: 12 * GiB,
      usagePercent: '25.0',
    });
    expect(res.body.disk).toEqual({
      fs: '/dev/sda1',
      mount: '/',
      total: 100 * GiB,
      used: 40 * GiB,
      free: 60 * GiB,
      usagePercent: '40.0',
    });
  });
});

describe('GET /api/system/stats inside a nested host', () => {
  beforeEach(() => {
    // A 2-core, 4 GiB LXC on an 8-core, 16 GiB machine.
    mockDockerInfo.mockResolvedValue({ NCPU: 2, MemTotal: 4 * GiB });
    process.env.SENCHO_HOST_CGROUP_PATH = CGROUP;
  });

  it('reports Docker capacity and cgroup usage when the mount is present', async () => {
    arcFs.setRead(`${CGROUP}/cgroup.controllers`, 'cpuset cpu memory\n');
    arcFs.setRead(`${CGROUP}/cpuset.cpus.effective`, '0-1\n');
    arcFs.setReadSequence(`${CGROUP}/cpu.stat`, ['usage_usec 1000000\n', 'usage_usec 1050000\n']);
    arcFs.setRead(`${CGROUP}/memory.max`, `${4 * GiB}\n`);
    arcFs.setRead(`${CGROUP}/memory.current`, `${2 * GiB}\n`);
    arcFs.setRead(`${CGROUP}/memory.stat`, `inactive_file ${512 * 1024 * 1024}\n`);

    const res = await request(app).get('/api/system/stats').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.cpu.cores).toBe(2);
    expect(res.body.cpu.usage).not.toBeNull();
    expect(Number(res.body.cpu.usage)).toBeGreaterThan(0);
    expect(Number(res.body.cpu.usage)).toBeLessThan(50);
    expect(res.body.memory).toEqual({
      total: 4 * GiB,
      used: 1.5 * GiB,
      free: 2.5 * GiB,
      usagePercent: '37.5',
    });
  });

  it('reports null usage when the mount is missing', async () => {
    const res = await request(app).get('/api/system/stats').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.cpu).toEqual({ usage: null, cores: 2 });
    expect(res.body.memory).toEqual({ total: 4 * GiB, used: null, free: null, usagePercent: null });
    // Disk is still the container's own overlay backing filesystem.
    expect(res.body.disk.usagePercent).toBe('40.0');
  });

  it('serves the legacy numeric shape to a hub that cannot render unknown', async () => {
    // An older hub proxies with a node_proxy token and no capability header.
    // Its dashboard parses usage as a number, so null would render as NaN%.
    const res = await request(app).get('/api/system/stats').set('Authorization', machineAuth());
    expect(res.status).toBe(200);
    expect(res.body.cpu).toEqual({ usage: '12.3', cores: 8 });
    expect(res.body.memory).toEqual({
      total: KERNEL_TOTAL,
      used: 4 * GiB,
      free: 12 * GiB,
      usagePercent: '25.0',
    });
  });

  it('serves nullable usage to a hub that advertises the capability', async () => {
    const res = await request(app)
      .get('/api/system/stats')
      .set('Authorization', machineAuth())
      .set(HOST_USAGE_UNKNOWN_HEADER, '1');
    expect(res.status).toBe(200);
    expect(res.body.cpu).toEqual({ usage: null, cores: 2 });
    expect(res.body.memory).toEqual({ total: 4 * GiB, used: null, free: null, usagePercent: null });
  });

  it('shapes each response from the cached sample, not a cached wire', async () => {
    // A legacy hub and a current one can poll the same node inside one 3s
    // cache window; whichever asks first must not decide the other's shape.
    const legacy = await request(app).get('/api/system/stats').set('Authorization', machineAuth());
    const current = await request(app).get('/api/system/stats').set('Cookie', adminCookie);
    expect(legacy.body.cpu.cores).toBe(8);
    expect(current.body.cpu).toEqual({ usage: null, cores: 2 });
    // One sample produced both responses.
    expect(mockCurrentLoad).toHaveBeenCalledTimes(1);
  });
});
