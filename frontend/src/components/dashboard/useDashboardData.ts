import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNodes } from '@/context/NodeContext';
import { apiFetch } from '@/lib/api';
import { fetchStackStatusesShared } from '@/lib/stackStatusesFetch';
import { visibilityInterval } from '@/lib/utils';
import type {
  Stats,
  SystemStats,
  MetricPoint,
  StackStatusEntry,
  DashboardData,
  StackCpuSeries,
  StackStatusesLoadStatus,
} from './types';

const DEFAULT_STATS: Stats = { active: 0, managed: 0, unmanaged: 0, exited: 0, total: 0 };
const SPARK_BUCKETS = 20;
const SPARK_WINDOW_MS = 10 * 60 * 1000;
const BYTES_PER_MB = 1024 * 1024;
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

// Historical rows from /metrics/historical carry net_rx_mb / net_tx_mb as MB/s rates
// (legacy field names), not cumulative megabytes. Aggregate per timestamp, bucket,
// and emit bytes/s so the sparkline matches the live NETWORK headline units.
export function buildNetHistory(
  metrics: MetricPoint[],
  historyEndAt: number | null,
  windowMs: number,
  buckets: number,
): number[] {
  if (metrics.length === 0 || historyEndAt === null) return Array(buckets).fill(0);

  const start = historyEndAt - windowMs;
  const bucketMs = windowMs / buckets;
  const bucketSum = Array<number>(buckets).fill(0);
  const bucketTimestamps = Array.from({ length: buckets }, () => new Set<number>());

  for (const p of metrics) {
    if (p.timestamp < start) continue;
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor((p.timestamp - start) / bucketMs)));
    bucketSum[idx] += (p.net_rx_mb + p.net_tx_mb) * BYTES_PER_MB;
    bucketTimestamps[idx].add(p.timestamp);
  }

  let last = 0;
  for (let i = 0; i < buckets; i += 1) {
    const tsCount = bucketTimestamps[i].size;
    if (tsCount > 0) {
      bucketSum[i] /= tsCount;
      last = bucketSum[i];
    } else {
      bucketSum[i] = last;
    }
  }
  return bucketSum;
}

// After three consecutive failures of the live metrics endpoints, surface a
// "metrics stale" indicator so the operator knows the gauges are no longer
// being refreshed (the Docker socket or the metrics service is unreachable)
// rather than just slow. Polling continues; the indicator describes the
// freshness of the visible numbers, not the polling cadence. The threshold
// is chosen so a single transient hiccup does not trip the indicator.
const METRICS_STALE_THRESHOLD = 3;

const VALID_STACK_STATUS_VALUES = new Set(['running', 'exited', 'unknown', 'partial']);

// A malformed per-stack entry (null, a bare string, or an object missing
// `status`) must never reach the table renderer, which indexes straight into
// `entry.status` and other fields without a null check.
function isValidStatusEntry(value: unknown): value is StackStatusEntry {
  return (
    !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && VALID_STACK_STATUS_VALUES.has((value as { status?: unknown }).status as string)
  );
}

export function useDashboardData(): DashboardData {
  const { activeNode, nodes } = useNodes();
  const nodeId = activeNode?.id;

  const [stats, setStats] = useState<Stats>(DEFAULT_STATS);
  const [systemStats, setSystemStats] = useState<SystemStats | null>(null);
  const [metrics, setMetrics] = useState<MetricPoint[]>([]);
  const [stackStatuses, setStackStatuses] = useState<Record<string, StackStatusEntry>>({});
  const [stackStatusesLoadStatus, setStackStatusesLoadStatus] = useState<StackStatusesLoadStatus>('idle');
  const [stackStatusesLoadError, setStackStatusesLoadError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [metricsStale, setMetricsStale] = useState(false);

  // Keep a ref to the latest nodeId so async callbacks don't write stale data
  // after a node switch has already triggered a new effect cycle.
  const nodeIdRef = useRef(nodeId);
  useEffect(() => { nodeIdRef.current = nodeId; }, [nodeId]);

  // Whether the last committed success held a non-empty map. Soft poll failures
  // keep the prior map only in that case; a confirmed-empty fleet must surface a
  // recoverable error instead. Set from each committed success and reset on node
  // change, so commitStackStatusesFailure (a useCallback that does not depend on
  // stackStatuses) can read it without the map identity.
  const hadNonEmptyStatusesRef = useRef(false);
  // Latest-request arbitration for /stacks/statuses: polling, invalidation,
  // mount, and Retry can overlap; only the current generation may commit.
  const stackStatusesFetchGenRef = useRef(0);
  // Soft poll/invalidation must not start while any statuses request is in
  // flight. Fixed-interval ticks would otherwise bump generation forever and
  // starve a slow foreground hydration. Foreground (mount/retry/node change)
  // always starts and supersedes obsolete work.
  const stackStatusesInFlightRef = useRef(false);
  useEffect(() => {
    hadNonEmptyStatusesRef.current = false;
  }, [nodeId]);
  useEffect(() => () => {
    stackStatusesFetchGenRef.current += 1;
  }, []);

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

  // Stack statuses: 10s polling, resets on node change. Foreground / retry
  // expose loading and recoverable error; soft poll failures after success keep
  // the prior map so the dashboard never flashes a false empty state.
  const isCurrentStatusesFetch = useCallback((
    currentNodeId: number | undefined,
    generation: number,
  ) => (
    nodeIdRef.current === currentNodeId
    && stackStatusesFetchGenRef.current === generation
  ), []);

  const commitStackStatusesSuccess = useCallback((
    currentNodeId: number | undefined,
    generation: number,
    data: Record<string, StackStatusEntry>,
  ) => {
    if (!isCurrentStatusesFetch(currentNodeId, generation)) return;
    setStackStatuses(data);
    setStackStatusesLoadStatus('success');
    setStackStatusesLoadError(null);
    hadNonEmptyStatusesRef.current = Object.keys(data).length > 0;
  }, [isCurrentStatusesFetch]);

  const commitStackStatusesFailure = useCallback((
    currentNodeId: number | undefined,
    generation: number,
    mode: 'foreground' | 'soft',
    failureMessage: string,
  ) => {
    if (!isCurrentStatusesFetch(currentNodeId, generation)) return;
    // Soft: prior non-empty rows stay visible on a transient failure. Prior
    // confirmed-empty becomes a recoverable error so a soft failure can never
    // look identical to "no stacks".
    if (mode === 'soft' && hadNonEmptyStatusesRef.current) return;
    setStackStatusesLoadStatus('error');
    setStackStatusesLoadError(failureMessage);
  }, [isCurrentStatusesFetch]);

  const fetchStackStatuses = useCallback(async (
    currentNodeId: number | undefined,
    mode: 'foreground' | 'soft',
  ) => {
    // Skip until activeNode resolves. Passing null/"local" here would fetch the
    // hub while a remembered remote node is still loading and commit under an
    // unresolved guard.
    if (currentNodeId === undefined) return;
    if (nodeIdRef.current !== currentNodeId) return;
    if (mode === 'soft' && stackStatusesInFlightRef.current) return;
    const generation = ++stackStatusesFetchGenRef.current;
    stackStatusesInFlightRef.current = true;
    if (mode === 'foreground') {
      setStackStatusesLoadStatus('loading');
      setStackStatusesLoadError(null);
    }
    try {
      const result = await fetchStackStatusesShared(currentNodeId);
      if (!isCurrentStatusesFetch(currentNodeId, generation)) return;
      if (!result.ok) {
        commitStackStatusesFailure(
          currentNodeId,
          generation,
          mode,
          `Could not load stack health (${result.status}).`,
        );
        return;
      }
      const body = result.body;
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        // Drop any entry isValidStatusEntry rejects rather than trusting the
        // whole map: one bad entry must not crash or misrepresent the rest of
        // a valid response.
        const rawEntries = Object.entries(body as Record<string, unknown>);
        const sanitized: Record<string, StackStatusEntry> = {};
        for (const [file, entry] of rawEntries) {
          if (isValidStatusEntry(entry)) {
            sanitized[file] = entry;
          } else {
            console.error('[Dashboard] Dropped malformed stack status entry:', file, entry);
          }
        }
        // A non-empty map where every entry failed validation is a malformed
        // response, not a confirmed-empty fleet: committing it as success
        // would be indistinguishable from a genuine empty fleet.
        if (rawEntries.length > 0 && Object.keys(sanitized).length === 0) {
          commitStackStatusesFailure(
            currentNodeId,
            generation,
            mode,
            'Stack health response was invalid.',
          );
          return;
        }
        commitStackStatusesSuccess(currentNodeId, generation, sanitized);
        return;
      }
      commitStackStatusesFailure(
        currentNodeId,
        generation,
        mode,
        'Stack health response was invalid.',
      );
    } catch {
      if (!isCurrentStatusesFetch(currentNodeId, generation)) return;
      commitStackStatusesFailure(
        currentNodeId,
        generation,
        mode,
        'Could not load stack health.',
      );
    } finally {
      // Only the latest generation clears the gate. A superseded request that
      // finishes later must not reopen soft polling while a newer fetch is live.
      if (stackStatusesFetchGenRef.current === generation) {
        stackStatusesInFlightRef.current = false;
      }
    }
  }, [commitStackStatusesSuccess, commitStackStatusesFailure, isCurrentStatusesFetch]);

  const retryStackStatuses = useCallback(() => {
    void fetchStackStatuses(nodeIdRef.current, 'foreground');
  }, [fetchStackStatuses]);

  useEffect(() => {
    setStackStatuses({}); // eslint-disable-line react-hooks/set-state-in-effect
    setStackStatusesLoadStatus('loading');
    setStackStatusesLoadError(null);
    const currentNodeId = nodeId;
    // Stay in loading while NodeContext has not resolved activeNode; do not
    // fetch against an unknown target (and do not treat that window as empty).
    if (currentNodeId === undefined) return;
    void fetchStackStatuses(currentNodeId, 'foreground');
    const cleanup = visibilityInterval(() => {
      void fetchStackStatuses(currentNodeId, 'soft');
    }, 10000);
    return cleanup;
  }, [nodeId, fetchStackStatuses]);

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
    if (currentNodeId === undefined) return;
    let active = true;
    let invalidateTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = async () => {
      if (!active || nodeIdRef.current !== currentNodeId) return;
      const [statsData, sysData] = await Promise.all([
        fetchJson<Stats>('/stats'),
        fetchJson<SystemStats>('/system/stats'),
      ]);
      // Re-check after the await: an unmount or node switch may have
      // happened while the fetches were in flight, in which case the
      // resulting setState calls would land on a stale render tree.
      if (!active || nodeIdRef.current !== currentNodeId) return;
      if (statsData) {
        setStats(statsData);
        setLastSyncAt(Date.now());
      }
      if (sysData) setSystemStats(sysData);
      await fetchStackStatuses(currentNodeId, 'soft');
    };
    const onInvalidate = () => {
      if (!active || nodeIdRef.current !== currentNodeId) return;
      if (invalidateTimer) clearTimeout(invalidateTimer);
      invalidateTimer = setTimeout(() => {
        invalidateTimer = null;
        void refresh();
      }, INVALIDATE_DEBOUNCE_MS);
    };
    window.addEventListener('sencho:state-invalidate', onInvalidate);
    return () => {
      active = false;
      window.removeEventListener('sencho:state-invalidate', onInvalidate);
      if (invalidateTimer) clearTimeout(invalidateTimer);
    };
  }, [nodeId, fetchJson, fetchStackStatuses]);

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

  const netHistory = useMemo(
    () => buildNetHistory(metrics, historyEndAt, SPARK_WINDOW_MS, SPARK_BUCKETS),
    [metrics, historyEndAt],
  );

  return {
    stats,
    systemStats,
    metrics,
    stackStatuses,
    stackStatusesLoadStatus,
    stackStatusesLoadError,
    retryStackStatuses,
    lastSyncAt,
    nodeCount: nodes.length,
    stackCpuSeries,
    cpuHistory,
    netHistory,
    historyEndAt,
    metricsStale,
  };
}
