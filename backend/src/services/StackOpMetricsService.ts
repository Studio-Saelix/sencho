/**
 * In-memory counters + latency samples for stack lifecycle operations.
 * Internal-only - never exported to any external system. Surfaced to
 * admins via GET /api/stack-metrics so operators have a way to debug
 * "why is this remote node slow today?" without scrolling logs.
 *
 * State is process-local on purpose. A Sencho restart clears all metrics;
 * the alternative (persisting to SQLite) would add write amplification
 * to every lifecycle op for very little operator value.
 */

export type StackOpAction = 'deploy' | 'down' | 'restart' | 'stop' | 'start' | 'update';

interface StackOpStats {
  count: number;
  successCount: number;
  errorCount: number;
  totalMs: number;
  /**
   * Ring buffer of recent latencies (newest at the end). Capped at
   * MAX_SAMPLES to bound memory regardless of throughput. p50/p95 are
   * computed from this window on demand.
   */
  recentSamples: number[];
}

export interface StackOpSnapshotEntry {
  nodeId: number;
  action: StackOpAction;
  count: number;
  successCount: number;
  errorCount: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
}

const MAX_SAMPLES = 1000;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

export class StackOpMetricsService {
  private static instance: StackOpMetricsService;
  private readonly stats = new Map<string, StackOpStats>();

  public static getInstance(): StackOpMetricsService {
    if (!StackOpMetricsService.instance) {
      StackOpMetricsService.instance = new StackOpMetricsService();
    }
    return StackOpMetricsService.instance;
  }

  public static resetForTests(): void {
    this.instance = new StackOpMetricsService();
  }

  private key(nodeId: number, action: StackOpAction): string {
    return `${nodeId}:${action}`;
  }

  /**
   * Record one completed op. Call from the route layer after the lifecycle
   * call resolves or rejects; `ok=false` for the rejection path.
   */
  public record(nodeId: number, action: StackOpAction, durationMs: number, ok: boolean): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const k = this.key(nodeId, action);
    let s = this.stats.get(k);
    if (!s) {
      s = { count: 0, successCount: 0, errorCount: 0, totalMs: 0, recentSamples: [] };
      this.stats.set(k, s);
    }
    s.count += 1;
    if (ok) s.successCount += 1;
    else s.errorCount += 1;
    s.totalMs += durationMs;
    s.recentSamples.push(durationMs);
    if (s.recentSamples.length > MAX_SAMPLES) {
      // Drop oldest. Array.shift is O(n) but n is bounded to MAX_SAMPLES
      // and this path is once-per-stack-op (low cadence).
      s.recentSamples.shift();
    }
  }

  public snapshot(): StackOpSnapshotEntry[] {
    const out: StackOpSnapshotEntry[] = [];
    for (const [key, s] of this.stats.entries()) {
      const [nodeIdStr, action] = key.split(':');
      const nodeId = Number(nodeIdStr);
      if (!Number.isFinite(nodeId)) continue;
      const sorted = [...s.recentSamples].sort((a, b) => a - b);
      out.push({
        nodeId,
        action: action as StackOpAction,
        count: s.count,
        successCount: s.successCount,
        errorCount: s.errorCount,
        avgMs: s.count === 0 ? 0 : Math.round(s.totalMs / s.count),
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
      });
    }
    // Stable ordering: nodeId asc, then action asc.
    out.sort((a, b) => a.nodeId - b.nodeId || a.action.localeCompare(b.action));
    return out;
  }

  public size(): number {
    return this.stats.size;
  }
}
