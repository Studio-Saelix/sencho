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
import type { StackAction, ContainerInfo } from '../EditorView';
import type { Label as StackLabel } from '../../label-types';
import type { FilterChip } from '../../sidebar/sidebar-types';
import type { StackRowStatus } from '../../sidebar/stack-status-utils';

interface StackStatus {
  [key: string]: 'running' | 'exited' | 'unknown';
}

interface StackStatusInfo {
  status: 'running' | 'exited' | 'unknown';
  mainPort?: number;
}

export interface RemoteResult {
  nodeId: number;
  nodeName: string;
  files: Array<{ file: string; status: StackRowStatus }>;
}

export function useStackListState() {
  const { nodes, activeNode } = useNodes();

  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [stackActions, setStackActions] = useState<Record<string, StackAction>>({});
  const stackActionsRef = useRef<Record<string, StackAction>>({});
  stackActionsRef.current = stackActions;

  const [isScanning, setIsScanning] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [stackStatuses, setStackStatuses] = useState<StackStatus>({});
  const [stackPorts, setStackPorts] = useState<Record<string, number | undefined>>({});
  const [labels, setLabels] = useState<StackLabel[]>([]);
  const [stackLabelMap, setStackLabelMap] = useState<Record<string, StackLabel[]>>({});
  const [autoUpdateSettings, setAutoUpdateSettings] = useState<Record<string, boolean>>({});
  const [filterChip, setFilterChip] = useState<FilterChip>('all');
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());

  const { stackUpdates, refresh: fetchImageUpdates } = useImageUpdates(activeNode?.id);
  const { pinned, pin, unpin, isPinned, evictedOldest } = usePinnedStacks(activeNode?.id);
  const { isCollapsed, toggle: toggleCollapse } = useSidebarGroupCollapse(activeNode?.id);
  const { runBulk } = useBulkStackActions();

  const { hits: remoteSearchHits, loading: remoteSearchLoading } = useCrossNodeStackSearch({
    query: searchQuery,
    enabled: true,
    excludeNodeId: activeNode?.id,
  });

  useEffect(() => {
    if (evictedOldest) toast.info('Pinned. Unpinned oldest (max 10).');
  }, [evictedOldest]);

  const setStackAction = (stackFile: string, action: StackAction) => {
    setStackActions(prev => ({ ...prev, [stackFile]: action }));
  };
  const clearStackAction = (stackFile: string) => {
    setStackActions(prev => {
      const next = { ...prev };
      delete next[stackFile];
      return next;
    });
  };
  const isStackBusy = useCallback((stackFile: string) => stackFile in stackActionsRef.current, []);

  const setOptimisticStatus = (stackFile: string, status: 'running' | 'exited') => {
    setStackStatuses(prev => ({ ...prev, [stackFile]: status }));
  };

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
    try {
      const res = await apiFetch('/stacks');
      if (!res.ok) {
        setFiles([]);
        return [];
      }
      const data = await res.json();
      const fileList: string[] = Array.isArray(data) ? data : [];
      setFiles(fileList);

      // Fetch all stack statuses in a single bulk call (falls back to per-stack queries for older remote nodes)
      const statusRes = await apiFetch('/stacks/statuses');
      let bulkStatuses: Record<string, 'running' | 'exited' | 'unknown'> | null = null;
      const bulkPorts: Record<string, number | undefined> = {};
      if (statusRes.ok) {
        const raw = await statusRes.json();
        bulkStatuses = {};
        // Handle both old format (plain string) and new format ({ status, mainPort })
        for (const [key, val] of Object.entries(raw)) {
          if (typeof val === 'string') {
            bulkStatuses[key] = val as 'running' | 'exited' | 'unknown';
          } else if (val && typeof val === 'object' && 'status' in val) {
            const info = val as StackStatusInfo;
            bulkStatuses[key] = info.status;
            if (info.mainPort) bulkPorts[key] = info.mainPort;
          }
        }
      } else {
        // Fallback: query each stack individually (remote node may not have bulk endpoint)
        const statusResults = await Promise.allSettled(
          fileList.map(async (file) => {
            const containersRes = await apiFetch(`/stacks/${file}/containers`);
            if (!containersRes.ok) return { file, status: 'unknown' as const };
            const containers = await containersRes.json();
            const hasRunning = Array.isArray(containers) && containers.some((c: ContainerInfo) => c.State === 'running');
            return { file, status: hasRunning ? 'running' as const : (Array.isArray(containers) && containers.length > 0 ? 'exited' as const : 'unknown' as const) };
          })
        );
        bulkStatuses = {};
        for (const result of statusResults) {
          if (result.status === 'fulfilled') {
            bulkStatuses[result.value.file] = result.value.status;
          }
        }
      }
      setStackStatuses(prev => {
        const next: StackStatus = {};
        for (const file of fileList) {
          const status = bulkStatuses?.[file] ?? 'unknown';
          next[file] = (file in stackActionsRef.current) ? (prev[file] ?? status) : status;
        }
        return next;
      });
      setStackPorts(prev => {
        const keys = Object.keys(bulkPorts);
        if (keys.length === Object.keys(prev).length && keys.every(k => prev[k] === bulkPorts[k])) return prev;
        return bulkPorts;
      });
      refreshLabels();
      return fileList;
    } catch (error) {
      console.error('Failed to refresh stacks:', error);
      setFiles([]);
      return [];
    } finally {
      setIsLoading(false);
    }
  };

  // Held in a ref so the long-lived WS effect and scheduleStateInvalidateRefresh
  // never close over a stale refreshStacks.
  const refreshStacksRef = useRef(refreshStacks);
  useEffect(() => { refreshStacksRef.current = refreshStacks; });

  const fetchAutoUpdateSettings = async () => {
    try {
      const res = await apiFetch('/stacks/auto-update-settings');
      if (res.ok) {
        const data = await res.json();
        setAutoUpdateSettings(data as Record<string, boolean>);
      } else {
        console.error('[AutoUpdateSettings] fetch returned', res.status);
      }
    } catch (e: unknown) {
      console.error('[AutoUpdateSettings] fetch failed:', e);
    }
  };

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
    down: filteredFiles.filter(f => stackStatuses[f] === 'exited').length,
    updates: filteredFiles.filter(f => !!stackUpdates[f]).length,
  }), [filteredFiles, stackStatuses, stackUpdates]);

  const chipFilteredFiles = useMemo(() => {
    if (filterChip === 'all') return filteredFiles;
    if (filterChip === 'up') return filteredFiles.filter(f => stackStatuses[f] === 'running');
    if (filterChip === 'down') return filteredFiles.filter(f => stackStatuses[f] === 'exited');
    if (filterChip === 'updates') return filteredFiles.filter(f => !!stackUpdates[f]);
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
      onAfter: () => { refreshStacksRef.current(true); clearSelection(); },
    });
  }, [selectedFiles, runBulk, clearSelection]);

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
    const out: Record<number, Array<{ file: string; status: 'running' | 'exited' | 'unknown' }>> = {};
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
    files, setFiles,
    selectedFile, setSelectedFile,
    isLoading, setIsLoading,
    stackActions, stackActionsRef,
    isScanning,
    searchQuery, setSearchQuery,
    stackStatuses, setStackStatuses,
    stackPorts, setStackPorts,
    labels,
    stackLabelMap,
    autoUpdateSettings, setAutoUpdateSettings,
    filterChip, setFilterChip,
    bulkMode, setBulkMode,
    selectedFiles, setSelectedFiles,
    filteredFiles,
    filterCounts,
    chipFilteredFiles,
    remoteResults,
    setStackAction, clearStackAction, isStackBusy,
    setOptimisticStatus,
    refreshLabels,
    refreshStacks,
    fetchAutoUpdateSettings,
    handleScanStacks,
    scheduleStateInvalidateRefresh,
    toggleBulkMode, toggleSelect, clearSelection, handleBulkAction,
    stackUpdates, fetchImageUpdates,
    pinned, pin, unpin, isPinned,
    isCollapsed, toggleCollapse,
    remoteSearchLoading,
  } as const;
}
