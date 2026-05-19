import { useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Loader2, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmModal } from '@/components/ui/modal';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { cn, formatBytes } from '@/lib/utils';
import type { FleetNode } from '@/components/FleetView/types';
import { ResultsList, type ResultRow } from '../ResultsList';
import { TONE_RAIL, TONE_BG, type AccentTone } from './tone';

type PruneTarget = 'images' | 'volumes' | 'networks';
type PruneScope = 'managed' | 'all';

const ALL_TARGETS: ReadonlyArray<{ id: PruneTarget; label: string }> = [
  { id: 'images', label: 'Images' },
  { id: 'volumes', label: 'Volumes' },
  { id: 'networks', label: 'Networks' },
];

interface TargetResult { target: PruneTarget; success: boolean; reclaimedBytes: number; error?: string }
interface FleetPruneNodeResult {
  nodeId: number; nodeName: string; reachable: boolean; error?: string; targets: TargetResult[];
}

interface Props {
  nodes: FleetNode[];
  icon: LucideIcon;
  accentTone: AccentTone;
}

export function FleetPruneCard({ nodes, icon: Icon, accentTone }: Props) {
  const nodeCount = nodes.length;
  const [targets, setTargets] = useState<Set<PruneTarget>>(new Set(['images']));
  const [scope, setScope] = useState<PruneScope>('managed');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ResultRow[]>([]);

  const toggleTarget = (target: PruneTarget) => {
    setTargets(prev => {
      const next = new Set(prev);
      if (next.has(target)) next.delete(target);
      else next.add(target);
      return next;
    });
  };

  async function run() {
    if (targets.size === 0) return;
    const selected = Array.from(targets);
    const toastId = toast.loading(`Pruning ${selected.join(', ')} across the fleet…`);
    setRunning(true);
    setResults([]);
    try {
      const res = await apiFetch('/fleet/labels/fleet-prune', {
        method: 'POST',
        body: JSON.stringify({ targets: selected, scope }),
      });
      const body = await res.json().catch(() => ({}));
      toast.dismiss(toastId);
      if (!res.ok) {
        toast.error(body.error || 'Fleet prune failed');
        return;
      }
      const apiResults = (body.results as FleetPruneNodeResult[]) ?? [];
      const rows: ResultRow[] = apiResults.map((node) => {
        const totalBytes = node.targets.reduce((sum, t) => sum + (t.reclaimedBytes ?? 0), 0);
        const allOk = node.reachable && node.targets.every(t => t.success);
        return {
          key: `node-${node.nodeId}`,
          label: node.reachable
            ? `${node.nodeName} · ${formatBytes(totalBytes)}`
            : `${node.nodeName} (unreachable)`,
          success: allOk,
          error: node.reachable ? undefined : node.error,
          sub: node.targets.map((t, i) => ({
            key: `${node.nodeId}-${t.target}-${i}`,
            label: `${t.target} · ${formatBytes(t.reclaimedBytes ?? 0)}`,
            success: t.success,
            error: t.error,
          })),
        };
      });
      setResults(rows);
      const totalNodes = apiResults.length;
      const okNodes = apiResults.filter(n => n.reachable && n.targets.every(t => t.success)).length;
      const totalReclaimed = apiResults.reduce(
        (sum, n) => sum + n.targets.reduce((s, t) => s + (t.reclaimedBytes ?? 0), 0),
        0,
      );
      if (okNodes === totalNodes && totalNodes > 0) {
        toast.success(`Reclaimed ${formatBytes(totalReclaimed)} across ${totalNodes} node${totalNodes === 1 ? '' : 's'}.`);
      } else if (okNodes === 0) {
        toast.error('Prune failed on every node. See results below.');
      } else {
        toast.warning(`${okNodes}/${totalNodes} nodes succeeded · ${formatBytes(totalReclaimed)} reclaimed. See results below.`);
      }
    } catch (err) {
      toast.dismiss(toastId);
      toast.error(err instanceof Error ? err.message : 'Network error');
    } finally {
      setRunning(false);
      setConfirmOpen(false);
    }
  }

  const targetCount = targets.size;
  const isAllScope = scope === 'all';

  return (
    <Card className="relative overflow-hidden bg-card shadow-card-bevel">
      <span aria-hidden className={cn('absolute inset-y-0 left-0 w-[3px]', TONE_RAIL[accentTone])} />
      <CardContent className="p-6">
        <div className="flex items-start gap-3 mb-4">
          <span className={cn('inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md', TONE_BG[accentTone])}>
            <Icon className="h-5 w-5" strokeWidth={1.5} />
          </span>
          <div className="flex-1">
            <h3 className="text-base font-medium text-stat-value">Prune Docker resources fleet-wide</h3>
            <p className="mt-1 text-xs text-stat-subtitle">
              Reclaim space on {nodeCount} node{nodeCount === 1 ? '' : 's'} by removing unused images, volumes, and networks. Reclaimed bytes are approximate.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-stat-subtitle mb-1.5">Targets</div>
            <div className="flex flex-wrap gap-3">
              {ALL_TARGETS.map(t => (
                <label
                  key={t.id}
                  className="flex items-center gap-2 py-1 px-2 rounded hover:bg-glass-highlight cursor-pointer"
                >
                  <Checkbox
                    checked={targets.has(t.id)}
                    onCheckedChange={() => toggleTarget(t.id)}
                    disabled={running}
                  />
                  <span className="text-xs text-stat-value">{t.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wide text-stat-subtitle mb-1.5">Scope</div>
            <div className="inline-flex rounded-md border border-card-border/60 overflow-hidden">
              <Button
                type="button"
                variant={scope === 'managed' ? 'default' : 'outline'}
                size="sm"
                disabled={running}
                onClick={() => setScope('managed')}
                className="rounded-none border-0 h-8 px-3 text-xs"
              >
                Managed only
              </Button>
              <Button
                type="button"
                variant={scope === 'all' ? 'default' : 'outline'}
                size="sm"
                disabled={running}
                onClick={() => setScope('all')}
                className="rounded-none border-0 h-8 px-3 text-xs"
              >
                All unused
              </Button>
            </div>
            <p className="mt-1.5 text-[11px] text-stat-subtitle">
              {scope === 'managed'
                ? 'Restricts to resources owned by stacks Sencho manages.'
                : 'Removes every unused resource, including workloads Sencho does not manage.'}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={running || targetCount === 0}
              onClick={() => setConfirmOpen(true)}
              className="gap-2"
            >
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} /> : <Icon className="h-3.5 w-3.5" strokeWidth={1.5} />}
              Prune across fleet
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
                  Prune is destructive and cannot be undone. Each target is run serially per node; reclaimed bytes appear per node and per target below.
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
          kicker="Fleet prune"
          title={isAllScope ? 'Prune ALL unused resources across the fleet?' : 'Prune managed resources across the fleet?'}
          description={
            isAllScope
              ? 'This runs docker prune --all on every reachable node. Any image, volume, or network not currently in use will be deleted, including resources from workloads Sencho does not manage. This cannot be undone.'
              : 'Sencho will remove unused Docker resources owned by stacks known to this fleet on every reachable node. Active resources are not touched.'
          }
          confirmLabel={isAllScope ? 'Prune everything unused' : 'Prune managed'}
          confirming={running}
          onConfirm={run}
        />
      </CardContent>
    </Card>
  );
}
