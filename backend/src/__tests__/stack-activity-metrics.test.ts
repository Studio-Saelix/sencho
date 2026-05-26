import { describe, it, expect, beforeEach } from 'vitest';
import { StackActivityMetricsService } from '../services/StackActivityMetricsService';

beforeEach(() => {
  StackActivityMetricsService.resetForTests();
});

describe('StackActivityMetricsService', () => {
  it('counts success and error per (nodeId, op) independently', () => {
    const m = StackActivityMetricsService.getInstance();
    m.record(1, 'read', 5, true);
    m.record(1, 'read', 10, true);
    m.record(1, 'read', 8, false);
    m.record(1, 'write', 2, true);
    m.record(2, 'read', 3, true);

    const snap = m.snapshot();
    const oneRead = snap.entries.find(e => e.nodeId === 1 && e.op === 'read');
    expect(oneRead).toMatchObject({ count: 3, successCount: 2, errorCount: 1 });

    const oneWrite = snap.entries.find(e => e.nodeId === 1 && e.op === 'write');
    expect(oneWrite).toMatchObject({ count: 1, successCount: 1, errorCount: 0 });

    const twoRead = snap.entries.find(e => e.nodeId === 2 && e.op === 'read');
    expect(twoRead).toMatchObject({ count: 1, successCount: 1 });
  });

  it('computes avg, p50, p95 over the ring buffer', () => {
    const m = StackActivityMetricsService.getInstance();
    for (let i = 1; i <= 100; i++) m.record(0, 'read', i, true);
    const snap = m.snapshot();
    const e = snap.entries[0];
    expect(e.count).toBe(100);
    expect(e.avgMs).toBe(Math.round((1 + 100) / 2));
    expect(e.p50Ms).toBeGreaterThanOrEqual(48);
    expect(e.p50Ms).toBeLessThanOrEqual(52);
    expect(e.p95Ms).toBeGreaterThanOrEqual(94);
    expect(e.p95Ms).toBeLessThanOrEqual(96);
  });

  it('drops oldest samples once the ring buffer is full', () => {
    const m = StackActivityMetricsService.getInstance();
    for (let i = 0; i < 1500; i++) m.record(0, 'read', i, true);
    const snap = m.snapshot();
    // count is unbounded; only the latency window is capped.
    expect(snap.entries[0].count).toBe(1500);
    // Samples 500..1499 are retained (oldest 500 evicted), so p50 is 999.
    expect(snap.entries[0].p50Ms).toBeGreaterThanOrEqual(990);
    expect(snap.entries[0].p50Ms).toBeLessThanOrEqual(1010);
  });

  it('ignores invalid durations', () => {
    const m = StackActivityMetricsService.getInstance();
    m.record(0, 'read', Number.NaN, true);
    m.record(0, 'read', -5, true);
    m.record(0, 'read', Number.POSITIVE_INFINITY, true);
    expect(m.snapshot().entries).toEqual([]);
  });

  it('orders snapshot entries by nodeId then op', () => {
    const m = StackActivityMetricsService.getInstance();
    m.record(2, 'write', 1, true);
    m.record(2, 'read', 1, true);
    m.record(1, 'write', 1, true);
    m.record(1, 'read', 1, true);
    const order = m.snapshot().entries.map(e => `${e.nodeId}:${e.op}`);
    expect(order).toEqual(['1:read', '1:write', '2:read', '2:write']);
  });
});
