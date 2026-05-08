/**
 * Shared diagnostic logging gate. Reads `developer_mode` from
 * DatabaseService, which caches the global_settings snapshot internally
 * and invalidates on write, so hot-path callers can query freely.
 *
 * Acceptable: error paths, per-request paths, per-tunnel paths,
 * once-per-stream paths. Each call costs one Map lookup in Node's
 * require cache, one method call into the cached settings object, and
 * a property access — fine for these cadences.
 *
 * NOT acceptable: per-frame paths in steady state (WebSocket message
 * loops, container stats streams, log-tail demuxers). The try/catch
 * frame setup and the hop into DatabaseService add up at thousands of
 * calls per second. If you need diagnostic logging in a per-frame
 * loop, snapshot the result once outside the loop and read the
 * snapshot inside.
 */

export function isDebugEnabled(): boolean {
  try {
    // Dynamic require avoids circular-dependency issues when this
    // utility is imported from services that DatabaseService itself
    // depends on, and prevents SQLite side effects during tests.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseService } = require('../services/DatabaseService');
    return DatabaseService.getInstance().getGlobalSettings().developer_mode === '1';
  } catch {
    return false;
  }
}
