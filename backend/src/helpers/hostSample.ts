import si from 'systeminformation';
import { promises as fs } from 'fs';
import path from 'path';
import { CacheService } from '../services/CacheService';
import { NodeRegistry } from '../services/NodeRegistry';
import { withTimeout } from '../utils/withTimeout';
import {
  getHostMemory,
  memoryToWire,
  memoryUnknownWire,
  type HostMemory,
  type MemoryWire,
} from './hostMemory';

/**
 * Host CPU / memory / disk sample for the local node.
 *
 * Inside a Proxmox LXC (or any nested container) the kernel the Sencho
 * container can see is the outer machine's: `/proc/stat`, `/proc/meminfo` and
 * `si.currentLoad()` describe the hypervisor host, while the Docker daemon
 * runs inside the LXC with LXCFS in front of `/proc`. So capacity is taken
 * from `docker info` (`NCPU`, `MemTotal`), which is what the daemon sees, and
 * each dimension is compared against the kernel view on its own:
 *
 * - agreeing (bare metal, a VM, Docker Desktop, a container with its own
 *   `cpus:`/`mem_limit:`): today's numbers, unchanged;
 * - disagreeing (nested): usage is measured from the Docker host's cgroup v2
 *   root, mounted read-only at `/host/sys/fs/cgroup` (or
 *   `SENCHO_HOST_CGROUP_PATH`), or reported as unknown when no trusted source
 *   exists. A value from the outer machine is never reported.
 */

export type UsageReading<T> =
  | { kind: 'measured'; value: T; source: 'kernel' | 'cgroup' }
  | { kind: 'unknown' };

export interface DiskSample {
  fs: string;
  mount: string;
  total: number;
  used: number;
  free: number;
  usagePercent: string;
}

export interface HostSample {
  cpu: { cores: number; usage: UsageReading<number> };
  memory: { total: number; usage: UsageReading<HostMemory> };
  disk: DiskSample | null;
}

/** Wire shape served by /api/system/stats and the fleet overview. */
export interface HostSampleWire {
  cpu: { usage: string | null; cores: number };
  memory: MemoryWire;
  disk: DiskSample | null;
}

/** Where the Docker host's cgroup v2 root is read from when no override is set. */
export const HOST_CGROUP_FIXED_PATH = '/host/sys/fs/cgroup';

/** Capacity changes rarely, but Proxmox can resize an LXC live. */
const CAPACITY_CACHE_TTL_MS = 30_000;
/** A slow daemon must not stall a dashboard poll. */
const CAPACITY_TIMEOUT_MS = 3_000;
/** Two cgroup CPU counters closer than this are too noisy to divide. */
const MIN_CPU_WINDOW_MS = 250;
/** Reclaimable memory tolerance between `docker info` MemTotal and the LXC limit. */
const MEMORY_TOLERANCE = 0.02;

export interface DockerCapacity {
  cores: number;
  memTotal: number;
}

interface CpuCounterSample {
  usageUsec: number;
  atMs: number;
}

// Shared per cgroup root so concurrent callers reuse one measurement window,
// the way `si.currentLoad` keeps its own previous /proc/stat counters.
const cpuCounterSamples = new Map<string, CpuCounterSample>();
// Memoized so a failing daemon logs once per error code, not every tick.
const loggedCapacityErrors = new Set<string>();

function cgroupRoot(): string {
  const raw = process.env.SENCHO_HOST_CGROUP_PATH?.trim();
  return raw ? raw : HOST_CGROUP_FIXED_PATH;
}

function isExpectedFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return (
    code === 'ENOENT' ||
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'EISDIR' ||
    code === 'ENOTDIR' ||
    code === 'ELOOP'
  );
}

/**
 * Read one cgroup file. Any unreadable file is the normal non-nested case and
 * resolves to undefined so the caller reports usage unknown; an unexpected
 * error is logged once per code and resolves the same way.
 */
async function readCgroupFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (isExpectedFsError(err)) return undefined;
    const code = (err as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
    if (loggedCapacityErrors.has(`cgroup:${code}`)) return undefined;
    loggedCapacityErrors.add(`cgroup:${code}`);
    console.warn(`[HostSample] Unexpected error reading ${filePath} (${code}); treating host usage as unknown`);
    return undefined;
  }
}

/** Numeric value of a `<key> <number>` line (cgroup flat or memory.stat format). */
function parseKeyedNumber(raw: string, key: string): number | undefined {
  for (const line of raw.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 2 || parts[0] !== key) continue;
    const value = Number(parts[1]);
    if (!Number.isFinite(value) || value < 0) return undefined;
    return value;
  }
  return undefined;
}

/**
 * Count the CPUs in a `cpuset.cpus.effective` list (`0-3,8,10-11` -> 7).
 * Returns undefined on a malformed list, so a bad read is never trusted.
 */
export function countCpusetCpus(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let count = 0;
  for (const part of trimmed.split(',')) {
    const range = part.trim();
    if (!range) return undefined;
    const bounds = range.split('-');
    if (bounds.length === 1) {
      if (!/^\d+$/.test(bounds[0])) return undefined;
      count += 1;
      continue;
    }
    if (bounds.length !== 2 || !/^\d+$/.test(bounds[0]) || !/^\d+$/.test(bounds[1])) return undefined;
    const from = Number(bounds[0]);
    const to = Number(bounds[1]);
    if (to < from) return undefined;
    count += to - from + 1;
  }
  return count > 0 ? count : undefined;
}

/** Percent of the whole Docker host used over a counter window. */
export function computeCpuPercent(
  prevUsec: number,
  prevAtMs: number,
  currUsec: number,
  currAtMs: number,
  cores: number,
): number | null {
  const deltaUsec = currUsec - prevUsec;
  const deltaMs = currAtMs - prevAtMs;
  if (!Number.isFinite(deltaUsec) || !Number.isFinite(deltaMs)) return null;
  if (deltaUsec < 0 || deltaMs <= 0 || cores <= 0) return null;
  const percent = (deltaUsec / (deltaMs * 1000 * cores)) * 100;
  if (!Number.isFinite(percent)) return null;
  return Math.min(Math.max(percent, 0), 100);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCpuUsageUsec(root: string): Promise<number | undefined> {
  const raw = await readCgroupFile(path.join(root, 'cpu.stat'));
  if (raw === undefined) return undefined;
  return parseKeyedNumber(raw, 'usage_usec');
}

/**
 * CPU usage of the Docker host, from its cgroup v2 `cpu.stat` counter.
 * Trusted only when the cgroup is v2, `usage_usec` is present, and the cgroup
 * cpuset lists exactly the cores `docker info` reports. Anything else is
 * unknown: reporting the outer machine's CPUs as this host's usage would be
 * worse than saying nothing.
 */
async function readCgroupCpuUsage(root: string, cores: number): Promise<number | null> {
  // `cgroup.controllers` only exists on a cgroup v2 hierarchy.
  const controllers = await readCgroupFile(path.join(root, 'cgroup.controllers'));
  if (controllers === undefined) return null;

  const cpusetRaw = await readCgroupFile(path.join(root, 'cpuset.cpus.effective'));
  const cpusetCount = cpusetRaw === undefined ? undefined : countCpusetCpus(cpusetRaw);
  if (cpusetCount !== cores) return null;

  const firstUsec = await readCpuUsageUsec(root);
  if (firstUsec === undefined) return null;
  const firstAt = Date.now();

  const prev = cpuCounterSamples.get(root);
  if (prev && firstAt - prev.atMs >= MIN_CPU_WINDOW_MS) {
    cpuCounterSamples.set(root, { usageUsec: firstUsec, atMs: firstAt });
    return computeCpuPercent(prev.usageUsec, prev.atMs, firstUsec, firstAt, cores);
  }

  // No usable previous sample: take a second reading instead of reporting a
  // since-boot average as the current load.
  await sleep(MIN_CPU_WINDOW_MS);
  const secondUsec = await readCpuUsageUsec(root);
  const secondAt = Date.now();
  if (secondUsec === undefined) return null;
  cpuCounterSamples.set(root, { usageUsec: secondUsec, atMs: secondAt });
  return computeCpuPercent(firstUsec, firstAt, secondUsec, secondAt, cores);
}

/**
 * Working-set memory of the Docker host, from its cgroup v2 counters.
 * Trusted only when `memory.max` agrees with the Docker host's MemTotal within
 * the tolerance, so a container limit or a different machine is never
 * mistaken for the host. Page cache counted in `inactive_file` is reclaimable
 * and is excluded, mirroring `total - available`.
 */
async function readCgroupMemory(root: string, memTotal: number): Promise<HostMemory | null> {
  // cgroup v2 only, same marker as the CPU path. On cgroup v1 (Proxmox 6 and
  // older) these files do not exist and usage stays unknown.
  const controllers = await readCgroupFile(path.join(root, 'cgroup.controllers'));
  if (controllers === undefined) return null;

  const maxRaw = await readCgroupFile(path.join(root, 'memory.max'));
  if (maxRaw === undefined) return null;
  const limit = Number(maxRaw.trim());
  if (maxRaw.trim() === 'max' || !Number.isFinite(limit) || limit <= 0) return null;
  if (!withinTolerance(limit, memTotal)) return null;

  const currentRaw = await readCgroupFile(path.join(root, 'memory.current'));
  // Number('') is 0: a blank file must read as unknown, not as a measured 0%.
  const currentTrimmed = currentRaw === undefined ? '' : currentRaw.trim();
  const current = currentTrimmed === '' ? NaN : Number(currentTrimmed);
  if (!Number.isFinite(current) || current < 0) return null;

  const statRaw = await readCgroupFile(path.join(root, 'memory.stat'));
  if (statRaw === undefined) return null;
  const inactiveFile = parseKeyedNumber(statRaw, 'inactive_file');
  if (inactiveFile === undefined) return null;

  const used = Math.max(current - inactiveFile, 0);
  const total = memTotal;
  return {
    total,
    used,
    free: Math.max(total - used, 0),
    usagePercent: total > 0 ? (used / total) * 100 : 0,
  };
}

function withinTolerance(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return false;
  return Math.abs(a - b) / b <= MEMORY_TOLERANCE;
}

async function fetchDockerCapacity(nodeId: number): Promise<DockerCapacity | null> {
  try {
    const docker = NodeRegistry.getInstance().getDocker(nodeId);
    const info = await withTimeout(docker.info(), CAPACITY_TIMEOUT_MS, 'docker info');
    const cores = typeof info?.NCPU === 'number' && info.NCPU > 0 ? info.NCPU : 0;
    const memTotal = typeof info?.MemTotal === 'number' && info.MemTotal > 0 ? info.MemTotal : 0;
    if (cores === 0 || memTotal === 0) {
      logCapacityFailure('invalid', `docker info did not report a usable NCPU/MemTotal (NCPU=${cores}, MemTotal=${memTotal})`);
      return null;
    }
    return { cores, memTotal };
  } catch (err) {
    const code = err instanceof Error ? err.name : 'UNKNOWN';
    const message = err instanceof Error ? err.message : String(err);
    logCapacityFailure(code, message);
    return null;
  }
}

/**
 * Accepted trade-off: when the daemon cannot be reached, capacity and both
 * dimensions fall back to the kernel view, which is today's behavior. On a
 * nested host that momentarily reports the outer machine again, never for
 * longer than the capacity cache TTL. The alternative (remembering "this host
 * was nested") would keep reporting unknown long after a `DOCKER_HOST` change
 * made the kernel view valid again, and it is not what an operator expects
 * from a probe that cannot see the daemon at all.
 */
function logCapacityFailure(code: string, detail: string): void {
  if (loggedCapacityErrors.has(code)) return;
  loggedCapacityErrors.add(code);
  console.warn(
    `[HostSample] docker info unavailable (${code}): ${detail}; ` +
      'falling back to the kernel view for host capacity',
  );
}

/**
 * CPU cores and total memory as the Docker host sees them, cached per node.
 * Null when the daemon cannot answer within the bound, so callers fall back to
 * today's kernel numbers rather than regress.
 */
export async function readDockerCapacity(nodeId: number): Promise<DockerCapacity | null> {
  return CacheService.getInstance().getOrFetch(
    `docker-capacity:${nodeId}`,
    CAPACITY_CACHE_TTL_MS,
    () => fetchDockerCapacity(nodeId),
  );
}

function buildDiskSample(fsSize: Awaited<ReturnType<typeof si.fsSize>>): DiskSample | null {
  const mainDisk = fsSize.find((fs) => fs.mount === '/' || fs.mount === 'C:') || fsSize[0];
  if (!mainDisk) return null;
  return {
    fs: mainDisk.fs,
    mount: mainDisk.mount,
    total: mainDisk.size,
    used: mainDisk.used,
    free: mainDisk.available,
    usagePercent: mainDisk.use ? mainDisk.use.toFixed(1) : '0',
  };
}

/** One sample of the local node's CPU, memory and disk, host-scoped. */
export async function readLocalHostSample(nodeId: number): Promise<HostSample> {
  const [capacity, kernelLoad, kernelMem, fsSize] = await Promise.all([
    readDockerCapacity(nodeId),
    si.currentLoad(),
    getHostMemory(),
    si.fsSize(),
  ]);

  const kernelCores = kernelLoad.cpus.length;
  // Agreement is the signal, not a cgroup quota check: an LXC limited only by
  // `cpu.max` (no cpuset) reports the outer core count from both sides, and
  // LXCFS shows the same count to the LXC's own tools, so today's numbers
  // already describe what the operator sees there. A cpuset-limited LXC (what
  // Proxmox pins `cores` with) disagrees and takes the cgroup path.
  const cpuNested = capacity !== null && capacity.cores > 0 && capacity.cores !== kernelCores;

  let cpu: HostSample['cpu'];
  if (capacity !== null && cpuNested) {
    const cgroupUsage = await readCgroupCpuUsage(cgroupRoot(), capacity.cores);
    cpu = {
      cores: capacity.cores,
      usage: cgroupUsage === null
        ? { kind: 'unknown' }
        : { kind: 'measured', value: cgroupUsage, source: 'cgroup' },
    };
  } else {
    cpu = {
      cores: kernelCores,
      usage: { kind: 'measured', value: kernelLoad.currentLoad, source: 'kernel' },
    };
  }

  let memory: HostSample['memory'];
  if (capacity !== null && capacity.memTotal > 0 && !withinTolerance(capacity.memTotal, kernelMem.total)) {
    const cgroupMem = await readCgroupMemory(cgroupRoot(), capacity.memTotal);
    memory = {
      total: capacity.memTotal,
      usage: cgroupMem === null
        ? { kind: 'unknown' }
        : { kind: 'measured', value: cgroupMem, source: 'cgroup' },
    };
  } else {
    memory = {
      total: kernelMem.total,
      usage: { kind: 'measured', value: kernelMem, source: 'kernel' },
    };
  }

  return { cpu, memory, disk: buildDiskSample(fsSize) };
}

/** Map a sample to the wire shape. `null` usage is the only unknown signal. */
export function hostSampleToWire(sample: HostSample): HostSampleWire {
  return {
    cpu: {
      usage: sample.cpu.usage.kind === 'measured' ? sample.cpu.usage.value.toFixed(1) : null,
      cores: sample.cpu.cores,
    },
    memory: sample.memory.usage.kind === 'measured'
      ? memoryToWire(sample.memory.usage.value)
      : memoryUnknownWire(sample.memory.total),
    disk: sample.disk,
  };
}

/** Clear the shared CPU window and the log dedup sets. Tests only. */
export function _resetHostSampleStateForTests(): void {
  cpuCounterSamples.clear();
  loggedCapacityErrors.clear();
}
