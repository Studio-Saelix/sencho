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

/** Bound reads of the operator-supplied override path; both files are a few KB. */
const MAX_CANDIDATE_BYTES = 1024 * 1024;

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

function logSelectedPath(path: string, label: string): void {
  if (loggedSelectedPaths.has(path)) return;
  loggedSelectedPaths.add(path);
  console.debug(`[HostMemory] Using ${label} from ${path}`);
}

/**
 * Read a single candidate file, applying the operator-override guard (regular
 * file, bounded size) and the fail-open error contract. Returns the raw text,
 * or undefined when the path is unusable so the caller falls through to the
 * next candidate. Unexpected errors are logged once per code.
 */
async function readCandidateFile(path: string, isOverride: boolean): Promise<string | undefined> {
  try {
    // The override path is operator-supplied: verify it is a regular file of
    // bounded size before reading (guards against a named pipe or an
    // accidentally huge target). The fixed paths are trusted.
    if (isOverride) {
      const info = await fs.stat(path);
      if (!info.isFile() || info.size > MAX_CANDIDATE_BYTES) return undefined;
    }
    return await fs.readFile(path, 'utf8');
  } catch (err) {
    // Fail open: a missing or unreadable file is the normal non-ZFS/non-VM
    // case (expected fs errors); an unexpected error is logged once but still
    // falls through so the adjustment can only lower a false positive.
    if (isExpectedFsError(err)) return undefined;
    const code = (err as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
    if (loggedErrorCodes.has(code)) return undefined;
    loggedErrorCodes.add(code);
    console.warn(`[HostMemory] Unexpected error reading ${path} (${code}); treating as 0`);
    return undefined;
  }
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
    const raw = await readCandidateFile(candidatePath, candidatePath === override);
    if (raw === undefined) continue;
    const ballooned = parseMeminfoBalloon(raw);
    if (ballooned === undefined) continue;
    logSelectedPath(candidatePath, 'meminfo');
    return ballooned;
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
    const raw = await readCandidateFile(candidatePath, candidatePath === override);
    if (raw === undefined) continue;
    const { size, cMin } = parseArcstats(raw);
    if (size === undefined || cMin === undefined) continue;
    if (!Number.isFinite(size) || !Number.isFinite(cMin) || size < 0 || cMin < 0) continue;
    // A valid record resolves the lookup, even when reclaimable is 0
    // (size < c_min means ARC is at its floor).
    logSelectedPath(candidatePath, 'ZFS ARC stats');
    return Math.max(size - cMin, 0);
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

/** Wire shape of host memory as served by /api/system/stats and fleet overviews. */
export interface MemoryWire {
  total: number;
  used: number;
  free: number;
  usagePercent: string;
  ballooned?: number;
  effectiveTotal?: number;
  effectiveUsed?: number;
  effectiveFree?: number;
  effectiveUsagePercent?: string;
  balloonSource?: string;
}

/**
 * Map adjusted host memory to the wire shape. Balloon fields are only
 * included when a balloon reading was present, so the non-VM shape stays
 * identical to the pre-balloon wire format.
 */
export function memoryToWire(hostMem: HostMemory): MemoryWire {
  return {
    total: hostMem.total,
    used: hostMem.used,
    free: hostMem.free,
    usagePercent: hostMem.usagePercent.toFixed(1),
    ...(hostMem.ballooned !== undefined
      ? {
          ballooned: hostMem.ballooned,
          effectiveTotal: hostMem.effectiveTotal,
          effectiveUsed: hostMem.effectiveUsed,
          effectiveFree: hostMem.effectiveFree,
          effectiveUsagePercent: hostMem.effectiveUsagePercent?.toFixed(1),
          balloonSource: hostMem.balloonSource,
        }
      : {}),
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
