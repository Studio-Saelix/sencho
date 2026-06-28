import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmModal } from '@/components/ui/modal';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { FleetActionCard } from '@/components/ui/fleet-action-card';
import { SheetSection } from '@/components/ui/system-sheet';
import { LabelPill } from '@/components/LabelPill';
import { apiFetch, fetchForNode } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/lib/utils';
import type { FleetNode } from '@/components/FleetView/types';
import { type Label, type LabelColor, LABEL_COLORS } from '@/components/label-types';
import { ResultsList, type ResultRow } from '../ResultsList';

interface NodeStackResult { stackName: string; success: boolean; error?: string }
interface AssignNodeResult {
  nodeId: number;
  nodeName: string;
  reachable?: boolean;
  error?: string;
  created: boolean;
  stackResults: NodeStackResult[];
}

interface NodeData {
  node: FleetNode;
  reachable: boolean;
  stacks: string[];
  labels: Label[];
}

// A label name that exists somewhere in the fleet, with a deterministic color
// to propagate. `colorConflict` flags names whose stored color differs across
// nodes (the local node's color wins, then the most common, then the first).
interface LabelTemplate {
  name: string;
  color: LabelColor;
  colorConflict: boolean;
}

interface Props {
  nodes: FleetNode[];
}

// One node's slice of the pending assignment: the stacks selected on it and
// whether the label will be created there. Shared by the preview builder and the
// confirm-modal list so the two cannot drift.
type PreviewNode = { nodeId: number; nodeName: string; willCreate: boolean; stacks: string[] };

const KICKER = 'font-mono text-[10px] uppercase tracking-[0.18em]';

export function BulkLabelAssignCard({ nodes }: Props) {
  const [nodeData, setNodeData] = useState<NodeData[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<LabelTemplate | null>(null);
  // nodeId -> selected stack names on that node.
  const [selected, setSelected] = useState<Map<number, Set<string>>>(new Map());
  const [search, setSearch] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ResultRow[]>([]);

  // The latest nodes are read through a ref so the load effect can rebuild
  // per-node state without taking the array as a reactive dependency (it is a
  // fresh reference each parent render, e.g. on each fleet poll).
  const nodesRef = useRef(nodes);
  useEffect(() => { nodesRef.current = nodes; });
  const nodeIds = nodes.map(n => n.id).join(',');

  // Bumped by the manual Refresh so the snapshot is never trusted indefinitely:
  // a remote that recovers, or a label added/removed after the card opened, is
  // re-read on demand rather than confirmed against stale state.
  const [refreshKey, setRefreshKey] = useState(0);

  // Reload when the node set changes or the operator refreshes (not on every
  // parent render). Resets the selection because a refreshed fleet can no longer
  // guarantee the previously picked stacks still exist.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setSelected(new Map());
      setSelectedTemplate(null);
      setResults([]);
      const entries = await Promise.all(nodesRef.current.map(async (node): Promise<NodeData> => {
        try {
          const [stacksRes, labelsRes] = await Promise.all([
            fetchForNode(`/fleet/node/${node.id}/stacks`, node.id),
            fetchForNode('/labels', node.id),
          ]);
          const stacks = stacksRes.ok ? ((await stacksRes.json()) as string[]) : [];
          const labels = labelsRes.ok ? ((await labelsRes.json()) as Label[]) : [];
          if (!stacksRes.ok || !labelsRes.ok) {
            console.warn(`[BulkLabelAssign] node ${node.id} (${node.name}) load incomplete: stacks ${stacksRes.status}, labels ${labelsRes.status}`);
          }
          return { node, reachable: stacksRes.ok && labelsRes.ok, stacks, labels };
        } catch (err) {
          console.error(`[BulkLabelAssign] failed to load node ${node.id} (${node.name}):`, err);
          return { node, reachable: false, stacks: [], labels: [] };
        }
      }));
      if (!cancelled) {
        setNodeData(entries);
        setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [nodeIds, refreshKey]);

  // Distinct label templates across the fleet (name + deterministic color).
  const templates = useMemo<LabelTemplate[]>(() => {
    const byName = new Map<string, { colors: Map<string, number>; localColor?: string }>();
    for (const entry of nodeData) {
      const isLocal = entry.node.type === 'local';
      for (const label of entry.labels) {
        const t = byName.get(label.name) ?? { colors: new Map<string, number>() };
        t.colors.set(label.color, (t.colors.get(label.color) ?? 0) + 1);
        if (isLocal) t.localColor = label.color;
        byName.set(label.name, t);
      }
    }
    return Array.from(byName.entries())
      .map(([name, t]) => {
        let color = t.localColor;
        if (!color) {
          let best = -1;
          for (const [c, count] of t.colors) {
            if (count > best) { best = count; color = c; }
          }
        }
        const safe: LabelColor = typeof color === 'string' && (LABEL_COLORS as string[]).includes(color) ? (color as LabelColor) : 'slate';
        return { name, color: safe, colorConflict: t.colors.size > 1 };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [nodeData]);

  const totalSelected = useMemo(() => {
    let n = 0;
    for (const set of selected.values()) n += set.size;
    return n;
  }, [selected]);
  const nodesWithSelection = useMemo(
    () => Array.from(selected.values()).filter(s => s.size > 0).length,
    [selected],
  );

  function toggleStack(nodeId: number, stackName: string) {
    setSelected(prev => {
      const next = new Map(prev);
      const set = new Set(next.get(nodeId) ?? []);
      if (set.has(stackName)) set.delete(stackName);
      else set.add(stackName);
      next.set(nodeId, set);
      return next;
    });
  }
  function toggleAllForNode(nodeId: number, stacks: string[]) {
    setSelected(prev => {
      const next = new Map(prev);
      const set = new Set(next.get(nodeId) ?? []);
      const allSelected = stacks.length > 0 && stacks.every(s => set.has(s));
      if (allSelected) stacks.forEach(s => set.delete(s));
      else stacks.forEach(s => set.add(s));
      next.set(nodeId, set);
      return next;
    });
  }
  function reset() {
    setSelected(new Map());
    setSelectedTemplate(null);
    setResults([]);
    setSearch('');
  }

  const filterQuery = search.trim().toLowerCase();
  function filteredStacks(stacks: string[]): string[] {
    if (!filterQuery) return stacks;
    return stacks.filter(s => s.toLowerCase().includes(filterQuery));
  }

  async function run() {
    if (!selectedTemplate || totalSelected === 0) return;
    const targets = Array.from(selected.entries())
      .filter(([, set]) => set.size > 0)
      .map(([nodeId, set]) => ({ nodeId, stackNames: Array.from(set) }));
    const toastId = toast.loading(`Assigning "${selectedTemplate.name}" to ${totalSelected} stack${totalSelected === 1 ? '' : 's'} across ${targets.length} node${targets.length === 1 ? '' : 's'}…`);
    setRunning(true);
    setResults([]);
    try {
      const res = await apiFetch('/fleet/labels/bulk-assign', {
        method: 'POST',
        body: JSON.stringify({ label: { name: selectedTemplate.name, color: selectedTemplate.color }, targets }),
      });
      const body = await res.json().catch(() => ({}));
      toast.dismiss(toastId);
      if (!res.ok) {
        toast.error(body.error || 'Bulk label assign failed');
        return;
      }
      // A 200 with a missing or non-array `results` is a server/contract bug,
      // not an empty assign: don't let it fall through to the success path with
      // zero counts. Log it and tell the operator it was unexpected.
      if (!Array.isArray(body.results)) {
        console.error('[BulkLabelAssign] bulk-assign returned a malformed body', body);
        toast.error('Bulk label assign returned an unexpected response. Check the server logs and retry.');
        return;
      }
      const apiResults = body.results as AssignNodeResult[];
      const rows: ResultRow[] = apiResults.map((node) => {
        const unreachable = node.reachable === false;
        const ok = node.stackResults.filter(s => s.success).length;
        return {
          key: `node-${node.nodeId}`,
          label: unreachable
            ? `${node.nodeName} (unreachable)`
            : `${node.nodeName} · ${node.created ? 'label created' : 'label reused'} · ${ok}/${node.stackResults.length} stack${node.stackResults.length === 1 ? '' : 's'}`,
          success: !unreachable && node.stackResults.length > 0 && node.stackResults.every(s => s.success),
          error: unreachable ? (node.error ?? 'Node unreachable') : undefined,
          sub: node.stackResults.map((s, i) => ({
            key: `${node.nodeId}-${s.stackName}-${i}`,
            label: s.stackName,
            success: s.success,
            error: s.error,
          })),
        };
      });
      setResults(rows);
      const allStacks = apiResults.flatMap(n => n.stackResults);
      const ok = allStacks.filter(s => s.success).length;
      const failed = allStacks.length - ok;
      const unreachableCount = apiResults.filter(n => n.reachable === false).length;
      if (ok > 0 && failed === 0 && unreachableCount === 0) toast.success(`Assigned "${selectedTemplate.name}" to ${ok} stack${ok === 1 ? '' : 's'} across ${apiResults.length} node${apiResults.length === 1 ? '' : 's'}.`);
      else if (ok === 0 && failed === 0 && unreachableCount === 0) {
        // Every node reported zero stack results for a non-empty request: a
        // contract break the success path above must not absorb.
        console.error('[BulkLabelAssign] bulk-assign returned no stack results', apiResults);
        toast.error('Bulk label assign returned no results. Check the server logs and retry.');
      }
      else toast.warning(`${ok} assigned, ${failed} failed${unreachableCount > 0 ? `, ${unreachableCount} node${unreachableCount === 1 ? '' : 's'} unreachable` : ''}. See results below.`);
    } catch (err) {
      toast.dismiss(toastId);
      toast.error(err instanceof Error ? err.message : 'Network error');
    } finally {
      setRunning(false);
      setConfirmOpen(false);
    }
  }

  const blastValue = useMemo(() => {
    if (!selectedTemplate || totalSelected === 0) return 'awaiting target';
    return `${totalSelected} stack${totalSelected === 1 ? '' : 's'} · ${nodesWithSelection} node${nodesWithSelection === 1 ? '' : 's'}`;
  }, [selectedTemplate, totalSelected, nodesWithSelection]);

  const previewNodes = useMemo(() => {
    if (!selectedTemplate) return [];
    return nodeData
      .map(entry => {
        const set = selected.get(entry.node.id);
        const stacks = set ? Array.from(set) : [];
        if (stacks.length === 0) return null;
        const willCreate = !entry.labels.some(l => l.name === selectedTemplate.name);
        return { nodeId: entry.node.id, nodeName: entry.node.name, willCreate, stacks };
      })
      .filter((n): n is PreviewNode => n !== null);
  }, [nodeData, selected, selectedTemplate]);

  return (
    <>
      <FleetActionCard
        crumb={['Fleet', 'Actions', 'Bulk label assign']}
        name="Bulk label assign."
        meta="cross-node · adds label · creates it where missing · preserves existing"
        actionClass="transformative"
        blastRadius={{ value: blastValue }}
        secondaryAction={{
          label: 'Reset',
          onClick: reset,
          disabled: running || (totalSelected === 0 && !selectedTemplate),
        }}
        primaryAction={{
          label: 'Apply',
          onClick: () => setConfirmOpen(true),
          variant: 'primary',
          disabled: running || !selectedTemplate || totalSelected === 0,
        }}
        footerContext="Reversible · yes · reassign anytime"
      >
        <SheetSection
          title="Label · source"
          meta={loading ? 'loading…' : `${templates.length} label${templates.length === 1 ? '' : 's'}`}
        >
          <div className="flex items-start justify-between gap-2 mb-2">
            <p className={cn(KICKER, 'text-stat-subtitle normal-case tracking-normal text-[11px]')}>
              Pick a stack label from anywhere in the fleet. It is added to the selected stacks on each node, and created there with this color if the node does not have it yet.
            </p>
            <button
              type="button"
              onClick={() => setRefreshKey(k => k + 1)}
              disabled={running || loading}
              title="Re-read stacks and labels from every node"
              className={cn(KICKER, 'shrink-0 text-stat-subtitle hover:text-stat-value disabled:opacity-50')}
            >
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5 max-h-32 overflow-auto p-2 border border-card-border/40 rounded-md">
            {templates.length === 0 && (
              <span className="text-xs text-stat-subtitle">
                {loading ? 'Loading…' : 'No stack labels defined across the fleet.'}
              </span>
            )}
            {templates.map(t => {
              const synthetic: Label = { id: -1, node_id: -1, name: t.name, color: t.color };
              const active = selectedTemplate?.name === t.name;
              return (
                <LabelPill
                  key={t.name}
                  label={synthetic}
                  active={active}
                  onClick={() => !running && setSelectedTemplate(active ? null : t)}
                />
              );
            })}
          </div>
          {selectedTemplate?.colorConflict && (
            <p className="mt-2 text-[11px] text-stat-subtitle">
              This label uses different colors on different nodes. The shown color is applied where it is created.
            </p>
          )}
        </SheetSection>

        <SheetSection
          title={`Target stacks · ${totalSelected} selected`}
          meta={nodesWithSelection > 0 ? `${nodesWithSelection} node${nodesWithSelection === 1 ? '' : 's'}` : undefined}
        >
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter stacks…"
            className="h-9 text-sm mb-2"
            disabled={running}
            autoComplete="off"
            spellCheck={false}
          />
          <div className="grid gap-2 max-h-64 overflow-auto pr-1">
            {nodeData.length === 0 && (
              <span className="text-xs text-stat-subtitle">{loading ? 'Loading…' : 'No nodes in the fleet.'}</span>
            )}
            {nodeData.map(entry => {
              const stacks = filteredStacks(entry.stacks);
              const set = selected.get(entry.node.id) ?? new Set<string>();
              const allSelected = stacks.length > 0 && stacks.every(s => set.has(s));
              return (
                <div key={entry.node.id} className="border border-card-border/40 rounded-md p-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className={cn(KICKER, 'text-stat-value')}>
                      {entry.node.name}{entry.node.type === 'local' ? ' · local' : ''}
                    </span>
                    {entry.reachable && stacks.length > 0 ? (
                      <button
                        type="button"
                        disabled={running}
                        onClick={() => toggleAllForNode(entry.node.id, stacks)}
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
                    <label
                      key={stackName}
                      className="flex items-center gap-2 py-1 px-1 rounded hover:bg-glass-highlight cursor-pointer"
                    >
                      <Checkbox
                        checked={set.has(stackName)}
                        onCheckedChange={() => toggleStack(entry.node.id, stackName)}
                        disabled={running}
                      />
                      <span className="text-xs font-mono text-stat-value">{stackName}</span>
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
        </SheetSection>

        {selectedTemplate && previewNodes.length > 0 && (
          <SheetSection
            title={`Preview · ${totalSelected} stack${totalSelected === 1 ? '' : 's'}`}
            meta={`across ${previewNodes.length} node${previewNodes.length === 1 ? '' : 's'}`}
          >
            <div className="rounded border border-card-border/60 bg-card/40 shadow-[inset_0_2px_4px_0_oklch(0_0_0_/_0.35)] p-2 space-y-1">
              {previewNodes.map(n => (
                <div key={n.nodeId} className="flex items-center gap-2">
                  <span className={cn(
                    KICKER,
                    'inline-flex items-center px-1 py-0.5 rounded-sm border shrink-0',
                    n.willCreate
                      ? 'border-amber-400/40 bg-amber-400/10 text-amber-400'
                      : 'border-success/40 bg-success/10 text-success',
                  )}>
                    {n.willCreate ? 'create' : 'reuse'}
                  </span>
                  <span className="flex-1 min-w-0 truncate text-[11px] text-stat-value">{n.nodeName}</span>
                  <span className={cn(KICKER, 'shrink-0 text-stat-subtitle')}>
                    {n.stacks.length} stack{n.stacks.length === 1 ? '' : 's'}
                  </span>
                </div>
              ))}
            </div>
          </SheetSection>
        )}

        {results.length > 0 && (
          <SheetSection title="Per-node breakdown">
            <ResultsList results={results} />
          </SheetSection>
        )}
      </FleetActionCard>

      <ConfirmModal
        open={confirmOpen}
        onOpenChange={(open) => { if (!open) setConfirmOpen(false); }}
        variant="default"
        kicker="Bulk label assign"
        title={`Assign "${selectedTemplate?.name ?? ''}" to ${totalSelected} stack${totalSelected === 1 ? '' : 's'} across ${nodesWithSelection} node${nodesWithSelection === 1 ? '' : 's'}?`}
        description="The label is added to each selected stack, preserving its existing labels. On nodes that do not have this label yet, Sencho creates it with the chosen color."
        confirmLabel="Apply"
        confirming={running}
        onConfirm={run}
      >
        {previewNodes.length > 0 && <AffectedTargetsList nodes={previewNodes} />}
      </ConfirmModal>
    </>
  );
}

// The concrete node/stack list carried into the confirm modal so the operator
// approves against the names being changed, not a bare stack/node count. Mirrors
// the stop card's resolved-targets list; `creates label` flags nodes where the
// label does not exist yet and will be created.
function AffectedTargetsList({ nodes }: { nodes: PreviewNode[] }) {
  return (
    <div className="max-h-[180px] overflow-y-auto rounded border border-card-border/60 bg-card/40 p-2">
      <ul className="space-y-1.5">
        {nodes.map(n => (
          <li key={n.nodeId} className="flex items-start gap-2">
            <span className={cn(KICKER, 'shrink-0 pt-0.5', n.willCreate ? 'text-amber-400' : 'text-stat-subtitle')}>
              {n.nodeName}{n.willCreate ? ' · creates label' : ''}
            </span>
            <span className="min-w-0 flex-1 break-words font-mono text-[11px] text-stat-value">{n.stacks.join(', ')}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
