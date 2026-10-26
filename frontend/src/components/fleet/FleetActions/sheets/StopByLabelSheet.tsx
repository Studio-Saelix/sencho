import { Skeleton } from '@/components/ui/skeleton';
import { StatusPath, type StatusPathAnswer } from '@/components/ui/status-path';
import { SheetSection, SystemSheet } from '@/components/ui/system-sheet';
import { useVisualBusy } from '@/hooks/useVisualBusy';
import { plural } from '@/lib/blueprintTargets';
import { cn } from '@/lib/utils';
import { LabelAutocomplete } from '../LabelAutocomplete';
import { ResultsList } from '../ResultsList';
import type { MatchPreviewNode, PreviewState, ResolvedTarget } from '../stopByLabel';
import { useStopByLabelFlow, type StopOutcome } from '../useStopByLabelFlow';

const KICKER = 'font-mono text-[10px] uppercase tracking-[0.18em]';
const EXAMPLE_LIMIT = 3;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function StopByLabelSheet({ open, onOpenChange }: Props) {
  const flow = useStopByLabelFlow(open);
  const { preview, outcome, running } = flow;
  const done = outcome !== null;
  const { showBusy } = useVisualBusy(preview.kind === 'loading');

  return (
    <SystemSheet
      open={open}
      // A run in flight cannot be dismissed: closing would drop its result and let a second stop start.
      onOpenChange={(next) => { if (next || !running) onOpenChange(next); }}
      size="lg"
      crumb={['Fleet', 'Actions', 'Stop']}
      name="Stop stacks by label"
      meta="stack label · per-node fan-out · only the stacks listed below"
      primaryAction={done ? { label: 'Done', onClick: () => onOpenChange(false) } : undefined}
      secondaryActions={!done && preview.kind === 'unavailable'
        ? [{ label: 'Resolve with dry run', onClick: flow.resolve, disabled: running || flow.trimmed.length === 0 }]
        : undefined}
      destructiveAction={done ? undefined : {
        label: 'Stop stacks',
        onClick: flow.stop,
        disabled: !flow.canStop,
        pending: running,
      }}
      footerContext={done ? 'Finished' : 'Services stay down until restarted · Stop runs only the stacks resolved here'}
    >
      <SheetSection title="Stack label" meta={`stack labels · ${flow.suggestions.length}`}>
        <p className="mb-2 text-[11px] text-stat-subtitle">
          Stops every stack assigned this stack label on every reachable node across the fleet. Node labels are not used by this action.
        </p>
        {flow.suggestUnreachable > 0 && (
          <p className="mb-2 text-[11px] text-stat-icon">
            {plural(flow.suggestUnreachable, 'node')} unreachable; suggestions may be incomplete.
          </p>
        )}
        <LabelAutocomplete
          value={flow.labelName}
          onChange={flow.setLabelName}
          suggestions={flow.suggestions}
          disabled={running || done}
          placeholder="e.g. production"
        />
      </SheetSection>

      <SheetSection title={done ? 'Result' : 'Plan'}>
        {outcome
          ? <OutcomePath outcome={outcome} />
          : (
            <PlanPath
              preview={preview}
              targets={flow.resolvedTargets}
              unreachable={flow.unreachable}
              failedToResolve={flow.failedToResolve}
              denied={flow.denied}
              label={flow.trimmed}
              showBusy={showBusy}
            />
          )}
      </SheetSection>
    </SystemSheet>
  );
}

function PlanPath({ preview, targets, unreachable, failedToResolve, denied, label, showBusy }: {
  preview: PreviewState;
  targets: ResolvedTarget[] | null;
  unreachable: MatchPreviewNode[];
  failedToResolve: number;
  denied: boolean;
  label: string;
  showBusy: boolean;
}) {
  if (label.length === 0) {
    return <StatusPath answer={{ tone: 'neutral', title: 'No label yet', line: 'Type or pick a stack label to see what it would stop.' }} stages={[]} />;
  }
  if (preview.kind === 'loading') {
    return showBusy
      ? <div aria-busy="true" className="space-y-2"><Skeleton className="h-14 w-full" /><Skeleton className="h-4 w-28" /></div>
      : <div className="h-[88px]" aria-hidden />;
  }
  const marker = [
    unreachable.length > 0 && `${unreachable.length} unreachable, left out`,
    failedToResolve > 0 && `${failedToResolve} could not be resolved`,
  ].filter(Boolean).join(' · ') || undefined;

  if (targets && targets.some(t => t.stackNames.length > 0)) {
    return (
      <StatusPath
        answer={stopAnswer(targets, marker, denied)}
        stages={[]}
        proof={{ label: 'Stacks per node', children: <TargetsList targets={targets} unreachable={unreachable} /> }}
      />
    );
  }
  if (targets !== null && preview.kind !== 'ready') {
    // A dry run resolved the label to nothing, which is an answer, not a missing preview.
    return (
      <StatusPath
        answer={{ tone: 'neutral', title: 'No stacks match', line: 'The dry run found no stack carrying this label on a reachable node.', marker }}
        stages={[]}
        proof={unreachable.length > 0 ? { label: 'Unreachable nodes', children: <UnreachableList nodes={unreachable} /> } : undefined}
      />
    );
  }
  if (preview.kind === 'ready') {
    const labelExists = preview.data.perNode.some(n => n.reachable && n.labelExists);
    const line = labelExists
      ? 'This stack label exists but has no stacks assigned on the reachable nodes.'
      : 'No reachable node carries a stack label by that name.';
    return (
      <StatusPath
        answer={{ tone: 'neutral', title: 'No stacks match', line, marker }}
        stages={[]}
        proof={unreachable.length > 0 ? { label: 'Unreachable nodes', children: <UnreachableList nodes={unreachable} /> } : undefined}
      />
    );
  }
  return (
    <StatusPath
      answer={{ tone: 'warning', title: 'Preview unavailable', line: 'The match preview did not respond. Resolve with a dry run to see what Stop would do.' }}
      stages={[]}
    />
  );
}

function stopAnswer(targets: ResolvedTarget[], marker: string | undefined, denied: boolean): StatusPathAnswer {
  const names = targets.flatMap(t => t.stackNames);
  const shown = names.slice(0, EXAMPLE_LIMIT).join(', ');
  const rest = names.length - EXAMPLE_LIMIT;
  return {
    tone: 'destructive',
    title: `Stops ${plural(names.length, 'stack')}`,
    line: `on ${plural(targets.length, 'node')} · ${shown}${rest > 0 ? ` +${rest} more` : ''}`,
    marker,
    // Stop is disabled for stacks the session may not stop; say why instead of leaving a dead button.
    detail: denied ? 'You do not have permission to stop every stack listed, so Stop is unavailable.' : undefined,
  };
}

function OutcomePath({ outcome }: { outcome: StopOutcome }) {
  const { ok, failed, unreachable, matchedNodes, label } = outcome;
  let answer: StatusPathAnswer;
  if (ok === 0 && failed === 0 && unreachable > 0) {
    answer = { tone: 'warning', title: 'Nothing was stopped', line: `${plural(unreachable, 'node')} unreachable, so the stacks there were not stopped.` };
  } else if (ok === 0 && failed === 0) {
    answer = { tone: 'neutral', title: 'Nothing was stopped', line: `No stack carried “${label}” on a reachable node.` };
  } else if (failed === 0 && unreachable === 0) {
    answer = { tone: 'success', title: `Stopped ${plural(ok, 'stack')}`, line: `on ${plural(matchedNodes, 'node')}` };
  } else {
    const extra = unreachable > 0 ? ` · ${plural(unreachable, 'node')} unreachable` : '';
    answer = { tone: 'warning', title: `${ok} stopped, ${failed} failed`, line: `on ${plural(matchedNodes, 'node')}${extra}` };
  }
  return (
    <StatusPath answer={answer} stages={[]} proof={{ label: 'Per-node outcome', children: <ResultsList results={outcome.rows} /> }} />
  );
}

// The resolved node/stack list the Stop runs against. Both axes are bound to it:
// the stop sends these node ids and the exact stacks per node, and the backend
// stops only stacks that are still label-matched AND in this set, so drift
// between preview and commit cannot widen the blast radius.
function TargetsList({ targets, unreachable }: { targets: ResolvedTarget[]; unreachable: MatchPreviewNode[] }) {
  return (
    <div className="space-y-2">
      <div className="rounded border border-card-border/60 bg-card/40 p-2">
        <ul className="space-y-1.5">
          {targets.map(t => (
            <li key={t.nodeId} className="flex items-start gap-2">
              <span className={cn(KICKER, 'shrink-0 pt-0.5 text-stat-subtitle')}>{t.nodeName}</span>
              <span className="min-w-0 flex-1 break-words font-mono text-[11px] text-stat-value">{t.stackNames.join(', ')}</span>
            </li>
          ))}
        </ul>
      </div>
      {unreachable.length > 0 && <UnreachableList nodes={unreachable} />}
    </div>
  );
}

// Muted list of nodes Sencho could not query, so a partial blast radius is
// observable rather than silently dropped.
function UnreachableList({ nodes }: { nodes: MatchPreviewNode[] }) {
  return (
    <div className="rounded border border-card-border/60 bg-card/40 p-2">
      <div className={cn(KICKER, 'mb-1 text-stat-icon')}>unreachable · {nodes.length}</div>
      <ul className="space-y-1">
        {nodes.map(n => (
          <li key={n.nodeId} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-stat-subtitle">{n.nodeName}</span>
            {n.error && <span className={cn(KICKER, 'max-w-[55%] shrink-0 truncate text-stat-icon')}>{n.error}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
