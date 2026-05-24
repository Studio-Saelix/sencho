/**
 * Unit tests for StackOpMetricsService — the in-process per-(nodeId, action)
 * counter + p50/p95 latency facility surfaced by GET /api/stack-metrics.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { StackOpMetricsService } from '../services/StackOpMetricsService';

beforeEach(() => {
  StackOpMetricsService.resetForTests();
});

describe('StackOpMetricsService', () => {
  it('returns a singleton', () => {
    expect(StackOpMetricsService.getInstance()).toBe(StackOpMetricsService.getInstance());
  });

  it('starts empty', () => {
    expect(StackOpMetricsService.getInstance().size()).toBe(0);
    expect(StackOpMetricsService.getInstance().snapshot()).toEqual([]);
  });

  it('records counts split between success and error', () => {
    const svc = StackOpMetricsService.getInstance();
    svc.record(1, 'deploy', 100, true);
    svc.record(1, 'deploy', 200, false);
    svc.record(1, 'deploy', 300, true);

    const entries = svc.snapshot();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      nodeId: 1,
      action: 'deploy',
      count: 3,
      successCount: 2,
      errorCount: 1,
      avgMs: 200,
    });
  });

  it('keys independently by (nodeId, action)', () => {
    const svc = StackOpMetricsService.getInstance();
    svc.record(1, 'deploy', 10, true);
    svc.record(1, 'restart', 20, true);
    svc.record(2, 'deploy', 30, true);
    expect(svc.size()).toBe(3);
    const entries = svc.snapshot();
    expect(entries.map(e => `${e.nodeId}:${e.action}`)).toEqual([
      '1:deploy', '1:restart', '2:deploy',
    ]);
  });

  it('computes p50 and p95 from recent samples', () => {
    const svc = StackOpMetricsService.getInstance();
    for (let i = 1; i <= 100; i++) {
      svc.record(1, 'deploy', i, true);
    }
    const [entry] = svc.snapshot();
    expect(entry.p50Ms).toBe(50);
    expect(entry.p95Ms).toBe(95);
  });

  it('caps the sample ring buffer at 1000 to bound memory', () => {
    const svc = StackOpMetricsService.getInstance();
    for (let i = 1; i <= 1500; i++) {
      svc.record(1, 'deploy', i, true);
    }
    const [entry] = svc.snapshot();
    expect(entry.count).toBe(1500);
    // p95 uses only the last 1000 samples (501..1500), so p95 = 501 + floor((1000-1) * 0.95) = 501 + 949 = 1450
    expect(entry.p95Ms).toBe(1450);
  });

  it('ignores non-finite or negative durations', () => {
    const svc = StackOpMetricsService.getInstance();
    svc.record(1, 'deploy', NaN, true);
    svc.record(1, 'deploy', -5, true);
    svc.record(1, 'deploy', Infinity, true);
    expect(svc.size()).toBe(0);
  });

  it('snapshot ordering: nodeId asc, then action asc', () => {
    const svc = StackOpMetricsService.getInstance();
    svc.record(3, 'start', 1, true);
    svc.record(1, 'update', 1, true);
    svc.record(2, 'deploy', 1, true);
    svc.record(1, 'deploy', 1, true);
    const keys = svc.snapshot().map(e => `${e.nodeId}:${e.action}`);
    expect(keys).toEqual(['1:deploy', '1:update', '2:deploy', '3:start']);
  });

  it('resetForTests clears all state', () => {
    const before = StackOpMetricsService.getInstance();
    before.record(1, 'deploy', 100, true);
    StackOpMetricsService.resetForTests();
    expect(StackOpMetricsService.getInstance()).not.toBe(before);
    expect(StackOpMetricsService.getInstance().size()).toBe(0);
  });
});
