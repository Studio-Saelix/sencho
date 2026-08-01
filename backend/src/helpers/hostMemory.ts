import si from 'systeminformation';
import { promises as fs } from 'fs';

/**
 * Shared host-memory computation, ZFS ARC and VM-balloon aware.
 *
 * `systeminformation.mem()` derives `active` as `total - available` on
 * Linux/BSD/macOS, so keying usage off `active` already dodges page-cache
 * inflation. It does NOT account for two sources of reclaimable memory:
 *
 * 1. **OpenZFS ARC**: the kernel's MemAvailable treats ARC as unavailable
 *    even though ARC shrinks under memory pressure.
 * 2. **VM memory ballooning**: hypervisors (TrueNAS/KVM, Proxmox) reclaim
 *    guest memory through a balloon driver. The reclaimed amount appears in
 *    `/proc/meminfo` as `Balloon: N kB` but is invisible to
 *    `systeminformation.mem()`, so a ballooned VM can read as memory-critical
 *    when the guest is actually healthy.
 *
 * When ARC kstats are readable we add the reclaimable portion
 * (`max(size - c_min, 0)`) back into available memory. When `/proc/meminfo`
 * reports a nonzero `Balloon:` value we subtract the ballooned amount from
 * used and recompute an effective usage percentage. On non-ZFS / non-VM
 * hosts, or when the files are not readable inside the container, both
 * adjustments resolve to zero and the result is identical to the previous
 * `active / total` behavior.
 */

/** Effective host memory after ARC and balloon adjustments. */
export interface HostMemory {
  total: number;
  /** Effective used bytes (ARC-adjusted). */
  used: number;
  /** Effective available bytes (ARC-adjusted). */
  free: number;
  /** Effective used as a percentage of total (0 when total is 0). */
  usagePercent: number;
  /** Balloon-reclaimed bytes (from /proc/meminfo). Present only when > 0. */
  ballooned?: number;
  /** Total memory (same as `total`; provided for symmetric UI code). */
  effectiveTotal?: number;
  /** Used bytes after subtracting both ARC reclaim and balloon. */
  effectiveUsed?: number;
  /** Free bytes after adding both ARC reclaim and balloon. */
  effectiveFree?: number;
  /** Effective used as a percentage (balloon-adjusted). */
  effectiveUsagePercent?: number;
  /** Source identifier for the balloon reading. */
  balloonSource?: 'linux_proc_meminfo';
}

type MemData = Awaited<ReturnType<typeof si.mem>>;

/**
 * Candidate arcstats paths in priority order. The operator override is only
 * present when SENCHO_ZFS_ARCSTATS_PATH is set; the two fixed paths are the
 * host-mounted and the standard container-visible kstat locations.
 */
export const ARCSTATS_FIXED_PATHS = [
  '/host/proc/spl/kstat/zfs/arcstats',
  '/proc/spl/kstat/zfs/arcstats',
];

/** Bound reads of the operator-supplied override path; arcstats is a few KB. */
const MAX_ARCSTATS_BYTES = 1024 * 1024;

/**
 * Candidate /proc/meminfo paths in priority order. The operator override is
 * only present when SENCHO_PROC_MEMINFO_PATH is set; the two fixed paths are
 * the host-mounted and the standard container-visible locations.
 */
export const MEMINFO_FIXED_PATHS = [
  '/host/proc/meminfo',
  '/proc/meminfo',
];

// Memoized so a 30s monitor tick / dashboard poll does not log on every cycle.
const loggedSelectedPaths = new Set<string>();
const loggedErrorCodes = new Set<string>();

function arcOverridePath(): string | undefined {
  const raw = process.env.SENCHO_ZFS_ARCSTATS_PATH?.trim();
  return raw ? raw : undefined;
}

function meminfoOverridePath(): string | undefined {
  const raw = process.env.SENCHO_PROC_MEMINFO_PATH?.trim();
  return raw ? raw : undefined;
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

function logUnexpected(context: string, err: unknown): void {
  const code = (err as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
  if (loggedErrorCodes.has(code)) return;
  loggedErrorCodes.add(code);
  console.warn(`[HostMemory] Unexpected error reading ARC stats (${context}, ${code}); treating ARC as reclaimable=0`);
}

/** Parse the kstat table for the `size` and `c_min` rows (`<name> <type> <value>`). */
function parseArcstats(raw: string): { size?: number; cMin?: number } {
  let size: number | undefined;
  let cMin: number | undefined;
  for (const line of raw.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    if (parts[0] === 'size') size = Number(parts[2]);
    else if (parts[0] === 'c_min') cMin = Number(parts[2]);
  }
  return { size, cMin };
}

/**
 * Parse a /proc/meminfo body for the `Balloon:` line. Returns bytes, or
 * undefined when the field is absent/malformed. Only the standard `<N> kB`
 * format is recognized.
 */
function parseMeminfoBalloon(raw: string): number | undefined {
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('Balloon:')) continue;
    const parts = trimmed.split(/\s+/);
    // Expect "Balloon: <N> kB" (3 tokens).
    if (parts.length !== 3 || parts[2] !== 'kB') return undefined;
    const value = Number(parts[1]);
    if (!Number.isFinite(value) || value < 0) return undefined;
    return value * 1024;
  }
  return undefined;
}

/**
 * Ballooned memory in bytes, or 0 when the meminfo field is absent/unusable.
 * Never throws: any error resolves to 0 so balloon awareness can only lower a
 * false-positive reading, never break host-memory reporting.
 */
async function readBalloonedMemory(): Promise<number> {
  const override = meminfoOverridePath();
  const candidates = override ? [override, ...MEMINFO_FIXED_PATHS] : MEMINFO_FIXED_PATHS;
  for (const candidatePath of candidates) {
    try {
      // The override path is operator-supplied: verify it is a regular file
      // of bounded size before reading (guards against a named pipe or an
      // accidentally huge target). The fixed meminfo paths are trusted.
      if (candidatePath === override) {
        const info = await fs.stat(candidatePath);
        if (!info.isFile() || info.size > MAX_ARCSTATS_BYTES) continue;
      }
      const raw = await fs.readFile(candidatePath, 'utf8');
      const ballooned = parseMeminfoBalloon(raw);
      if (ballooned === undefined) continue;
      if (!loggedSelectedPaths.has(candidatePath)) {
        loggedSelectedPaths.add(candidatePath);
        console.debug(`[HostMemory] Using meminfo from ${candidatePath}`);
      }
      return ballooned;
    } catch (err) {
      // Fail open: a missing or unreadable meminfo is the normal non-VM case
      // (expected fs errors); an unexpected error is logged once but still
      // falls through so balloon awareness can only lower a false positive.
      if (isExpectedFsError(err)) continue;
      const code = (err as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
      if (loggedErrorCodes.has(code)) continue;
      loggedErrorCodes.add(code);
      console.warn(`[HostMemory] Unexpected error reading meminfo (${candidatePath}, ${code}); treating ballooned as 0`);
    }
  }
  return 0;
}

/**
 * Reclaimable ARC in bytes, or 0 when ARC stats are unavailable/unusable.
 * Never throws: any error resolves to 0 so ARC awareness can only lower a
 * false-positive reading, never break host-memory reporting.
 */
async function readReclaimableArc(): Promise<number> {
  const override = arcOverridePath();
  const candidates = override ? [override, ...ARCSTATS_FIXED_PATHS] : ARCSTATS_FIXED_PATHS;
  for (const candidatePath of candidates) {
    try {
      // The override path is operator-supplied: verify it is a regular file
      // of bounded size before reading (guards against a named pipe or an
      // accidentally huge target). The fixed kstat paths are trusted.
      if (candidatePath === override) {
        const info = await fs.stat(candidatePath);
        if (!info.isFile() || info.size > MAX_ARCSTATS_BYTES) continue;
      }
      const raw = await fs.readFile(candidatePath, 'utf8');
      const { size, cMin } = parseArcstats(raw);
      if (size === undefined || cMin === undefined) continue;
      if (!Number.isFinite(size) || !Number.isFinite(cMin) || size < 0 || cMin < 0) continue;
      // A valid record resolves the lookup, even when reclaimable is 0
      // (size < c_min means ARC is at its floor).
      if (!loggedSelectedPaths.has(candidatePath)) {
        loggedSelectedPaths.add(candidatePath);
        console.debug(`[HostMemory] Using ZFS ARC stats from ${candidatePath}`);
      }
      return Math.max(size - cMin, 0);
    } catch (err) {
      // Fail open: a missing or unreadable kstat is the normal non-ZFS case
      // (expected fs errors); an unexpected error is logged once but still
      // falls through so ARC awareness can only lower a false positive.
      if (isExpectedFsError(err)) continue;
      logUnexpected(candidatePath, err);
    }
  }
  return 0;
}

/**
 * Pure ARC adjustment. With `arcReclaimable === 0` this reproduces the prior
 * `active / total` percentage exactly (since `active === total - available`).
 */
export function adjustForArc(mem: Pick<MemData, 'total' | 'available'>, arcReclaimable: number): HostMemory {
  const effectiveAvailable = Math.min(mem.total, mem.available + Math.max(arcReclaimable, 0));
  const effectiveUsed = Math.max(mem.total - effectiveAvailable, 0);
  const usagePercent = mem.total > 0 ? (effectiveUsed / mem.total) * 100 : 0;
  return { total: mem.total, used: effectiveUsed, free: effectiveAvailable, usagePercent };
}

/**
 * Balloon adjustment layer. Applies on top of the ARC-adjusted result.
 * When `ballooned <= 0` the input is returned unchanged, preserving exact
 * `.toEqual()` backward compatibility for every existing test assertion.
 */
export function adjustForBalloon(hostMem: HostMemory, ballooned: number): HostMemory {
  if (ballooned <= 0) return hostMem;
  const effectiveUsed = Math.max(hostMem.used - ballooned, 0);
  const effectiveFree = Math.min(hostMem.free + ballooned, hostMem.total);
  const effectiveUsagePercent = hostMem.total > 0
    ? (effectiveUsed / hostMem.total) * 100
    : 0;
  return {
    ...hostMem,
    ballooned,
    effectiveTotal: hostMem.total,
    effectiveUsed,
    effectiveFree,
    effectiveUsagePercent,
    balloonSource: 'linux_proc_meminfo' as const,
  };
}

/** Fetch host memory, reclaimable ARC, and ballooned memory concurrently. */
export async function getHostMemory(): Promise<HostMemory> {
  const [mem, arcReclaimable, ballooned] = await Promise.all([
    si.mem(),
    readReclaimableArc(),
    readBalloonedMemory(),
  ]);
  return adjustForBalloon(adjustForArc(mem, arcReclaimable), ballooned);
}
