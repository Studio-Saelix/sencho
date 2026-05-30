import { describe, it, expect, beforeEach } from 'vitest';
import { GlobalLogsMetrics } from '../services/GlobalLogsMetrics';
import { mapWithConcurrency } from '../routes/metrics';

describe('GlobalLogsMetrics', () => {
  beforeEach(() => GlobalLogsMetrics.resetForTests());

  it('starts at all-zero', () => {
    const s = GlobalLogsMetrics.snapshot();
    expect(s.active_sse_connections).toBe(0);
    expect(s.sse_connections_total).toBe(0);
    expect(s.lines_streamed_total).toBe(0);
  });

  it('openConnection bumps both the gauge and the total; closeConnection drops only the gauge', () => {
    GlobalLogsMetrics.openConnection();
    GlobalLogsMetrics.openConnection();
    expect(GlobalLogsMetrics.snapshot().active_sse_connections).toBe(2);
    expect(GlobalLogsMetrics.snapshot().sse_connections_total).toBe(2);

    GlobalLogsMetrics.closeConnection();
    expect(GlobalLogsMetrics.snapshot().active_sse_connections).toBe(1);
    // The monotonic total is untouched by a close.
    expect(GlobalLogsMetrics.snapshot().sse_connections_total).toBe(2);
  });

  it('clamps the active gauge at zero on an unbalanced close', () => {
    GlobalLogsMetrics.closeConnection();
    GlobalLogsMetrics.closeConnection();
    expect(GlobalLogsMetrics.snapshot().active_sse_connections).toBe(0);
  });

  it('increments a monotonic counter by an explicit amount', () => {
    GlobalLogsMetrics.increment('lines_streamed_total', 5);
    GlobalLogsMetrics.increment('lines_streamed_total');
    expect(GlobalLogsMetrics.snapshot().lines_streamed_total).toBe(6);
  });

  it('snapshot returns a copy, not a live reference', () => {
    const s = GlobalLogsMetrics.snapshot();
    s.lines_streamed_total = 999;
    expect(GlobalLogsMetrics.snapshot().lines_streamed_total).toBe(0);
  });
});

describe('mapWithConcurrency', () => {
  it('runs every item exactly once', async () => {
    const seen: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => { seen.push(n); });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('never exceeds the concurrency limit in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([...Array(20).keys()], 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 2));
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // proves it actually parallelizes
  });

  it('is a no-op on an empty array', async () => {
    let calls = 0;
    await mapWithConcurrency([], 4, async () => { calls += 1; });
    expect(calls).toBe(0);
  });
});
