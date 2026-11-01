import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNodes } from '@/context/NodeContext';
import { apiFetch } from '@/lib/api';
import { fetchStackStatusesShared } from '@/lib/stackStatusesFetch';
import {
  classifyRemoteReadError,
  classifyRemoteReadFailure,
  isUnreadableNode,
  remoteReadFailureMessage,
  type RemoteReadFailure,
  type UnreadableNodeFailure,
} from '@/lib/remoteReadFailure';
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
import { parseStackStatusesMap } from './parseStackStatusEntry';

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

/** The first cause that means the hub has no readable path to the node, in the
 *  order the dashboard should name it: a route-level deadline, then the two
 *  metrics endpoints. */
function firstUnreadableCause(
  ...failures: Array<RemoteReadFailure | null | undefined>
): UnreadableNodeFailure | null {
  for (const failure of failures) {
    if (isUnreadableNode(failure)) return failure;
  }
  return null;
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
  const [stackStatusesFreshness, setStackStatusesFreshness] = useState<'current' | 'stale'>('current');
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [metricsStale, setMetricsStale] = useState(false);
  // A node that did not answer at all is a different state from metrics that
  // are stale for a known local reason (the Docker socket). Only the former
  // reads as "Unknown"; the latter keeps the derived level. The cause travels
  // with the state so the headline can name a disconnected Pilot or an
  // unconfigured node instead of calling every cause "not answering".
  const [unreadableCause, setUnreadableCause] = useState<UnreadableNodeFailure | null>(null);
  // The read the headline depends on may be queued behind other node reads in
  // the browser's six-connection limit. Until one of the metrics endpoints has
  // settled there is no reading to report, so the headline must not claim the
  // default (healthy) level in the meantime.
  const [metricsSettled, setMetricsSettled] = useState(false);

  // Keep a ref to the latest nodeId so async callbacks don't write stale data
  // after a node switch has already triggered a new effect cycle.
  const nodeIdRef = useRef(nodeId);
  useEffect(() => { nodeIdRef.current = nodeId; }, [nodeId]);
  // The node's display name for failure copy. Held in a ref so the fetch
  // callbacks keep a stable identity across renders (they drive the polling
  // effects) while still naming the node the read actually targeted.
  const nodeNameRef = useRef(activeNode?.name);
  useEffect(() => { nodeNameRef.current = activeNode?.name; }, [activeNode?.name]);

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
  // Last failure kind per endpoint, so the headline can distinguish "the node
  // did not answer" from "the gauges are stale". Cleared by that endpoint's
  // next success and on a node change.
  const lastFailureRef = useRef<{ stats: RemoteReadFailure | null; sys: RemoteReadFailure | null }>({
    stats: null,
    sys: null,
  });
  // A bounded read that is not one of the two metrics endpoints (the shared
  // stack-statuses read) can prove the same thing: the node did not answer.
  // Feeding it into the headline lets the first failed read name the outage
  // instead of waiting for the metrics request that is queued behind it.
  const nodeReadFailureRef = useRef<RemoteReadFailure | null>(null);
  // True once a metrics endpoint answered for the current node. A route-level
  // deadline (stack statuses) then says nothing about the node being silent.
  const metricsAnsweredRef = useRef(false);

  const publishNodeHealth = useCallback(() => {
    const counts = failureCountsRef.current;
    const cause = firstUnreadableCause(
      nodeReadFailureRef.current,
      lastFailureRef.current.stats,
      lastFailureRef.current.sys,
    );
    setMetricsStale(
      counts.stats >= METRICS_STALE_THRESHOLD
      || counts.sys >= METRICS_STALE_THRESHOLD
      || cause !== null,
    );
    setUnreadableCause(cause);
  }, []);

  const recordNodeReadFailure = useCallback((failure: RemoteReadFailure) => {
    // Only a cause that leaves the hub with no readable path to the node (a
    // deadline, an unreachable node, a disconnected Pilot, an unconfigured
    // target, a refused address) changes the headline. An authorization or
    // HTTP answer came from the node, so it proves nothing about that.
    if (!isUnreadableNode(failure)) return;
    // A metrics endpoint has already answered this node since the switch, so
    // this is one route failing, not a silent node; the next metrics poll would
    // otherwise clear the claim a moment after it was made.
    if (metricsAnsweredRef.current) return;
    nodeReadFailureRef.current = failure;
    publishNodeHealth();
  }, [publishNodeHealth]);

  const fetchJson = useCallback(async <T>(
    endpoint: string,
    options?: { localOnly?: boolean; signal?: AbortSignal },
  ): Promise<{ ok: true; data: T } | { ok: false; failure: RemoteReadFailure }> => {
    try {
      const res = await apiFetch(endpoint, options);
      if (!res.ok) {
        return { ok: false, failure: classifyRemoteReadFailure(res) ?? 'http' };
      }
      return { ok: true, data: await res.json() as T };
    } catch (error) {
      return { ok: false, failure: classifyRemoteReadError(error) };
    }
  }, []);

  const recordOutcome = useCallback((
    endpoint: 'stats' | 'sys',
    outcome: { ok: true } | { ok: false; failure: RemoteReadFailure },
  ) => {
    const counts = failureCountsRef.current;
    setMetricsSettled(true);
    if (outcome.ok) {
      counts[endpoint] = 0;
      lastFailureRef.current[endpoint] = null;
      metricsAnsweredRef.current = true;
      // A metrics answer proves the node is reachable, so a deadline from the
      // stack-statuses read was about that route, not a silent node.
      nodeReadFailureRef.current = null;
    } else if (isUnreadableNode(outcome.failure)) {
      // A node the hub cannot read is not a transient hiccup: mark the numbers
      // stale on the first such failure instead of waiting out three polls, so
      // the dashboard never keeps showing zeros as if they were readings.
      counts[endpoint] = METRICS_STALE_THRESHOLD;
      lastFailureRef.current[endpoint] = outcome.failure;
    } else {
      counts[endpoint] += 1;
      lastFailureRef.current[endpoint] = outcome.failure;
    }
    publishNodeHealth();
  }, [publishNodeHealth]);

  // Container stats: 5s polling, resets on node change
  useEffect(() => {
    setStats(DEFAULT_STATS); // eslint-disable-line react-hooks/set-state-in-effect
    setLastSyncAt(null);
    setMetricsSettled(false);
    nodeReadFailureRef.current = null;
    metricsAnsweredRef.current = false;
    failureCountsRef.current.stats = 0;
    lastFailureRef.current.stats = null;
    setMetricsStale(failureCountsRef.current.sys >= METRICS_STALE_THRESHOLD);
    setUnreadableCause(firstUnreadableCause(lastFailureRef.current.sys));
    const currentNodeId = nodeId;
    const controller = new AbortController();
    const fetchStats = async () => {
      if (nodeIdRef.current !== currentNodeId) return; // Stale effect
      const outcome = await fetchJson<Stats>('/stats', { signal: controller.signal });
      if (controller.signal.aborted || nodeIdRef.current !== currentNodeId) return;
      if (outcome.ok) {
        setStats(outcome.data);
        setLastSyncAt(Date.now());
      }
      recordOutcome('stats', outcome);
    };
    fetchStats();
    const stopPolling = visibilityInterval(fetchStats, 5000);
    // A read for a node the operator has left must not keep a browser
    // connection busy ahead of the next surface's reads.
    return () => {
      controller.abort();
      stopPolling();
    };
  }, [nodeId, fetchJson, recordOutcome]);

  // System stats: 5s polling, resets on node change
  useEffect(() => {
    setSystemStats(null); // eslint-disable-line react-hooks/set-state-in-effect
    failureCountsRef.current.sys = 0;
    lastFailureRef.current.sys = null;
    setMetricsStale(failureCountsRef.current.stats >= METRICS_STALE_THRESHOLD);
    setUnreadableCause(firstUnreadableCause(lastFailureRef.current.stats));
    const currentNodeId = nodeId;
    const controller = new AbortController();
    const fetchSys = async () => {
      if (nodeIdRef.current !== currentNodeId) return;
      const outcome = await fetchJson<SystemStats>('/system/stats', { signal: controller.signal });
      if (controller.signal.aborted || nodeIdRef.current !== currentNodeId) return;
      if (outcome.ok) setSystemStats(outcome.data);
      recordOutcome('sys', outcome);
    };
    fetchSys();
    const stopPolling = visibilityInterval(fetchSys, 5000);
    return () => {
      controller.abort();
      stopPolling();
    };
  }, [nodeId, fetchJson, recordOutcome]);

  // Historical metrics: 60s polling, resets on node change
  useEffect(() => {
    setMetrics([]); // eslint-disable-line react-hooks/set-state-in-effect
    const currentNodeId = nodeId;
    const controller = new AbortController();
    const fetchMetrics = async () => {
      if (nodeIdRef.current !== currentNodeId) return;
      const outcome = await fetchJson<MetricPoint[]>('/metrics/historical', { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (outcome.ok && nodeIdRef.current === currentNodeId) setMetrics(outcome.data);
    };
    fetchMetrics();
    const stopPolling = visibilityInterval(fetchMetrics, 60000);
    return () => {
      controller.abort();
      stopPolling();
    };
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
    setStackStatusesFreshness('current');
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
    if (hadNonEmptyStatusesRef.current) {
      setStackStatusesFreshness('stale');
    }
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
      if (result.failure === 'auth-abort') {
        // Logout clears the coalescer mid-flight; do not leave the card on
        // skeletons if the session teardown is slow to unmount Home.
        commitStackStatusesFailure(
          currentNodeId,
          generation,
          mode,
          'Could not load stack health.',
        );
        return;
      }
      if (!result.ok) {
        // The earliest node-scoped read to fail is often this one, because
        // the metrics endpoints are queued behind the same browser connection
        // limit. Let it name the outage now instead of leaving the headline on
        // a healthy default until the metrics answer.
        if (result.failure !== undefined) recordNodeReadFailure(result.failure);
        const failureMsg = result.failure !== undefined && isUnreadableNode(result.failure)
          ? remoteReadFailureMessage(result.failure, { nodeName: nodeNameRef.current, status: result.status })
          : `Could not load stack health (${result.status}).`;
        commitStackStatusesFailure(
          currentNodeId,
          generation,
          mode,
          failureMsg,
        );
        return;
      }
      const parsed = parseStackStatusesMap(result.body);
      if (parsed.kind === 'ok') {
        commitStackStatusesSuccess(currentNodeId, generation, parsed.entries);
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
  }, [commitStackStatusesSuccess, commitStackStatusesFailure, isCurrentStatusesFetch, recordNodeReadFailure]);

  const retryStackStatuses = useCallback(() => {
    void fetchStackStatuses(nodeIdRef.current, 'foreground');
  }, [fetchStackStatuses]);

  useEffect(() => {
    setStackStatuses({}); // eslint-disable-line react-hooks/set-state-in-effect
    setStackStatusesLoadStatus('loading');
    setStackStatusesLoadError(null);
    setStackStatusesFreshness('current');
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
    const controller = new AbortController();
    const refresh = async () => {
      if (!active || nodeIdRef.current !== currentNodeId) return;
      const [statsOutcome, sysOutcome] = await Promise.all([
        fetchJson<Stats>('/stats', { signal: controller.signal }),
        fetchJson<SystemStats>('/system/stats', { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return;
      // Re-check after the await: an unmount or node switch may have
      // happened while the fetches were in flight, in which case the
      // resulting setState calls would land on a stale render tree.
      if (!active || nodeIdRef.current !== currentNodeId) return;
      if (statsOutcome.ok) {
        setStats(statsOutcome.data);
        setLastSyncAt(Date.now());
      }
      if (sysOutcome.ok) setSystemStats(sysOutcome.data);
      recordOutcome('stats', statsOutcome);
      recordOutcome('sys', sysOutcome);
      await fetchStackStatuses(currentNodeId, 'soft');
    };
    const onInvalidate = (event: Event) => {
      const nodeIdFromEvent = (event as CustomEvent<{ nodeId?: unknown }>).detail?.nodeId;
      if (typeof nodeIdFromEvent !== 'number' || nodeIdFromEvent !== currentNodeId) return;
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
      controller.abort();
      window.removeEventListener('sencho:state-invalidate', onInvalidate);
      if (invalidateTimer) clearTimeout(invalidateTimer);
    };
  }, [nodeId, fetchJson, fetchStackStatuses, recordOutcome]);

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
    stackStatusesFreshness,
    retryStackStatuses,
    lastSyncAt,
    nodeCount: nodes.length,
    stackCpuSeries,
    cpuHistory,
    netHistory,
    historyEndAt,
    metricsStale,
    metricsUnreadable: unreadableCause !== null,
    unreadableCause,
    metricsSettled,
  };
}
