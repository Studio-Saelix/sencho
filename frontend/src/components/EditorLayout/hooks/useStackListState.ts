import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { apiFetch } from '@/lib/api';
import { fetchStackStatusesShared, type StackStatusesFetchResult } from '@/lib/stackStatusesFetch';
import {
  newAttemptId,
  abortAttempt,
  beginSpan,
  endSpan,
  flushPendingCommit,
  markMilestone,
  type SpanHandle,
  type PendingCommit,
} from '@/lib/hydrationTiming';
import { toast } from '@/components/ui/toast-store';
import { useNodes } from '@/context/NodeContext';
import { useImageUpdates } from '@/hooks/useImageUpdates';
import { usePinnedStacks } from '@/hooks/usePinnedStacks';
import { useSidebarGroupCollapse } from '@/hooks/useSidebarGroupCollapse';
import { useBulkStackActions, type BulkAction } from '@/hooks/useBulkStackActions';
import { useCrossNodeStackSearch } from '@/hooks/useCrossNodeStackSearch';
import { SENCHO_LABELS_CHANGED } from '@/lib/events';
import type { StackUpdateInfo } from '@/types/imageUpdates';
import { isConfirmedImageUpdate } from '@/types/imageUpdates';
import { isInputFocused, isPaletteOpen } from '@/lib/keyboard-guards';
import type { StackAction, StackActionResult } from '../EditorView';
import type { Label as StackLabel } from '../../label-types';
import type { FilterChip } from '../../sidebar/sidebar-types';
import { isDownStatus, classifyContainersStatus, isBulkStatusObjectFormat } from '../../sidebar/stack-status-utils';
import type { StackRowStatus } from '../../sidebar/stack-status-utils';

/** Compatibility path for remote nodes whose `/stacks/statuses` is absent or
 *  returns the legacy plain-string format: query each stack's containers and
 *  classify them so a degraded (partial) stack is not reported as healthy. */
async function deriveStatusesFromContainers(
  fileList: string[],
): Promise<Record<string, StackRowStatus>> {
  const results = await Promise.allSettled(
    fileList.map(async (file) => {
      const containersRes = await apiFetch(`/stacks/${file}/containers`);
      if (!containersRes.ok) return { file, status: 'unknown' as StackRowStatus };
      const containers = await containersRes.json();
      return {
        file,
        status: Array.isArray(containers) ? classifyContainersStatus(containers) : 'unknown',
      };
    }),
  );
  const out: Record<string, StackRowStatus> = {};
  for (const result of results) {
    if (result.status === 'fulfilled') out[result.value.file] = result.value.status;
  }
  return out;
}

interface StackStatus {
  [key: string]: StackRowStatus;
}

interface StackCounts {
  [key: string]: { running: number; total: number } | undefined;
}

interface StackStatusInfo {
  status: StackRowStatus;
  mainPort?: number;
  running?: number;
  total?: number;
  isSelf?: boolean;
}

export interface RemoteResult {
  nodeId: number;
  nodeName: string;
  files: Array<{ file: string; status: StackRowStatus }>;
}

const EMPTY_UPDATES: Record<string, StackUpdateInfo> = {};

export type StacksLoadStatus = 'idle' | 'loading' | 'success' | 'error';

export function useStackListState() {
  const { nodes, activeNode } = useNodes();

  const [files, setFiles] = useState<string[]>([]);
  // Node the current `files` list belongs to (null = local). Stamped together
  // with `files` from the node active when the fetch started, so a consumer can
  // tell whether the list it is reading is the one it expects, even during the
  // async gap right after a node switch when `files` still holds the old node's
  // entries. Filenames repeat across nodes, so a name lookup against the wrong
  // list would resolve to the wrong file.
  const [filesNodeId, setFilesNodeId] = useState<number | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [stackActions, setStackActions] = useState<Record<string, StackAction>>({});
  const stackActionsRef = useRef<Record<string, StackAction>>({});
  // Monotonic token per refreshStacks call; lets a superseded fetch skip its
  // state writes so a rapid node switch cannot leave a stale files/filesNodeId.
  const fetchSeqRef = useRef(0);

  // Hydration-timing: the current foreground list attempt and the commits it is
  // waiting for React to observe. Only foreground loads arm these; background
  // refreshes still record diagnostic spans but do not re-commit the milestones.
  const listAttemptRef = useRef<string | null>(null);
  const listVisiblePendingRef = useRef<PendingCommit | null>(null);
  const listHydratedPendingRef = useRef<PendingCommit | null>(null);

  // Per-stack terminal failure records driving the in-detail recovery panel.
  // In-memory only. Node scoping is enforced by the caller, which clears these
  // on active-node change (see EditorLayout's node-switch effect) so a repeated
  // stack filename cannot carry a failure across nodes.
  const [lastActionResult, setLastActionResult] = useState<Record<string, StackActionResult>>({});

  const [isScanning, setIsScanning] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [stackStatuses, setStackStatuses] = useState<StackStatus>({});
  const [stackPorts, setStackPorts] = useState<Record<string, number | undefined>>({});
  const [stackSelfFlags, setStackSelfFlags] = useState<Record<string, boolean>>({});
  const [stackCounts, setStackCounts] = useState<StackCounts>({});
  const [labels, setLabels] = useState<StackLabel[]>([]);
  const [stackLabelMap, setStackLabelMap] = useState<Record<string, StackLabel[]>>({});
  const [filterChip, setFilterChip] = useState<FilterChip>('all');
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [stacksLoadStatus, setStacksLoadStatus] = useState<StacksLoadStatus>('idle');
  const [stacksLoadError, setStacksLoadError] = useState<string | null>(null);
  const [stacksLoadNodeId, setStacksLoadNodeId] = useState<number | null>(null);
  const hadSuccessfulListRef = useRef(false);

  const { stackUpdates, refresh: fetchImageUpdates, sidebarIndicators } = useImageUpdates(activeNode?.id);
  const sidebarStackUpdates = sidebarIndicators ? stackUpdates : EMPTY_UPDATES;
  const { pinned, pin, unpin, isPinned, evictedOldest } = usePinnedStacks(activeNode?.id);
  const { isCollapsed, toggle: toggleCollapse } = useSidebarGroupCollapse(activeNode?.id);
  const { runBulk } = useBulkStackActions();

  const { hits: remoteSearchHits, failedNodes: remoteSearchFailedNodes, loading: remoteSearchLoading } = useCrossNodeStackSearch({
    query: searchQuery,
    enabled: true,
    excludeNodeId: activeNode?.id,
  });

  useEffect(() => {
    if (evictedOldest) toast.info('Pinned. Unpinned oldest (max 10).');
  }, [evictedOldest]);

  useEffect(() => {
    hadSuccessfulListRef.current = false;
    setStacksLoadStatus('idle');
    setStacksLoadError(null);
  }, [activeNode?.id]);

  // Ref is updated synchronously alongside the state setter so any code that
  // runs right after (e.g. `refreshStacks(true)` in an action's finally block)
  // observes the cleared map before React commits the next render. Without
  // this, the busy-stack check inside refreshStacks would still flag the
  // stack as in-progress and preserve the optimistic status mask.
  const setStackAction = (stackFile: string, action: StackAction) => {
    const next = { ...stackActionsRef.current, [stackFile]: action };
    stackActionsRef.current = next;
    setStackActions(next);
  };
  const clearStackAction = (stackFile: string) => {
    const next = { ...stackActionsRef.current };
    delete next[stackFile];
    stackActionsRef.current = next;
    setStackActions(next);
  };
  const isStackBusy = useCallback((stackFile: string) => stackFile in stackActionsRef.current, []);

  const setOptimisticStatus = (stackFile: string, status: 'running' | 'exited') => {
    setStackStatuses(prev => ({ ...prev, [stackFile]: status }));
  };

  // Recovery record lifecycle. recordActionFailure stores a terminal failure;
  // recordActionSuccess / dismissActionResult drop it; clearActionRecords wipes
  // all (node switch). The recovery panel itself renders only when the stack is
  // not mid-operation, so a stale record never shows during a retry.
  const clearStackResult = useCallback((stackFile: string) => {
    setLastActionResult(prev => {
      if (!(stackFile in prev)) return prev;
      const next = { ...prev };
      delete next[stackFile];
      return next;
    });
  }, []);
  const recordActionFailure = useCallback((stackFile: string, result: StackActionResult) => {
    setLastActionResult(prev => ({ ...prev, [stackFile]: result }));
  }, []);
  const recordActionSuccess = clearStackResult;
  const dismissActionResult = clearStackResult;
  const clearActionRecords = useCallback(() => {
    setLastActionResult({});
  }, []);

  const refreshLabels = useCallback(async () => {
    try {
      const [labelsRes, assignmentsRes] = await Promise.all([
        apiFetch('/labels'),
        apiFetch('/labels/assignments'),
      ]);
      if (labelsRes.ok) setLabels(await labelsRes.json());
      if (assignmentsRes.ok) setStackLabelMap(await assignmentsRes.json());
    } catch {
      // Labels are non-critical; fail silently
    }
  }, []);

  useEffect(() => {
    const handler = () => refreshLabels();
    window.addEventListener(SENCHO_LABELS_CHANGED, handler);
    return () => window.removeEventListener(SENCHO_LABELS_CHANGED, handler);
  }, [refreshLabels]);

  const refreshStacks = async (background = false): Promise<string[]> => {
    const fetchNodeId = activeNode?.id ?? null;
    const mySeq = ++fetchSeqRef.current;
    const stale = () => fetchSeqRef.current !== mySeq;

    // Supersede any in-flight list attempt so a late commit from an interrupted
    // load cannot record list_visible / list_hydrated for a stale fetch.
    if (listAttemptRef.current) abortAttempt(listAttemptRef.current);
    listVisiblePendingRef.current = null;
    listHydratedPendingRef.current = null;

    const attemptId = newAttemptId();
    listAttemptRef.current = attemptId;
    // True once the list itself is committed, so the shared catch below can tell
    // a list-fetch failure (nothing visible) from a status-path failure (list is
    // visible, hydration errored).
    let listSucceeded = false;
    let proxied = false;

    if (!background) setIsLoading(true);
    setStacksLoadNodeId(fetchNodeId);
    if (!background || !hadSuccessfulListRef.current) {
      setStacksLoadStatus('loading');
      setStacksLoadError(null);
    }

    // Tracks the most recently committed list for this attempt: `files` (the
    // render-time closure) is stale once the list itself has just succeeded
    // within this same call, e.g. the list decodes fine but the follow-up
    // /stacks/statuses decode then throws. Seeded from `files` so a failure
    // that happens before the list ever loads still consults the prior state.
    let latestFileList = files;

    // Soft (background) failure keeps a non-empty list visible, matching the
    // soft-failure handling in applyContainersFetchFailure (useStackActions.ts).
    // A list that was already confirmed empty must not stay masquerading as
    // empty: it becomes a recoverable error instead, since a soft failure is
    // otherwise indistinguishable from "still no stacks".
    const applyStacksFailure = (message: string): string[] => {
      if (background && hadSuccessfulListRef.current && latestFileList.length > 0) {
        setStacksLoadError(message);
        return latestFileList;
      }
      setFiles([]);
      setFilesNodeId(fetchNodeId);
      setStacksLoadStatus('error');
      setStacksLoadError(message);
      return [];
    };

    const headersSpan = beginSpan('fetch_headers', { attemptId, background });
    let bodySpan: SpanHandle | null = null;
    try {
      const res = await apiFetch('/stacks');
      proxied = res.headers.get('x-sencho-proxy') === '1';
      endSpan(headersSpan, { proxied, detail: { status: res.status } });
      if (stale()) { abortAttempt(attemptId); return []; }
      if (!res.ok) {
        return applyStacksFailure(`Could not load stacks (${res.status})`);
      }
      bodySpan = beginSpan('body_decode', { attemptId, background, proxied });
      const data = await res.json();
      endSpan(bodySpan);
      bodySpan = null;
      if (!Array.isArray(data)) {
        return applyStacksFailure('Stack list response was invalid.');
      }
      const fileList: string[] = data;
      latestFileList = fileList;
      const listDispatch = beginSpan('state_dispatch', { attemptId, background, proxied });
      setFiles(fileList);
      setFilesNodeId(fetchNodeId);
      hadSuccessfulListRef.current = true;
      setStacksLoadStatus('success');
      setStacksLoadError(null);
      endSpan(listDispatch);
      listSucceeded = true;
      // Token folds node + count so an empty->empty commit still fires once per
      // attempt even when the committed `files` is referentially equal.
      const listToken = `${fetchNodeId}:${fileList.length}`;
      if (!background) {
        listVisiblePendingRef.current = { attemptId, token: listToken, proxied };
      }

      // Fetch all stack statuses in a single bulk call. Only the current object
      // format can express `partial`; a node lacking the endpoint or returning
      // the legacy plain-string format is re-derived from per-stack containers
      // so a crashed container is not hidden behind a healthy sibling.
      // Skip statuses until activeNode resolves (null here means unresolved, not
      // "local"); never pass an unknown target into the shared fetch.
      if (fetchNodeId === null) {
        return fileList;
      }
      const statusHeaders = beginSpan('fetch_headers', { attemptId, background, proxied });
      let statusResult: StackStatusesFetchResult;
      try {
        statusResult = await fetchStackStatusesShared(fetchNodeId);
      } catch (statusErr) {
        endSpan(statusHeaders, { outcome: 'error', detail: { coalesced: false } });
        throw statusErr;
      }
      const statusProxied = statusResult.proxied || proxied;
      // Joined waiters mark network spans superseded so truncated join timings
      // are not mistaken for fast fetches.
      endSpan(statusHeaders, {
        outcome: statusResult.coalesced ? 'superseded' : undefined,
        proxied: statusProxied,
        detail: { status: statusResult.status, coalesced: statusResult.coalesced },
      });
      if (stale()) { abortAttempt(attemptId); return fileList; }
      let bulkStatuses: Record<string, StackRowStatus> = {};
      const bulkPorts: Record<string, number | undefined> = {};
      const bulkSelf: Record<string, boolean> = {};
      const bulkCounts: StackCounts = {};

      // Decode already happened inside the shared helper; do not emit a fake
      // body_decode span that would look like near-zero network work.
      const raw: unknown = statusResult.ok ? statusResult.body : null;
      if (isBulkStatusObjectFormat(raw)) {
        for (const [key, val] of Object.entries(raw as Record<string, StackStatusInfo>)) {
          bulkStatuses[key] = val.status;
          if (val.mainPort) bulkPorts[key] = val.mainPort;
          if (val.isSelf) bulkSelf[key] = true;
          if (val.running !== undefined && val.total !== undefined) {
            bulkCounts[key] = { running: val.running, total: val.total };
          }
        }
      } else {
        bulkStatuses = await deriveStatusesFromContainers(fileList);
      }
      const statusDispatch = beginSpan('state_dispatch', {
        attemptId,
        background,
        proxied: statusProxied,
        detail: { coalesced: statusResult.coalesced },
      });
      setStackStatuses(prev => {
        const next: StackStatus = {};
        for (const file of fileList) {
          const status = bulkStatuses[file] ?? 'unknown';
          next[file] = (file in stackActionsRef.current) ? (prev[file] ?? status) : status;
        }
        return next;
      });
      setStackPorts(prev => {
        const keys = Object.keys(bulkPorts);
        if (keys.length === Object.keys(prev).length && keys.every(k => prev[k] === bulkPorts[k])) return prev;
        return bulkPorts;
      });
      setStackSelfFlags(bulkSelf);
      setStackCounts(bulkCounts);
      endSpan(statusDispatch, { detail: { coalesced: statusResult.coalesced } });
      refreshLabels();
      if (!background) {
        listHydratedPendingRef.current = { attemptId, token: listToken, proxied: statusProxied };
      }
      return fileList;
    } catch (error) {
      // endSpan is a no-op when the span was already closed (or never opened).
      endSpan(headersSpan, { outcome: 'error' });
      if (bodySpan !== null) endSpan(bodySpan, { outcome: 'error' });
      if (stale()) { abortAttempt(attemptId); return []; }
      console.error('Failed to refresh stacks:', error);
      const message = error instanceof Error ? error.message : 'Failed to load stacks';
      // The list committed but hydrating its statuses threw: record the list
      // path as hydrated-with-error rather than leaving it hanging.
      if (listSucceeded && !background) {
        markMilestone('list_hydrated', { attemptId, outcome: 'error', proxied });
      }
      return applyStacksFailure(message);
    } finally {
      setIsLoading(false);
    }
  };

  // Held in a ref so the long-lived WS effect and scheduleStateInvalidateRefresh
  // never close over a stale refreshStacks.
  const refreshStacksRef = useRef(refreshStacks);
  useEffect(() => { refreshStacksRef.current = refreshStacks; });

  // Commit-aligned list milestones: fire once React has actually committed the
  // file list (list_visible) and the statuses (list_hydrated) for the owning
  // attempt. commitMilestone no-ops for a superseded/aborted attempt, so a stale
  // load can never complete a session it no longer owns. Empty lists still fire
  // via the completion token.
  useEffect(() => {
    if (stacksLoadStatus !== 'success') return;
    flushPendingCommit(listVisiblePendingRef, 'list_visible');
  }, [files, filesNodeId, stacksLoadStatus]);

  useEffect(() => {
    flushPendingCommit(listHydratedPendingRef, 'list_hydrated');
  }, [stackStatuses, filesNodeId]);

  const handleScanStacks = async () => {
    if (isScanning) return;
    setIsScanning(true);
    const previousStacks = [...files];
    try {
      const currentStacks = await refreshStacksRef.current();
      const added = currentStacks.filter(s => !previousStacks.includes(s));
      const removed = previousStacks.filter(s => !currentStacks.includes(s));

      if (added.length > 0) {
        toast.success(`Found ${added.length} new stack${added.length !== 1 ? 's' : ''}: ${added.join(', ')}`);
      }
      if (removed.length > 0) {
        toast.info(`${removed.length} stack${removed.length !== 1 ? 's' : ''} no longer detected: ${removed.join(', ')}`);
      }
      if (added.length === 0 && removed.length === 0) {
        toast.info('No new stacks found.');
      }
    } catch (error: unknown) {
      const err = error as Record<string, unknown>;
      const data = err?.data as Record<string, unknown> | undefined;
      toast.error((err?.message as string) || (err?.error as string) || (data?.error as string) || 'Something went wrong.');
    } finally {
      setIsScanning(false);
    }
  };

  // Coalesce a burst of state-invalidate signals into one stack refetch.
  // The 250ms debounce balances responsiveness against API thrashing.
  const stateInvalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleStateInvalidateRefresh = useCallback(() => {
    if (stateInvalidateTimerRef.current) clearTimeout(stateInvalidateTimerRef.current);
    stateInvalidateTimerRef.current = setTimeout(() => {
      stateInvalidateTimerRef.current = null;
      refreshStacksRef.current(true);
    }, 250);
  }, []);

  const filteredFiles = useMemo(
    () => files.filter(file => file.toLowerCase().includes(searchQuery.toLowerCase())),
    [files, searchQuery],
  );

  const hasConfirmedSidebarUpdate = (file: string): boolean => {
    const info = sidebarStackUpdates[file];
    return info != null && isConfirmedImageUpdate(info);
  };

  const filterCounts = useMemo(() => ({
    all: filteredFiles.length,
    up: filteredFiles.filter(f => stackStatuses[f] === 'running').length,
    down: filteredFiles.filter(f => isDownStatus(stackStatuses[f])).length,
    updates: filteredFiles.filter(hasConfirmedSidebarUpdate).length,
  }), [filteredFiles, stackStatuses, sidebarStackUpdates]);

  const chipFilteredFiles = useMemo(() => {
    if (filterChip === 'all') return filteredFiles;
    if (filterChip === 'up') return filteredFiles.filter(f => stackStatuses[f] === 'running');
    if (filterChip === 'down') return filteredFiles.filter(f => isDownStatus(stackStatuses[f]));
    if (filterChip === 'updates') return filteredFiles.filter(hasConfirmedSidebarUpdate);
    return filteredFiles;
  }, [filteredFiles, filterChip, stackStatuses, sidebarStackUpdates]);

  const toggleBulkMode = useCallback(() => {
    setBulkMode(prev => {
      if (prev) setSelectedFiles(new Set());
      return !prev;
    });
  }, []);

  const toggleSelect = useCallback((file: string) => {
    setSelectedFiles(prev => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedFiles(new Set());
  }, []);

  const handleBulkAction = useCallback((action: BulkAction) => {
    const filesToAction = Array.from(selectedFiles);
    runBulk(action, filesToAction, {
      onAfter: () => {
        refreshStacksRef.current(true);
        if (action === 'update') void fetchImageUpdates();
        clearSelection();
      },
    });
  }, [selectedFiles, runBulk, clearSelection, fetchImageUpdates]);

  const chipFilteredFilesRef = useRef(chipFilteredFiles);
  useEffect(() => { chipFilteredFilesRef.current = chipFilteredFiles; }, [chipFilteredFiles]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isInputFocused()) return;
      if (isPaletteOpen()) return;

      if (e.key === 'b' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        toggleBulkMode();
      } else if (e.key === 'Escape' && bulkMode) {
        e.preventDefault();
        setBulkMode(false);
        setSelectedFiles(new Set());
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'a' && bulkMode) {
        e.preventDefault();
        setSelectedFiles(new Set(chipFilteredFilesRef.current));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [bulkMode, toggleBulkMode]);

  const remoteStackResults = useMemo(() => {
    const out: Record<number, Array<{ file: string; status: StackRowStatus }>> = {};
    for (const hit of remoteSearchHits) {
      (out[hit.nodeId] ??= []).push({ file: hit.file, status: hit.status });
    }
    return out;
  }, [remoteSearchHits]);

  const remoteResults = useMemo((): RemoteResult[] => {
    return Object.entries(remoteStackResults).flatMap(([nodeIdStr, remoteFiles]) => {
      const node = nodes.find(n => n.id === Number(nodeIdStr));
      if (!node || remoteFiles.length === 0) return [];
      return [{
        nodeId: node.id,
        nodeName: node.name,
        files: remoteFiles.map(({ file, status }) => ({ file, status: status as StackRowStatus })),
      }];
    });
  }, [remoteStackResults, nodes]);

  // When the sidebar indicator toggle is turned off, reset an active Updates
  // filter to 'all' so the user is not stuck in a filter that shows nothing.
  useEffect(() => {
    if (!sidebarIndicators && filterChip === 'updates') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFilterChip('all');
    }
  }, [sidebarIndicators, filterChip]);

  return {
    files, setFiles, filesNodeId,
    selectedFile, setSelectedFile,
    isLoading, setIsLoading,
    stackActions, stackActionsRef,
    isScanning,
    searchQuery, setSearchQuery,
    stackStatuses, setStackStatuses,
    stackPorts, setStackPorts,
    stackSelfFlags,
    stackCounts,
    labels,
    stackLabelMap,
    filterChip, setFilterChip,
    bulkMode, setBulkMode,
    selectedFiles, setSelectedFiles,
    filteredFiles,
    filterCounts,
    chipFilteredFiles,
    remoteResults,
    setStackAction, clearStackAction, isStackBusy,
    setOptimisticStatus,
    lastActionResult,
    recordActionFailure, recordActionSuccess, clearActionRecords, dismissActionResult,
    refreshLabels,
    refreshStacks,
    handleScanStacks,
    scheduleStateInvalidateRefresh,
    toggleBulkMode, toggleSelect, clearSelection, handleBulkAction,
    stackUpdates, fetchImageUpdates,
    sidebarIndicators, sidebarStackUpdates,
    pinned, pin, unpin, isPinned,
    isCollapsed, toggleCollapse,
    remoteSearchLoading,
    remoteSearchFailedNodes,
    stacksLoadStatus,
    stacksLoadError,
    stacksLoadNodeId,
  } as const;
}
