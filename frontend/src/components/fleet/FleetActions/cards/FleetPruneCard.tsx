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
import { ResultsList, type ResultRow } from '../ResultsList';

type PruneTarget = 'images' | 'volumes' | 'networks';
type PruneScope = 'managed' | 'all';

const ALL_TARGETS: ReadonlyArray<{ id: PruneTarget; label: string }> = [
  { id: 'images', label: 'Images' },
  { id: 'volumes', label: 'Volumes' },
  { id: 'networks', label: 'Networks' },
];

interface TargetResult { target: PruneTarget; success: boolean; reclaimedBytes: number; error?: string; dryRun?: boolean }
interface FleetPruneNodeResult {
  nodeId: number; nodeName: string; reachable: boolean; error?: string; targets: TargetResult[];
}

interface PruneEstimateNode { nodeId: number; nodeName: string; reclaimableBytes: number; reachable: boolean; error?: string }
interface PruneEstimateResponse { totalBytes: number; perNode: PruneEstimateNode[] }

type EstimateState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; data: PruneEstimateResponse };

interface Props {
  nodes: FleetNode[];
}

const KICKER = 'font-mono text-[10px] uppercase tracking-[0.18em]';
const ESTIMATE_ROW_LIMIT = 6;

export function FleetPruneCard({ nodes }: Props) {
  const nodeCount = nodes.length;
  const [targets, setTargets] = useState<Set<PruneTarget>>(new Set(['images']));
  const [scope, setScope] = useState<PruneScope>('managed');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [estimate, setEstimate] = useState<EstimateState>({ kind: 'idle' });

  const toggleTarget = (target: PruneTarget) => {
    setTargets(prev => {
      const next = new Set(prev);
      if (next.has(target)) next.delete(target);
      else next.add(target);
      return next;
    });
  };

  // Re-estimate when the operator's choices change. Debounced because each
  // tick fans out per-target HTTP to every remote node; back-to-back clicks
  // on the target checkboxes would otherwise pile concurrent fleet-wide fans
  // onto the backend.
  const estimateDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (estimateDebounceRef.current) clearTimeout(estimateDebounceRef.current);
    if (targets.size === 0) {
      setEstimate({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setEstimate({ kind: 'loading' });
    estimateDebounceRef.current = setTimeout(async () => {
      try {
        const res = await apiFetch('/fleet/prune/estimate', {
          method: 'POST',
          body: JSON.stringify({ targets: Array.from(targets), scope }),
        });
        if (cancelled) return;
        if (res.status === 404 || !res.ok) {
          setEstimate({ kind: 'unavailable' });
          return;
        }
        const data = (await res.json()) as PruneEstimateResponse;
        if (!cancelled) setEstimate({ kind: 'ready', data });
      } catch {
        if (!cancelled) setEstimate({ kind: 'unavailable' });
      }
    }, 350);
    return () => {
      cancelled = true;
      if (estimateDebounceRef.current) clearTimeout(estimateDebounceRef.current);
    };
  }, [targets, scope]);

  async function run(opts: { dryRun: boolean }) {
    if (targets.size === 0) return;
    const selected = Array.from(targets);
    const verb = opts.dryRun ? 'Dry-running prune of' : 'Pruning';
    const toastId = toast.loading(`${verb} ${selected.join(', ')} across the fleet…`);
    setRunning(true);
    setResults([]);
    try {
      const res = await apiFetch('/fleet/labels/fleet-prune', {
        method: 'POST',
        body: JSON.stringify({ targets: selected, scope, dryRun: opts.dryRun }),
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
            ? `${node.nodeName} · ${formatBytes(totalBytes)}${opts.dryRun ? ' (dry run)' : ''}`
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
      if (opts.dryRun) {
        toast.success(`Dry run: ${formatBytes(totalReclaimed)} would be reclaimed across ${totalNodes} node${totalNodes === 1 ? '' : 's'}.`);
      } else if (okNodes === totalNodes && totalNodes > 0) {
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

  const isAllScope = scope === 'all';

  const blastValue = useMemo(() => {
    if (targets.size === 0) return 'awaiting target';
    if (estimate.kind === 'loading') return '~ estimating…';
    if (estimate.kind === 'unavailable') return '~ estimate unavailable';
    if (estimate.kind === 'ready') {
      const { totalBytes } = estimate.data;
      if (totalBytes === 0) return '0 reclaimable';
      return `~ ${formatBytes(totalBytes)} reclaimable`;
    }
    return 'awaiting target';
  }, [targets.size, estimate]);

  const blastTone = estimate.kind === 'loading' || estimate.kind === 'unavailable' ? 'muted' as const : undefined;

  return (
    <>
      <FleetActionCard
        crumb={['Fleet', 'Actions', 'Prune resources']}
        name="Prune fleet-wide."
        meta="images · volumes · networks · serial per node"
        actionClass="maintenance"
        blastRadius={{ value: blastValue, tone: blastTone }}
        secondaryAction={{
          label: running ? 'Running…' : 'Dry run',
          onClick: () => run({ dryRun: true }),
          disabled: running || targets.size === 0,
        }}
        primaryAction={{
          label: 'Prune fleet',
          onClick: () => setConfirmOpen(true),
          variant: 'destructive',
          // Block the destructive confirm until the operator has actually
          // seen what the readout says will be reclaimed. Falling back to a
          // confirm modal with no estimate context is the audit §F20.3 problem.
          disabled: running || targets.size === 0 || estimate.kind !== 'ready',
        }}
        footerContext={`Reversible · no · serial across ${nodeCount} node${nodeCount === 1 ? '' : 's'}`}
      >
        <SheetSection
          title={`Targets · ${targets.size} / ${ALL_TARGETS.length}`}
          meta={targets.size === 0 ? 'pick at least one' : undefined}
        >
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
        </SheetSection>

        <SheetSection title="Scope" meta={scope === 'managed' ? 'sencho-owned only' : 'all unused'}>
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
          <p className="mt-2 text-[11px] text-stat-subtitle">
            {scope === 'managed'
              ? 'Restricts to resources owned by stacks Sencho manages.'
              : 'Removes every unused resource, including workloads Sencho does not manage.'}
          </p>
        </SheetSection>

        {targets.size > 0 && <EstimateSection estimate={estimate} />}

        {results.length > 0 && (
          <SheetSection title="Per-node breakdown">
            <ResultsList results={results} />
          </SheetSection>
        )}
      </FleetActionCard>

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
        onConfirm={() => run({ dryRun: false })}
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
  const { perNode } = estimate.data;
  const visible = perNode.slice(0, ESTIMATE_ROW_LIMIT);
  const remaining = perNode.length - visible.length;
  return (
    <SheetSection title="Estimate · per node" meta={`${perNode.length} node${perNode.length === 1 ? '' : 's'}`}>
      <div className="rounded border border-card-border/60 bg-card/40 shadow-[inset_0_2px_4px_0_oklch(0_0_0_/_0.35)] p-2">
        <ul className="space-y-1">
          {visible.map((n) => (
            <li key={n.nodeId} className="flex items-center gap-2">
              <span className={cn(
                KICKER,
                'inline-flex items-center px-1 py-0.5 rounded-sm border shrink-0',
                n.reachable
                  ? 'border-success/40 bg-success/10 text-success'
                  : 'border-stat-subtitle/40 bg-card text-stat-subtitle',
              )}>
                {n.reachable ? 'OK' : '--'}
              </span>
              <span className="flex-1 min-w-0 truncate font-mono text-[11px] text-stat-value">{n.nodeName}</span>
              <span className={cn(KICKER, 'shrink-0 tabular-nums', n.reachable ? 'text-stat-subtitle' : 'text-stat-icon')}>
                {n.reachable ? formatBytes(n.reclaimableBytes) : (n.error ?? 'unreachable')}
              </span>
            </li>
          ))}
          {remaining > 0 && (
            <li className={cn(KICKER, 'text-stat-icon pt-1')}>
              + {remaining} more node{remaining === 1 ? '' : 's'}
            </li>
          )}
        </ul>
      </div>
    </SheetSection>
  );
}
