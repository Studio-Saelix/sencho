import { RefreshCw } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { StatusPath, type StatusPathAnswer } from '@/components/ui/status-path';
import { SheetSection, SystemSheet } from '@/components/ui/system-sheet';
import { LabelPill } from '@/components/LabelPill';
import { plural } from '@/lib/blueprintTargets';
import { cn } from '@/lib/utils';
import type { FleetNode } from '@/components/FleetView/types';
import type { Label } from '@/components/label-types';
import { ResultsList } from '../ResultsList';
import { useLabelStacksFlow, type AssignOutcome, type PreviewNode } from '../useLabelStacksFlow';

const KICKER = 'font-mono text-[10px] uppercase tracking-[0.18em]';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodes: FleetNode[];
}

export function LabelStacksSheet({ open, onOpenChange, nodes }: Props) {
  const flow = useLabelStacksFlow({ open, nodes });
  const { selectedTemplate, totalSelected, running, outcome, loading } = flow;
  const done = outcome !== null;
  const filterQuery = flow.search.trim().toLowerCase();
  const nodesWithSelection = flow.previewNodes.length;

  return (
    <SystemSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      crumb={['Fleet', 'Actions', 'Label stacks']}
      name="Label stacks"
      meta="one label · stacks on many nodes · keeps existing labels"
      primaryAction={done
        ? { label: 'Done', onClick: () => onOpenChange(false) }
        : {
          label: 'Apply',
          onClick: flow.run,
          pending: running,
          disabled: !selectedTemplate || totalSelected === 0 || !flow.canApplySelection,
        }}
      secondaryActions={done ? undefined : [
        { label: 'Reset', onClick: flow.reset, disabled: running || (totalSelected === 0 && !selectedTemplate) },
        { label: 'Refresh', icon: RefreshCw, onClick: flow.refresh, pending: loading, disabled: running },
      ]}
      footerContext="Reversible · reassign anytime from a stack"
    >
      <SheetSection title="Label" meta={loading ? 'loading…' : plural(flow.templates.length, 'label')}>
        <div className="flex flex-wrap gap-1.5">
          {flow.templates.length === 0 && (
            <span className="text-xs text-stat-subtitle">
              {loading ? 'Loading…' : 'No stack labels defined across the fleet.'}
            </span>
          )}
          {flow.templates.map(t => {
            const synthetic: Label = { id: -1, node_id: -1, name: t.name, color: t.color };
            const active = selectedTemplate?.name === t.name;
            return (
              <LabelPill
                key={t.name}
                label={synthetic}
                active={active}
                onClick={() => !running && !done && flow.setSelectedTemplate(active ? null : t)}
              />
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-stat-subtitle">
          {selectedTemplate?.colorConflict
            ? 'This label uses different colors on different nodes. The shown color is applied where it is created.'
            : 'Created with this color on nodes that do not have it yet. Existing labels on a stack are kept.'}
        </p>
      </SheetSection>

      <SheetSection
        title="Stacks"
        meta={totalSelected > 0 ? `${totalSelected} selected` : undefined}
      >
        <Input
          value={flow.search}
          onChange={(e) => flow.setSearch(e.target.value)}
          placeholder="Filter stacks…"
          className="mb-2 h-9 text-sm"
          disabled={running || done}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="grid gap-2">
          {flow.nodeData.length === 0 && (
            <span className="text-xs text-stat-subtitle">{loading ? 'Loading…' : 'No nodes in the fleet.'}</span>
          )}
          {flow.nodeData.map(entry => {
            const stacks = filterQuery ? entry.stacks.filter(s => s.toLowerCase().includes(filterQuery)) : entry.stacks;
            const set = flow.selected.get(entry.node.id) ?? new Set<string>();
            const allSelected = stacks.length > 0 && stacks.every(s => set.has(s));
            return (
              <div key={entry.node.id} className="rounded-md border border-card-border/40 p-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className={cn(KICKER, 'text-stat-value')}>
                    {entry.node.name}{entry.node.type === 'local' && !/local/i.test(entry.node.name) ? ' · local' : ''}
                  </span>
                  {entry.reachable && stacks.length > 0 ? (
                    <button
                      type="button"
                      disabled={running || done}
                      onClick={() => flow.toggleAllForNode(entry.node.id, stacks)}
                      className={cn(KICKER, 'text-stat-subtitle hover:text-stat-value disabled:opacity-50')}
                    >
                      {allSelected ? 'Clear' : 'Select all'}
                    </button>
                  ) : (
                    <span className={cn(KICKER, entry.reachable ? 'text-stat-icon' : 'text-destructive')}>
                      {entry.reachable ? (filterQuery ? 'no matches' : 'no stacks') : 'unreachable'}
                    </span>
                  )}
                </div>
                {stacks.map(stackName => (
                  <label key={stackName} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-glass-highlight">
                    <Checkbox
                      checked={set.has(stackName)}
                      onCheckedChange={() => flow.toggleStack(entry.node.id, stackName)}
                      disabled={running || done}
                    />
                    <span className="font-mono text-xs text-stat-value">{stackName}</span>
                  </label>
                ))}
              </div>
            );
          })}
        </div>
      </SheetSection>

      <SheetSection title={done ? 'Result' : 'Plan'}>
        {outcome
          ? <OutcomePath outcome={outcome} />
          : <PlanPath label={selectedTemplate?.name} stacks={totalSelected} nodes={nodesWithSelection} previewNodes={flow.previewNodes} />}
      </SheetSection>
    </SystemSheet>
  );
}

function PlanPath({ label, stacks, nodes, previewNodes }: {
  label: string | undefined;
  stacks: number;
  nodes: number;
  previewNodes: PreviewNode[];
}) {
  if (!label || stacks === 0) {
    return <StatusPath answer={{ tone: 'neutral', title: 'Nothing selected', line: 'Pick a label, then the stacks to add it to.' }} stages={[]} />;
  }
  const creates = previewNodes.filter(n => n.willCreate).length;
  const answer: StatusPathAnswer = {
    tone: 'brand',
    title: `Adds “${label}” to ${plural(stacks, 'stack')}`,
    line: `on ${plural(nodes, 'node')} · ${creates > 0 ? `creates the label on ${plural(creates, 'node')}` : 'reuses it everywhere'}`,
  };
  return (
    <StatusPath
      answer={answer}
      stages={[]}
      proof={{ label: 'Per-node detail', children: <PreviewList nodes={previewNodes} /> }}
    />
  );
}

function OutcomePath({ outcome }: { outcome: AssignOutcome }) {
  const clean = outcome.failed === 0 && outcome.unreachable === 0;
  const parts = [outcome.failed > 0 && `${outcome.failed} failed`, outcome.unreachable > 0 && `${plural(outcome.unreachable, 'node')} unreachable`].filter(Boolean);
  const answer: StatusPathAnswer = {
    tone: clean ? 'success' : 'warning',
    title: clean ? `Assigned “${outcome.label}” to ${plural(outcome.ok, 'stack')}` : `${outcome.ok} assigned`,
    line: clean ? `on ${plural(outcome.nodes, 'node')}` : parts.join(' · '),
  };
  return (
    <StatusPath answer={answer} stages={[]} proof={{ label: 'Per-node outcome', children: <ResultsList results={outcome.rows} /> }} />
  );
}

function PreviewList({ nodes }: { nodes: PreviewNode[] }) {
  return (
    <div className="space-y-1.5 rounded border border-card-border/60 bg-card/40 p-2">
      {nodes.map(n => (
        <div key={n.nodeId} className="flex items-start gap-2">
          <span className={cn(
            KICKER,
            'inline-flex shrink-0 items-center rounded-sm border px-1 py-0.5',
            n.willCreate ? 'border-warning/40 bg-warning/10 text-warning' : 'border-success/40 bg-success/10 text-success',
          )}>
            {n.willCreate ? 'create' : 'reuse'}
          </span>
          <span className="shrink-0 pt-0.5 text-[11px] text-stat-value">{n.nodeName}</span>
          <span className="min-w-0 flex-1 break-words pt-0.5 font-mono text-[11px] text-stat-subtitle">{n.stacks.join(', ')}</span>
        </div>
      ))}
    </div>
  );
}
