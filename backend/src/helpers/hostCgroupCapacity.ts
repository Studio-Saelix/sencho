import { promises as fs } from 'fs';
import path from 'path';

/**
 * Host-scoped cgroup capacity for node CPU/RAM totals.
 *
 * Inside Docker (especially Docker-in-LXC without lxcfs), `/proc` MemTotal and
 * CPU lists often expose the outer hypervisor host. Finite cgroup limits on the
 * Docker host / LXC are the authoritative node capacity, but only when the
 * process joins the host cgroup namespace (`cgroup: host` in Compose).
 *
 * Scope rules:
 * - Extract Sencho's full container ID from `/proc/self/cgroup`.
 * - Container boundary = shallowest self-path ancestor whose path contains that ID.
 * - Sample only ancestors starting at the boundary's parent (never the leaf).
 * - Memory and CPU are independent; a snapshot may carry only one dimension.
 * - Fail open (null) when the boundary cannot be established or neither
 *   dimension has a finite host-scoped limit.
 */

/** Cache-aware working-set memory for a finite host-scoped cgroup limit. */
export interface HostCgroupMemory {
  total: number;
  used: number;
  free: number;
  usagePercent: number;
}

/**
 * Partial capacity snapshot. `null` only when both dimensions lack an
 * authoritative finite value. Callers must treat each field independently.
 */
export interface HostCgroupCapacitySnapshot {
  memory: HostCgroupMemory | null;
  cpuCores: number | null;
}

/** Optional overrides used by unit tests (temp fixture trees). */
export interface HostCgroupCapacityOptions {
  cgroupFilePath?: string;
  cgroupFsRoot?: string;
  /** When set (including null), skip ID extraction from the cgroup file. */
  containerId?: string | null;
}

const DEFAULT_CGROUP_FILE = '/proc/self/cgroup';
const DEFAULT_CGROUP_FS_ROOT = '/sys/fs/cgroup';

/** v1 "unlimited" sentinels are page-aligned values near 2^63. */
const V1_UNLIMITED_THRESHOLD = 1n << 62n;

const loggedSelected = new Set<string>();

function logOnce(key: string, message: string): void {
  if (loggedSelected.has(key)) return;
  loggedSelected.add(key);
  console.debug(message);
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

async function readText(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (isExpectedFsError(err)) return undefined;
    const code = (err as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
    console.warn(`[HostCgroup] Unexpected error reading ${filePath} (${code})`);
    return undefined;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Extract the last 64-hex container ID from a cgroup file body. */
export function extractContainerIdFromCgroupContents(contents: string): string | null {
  const matches = contents.match(/[a-f0-9]{64}/gi);
  return matches && matches.length > 0 ? matches[matches.length - 1].toLowerCase() : null;
}

/**
 * Prefer the unified cgroup v2 path (`0::/...`). Fall back to the first
 * absolute controller path from a v1 multi-line file.
 */
export function parseSelfCgroupRelativePath(contents: string): string | null {
  let v1Fallback: string | null = null;
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const v2 = trimmed.match(/^0::(\/.*)$/);
    if (v2) return normalizeCgroupRelPath(v2[1]);
    if (v1Fallback !== null) continue;
    const parts = trimmed.split(':');
    if (parts.length < 3) continue;
    const rel = parts.slice(2).join(':');
    if (rel.startsWith('/')) v1Fallback = normalizeCgroupRelPath(rel);
  }
  return v1Fallback;
}

function normalizeCgroupRelPath(rel: string): string {
  if (!rel || rel === '/') return '/';
  const withSlash = rel.startsWith('/') ? rel : `/${rel}`;
  const collapsed = withSlash.replace(/\/+/g, '/');
  return collapsed.length > 1 && collapsed.endsWith('/')
    ? collapsed.slice(0, -1)
    : collapsed;
}

/** Self path then each parent up to `/`. */
export function cgroupAncestorChain(relPath: string): string[] {
  const normalized = normalizeCgroupRelPath(relPath);
  const chain: string[] = [];
  let current = normalized;
  while (true) {
    chain.push(current);
    if (current === '/') break;
    const parent = path.posix.dirname(current);
    current = parent === '.' ? '/' : parent;
  }
  return chain;
}

/**
 * Shallowest (closest to `/`) ancestor whose path contains the container ID.
 * That is the container root even when the process sits in a subgroup under it.
 * Returns null when no boundary can be established.
 */
export function findContainerBoundary(
  selfRelPath: string,
  containerId: string,
): string | null {
  const id = containerId.toLowerCase();
  const chain = cgroupAncestorChain(selfRelPath);
  let boundary: string | null = null;
  for (const ancestor of chain) {
    if (ancestor.toLowerCase().includes(id)) boundary = ancestor;
  }
  return boundary;
}

/** Host-scoped sample paths: parent of the container boundary through `/`. */
export function hostScopedAncestorChain(
  selfRelPath: string,
  containerId: string,
): string[] | null {
  const boundary = findContainerBoundary(selfRelPath, containerId);
  if (!boundary) return null;
  const chain = cgroupAncestorChain(selfRelPath);
  const boundaryIndex = chain.indexOf(boundary);
  if (boundaryIndex < 0) return null;
  // Start at the parent of the boundary (exclude the Sencho leaf cgroup).
  return chain.slice(boundaryIndex + 1);
}

function joinCgroupFs(root: string, rel: string, ...parts: string[]): string {
  const base = rel === '/' ? root : path.join(root, ...rel.replace(/^\//, '').split('/'));
  return parts.length === 0 ? base : path.join(base, ...parts);
}

/** v1 controller tree: `/sys/fs/cgroup/<controller>/<rel>/...`. */
function joinController(root: string, controller: string, rel: string, ...parts: string[]): string {
  return joinCgroupFs(path.join(root, controller), rel, ...parts);
}

/** Prefer the tighter of quota and cpuset when both are finite. */
function pickEffectiveCpuCores(quotaCores: number | null, cpusetCores: number | null): number | null {
  if (quotaCores !== null && cpusetCores !== null) return Math.min(quotaCores, cpusetCores);
  return quotaCores ?? cpusetCores;
}

function parseFiniteMemoryLimit(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'max') return null;
  if (!/^-?\d+$/.test(trimmed)) return null;
  let value: bigint;
  try {
    value = BigInt(trimmed);
  } catch {
    return null;
  }
  if (value <= 0n) return null;
  if (value >= V1_UNLIMITED_THRESHOLD) return null;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
}

function parseUint(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

/** Parse `cpu.max` ("max 100000" or "150000 100000") into core count. */
export function parseCpuMaxCores(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const [quotaRaw, periodRaw] = parts;
  if (quotaRaw === 'max') return null;
  const quota = Number(quotaRaw);
  const period = Number(periodRaw);
  if (!Number.isFinite(quota) || !Number.isFinite(period)) return null;
  if (quota <= 0 || period <= 0) return null;
  return Math.max(1, Math.round(quota / period));
}

/** Parse v1 cfs quota/period pair into core count. */
export function parseV1CpuQuotaCores(quotaRaw: string | undefined, periodRaw: string | undefined): number | null {
  const quota = Number(quotaRaw?.trim());
  const period = Number(periodRaw?.trim());
  if (!Number.isFinite(quota) || !Number.isFinite(period)) return null;
  if (quota < 0) return null; // -1 means unlimited
  if (quota === 0 || period <= 0) return null;
  return Math.max(1, Math.round(quota / period));
}

/** Count CPUs in a cpuset list like `0-1,4,6-7`. */
export function countCpusetList(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let total = 0;
  for (const part of trimmed.split(',')) {
    const token = part.trim();
    if (!token) continue;
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return null;
      total += end - start + 1;
      continue;
    }
    if (!/^\d+$/.test(token)) return null;
    total += 1;
  }
  return total > 0 ? total : null;
}

function parseMemoryStatInactiveFile(statBody: string | undefined, preferTotal: boolean): number {
  if (!statBody) return 0;
  let inactiveFile: number | null = null;
  let totalInactiveFile: number | null = null;
  for (const line of statBody.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const value = Number(parts[1]);
    if (!Number.isFinite(value) || value < 0) continue;
    if (parts[0] === 'inactive_file') inactiveFile = value;
    else if (parts[0] === 'total_inactive_file') totalInactiveFile = value;
  }
  if (preferTotal && totalInactiveFile !== null) return totalInactiveFile;
  if (inactiveFile !== null) return inactiveFile;
  if (totalInactiveFile !== null) return totalInactiveFile;
  return 0;
}

function buildWorkingSet(total: number, rawUsage: number, inactiveFile: number): HostCgroupMemory {
  const workingSet = Math.max(0, rawUsage - Math.max(0, inactiveFile));
  const used = Math.min(workingSet, total);
  const free = Math.max(0, total - used);
  const usagePercent = total > 0 ? (used / total) * 100 : 0;
  return { total, used, free, usagePercent };
}

interface DirMemoryReading {
  limit: number | null;
  rawUsage: number | null;
  inactiveFile: number;
}

async function detectUnifiedV2(cgroupFsRoot: string): Promise<boolean> {
  return pathExists(path.join(cgroupFsRoot, 'cgroup.controllers'));
}

async function readDirMemoryV2(cgroupFsRoot: string, rel: string): Promise<DirMemoryReading> {
  const limit = parseFiniteMemoryLimit(await readText(joinCgroupFs(cgroupFsRoot, rel, 'memory.max')));
  const rawUsage = parseUint(await readText(joinCgroupFs(cgroupFsRoot, rel, 'memory.current')));
  const inactiveFile = parseMemoryStatInactiveFile(
    await readText(joinCgroupFs(cgroupFsRoot, rel, 'memory.stat')),
    false,
  );
  return { limit, rawUsage, inactiveFile };
}

async function readDirMemoryV1(cgroupFsRoot: string, rel: string): Promise<DirMemoryReading> {
  const limit = parseFiniteMemoryLimit(
    await readText(joinController(cgroupFsRoot, 'memory', rel, 'memory.limit_in_bytes')),
  );
  const rawUsage = parseUint(
    await readText(joinController(cgroupFsRoot, 'memory', rel, 'memory.usage_in_bytes')),
  );
  const inactiveFile = parseMemoryStatInactiveFile(
    await readText(joinController(cgroupFsRoot, 'memory', rel, 'memory.stat')),
    true,
  );
  return { limit, rawUsage, inactiveFile };
}

async function readDirCpuV2(cgroupFsRoot: string, rel: string): Promise<number | null> {
  const quotaCores = parseCpuMaxCores(await readText(joinCgroupFs(cgroupFsRoot, rel, 'cpu.max')));
  // Root cpuset is host affinity (often every hypervisor CPU), not node capacity.
  if (rel === '/') return quotaCores;

  const effectiveRaw = await readText(joinCgroupFs(cgroupFsRoot, rel, 'cpuset.cpus.effective'));
  let cpusetCores: number | null;
  if (effectiveRaw !== undefined) {
    // Present-but-empty means no runnable CPUs here; do not fall back to requested.
    cpusetCores = countCpusetList(effectiveRaw);
  } else {
    cpusetCores = countCpusetList(await readText(joinCgroupFs(cgroupFsRoot, rel, 'cpuset.cpus')));
  }
  return pickEffectiveCpuCores(quotaCores, cpusetCores);
}

async function readDirCpuV1(cgroupFsRoot: string, rel: string): Promise<number | null> {
  const quotaCores = parseV1CpuQuotaCores(
    await readText(joinController(cgroupFsRoot, 'cpu', rel, 'cpu.cfs_quota_us')),
    await readText(joinController(cgroupFsRoot, 'cpu', rel, 'cpu.cfs_period_us')),
  );
  if (rel === '/') return quotaCores;
  const cpusetCores = countCpusetList(
    await readText(joinController(cgroupFsRoot, 'cpuset', rel, 'cpuset.cpus')),
  );
  return pickEffectiveCpuCores(quotaCores, cpusetCores);
}

/**
 * Read host-scoped cgroup capacity. Returns null when the container boundary
 * cannot be established or when neither memory nor CPU has a finite limit.
 */
export async function readHostScopedCgroupCapacity(
  options: HostCgroupCapacityOptions = {},
): Promise<HostCgroupCapacitySnapshot | null> {
  try {
    const cgroupFilePath = options.cgroupFilePath ?? DEFAULT_CGROUP_FILE;
    const cgroupFsRoot = options.cgroupFsRoot ?? DEFAULT_CGROUP_FS_ROOT;

    const cgroupContents = await readText(cgroupFilePath);
    if (!cgroupContents) return null;

    const containerId = options.containerId !== undefined
      ? options.containerId
      : extractContainerIdFromCgroupContents(cgroupContents);
    if (!containerId) return null;

    const selfRelPath = parseSelfCgroupRelativePath(cgroupContents);
    if (!selfRelPath) return null;

    const hostChain = hostScopedAncestorChain(selfRelPath, containerId);
    if (!hostChain || hostChain.length === 0) return null;

    const unified = await detectUnifiedV2(cgroupFsRoot);
    const readMemory = unified ? readDirMemoryV2 : readDirMemoryV1;
    const readCpu = unified ? readDirCpuV2 : readDirCpuV1;

    // Chain is deep-first; keep the first dir among equal limits (deepest win).
    let bestMemoryRel: string | null = null;
    let bestMemoryReading: DirMemoryReading | null = null;
    let bestCpuCores: number | null = null;

    for (const rel of hostChain) {
      const mem = await readMemory(cgroupFsRoot, rel);
      if (mem.limit !== null && (bestMemoryReading?.limit == null || mem.limit < bestMemoryReading.limit)) {
        bestMemoryRel = rel;
        bestMemoryReading = mem;
      }

      const cores = await readCpu(cgroupFsRoot, rel);
      if (cores !== null && (bestCpuCores === null || cores < bestCpuCores)) {
        bestCpuCores = cores;
      }
    }

    let memory: HostCgroupMemory | null = null;
    if (
      bestMemoryReading?.limit != null
      && bestMemoryRel !== null
      && bestMemoryReading.rawUsage !== null
    ) {
      memory = buildWorkingSet(
        bestMemoryReading.limit,
        bestMemoryReading.rawUsage,
        bestMemoryReading.inactiveFile,
      );
      logOnce(`mem:${bestMemoryRel}`, `[HostCgroup] Using host-scoped memory from ${bestMemoryRel}`);
    }

    if (bestCpuCores !== null) {
      logOnce(`cpu:${bestCpuCores}`, `[HostCgroup] Using host-scoped CPU cores=${bestCpuCores}`);
    }

    if (!memory && bestCpuCores === null) return null;
    return { memory, cpuCores: bestCpuCores };
  } catch (err) {
    console.warn('[HostCgroup] Failed to read capacity; falling open:', (err as Error)?.message || err);
    return null;
  }
}
