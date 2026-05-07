import { useEffect, useMemo, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Loader2, Server } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ConfirmModal } from '@/components/ui/modal';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { LabelPill } from '@/components/LabelPill';
import { fetchForNode } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/lib/utils';
import type { FleetNode } from '@/components/FleetView/types';
import type { Label } from '@/components/label-types';
import { ResultsList, type ResultRow } from '../ResultsList';
import { TONE_RAIL, TONE_BG, type AccentTone } from './tone';

interface NodeStackResult { stackName: string; success: boolean; error?: string }

interface Props {
  nodes: FleetNode[];
  icon: LucideIcon;
  accentTone: AccentTone;
}

export function BulkLabelAssignCard({ nodes, icon: Icon, accentTone }: Props) {
  const [selectedNodeId, setSelectedNodeId] = useState<string>(() => {
    const local = nodes.find(n => n.type === 'local');
    return String(local?.id ?? nodes[0]?.id ?? '');
  });
  const [stacks, setStacks] = useState<string[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [loadingLists, setLoadingLists] = useState(false);
  const [selectedStacks, setSelectedStacks] = useState<Set<string>>(new Set());
  const [selectedLabels, setSelectedLabels] = useState<Set<number>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ResultRow[]>([]);

  const nodeId = useMemo(() => Number(selectedNodeId) || 0, [selectedNodeId]);
  const selectedNode = useMemo(() => nodes.find(n => n.id === nodeId), [nodes, nodeId]);

  // Load stacks + labels whenever the node changes.
  useEffect(() => {
    if (!nodeId) return;
    let cancelled = false;
    async function load() {
      setLoadingLists(true);
      setSelectedStacks(new Set());
      setSelectedLabels(new Set());
      setResults([]);
      try {
        const [stacksRes, labelsRes] = await Promise.all([
          fetchForNode(`/fleet/node/${nodeId}/stacks`, nodeId),
          fetchForNode('/labels', nodeId),
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
  }, [nodeId]);

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

  async function run() {
    if (selectedStacks.size === 0) return;
    const labelIds = Array.from(selectedLabels);
    const assignments = Array.from(selectedStacks).map(stackName => ({ stackName, labelIds }));
    const toastId = toast.loading(`Assigning labels to ${assignments.length} stack${assignments.length === 1 ? '' : 's'}…`);
    setRunning(true);
    try {
      const res = await fetchForNode('/fleet-actions/labels/bulk-assign', nodeId, {
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

  return (
    <Card className="relative overflow-hidden bg-card shadow-card-bevel">
      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-[3px]', TONE_RAIL[accentTone])} />
      <CardContent className="p-6">
        <div className="flex items-start gap-3 mb-4">
          <span className={cn('inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md', TONE_BG[accentTone])}>
            <Icon className="h-5 w-5" strokeWidth={1.5} />
          </span>
          <div className="flex-1">
            <h3 className="text-base font-medium text-stat-value">Bulk label assign</h3>
            <p className="mt-1 text-xs text-stat-subtitle">
              Pick a node, multi-select stacks, and replace their labels in one shot.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Server className="h-3.5 w-3.5 text-stat-subtitle" strokeWidth={1.5} />
            <Select value={selectedNodeId} onValueChange={setSelectedNodeId} disabled={running}>
              <SelectTrigger className="w-56 h-8 text-xs">
                <SelectValue placeholder="Select a node" />
              </SelectTrigger>
              <SelectContent>
                {nodes.map(n => (
                  <SelectItem key={n.id} value={String(n.id)}>
                    {n.name} {n.type === 'local' ? '(local)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {loadingLists && <span className="text-xs text-stat-subtitle">Loading…</span>}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] uppercase tracking-wide text-stat-subtitle">
                Stacks ({selectedStacks.size}/{stacks.length})
              </span>
              {stacks.length > 0 && (
                <button
                  type="button"
                  disabled={running}
                  onClick={toggleAllStacks}
                  className="text-xs text-stat-subtitle hover:text-stat-value disabled:opacity-50"
                >
                  {selectedStacks.size === stacks.length ? 'Clear' : 'Select all'}
                </button>
              )}
            </div>
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
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wide text-stat-subtitle mb-1.5">
              Labels ({selectedLabels.size}/{labels.length})
            </div>
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
          </div>

          <p className="text-[11px] text-stat-subtitle">
            Selected labels replace each chosen stack's existing label set on this node.
            Selecting no labels clears assignments.
          </p>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={running || selectedStacks.size === 0}
              onClick={() => setConfirmOpen(true)}
              className="gap-2"
            >
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} /> : <Icon className="h-3.5 w-3.5" strokeWidth={1.5} />}
              Apply to {selectedStacks.size} stack{selectedStacks.size === 1 ? '' : 's'}
            </Button>
            {!running && results.length > 0 && (
              <button
                type="button"
                onClick={() => setResults([])}
                className="text-xs text-stat-subtitle hover:text-stat-value"
              >
                Clear results
              </button>
            )}
          </div>

          {results.length > 0 && (
            <ResultsList title="Per-stack results" results={results} />
          )}
        </div>

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
      </CardContent>
    </Card>
  );
}
