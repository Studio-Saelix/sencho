import { DatabaseService } from '../services/DatabaseService';

/**
 * Shared diagnostic logging gate. Reads `developer_mode` from
 * DatabaseService, which caches the global_settings snapshot internally
 * and invalidates on write, so hot-path callers can query freely.
 *
 * Acceptable: error paths, per-request paths, per-tunnel paths,
 * once-per-stream paths. Each call costs one Map lookup in Node's
 * require cache, one method call into the cached settings object, and
 * a property access. Fine for these cadences.
 *
 * NOT acceptable: per-frame paths in steady state (WebSocket message
 * loops, container stats streams, log-tail demuxers). The require
 * lookup and singleton dispatch add up at thousands of calls per
 * second. If you need diagnostic logging in a per-frame loop,
 * snapshot the result once outside the loop and read the snapshot
 * inside.
 */

export function isDebugEnabled(): boolean {
  try {
    if (process.env.NODE_ENV === 'test' && !process.env.DATA_DIR) return false;
    return DatabaseService.getInstance().getGlobalSettings().developer_mode === '1';
  } catch {
    return false;
  }
}
