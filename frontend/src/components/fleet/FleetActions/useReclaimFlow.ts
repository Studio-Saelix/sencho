import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { formatBytes } from '@/lib/utils';
import type { FleetNode } from '@/components/FleetView/types';
import type { FleetPruneNodeResult, FleetPruneTarget, PruneScope } from '@/lib/prunePlan';
import { executeResultsAreValid, reviewStateIsValid, type ReviewedPlanState } from './pruneReview';
import { outcomeSummary, summarizePlan } from './pruneAnswer';

/** Wait for the operator to finish ticking options before building a plan. */
const PLAN_DEBOUNCE_MS = 300;

export type ReclaimPhase =
  | { kind: 'idle' }
  | { kind: 'building' }
  | { kind: 'ready'; review: ReviewedPlanState }
  | { kind: 'failed'; message: string }
  | { kind: 'done'; plan: FleetPruneNodeResult[]; results: FleetPruneNodeResult[] };

interface PlanResponse {
  error?: string;
  code?: string;
  nodeId?: number;
  results?: FleetPruneNodeResult[];
}

interface Options {
  open: boolean;
  nodes: FleetNode[];
  /** Called after items were removed so the Actions list can refresh its estimate. */
  onPruned: () => void;
}

const STALE_COPY = 'after it was built. Review the new plan.';

/**
 * The Reclaim flow: the plan builds itself whenever the sheet is open and an
 * option or the node roster changes, and Prune runs exactly the plan on screen.
 */
export function useReclaimFlow({ open, nodes, onPruned }: Options) {
  const [targets, setTargets] = useState<Set<FleetPruneTarget>>(new Set(['images']));
  const [scope, setScope] = useState<PruneScope>('managed');
  const [phase, setPhase] = useState<ReclaimPhase>({ kind: 'building' });
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);

  // Read through refs so the plan effect does not re-run on every fleet poll
  // (the nodes array is a fresh reference each time) and ignores a roster tick
  // while Prune is executing or has finished.
  const nodesRef = useRef(nodes);
  useEffect(() => { nodesRef.current = nodes; });
  const settledRef = useRef(false);
  const runningRef = useRef(false);
  useEffect(() => { settledRef.current = phase.kind === 'done'; }, [phase.kind]);

  const selectedTargets = useMemo(() => [...targets].sort(), [targets]);
  const rosterKey = useMemo(
    () => nodes.map((node) => `${node.id}:${node.status}`).sort().join(','),
    [nodes],
  );
  const reviewKey = `${selectedTargets.join(',')}|${scope}|${rosterKey}`;

  useEffect(() => {
    if (!open || settledRef.current || runningRef.current) return;
    if (selectedTargets.length === 0) {
      setPhase({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setPhase({ kind: 'building' });
    const timer = setTimeout(async () => {
      try {
        const response = await apiFetch('/fleet/labels/fleet-prune', {
          method: 'POST',
          body: JSON.stringify({ targets: selectedTargets, scope, dryRun: true }),
        });
        const data = await response.json().catch(() => null) as PlanResponse | null;
        if (cancelled) return;
        if (!response.ok) throw new Error(data?.error || 'Failed to build fleet prune plans');
        const results = Array.isArray(data?.results) ? data.results : [];
        const review = { key: reviewKey, results };
        if (reviewStateIsValid(review, reviewKey, nodesRef.current, selectedTargets)) {
          setPhase({ kind: 'ready', review });
        } else {
          setPhase({ kind: 'failed', message: 'The plan did not cover every reachable node. Rebuild to try again.' });
        }
      } catch (error) {
        console.error('Failed to build fleet prune plans', error);
        if (!cancelled) {
          setPhase({ kind: 'failed', message: error instanceof Error ? error.message : 'Failed to build fleet prune plans' });
        }
      }
    }, PLAN_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, selectedTargets, scope, reviewKey, epoch]);

  const toggleTarget = (target: FleetPruneTarget) => {
    setNotice(null);
    setTargets((current) => {
      const next = new Set(current);
      if (next.has(target)) next.delete(target);
      else next.add(target);
      return next;
    });
  };

  const changeScope = (next: PruneScope) => {
    setNotice(null);
    setScope(next);
  };

  const rebuild = useCallback(() => {
    settledRef.current = false;
    setEpoch((value) => value + 1);
  }, []);

  const review = phase.kind === 'ready' && reviewStateIsValid(phase.review, reviewKey, nodes, selectedTargets)
    ? phase.review
    : null;
  const canPrune = !running && review !== null && summarizePlan(review.results).items > 0;

  const execute = async () => {
    if (!review || !canPrune) return;
    const toastId = toast.loading(`Pruning ${selectedTargets.join(', ')} across the fleet…`);
    runningRef.current = true;
    setRunning(true);
    let finished = false;
    try {
      const response = await apiFetch('/fleet/labels/fleet-prune', {
        method: 'POST',
        body: JSON.stringify({
          targets: selectedTargets,
          scope,
          dryRun: false,
          reviewedNodes: review.results.map((result) => ({ nodeId: result.nodeId, reachable: result.reachable })),
          plans: review.results
            .filter((result) => result.reachable && result.fingerprint)
            .map((result) => ({ nodeId: result.nodeId, fingerprint: result.fingerprint as string })),
        }),
      });
      const data = await response.json().catch(() => null) as PlanResponse | null;
      if (!response.ok) {
        if (data?.code === 'PRUNE_PLAN_STALE') {
          const nodeName = review.results.find((result) => result.nodeId === data.nodeId)?.nodeName
            ?? data.error?.match(/on (.+) after/)?.[1]
            ?? 'a node';
          toast.error(`The prune plan changed on “${nodeName}” ${STALE_COPY}`);
          setNotice(`The plan changed on “${nodeName}” ${STALE_COPY}`);
          return;
        }
        throw new Error(data?.error || 'Fleet prune failed');
      }
      if (!executeResultsAreValid(data?.results, review.results, selectedTargets)) {
        throw new Error('Fleet prune returned an incomplete node result set');
      }
      finished = true;
      setPhase({ kind: 'done', plan: review.results, results: data.results });
      reportOutcome(data.results);
      if (outcomeSummary(data.results).removedAny) onPruned();
    } catch (error) {
      console.error('Fleet prune failed', error);
      toast.error(error instanceof Error ? error.message : 'Fleet prune failed');
    } finally {
      toast.dismiss(toastId);
      runningRef.current = false;
      setRunning(false);
      // A refused or failed run leaves no authorization behind: build a fresh plan.
      if (!finished) rebuild();
    }
  };

  return { targets, selectedTargets, scope, phase, review, running, notice, canPrune, toggleTarget, changeScope, rebuild, execute };
}

function reportOutcome(results: FleetPruneNodeResult[]): void {
  const { stale, removedAny, failedAny, reclaimed } = outcomeSummary(results);
  if (stale && removedAny) {
    toast.warning(`Fleet prune partially completed: ${formatBytes(reclaimed)} reclaimed before the plan changed on “${stale.nodeName}”. Review the new plan.`);
  } else if (stale) {
    toast.error(`The prune plan changed on “${stale.nodeName}” ${STALE_COPY}`);
  } else if (failedAny) {
    toast.warning(`Fleet prune completed with item failures. ${formatBytes(reclaimed)} reclaimed.`);
  } else {
    toast.success(`Reclaimed ${formatBytes(reclaimed)} across ${results.length} node${results.length === 1 ? '' : 's'}.`);
  }
}
