import os from 'os';

/**
 * Below this floor of free host memory, treat an ENOENT or ENOMEM
 * spawn failure as a memory-pressure event rather than a missing binary.
 * Linux libuv's posix_spawn can fail to allocate its argv/path-search arena
 * under memory pressure and surface the underlying ENOMEM as ENOENT, sending
 * operators down a "missing binary" debugging path when the real cause is
 * host OOM. 128 MiB is well above the point where posix_spawn starts dropping
 * arenas yet low enough that a healthy homelab host never trips it.
 */
export const LOW_MEMORY_FLOOR_BYTES = 128 * 1024 * 1024;

export interface SpawnErrorContext {
  /** Literal first argument passed to spawn/exec (e.g. "docker", "/bin/sh"). */
  command: string;
}

export interface MappedSpawnError {
  /** Operator-facing message. Safe to send through WS / log / throw. */
  message: string;
  /** True when the failure was attributed to host memory pressure. */
  isLowMemory: boolean;
}

/**
 * Rewrite a spawn / exec error into an operator-facing message.
 *
 * Ordering matters: an explicit ENOMEM always wins, then an ENOENT under low
 * free memory is treated as the libuv masquerade case, and only after that
 * does the genuine "docker CLI missing" mapping fire. Other errors pass
 * through unchanged.
 */
export function describeSpawnError(
  error: NodeJS.ErrnoException,
  ctx: SpawnErrorContext,
): MappedSpawnError {
  const free = os.freemem();
  const total = os.totalmem();
  const freeMiB = Math.round(free / (1024 * 1024));
  const totalMiB = Math.round(total / (1024 * 1024));
  const lowMem = free < LOW_MEMORY_FLOOR_BYTES;

  if (error.code === 'ENOMEM') {
    return {
      message: `Out of memory while launching ${ctx.command} (host free memory: ${freeMiB} MiB of ${totalMiB} MiB)`,
      isLowMemory: true,
    };
  }

  if (error.code === 'ENOENT' && lowMem) {
    return {
      message: `Out of memory while launching ${ctx.command} (host free memory: ${freeMiB} MiB of ${totalMiB} MiB; reported as ENOENT under memory pressure)`,
      isLowMemory: true,
    };
  }

  if (error.code === 'ENOENT' && /^spawn docker(?:$| )/.test(error.message ?? '')) {
    return { message: 'Docker CLI unavailable on this node', isLowMemory: false };
  }

  return { message: error.message ?? String(error), isLowMemory: false };
}
