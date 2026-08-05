import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmModal } from '@/components/ui/modal';
import { FleetActionCard } from '@/components/ui/fleet-action-card';
import { SheetSection } from '@/components/ui/system-sheet';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { cn, formatBytes } from '@/lib/utils';
import type { FleetNode } from '@/components/FleetView/types';
import type {
  FleetPruneNodeResult,
  FleetPruneTarget,
  PruneScope,
} from '@/lib/prunePlan';
import { isPruneItemOutcome, isPrunePlanItem } from '@/lib/prunePlan';
import { PrunePlanResults } from '../PrunePlanResults';

const ALL_TARGETS: ReadonlyArray<{ id: FleetPruneTarget; label: string }> = [
  { id: 'images', label: 'Images' },
  { id: 'volumes', label: 'Volumes' },
  { id: 'networks', label: 'Networks' },
];

interface PruneEstimateNode {
  nodeId: number;
  nodeName: string;
  reclaimableBytes: number;
  reachable: boolean;
  error?: string;
  partial?: boolean;
}

interface PruneEstimateResponse {
  totalBytes: number;
  perNode: PruneEstimateNode[];
}

type EstimateState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; data: PruneEstimateResponse };

interface ReviewedPlanState {
  key: string;
  results: FleetPruneNodeResult[];
}

interface Props {
  nodes: FleetNode[];
}

const KICKER = 'font-mono text-[10px] uppercase tracking-[0.18em]';
const ESTIMATE_ROW_LIMIT = 6;

function reviewStateIsValid(
  reviewed: ReviewedPlanState | null,
  reviewKey: string,
  nodes: FleetNode[],
  selectedTargets: FleetPruneTarget[],
): reviewed is ReviewedPlanState {
  if (!reviewed || reviewed.key !== reviewKey || reviewed.results.length !== nodes.length) return false;
  const currentIds = new Set(nodes.map((node) => node.id));
  const resultIds = new Set(reviewed.results.map((result) => result.nodeId));
  return resultIds.size === reviewed.results.length
    && reviewed.results.every((result) => currentIds.has(result.nodeId)
    && (result.reachable
      ? typeof result.fingerprint === 'string' && result.fingerprint.length > 0
        && Array.isArray(result.items) && result.items.every((item) => isPrunePlanItem(item) && selectedTargets.includes(item.target as FleetPruneTarget))
      : !result.fingerprint));
}

function executeResultsAreValid(
  value: unknown,
  reviewedResults: FleetPruneNodeResult[],
  selectedTargets: FleetPruneTarget[],
): value is FleetPruneNodeResult[] {
  if (!Array.isArray(value)) return false;
  const expectedIds = reviewedResults.filter((result) => result.reachable).map((result) => result.nodeId);
  if (value.length !== expectedIds.length) return false;
  const seen = new Set<number>();
  return value.every((result) => {
    if (!result || typeof result !== 'object') return false;
    const entry = result as Partial<FleetPruneNodeResult>;
    if (!Number.isInteger(entry.nodeId) || seen.has(entry.nodeId as number)) return false;
    seen.add(entry.nodeId as number);
    if (!expectedIds.includes(entry.nodeId as number)) return false;
    if (typeof entry.nodeName !== 'string' || typeof entry.reachable !== 'boolean' || !Array.isArray(entry.targets)) return false;
    const targetIds = new Set<FleetPruneTarget>();
    for (const target of entry.targets) {
      if (!target || typeof target !== 'object') return false;
      const row = target as Partial<FleetPruneNodeResult['targets'][number]>;
      if (!selectedTargets.includes(row.target as FleetPruneTarget) || targetIds.has(row.target as FleetPruneTarget)
        || typeof row.success !== 'boolean' || row.dryRun !== false
        || typeof row.reclaimedBytes !== 'number' || !Number.isFinite(row.reclaimedBytes) || row.reclaimedBytes < 0) return false;
      for (const count of [row.removed, row.skipped, row.failed]) {
        if (count !== undefined && (!Number.isInteger(count) || count < 0)) return false;
      }
      targetIds.add(row.target as FleetPruneTarget);
    }
    if (targetIds.size !== selectedTargets.length) return false;
    if (entry.reclaimedBytes !== undefined
      && (typeof entry.reclaimedBytes !== 'number' || !Number.isFinite(entry.reclaimedBytes) || entry.reclaimedBytes < 0)) return false;
    if (entry.outcomes !== undefined) {
      if (!Array.isArray(entry.outcomes) || !entry.outcomes.every(isPruneItemOutcome)) return false;
      const reviewed = reviewedResults.find((result) => result.nodeId === entry.nodeId);
      const expectedItems = new Set((reviewed?.items ?? []).map((item) => `${item.target}\0${item.id}`));
      const outcomeKeys = new Set(entry.outcomes.map((outcome) => `${outcome.target}\0${outcome.id}`));
      if (outcomeKeys.size !== entry.outcomes.length || outcomeKeys.size !== expectedItems.size
        || [...outcomeKeys].some((key) => !expectedItems.has(key))) return false;
    }
    return true;
  });
}

export function FleetPruneCard({ nodes }: Props) {
  const [targets, setTargets] = useState<Set<FleetPruneTarget>>(new Set(['images']));
  const [scope, setScope] = useState<PruneScope>('managed');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [planResults, setPlanResults] = useState<FleetPruneNodeResult[]>([]);
  const [displayKey, setDisplayKey] = useState('');
  const [executeResults, setExecuteResults] = useState<FleetPruneNodeResult[] | undefined>();
  const [reviewed, setReviewed] = useState<ReviewedPlanState | null>(null);
  const [estimate, setEstimate] = useState<EstimateState>({ kind: 'loading' });
  const [estimateEpoch, setEstimateEpoch] = useState(0);

  const selectedTargets = useMemo(() => [...targets].sort(), [targets]);
  const rosterKey = useMemo(
    () => nodes.map((node) => `${node.id}:${node.status}`).sort().join(','),
    [nodes],
  );
  const reviewKey = `${selectedTargets.join(',')}|${scope}|${rosterKey}`;
  const reviewValid = reviewStateIsValid(reviewed, reviewKey, nodes, selectedTargets);

  const toggleTarget = (target: FleetPruneTarget) => {
    setReviewed(null);
    setExecuteResults(undefined);
    setEstimate({ kind: 'loading' });
    setTargets((current) => {
      const next = new Set(current);
      if (next.has(target)) next.delete(target);
      else next.add(target);
      return next;
    });
  };

  const changeScope = (nextScope: PruneScope) => {
    setReviewed(null);
    setExecuteResults(undefined);
    setEstimate({ kind: 'loading' });
    setScope(nextScope);
  };

  const estimateDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (estimateDebounceRef.current) clearTimeout(estimateDebounceRef.current);
    if (targets.size === 0) {
      return;
    }
    let cancelled = false;
    estimateDebounceRef.current = setTimeout(async () => {
      if (!cancelled) setEstimate({ kind: 'loading' });
      try {
        const response = await apiFetch('/fleet/prune/estimate', {
          method: 'POST',
          body: JSON.stringify({ targets: selectedTargets, scope }),
        });
        if (cancelled) return;
        if (!response.ok) {
          setEstimate({ kind: 'unavailable' });
          return;
        }
        const data = await response.json() as PruneEstimateResponse;
        if (!cancelled) setEstimate({ kind: 'ready', data });
      } catch (error) {
        console.error('Failed to estimate fleet prune', error);
        if (!cancelled) setEstimate({ kind: 'unavailable' });
      }
    }, 350);
    return () => {
      cancelled = true;
      if (estimateDebounceRef.current) clearTimeout(estimateDebounceRef.current);
    };
  }, [selectedTargets, scope, targets.size, estimateEpoch]);

  const runDryRun = async () => {
    if (selectedTargets.length === 0) return;
    const toastId = toast.loading(`Building prune plans for ${selectedTargets.join(', ')}…`);
    setRunning(true);
    setReviewed(null);
    setExecuteResults(undefined);
    try {
      const response = await apiFetch('/fleet/labels/fleet-prune', {
        method: 'POST',
        body: JSON.stringify({ targets: selectedTargets, scope, dryRun: true }),
      });
      const data = await response.json().catch(() => null) as { error?: string; results?: FleetPruneNodeResult[] } | null;
      if (!response.ok) throw new Error(data?.error || 'Failed to build fleet prune plans');
      const results = Array.isArray(data?.results) ? data.results : [];
      setPlanResults(results);
      setDisplayKey(reviewKey);
      const nextReview = { key: reviewKey, results };
      if (reviewStateIsValid(nextReview, reviewKey, nodes, selectedTargets)) {
        setReviewed(nextReview);
        const total = results.reduce((sum, result) => sum + (result.reclaimableBytes ?? 0), 0);
        toast.success(`Dry run ready: ${formatBytes(total)} across ${results.length} node${results.length === 1 ? '' : 's'}.`);
      } else {
        toast.error('Dry run did not return a valid plan for every reachable node.');
      }
    } catch (error) {
      console.error('Failed to build fleet prune plans', error);
      toast.error(error instanceof Error ? error.message : 'Failed to build fleet prune plans');
    } finally {
      toast.dismiss(toastId);
      setRunning(false);
    }
  };

  const runExecute = async () => {
    if (!reviewValid) return;
    const reviewedSnapshot = reviewed;
    const toastId = toast.loading(`Pruning ${selectedTargets.join(', ')} across the fleet…`);
    setRunning(true);
    setExecuteResults(undefined);
    try {
      const reviewedNodes = reviewedSnapshot.results.map((result) => ({
        nodeId: result.nodeId,
        reachable: result.reachable,
      }));
      const plans = reviewedSnapshot.results
        .filter((result) => result.reachable && result.fingerprint)
        .map((result) => ({ nodeId: result.nodeId, fingerprint: result.fingerprint as string }));
      const response = await apiFetch('/fleet/labels/fleet-prune', {
        method: 'POST',
        body: JSON.stringify({ targets: selectedTargets, scope, dryRun: false, reviewedNodes, plans }),
      });
      const data = await response.json().catch(() => null) as {
        error?: string;
        code?: string;
        nodeId?: number;
        results?: FleetPruneNodeResult[];
      } | null;
      if (!response.ok) {
        if (data?.code === 'PRUNE_PLAN_STALE') {
          setPlanResults([]);
          setDisplayKey('');
          const nodeName = reviewedSnapshot.results.find((result) => result.nodeId === data.nodeId)?.nodeName
            ?? data.error?.match(/on (.+) after/)?.[1]
            ?? 'a node';
          toast.error(`The prune plan changed on “${nodeName}” after the dry run. Run the dry run again before pruning.`);
          return;
        }
        throw new Error(data?.error || 'Fleet prune failed');
      }
      if (!executeResultsAreValid(data?.results, reviewedSnapshot.results, selectedTargets)) {
        throw new Error('Fleet prune returned an incomplete node result set');
      }
      const results = data.results;
      setExecuteResults(results);
      const reclaimed = results.reduce((sum, result) => sum + (result.reclaimedBytes ?? 0), 0);
      const staleResult = results.find((result) => result.code === 'PRUNE_PLAN_STALE');
      const removedAny = results.some((result) => result.outcomes?.some((outcome) => outcome.status === 'removed'));
      const failed = results.some((result) => result.targets.some((target) => !target.success));
      if (staleResult && removedAny) {
        toast.warning(`Fleet prune partially completed: ${formatBytes(reclaimed)} reclaimed before the plan changed on “${staleResult.nodeName}”. Run the dry run again before pruning.`);
      } else if (staleResult) {
        toast.error(`The prune plan changed on “${staleResult.nodeName}” after the dry run. Run the dry run again before pruning.`);
      } else if (failed) toast.warning(`Fleet prune completed with item failures. ${formatBytes(reclaimed)} reclaimed.`);
      else toast.success(`Reclaimed ${formatBytes(reclaimed)} across ${results.length} node${results.length === 1 ? '' : 's'}.`);
      if (removedAny) {
        setEstimateEpoch((epoch) => epoch + 1);
      }
    } catch (error) {
      console.error('Fleet prune failed', error);
      toast.error(error instanceof Error ? error.message : 'Fleet prune failed');
    } finally {
      setReviewed(null);
      toast.dismiss(toastId);
      setRunning(false);
      setConfirmOpen(false);
    }
  };

  const blastValue = useMemo(() => {
    if (targets.size === 0) return 'awaiting target';
    if (estimate.kind === 'loading') return '~ estimating…';
    if (estimate.kind === 'unavailable') return '~ estimate unavailable';
    if (estimate.kind === 'ready') {
      const partial = estimate.data.perNode.some((node) => node.partial);
      const suffix = partial ? ' · partial' : '';
      if (estimate.data.totalBytes === 0) return `0 reclaimable${suffix}`;
      return `~ ${formatBytes(estimate.data.totalBytes)} reclaimable${suffix}`;
    }
    return 'awaiting target';
  }, [targets.size, estimate]);

  const blastTone = estimate.kind === 'loading' || estimate.kind === 'unavailable' ? 'muted' as const : undefined;
  const isAllScope = scope === 'all';

  return (
    <>
      <FleetActionCard
        crumb={['Fleet', 'Actions', 'Prune resources']}
        name="Prune fleet-wide."
        meta="images · volumes · networks · reviewed per node"
        actionClass="maintenance"
        blastRadius={{ value: blastValue, tone: blastTone }}
        secondaryAction={{
          label: running ? 'Running…' : 'Dry run',
          onClick: runDryRun,
          disabled: running || targets.size === 0,
        }}
        primaryAction={{
          label: 'Prune fleet',
          onClick: () => setConfirmOpen(true),
          variant: 'destructive',
          disabled: running || !reviewValid,
        }}
        footerContext={
          targets.size > 0 && !reviewValid
            ? `Reversible · no · reviewed across ${nodes.length} node${nodes.length === 1 ? '' : 's'} · Run Dry run to unlock Prune fleet`
            : `Reversible · no · reviewed across ${nodes.length} node${nodes.length === 1 ? '' : 's'}`
        }
      >
        <SheetSection title={`Targets · ${targets.size} / ${ALL_TARGETS.length}`} meta={targets.size === 0 ? 'pick at least one' : undefined}>
          <div className="flex flex-wrap gap-3">
            {ALL_TARGETS.map((target) => (
              <label key={target.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-glass-highlight">
                <Checkbox checked={targets.has(target.id)} onCheckedChange={() => toggleTarget(target.id)} disabled={running} />
                <span className="text-xs text-stat-value">{target.label}</span>
              </label>
            ))}
          </div>
        </SheetSection>

        <SheetSection title="Scope" meta={scope === 'managed' ? 'sencho-owned only' : 'all unused'}>
          <div className="inline-flex overflow-hidden rounded-md border border-card-border/60">
            <Button type="button" variant={scope === 'managed' ? 'default' : 'outline'} size="sm" disabled={running} onClick={() => changeScope('managed')} className="h-8 rounded-none border-0 px-3 text-xs">
              Managed only
            </Button>
            <Button type="button" variant={scope === 'all' ? 'default' : 'outline'} size="sm" disabled={running} onClick={() => changeScope('all')} className="h-8 rounded-none border-0 px-3 text-xs">
              All unused
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-stat-subtitle">
            {scope === 'managed'
              ? 'Restricts candidates to resources owned by stacks Sencho manages.'
              : 'Includes unused resources from workloads Sencho does not manage.'}
          </p>
        </SheetSection>

        {targets.size > 0 && <EstimateSection estimate={estimate} />}

        {displayKey === reviewKey && planResults.length > 0 && (
          <SheetSection title={executeResults ? 'Prune outcomes' : 'Reviewed prune plan'}>
            <PrunePlanResults planResults={planResults} executeResults={executeResults} />
          </SheetSection>
        )}
      </FleetActionCard>

      <ConfirmModal
        open={confirmOpen}
        onOpenChange={(open) => { if (!open) setConfirmOpen(false); }}
        variant="destructive"
        kicker="Fleet prune"
        title={isAllScope ? 'Prune ALL unused resources across the fleet?' : 'Prune managed resources across the fleet?'}
        description={isAllScope
          ? 'This removes the reviewed unused images, volumes, and networks, including resources from workloads Sencho does not manage. This cannot be undone.'
          : 'Sencho will remove only the reviewed unused resources owned by stacks known to this fleet. Active resources are not touched.'}
        confirmLabel={isAllScope ? 'Prune everything unused' : 'Prune managed'}
        confirming={running}
        onConfirm={runExecute}
      />
    </>
  );
}

function EstimateSection({ estimate }: { estimate: EstimateState }) {
  if (estimate.kind === 'idle' || estimate.kind === 'loading') {
    return (
      <SheetSection title="Estimate · per node" meta={estimate.kind === 'loading' ? 'computing…' : undefined}>
        <div className={cn(KICKER, 'text-stat-icon')}>walking each node's docker daemon</div>
      </SheetSection>
    );
  }
  if (estimate.kind === 'unavailable') {
    return (
      <SheetSection title="Estimate · per node" meta="unavailable">
        <div className={cn(KICKER, 'text-stat-icon')}>estimate endpoint did not respond</div>
      </SheetSection>
    );
  }
  const visible = estimate.data.perNode.slice(0, ESTIMATE_ROW_LIMIT);
  const remaining = estimate.data.perNode.length - visible.length;
  return (
    <SheetSection title="Estimate · per node" meta={`${estimate.data.perNode.length} node${estimate.data.perNode.length === 1 ? '' : 's'}`}>
      <div className="rounded border border-card-border/60 bg-card/40 p-2 shadow-[inset_0_2px_4px_0_oklch(0_0_0_/_0.35)]">
        <ul className="space-y-1">
          {visible.map((node) => (
            <li
              key={node.nodeId}
              className="flex items-center gap-2"
              title={node.error}
            >
              <span className={cn(
                KICKER,
                'inline-flex shrink-0 items-center rounded-sm border px-1 py-0.5',
                node.reachable
                  ? (node.partial
                    ? 'border-warning/40 bg-warning/10 text-warning'
                    : 'border-success/40 bg-success/10 text-success')
                  : 'border-stat-subtitle/40 bg-card text-stat-subtitle',
              )}>
                {node.reachable ? (node.partial ? 'PART' : 'OK') : '--'}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-stat-value">{node.nodeName}</span>
              <span className={cn(KICKER, 'shrink-0 tabular-nums', node.reachable ? 'text-stat-subtitle' : 'text-stat-icon')}>
                {node.reachable ? formatBytes(node.reclaimableBytes) : (node.error ?? 'unreachable')}
              </span>
            </li>
          ))}
          {remaining > 0 && <li className={cn(KICKER, 'pt-1 text-stat-icon')}>+ {remaining} more node{remaining === 1 ? '' : 's'}</li>}
        </ul>
      </div>
    </SheetSection>
  );
}
