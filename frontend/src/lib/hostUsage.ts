/**
 * Parse a host usage reading from the metrics or fleet wire.
 *
 * `null`/`undefined` means the host cannot measure that dimension from the
 * Sencho container (a nested container with no cgroup mount), which is not the
 * same as zero and must never be rendered as one. A malformed value is treated
 * the same way rather than as 0%.
 */
export function parseHostUsage(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const value = parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}
