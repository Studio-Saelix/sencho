import { useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Loader2, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ConfirmModal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { apiFetch, fetchForNode } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/lib/utils';
import type { FleetNode } from '@/components/FleetView/types';
import type { Label } from '@/components/label-types';
import { ResultsList, type ResultRow } from '../ResultsList';
import { TONE_RAIL, TONE_BG, type AccentTone } from './tone';

interface NodeStackResult { stackName: string; success: boolean; error?: string }
interface FleetStopNodeResult {
  nodeId: number;
  nodeName: string;
  matched: boolean;
  stackResults: NodeStackResult[];
}

interface Props {
  nodes: FleetNode[];
  icon: LucideIcon;
  accentTone: AccentTone;
}

export function LabelFleetStopCard({ nodes, icon: Icon, accentTone }: Props) {
  const [labelName, setLabelName] = useState('');
  const [knownLabelNames, setKnownLabelNames] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ResultRow[]>([]);

  // Aggregate label names across reachable nodes for autocomplete. Offline
  // nodes are skipped so the page-load fanout doesn't hang on dead remotes.
  useEffect(() => {
    let cancelled = false;
    async function loadSuggestions() {
      const names = new Set<string>();
      const reachable = nodes.filter(n => n.status === 'online');
      await Promise.all(reachable.map(async (node) => {
        try {
          const res = await fetchForNode('/labels', node.id);
          if (!res.ok) return;
          const list = (await res.json()) as Label[];
          for (const l of list) names.add(l.name);
        } catch {
          /* ignore — this node is unreachable, not user-facing */
        }
      }));
      if (!cancelled) setKnownLabelNames(Array.from(names).sort());
    }
    loadSuggestions();
    return () => { cancelled = true; };
  }, [nodes]);

  async function run() {
    const trimmed = labelName.trim();
    if (!trimmed) return;
    const toastId = toast.loading(`Stopping stacks labeled "${trimmed}" across the fleet…`);
    setRunning(true);
    setResults([]);
    try {
      const res = await apiFetch('/fleet/labels/fleet-stop', {
        method: 'POST',
        body: JSON.stringify({ labelName: trimmed }),
      });
      const body = await res.json().catch(() => ({}));
      toast.dismiss(toastId);
      if (!res.ok) {
        toast.error(body.error || 'Fleet stop failed');
        return;
      }
      const apiResults = (body.results as FleetStopNodeResult[]) ?? [];
      const rows: ResultRow[] = apiResults.map((node) => ({
        key: `node-${node.nodeId}`,
        label: node.matched
          ? `${node.nodeName} · ${node.stackResults.length} stack${node.stackResults.length === 1 ? '' : 's'}`
          : `${node.nodeName} (no matching label)`,
        success: node.matched && node.stackResults.every(s => s.success),
        error: node.matched ? undefined : 'Label not present',
        sub: node.stackResults.map((s, i) => ({
          key: `${node.nodeId}-${s.stackName}-${i}`,
          label: s.stackName,
          success: s.success,
          error: s.error,
        })),
      }));
      setResults(rows);
      const matchedNodes = apiResults.filter(n => n.matched).length;
      const stacksTouched = apiResults.flatMap(n => n.stackResults);
      const ok = stacksTouched.filter(s => s.success).length;
      const failed = stacksTouched.length - ok;
      if (matchedNodes === 0) toast.info('No nodes have a label by that name.');
      else if (failed === 0 && ok > 0) toast.success(`Stopped ${ok} stack${ok === 1 ? '' : 's'} across ${matchedNodes} node${matchedNodes === 1 ? '' : 's'}.`);
      else if (ok === 0 && failed === 0) toast.info('Label matched but no stacks were assigned to it.');
      else toast.warning(`${ok} stopped, ${failed} failed. See results below.`);
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
            <h3 className="text-base font-medium text-stat-value">Stop fleet by label</h3>
            <p className="mt-1 text-xs text-stat-subtitle">
              Stop every stack labeled with this name on every node. Labels are matched by name across the fleet.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label htmlFor="fleet-stop-label-input" className="block text-[10px] uppercase tracking-wide text-stat-subtitle mb-1.5">
              Label name
            </label>
            <Input
              id="fleet-stop-label-input"
              list="fleet-stop-label-suggestions"
              value={labelName}
              onChange={(e) => setLabelName(e.target.value)}
              placeholder="e.g. production"
              className="h-9 text-sm"
              disabled={running}
            />
            <datalist id="fleet-stop-label-suggestions">
              {knownLabelNames.map(n => <option key={n} value={n} />)}
            </datalist>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={running || labelName.trim().length === 0}
              onClick={() => setConfirmOpen(true)}
              className="gap-2"
            >
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} /> : <Icon className="h-3.5 w-3.5" strokeWidth={1.5} />}
              Stop matching stacks
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

          {results.length === 0 && !running && (
            <div className="rounded-md border border-card-border/40 bg-glass-highlight/30 p-3 text-xs text-stat-subtitle">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
                <span>
                  Different nodes can have their own label rows. Stops are dispatched per node and report
                  per-stack results below.
                </span>
              </div>
            </div>
          )}

          {results.length > 0 && (
            <ResultsList title="Per-node breakdown" results={results} />
          )}
        </div>

        <ConfirmModal
          open={confirmOpen}
          onOpenChange={(open) => { if (!open) setConfirmOpen(false); }}
          variant="destructive"
          kicker="Fleet stop"
          title={`Stop all stacks labeled "${labelName.trim()}"?`}
          description="Sencho will stop every stack on every node that has a label with this name. Services will be unavailable until restarted."
          confirmLabel="Stop fleet"
          confirming={running}
          onConfirm={run}
        />
      </CardContent>
    </Card>
  );
}
