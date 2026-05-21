import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmModal } from '@/components/ui/modal';
import { Checkbox } from '@/components/ui/checkbox';
import { FleetActionCard } from '@/components/ui/fleet-action-card';
import { SheetSection } from '@/components/ui/system-sheet';
import { LabelPill } from '@/components/LabelPill';
import { fetchForNode } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/lib/utils';
import type { FleetNode } from '@/components/FleetView/types';
import type { Label } from '@/components/label-types';
import { ResultsList, type ResultRow } from '../ResultsList';

interface NodeStackResult { stackName: string; success: boolean; error?: string }

interface Props {
  nodes: FleetNode[];
}

export function BulkLabelAssignCard({ nodes }: Props) {
  const [selectedNodeId, setSelectedNodeId] = useState<number>(() => {
    const local = nodes.find(n => n.type === 'local');
    return Number(local?.id ?? nodes[0]?.id ?? 0);
  });
  const [stacks, setStacks] = useState<string[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [loadingLists, setLoadingLists] = useState(false);
  const [selectedStacks, setSelectedStacks] = useState<Set<string>>(new Set());
  const [selectedLabels, setSelectedLabels] = useState<Set<number>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ResultRow[]>([]);

  const selectedNode = useMemo(() => nodes.find(n => n.id === selectedNodeId), [nodes, selectedNodeId]);

  useEffect(() => {
    if (!selectedNodeId) return;
    let cancelled = false;
    async function load() {
      setLoadingLists(true);
      setSelectedStacks(new Set());
      setSelectedLabels(new Set());
      setResults([]);
      try {
        const [stacksRes, labelsRes] = await Promise.all([
          fetchForNode(`/fleet/node/${selectedNodeId}/stacks`, selectedNodeId),
          fetchForNode('/labels', selectedNodeId),
        ]);
        const stacksList = stacksRes.ok ? ((await stacksRes.json()) as string[]) : [];
        const labelsList = labelsRes.ok ? ((await labelsRes.json()) as Label[]) : [];
        if (!cancelled) {
          setStacks(stacksList);
          setLabels(labelsList);
        }
      } catch {
        if (!cancelled) {
          setStacks([]);
          setLabels([]);
        }
      } finally {
        if (!cancelled) setLoadingLists(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [selectedNodeId]);

  function toggleStack(stackName: string) {
    setSelectedStacks(prev => {
      const next = new Set(prev);
      if (next.has(stackName)) next.delete(stackName);
      else next.add(stackName);
      return next;
    });
  }
  function toggleLabel(labelId: number) {
    setSelectedLabels(prev => {
      const next = new Set(prev);
      if (next.has(labelId)) next.delete(labelId);
      else next.add(labelId);
      return next;
    });
  }
  function toggleAllStacks() {
    if (selectedStacks.size === stacks.length) setSelectedStacks(new Set());
    else setSelectedStacks(new Set(stacks));
  }
  function clearSelection() {
    setSelectedStacks(new Set());
    setSelectedLabels(new Set());
    setResults([]);
  }

  async function run() {
    if (selectedStacks.size === 0) return;
    const labelIds = Array.from(selectedLabels);
    const assignments = Array.from(selectedStacks).map(stackName => ({ stackName, labelIds }));
    const toastId = toast.loading(`Assigning labels to ${assignments.length} stack${assignments.length === 1 ? '' : 's'}…`);
    setRunning(true);
    try {
      const res = await fetchForNode('/fleet-actions/labels/bulk-assign', selectedNodeId, {
        method: 'POST',
        body: JSON.stringify({ assignments }),
      });
      const body = await res.json().catch(() => ({}));
      toast.dismiss(toastId);
      if (!res.ok) {
        toast.error(body.error || 'Bulk label assignment failed');
        return;
      }
      const rows: ResultRow[] = (body.results as NodeStackResult[] ?? []).map((r, i) => ({
        key: `${r.stackName}-${i}`,
        label: r.stackName || '(unnamed)',
        success: r.success,
        error: r.error,
      }));
      setResults(rows);
      const ok = rows.filter(r => r.success).length;
      const failed = rows.length - ok;
      if (failed === 0) toast.success(`Updated labels on ${ok} stack${ok === 1 ? '' : 's'}.`);
      else toast.warning(`${ok} updated, ${failed} failed. See results below.`);
    } catch (err) {
      toast.dismiss(toastId);
      toast.error(err instanceof Error ? err.message : 'Network error');
    } finally {
      setRunning(false);
      setConfirmOpen(false);
    }
  }

  const blastValue = useMemo(() => {
    if (selectedStacks.size === 0 || selectedLabels.size === 0 || !selectedNode) return 'awaiting target';
    const stackLabel = `${selectedStacks.size} ${selectedStacks.size === 1 ? 'stack' : 'stacks'}`;
    // "local · " prefix triggers the primitive's cyan-dot path per §18.5.
    if (selectedNode.type === 'local') return `local · ${stackLabel}`;
    return `${selectedNode.name} · ${stackLabel}`;
  }, [selectedNode, selectedStacks.size, selectedLabels.size]);

  return (
    <>
      <FleetActionCard
        crumb={['Fleet', 'Actions', 'Bulk label assign']}
        name="Bulk label assign."
        meta="one node · multi-stack · replaces existing label set"
        actionClass="transformative"
        blastRadius={{ value: blastValue }}
        secondaryAction={{
          label: 'Reset',
          onClick: clearSelection,
          disabled: running || (selectedStacks.size === 0 && selectedLabels.size === 0),
        }}
        primaryAction={{
          label: 'Apply',
          onClick: () => setConfirmOpen(true),
          variant: 'primary',
          disabled: running || selectedStacks.size === 0 || selectedLabels.size === 0,
        }}
        footerContext="Reversible · yes · reassign anytime"
      >
        <SheetSection title="Node" meta={loadingLists ? 'loading…' : undefined}>
          <NodeSegmented
            nodes={nodes}
            value={selectedNodeId}
            onChange={setSelectedNodeId}
            disabled={running}
          />
        </SheetSection>

        <SheetSection
          title={`Stacks · ${selectedStacks.size} / ${stacks.length}`}
          meta={stacks.length > 0
            ? (selectedStacks.size === stacks.length ? 'all selected' : 'multi-select')
            : undefined}
        >
          <div className="grid gap-0.5 max-h-44 overflow-auto pr-1 border border-card-border/40 rounded-md p-2">
            {stacks.length === 0 && (
              <span className="text-xs text-stat-subtitle">
                {loadingLists ? 'Loading…' : selectedNode ? `No stacks on ${selectedNode.name}.` : 'Pick a node.'}
              </span>
            )}
            {stacks.map(stackName => (
              <label
                key={stackName}
                className="flex items-center gap-2 py-1 px-1 rounded hover:bg-glass-highlight cursor-pointer"
              >
                <Checkbox
                  checked={selectedStacks.has(stackName)}
                  onCheckedChange={() => toggleStack(stackName)}
                  disabled={running}
                />
                <span className="text-xs font-mono text-stat-value">{stackName}</span>
              </label>
            ))}
          </div>
          {stacks.length > 0 && (
            <button
              type="button"
              disabled={running}
              onClick={toggleAllStacks}
              className="mt-2 font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle hover:text-stat-value disabled:opacity-50"
            >
              {selectedStacks.size === stacks.length ? 'Clear all' : 'Select all'}
            </button>
          )}
        </SheetSection>

        <SheetSection
          title={`Labels · ${selectedLabels.size} / ${labels.length}`}
          meta="replaces existing"
        >
          <div className="flex flex-wrap gap-1.5 max-h-32 overflow-auto p-2 border border-card-border/40 rounded-md">
            {labels.length === 0 && (
              <span className="text-xs text-stat-subtitle">
                {loadingLists ? 'Loading…' : selectedNode ? `No labels defined on ${selectedNode.name}.` : ''}
              </span>
            )}
            {labels.map(label => (
              <LabelPill
                key={label.id}
                label={label}
                active={selectedLabels.has(label.id)}
                onClick={() => !running && toggleLabel(label.id)}
              />
            ))}
          </div>
          <p className="mt-2 text-[11px] text-stat-subtitle">
            Selected labels replace each chosen stack's existing label set on this node.
            Selecting no labels clears assignments.
          </p>
        </SheetSection>

        {results.length > 0 && (
          <SheetSection title="Per-stack results">
            <ResultsList results={results} />
          </SheetSection>
        )}
      </FleetActionCard>

      <ConfirmModal
        open={confirmOpen}
        onOpenChange={(open) => { if (!open) setConfirmOpen(false); }}
        variant="default"
        kicker="Bulk label assign"
        title={`Apply ${selectedLabels.size} label${selectedLabels.size === 1 ? '' : 's'} to ${selectedStacks.size} stack${selectedStacks.size === 1 ? '' : 's'}?`}
        description={
          selectedLabels.size === 0
            ? 'No labels selected, this will clear existing assignments on the selected stacks.'
            : `Each selected stack's existing label set on ${selectedNode?.name ?? 'this node'} will be replaced with the chosen labels.`
        }
        confirmLabel="Apply"
        confirming={running}
        onConfirm={run}
      />
    </>
  );
}

interface NodeSegmentedProps {
  nodes: FleetNode[];
  value: number;
  onChange: (id: number) => void;
  disabled: boolean;
}

function NodeSegmented({ nodes, value, onChange, disabled }: NodeSegmentedProps) {
  return (
    <div className="inline-flex flex-wrap rounded-md border border-card-border/60 overflow-hidden">
      {nodes.map(n => {
        const active = n.id === value;
        return (
          <Button
            key={n.id}
            type="button"
            variant={active ? 'default' : 'outline'}
            size="sm"
            disabled={disabled}
            onClick={() => onChange(n.id)}
            className={cn('rounded-none border-0 h-8 px-3 text-xs', active && 'pointer-events-none')}
          >
            {n.name}{n.type === 'local' ? ' (local)' : ''}
          </Button>
        );
      })}
    </div>
  );
}
