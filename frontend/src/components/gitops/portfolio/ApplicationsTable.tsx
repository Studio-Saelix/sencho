import { Activity, Check, ChevronLeft, ChevronRight, CircleHelp, CircleSlash, Clock, ExternalLink, XCircle } from 'lucide-react';
import {
  RUNTIME_STATE_LOOKUP,
  SOURCE_STATE_LOOKUP,
  type GitOpsStateMeta,
  type GitOpsTone,
} from '@/lib/gitopsState';
import { attentionLabel, POSTURE_TONE_CLASS } from '@/lib/gitopsPortfolio';
import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/lib/utils';
import type { GitOpsPortfolioRow } from '@/types/gitopsPortfolio';
import { openPortfolioApplication } from './portfolioNavigation';

/** Health facet words, which predate the gitopsState vocabulary and have no lookup there. */
const HEALTH_STATE: Partial<Record<string, GitOpsStateMeta>> = {
  passed: { label: 'healthy', tone: 'success', line: 'The last health check passed.', icon: Check },
  failed: { label: 'failing', tone: 'destructive', line: 'The health check is failing.', icon: XCircle },
  pending: { label: 'health pending', tone: 'neutral', line: 'No health run has settled yet.', icon: Clock },
  checking: { label: 'checking', tone: 'brand', line: 'A health run is watching the deploy.', icon: Activity },
  unknown: { label: 'unknown', tone: 'warning', line: 'Health evidence could not be proven.', icon: CircleHelp },
  unbound: { label: 'unbound', tone: 'neutral', line: 'No health gate is bound to this target.', icon: CircleSlash },
};

/**
 * One facet status, as the row's cell-sized chip.
 *
 * Reads through the shared partial lookups: a status this build does not know
 * (a newer node's vocabulary) renders as the raw status in neutral mono, not
 * as a blank or a guess. That is the same forward-compat rule GitOpsBadge
 * carries for stack rows.
 */
function FacetChip({ status, lookup }: { status: string; lookup?: Partial<Record<string, GitOpsStateMeta>> }) {
  const meta: GitOpsStateMeta | undefined = lookup?.[status];
  if (status === 'not_applicable') {
    return <span className="font-mono text-[11px] text-stat-icon">--</span>;
  }
  const tone: GitOpsTone = meta?.tone ?? 'neutral';
  const label = meta?.label ?? status.replace(/_/g, ' ');
  return (
    <span
      title={meta?.line}
      className={cn(
        'inline-block max-w-full truncate rounded-md border px-1.5 py-0.5 font-mono text-[10px] leading-4',
        tone === 'success' && 'border-success/40 bg-success/[0.06] text-success',
        tone === 'brand' && 'border-brand/40 bg-brand/[0.06] text-brand',
        tone === 'warning' && 'border-warning/40 bg-warning/[0.06] text-warning',
        tone === 'destructive' && 'border-destructive/40 bg-destructive/[0.06] text-destructive',
        tone === 'neutral' && 'border-card-border bg-card/40 text-stat-subtitle',
      )}
    >
      {label}
    </span>
  );
}

/** Where the application runs, in one line. */
function TargetCell({ row }: { row: GitOpsPortfolioRow }) {
  if (row.targetMode === 'direct') {
    return (
      <span className="block min-w-0">
        <span className="block truncate font-mono text-[11px] text-stat-value">{row.nodeName ?? `node ${row.nodeId}`}</span>
        <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-stat-icon">direct</span>
      </span>
    );
  }
  return (
    <span className="block min-w-0">
      <span className="block truncate font-mono text-[11px] text-stat-value">
        {row.targets.length} target{row.targets.length === 1 ? '' : 's'}
      </span>
      <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-stat-icon">blueprint</span>
    </span>
  );
}

const GRID_COLS = 'grid-cols-[20px_minmax(140px,1.3fr)_minmax(150px,1.1fr)_92px_110px_110px_110px_90px_72px_minmax(150px,1fr)_96px_20px]';

export function ApplicationsTable({
  rows,
  nextCursor,
  onPrevPage,
  onNextPage,
  pageLoaded,
  onDrillDown,
}: {
  rows: GitOpsPortfolioRow[];
  nextCursor: string | null;
  onPrevPage: () => void;
  onNextPage: () => void;
  pageLoaded: number;
  onDrillDown?: (row: GitOpsPortfolioRow) => void;
}) {
  const open = (row: GitOpsPortfolioRow) => (onDrillDown ? onDrillDown(row) : openPortfolioApplication(row));

  return (
    <section
      aria-label="GitOps applications"
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel"
    >
      {/* The header scrolls with the rows so it stays visible at the column
          count's minimum width instead of being clipped by the card. */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className={cn('sticky top-0 z-10 grid items-center gap-2 border-b border-card-border/70 bg-card px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle min-w-[1180px]', GRID_COLS)}>
          <span aria-hidden />
          <span>Application</span>
          <span>Repository · ref</span>
          <span>Target</span>
          <span>Source</span>
          <span>Rollout</span>
          <span>Runtime</span>
          <span>Health</span>
          <span>Drift</span>
          <span>Attention</span>
          <span>Last activity</span>
          <span aria-hidden />
        </div>

        {rows.length === 0 ? (
          <div className="flex h-full min-h-[200px] items-center justify-center p-10 text-center">
            <div>
              <p className="font-heading text-xl text-stat-value">Nothing here</p>
              <p className="mt-1 font-mono text-xs text-stat-subtitle">
                No GitOps application matches the current filters.
              </p>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-card-border/50">
            {rows.map(row => <ApplicationRow key={row.id} row={row} onOpen={() => open(row)} />)}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-card-border/70 px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
          Page {pageLoaded}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onPrevPage}
            disabled={pageLoaded <= 1}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-card-border text-stat-subtitle transition-colors hover:text-stat-value disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Previous page"
          >
            <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
          <button
            type="button"
            onClick={onNextPage}
            disabled={nextCursor === null}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-card-border text-stat-subtitle transition-colors hover:text-stat-value disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Next page"
          >
            <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </section>
  );
}

function ApplicationRow({ row, onOpen }: { row: GitOpsPortfolioRow; onOpen: () => void }) {
  const openingPossible = row.targetMode === 'direct'
    ? row.nodeId !== null && row.stackName !== null
    : row.blueprintId !== null;

  const failureAttention = row.attention.some(reason => attentionLabel(reason).tone === 'destructive');
  const rowTint = row.attention.length === 0
    ? ''
    : failureAttention ? 'bg-destructive/[0.04]' : 'bg-warning/[0.04]';

  return (
    <li>
      <button
        type="button"
        onClick={openingPossible ? onOpen : undefined}
        disabled={!openingPossible}
        className={cn(
          'group grid w-full min-w-[1180px] items-center gap-2 px-3 py-2 text-left transition-colors',
          GRID_COLS,
          rowTint,
          openingPossible && 'hover:bg-accent/40',
          !openingPossible && 'cursor-default',
        )}
      >
        <span aria-hidden className={cn(
          'h-2 w-2 rounded-full',
          row.posture === 'failed' && 'bg-destructive shadow-[0_0_6px_0_var(--destructive)]',
          row.posture === 'attention' && 'bg-warning shadow-[0_0_6px_0_var(--warning)]',
          row.posture === 'in_progress' && 'bg-brand',
          row.posture === 'converged' && 'bg-success',
          row.posture === 'converged_qualified' && 'bg-success/70',
          row.posture === 'unknown' && 'bg-stat-icon',
        )} />

        <span className="min-w-0">
          <span className="block truncate font-mono text-xs font-medium text-stat-value">{row.name}</span>
          <span className="block truncate font-mono text-[10px] text-stat-icon">
            {row.stackName ?? (row.blueprintId !== null ? `blueprint #${row.blueprintId}` : '')}
          </span>
        </span>

        <span className="min-w-0">
          {row.repository ? (
            <>
              <span className="block truncate font-mono text-[11px] text-stat-title">
                {row.repository.host}{row.repository.pathname}
              </span>
              <span className="block truncate font-mono text-[10px] text-stat-subtitle">
                {row.repository.configuredRef}
                {row.fetchedCommitSha ? ` · ${row.fetchedCommitSha.slice(0, 7)}` : ''}
              </span>
            </>
          ) : (
            <span className="font-mono text-[11px] text-stat-icon">--</span>
          )}
        </span>

        <TargetCell row={row} />

        <FacetChip status={row.sourceStatus} lookup={SOURCE_STATE_LOOKUP} />
        <FacetChip status={row.rolloutStatus} lookup={RUNTIME_STATE_LOOKUP} />
        <FacetChip status={row.runtimeStatus} lookup={RUNTIME_STATE_LOOKUP} />
        <FacetChip status={row.healthStatus} lookup={HEALTH_STATE} />

        <span className="min-w-0">
          {row.drift.count > 0 ? (
            <span className="font-mono text-[11px] text-warning">
              {row.drift.count} {row.drift.count === 1 ? 'item' : 'items'}
              <span className="block truncate text-[10px] text-stat-subtitle">{row.drift.classes.join(' · ')}</span>
            </span>
          ) : (
            <span className="font-mono text-[11px] text-stat-icon">none</span>
          )}
        </span>

        <span className="flex min-w-0 flex-wrap gap-1">
          {row.attention.slice(0, 2).map(reason => {
            const label = attentionLabel(reason);
            return (
              <span
                key={reason}
                title={label.line}
                className={cn(
                  'truncate rounded border px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.08em]',
                  POSTURE_TONE_CLASS[label.tone],
                )}
              >
                {label.label}
              </span>
            );
          })}
          {row.attention.length > 2 && (
            <span className="font-mono text-[10px] text-stat-icon">+{row.attention.length - 2}</span>
          )}
          {row.attention.length === 0 && <span className="font-mono text-[11px] text-stat-icon">--</span>}
        </span>

        <span className="min-w-0 truncate font-mono text-[11px] text-stat-subtitle">
          {row.lastActivityAt !== null
            ? formatRelativeTime(Math.floor(row.lastActivityAt / 1000))
            : 'unknown'}
          {row.evidence.unknown && <span className="block text-[10px] text-warning">evidence partial</span>}
        </span>

        {openingPossible ? (
          <ExternalLink className="h-3.5 w-3.5 text-stat-icon transition-colors group-hover:text-brand" strokeWidth={1.5} />
        ) : (
          <span />
        )}
      </button>
    </li>
  );
}
