import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { useNodes } from '@/context/NodeContext';
import { useImageUpdates } from '@/hooks/useImageUpdates';
import { usePinnedStacks } from '@/hooks/usePinnedStacks';
import { useSidebarGroupCollapse } from '@/hooks/useSidebarGroupCollapse';
import { useBulkStackActions, type BulkAction } from '@/hooks/useBulkStackActions';
import { useCrossNodeStackSearch } from '@/hooks/useCrossNodeStackSearch';
import { SENCHO_LABELS_CHANGED } from '@/lib/events';
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
}

export interface RemoteResult {
  nodeId: number;
  nodeName: string;
  files: Array<{ file: string; status: StackRowStatus }>;
}

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

  // Per-stack terminal failure records driving the in-detail recovery panel.
  // In-memory only. Node scoping is enforced by the caller, which clears these
  // on active-node change (see EditorLayout's node-switch effect) so a repeated
  // stack filename cannot carry a failure across nodes.
  const [lastActionResult, setLastActionResult] = useState<Record<string, StackActionResult>>({});

  const [isScanning, setIsScanning] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [stackStatuses, setStackStatuses] = useState<StackStatus>({});
  const [stackPorts, setStackPorts] = useState<Record<string, number | undefined>>({});
  const [stackCounts, setStackCounts] = useState<StackCounts>({});
  const [labels, setLabels] = useState<StackLabel[]>([]);
  const [stackLabelMap, setStackLabelMap] = useState<Record<string, StackLabel[]>>({});
  const [filterChip, setFilterChip] = useState<FilterChip>('all');
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());

  const { stackUpdates, refresh: fetchImageUpdates } = useImageUpdates(activeNode?.id);
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
    if (!background) setIsLoading(true);
    // Snapshot the node this fetch targets and a sequence token so a superseded
    // or out-of-order resolution (from a rapid node switch) cannot overwrite a
    // newer node's list, keeping `files` and `filesNodeId` consistent.
    const fetchNodeId = activeNode?.id ?? null;
    const mySeq = ++fetchSeqRef.current;
    const stale = () => fetchSeqRef.current !== mySeq;
    try {
      const res = await apiFetch('/stacks');
      if (stale()) return [];
      if (!res.ok) {
        setFiles([]);
        setFilesNodeId(fetchNodeId);
        return [];
      }
      const data = await res.json();
      const fileList: string[] = Array.isArray(data) ? data : [];
      setFiles(fileList);
      setFilesNodeId(fetchNodeId);

      // Fetch all stack statuses in a single bulk call. Only the current object
      // format can express `partial`; a node lacking the endpoint or returning
      // the legacy plain-string format is re-derived from per-stack containers
      // so a crashed container is not hidden behind a healthy sibling.
      const statusRes = await apiFetch('/stacks/statuses');
      if (stale()) return fileList;
      let bulkStatuses: Record<string, StackRowStatus> = {};
      const bulkPorts: Record<string, number | undefined> = {};
      const bulkCounts: StackCounts = {};

      const raw: unknown = statusRes.ok ? await statusRes.json() : null;
      if (isBulkStatusObjectFormat(raw)) {
        for (const [key, val] of Object.entries(raw as Record<string, StackStatusInfo>)) {
          bulkStatuses[key] = val.status;
          if (val.mainPort) bulkPorts[key] = val.mainPort;
          if (val.running !== undefined && val.total !== undefined) {
            bulkCounts[key] = { running: val.running, total: val.total };
          }
        }
      } else {
        bulkStatuses = await deriveStatusesFromContainers(fileList);
      }
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
      setStackCounts(bulkCounts);
      refreshLabels();
      return fileList;
    } catch (error) {
      if (stale()) return [];
      console.error('Failed to refresh stacks:', error);
      setFiles([]);
      setFilesNodeId(fetchNodeId);
      return [];
    } finally {
      setIsLoading(false);
    }
  };

  // Held in a ref so the long-lived WS effect and scheduleStateInvalidateRefresh
  // never close over a stale refreshStacks.
  const refreshStacksRef = useRef(refreshStacks);
  useEffect(() => { refreshStacksRef.current = refreshStacks; });

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

  const filterCounts = useMemo(() => ({
    all: filteredFiles.length,
    up: filteredFiles.filter(f => stackStatuses[f] === 'running').length,
    down: filteredFiles.filter(f => isDownStatus(stackStatuses[f])).length,
    updates: filteredFiles.filter(f => stackUpdates[f]?.hasUpdate).length,
  }), [filteredFiles, stackStatuses, stackUpdates]);

  const chipFilteredFiles = useMemo(() => {
    if (filterChip === 'all') return filteredFiles;
    if (filterChip === 'up') return filteredFiles.filter(f => stackStatuses[f] === 'running');
    if (filterChip === 'down') return filteredFiles.filter(f => isDownStatus(stackStatuses[f]));
    if (filterChip === 'updates') return filteredFiles.filter(f => stackUpdates[f]?.hasUpdate);
    return filteredFiles;
  }, [filteredFiles, filterChip, stackStatuses, stackUpdates]);

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

  return {
    files, setFiles, filesNodeId,
    selectedFile, setSelectedFile,
    isLoading, setIsLoading,
    stackActions, stackActionsRef,
    isScanning,
    searchQuery, setSearchQuery,
    stackStatuses, setStackStatuses,
    stackPorts, setStackPorts,
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
    pinned, pin, unpin, isPinned,
    isCollapsed, toggleCollapse,
    remoteSearchLoading,
    remoteSearchFailedNodes,
  } as const;
}
