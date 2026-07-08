import { describe, it, expect } from 'vitest';
import { buildNetHistory } from '../useDashboardData';
import type { MetricPoint } from '../types';

const WINDOW_MS = 10 * 60 * 1000;
const BUCKETS = 20;
const BUCKET_MS = WINDOW_MS / BUCKETS;
const BYTES_PER_MB = 1024 * 1024;

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

describe('buildNetHistory', () => {
  const historyEndAt = 1_000_000;
  const start = historyEndAt - WINDOW_MS;

  it('returns zero-filled buckets when metrics are empty', () => {
    expect(buildNetHistory([], historyEndAt, WINDOW_MS, BUCKETS)).toEqual(Array(BUCKETS).fill(0));
  });

  it('returns zero-filled buckets when historyEndAt is null', () => {
    expect(buildNetHistory([point({ timestamp: historyEndAt, net_rx_mb: 1 })], null, WINDOW_MS, BUCKETS))
      .toEqual(Array(BUCKETS).fill(0));
  });

  it('converts aggregate MB/s to bytes/s for a single container', () => {
    const ts = start + BUCKET_MS;
    const result = buildNetHistory(
      [point({ timestamp: ts, net_rx_mb: 0.5, net_tx_mb: 0.5 })],
      historyEndAt,
      WINDOW_MS,
      BUCKETS,
    );
    const idx = Math.floor((ts - start) / BUCKET_MS);
    expect(result[idx]).toBeCloseTo(BYTES_PER_MB, 0);
  });

  it('sums two containers at the same timestamp before bucketing', () => {
    const ts = start + BUCKET_MS;
    const result = buildNetHistory(
      [
        point({ container_id: 'a', timestamp: ts, net_rx_mb: 1, net_tx_mb: 0 }),
        point({ container_id: 'b', timestamp: ts, net_rx_mb: 1, net_tx_mb: 0 }),
      ],
      historyEndAt,
      WINDOW_MS,
      BUCKETS,
    );
    const idx = Math.floor((ts - start) / BUCKET_MS);
    expect(result[idx]).toBeCloseTo(2 * BYTES_PER_MB, 0);
  });

  it('averages multiple timestamp aggregates within the same spark bucket', () => {
    const bucketStart = start + BUCKET_MS;
    const ts1 = bucketStart + 1_000;
    const ts2 = bucketStart + 2_000;
    const result = buildNetHistory(
      [
        point({ timestamp: ts1, net_rx_mb: 1, net_tx_mb: 0 }),
        point({ timestamp: ts2, net_rx_mb: 3, net_tx_mb: 0 }),
      ],
      historyEndAt,
      WINDOW_MS,
      BUCKETS,
    );
    const idx = Math.floor((ts1 - start) / BUCKET_MS);
    expect(result[idx]).toBeCloseTo(2 * BYTES_PER_MB, 0);
  });

  it('produces non-zero values for steady traffic instead of delta noise near zero', () => {
    const ts1 = start + BUCKET_MS;
    const ts2 = start + 2 * BUCKET_MS;
    const result = buildNetHistory(
      [
        point({ timestamp: ts1, net_rx_mb: 1, net_tx_mb: 0 }),
        point({ timestamp: ts2, net_rx_mb: 1, net_tx_mb: 0 }),
      ],
      historyEndAt,
      WINDOW_MS,
      BUCKETS,
    );
    const idx1 = Math.floor((ts1 - start) / BUCKET_MS);
    const idx2 = Math.floor((ts2 - start) / BUCKET_MS);
    expect(result[idx1]).toBeCloseTo(BYTES_PER_MB, 0);
    expect(result[idx2]).toBeCloseTo(BYTES_PER_MB, 0);
  });

  it('forward-fills empty buckets from the previous observed bucket', () => {
    const ts = start + 3 * BUCKET_MS;
    const result = buildNetHistory(
      [point({ timestamp: ts, net_rx_mb: 2, net_tx_mb: 0 })],
      historyEndAt,
      WINDOW_MS,
      BUCKETS,
    );
    const idx = Math.floor((ts - start) / BUCKET_MS);
    expect(result[idx - 1]).toBe(0);
    expect(result[idx]).toBeCloseTo(2 * BYTES_PER_MB, 0);
    expect(result[idx + 1]).toBeCloseTo(2 * BYTES_PER_MB, 0);
  });

  it('resets forward-fill to zero after an explicit zero sample', () => {
    const tsPositive = start + BUCKET_MS;
    const tsZero = start + 3 * BUCKET_MS;
    const result = buildNetHistory(
      [
        point({ timestamp: tsPositive, net_rx_mb: 2, net_tx_mb: 0 }),
        point({ timestamp: tsZero, net_rx_mb: 0, net_tx_mb: 0 }),
      ],
      historyEndAt,
      WINDOW_MS,
      BUCKETS,
    );
    const positiveIdx = Math.floor((tsPositive - start) / BUCKET_MS);
    const zeroIdx = Math.floor((tsZero - start) / BUCKET_MS);
    expect(result[positiveIdx]).toBeCloseTo(2 * BYTES_PER_MB, 0);
    expect(result[zeroIdx]).toBe(0);
    expect(result[zeroIdx + 1]).toBe(0);
  });

  it('excludes rows before the spark window', () => {
    const ts = start - 1;
    const result = buildNetHistory(
      [point({ timestamp: ts, net_rx_mb: 99, net_tx_mb: 99 })],
      historyEndAt,
      WINDOW_MS,
      BUCKETS,
    );
    expect(result.every((v) => v === 0)).toBe(true);
  });
});
