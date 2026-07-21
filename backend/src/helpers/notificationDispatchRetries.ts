/**
 * Strict parser for notification_dispatch_retries (extra attempts, 0..3).
 * Accepts JSON number integers or single-digit strings "0".."3" only.
 * Rejects null, booleans, empty/whitespace, decimals, and out-of-range values.
 */
export function parseNotificationDispatchRetries(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 0 || raw > 3) return null;
    return raw;
  }
  if (typeof raw === 'string') {
    if (!/^[0-3]$/.test(raw)) return null;
    return Number(raw);
  }
  return null;
}
