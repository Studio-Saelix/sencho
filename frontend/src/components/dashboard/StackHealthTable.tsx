import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sparkline } from '@/components/ui/sparkline';
import { ChevronLeft, ChevronRight, Layers } from 'lucide-react';
import type { StackStatusEntry, MetricPoint, StackCpuSeries } from './types';
import { aggregateCurrentUsage } from './aggregateCurrentUsage';
import { classifyRow, type RowState } from './classifyRow';

interface StackHealthTableProps {
  stackStatuses: Record<string, StackStatusEntry>;
  metrics: MetricPoint[];
  stackCpuSeries: Record<string, StackCpuSeries>;
  activeNodeName: string;
  onNavigateToStack: (stackFile: string) => void;
}

const PAGE_SIZE = 8;
// Shared by the header and data rows so their columns stay aligned. The
// `max-md:min-w` keeps both at the same width below md, where the card scrolls
// horizontally; desktop is unaffected by the `max-md:` prefix.
const GRID_TEMPLATE = 'grid-cols-[14px_minmax(0,1fr)_minmax(0,120px)_52px_52px_72px_110px_16px] max-md:min-w-[600px]';

const formatMemory = (mb: number): string => {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(0)} MB`;
};

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

const stateDot: Record<RowState, string> = {
  healthy: 'bg-success',
  warn: 'bg-warning',
  error: 'bg-destructive',
};

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

export function StackHealthTable({
  stackStatuses,
  metrics,
  stackCpuSeries,
  activeNodeName,
  onNavigateToStack,
}: StackHealthTableProps) {
  const [page, setPage] = useState(0);
  // Live-tick the current second so uptime labels advance without a parent
  // refetch. Thirty-second cadence keeps the DOM calm while still refreshing
  // every "Nm" bucket change.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  const stackAggregates = useMemo(() => aggregateCurrentUsage(metrics), [metrics]);

  const rows = useMemo(() => {
    const list = Object.entries(stackStatuses).map(([file, entry]) => {
      const name = file.replace(/\.(yml|yaml)$/, '');
      const agg = stackAggregates[name];
      const series = stackCpuSeries[name];
      const peakCpu = series?.peakValue ?? agg?.cpu ?? 0;
      const state = classifyRow(entry.status, peakCpu);
      return {
        file,
        name,
        status: entry.status,
        memory: agg?.mem ?? null,
        cpu: agg?.cpu ?? null,
        peakCpu,
        series: series?.points ?? [],
        peakIndex: series?.peakIndex ?? -1,
        state,
        runningSince: entry.runningSince ?? null,
      };
    });
    const stateOrder: Record<RowState, number> = { error: 0, warn: 1, healthy: 2 };
    list.sort((a, b) => {
      const diff = stateOrder[a.state] - stateOrder[b.state];
      if (diff !== 0) return diff;
      return b.peakCpu - a.peakCpu;
    });
    return list;
  }, [stackStatuses, stackAggregates, stackCpuSeries]);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pagedRows = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const needsPagination = rows.length > PAGE_SIZE;

  const stackCount = Object.keys(stackStatuses).length;

  if (stackCount === 0) {
    return (
      <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel py-10">
        <div className="flex flex-col items-center justify-center gap-2 text-stat-subtitle">
          <Layers className="h-8 w-8 text-stat-icon" strokeWidth={1.5} />
          <p className="text-sm">No stacks found. Create one from the sidebar.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel max-md:overflow-x-auto">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex items-baseline gap-3">
          <h2 className="font-heading text-xl leading-none tracking-tight text-stat-value">
            Stack health
          </h2>
          <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-stat-subtitle">
            {stackCount} {stackCount === 1 ? 'stack' : 'stacks'} · sorted by load
          </span>
        </div>
        {needsPagination ? (
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              disabled={safePage === 0}
              onClick={() => setPage(safePage - 1)}
            >
              <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
            </Button>
            <span className="text-xs font-mono tabular-nums text-stat-subtitle min-w-[3rem] text-center">
              {safePage + 1} / {totalPages}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              disabled={safePage >= totalPages - 1}
              onClick={() => setPage(safePage + 1)}
            >
              <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} />
            </Button>
          </div>
        ) : null}
      </div>
      <div className={`grid ${GRID_TEMPLATE} items-center gap-4 border-t border-border/60 px-[var(--density-row-x)] py-[var(--density-cell-y)] font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle`}>
        <span />
        <span>STACK</span>
        <span>HOST</span>
        <span className="text-right">UP</span>
        <span className="text-right">CPU</span>
        <span className="text-right">MEM</span>
        <span className="text-right">CPU · 10m</span>
        <span />
      </div>
      <ul className="divide-y divide-border/40">
        {pagedRows.map((row) => (
          <li
            key={row.file}
            role="button"
            tabIndex={0}
            onClick={() => onNavigateToStack(row.file)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onNavigateToStack(row.file);
              }
            }}
            className={`grid ${GRID_TEMPLATE} cursor-pointer items-center gap-4 px-[var(--density-row-x)] py-[var(--density-row-y)] transition-colors hover:bg-accent/5 ${rowTint[row.state]}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full justify-self-center ${stateDot[row.state]}`} aria-hidden="true" />
            <span className="truncate font-mono text-sm text-stat-value">{row.name}</span>
            <span className="truncate font-mono text-xs text-stat-subtitle">{activeNodeName}</span>
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
            <ChevronRight className="h-3.5 w-3.5 text-stat-icon" strokeWidth={1.5} />
          </li>
        ))}
      </ul>
    </div>
  );
}
