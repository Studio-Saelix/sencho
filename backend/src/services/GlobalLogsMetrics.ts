/**
 * GlobalLogsMetrics: process-local counters for the Global Observability log
 * path (the SSE stream and the polling snapshot). Strictly process-local and
 * in-memory: Sencho does not export metrics to any external sink (privacy
 * posture, process-local by design), and unlike PilotMetrics these counters
 * are NOT persisted to SQLite because they describe ephemeral live-stream
 * activity that is meaningless across a restart. They reset on process start.
 *
 * Surfaced via GET /api/system/log-stream-metrics (admin only). Purpose is
 * operator support: spot a connection gauge that never drains (a leak) or a
 * rising attach/frame-error count (a daemon or demux problem).
 *
 * No general in-process metrics facility exists in the backend today; this is
 * a per-feature pattern mirroring PilotMetrics. When a shared facility lands,
 * this module should be replaced by an instance of it rather than grown.
 */

export interface LogStreamCounters {
  /** Live gauge: SSE connections currently open. Should drain to 0 when no tab watches. */
  active_sse_connections: number;
  /** Monotonic: SSE connections opened since process start. */
  sse_connections_total: number;
  /** Monotonic: polling-fallback snapshot requests served. */
  poll_requests_total: number;
  /** Monotonic: log lines pushed to clients (SSE + polling). */
  lines_streamed_total: number;
  /** Monotonic: follow-stream attach failures and mid-stream stream errors. */
  stream_attach_errors_total: number;
  /** Monotonic: malformed demux frame headers (corrupt stream, resynced). */
  demux_frame_errors_total: number;
}

type MonotonicCounter = Exclude<keyof LogStreamCounters, 'active_sse_connections'>;

const ZERO: LogStreamCounters = {
  active_sse_connections: 0,
  sse_connections_total: 0,
  poll_requests_total: 0,
  lines_streamed_total: 0,
  stream_attach_errors_total: 0,
  demux_frame_errors_total: 0,
};

class GlobalLogsMetricsImpl {
  private counters: LogStreamCounters = { ...ZERO };

  /** Increment a monotonic counter by `by` (default 1). */
  public increment(name: MonotonicCounter, by = 1): void {
    this.counters[name] += by;
  }

  /** A new SSE connection opened: bump the gauge and the total. */
  public openConnection(): void {
    this.counters.active_sse_connections += 1;
    this.counters.sse_connections_total += 1;
  }

  /** An SSE connection closed: drop the gauge, clamped at zero. */
  public closeConnection(): void {
    this.counters.active_sse_connections = Math.max(0, this.counters.active_sse_connections - 1);
  }

  public snapshot(): LogStreamCounters {
    return { ...this.counters };
  }

  /** Reset all in-memory state. Tests only. */
  public resetForTests(): void {
    this.counters = { ...ZERO };
  }
}

export const GlobalLogsMetrics = new GlobalLogsMetricsImpl();
