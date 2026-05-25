import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNodes } from '@/context/NodeContext';
import { apiFetch } from '@/lib/api';
import { visibilityInterval } from '@/lib/utils';
import type {
  Stats,
  SystemStats,
  MetricPoint,
  StackStatusEntry,
  DashboardData,
  StackCpuSeries,
} from './types';

const DEFAULT_STATS: Stats = { active: 0, managed: 0, unmanaged: 0, exited: 0, total: 0 };
const SPARK_BUCKETS = 20;
const SPARK_WINDOW_MS = 10 * 60 * 1000;
// Trailing-edge debounce window for live state-invalidate refetches. Matches
// useNextAutoUpdateRun so dashboard surfaces feel "live" without amplifying a
// container-event burst into one HTTP request per event.
const INVALIDATE_DEBOUNCE_MS = 250;

function bucketCpu(points: MetricPoint[], windowMs: number, buckets: number): number[] {
  if (points.length === 0) return Array(buckets).fill(0);
  const now = Date.now();
  const start = now - windowMs;
  const bucketMs = windowMs / buckets;
  const out = Array<number>(buckets).fill(0);
  const counts = Array<number>(buckets).fill(0);
  for (const p of points) {
    if (p.timestamp < start) continue;
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor((p.timestamp - start) / bucketMs)));
    out[idx] += p.cpu_percent;
    counts[idx] += 1;
  }
  for (let i = 0; i < buckets; i += 1) {
    if (counts[i] > 0) out[i] = out[i] / counts[i];
  }
  // Forward-fill empty buckets from the previous non-empty one so the line
  // reads as a continuous trend rather than a sawtooth of zeros.
  let last = 0;
  for (let i = 0; i < buckets; i += 1) {
    if (counts[i] === 0) out[i] = last;
    else last = out[i];
  }
  return out;
}

// After three consecutive failures of the live metrics endpoints, surface a
// "metrics stale" indicator so the operator knows the gauges are no longer
// being refreshed (the Docker socket or the metrics service is unreachable)
// rather than just slow. Polling continues; the indicator describes the
// freshness of the visible numbers, not the polling cadence. The threshold
// is chosen so a single transient hiccup does not trip the indicator.
const METRICS_STALE_THRESHOLD = 3;

export function useDashboardData(): DashboardData {
  const { activeNode, nodes } = useNodes();
  const nodeId = activeNode?.id;

  const [stats, setStats] = useState<Stats>(DEFAULT_STATS);
  const [systemStats, setSystemStats] = useState<SystemStats | null>(null);
  const [metrics, setMetrics] = useState<MetricPoint[]>([]);
  const [stackStatuses, setStackStatuses] = useState<Record<string, StackStatusEntry>>({});
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [metricsStale, setMetricsStale] = useState(false);

  // Keep a ref to the latest nodeId so async callbacks don't write stale data
  // after a node switch has already triggered a new effect cycle.
  const nodeIdRef = useRef(nodeId);
  useEffect(() => { nodeIdRef.current = nodeId; }, [nodeId]);

  // Consecutive failure counters per live-metrics endpoint. Either reaching
  // METRICS_STALE_THRESHOLD trips the metricsStale indicator; the first
  // successful response on the failing endpoint clears its own counter and,
  // when both are within the threshold, clears the indicator.
  const failureCountsRef = useRef({ stats: 0, sys: 0 });

  const fetchJson = useCallback(async <T>(endpoint: string, options?: { localOnly?: boolean }): Promise<T | null> => {
    try {
      const res = await apiFetch(endpoint, options);
      if (!res.ok) return null;
      return await res.json() as T;
    } catch {
      return null;
    }
  }, []);

  const recordOutcome = useCallback((endpoint: 'stats' | 'sys', success: boolean) => {
    const counts = failureCountsRef.current;
    if (success) counts[endpoint] = 0;
    else counts[endpoint] += 1;
    const stale = counts.stats >= METRICS_STALE_THRESHOLD || counts.sys >= METRICS_STALE_THRESHOLD;
    setMetricsStale(stale);
  }, []);

  // Container stats: 5s polling, resets on node change
  useEffect(() => {
    setStats(DEFAULT_STATS); // eslint-disable-line react-hooks/set-state-in-effect
    setLastSyncAt(null);
    failureCountsRef.current.stats = 0;
    setMetricsStale(failureCountsRef.current.sys >= METRICS_STALE_THRESHOLD);
    const currentNodeId = nodeId;
    const fetchStats = async () => {
      if (nodeIdRef.current !== currentNodeId) return; // Stale effect
      const data = await fetchJson<Stats>('/stats');
      if (nodeIdRef.current !== currentNodeId) return;
      if (data) {
        setStats(data);
        setLastSyncAt(Date.now());
        recordOutcome('stats', true);
      } else {
        recordOutcome('stats', false);
      }
    };
    fetchStats();
    const cleanup = visibilityInterval(fetchStats, 5000);
    return cleanup;
  }, [nodeId, fetchJson, recordOutcome]);

  // System stats: 5s polling, resets on node change
  useEffect(() => {
    setSystemStats(null); // eslint-disable-line react-hooks/set-state-in-effect
    failureCountsRef.current.sys = 0;
    setMetricsStale(failureCountsRef.current.stats >= METRICS_STALE_THRESHOLD);
    const currentNodeId = nodeId;
    const fetchSys = async () => {
      if (nodeIdRef.current !== currentNodeId) return;
      const data = await fetchJson<SystemStats>('/system/stats');
      if (nodeIdRef.current !== currentNodeId) return;
      if (data) {
        setSystemStats(data);
        recordOutcome('sys', true);
      } else {
        recordOutcome('sys', false);
      }
    };
    fetchSys();
    const cleanup = visibilityInterval(fetchSys, 5000);
    return cleanup;
  }, [nodeId, fetchJson, recordOutcome]);

  // Historical metrics: 60s polling, resets on node change
  useEffect(() => {
    setMetrics([]); // eslint-disable-line react-hooks/set-state-in-effect
    const currentNodeId = nodeId;
    const fetchMetrics = async () => {
      if (nodeIdRef.current !== currentNodeId) return;
      const data = await fetchJson<MetricPoint[]>('/metrics/historical');
      if (data && nodeIdRef.current === currentNodeId) setMetrics(data);
    };
    fetchMetrics();
    const cleanup = visibilityInterval(fetchMetrics, 60000);
    return cleanup;
  }, [nodeId, fetchJson]);

  // Stack statuses: 10s polling, resets on node change
  useEffect(() => {
    setStackStatuses({}); // eslint-disable-line react-hooks/set-state-in-effect
    const currentNodeId = nodeId;
    const fetchStatuses = async () => {
      if (nodeIdRef.current !== currentNodeId) return;
      const data = await fetchJson<Record<string, StackStatusEntry>>('/stacks/statuses');
      if (data && nodeIdRef.current === currentNodeId) setStackStatuses(data);
    };
    fetchStatuses();
    const cleanup = visibilityInterval(fetchStatuses, 10000);
    return cleanup;
  }, [nodeId, fetchJson]);

  // React to live `state-invalidate` signals from /ws/notifications: when a
  // Docker container event fires (start/stop/die/restart/health), the layout
  // re-broadcasts the envelope as a window CustomEvent. Refetch the cheap
  // data (stats, system, statuses) so the dashboard header and sidebar status
  // update in well under a second instead of waiting for the next polling
  // tick. Historical metrics are skipped — they are a 10-minute trend, not a
  // live indicator. The refetch is trailing-edge debounced so an event storm
  // (e.g. a 50-container stack restart) collapses to a single coalesced
  // refresh instead of one HTTP request per event.
  useEffect(() => {
    const currentNodeId = nodeId;
    let invalidateTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = async () => {
      if (nodeIdRef.current !== currentNodeId) return;
      const [statsData, sysData, statusesData] = await Promise.all([
        fetchJson<Stats>('/stats'),
        fetchJson<SystemStats>('/system/stats'),
        fetchJson<Record<string, StackStatusEntry>>('/stacks/statuses'),
      ]);
      if (nodeIdRef.current !== currentNodeId) return;
      if (statsData) {
        setStats(statsData);
        setLastSyncAt(Date.now());
      }
      if (sysData) setSystemStats(sysData);
      if (statusesData) setStackStatuses(statusesData);
    };
    const onInvalidate = () => {
      if (nodeIdRef.current !== currentNodeId) return;
      if (invalidateTimer) clearTimeout(invalidateTimer);
      invalidateTimer = setTimeout(() => {
        invalidateTimer = null;
        void refresh();
      }, INVALIDATE_DEBOUNCE_MS);
    };
    window.addEventListener('sencho:state-invalidate', onInvalidate);
    return () => {
      window.removeEventListener('sencho:state-invalidate', onInvalidate);
      if (invalidateTimer) clearTimeout(invalidateTimer);
    };
  }, [nodeId, fetchJson]);

  const stackCpuSeries = useMemo<Record<string, StackCpuSeries>>(() => {
    if (metrics.length === 0) return {};
    const grouped = new Map<string, MetricPoint[]>();
    for (const point of metrics) {
      if (!point.stack_name) continue;
      const bucket = grouped.get(point.stack_name) ?? [];
      bucket.push(point);
      grouped.set(point.stack_name, bucket);
    }
    const out: Record<string, StackCpuSeries> = {};
    for (const [stackName, rows] of grouped) {
      const points = bucketCpu(rows, SPARK_WINDOW_MS, SPARK_BUCKETS);
      let peakValue = -Infinity;
      let peakIndex = 0;
      for (let i = 0; i < points.length; i += 1) {
        if (points[i] > peakValue) {
          peakValue = points[i];
          peakIndex = i;
        }
      }
      out[stackName] = {
        stackName,
        points,
        peakValue: peakValue === -Infinity ? 0 : peakValue,
        peakIndex,
        latestValue: points[points.length - 1] ?? 0,
      };
    }
    return out;
  }, [metrics]);

  const cores = systemStats?.cpu.cores || 1;

  // Anchor the 10-minute sparkline window to the newest metric sample so the
  // bucketing memos stay pure (calling Date.now() inside useMemo would violate
  // react-hooks/purity and could yield inconsistent bucket boundaries across
  // re-renders).
  const historyEndAt = useMemo<number | null>(() => {
    if (metrics.length === 0) return null;
    let max = metrics[0].timestamp;
    for (let i = 1; i < metrics.length; i += 1) {
      if (metrics[i].timestamp > max) max = metrics[i].timestamp;
    }
    return max;
  }, [metrics]);

  // Aggregate host-level CPU normalized over cores, so the sparkline matches
  // the gauge percentage rather than summing raw container usage.
  const cpuHistory = useMemo<number[]>(() => {
    if (metrics.length === 0 || historyEndAt === null) return Array(SPARK_BUCKETS).fill(0);
    const start = historyEndAt - SPARK_WINDOW_MS;
    const bucketMs = SPARK_WINDOW_MS / SPARK_BUCKETS;
    // Per-bucket sum across all containers, tracking how many distinct
    // timestamps contributed so we can average per bucket.
    const bucketSum = Array<number>(SPARK_BUCKETS).fill(0);
    const bucketTimestamps = Array.from({ length: SPARK_BUCKETS }, () => new Set<number>());
    for (const p of metrics) {
      if (p.timestamp < start) continue;
      const idx = Math.min(SPARK_BUCKETS - 1, Math.max(0, Math.floor((p.timestamp - start) / bucketMs)));
      bucketSum[idx] += p.cpu_percent / cores;
      bucketTimestamps[idx].add(p.timestamp);
    }
    const out = Array<number>(SPARK_BUCKETS).fill(0);
    let last = 0;
    for (let i = 0; i < SPARK_BUCKETS; i += 1) {
      const tsCount = bucketTimestamps[i].size;
      if (tsCount > 0) {
        out[i] = bucketSum[i] / tsCount;
        last = out[i];
      } else {
        out[i] = last;
      }
    }
    return out;
  }, [metrics, cores, historyEndAt]);

  // Network throughput over time: compute per-container deltas between
  // consecutive samples, assign each delta to the bucket of the later sample,
  // and sum across containers. This is robust to container churn because each
  // delta is paired within a single container's lifeline. Negative deltas
  // (counter reset after a restart) clamp to zero.
  const netHistory = useMemo<number[]>(() => {
    if (metrics.length === 0 || historyEndAt === null) return Array(SPARK_BUCKETS).fill(0);
    const start = historyEndAt - SPARK_WINDOW_MS;
    const bucketMs = SPARK_WINDOW_MS / SPARK_BUCKETS;
    const byContainer = new Map<string, MetricPoint[]>();
    for (const p of metrics) {
      const bucket = byContainer.get(p.container_id) ?? [];
      bucket.push(p);
      byContainer.set(p.container_id, bucket);
    }
    const out = Array<number>(SPARK_BUCKETS).fill(0);
    for (const samples of byContainer.values()) {
      samples.sort((a, b) => a.timestamp - b.timestamp);
      for (let i = 1; i < samples.length; i += 1) {
        const curr = samples[i];
        if (curr.timestamp < start) continue;
        const prev = samples[i - 1];
        const delta = (curr.net_rx_mb + curr.net_tx_mb) - (prev.net_rx_mb + prev.net_tx_mb);
        if (delta <= 0) continue;
        const idx = Math.min(SPARK_BUCKETS - 1, Math.max(0, Math.floor((curr.timestamp - start) / bucketMs)));
        out[idx] += delta;
      }
    }
    return out;
  }, [metrics, historyEndAt]);

  return {
    stats,
    systemStats,
    metrics,
    stackStatuses,
    lastSyncAt,
    nodeCount: nodes.length,
    stackCpuSeries,
    cpuHistory,
    netHistory,
    historyEndAt,
    metricsStale,
  };
}
