import { Activity, Check, ChevronLeft, ChevronRight, CircleHelp, CircleSlash, Clock, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  RUNTIME_STATE_LOOKUP,
  SOURCE_STATE_LOOKUP,
  type GitOpsStateMeta,
  type GitOpsTone,
} from '@/lib/gitopsState';
import { attentionLabel, POSTURE_TONE_CLASS } from '@/lib/gitopsPortfolio';
import { cn, formatRelativeTime } from '@/lib/utils';
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

/**
 * The portfolio application list, built on the same table shell as the
 * Security tabs: a beveled card holding a ScrollArea with the shared Table
 * primitives, tracked-mono header cells, hover-tinted rows, and the pagination
 * footer underneath. Scrolling stays inside the card, so the page itself never
 * scrolls and the header/rows stay a single visual block.
 */
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
    <section aria-label="GitOps applications" className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel">
        <ScrollArea className="flex-1 min-h-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-8 text-[10px] uppercase tracking-[0.18em]" aria-label="State" />
                <TableHead className="text-[10px] uppercase tracking-[0.18em]">Application</TableHead>
                <TableHead className="text-[10px] uppercase tracking-[0.18em]">Repository · ref</TableHead>
                <TableHead className="text-[10px] uppercase tracking-[0.18em]">Target</TableHead>
                <TableHead className="text-[10px] uppercase tracking-[0.18em]">Source</TableHead>
                <TableHead className="text-[10px] uppercase tracking-[0.18em]">Rollout</TableHead>
                <TableHead className="text-[10px] uppercase tracking-[0.18em]">Runtime</TableHead>
                <TableHead className="text-[10px] uppercase tracking-[0.18em]">Health</TableHead>
                <TableHead className="text-[10px] uppercase tracking-[0.18em]">Drift</TableHead>
                <TableHead className="text-[10px] uppercase tracking-[0.18em]">Attention</TableHead>
                <TableHead className="text-[10px] uppercase tracking-[0.18em]">Last activity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(row => (
                <ApplicationRow key={row.id} row={row} onOpen={() => open(row)} />
              ))}
            </TableBody>
          </Table>
          {rows.length === 0 && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No GitOps application matches the current filters.
            </div>
          )}
        </ScrollArea>
      </div>

      <div className="flex items-center justify-end gap-1 pt-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onPrevPage}
          disabled={pageLoaded <= 1}
          aria-label="Previous page"
        >
          <ChevronLeft className="w-4 h-4" strokeWidth={1.5} />
        </Button>
        <span className="text-xs text-stat-subtitle tabular-nums px-1">Page {pageLoaded}</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onNextPage}
          disabled={nextCursor === null}
          aria-label="Next page"
        >
          <ChevronRight className="w-4 h-4" strokeWidth={1.5} />
        </Button>
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
    <TableRow className={cn('transition-colors hover:bg-muted/30', rowTint)}>
      <TableCell className="align-top">
        <span
          aria-hidden
          className={cn(
            'mt-1 inline-block h-2 w-2 rounded-full',
            row.posture === 'failed' && 'bg-destructive shadow-[0_0_6px_0_var(--destructive)]',
            row.posture === 'attention' && 'bg-warning shadow-[0_0_6px_0_var(--warning)]',
            row.posture === 'in_progress' && 'bg-brand',
            row.posture === 'converged' && 'bg-success',
            row.posture === 'converged_qualified' && 'bg-success/70',
            row.posture === 'unknown' && 'bg-stat-icon',
          )}
        />
      </TableCell>

      <TableCell className="align-top">
        <div className="min-w-0 max-w-[220px]">
          {openingPossible ? (
            <button
              type="button"
              className="block min-w-0 truncate text-left font-mono text-xs hover:text-brand"
              onClick={onOpen}
            >
              {row.name}
            </button>
          ) : (
            <span className="block min-w-0 truncate font-mono text-xs">{row.name}</span>
          )}
          <span className="block truncate font-mono text-[10px] text-stat-subtitle">
            {row.stackName ?? (row.blueprintId !== null ? `blueprint #${row.blueprintId}` : '')}
          </span>
        </div>
      </TableCell>

      <TableCell className="align-top">
        {row.repository ? (
          <div className="min-w-0 max-w-[220px]">
            <span className="block truncate font-mono text-[11px] text-stat-title">
              {row.repository.host}{row.repository.pathname}
            </span>
            <span className="block truncate font-mono text-[10px] text-stat-subtitle">
              {row.repository.configuredRef}
              {row.fetchedCommitSha ? ` · ${row.fetchedCommitSha.slice(0, 7)}` : ''}
            </span>
          </div>
        ) : (
          <span className="font-mono text-[11px] text-stat-icon">--</span>
        )}
      </TableCell>

      <TableCell className="align-top">
        {row.targetMode === 'direct' ? (
          <div className="min-w-0">
            <span className="block truncate font-mono text-[11px] text-stat-value">{row.nodeName ?? `node ${row.nodeId}`}</span>
            <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-stat-icon">direct</span>
          </div>
        ) : (
          <div className="min-w-0">
            <span className="block truncate font-mono text-[11px] text-stat-value">
              {row.targets.length} target{row.targets.length === 1 ? '' : 's'}
            </span>
            <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-stat-icon">blueprint</span>
          </div>
        )}
      </TableCell>

      <TableCell className="align-top"><FacetChip status={row.sourceStatus} lookup={SOURCE_STATE_LOOKUP} /></TableCell>
      <TableCell className="align-top"><FacetChip status={row.rolloutStatus} lookup={RUNTIME_STATE_LOOKUP} /></TableCell>
      <TableCell className="align-top"><FacetChip status={row.runtimeStatus} lookup={RUNTIME_STATE_LOOKUP} /></TableCell>
      <TableCell className="align-top"><FacetChip status={row.healthStatus} lookup={HEALTH_STATE} /></TableCell>

      <TableCell className="align-top">
        {row.drift.count > 0 ? (
          <div className="min-w-0 max-w-[140px]">
            <span className="font-mono text-[11px] text-warning">
              {row.drift.count} {row.drift.count === 1 ? 'item' : 'items'}
            </span>
            <span className="block truncate text-[10px] text-stat-subtitle">{row.drift.classes.join(' · ')}</span>
          </div>
        ) : (
          <span className="font-mono text-[11px] text-stat-icon">none</span>
        )}
      </TableCell>

      <TableCell className="align-top">
        <span className="flex min-w-0 max-w-[190px] flex-wrap gap-1">
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
      </TableCell>

      <TableCell className="align-top">
        <span className="block truncate font-mono text-[11px] text-stat-subtitle">
          {row.lastActivityAt !== null
            ? formatRelativeTime(Math.floor(row.lastActivityAt / 1000))
            : 'unknown'}
        </span>
        {row.evidence.unknown && <span className="block font-mono text-[10px] text-warning">evidence partial</span>}
      </TableCell>
    </TableRow>
  );
}
