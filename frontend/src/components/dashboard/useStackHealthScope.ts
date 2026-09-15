import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Node } from '@/context/NodeContext';
import { useNodes } from '@/context/NodeContext';
import { fetchStackStatusesShared, type StackStatusesFetchResult } from '@/lib/stackStatusesFetch';
import type { StackUpdateInfo } from '@/types/imageUpdates';
import { parseStackStatusesMap } from './parseStackStatusEntry';
import { fetchRemoteFacet, startFacetTimeout } from './fetchRemoteFacet';
import { buildStackCpuSeries, projectStackHealthRows } from './projectStackHealthRows';
import type {
  NodeHealthFailureReason,
  NodeHealthState,
  StackHealthCoverage,
  StackHealthRow,
  StackHealthScopeMode,
  StackHealthViewKind,
} from './stackHealthTypes';
import type { MetricPoint, StackCpuSeries, StackStatusEntry, StackStatusesLoadStatus } from './types';
import {
  projectSourceStates,
  type GitOpsSourceStateMap,
  type GitSourceRow,
} from './useGitOpsSourceStates';

export type { StackHealthNavTarget, StackHealthRow, StackHealthScopeMode } from './stackHealthTypes';

export const STACK_HEALTH_COLLAPSE_SIZE = 8;
export const REMOTE_STATUS_INTERVAL_MS = 10_000;
export const REMOTE_METRICS_INTERVAL_MS = 60_000;
const INVALIDATE_DEBOUNCE_MS = 250;

type RemoteFacetPath = '/metrics/historical' | '/git-sources';

type RemoteSlice = {
  nodeId: number;
  nodeName: string;
  state: NodeHealthState;
  reason?: NodeHealthFailureReason;
  statuses: Record<string, StackStatusEntry>;
  metrics: MetricPoint[] | null;
  gitops: GitOpsSourceStateMap | null;
};

type ActiveInputs = {
  stackStatuses: Record<string, StackStatusEntry>;
  stackStatusesFreshness: 'current' | 'stale';
  stackStatusesLoadStatus: StackStatusesLoadStatus;
  stackStatusesLoadError: string | null;
  retryStackStatuses: () => void;
  metrics: MetricPoint[];
  stackCpuSeries: Record<string, StackCpuSeries>;
  gitopsSourceStates: GitOpsSourceStateMap;
  stackUpdates: Record<string, StackUpdateInfo>;
};

type ScopeView = {
  rows: StackHealthRow[];
  coverage: StackHealthCoverage;
  view: StackHealthViewKind;
  incomplete: boolean;
  viewError: string | null;
};

export interface UseStackHealthScopeArgs extends ActiveInputs {
  scope: StackHealthScopeMode;
}

export interface StackHealthScopeResult {
  view: StackHealthViewKind;
  viewError: string | null;
  rows: StackHealthRow[];
  coverage: StackHealthCoverage;
  incomplete: boolean;
  showScopeControl: boolean;
  retry: () => void;
  retryFailedOrStale: () => void;
}

function emptySlice(node: Node, state: NodeHealthState, reason?: NodeHealthFailureReason): RemoteSlice {
  return {
    nodeId: node.id,
    nodeName: node.name,
    state,
    reason,
    statuses: {},
    metrics: null,
    gitops: null,
  };
}

function isReporting(state: NodeHealthState): boolean {
  return state === 'current' || state === 'stale';
}

function hasRetainableStatuses(slice: RemoteSlice): boolean {
  return isReporting(slice.state) && Object.keys(slice.statuses).length > 0;
}

function failOrStale(slice: RemoteSlice, reason: NodeHealthFailureReason): RemoteSlice {
  if (hasRetainableStatuses(slice)) return { ...slice, state: 'stale', reason };
  return { ...slice, state: 'failed', reason, statuses: {} };
}

function reasonFromStatusResult(result: StackStatusesFetchResult): NodeHealthFailureReason {
  if (result.failure === 'timeout') return 'timeout';
  if (result.status === 403) return 'denied';
  return 'error';
}

function applyStatusResult(slice: RemoteSlice, result: StackStatusesFetchResult): RemoteSlice {
  if (result.failure === 'auth-abort') return slice;
  if (!result.ok) return failOrStale(slice, reasonFromStatusResult(result));
  const parsed = parseStackStatusesMap(result.body);
  if (parsed.kind === 'invalid') return failOrStale(slice, 'malformed');
  return { ...slice, state: 'current', reason: undefined, statuses: parsed.entries };
}

function asMetricPoints(body: unknown): MetricPoint[] | null {
  return Array.isArray(body) ? body as MetricPoint[] : null;
}

function asGitSourceRows(body: unknown): GitSourceRow[] | null {
  return Array.isArray(body) ? body as GitSourceRow[] : null;
}

function activeOutcomeState(
  loadStatus: StackStatusesLoadStatus,
  freshness: 'current' | 'stale',
  hasRows: boolean,
): NodeHealthState {
  if (loadStatus === 'idle' || loadStatus === 'loading') {
    if (!hasRows) return 'pending';
    return freshness === 'stale' ? 'stale' : 'current';
  }
  if (loadStatus === 'error') {
    return hasRows ? 'stale' : 'failed';
  }
  return freshness === 'stale' ? 'stale' : 'current';
}

function thisNodeView(
  activeState: NodeHealthState,
  activeRows: StackHealthRow[],
  nodeCount: number,
  loadError: string | null,
): ScopeView {
  if (activeState === 'pending') {
    return {
      rows: [],
      coverage: { k: 0, m: nodeCount, n: 0 },
      view: 'loading',
      incomplete: false,
      viewError: null,
    };
  }
  if (activeState === 'failed') {
    return {
      rows: [],
      coverage: { k: 0, m: nodeCount, n: 0 },
      view: 'unavailable',
      incomplete: false,
      viewError: loadError,
    };
  }
  return {
    rows: activeRows,
    coverage: { k: activeState === 'current' ? 1 : 0, m: 1, n: activeRows.length },
    view: activeRows.length === 0 ? 'empty' : 'ready',
    incomplete: activeState === 'stale',
    viewError: null,
  };
}

function fleetView(
  inventory: Node[],
  activeNodeId: number | undefined,
  activeState: NodeHealthState,
  activeRows: StackHealthRow[],
  remote: Record<number, RemoteSlice>,
): ScopeView {
  const merged: StackHealthRow[] = [];
  let k = 0;
  let anyPending = false;
  let anyStale = false;

  for (const node of inventory) {
    if (node.id === activeNodeId) {
      if (activeState === 'current') k += 1;
      if (activeState === 'pending') anyPending = true;
      if (activeState === 'stale') anyStale = true;
      if (isReporting(activeState)) merged.push(...activeRows);
      continue;
    }

    const slice = remote[node.id];
    const state = slice?.state ?? (node.status === 'offline' ? 'offline' : 'pending');
    if (state === 'current') k += 1;
    if (state === 'pending') anyPending = true;
    if (state === 'stale') anyStale = true;
    if (isReporting(state) && slice) {
      const metrics = slice.metrics ?? [];
      merged.push(...projectStackHealthRows({
        node,
        statuses: slice.statuses,
        metrics,
        series: buildStackCpuSeries(metrics),
        gitops: slice.gitops ?? {},
        freshness: state === 'stale' ? 'stale' : 'current',
        includeUpdates: false,
      }));
    }
  }

  const n = merged.length;
  const m = inventory.length;
  const coverage = { k, m, n };
  const incomplete = k !== m;

  if (!anyStale && n === 0 && anyPending) {
    return { rows: [], coverage, view: 'loading', incomplete, viewError: null };
  }
  if (k === 0 && !anyStale) {
    return {
      rows: [],
      coverage,
      view: 'unavailable',
      incomplete,
      viewError: 'Could not load stack health from any node.',
    };
  }
  if (n === 0 && incomplete) {
    return {
      rows: [],
      coverage,
      view: 'unavailable',
      incomplete,
      viewError: 'Could not load a complete stack health inventory.',
    };
  }
  if (k === m && n === 0) {
    return { rows: [], coverage, view: 'empty', incomplete: false, viewError: null };
  }
  return { rows: merged, coverage, view: 'ready', incomplete, viewError: null };
}

export function useStackHealthScope(args: UseStackHealthScopeArgs): StackHealthScopeResult {
  const { nodes, activeNode } = useNodes();
  const {
    scope,
    stackStatuses,
    stackStatusesFreshness,
    stackStatusesLoadStatus,
    stackStatusesLoadError,
    retryStackStatuses,
    metrics,
    stackCpuSeries,
    gitopsSourceStates,
    stackUpdates,
  } = args;

  const [remote, setRemote] = useState<Record<number, RemoteSlice>>({});
  const generationRef = useRef(0);
  const activeIdRef = useRef(activeNode?.id);
  const facetControllers = useRef(new Map<string, AbortController>());
  activeIdRef.current = activeNode?.id;

  const abortFacets = useCallback((reason: unknown) => {
    for (const controller of facetControllers.current.values()) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
    facetControllers.current.clear();
  }, []);

  const runFacet = useCallback(async (gen: number, nodeId: number, path: RemoteFacetPath) => {
    const key = `${nodeId}:${path}`;
    const existing = facetControllers.current.get(key);
    if (existing && !existing.signal.aborted) existing.abort('replaced');
    const controller = new AbortController();
    facetControllers.current.set(key, controller);
    const stopTimeout = startFacetTimeout(controller);
    const result = await fetchRemoteFacet(path, nodeId, controller.signal);
    stopTimeout();
    if (facetControllers.current.get(key) === controller) {
      facetControllers.current.delete(key);
    }
    if (gen !== generationRef.current) return;
    if (activeIdRef.current === nodeId) return;
    if (!result.ok && result.failure === 'auth-abort') return;
    setRemote((prev) => {
      const slice = prev[nodeId];
      if (!slice) return prev;
      if (path === '/metrics/historical') {
        return {
          ...prev,
          [nodeId]: { ...slice, metrics: result.ok ? asMetricPoints(result.body) : null },
        };
      }
      const rows = result.ok ? asGitSourceRows(result.body) : null;
      return {
        ...prev,
        [nodeId]: { ...slice, gitops: rows ? projectSourceStates(rows) : null },
      };
    });
  }, []);

  const runStatuses = useCallback(async (gen: number, node: Node, markPending: boolean) => {
    if (markPending) {
      setRemote((prev) => {
        const current = prev[node.id];
        if (current && (hasRetainableStatuses(current) || current.state === 'pending')) return prev;
        return { ...prev, [node.id]: emptySlice(node, 'pending') };
      });
    }
    let result: StackStatusesFetchResult;
    try {
      result = await fetchStackStatusesShared(node.id);
    } catch {
      result = {
        ok: false,
        status: 0,
        proxied: false,
        body: null,
        coalesced: false,
        failure: 'http',
      };
    }
    if (gen !== generationRef.current) return;
    if (activeIdRef.current === node.id) return;
    if (result.failure === 'auth-abort') return;
    setRemote((prev) => {
      const current = prev[node.id] ?? emptySlice(node, 'pending');
      return { ...prev, [node.id]: applyStatusResult(current, result) };
    });
  }, []);

  const refreshNode = useCallback((gen: number, node: Node, markPending: boolean) => {
    void runStatuses(gen, node, markPending);
    void runFacet(gen, node.id, '/metrics/historical');
    void runFacet(gen, node.id, '/git-sources');
  }, [runFacet, runStatuses]);

  const remoteTargets = useMemo(() => {
    if (scope !== 'all-nodes') return [] as Node[];
    return nodes.filter((n) => n.id !== activeNode?.id);
  }, [scope, nodes, activeNode?.id]);

  const targetKey = remoteTargets.map((n) => `${n.id}:${n.status}`).join(',');

  useEffect(() => {
    if (scope !== 'all-nodes') {
      generationRef.current += 1;
      abortFacets('unmount');
      setRemote((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    const gen = ++generationRef.current;
    abortFacets('unmount');

    const targets = remoteTargets;
    setRemote((prev) => {
      const next: Record<number, RemoteSlice> = {};
      for (const node of targets) {
        next[node.id] = node.status === 'offline'
          ? emptySlice(node, 'offline')
          : (prev[node.id] ?? emptySlice(node, 'pending'));
      }
      return next;
    });

    for (const node of targets) {
      if (node.status === 'offline') continue;
      refreshNode(gen, node, true);
    }

    const statusTimer = setInterval(() => {
      for (const node of targets) {
        if (node.status === 'offline') continue;
        void runStatuses(gen, node, false);
      }
    }, REMOTE_STATUS_INTERVAL_MS);
    const metricsTimer = setInterval(() => {
      for (const node of targets) {
        if (node.status === 'offline') continue;
        void runFacet(gen, node.id, '/metrics/historical');
      }
    }, REMOTE_METRICS_INTERVAL_MS);

    return () => {
      generationRef.current += 1;
      abortFacets('unmount');
      clearInterval(statusTimer);
      clearInterval(metricsTimer);
    };
  }, [scope, targetKey, abortFacets, refreshNode, runStatuses, runFacet, remoteTargets]);

  useEffect(() => {
    const onUnauth = () => abortFacets('auth-abort');
    window.addEventListener('sencho-unauthorized', onUnauth);
    return () => window.removeEventListener('sencho-unauthorized', onUnauth);
  }, [abortFacets]);

  useEffect(() => {
    if (scope !== 'all-nodes') return;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const onInvalidate = (event: Event) => {
      const detail = (event as CustomEvent<{ scope?: string; nodeId?: unknown }>).detail;
      if (typeof detail?.nodeId !== 'number') return;
      if (detail.nodeId === activeIdRef.current) return;
      const node = remoteTargets.find((n) => n.id === detail.nodeId);
      if (!node || node.status === 'offline') return;
      const gitopsOnly = detail.scope === 'gitops';
      const key = `${detail.nodeId}:${gitopsOnly ? 'gitops' : 'status'}`;
      const existing = timers.get(key);
      if (existing) clearTimeout(existing);
      timers.set(key, setTimeout(() => {
        timers.delete(key);
        const gen = generationRef.current;
        if (gitopsOnly) {
          void runFacet(gen, node.id, '/git-sources');
          return;
        }
        void runStatuses(gen, node, false);
      }, INVALIDATE_DEBOUNCE_MS));
    };
    window.addEventListener('sencho:state-invalidate', onInvalidate);
    return () => {
      window.removeEventListener('sencho:state-invalidate', onInvalidate);
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [scope, remoteTargets, runFacet, runStatuses]);

  const retryFailedOrStale = useCallback(() => {
    const gen = generationRef.current;
    for (const node of remoteTargets) {
      const slice = remote[node.id];
      if (!slice || node.status === 'offline') continue;
      if (slice.state !== 'failed' && slice.state !== 'stale') continue;
      refreshNode(gen, node, false);
    }
    if (stackStatusesFreshness === 'stale' || stackStatusesLoadStatus === 'error') {
      retryStackStatuses();
    }
  }, [
    remote,
    remoteTargets,
    refreshNode,
    retryStackStatuses,
    stackStatusesFreshness,
    stackStatusesLoadStatus,
  ]);

  const { rows, coverage, view, incomplete, viewError } = useMemo(() => {
    const activeRows = activeNode
      ? projectStackHealthRows({
        node: activeNode,
        statuses: stackStatuses,
        metrics,
        series: stackCpuSeries,
        gitops: gitopsSourceStates,
        stackUpdates,
        freshness: stackStatusesFreshness,
        includeUpdates: true,
      })
      : [];
    const activeState = activeNode
      ? activeOutcomeState(stackStatusesLoadStatus, stackStatusesFreshness, activeRows.length > 0)
      : 'pending';

    if (scope !== 'all-nodes') {
      return thisNodeView(activeState, activeRows, nodes.length, stackStatusesLoadError);
    }
    return fleetView(nodes, activeNode?.id, activeState, activeRows, remote);
  }, [
    activeNode,
    gitopsSourceStates,
    metrics,
    nodes,
    remote,
    scope,
    stackCpuSeries,
    stackStatuses,
    stackStatusesFreshness,
    stackStatusesLoadError,
    stackStatusesLoadStatus,
    stackUpdates,
  ]);

  const retry = useCallback(() => {
    if (scope === 'all-nodes') {
      retryFailedOrStale();
      return;
    }
    retryStackStatuses();
  }, [scope, retryFailedOrStale, retryStackStatuses]);

  return {
    view,
    viewError,
    rows,
    coverage,
    incomplete,
    showScopeControl: nodes.length >= 2,
    retry,
    retryFailedOrStale,
  };
}
