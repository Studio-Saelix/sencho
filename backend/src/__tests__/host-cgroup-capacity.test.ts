import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  countCpusetList,
  extractContainerIdFromCgroupContents,
  findContainerBoundary,
  hostScopedAncestorChain,
  parseCpuMaxCores,
  parseSelfCgroupRelativePath,
  parseV1CpuQuotaCores,
  readHostScopedCgroupCapacity,
} from '../helpers/hostCgroupCapacity';

const CONTAINER_ID = 'a'.repeat(64);
const OTHER_ID = 'b'.repeat(64);

async function writeFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, 'utf8');
}

describe('hostCgroupCapacity parsers', () => {
  it('extracts the last 64-hex container id', () => {
    const body = `12:memory:/docker/${OTHER_ID}\n0::/system.slice/docker-${CONTAINER_ID}.scope\n`;
    expect(extractContainerIdFromCgroupContents(body)).toBe(CONTAINER_ID);
  });

  it('parses v2 and v1 self paths', () => {
    expect(parseSelfCgroupRelativePath(`0::/lxc/101/docker/${CONTAINER_ID}\n`))
      .toBe(`/lxc/101/docker/${CONTAINER_ID}`);
    expect(parseSelfCgroupRelativePath(`12:memory:/docker/${CONTAINER_ID}\n`))
      .toBe(`/docker/${CONTAINER_ID}`);
  });

  it('anchors the container boundary on the self id and samples from its parent', () => {
    const self = `/lxc/101/docker/${CONTAINER_ID}`;
    expect(findContainerBoundary(self, CONTAINER_ID)).toBe(self);
    expect(hostScopedAncestorChain(self, CONTAINER_ID)).toEqual(['/lxc/101/docker', '/lxc/101', '/lxc', '/']);
  });

  it('keeps a host ancestor whose name contains docker', () => {
    const self = `/docker-hosts/pool/system.slice/docker-${CONTAINER_ID}.scope`;
    expect(hostScopedAncestorChain(self, CONTAINER_ID)).toEqual([
      '/docker-hosts/pool/system.slice',
      '/docker-hosts/pool',
      '/docker-hosts',
      '/',
    ]);
  });

  it('returns null host chain when the self id is missing from the path', () => {
    expect(hostScopedAncestorChain('/lxc/101', CONTAINER_ID)).toBeNull();
  });

  it('parses cpu.max and v1 quota cores with rounding', () => {
    expect(parseCpuMaxCores('max 100000')).toBeNull();
    expect(parseCpuMaxCores('150000 100000')).toBe(2);
    expect(parseCpuMaxCores('100000 0')).toBeNull();
    expect(parseV1CpuQuotaCores('200000', '100000')).toBe(2);
    expect(parseV1CpuQuotaCores('-1', '100000')).toBeNull();
    expect(parseV1CpuQuotaCores('100000', '0')).toBeNull();
  });

  it('counts cpuset lists', () => {
    expect(countCpusetList('0-1')).toBe(2);
    expect(countCpusetList('0,2,4-5')).toBe(4);
    expect(countCpusetList('')).toBeNull();
  });
});

describe('readHostScopedCgroupCapacity fixtures', () => {
  let tmpRoot: string;
  let cgroupFile: string;
  let cgroupFsRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sencho-cgroup-'));
    cgroupFile = path.join(tmpRoot, 'cgroup');
    cgroupFsRoot = path.join(tmpRoot, 'sys');
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  async function installV2Dir(rel: string, files: Record<string, string>): Promise<void> {
    const dir = rel === '/' ? cgroupFsRoot : path.join(cgroupFsRoot, ...rel.replace(/^\//, '').split('/'));
    await fs.mkdir(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      await writeFile(path.join(dir, name), body);
    }
  }

  it('returns null for a private namespace with no container id', async () => {
    await writeFile(cgroupFile, '0::/\n');
    await writeFile(path.join(cgroupFsRoot, 'cgroup.controllers'), 'cpu memory cpuset\n');
    await installV2Dir('/', { 'memory.max': 'max', 'cpu.max': 'max 100000' });
    const result = await readHostScopedCgroupCapacity({
      cgroupFilePath: cgroupFile,
      cgroupFsRoot,
    });
    expect(result).toBeNull();
  });

  it('returns null when the container boundary cannot be established', async () => {
    await writeFile(cgroupFile, `0::/lxc/101\n${CONTAINER_ID}\n`);
    // Force an id that is not in the path by overriding containerId while
    // leaving a path that does not contain it.
    await writeFile(path.join(cgroupFsRoot, 'cgroup.controllers'), 'cpu memory\n');
    const result = await readHostScopedCgroupCapacity({
      cgroupFilePath: cgroupFile,
      cgroupFsRoot,
      containerId: CONTAINER_ID,
    });
    expect(result).toBeNull();
  });

  it('uses the LXC parent when the Sencho leaf is unlimited (docker cgroupfs)', async () => {
    const self = `/lxc/101/docker/${CONTAINER_ID}`;
    await writeFile(cgroupFile, `0::${self}\n`);
    await writeFile(path.join(cgroupFsRoot, 'cgroup.controllers'), 'cpu memory cpuset\n');
    await installV2Dir(self, {
      'memory.max': '536870912',
      'memory.current': '100000000',
      'cpu.max': '100000 100000',
    });
    await installV2Dir('/lxc/101', {
      'memory.max': String(4 * 1024 ** 3),
      'memory.current': String(1 * 1024 ** 3),
      'memory.stat': 'inactive_file 536870912\n',
      'cpu.max': '200000 100000',
      'cpuset.cpus.effective': '0-1',
    });
    await installV2Dir('/', {
      'memory.max': 'max',
      'cpu.max': 'max 100000',
    });

    const result = await readHostScopedCgroupCapacity({
      cgroupFilePath: cgroupFile,
      cgroupFsRoot,
    });
    expect(result).not.toBeNull();
    expect(result!.cpuCores).toBe(2);
    expect(result!.memory?.total).toBe(4 * 1024 ** 3);
    // raw 1GiB - 512MiB inactive_file = 512MiB working set
    expect(result!.memory?.used).toBe(512 * 1024 ** 2);
    expect(result!.memory?.free).toBe(result!.memory!.total - result!.memory!.used);
  });

  it('excludes a finite Sencho leaf under a systemd docker scope', async () => {
    const self = `/system.slice/docker-${CONTAINER_ID}.scope`;
    await writeFile(cgroupFile, `0::${self}\n`);
    await writeFile(path.join(cgroupFsRoot, 'cgroup.controllers'), 'cpu memory\n');
    await installV2Dir(self, {
      'memory.max': '268435456',
      'memory.current': '100000000',
      'cpu.max': '100000 100000',
    });
    await installV2Dir('/system.slice', {
      'memory.max': 'max',
      'cpu.max': 'max 100000',
    });
    await installV2Dir('/', {
      'memory.max': String(8 * 1024 ** 3),
      'memory.current': String(2 * 1024 ** 3),
      'memory.stat': 'inactive_file 0\n',
      'cpu.max': '400000 100000',
    });

    const result = await readHostScopedCgroupCapacity({
      cgroupFilePath: cgroupFile,
      cgroupFsRoot,
    });
    expect(result?.memory?.total).toBe(8 * 1024 ** 3);
    expect(result?.cpuCores).toBe(4);
  });

  it('handles podman/libpod scope paths', async () => {
    const self = `/user.slice/user-1000.slice/user@1000.service/app.slice/libpod-${CONTAINER_ID}.scope`;
    await writeFile(cgroupFile, `0::${self}\n`);
    await writeFile(path.join(cgroupFsRoot, 'cgroup.controllers'), 'cpu memory\n');
    await installV2Dir(self, { 'memory.max': 'max', 'cpu.max': 'max 100000' });
    await installV2Dir('/user.slice/user-1000.slice/user@1000.service/app.slice', {
      'memory.max': String(2 * 1024 ** 3),
      'memory.current': '100',
      'cpu.max': '200000 100000',
    });

    const result = await readHostScopedCgroupCapacity({
      cgroupFilePath: cgroupFile,
      cgroupFsRoot,
    });
    expect(result?.memory?.total).toBe(2 * 1024 ** 3);
    expect(result?.cpuCores).toBe(2);
  });

  it('supports memory-only and cpu-only finite limits independently', async () => {
    const self = `/lxc/7/docker/${CONTAINER_ID}`;
    await writeFile(cgroupFile, `0::${self}\n`);
    await writeFile(path.join(cgroupFsRoot, 'cgroup.controllers'), 'cpu memory cpuset\n');
    await installV2Dir(self, { 'memory.max': 'max', 'cpu.max': 'max 100000' });
    await installV2Dir('/lxc/7', {
      'memory.max': String(1024 ** 3),
      'memory.current': '10',
      'cpu.max': 'max 100000',
      'cpuset.cpus.effective': '',
    });
    await installV2Dir('/', { 'memory.max': 'max', 'cpu.max': 'max 100000' });

    const memoryOnly = await readHostScopedCgroupCapacity({
      cgroupFilePath: cgroupFile,
      cgroupFsRoot,
    });
    expect(memoryOnly?.memory?.total).toBe(1024 ** 3);
    expect(memoryOnly?.cpuCores).toBeNull();

    await installV2Dir('/lxc/7', {
      'memory.max': 'max',
      'cpu.max': '300000 100000',
      'cpuset.cpus.effective': '0-7',
    });
    const cpuOnly = await readHostScopedCgroupCapacity({
      cgroupFilePath: cgroupFile,
      cgroupFsRoot,
    });
    expect(cpuOnly?.memory).toBeNull();
    expect(cpuOnly?.cpuCores).toBe(3);
  });

  it('chooses the stricter parent memory and min(quota, effective cpuset)', async () => {
    const self = `/a/b/docker/${CONTAINER_ID}`;
    await writeFile(cgroupFile, `0::${self}\n`);
    await writeFile(path.join(cgroupFsRoot, 'cgroup.controllers'), 'cpu memory cpuset\n');
    await installV2Dir(self, { 'memory.max': 'max', 'cpu.max': 'max 100000' });
    await installV2Dir('/a/b', {
      'memory.max': String(8 * 1024 ** 3),
      'memory.current': '1',
      'cpu.max': '800000 100000',
      'cpuset.cpus.effective': '0-1',
      'cpuset.cpus': '0-7',
    });
    await installV2Dir('/a', {
      'memory.max': String(4 * 1024 ** 3),
      'memory.current': '1',
      'cpu.max': 'max 100000',
    });

    const result = await readHostScopedCgroupCapacity({
      cgroupFilePath: cgroupFile,
      cgroupFsRoot,
    });
    expect(result?.memory?.total).toBe(4 * 1024 ** 3);
    expect(result?.cpuCores).toBe(2); // min(8 quota, 2 effective)
  });

  it('clamps working set and falls back when memory.stat is missing', async () => {
    const self = `/x/docker/${CONTAINER_ID}`;
    await writeFile(cgroupFile, `0::${self}\n`);
    await writeFile(path.join(cgroupFsRoot, 'cgroup.controllers'), 'memory\n');
    await installV2Dir(self, { 'memory.max': 'max' });
    await installV2Dir('/x', {
      'memory.max': '1000',
      'memory.current': '5000',
    });
    const result = await readHostScopedCgroupCapacity({
      cgroupFilePath: cgroupFile,
      cgroupFsRoot,
    });
    expect(result?.memory).toEqual({
      total: 1000,
      used: 1000,
      free: 0,
      usagePercent: 100,
    });
  });


  it('excludes the container root when self is a subgroup under the id path', async () => {
    const containerRoot = `/system.slice/docker-${CONTAINER_ID}.scope`;
    const self = `${containerRoot}/payload`;
    await writeFile(cgroupFile, `0::${self}\n`);
    await writeFile(path.join(cgroupFsRoot, 'cgroup.controllers'), 'cpu memory\n');
    await installV2Dir(self, {
      'memory.max': 'max',
      'cpu.max': 'max 100000',
    });
    await installV2Dir(containerRoot, {
      'memory.max': '268435456',
      'memory.current': '100',
      'cpu.max': '100000 100000',
    });
    await installV2Dir('/', {
      'memory.max': String(4 * 1024 ** 3),
      'memory.current': String(1 * 1024 ** 3),
      'memory.stat': 'inactive_file 0\n',
      'cpu.max': '200000 100000',
      'cpuset.cpus.effective': '0-31',
    });

    expect(findContainerBoundary(self, CONTAINER_ID)).toBe(containerRoot);
    const result = await readHostScopedCgroupCapacity({
      cgroupFilePath: cgroupFile,
      cgroupFsRoot,
    });
    expect(result?.memory?.total).toBe(4 * 1024 ** 3);
    expect(result?.cpuCores).toBe(2);
  });

  it('ignores root cpuset-only affinity when cpu.max is unlimited', async () => {
    const self = `/lxc/9/docker/${CONTAINER_ID}`;
    await writeFile(cgroupFile, `0::${self}\n`);
    await writeFile(path.join(cgroupFsRoot, 'cgroup.controllers'), 'cpu memory cpuset\n');
    await installV2Dir(self, { 'memory.max': 'max', 'cpu.max': 'max 100000' });
    await installV2Dir('/lxc/9', {
      'memory.max': String(4 * 1024 ** 3),
      'memory.current': '10',
      'cpu.max': 'max 100000',
    });
    await installV2Dir('/', {
      'memory.max': 'max',
      'cpu.max': 'max 100000',
      'cpuset.cpus.effective': '0-111',
      'cpuset.cpus': '0-111',
    });

    const result = await readHostScopedCgroupCapacity({
      cgroupFilePath: cgroupFile,
      cgroupFsRoot,
    });
    expect(result?.memory?.total).toBe(4 * 1024 ** 3);
    expect(result?.cpuCores).toBeNull();
  });

  it('does not fall back to requested cpuset when effective is present but empty', async () => {
    const self = `/lxc/3/docker/${CONTAINER_ID}`;
    await writeFile(cgroupFile, `0::${self}\n`);
    await writeFile(path.join(cgroupFsRoot, 'cgroup.controllers'), 'cpu memory cpuset\n');
    await installV2Dir(self, { 'memory.max': 'max', 'cpu.max': 'max 100000' });
    await installV2Dir('/lxc/3', {
      'memory.max': 'max',
      'cpu.max': 'max 100000',
      'cpuset.cpus.effective': '',
      'cpuset.cpus': '0-7',
    });

    const result = await readHostScopedCgroupCapacity({
      cgroupFilePath: cgroupFile,
      cgroupFsRoot,
    });
    expect(result).toBeNull();
  });

  it('fails memory open when memory.current is missing', async () => {
    const self = `/lxc/4/docker/${CONTAINER_ID}`;
    await writeFile(cgroupFile, `0::${self}\n`);
    await writeFile(path.join(cgroupFsRoot, 'cgroup.controllers'), 'memory\n');
    await installV2Dir(self, { 'memory.max': 'max' });
    await installV2Dir('/lxc/4', {
      'memory.max': String(1024 ** 3),
    });

    const result = await readHostScopedCgroupCapacity({
      cgroupFilePath: cgroupFile,
      cgroupFsRoot,
    });
    expect(result).toBeNull();
  });

  it('reads v1 split controller paths and ignores absurd memory sentinels', async () => {
    const self = `/docker/${CONTAINER_ID}`;
    await writeFile(cgroupFile, `12:memory:${self}\n11:cpu,cpuacct:${self}\n10:cpuset:${self}\n`);
    // No cgroup.controllers => v1 mode
    await writeFile(path.join(cgroupFsRoot, 'memory', 'docker', CONTAINER_ID, 'memory.limit_in_bytes'), '9223372036854771712');
    await writeFile(path.join(cgroupFsRoot, 'memory', 'memory.limit_in_bytes'), String(2 * 1024 ** 3));
    await writeFile(path.join(cgroupFsRoot, 'memory', 'memory.usage_in_bytes'), String(512 * 1024 ** 2));
    await writeFile(path.join(cgroupFsRoot, 'memory', 'memory.stat'), 'total_inactive_file 0\ninactive_file 0\n');
    await writeFile(path.join(cgroupFsRoot, 'cpu', 'cpu.cfs_quota_us'), '200000');
    await writeFile(path.join(cgroupFsRoot, 'cpu', 'cpu.cfs_period_us'), '100000');
    await writeFile(path.join(cgroupFsRoot, 'cpuset', 'cpuset.cpus'), '0-3');

    const result = await readHostScopedCgroupCapacity({
      cgroupFilePath: cgroupFile,
      cgroupFsRoot,
    });
    expect(result?.memory?.total).toBe(2 * 1024 ** 3);
    expect(result?.cpuCores).toBe(2); // min(2 quota, 4 cpuset)
  });
});
