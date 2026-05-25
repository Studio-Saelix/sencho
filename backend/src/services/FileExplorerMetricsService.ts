/**
 * In-memory counters + latency samples for stack file explorer operations.
 * Internal-only; never exported to any external system. Surfaced to admins via
 * GET /api/file-explorer-metrics so operators can answer "why is the file
 * editor slow on this node?" without scrolling logs.
 *
 * State is process-local. A Sencho restart clears everything; the alternative
 * (persisting to SQLite) would add write amplification to every file op for
 * very little operator value. Each node tracks its own ops. A request that
 * targets a remote node is recorded by the remote Sencho, not the central.
 */

export type FileExplorerOp =
  | 'list'
  | 'read'
  | 'download'
  | 'permissionsRead'
  | 'upload'
  | 'write'
  | 'delete'
  | 'mkdir'
  | 'rename'
  | 'chmod';

interface FileExplorerOpStats {
  count: number;
  successCount: number;
  errorCount: number;
  totalMs: number;
  /**
   * Ring buffer of recent latencies (newest at the end). Capped at MAX_SAMPLES
   * to bound memory regardless of throughput. p50/p95 are computed from this
   * window on demand.
   */
  recentSamples: number[];
}

export interface FileExplorerSnapshotEntry {
  nodeId: number;
  op: FileExplorerOp;
  count: number;
  successCount: number;
  errorCount: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface FileExplorerSnapshot {
  entries: FileExplorerSnapshotEntry[];
  uploadBytesByNode: Array<{ nodeId: number; totalBytes: number }>;
}

const MAX_SAMPLES = 1000;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

export class FileExplorerMetricsService {
  private static instance: FileExplorerMetricsService;
  private readonly stats = new Map<string, FileExplorerOpStats>();
  private readonly uploadBytes = new Map<number, number>();

  public static getInstance(): FileExplorerMetricsService {
    if (!FileExplorerMetricsService.instance) {
      FileExplorerMetricsService.instance = new FileExplorerMetricsService();
    }
    return FileExplorerMetricsService.instance;
  }

  public static resetForTests(): void {
    this.instance = new FileExplorerMetricsService();
  }

  private key(nodeId: number, op: FileExplorerOp): string {
    return `${nodeId}:${op}`;
  }

  /**
   * Record one completed op. `ok=false` for the rejection path. Call once per
   * request from the route layer regardless of success or failure.
   */
  public record(nodeId: number, op: FileExplorerOp, durationMs: number, ok: boolean): void {
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
      // Drop oldest. Array.shift is O(n) but n is bounded to MAX_SAMPLES and
      // this path runs once per file op (low cadence).
      s.recentSamples.shift();
    }
  }

  /**
   * Record bytes flowing through an upload. Tracked separately because the
   * latency histogram alone hides whether a slow node is being asked to take
   * many small uploads or a few large ones.
   */
  public recordUploadBytes(nodeId: number, bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) return;
    this.uploadBytes.set(nodeId, (this.uploadBytes.get(nodeId) ?? 0) + bytes);
  }

  public snapshot(): FileExplorerSnapshot {
    const entries: FileExplorerSnapshotEntry[] = [];
    for (const [key, s] of this.stats.entries()) {
      const [nodeIdStr, op] = key.split(':');
      const nodeId = Number(nodeIdStr);
      if (!Number.isFinite(nodeId)) continue;
      const sorted = [...s.recentSamples].sort((a, b) => a - b);
      entries.push({
        nodeId,
        op: op as FileExplorerOp,
        count: s.count,
        successCount: s.successCount,
        errorCount: s.errorCount,
        avgMs: s.count === 0 ? 0 : Math.round(s.totalMs / s.count),
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
      });
    }
    entries.sort((a, b) => a.nodeId - b.nodeId || a.op.localeCompare(b.op));

    const uploadBytesByNode: Array<{ nodeId: number; totalBytes: number }> = [];
    for (const [nodeId, totalBytes] of this.uploadBytes.entries()) {
      uploadBytesByNode.push({ nodeId, totalBytes });
    }
    uploadBytesByNode.sort((a, b) => a.nodeId - b.nodeId);

    return { entries, uploadBytesByNode };
  }

  public size(): number {
    return this.stats.size;
  }
}
