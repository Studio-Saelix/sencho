import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { apiFetch } from '@/lib/api';
import { fetchStackStatusesShared } from '@/lib/stackStatusesFetch';
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
import { isDownStatus, classifyContainersStatus, isContainerStateInfo, isValidBulkPayload, isValidLegacyPayload, parseBulkStatusPayload } from '../../sidebar/stack-status-utils';
import type { StackRowStatus } from '../../sidebar/stack-status-utils';

/** Result of the legacy per-stack container derivation, with the number of
 *  stacks whose status comes from a successful, valid container response.
 *  Network or HTTP failures do not count as coverage, so a partially failing
 *  fallback cannot authorize actions on the files it could not inspect. */
interface DerivedStatuses {
  statuses: Record<string, StackRowStatus>;
  coveredFileCount: number;
}

/** Compatibility path for remote nodes whose `/stacks/statuses` is absent or
 *  returns the legacy plain-string format: query each stack's containers and
 *  classify them so a degraded (partial) stack is not reported as healthy.
 *  Requests target the captured node explicitly so a mid-switch fallback never
 *  drifts to whatever node is active when the per-stack calls resolve.
 *  Per-file failures are collected and logged so a total fallback failure is
 *  diagnosable instead of being indistinguishable from "no statuses yet". */
async function deriveStatusesFromContainers(
  fileList: string[],
  nodeId: number | null,
): Promise<DerivedStatuses> {
  const failed: string[] = [];
  const results = await Promise.allSettled(
    fileList.map(async (file): Promise<{ file: string; status: StackRowStatus; valid: boolean }> => {
      let containersRes: Response;
      try {
        containersRes = await apiFetch(`/stacks/${file}/containers`, { nodeId });
      } catch (err) {
        failed.push(`${file} (${err instanceof Error ? err.message : 'network error'})`);
        return { file, status: 'unknown', valid: false };
      }
      if (!containersRes.ok) {
        failed.push(`${file} (HTTP ${containersRes.status})`);
        return { file, status: 'unknown', valid: false };
      }
      try {
        const containers: unknown = await containersRes.json();
        // Only a container ARRAY with well-shaped entries is authoritative
        // evidence. A successful 200 carrying an error object or malformed
        // entries must fail closed, not count as coverage.
        const valid = Array.isArray(containers) && containers.every(isContainerStateInfo);
        if (!valid) {
          failed.push(`${file} (malformed container payload)`);
          return { file, status: 'unknown', valid: false };
        }
        return { file, status: classifyContainersStatus(containers), valid: true };
      } catch (err) {
        failed.push(`${file} (decode: ${err instanceof Error ? err.message : 'invalid body'})`);
        return { file, status: 'unknown', valid: false };
      }
    }),
  );
  const out: Record<string, StackRowStatus> = {};
  let coveredFileCount = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') {
      out[result.value.file] = result.value.status;
      if (result.value.valid) coveredFileCount += 1;
    }
  }
  if (failed.length > 0) {
    console.error(`Legacy status derivation failed for ${failed.length}/${fileList.length} stacks:`, failed.join('; '));
  }
  return { statuses: out, coveredFileCount };
}

interface StackStatus {
  [key: string]: StackRowStatus;
}

interface StackCounts {
  [key: string]: { running: number; total: number } | undefined;
}

export interface RemoteResult {
  nodeId: number;
  nodeName: string;
  files: Array<{ file: string; status: StackRowStatus }>;
}

const EMPTY_UPDATES: Record<string, StackUpdateInfo> = {};

export type StacksLoadStatus = 'idle' | 'loading' | 'success' | 'error';

/** The authoritative record of which status evidence the current list holds.
 *  `null` means pending: no current-node status result has landed for the
 *  committed list yet. Readiness and display are derived from this record at
 *  render time (see `hydrationReadyRef`), so a node switch or list change
 *  fails closed on the very first frame, before any effect runs.
 *  Discriminated on `outcome`: an error record carries no source or stale
 *  fields, so "error with stale identity" is unrepresentable. */
export type HydrationSource = 'bulk' | 'legacy';

export type HydrationEvidence =
  | {
      nodeId: number;
      /** Content identity of the committed list: JSON of sorted filenames. */
      listFingerprint: string;
      outcome: 'ok';
      /** `bulk` = current object format; `legacy` = per-stack container derivation. */
      source: HydrationSource;
      /** True when this is prior evidence preserved through a failed refresh
       *  and is no longer authoritative. Always false on fresh success. */
      stale: boolean;
      /** Number of current-list files covered by a successful, valid status entry. */
      coveredFileCount: number;
    }
  | {
      nodeId: number;
      /** Content identity of the committed list: JSON of sorted filenames. */
      listFingerprint: string;
      outcome: 'error';
      /** Error evidence never covers any file. */
      coveredFileCount: 0;
    };

/** Display projection of hydration state, derived once per render.
 *  - pending: no status evidence for the current list yet
 *  - error: the status fetch failed terminally
 *  - stale: prior same-node evidence retained through a failed refresh, or the
 *    evidence no longer matches the active node / committed list
 *  - incomplete: evidence covers only part of the current list
 *  - current: evidence is authoritative for the visible list */
export type HydrationDisplayState = 'pending' | 'error' | 'current' | 'stale' | 'incomplete';

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

  // Hydration evidence: the single source of truth for whether the visible list
  // has authoritative status data. The ref mirrors the state synchronously so
  // readiness checks in async handlers read current values, and so the first
  // render after a transition is already fail-closed (no effect needed).
  const [hydrationEvidence, setHydrationEvidence] = useState<HydrationEvidence | null>(null);
  const evidenceRef = useRef<HydrationEvidence | null>(null);
  // Render-synchronous refs (updated inline during render, matching the
  // NodeContext pattern) plus commit-synchronous fingerprint/count refs, so
  // `hydrationReadyRef` always evaluates the CURRENT node/list/evidence.
  const activeNodeIdRef = useRef<number | null>(activeNode?.id ?? null);
  activeNodeIdRef.current = activeNode?.id ?? null;
  const currentFingerprintRef = useRef<string>('');
  const currentFileCountRef = useRef(0);
  // The attempt id that owns the sidebar loading state. Background refreshes
  // take over an in-flight foreground owner so the skeleton dissolves when the
  // current attempt's list lands, never when a stale attempt finishes.
  const loadingOwnerRef = useRef<string | null>(null);

  const setHydrationEvidenceSync = (next: HydrationEvidence | null): void => {
    evidenceRef.current = next;
    setHydrationEvidence(next);
  };

  // Readiness is a function of the evidence record against the current node and
  // list, evaluated at call time (ref-backed), never captured in a closure.
  const hydrationReadyRef = useRef<() => boolean>(() => false);
  // Render-synchronous mirror so the predicate also fails when the list itself
  // errored: stale bulk selection must not dispatch against a failed-to-load
  // list even though the evidence record still matches the last list.
  const stacksLoadStatusRef = useRef<StacksLoadStatus>('idle');
  stacksLoadStatusRef.current = stacksLoadStatus;
  hydrationReadyRef.current = () => {
    if (stacksLoadStatusRef.current === 'error') return false;
    const e = evidenceRef.current;
    if (!e || e.outcome !== 'ok' || e.stale) return false;
    if (e.nodeId !== activeNodeIdRef.current) return false;
    if (e.listFingerprint !== currentFingerprintRef.current) return false;
    if (e.coveredFileCount !== currentFileCountRef.current) return false;
    return true;
  };

  const hydrationStatus: 'pending' | 'ok' | 'error' = hydrationEvidence?.outcome ?? 'pending';
  const actionsReady = hydrationReadyRef.current();
  const hydrationDisplay: HydrationDisplayState = (() => {
    const e = hydrationEvidence;
    if (!e) return 'pending';
    if (e.outcome === 'error') return 'error';
    // A node mismatch means the evidence (and the maps) belong to a different
    // node: show pending, never the prior node's data as current or stale.
    if (e.nodeId !== activeNodeIdRef.current) return 'pending';
    if (e.stale || e.listFingerprint !== currentFingerprintRef.current) return 'stale';
    if (e.coveredFileCount !== currentFileCountRef.current) return 'incomplete';
    return 'current';
  })();

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
    // Cross-node data must never render under a repeated filename: drop the
    // prior node's status-derived maps and evidence. Render-time derivation
    // (nodeId checks in hydrationDisplay/actionsReady) already fails closed on
    // the first frame; this effect is the cleanup, not the guard.
    setStackStatuses({});
    setStackPorts({});
    setStackSelfFlags({});
    setStackCounts({});
    setHydrationEvidenceSync(null);
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
    // Read the CURRENT active node from the render-synchronous ref, not the
    // closure: a callback captured on node A and invoked after the operator
    // switched to node B must refresh B, never mix A's statuses with a live
    // list request.
    const fetchNodeId = activeNodeIdRef.current;
    const mySeq = ++fetchSeqRef.current;
    const stale = () => fetchSeqRef.current !== mySeq;

    // Supersede any in-flight list attempt so a late commit from an interrupted
    // load cannot record list_visible / list_hydrated for a stale fetch.
    if (listAttemptRef.current) abortAttempt(listAttemptRef.current);
    listVisiblePendingRef.current = null;
    listHydratedPendingRef.current = null;

    const attemptId = newAttemptId();
    listAttemptRef.current = attemptId;
    // True once the list itself is committed, so the status-failure paths can
    // tell a list-fetch failure (nothing visible) from a status-path failure
    // (list is visible, hydration errored).
    let listSucceeded = false;
    let proxied = false;

    // List-loading ownership: the foreground attempt that set the skeleton owns
    // clearing it, at the moment its list commits (progressive visibility). A
    // background refresh that supersedes an in-flight foreground load takes over
    // the owner so the displaced foreground can never clear loading for a newer
    // attempt, and the skeleton dissolves when the current attempt's list lands.
    if (!background) {
      loadingOwnerRef.current = attemptId;
      setIsLoading(true);
    } else if (loadingOwnerRef.current !== null) {
      loadingOwnerRef.current = attemptId;
    }
    const settleLoading = () => {
      if (loadingOwnerRef.current === attemptId) {
        loadingOwnerRef.current = null;
        setIsLoading(false);
      }
    };

    setStacksLoadNodeId(fetchNodeId);
    if (!background || !hadSuccessfulListRef.current) {
      setStacksLoadStatus('loading');
      setStacksLoadError(null);
    }

    // Tracks the most recently committed list for this attempt: `files` (the
    // render-time closure) is stale once the list itself has just succeeded
    // within this same call, e.g. the list decodes fine but the follow-up
    // status path then throws. Seeded from `files` so a failure that happens
    // before the list ever loads still consults the prior state.
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

    // --- Concurrent dispatch -------------------------------------------------
    // The list and status endpoints return independent data (each has its own
    // keyset), so both requests start together. The list is still consumed and
    // committed first, keeping list_visible progressive; the status outcome is
    // observed at creation (never an unhandled rejection) and consumed after
    // the list commits.
    const stacksPromise = apiFetch('/stacks', { nodeId: fetchNodeId });
    const statusPromise = fetchNodeId === null ? null : (() => {
            const statusSpan = beginSpan('fetch_headers', { attemptId, background });
            return fetchStackStatusesShared(fetchNodeId).then(
              (result) => {
                // Joined waiters mark network spans superseded so truncated
                // join timings are not mistaken for fast fetches.
                endSpan(statusSpan, {
                  outcome: result.coalesced ? 'superseded' : undefined,
                  proxied: result.proxied,
                  detail: { status: result.status, coalesced: result.coalesced },
                });
                return {
                  ok: result.ok,
                  status: result.status,
                  body: result.body,
                  proxied: result.proxied,
                  coalesced: result.coalesced,
                  error: null,
                };
              },
              (statusErr) => {
                endSpan(statusSpan, { outcome: 'error', detail: { coalesced: false } });
                return {
                  ok: false,
                  status: 0,
                  body: null,
                  proxied: false,
                  coalesced: false,
                  error: statusErr instanceof Error ? statusErr : new Error(String(statusErr)),
                };
              },
            );
          })();

    const headersSpan = beginSpan('fetch_headers', { attemptId, background });
    let bodySpan: SpanHandle | null = null;
    // Evidence captured before this refresh, used to restore prior status data
    // (marked stale) when a same-list foreground refresh's status fetch fails.
    const priorEvidence = evidenceRef.current;
    // 0 matches no real node, so an error record can never accidentally
    // authorize one; the null-node path returns before any evidence is written.
    const evidenceNodeId: number = fetchNodeId ?? 0;

    // Shared error path: record error evidence for the current list and drop
    // the status maps so nothing renders as current. Used by the hard-error
    // branch of failHydration and by the catch path.
    const clearStatusMaps = (): void => {
      setStackStatuses({});
      setStackPorts({});
      setStackSelfFlags({});
      setStackCounts({});
    };
    const recordHydrationError = (forFingerprint: string): void => {
      setHydrationEvidenceSync({
        nodeId: evidenceNodeId,
        listFingerprint: forFingerprint,
        outcome: 'error',
        coveredFileCount: 0,
      });
      clearStatusMaps();
    };

    try {
      const res = await stacksPromise;
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
      if (stale()) { abortAttempt(attemptId); return []; }
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
      // Commit-synchronous fingerprint refs: readiness derives from these, so a
      // stale list can never carry an old list's evidence.
      const fingerprint = JSON.stringify([...fileList].sort());
      currentFingerprintRef.current = fingerprint;
      currentFileCountRef.current = fileList.length;
      settleLoading();
      // Token folds node + count so an empty->empty commit still fires once per
      // attempt even when the committed `files` is referentially equal.
      const listToken = `${fetchNodeId}:${fileList.length}`;
      if (!background) {
        listVisiblePendingRef.current = { attemptId, token: listToken, proxied };
      }

      // Skip statuses until activeNode resolves (null here means unresolved, not
      // "local"); never pass an unknown target into the shared fetch. Guarding
      // on statusPromise directly also narrows it for the await below.
      if (statusPromise === null) {
        return fileList;
      }
      // A foreground refresh blanks the evidence until its own status lands, so
      // the new list cannot be authorized by a prior list's statuses. Background
      // refreshes keep prior evidence (no flash) until the new result replaces it.
      if (!background) {
        setHydrationEvidenceSync(null);
      }

      // Classify the status outcome. Coverage counts only successful, valid
      // entries for current-list files; unrelated keys never contribute, so a
      // missing file plus an extra key still blocks readiness.
      const statusOutcome = await statusPromise;
      if (stale()) { abortAttempt(attemptId); return fileList; }
      let bulkStatuses: Record<string, StackRowStatus> = {};
      let bulkPorts: Record<string, number | undefined> = {};
      let bulkSelf: Record<string, boolean> = {};
      let bulkCounts: StackCounts = {};
      let source: HydrationSource = 'bulk';
      let coveredFileCount = 0;
      const statusProxied = statusOutcome.proxied || proxied;

      const failHydration = (reason: string): string[] => {
        console.error(`Failed to refresh stack statuses: ${reason}`);
        if (listSucceeded && !background) {
          markMilestone('list_hydrated', { attemptId, outcome: 'error', proxied });
          // Foreground (user-initiated) failures get one explicit signal; the
          // dashboard's background polls stay silent because they self-heal.
          toast.error('Could not refresh stack statuses. Check the node connection and try again.');
        }
        // Same-list failure restores the attempt-start snapshot (stale) so the
        // operator keeps last-known statuses with an explicit stale marker.
        // The snapshot, not the live ref, is used for both foreground and
        // background: a concurrent foreground refresh blanks the live evidence,
        // so a background failure must not fall through to the hard-error path
        // (and flash an error) while the foreground attempt is still in flight.
        // Changed list or missing prior replaces with a hard error and clears
        // the maps so nothing renders as current.
        if (
          priorEvidence &&
          priorEvidence.nodeId === evidenceNodeId &&
          priorEvidence.listFingerprint === fingerprint &&
          priorEvidence.outcome === 'ok'
        ) {
          setHydrationEvidenceSync({ ...priorEvidence, stale: true });
        } else {
          recordHydrationError(fingerprint);
        }
        return latestFileList;
      };

      if (statusOutcome.error) {
        return failHydration(statusOutcome.error.message);
      }
      if (statusOutcome.ok && isValidBulkPayload(statusOutcome.body)) {
        // Decode already happened inside the shared helper; do not emit a fake
        // body_decode span that would look like near-zero network work.
        const parsed = parseBulkStatusPayload(statusOutcome.body, fileList);
        bulkStatuses = parsed.statuses;
        bulkPorts = parsed.ports;
        bulkSelf = parsed.self;
        bulkCounts = parsed.counts;
        coveredFileCount = parsed.coveredFileCount;
      } else if (
        (statusOutcome.ok && isValidLegacyPayload(statusOutcome.body)) ||
        (!statusOutcome.ok &&
          (statusOutcome.status === 404 || statusOutcome.status === 405 || statusOutcome.status === 501))
      ) {
        // A node returning the legacy plain-string format (partial already
        // collapsed into running) or lacking the bulk endpoint entirely is
        // re-derived from per-stack containers so a crashed container is not
        // hidden behind a healthy sibling.
        source = 'legacy';
        const derived = await deriveStatusesFromContainers(fileList, evidenceNodeId);
        bulkStatuses = derived.statuses;
        coveredFileCount = derived.coveredFileCount;
        if (stale()) { abortAttempt(attemptId); return fileList; }
        // A total fallback failure (proxy down, node unreachable) must not
        // masquerade as "ok with zero coverage": it is a hard error.
        if (coveredFileCount === 0 && fileList.length > 0) {
          return failHydration(`legacy derivation covered 0 of ${fileList.length} stacks`);
        }
      } else if (!statusOutcome.ok) {
        // 400/403/408/409/429/5xx and malformed payloads are errors: they never
        // trigger per-stack fallback requests (which would amplify proxy work).
        return failHydration(`status ${statusOutcome.status}`);
      } else {
        return failHydration('unrecognized status payload');
      }

      const statusDispatch = beginSpan('state_dispatch', {
        attemptId,
        background,
        proxied: statusProxied,
        detail: { coalesced: statusOutcome.coalesced },
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
      endSpan(statusDispatch, { detail: { coalesced: statusOutcome.coalesced } });
      refreshLabels();
      setHydrationEvidenceSync({
        nodeId: evidenceNodeId,
        listFingerprint: fingerprint,
        outcome: 'ok',
        source,
        stale: false,
        coveredFileCount,
      });
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
      // The list committed but hydrating its statuses threw: keep the confirmed
      // list visible with error evidence, rather than erasing it. A list that
      // never loaded takes the existing failure path.
      if (listSucceeded) {
        if (!background) {
          markMilestone('list_hydrated', { attemptId, outcome: 'error', proxied });
        }
        recordHydrationError(currentFingerprintRef.current);
        return latestFileList;
      }
      return applyStacksFailure(message);
    } finally {
      settleLoading();
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

  // Runtime filters (Up/Down) are driven by the same hydration display state
  // that the rows use, so a zero count can never coexist with rows shown under
  // that chip. Pending, error, and incomplete coverage produce no Up/Down
  // matches; stale evidence keeps counts with a stale qualifier. The All chip
  // always matches `files` and Updates uses its own data source. Deriving from
  // `hydrationDisplay` (not from weaker re-derivations of the evidence) keeps
  // node-switch fail-closed on the very first frame.
  const showRuntimeFilters = hydrationDisplay === 'current' || hydrationDisplay === 'stale';
  const filterStaleQualifier = hydrationDisplay === 'stale';

  const runtimeVisibleFiles = showRuntimeFilters ? filteredFiles : [];
  const upFiles = runtimeVisibleFiles.filter(f => stackStatuses[f] === 'running');
  const downFiles = runtimeVisibleFiles.filter(f => isDownStatus(stackStatuses[f]));

  const filterCounts = useMemo(() => ({
    all: filteredFiles.length,
    up: upFiles.length,
    down: downFiles.length,
    updates: filteredFiles.filter(hasConfirmedSidebarUpdate).length,
  }), [filteredFiles, upFiles, downFiles, sidebarStackUpdates]);

  const chipFilteredFiles = useMemo(() => {
    if (filterChip === 'all') return filteredFiles;
    if (filterChip === 'up') return upFiles;
    if (filterChip === 'down') return downFiles;
    if (filterChip === 'updates') return filteredFiles.filter(hasConfirmedSidebarUpdate);
    return filteredFiles;
  }, [filteredFiles, filterChip, upFiles, downFiles, sidebarStackUpdates]);

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
    // Bulk lifecycle mutations need authoritative status evidence just like
    // single-stack actions; without it the batch would run against unknown
    // runtime state.
    if (!hydrationReadyRef.current()) {
      toast.error('Status data unavailable. Refresh and try again.');
      return;
    }
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
    hydrationStatus,
    hydrationDisplay,
    actionsReady,
    hydrationReady: () => hydrationReadyRef.current(),
    filterStaleQualifier,
  } as const;
}
