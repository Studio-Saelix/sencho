import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPath, type StatusPathAnswer } from '@/components/ui/status-path';
import { SheetSection, SystemSheet } from '@/components/ui/system-sheet';
import { useVisualBusy } from '@/hooks/useVisualBusy';
import type { FleetNode } from '@/components/FleetView/types';
import type { FleetPruneNodeResult, FleetPruneTarget, PruneScope } from '@/lib/prunePlan';
import { PrunePlanResults } from '../PrunePlanResults';
import { outcomeSummary, planAnswer, summarizePlan } from '../pruneAnswer';
import { useReclaimFlow } from '../useReclaimFlow';

const ALL_TARGETS: ReadonlyArray<{ id: FleetPruneTarget; label: string }> = [
  { id: 'images', label: 'Images' },
  { id: 'volumes', label: 'Volumes' },
  { id: 'networks', label: 'Networks' },
];

const SCOPE_OPTIONS = [
  { value: 'managed' as const, label: 'Managed only' },
  { value: 'all' as const, label: 'All unused' },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodes: FleetNode[];
  onPruned: () => void;
}

export function ReclaimSheet({ open, onOpenChange, nodes, onPruned }: Props) {
  const flow = useReclaimFlow({ open, nodes, onPruned });
  const { phase, scope, running } = flow;
  const done = phase.kind === 'done';
  const locked = running || done;
  const { showBusy } = useVisualBusy(phase.kind === 'building');

  return (
    <SystemSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      crumb={['Fleet', 'Actions', 'Reclaim']}
      name="Reclaim disk space"
      meta="images · volumes · networks · every reachable node"
      primaryAction={done ? { label: 'Done', onClick: () => onOpenChange(false) } : undefined}
      secondaryActions={done ? undefined : [{
        label: 'Rebuild',
        icon: RefreshCw,
        onClick: flow.rebuild,
        pending: phase.kind === 'building',
        disabled: running || flow.targets.size === 0,
      }]}
      destructiveAction={done ? undefined : {
        label: scope === 'all' ? 'Prune all' : 'Prune',
        onClick: flow.execute,
        disabled: !flow.canPrune,
        pending: running,
      }}
      footerContext={done ? 'Finished' : 'Not reversible · Prune runs exactly the plan shown'}
    >
      <SheetSection title="What" meta={`${flow.targets.size} of ${ALL_TARGETS.length}`}>
        <div className="flex flex-wrap gap-3">
          {ALL_TARGETS.map((target) => (
            <label key={target.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-glass-highlight">
              <Checkbox checked={flow.targets.has(target.id)} onCheckedChange={() => flow.toggleTarget(target.id)} disabled={locked} />
              <span className="text-xs text-stat-value">{target.label}</span>
            </label>
          ))}
        </div>
      </SheetSection>

      <SheetSection title="Which" meta={scope === 'managed' ? 'sencho-owned only' : 'all unused'}>
        <SegmentedControl<PruneScope> value={scope} options={SCOPE_OPTIONS} onChange={flow.changeScope} ariaLabel="Prune scope" disabled={locked} />
        <p className="mt-2 text-[11px] text-stat-subtitle">
          {scope === 'managed'
            ? 'Restricts candidates to resources owned by stacks Sencho manages.'
            : 'Includes unused resources from workloads Sencho does not manage.'}
        </p>
      </SheetSection>

      <SheetSection title={done ? 'Result' : 'Plan'}>
        {phase.kind === 'building' && (showBusy ? <PlanSkeleton /> : <div className="h-[88px]" aria-hidden />)}
        {phase.kind === 'idle' && <p className="text-xs text-stat-subtitle">Pick at least one target to build a plan.</p>}
        {phase.kind === 'failed' && (
          <StatusPath answer={{ tone: 'destructive', title: 'Plan unavailable', line: phase.message }} stages={[]} />
        )}
        {phase.kind === 'ready' && flow.review && (
          <StatusPath
            answer={planAnswer(summarizePlan(flow.review.results), flow.notice)}
            stages={[]}
            proof={{ label: 'Per-node plan', children: <PrunePlanResults planResults={flow.review.results} /> }}
          />
        )}
        {phase.kind === 'done' && (
          <OutcomePath plan={phase.plan} results={phase.results} onReview={flow.rebuild} />
        )}
      </SheetSection>
    </SystemSheet>
  );
}

function PlanSkeleton() {
  return (
    <div aria-busy="true" className="space-y-2">
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-4 w-28" />
    </div>
  );
}

function OutcomePath({ plan, results, onReview }: {
  plan: FleetPruneNodeResult[];
  results: FleetPruneNodeResult[];
  onReview: () => void;
}) {
  const summary = outcomeSummary(results);
  const answer: StatusPathAnswer = {
    ...summary.answer,
    action: summary.stale
      ? <Button variant="outline" size="sm" onClick={onReview}>Review new plan</Button>
      : undefined,
  };
  return (
    <StatusPath
      answer={answer}
      stages={[]}
      proof={{ label: 'Per-node outcome', children: <PrunePlanResults planResults={plan} executeResults={results} /> }}
    />
  );
}
