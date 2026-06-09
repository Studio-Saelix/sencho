import { describe, it, expect } from 'vitest';
import { aggregateCurrentUsage } from './aggregateCurrentUsage';
import type { MetricPoint } from './types';

const point = (over: Partial<MetricPoint>): MetricPoint => ({
  container_id: 'c1',
  stack_name: 'web',
  timestamp: 0,
  cpu_percent: 0,
  memory_mb: 0,
  net_rx_mb: 0,
  net_tx_mb: 0,
  ...over,
});

describe('aggregateCurrentUsage', () => {
  it('returns an empty map when there are no metrics', () => {
    expect(aggregateCurrentUsage([])).toEqual({});
  });

  it('sums the latest sample per container into a per-stack total', () => {
    const result = aggregateCurrentUsage([
      point({ container_id: 'a', timestamp: 1000, cpu_percent: 10, memory_mb: 100 }),
      point({ container_id: 'a', timestamp: 2000, cpu_percent: 15, memory_mb: 150 }), // newer wins for a
      point({ container_id: 'b', timestamp: 2000, cpu_percent: 5, memory_mb: 50 }),
    ], 90_000);

    expect(result.web).toEqual({ cpu: 20, mem: 200 });
  });

  it('excludes a container whose latest sample is stale relative to the freshest', () => {
    const staleWindow = 90_000;
    const result = aggregateCurrentUsage([
      // live container keeps reporting; its newest point is the freshest sample
      point({ container_id: 'live', timestamp: 500_000, cpu_percent: 30, memory_mb: 300 }),
      // stopped container's final reading lingers far behind the freshest sample
      point({ container_id: 'stopped', timestamp: 500_000 - staleWindow - 1, cpu_percent: 99, memory_mb: 999 }),
    ], staleWindow);

    // only the live container counts; the stale 99% / 999MB reading is dropped
    expect(result.web).toEqual({ cpu: 30, mem: 300 });
  });

  it('keeps a sample sitting exactly on the stale-window boundary', () => {
    const staleWindow = 90_000;
    const result = aggregateCurrentUsage([
      point({ container_id: 'live', timestamp: 500_000, cpu_percent: 10, memory_mb: 100 }),
      // exactly freshest - staleWindow: the cutoff is `< cutoff`, so this is kept
      point({ container_id: 'edge', timestamp: 500_000 - staleWindow, cpu_percent: 7, memory_mb: 70 }),
    ], staleWindow);

    expect(result.web).toEqual({ cpu: 17, mem: 170 });
  });

  it('omits a stack entirely when all its containers are stale', () => {
    const result = aggregateCurrentUsage([
      point({ stack_name: 'alive', container_id: 'x', timestamp: 1_000_000, cpu_percent: 12, memory_mb: 120 }),
      point({ stack_name: 'dead', container_id: 'y', timestamp: 1_000_000 - 200_000, cpu_percent: 80, memory_mb: 800 }),
    ], 90_000);

    expect(result.alive).toEqual({ cpu: 12, mem: 120 });
    expect(result.dead).toBeUndefined();
  });
});
