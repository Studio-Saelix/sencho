import { useCallback, useEffect, useRef, useState } from 'react';
import { parse as parseYaml } from 'yaml';
import { visibilityInterval } from '@/lib/utils';
import type { ContainerInfo } from '../EditorView';

/** Trailing-edge debounce for state-invalidate, matches useDashboardData. */
export const INVALIDATE_DEBOUNCE_MS = 250;
export const POLL_INTERVAL_MS = 10_000;
export const STALE_FAILURE_THRESHOLD = 3;

export type SoftRefreshOutcome = 'ok' | 'skipped' | 'failed';

export type StateInvalidateDetail = {
  type?: string;
  scope?: string;
  nodeId?: number | null;
  stackName?: string | null;
  containerId?: string | null;
  action?: string;
  ts?: number;
};

export type UseSelectedStackLiveRefreshArgs = {
  selectedFile: string | null;
  activeNodeId: number | undefined;
  /** False when activeView is not the stack editor (e.g. Security, Fleet). */
  isDetailVisible: boolean;
  containers: ContainerInfo[];
  composeContent: string;
  containersLoadStatus: 'idle' | 'loading' | 'success' | 'error';
  refreshSelectedContainers: (stackName: string, stackFile: string) => Promise<SoftRefreshOutcome>;
};

export type UseSelectedStackLiveRefreshResult = {
  syncStale: boolean;
  retrySync: () => void;
};

function stackBasename(stackFile: string): string {
  return stackFile.replace(/\.(yml|yaml)$/i, '');
}

/** Parse top-level Compose `name:` once per content snapshot. */
export function parseComposeProjectName(content: string): string | null {
  if (!content.trim()) return null;
  try {
    const parsed = parseYaml(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const name = (parsed as Record<string, unknown>).name;
    if (typeof name !== 'string') return null;
    const trimmed = name.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // Invalid YAML: no project alias from content.
  }
  return null;
}

/** Match Docker event IDs (often full 64-char) against list IDs (often short). */
export function containerIdMatches(ids: ReadonlySet<string>, eventId: string): boolean {
  if (ids.has(eventId)) return true;
  if (eventId.length < 12) return false;
  for (const id of ids) {
    if (id.length < 12) continue;
    if (id.startsWith(eventId) || eventId.startsWith(id)) return true;
  }
  return false;
}

function containersFingerprint(containers: ContainerInfo[]): string {
  return containers
    .map((c) => `${c.Id}:${c.State}:${c.healthStatus ?? ''}`)
    .join('\0');
}

/**
 * Decide whether a stack-scoped invalidate should soft-refresh the open detail.
 * Basename and project-alias comparisons are case-sensitive (Docker project labels are).
 */
export function shouldRefreshForInvalidate(
  detail: StateInvalidateDetail,
  opts: {
    activeNodeId: number | undefined;
    selectedBasename: string;
    composeProjectName: string | null;
    learnedAliases: ReadonlySet<string>;
    containerIds: ReadonlySet<string>;
  },
): boolean {
  if (detail.scope !== 'stack') return false;
  if (opts.activeNodeId === undefined || detail.nodeId !== opts.activeNodeId) return false;

  const containerId = detail.containerId ?? null;
  if (containerId && containerIdMatches(opts.containerIds, containerId)) return true;

  const project = detail.stackName ?? null;
  // Identity unproven: soft-refresh the selected stack (node-scoped fallback).
  if (!project) return true;

  if (project === opts.selectedBasename) return true;
  if (opts.composeProjectName !== null && project === opts.composeProjectName) return true;
  if (opts.learnedAliases.has(project)) return true;

  return false;
}

/**
 * Keep the open stack's container cards and health state synchronized with Docker
 * via sencho:state-invalidate plus a visibility-aware poll. Soft-refreshes only;
 * does not reload compose, env, or logs.
 */
export function useSelectedStackLiveRefresh({
  selectedFile,
  activeNodeId,
  isDetailVisible,
  containers,
  composeContent,
  containersLoadStatus,
  refreshSelectedContainers,
}: UseSelectedStackLiveRefreshArgs): UseSelectedStackLiveRefreshResult {
  const [syncStale, setSyncStale] = useState(false);

  const selectedFileRef = useRef(selectedFile);
  const activeNodeIdRef = useRef(activeNodeId);
  const isDetailVisibleRef = useRef(isDetailVisible);
  const refreshRef = useRef(refreshSelectedContainers);
  const failureCountRef = useRef(0);
  const inFlightRef = useRef(false);
  const trailingNeededRef = useRef(false);
  const invalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const learnedAliasesRef = useRef<Set<string>>(new Set());
  const composeProjectNameRef = useRef<string | null>(null);
  const containerIdsRef = useRef<Set<string>>(new Set());
  const prevFingerprintRef = useRef(containersFingerprint(containers));
  const prevLoadStatusRef = useRef(containersLoadStatus);

  selectedFileRef.current = selectedFile;
  activeNodeIdRef.current = activeNodeId;
  isDetailVisibleRef.current = isDetailVisible;
  refreshRef.current = refreshSelectedContainers;
  containerIdsRef.current = new Set(containers.map((c) => c.Id).filter(Boolean));

  function clearInvalidateTimer(): void {
    if (!invalidateTimerRef.current) return;
    clearTimeout(invalidateTimerRef.current);
    invalidateTimerRef.current = null;
  }

  // Cache compose project alias when content changes (not per event).
  useEffect(() => {
    composeProjectNameRef.current = parseComposeProjectName(composeContent);
  }, [composeContent]);

  // Reset learned aliases and stale state when the selection changes.
  useEffect(() => {
    learnedAliasesRef.current = new Set();
    failureCountRef.current = 0;
    // Keep trailingNeeded while a soft refresh is in flight so the finally
    // block can refresh the *current* selection instead of dropping the event.
    if (!inFlightRef.current) {
      trailingNeededRef.current = false;
    }
    clearInvalidateTimer();
    setSyncStale(false); // eslint-disable-line react-hooks/set-state-in-effect -- reset on selection identity change
  }, [selectedFile, activeNodeId]);

  // Drop pending debounce when leaving stack detail (Security / Fleet / etc.).
  // Keep trailingNeeded while in flight so finally can refresh if the user
  // returns before the request finishes (gated on isDetailVisibleRef there).
  useEffect(() => {
    if (isDetailVisible) return;
    if (!inFlightRef.current) {
      trailingNeededRef.current = false;
    }
    clearInvalidateTimer();
  }, [isDetailVisible]);

  // Successful container list from any path clears the failure counter.
  // Fingerprint includes State + healthStatus so same-ID health transitions clear stale.
  const fingerprint = containersFingerprint(containers);
  if (fingerprint !== prevFingerprintRef.current) {
    prevFingerprintRef.current = fingerprint;
    failureCountRef.current = 0;
    if (syncStale) setSyncStale(false);
  }

  // Confirmed-empty success (fingerprint stays '') must also clear stale after a Retry.
  if (
    containersLoadStatus === 'success'
    && prevLoadStatusRef.current !== 'success'
  ) {
    failureCountRef.current = 0;
    if (syncStale) setSyncStale(false);
  }
  prevLoadStatusRef.current = containersLoadStatus;

  const runRefresh = useCallback(async () => {
    if (!isDetailVisibleRef.current) return;
    const file = selectedFileRef.current;
    const nodeId = activeNodeIdRef.current;
    if (!file || nodeId === undefined) return;

    if (inFlightRef.current) {
      trailingNeededRef.current = true;
      return;
    }

    inFlightRef.current = true;
    const basename = stackBasename(file);
    try {
      const outcome = await refreshRef.current(basename, file);
      if (selectedFileRef.current !== file || activeNodeIdRef.current !== nodeId) {
        return;
      }
      if (outcome === 'ok') {
        failureCountRef.current = 0;
        setSyncStale(false);
      } else if (outcome === 'failed') {
        // Count real soft failures only. 'skipped' (stale/aborted arbitration)
        // must not advance the stale chip.
        failureCountRef.current += 1;
        if (failureCountRef.current >= STALE_FAILURE_THRESHOLD) {
          setSyncStale(true);
        }
      }
    } finally {
      inFlightRef.current = false;
      const hadTrailing = trailingNeededRef.current;
      trailingNeededRef.current = false;
      // Trailing refresh targets the current selection (may have changed mid-flight).
      if (
        !hadTrailing
        || !isDetailVisibleRef.current
        || !selectedFileRef.current
        || activeNodeIdRef.current === undefined
      ) {
        return;
      }
      void runRefresh();
    }
  }, []);

  const scheduleDebouncedRefresh = useCallback(() => {
    if (!isDetailVisibleRef.current) return;
    clearInvalidateTimer();
    invalidateTimerRef.current = setTimeout(() => {
      invalidateTimerRef.current = null;
      void runRefresh();
    }, INVALIDATE_DEBOUNCE_MS);
  }, [runRefresh]);

  useEffect(() => {
    if (!isDetailVisible) return;

    const onInvalidate = (e: Event) => {
      // Ref guard covers the gap between isDetailVisible flipping and effect cleanup.
      if (!isDetailVisibleRef.current) return;
      const detail = (e as CustomEvent<StateInvalidateDetail>).detail ?? {};
      const file = selectedFileRef.current;
      if (!file) return;

      const basename = stackBasename(file);
      const should = shouldRefreshForInvalidate(detail, {
        activeNodeId: activeNodeIdRef.current,
        selectedBasename: basename,
        composeProjectName: composeProjectNameRef.current,
        learnedAliases: learnedAliasesRef.current,
        containerIds: containerIdsRef.current,
      });
      if (!should) return;

      const project = detail.stackName;
      if (
        project
        && detail.containerId
        && containerIdMatches(containerIdsRef.current, detail.containerId)
      ) {
        learnedAliasesRef.current.add(project);
      }

      scheduleDebouncedRefresh();
    };

    window.addEventListener('sencho:state-invalidate', onInvalidate);
    return () => {
      window.removeEventListener('sencho:state-invalidate', onInvalidate);
      clearInvalidateTimer();
    };
  }, [isDetailVisible, scheduleDebouncedRefresh]);

  useEffect(() => {
    if (!isDetailVisible || !selectedFile || activeNodeId === undefined) return;
    return visibilityInterval(() => {
      void runRefresh();
    }, POLL_INTERVAL_MS);
  }, [isDetailVisible, selectedFile, activeNodeId, runRefresh]);

  const retrySync = useCallback(() => {
    failureCountRef.current = 0;
    setSyncStale(false);
    void runRefresh();
  }, [runRefresh]);

  return { syncStale, retrySync };
}
