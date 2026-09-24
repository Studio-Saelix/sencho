import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Sparkline } from '@/components/ui/sparkline';
import { AlertCircle, ArrowUp, ArrowDown, ChevronRight, CircleArrowUp, Layers, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { SegmentedControl } from '@/components/ui/segmented-control';
import type { RowState } from './classifyRow';
import { updateAvailableLabel } from '@/lib/updateAvailableLabel';
import GitOpsBadge from '@/components/gitops/GitOpsBadge';
import { openGitOpsWorkplace } from '@/components/gitops/portfolio/portfolioNavigation';
import type { StackHealthCoverage, StackHealthNavTarget, StackHealthRow, StackHealthScopeMode, StackHealthViewKind } from './stackHealthTypes';
import { STACK_HEALTH_COLLAPSE_SIZE } from './useStackHealthScope';
import { DashboardPanel, PanelMeta } from './DashboardPanel';

interface StackHealthTableProps {
  scope: StackHealthScopeMode;
  onScopeChange: (scope: StackHealthScopeMode) => void;
  showScopeControl: boolean;
  view: StackHealthViewKind;
  viewError: string | null;
  rows: StackHealthRow[];
  coverage: StackHealthCoverage;
  incomplete: boolean;
  onRetry: () => void;
  onRetryFailedOrStale?: () => void;
  onNavigateToStack: (target: StackHealthNavTarget) => void;
}

type SortKey = 'stack' | 'up' | 'cpu' | 'mem';

const THIS_NODE_GRID = 'grid-cols-[minmax(0,1fr)_64px_64px_168px_56px_52px_52px_72px_110px_16px] min-w-[840px]';
const ALL_NODES_GRID = 'grid-cols-[minmax(0,1fr)_88px_64px_64px_168px_56px_52px_52px_72px_110px_16px] min-w-[940px]';

function formatMemory(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(0)} MB`;
}

function SortHeader({ label, k, sortKey, sortDir, onSort, align = 'left' }: {
  label: string;
  k: SortKey;
  sortKey: SortKey | null;
  sortDir: 'asc' | 'desc';
  onSort: (k: SortKey) => void;
  align?: 'left' | 'right';
}) {
  return (
    <span className={align === 'right' ? 'text-right' : undefined}>
      <button
        type="button"
        onClick={() => onSort(k)}
        aria-label={`Sort by ${label.toLowerCase()}${sortKey === k ? `, ${sortDir === 'asc' ? 'ascending' : 'descending'}` : ''}`}
        className={cn(
          'inline-flex items-center gap-1 rounded-sm uppercase tracking-[0.22em] transition-colors hover:text-stat-value focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50',
          sortKey === k && 'text-stat-value',
          align === 'right' && 'flex-row-reverse',
        )}
      >
        {label}
        {sortKey === k && (sortDir === 'asc' ? <ArrowUp className="h-2.5 w-2.5" /> : <ArrowDown className="h-2.5 w-2.5" />)}
      </button>
    </span>
  );
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--';
  const days = Math.floor(seconds / 86400);
  if (days > 0) return `${days}d`;
  const hours = Math.floor(seconds / 3600);
  if (hours > 0) return `${hours}h`;
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `${minutes}m`;
  return `${Math.max(1, Math.floor(seconds))}s`;
}

const rowTint: Record<RowState, string> = {
  healthy: '',
  warn: 'bg-warning/[0.04]',
  error: 'bg-destructive/[0.04]',
};

const sparkStroke: Record<RowState, string> = {
  healthy: 'var(--chart-1)',
  warn: 'var(--warning)',
  error: 'var(--destructive)',
};

function NetworksCell({ networks }: { networks?: string[] }) {
  if (!networks || networks.length === 0) return <>--</>;
  const [first, ...rest] = networks;
  return (
    <span className="block min-w-0 truncate" title={rest.length > 0 ? networks.join(', ') : undefined}>
      {first}
      {rest.length > 0 ? <span className="text-stat-subtitle">{` +${rest.length}`}</span> : null}
    </span>
  );
}

function coverageLabel(scope: StackHealthScopeMode, coverage: StackHealthCoverage): string {
  const stackWord = coverage.n === 1 ? 'stack' : 'stacks';
  if (scope === 'this-node') {
    return `${coverage.n} ${stackWord}`;
  }
  if (coverage.k === coverage.m) {
    return `${coverage.n} ${stackWord} · ${coverage.m} nodes`;
  }
  return `${coverage.n} ${stackWord} · ${coverage.k}/${coverage.m} nodes reporting`;
}

export function StackHealthTable({
  scope,
  onScopeChange,
  showScopeControl,
  view,
  viewError,
  rows,
  coverage,
  incomplete,
  onRetry,
  onRetryFailedOrStale,
  onNavigateToStack,
}: StackHealthTableProps) {
  const [expanded, setExpanded] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    setExpanded(false);
  }, [scope]);

  const grid = scope === 'all-nodes' ? ALL_NODES_GRID : THIS_NODE_GRID;

  const sortedRows = useMemo(() => {
    const list = [...rows];
    if (sortKey === null) {
      const stateOrder: Record<RowState, number> = { error: 0, warn: 1, healthy: 2 };
      list.sort((a, b) => {
        const diff = stateOrder[a.state] - stateOrder[b.state];
        if (diff !== 0) return diff;
        return b.peakCpu - a.peakCpu;
      });
      return list;
    }
    const dir = sortDir === 'asc' ? 1 : -1;
    const nowSecs = now / 1000;
    const uptime = (rs: number | null) => (rs !== null ? nowSecs - rs : -1);
    list.sort((a, b) => {
      switch (sortKey) {
        case 'stack': return a.name.localeCompare(b.name) * dir;
        case 'up': return (uptime(a.runningSince) - uptime(b.runningSince)) * dir;
        case 'cpu': return ((a.cpu ?? -1) - (b.cpu ?? -1)) * dir;
        case 'mem': return ((a.memory ?? -1) - (b.memory ?? -1)) * dir;
        default: { const _exhaustive: never = sortKey; return _exhaustive; }
      }
    });
    return list;
  }, [rows, sortKey, sortDir, now]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'stack' ? 'asc' : 'desc'); }
  };

  const visibleRows = expanded ? sortedRows : sortedRows.slice(0, STACK_HEALTH_COLLAPSE_SIZE);
  const needsExpansion = sortedRows.length > STACK_HEALTH_COLLAPSE_SIZE;

  const panel = (body: ReactNode, footer?: ReactNode) => (
    <DashboardPanel
      title="Stack health"
      meta={(
        <>
          {view === 'ready' || view === 'empty' ? (
            <PanelMeta>
              {coverageLabel(scope, coverage)}{sortKey === null && view === 'ready' ? ' · sorted by load' : ''}
            </PanelMeta>
          ) : null}
          {incomplete && onRetryFailedOrStale ? (
            <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={onRetryFailedOrStale}>
              Retry
            </Button>
          ) : null}
        </>
      )}
      actions={showScopeControl ? (
        <SegmentedControl
          ariaLabel="Stack health node scope"
          className="max-md:[&_button]:min-h-11"
          value={scope}
          onChange={onScopeChange}
          options={[
            { value: 'this-node', label: 'This node' },
            { value: 'all-nodes', label: 'All nodes' },
          ]}
        />
      ) : undefined}
      footer={footer}
    >
      {body}
    </DashboardPanel>
  );

  if (view === 'loading') {
    return panel(
      <div className="space-y-3 px-5 pb-5">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (view === 'unavailable') {
    return panel(
      <div className="flex flex-col items-center justify-center gap-3 py-10 text-stat-subtitle">
        <AlertCircle className="h-8 w-8 text-stat-icon" strokeWidth={1.5} aria-hidden />
        <p className="px-4 text-center text-sm">
          {viewError ?? 'Could not load stack health.'}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" />
          Retry
        </Button>
      </div>
    );
  }

  if (view === 'empty') {
    return panel(
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-stat-subtitle">
        <Layers className="h-8 w-8 text-stat-icon" strokeWidth={1.5} aria-hidden />
        <p className="text-sm">No stacks found. Create one from the sidebar.</p>
      </div>
    );
  }

  return panel(
    <div className="overflow-x-auto">
      <div className={`grid ${grid} items-center gap-4 border-t border-border/60 px-[var(--density-row-x)] py-[var(--density-cell-y)] font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle`}>
        <SortHeader label="STACK" k="stack" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
        {scope === 'all-nodes' ? <span>NODE</span> : null}
        <span>STATE</span>
        <span>SOURCE</span>
        <span>NETWORKS</span>
        <span>PORT</span>
        <SortHeader label="UP" k="up" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
        <SortHeader label="CPU" k="cpu" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
        <SortHeader label="MEM" k="mem" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
        <span className="text-right">CPU · 10m</span>
        <span />
      </div>
      <ul className="divide-y divide-border/40">
        {visibleRows.map((row) => {
          const updateLabel = row.hasUpdate ? updateAvailableLabel(row.outdatedServices) : null;
          const openStack = () => onNavigateToStack({ node: row.node, file: row.file });
          return (
            <li
              key={row.key}
              data-node-id={row.node.id}
              onClick={openStack}
              title={row.freshness === 'stale' ? 'Status data is stale' : undefined}
              className={cn(
                `grid ${grid} cursor-pointer items-center gap-4 px-[var(--density-row-x)] py-[var(--density-row-y)] transition-colors hover:bg-accent/5 focus-within:bg-accent/5`,
                rowTint[row.state],
                row.freshness === 'stale' && 'opacity-50',
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <button
                  type="button"
                  className="min-w-0 truncate rounded-sm text-left font-mono text-sm text-stat-value focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
                >
                  {row.name}
                </button>
                {updateLabel && (
                  <span className="shrink-0" title={updateLabel}>
                    <CircleArrowUp
                      className="h-3.5 w-3.5 text-brand"
                      strokeWidth={2}
                      aria-label={updateLabel}
                    />
                  </span>
                )}
                {row.gitopsSourceState && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openGitOpsWorkplace();
                    }}
                    aria-label="Open the GitOps portfolio"
                    className="shrink-0 cursor-pointer"
                  >
                    <GitOpsBadge facet="source" status={row.gitopsSourceState} />
                  </button>
                )}
              </span>
              {scope === 'all-nodes' ? (
                <span className="truncate font-mono text-[11px] text-stat-subtitle">{row.node.name}</span>
              ) : null}
              <span className="truncate font-mono text-[11px] uppercase tracking-wide text-stat-subtitle">
                {row.status}
              </span>
              <span className="truncate font-mono text-[11px] uppercase tracking-wide text-stat-subtitle">
                {row.source === 'git' ? 'Git' : 'Local'}
              </span>
              <span className="min-w-0 overflow-hidden font-mono text-xs text-stat-subtitle">
                <NetworksCell networks={row.networks} />
              </span>
              <span className="truncate font-mono text-xs tabular-nums text-stat-subtitle">
                {row.mainPort !== null ? row.mainPort : '--'}
              </span>
              <span className="text-right font-mono text-xs tabular-nums text-stat-subtitle">
                {row.runningSince !== null
                  ? formatUptime(Math.max(0, Math.floor(now / 1000 - row.runningSince)))
                  : '--'}
              </span>
              <span className="text-right font-mono text-xs tabular-nums text-stat-subtitle">
                {row.cpu !== null ? `${row.cpu.toFixed(0)}%` : '--'}
              </span>
              <span className="text-right font-mono text-xs tabular-nums text-stat-subtitle">
                {row.memory !== null ? formatMemory(row.memory) : '--'}
              </span>
              <span className="ml-auto block h-5 w-[110px]">
                {row.series.length > 1 ? (
                  <Sparkline
                    points={row.series}
                    stroke={sparkStroke[row.state]}
                    fill={sparkStroke[row.state]}
                    peakColor="var(--chart-2)"
                    peakIndex={row.peakIndex >= 0 ? row.peakIndex : undefined}
                    showPeak={row.state !== 'healthy'}
                  />
                ) : (
                  <span className="block h-full w-full border-b border-dashed border-border/60" />
                )}
              </span>
              <span title="Open in Editor" aria-hidden>
                <ChevronRight className="h-3.5 w-3.5 text-stat-icon" strokeWidth={1.5} />
              </span>
            </li>
          );
        })}
      </ul>
    </div>,
    needsExpansion ? (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? 'Show less' : `Show all ${sortedRows.length} stacks`}
      </Button>
    ) : undefined,
  );
}

