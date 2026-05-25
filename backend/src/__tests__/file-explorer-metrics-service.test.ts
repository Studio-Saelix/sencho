import { describe, it, expect, beforeEach } from 'vitest';
import { FileExplorerMetricsService } from '../services/FileExplorerMetricsService';

beforeEach(() => {
  FileExplorerMetricsService.resetForTests();
});

describe('FileExplorerMetricsService', () => {
  it('aggregates count, success, error, and avg/p50/p95 latency per (nodeId, op)', () => {
    const svc = FileExplorerMetricsService.getInstance();
    svc.record(1, 'upload', 10, true);
    svc.record(1, 'upload', 30, true);
    svc.record(1, 'upload', 50, false);
    svc.record(1, 'read', 5, true);
    svc.record(2, 'upload', 1000, true);

    const { entries } = svc.snapshot();
    const node1Upload = entries.find(e => e.nodeId === 1 && e.op === 'upload')!;
    expect(node1Upload.count).toBe(3);
    expect(node1Upload.successCount).toBe(2);
    expect(node1Upload.errorCount).toBe(1);
    expect(node1Upload.avgMs).toBe(30);
    // percentile() floors (n-1) * p, so with sorted = [10, 30, 50]: p50 = sorted[1] = 30
    // and p95 = sorted[floor((3-1)*0.95)] = sorted[1] = 30. The shared pattern with
    // StackOpMetricsService accepts this off-by-floor; the histogram is for
    // operator triage, not statistical reporting.
    expect(node1Upload.p50Ms).toBe(30);
    expect(node1Upload.p95Ms).toBe(30);

    const node1Read = entries.find(e => e.nodeId === 1 && e.op === 'read')!;
    expect(node1Read.count).toBe(1);
    expect(node1Read.successCount).toBe(1);
    expect(node1Read.errorCount).toBe(0);

    const node2Upload = entries.find(e => e.nodeId === 2 && e.op === 'upload')!;
    expect(node2Upload.count).toBe(1);
    expect(node2Upload.avgMs).toBe(1000);
  });

  it('rejects negative or non-finite latency without growing the ring buffer', () => {
    const svc = FileExplorerMetricsService.getInstance();
    svc.record(1, 'upload', -1, true);
    svc.record(1, 'upload', NaN, true);
    svc.record(1, 'upload', Infinity, true);
    expect(svc.size()).toBe(0);
    expect(svc.snapshot().entries).toEqual([]);
  });

  it('caps the ring buffer at 1000 samples (older samples dropped on overflow)', () => {
    const svc = FileExplorerMetricsService.getInstance();
    // Record 1050 ops with increasing latencies. p95 should reflect the recent
    // window, not the dropped low values from the very start.
    for (let i = 0; i < 1050; i++) {
      svc.record(1, 'upload', i, true);
    }
    const entry = svc.snapshot().entries.find(e => e.nodeId === 1 && e.op === 'upload')!;
    expect(entry.count).toBe(1050);
    // The ring buffer dropped the first 50, so p50 ≈ 524 (middle of 50..1049)
    // and p95 ≈ 1001 (95th percentile of the same window). Use a relaxed
    // tolerance because percentile() floors the index.
    expect(entry.p50Ms).toBeGreaterThan(520);
    expect(entry.p50Ms).toBeLessThan(560);
    expect(entry.p95Ms).toBeGreaterThan(990);
  });

  it('tracks upload bytes per node and sorts the snapshot by nodeId', () => {
    const svc = FileExplorerMetricsService.getInstance();
    svc.recordUploadBytes(2, 1024);
    svc.recordUploadBytes(1, 512);
    svc.recordUploadBytes(2, 256);

    const { uploadBytesByNode } = svc.snapshot();
    expect(uploadBytesByNode).toEqual([
      { nodeId: 1, totalBytes: 512 },
      { nodeId: 2, totalBytes: 1280 },
    ]);
  });

  it('ignores negative or non-finite upload byte counts', () => {
    const svc = FileExplorerMetricsService.getInstance();
    svc.recordUploadBytes(1, -100);
    svc.recordUploadBytes(1, NaN);
    svc.recordUploadBytes(1, Infinity);
    expect(svc.snapshot().uploadBytesByNode).toEqual([]);
  });

  it('snapshot entries sort by nodeId ascending then op alphabetically', () => {
    const svc = FileExplorerMetricsService.getInstance();
    svc.record(2, 'upload', 1, true);
    svc.record(1, 'write', 1, true);
    svc.record(1, 'read', 1, true);

    const { entries } = svc.snapshot();
    expect(entries.map(e => `${e.nodeId}:${e.op}`)).toEqual([
      '1:read',
      '1:write',
      '2:upload',
    ]);
  });
});
