import type { ReactNode } from 'react';
import { Activity, Check, ChevronLeft, ChevronRight, CircleHelp, CircleSlash, Clock, MoreHorizontal, XCircle } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  driftClassLabel,
  ROLLOUT_STATE_LOOKUP,
  RUNTIME_STATE_LOOKUP,
  SOURCE_STATE_LOOKUP,
  type GitOpsStateMeta,
  type GitOpsTone,
} from '@/lib/gitopsState';
import { attentionLabel, countCurrentTargets, hasKnownPosture, PORTFOLIO_EMPTY_COPY, POSTURE_TONE_CLASS } from '@/lib/gitopsPortfolio';
import { cn, formatRelativeTime } from '@/lib/utils';
import type { GitOpsPortfolioRow } from '@/types/gitopsPortfolio';
import { openPortfolioApplication, portfolioRowActions } from './portfolioNavigation';

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
        POSTURE_TONE_CLASS[tone],
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
  portfolioEmpty,
  emptyActions,
  canOpenFleet = false,
  onDrillDown,
}: {
  rows: GitOpsPortfolioRow[];
  /** No application exists at all, as opposed to none matching the filters. */
  portfolioEmpty: boolean;
  /** Ways into GitOps, shown under the empty-portfolio copy. */
  emptyActions?: ReactNode;
  /** Whether the Fleet view (and so a Blueprint's detail) is reachable for this role. */
  canOpenFleet?: boolean;
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
                <TableHead className="text-[10px] uppercase tracking-[0.18em]">Last activity</TableHead>
                <TableHead className="w-10" aria-label="Actions" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(row => (
                <ApplicationRow key={row.id} row={row} onOpen={() => open(row)} canOpenFleet={canOpenFleet} />
              ))}
            </TableBody>
          </Table>
          {rows.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-12 text-center text-sm text-muted-foreground">
              {portfolioEmpty ? PORTFOLIO_EMPTY_COPY : 'No GitOps application matches the current filters.'}
              {portfolioEmpty && emptyActions}
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

function ApplicationRow({ row, onOpen, canOpenFleet }: { row: GitOpsPortfolioRow; onOpen: () => void; canOpenFleet: boolean }) {
  const currentTargetCount = countCurrentTargets(row.targets);
  // The row carries no attention column (the queue above lists them), so the dot names
  // the most urgent reason for screen readers and hover, including rows past the queue's cap.
  const topReason = row.attention.find(reason => attentionLabel(reason).tone === 'destructive') ?? row.attention[0];
  const topLabel = topReason === undefined ? undefined : attentionLabel(topReason);
  const failureAttention = topLabel?.tone === 'destructive';
  const moreReasons = row.attention.length - 1;
  const dotLabel = topLabel === undefined
    ? undefined
    : `${topLabel.label}${moreReasons > 0 ? `, ${moreReasons} more` : ''}`;
  const rowTint = row.attention.length === 0
    ? ''
    : failureAttention ? 'bg-destructive/[0.04]' : 'bg-warning/[0.04]';

  return (
    // The whole row opens the application. The name stays a real button so the row is
    // reachable and activatable from the keyboard; its click bubbles to the row.
    <TableRow className={cn('cursor-pointer transition-colors hover:bg-muted/30', rowTint)} onClick={onOpen}>
      <TableCell className="align-top">
        <span
          {...(dotLabel ? { role: 'img', 'aria-label': dotLabel, title: dotLabel } : { 'aria-hidden': true })}
          className={cn(
            'mt-1 inline-block h-2 w-2 rounded-full',
            row.posture === 'failed' && 'bg-destructive shadow-[0_0_6px_0_var(--destructive)]',
            row.posture === 'attention' && 'bg-warning shadow-[0_0_6px_0_var(--warning)]',
            row.posture === 'in_progress' && 'bg-brand',
            row.posture === 'converged' && 'bg-success',
            row.posture === 'converged_qualified' && 'bg-success/70',
             !hasKnownPosture(row.posture) && 'bg-stat-icon',
          )}
        />
      </TableCell>

      <TableCell className="align-top">
        <div className="min-w-0 max-w-[220px]">
          <button
            type="button"
            className="block min-w-0 truncate text-left font-mono text-xs hover:text-brand"
          >
            {row.name}
          </button>
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
              {currentTargetCount} target{currentTargetCount === 1 ? '' : 's'}
            </span>
            <span className="block font-mono text-[10px] uppercase tracking-[0.1em] text-stat-icon">blueprint</span>
          </div>
        )}
      </TableCell>

      <TableCell className="align-top"><FacetChip status={row.sourceStatus} lookup={SOURCE_STATE_LOOKUP} /></TableCell>
      <TableCell className="align-top"><FacetChip status={row.rolloutStatus} lookup={ROLLOUT_STATE_LOOKUP} /></TableCell>
      <TableCell className="align-top"><FacetChip status={row.runtimeStatus} lookup={RUNTIME_STATE_LOOKUP} /></TableCell>
      <TableCell className="align-top"><FacetChip status={row.healthStatus} lookup={HEALTH_STATE} /></TableCell>

      <TableCell className="align-top">
        {row.drift.count > 0 ? (
          <div className="min-w-0 max-w-[140px]">
            <span className="font-mono text-[11px] text-warning">
              {row.drift.count} {row.drift.count === 1 ? 'item' : 'items'}
            </span>
            <span className="block truncate text-[10px] text-stat-subtitle">
              {row.drift.classes.map(driftClassLabel).join(' · ')}
            </span>
          </div>
        ) : (
          <span className="font-mono text-[11px] text-stat-icon">none</span>
        )}
      </TableCell>

      <TableCell className="align-top">
        <span className="block truncate font-mono text-[11px] text-stat-subtitle">
          {row.lastActivityAt !== null
            ? formatRelativeTime(Math.floor(row.lastActivityAt / 1000))
            : 'unknown'}
        </span>
        {row.evidence.unknown && <span className="block font-mono text-[10px] text-warning">evidence partial</span>}
      </TableCell>

      {/* The menu is its own set of destinations, not a click on the row. */}
      <TableCell className="align-top" onClick={event => event.stopPropagation()}>
        <RowActionsMenu row={row} canOpenFleet={canOpenFleet} />
      </TableCell>
    </TableRow>
  );
}

/** Every place a row leads (its application, stack, Git source, Blueprint), in one menu. */
function RowActionsMenu({ row, canOpenFleet }: { row: GitOpsPortfolioRow; canOpenFleet: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Actions for ${row.name}`}>
          <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {portfolioRowActions(row, { canOpenFleet }).map(action => (
          <DropdownMenuItem key={action.label} onSelect={action.run}>
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
