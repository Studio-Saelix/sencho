import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { useAuth } from '@/context/AuthContext';
import { plural } from '@/lib/blueprintTargets';
import type { ResultRow } from './ResultsList';
import {
  isMatchPreviewResponse,
  isSuggestion,
  type FleetStopLabelSuggestion,
  type FleetStopNodeResult,
  type MatchPreviewNode,
  type PreviewState,
  type ResolvedTarget,
} from './stopByLabel';

/** Wait for the operator to finish typing before resolving the label. */
const PREVIEW_DEBOUNCE_MS = 500;

// What a dry run resolved for one label: the stacks it could resolve, the
// nodes it could not reach, and how many stacks failed to resolve.
interface DryRunSnapshot {
  label: string;
  targets: ResolvedTarget[];
  unreachable: MatchPreviewNode[];
  failed: number;
}

export interface StopOutcome {
  label: string;
  rows: ResultRow[];
  ok: number;
  failed: number;
  /** Nodes in the confirmed targets that could not be reached when the stop ran. */
  unreachable: number;
  /**
   * Nodes the plan left out before the stop ran. They were never sent a target,
   * so the response cannot mention them; the result must still name them or a
   * partial stop reads as a clean success.
   */
  leftOut: MatchPreviewNode[];
  /** Stacks the dry-run plan could not resolve, so the stop never sent them a target. */
  unresolved: number;
  matchedNodes: number;
}

function toRows(apiResults: FleetStopNodeResult[]): ResultRow[] {
  return apiResults.map((node) => {
    if (!node.reachable) {
      return {
        key: `node-${node.nodeId}`,
        label: `${node.nodeName} (unreachable)`,
        success: false,
        error: node.error || 'Node unreachable',
        sub: [],
      };
    }
    const stackResults = Array.isArray(node.stackResults) ? node.stackResults : [];
    return {
      key: `node-${node.nodeId}`,
      label: node.matched
        ? `${node.nodeName} · ${plural(stackResults.length, 'stack')}`
        : `${node.nodeName} (no matching stack label)`,
      success: node.matched && stackResults.every(s => s.success),
      error: node.matched ? undefined : 'Stack label not present',
      sub: stackResults.map((s, i) => ({
        key: `${node.nodeId}-${s.stackName}-${i}`,
        label: s.stackName,
        success: s.success,
        error: s.error,
      })),
    };
  });
}

/** Stack-label stop across the fleet: live match preview, dry-run fallback, and the resolved-target stop. */
export function useStopByLabelFlow(open: boolean) {
  const { can } = useAuth();
  const [labelName, setLabelName] = useState('');
  const [suggestions, setSuggestions] = useState<FleetStopLabelSuggestion[]>([]);
  const [suggestUnreachable, setSuggestUnreachable] = useState(0);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<StopOutcome | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ kind: 'idle' });
  // Snapshot of the most recent dry run's resolved targets, keyed by the label
  // it ran for. Stands in for the live preview when the match-preview endpoint is
  // unavailable, so a successful dry run still unblocks the real stop.
  const [dryRunResolved, setDryRunResolved] = useState<DryRunSnapshot | null>(null);
  const trimmed = labelName.trim();

  // Stack-label suggestions for the target picker. The fleet endpoint queries
  // every node authoritatively (local DB + live remote reads), so node labels
  // can never appear here and remote-only stack labels do. `unreachableNodes`
  // flags that the counts cover only the nodes Sencho could reach. A non-ok or
  // malformed response leaves the list empty rather than crashing: the endpoint
  // needs node:read, so a session without it gets no suggestions and can still
  // type a name.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    async function loadSuggestions() {
      try {
        const res = await apiFetch('/fleet/labels/suggestions');
        const data = res.ok ? await res.json().catch(() => null) : null;
        const list = Array.isArray(data?.suggestions) ? data.suggestions.filter(isSuggestion) : [];
        if (!cancelled) {
          setSuggestions(list);
          setSuggestUnreachable(typeof data?.unreachableNodes === 'number' ? data.unreachableNodes : 0);
        }
      } catch (err) {
        console.error('[FleetStop] suggestions failed', err);
        if (!cancelled) { setSuggestions([]); setSuggestUnreachable(0); }
      }
    }
    loadSuggestions();
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    // `cancelled` guards against an out-of-order response: once the debounce
    // timer fires, the request is in-flight and clearing the timer no longer
    // stops it. If the label changes before it resolves, this effect's cleanup
    // flips `cancelled` so the stale response cannot set `preview` for a label
    // that is no longer current and gate Stop against the wrong blast radius.
    let cancelled = false;
    // Any edit to the label invalidates a prior dry run's snapshot, so editing
    // away and back to the same name cannot re-enable Stop from a stale blast
    // radius. A fresh preview or dry run must resolve the current label again.
    setDryRunResolved(null);
    if (!open || trimmed.length === 0) {
      setPreview({ kind: 'idle' });
      return;
    }
    setPreview({ kind: 'loading' });
    const timer = setTimeout(async () => {
      try {
        const res = await apiFetch('/fleet/labels/match-preview', {
          method: 'POST',
          body: JSON.stringify({ labelName: trimmed }),
        });
        if (cancelled) return;
        if (!res.ok) {
          console.warn(`[FleetStop] match-preview returned ${res.status}`);
          setPreview({ kind: 'unavailable' });
          return;
        }
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!isMatchPreviewResponse(data)) {
          // A 200 with a shape we can't render is a server/contract bug, not a
          // transport miss; log it like the catch path so it's diagnosable.
          console.error('[FleetStop] match-preview returned a malformed body', data);
          setPreview({ kind: 'unavailable' });
          return;
        }
        setPreview({ kind: 'ready', data, label: trimmed });
      } catch (err) {
        if (cancelled) return;
        // Non-destructive preview: the operator can still resolve the targets
        // with a dry run, so we degrade to "unavailable" rather than toasting,
        // but leave a console trail so a recurring failure is diagnosable.
        console.error('[FleetStop] match-preview failed', err);
        setPreview({ kind: 'unavailable' });
      }
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, trimmed]);

  // The resolved blast radius the operator commits to. Sourced from the live
  // preview, or from a dry run of the *current* label when the live preview has
  // not resolved. Null until one resolves, which keeps the destructive Stop
  // disabled until the affected nodes/stacks are known.
  const livePreview = preview.kind === 'ready' && preview.label === trimmed ? preview : null;
  const currentDryRun = dryRunResolved !== null && dryRunResolved.label === trimmed ? dryRunResolved : null;
  const resolvedTargets = useMemo<ResolvedTarget[] | null>(() => {
    if (livePreview) {
      return livePreview.data.perNode
        .filter(n => n.reachable && n.stackNames.length > 0)
        .map(n => ({ nodeId: n.nodeId, nodeName: n.nodeName, stackNames: n.stackNames }));
    }
    return currentDryRun ? currentDryRun.targets : null;
  }, [livePreview, currentDryRun]);

  // The nodes the resolved plan left out, from the same source as the targets.
  const unreachable = useMemo<MatchPreviewNode[]>(() => {
    if (livePreview) return livePreview.data.perNode.filter(n => !n.reachable);
    return currentDryRun ? currentDryRun.unreachable : [];
  }, [livePreview, currentDryRun]);
  const failedToResolve = currentDryRun && preview.kind !== 'ready' ? currentDryRun.failed : 0;

  // Stop is enabled only once the blast radius is resolved to at least one
  // stack the session may stop, and never while a run is in flight.
  const hasTargets = resolvedTargets !== null && resolvedTargets.some(t => t.stackNames.length > 0);
  const permitted = resolvedTargets !== null && resolvedTargets.every(target => target.stackNames.every(stackName =>
    can('stack:deploy', 'stack', stackName, target.nodeId)));
  const canStop = !running && outcome === null && hasTargets && permitted;
  const denied = hasTargets && !permitted;

  async function run(opts: { dryRun: boolean; targets?: { nodeId: number; stackNames: string[] }[] }) {
    if (!trimmed) return;
    if (opts.targets?.some(target => target.stackNames.some(stackName =>
      !can('stack:deploy', 'stack', stackName, target.nodeId)))) return;
    const verb = opts.dryRun ? 'Resolving' : 'Stopping';
    const toastId = toast.loading(`${verb} stacks with the stack label "${trimmed}" across the fleet…`);
    setRunning(true);
    try {
      // The real stop carries the exact node + stack list the plan resolved, so
      // execution cannot expand to a node that has since reconnected nor to a
      // stack that gained the label after the preview. The dry run sends no
      // allowlist and scans the fleet.
      const res = await apiFetch('/fleet/labels/fleet-stop', {
        method: 'POST',
        body: JSON.stringify({ labelName: trimmed, dryRun: opts.dryRun, ...(opts.targets ? { targets: opts.targets } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      toast.dismiss(toastId);
      if (!res.ok) {
        toast.error(body.error || 'Stop stacks failed');
        return;
      }
      // A 200 with a non-array `results` is a server/contract bug, not an empty
      // fleet: don't let it masquerade as the legitimate "No reachable nodes"
      // outcome (a valid empty array below still reports that honestly).
      if (!Array.isArray(body.results)) {
        console.error('[FleetStop] fleet-stop returned a malformed body', body);
        toast.error('Stop stacks returned an unexpected response. Check the server logs and retry.');
        return;
      }
      const apiResults = body.results as FleetStopNodeResult[];
      if (opts.dryRun) setDryRunResolved(snapshotOf(trimmed, apiResults));
      // A real stop only sends targets for the plan's reachable nodes, so the
      // response never mentions the nodes the plan left out. Carry them from the
      // plan into the outcome; a dry run reports through the plan section instead.
      reportStop(
        apiResults, opts.dryRun, trimmed,
        opts.dryRun ? [] : unreachable,
        opts.dryRun ? 0 : failedToResolve,
        setOutcome,
      );
    } catch (err) {
      toast.dismiss(toastId);
      toast.error(err instanceof Error ? err.message : 'Network error');
    } finally {
      setRunning(false);
    }
  }

  // A preview resolved for another label (one render after an edit) reads as loading.
  const shownPreview: PreviewState = preview.kind === 'ready' && preview.label !== trimmed ? { kind: 'loading' } : preview;

  return {
    labelName, setLabelName, trimmed, suggestions, suggestUnreachable, preview: shownPreview, resolvedTargets,
    canStop, denied, unreachable, failedToResolve, running, outcome,
    resolve: () => run({ dryRun: true }),
    stop: () => run({
      dryRun: false,
      targets: (resolvedTargets ?? []).map(t => ({ nodeId: t.nodeId, stackNames: t.stackNames })),
    }),
  };
}

function snapshotOf(label: string, apiResults: FleetStopNodeResult[]): DryRunSnapshot {
  const targets: ResolvedTarget[] = [];
  let failed = 0;
  for (const n of apiResults) {
    if (!n.reachable || !n.matched) continue;
    if (!Array.isArray(n.stackResults)) {
      failed += 1;
      continue;
    }
    // A stack whose dry run errored is not part of the blast radius Stop may run against.
    const resolved = n.stackResults.filter(s => s.success);
    failed += n.stackResults.length - resolved.length;
    if (resolved.length > 0) targets.push({ nodeId: n.nodeId, nodeName: n.nodeName, stackNames: resolved.map(s => s.stackName) });
  }
  const unreachable = apiResults
    .filter(n => !n.reachable)
    .map(n => ({ nodeId: n.nodeId, nodeName: n.nodeName, reachable: false, labelExists: false, stackCount: 0, stackNames: [], error: n.error }));
  return { label, targets, unreachable, failed };
}

function leftOutRows(nodes: MatchPreviewNode[]): ResultRow[] {
  return nodes.map(node => ({
    key: `left-out-${node.nodeId}`,
    label: `${node.nodeName} (unreachable, left out)`,
    success: false,
    error: node.error || 'Node unreachable',
    sub: [],
  }));
}

function reportStop(
  apiResults: FleetStopNodeResult[],
  dryRun: boolean,
  label: string,
  plannedOut: MatchPreviewNode[],
  unresolved: number,
  setOutcome: (outcome: StopOutcome) => void,
): void {
  const reachable = apiResults.filter(n => n.reachable);
  const attemptedUnreachable = apiResults.filter(n => !n.reachable);
  // A node can appear in both lists only if the response names a node the plan
  // already left out (it should not, because left-out nodes are never targets),
  // so dedupe rather than double-count a defensive mismatch.
  const attemptedIds = new Set(apiResults.map(n => n.nodeId));
  const leftOut = plannedOut.filter(n => !attemptedIds.has(n.nodeId));
  const matchedNodes = reachable.filter(n => n.matched).length;
  const stacksTouched = apiResults.flatMap(n => Array.isArray(n.stackResults) ? n.stackResults : []);
  const ok = stacksTouched.filter(s => s.success).length;
  const failed = stacksTouched.length - ok;
  // Everything the plan left out of the stop: unreachable nodes, plus stacks a
  // dry run could not resolve. None of them appear in the response.
  const partialNotes = [
    leftOut.length > 0 && `${plural(leftOut.length, 'node')} unreachable, left out.`,
    attemptedUnreachable.length > 0 && `${plural(attemptedUnreachable.length, 'node')} unreachable.`,
    unresolved > 0 && `${plural(unresolved, 'stack')} could not be resolved.`,
  ].filter(Boolean).join(' ');
  const partialSuffix = partialNotes ? ` ${partialNotes}` : '';
  if (!dryRun) {
    setOutcome({
      label, rows: [...toRows(apiResults), ...leftOutRows(leftOut)], ok, failed,
      unreachable: attemptedUnreachable.length, leftOut, unresolved, matchedNodes,
    });
  }
  if (matchedNodes === 0) {
    if (reachable.length === 0) toast.warning(`No reachable nodes.${partialSuffix}`);
    // A confirmed node can lose the label between preview and stop; its
    // confirmed stacks come back as failures. That is a failed stop, not a
    // benign "no node carries the label" no-op.
    else if (failed > 0) toast.warning(`${ok} stopped, ${failed} failed. See the result.${partialSuffix}`);
    else toast.info(`No reachable node carries a stack label by that name.${partialSuffix}`);
  } else if (dryRun && failed > 0) toast.warning(`Resolved ${plural(ok, 'stack')}; ${failed} could not be resolved.${partialSuffix}`);
  else if (dryRun) toast.success(`Resolved ${plural(ok, 'stack')} across ${plural(matchedNodes, 'node')}.${partialSuffix}`);
  // A stop that could not reach or resolve part of the plan is partial: warn,
  // never a green success, even when every stack it did reach stopped cleanly.
  else if (failed === 0 && ok > 0 && partialNotes) toast.warning(`Stopped ${plural(ok, 'stack')} across ${plural(matchedNodes, 'node')}.${partialSuffix}`);
  else if (failed === 0 && ok > 0) toast.success(`Stopped ${plural(ok, 'stack')} across ${plural(matchedNodes, 'node')}.`);
  else if (ok === 0 && failed === 0) {
    if (partialNotes) toast.warning(`Nothing was stopped.${partialSuffix}`);
    else toast.info('Stack label matched but no stacks were assigned to it.');
  }
  else toast.warning(`${ok} stopped, ${failed} failed. See the result.${partialSuffix}`);
}
