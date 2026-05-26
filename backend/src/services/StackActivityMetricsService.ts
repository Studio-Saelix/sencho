/**
 * In-memory counters + latency samples for the per-stack activity timeline.
 * Internal-only; never exported to any external system. Surfaced to admins
 * via GET /api/stack-activity-metrics so operators can answer "why is the
 * activity tab slow?" or "is the timeline dropping events?" without
 * scrolling logs.
 *
 * State is process-local. A Sencho restart clears everything; persisting to
 * SQLite would add write amplification to the hot dispatchAlert path for
 * very little operator value. Each node tracks its own ops because the
 * remote-node HTTP proxy (proxy/remoteNodeProxy.ts) short-circuits
 * cross-node requests to the target's own router before this service sees
 * them.
 */

export type StackActivityOp = 'read' | 'write';

interface StackActivityOpStats {
  count: number;
  successCount: number;
  errorCount: number;
  totalMs: number;
  recentSamples: number[];
}

export interface StackActivitySnapshotEntry {
  nodeId: number;
  op: StackActivityOp;
  count: number;
  successCount: number;
  errorCount: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface StackActivitySnapshot {
  entries: StackActivitySnapshotEntry[];
}

const MAX_SAMPLES = 1000;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

export class StackActivityMetricsService {
  private static instance: StackActivityMetricsService;
  private readonly stats = new Map<string, StackActivityOpStats>();

  public static getInstance(): StackActivityMetricsService {
    if (!StackActivityMetricsService.instance) {
      StackActivityMetricsService.instance = new StackActivityMetricsService();
    }
    return StackActivityMetricsService.instance;
  }

  public static resetForTests(): void {
    this.instance = new StackActivityMetricsService();
  }

  private key(nodeId: number, op: StackActivityOp): string {
    return `${nodeId}:${op}`;
  }

  public record(nodeId: number, op: StackActivityOp, durationMs: number, ok: boolean): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const k = this.key(nodeId, op);
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
      s.recentSamples.shift();
    }
  }

  public snapshot(): StackActivitySnapshot {
    const entries: StackActivitySnapshotEntry[] = [];
    for (const [key, s] of this.stats.entries()) {
      const [nodeIdStr, op] = key.split(':');
      const nodeId = Number(nodeIdStr);
      if (!Number.isFinite(nodeId)) continue;
      const sorted = [...s.recentSamples].sort((a, b) => a - b);
      entries.push({
        nodeId,
        op: op as StackActivityOp,
        count: s.count,
        successCount: s.successCount,
        errorCount: s.errorCount,
        avgMs: s.count === 0 ? 0 : Math.round(s.totalMs / s.count),
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
      });
    }
    entries.sort((a, b) => a.nodeId - b.nodeId || a.op.localeCompare(b.op));
    return { entries };
  }

  public size(): number {
    return this.stats.size;
  }
}
