import { RefreshCw } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { AttentionQueue } from './AttentionQueue';
import { ApplicationsTable } from './ApplicationsTable';
import { PortfolioFilterBar } from './PortfolioFilterBar';
import { PortfolioMasthead } from './PortfolioMasthead';
import { useGitOpsPortfolio } from './useGitOpsPortfolio';
import { GitOpsApplicationView } from '../application/GitOpsApplicationView';
import { useGitOpsApplicationSelection } from '../application/useGitOpsApplicationSelection';

/**
 * The GitOps portfolio workplace: one answer to "what is GitOps doing across
 * Sencho, and what needs me", over hub-owned aggregated evidence.
 *
 * Every facet, status, attention reason and count here is a canonical
 * projection rendered, not a page-local recomputation; the page grows no
 * parallel status engine. Refresh is event-driven (gitops invalidate channel),
 * never a per-node browser poll.
 *
 * A row drills into its application view in place (the `application` query
 * parameter). The portfolio hook keeps running while the application view
 * replaces the list, so returning keeps its filters and page (both held in
 * hook state) without a reload.
 *
 * Desktop only by itself; the phone treatment is the bespoke screen in
 * components/mobile/MobileGitOps.tsx (mobile-treatments entry: bespoke).
 */
export function GitOpsWorkplaceView() {
  const portfolio = useGitOpsPortfolio();
  const { data, loading, error, staleSince, refreshing } = portfolio;
  const selectedApplication = useGitOpsApplicationSelection();

  if (selectedApplication !== null) return <GitOpsApplicationView key={selectedApplication} id={selectedApplication} />;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden p-6">
      {loading && !data ? (
        <div className="flex flex-col gap-4" aria-busy="true">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-9 w-full max-w-xl rounded-md" />
          <Skeleton className="min-h-0 flex-1 rounded-lg" />
        </div>
      ) : error ? (
        <PortfolioLoadError message={error} onRetry={portfolio.refresh} />
      ) : data ? (
        <>
          <PortfolioMasthead data={data} staleSince={staleSince} />

          <div className="flex min-h-0 flex-1 flex-col gap-4">
            <CoverageNotices data={data} />

            <AttentionQueue rows={data.attentionQueue} />

            {data.attentionQueueTruncated && (
              <p className="font-mono text-[11px] text-warning">
                More than {data.attentionQueue.length} applications require attention; the queue shows the first
                {' '}{data.attentionQueue.length}, ordered by severity.
              </p>
            )}

            <PortfolioFilterBar
              filters={portfolio.filters}
              nodes={data.coverage.map(entry => ({ id: entry.nodeId, name: entry.nodeName ?? `node ${entry.nodeId}` }))}
              onChange={portfolio.setFilters}
              onQueryChange={portfolio.setQuery}
            />

            <ApplicationsTable
              rows={data.applications}
              nextCursor={data.nextCursor}
              pageLoaded={portfolio.pageLoaded}
              onPrevPage={portfolio.prevPage}
              onNextPage={portfolio.nextPage}
            />

            {data.truncated && (
              <p className="font-mono text-[11px] text-warning">
                The portfolio is larger than one response can carry ({'>'}1000 rows); narrow with filters or pages.
              </p>
            )}
          </div>
        </>
      ) : null}

      {refreshing && data && (
        <div className="pointer-events-none fixed right-4 top-4 flex items-center gap-2 rounded-md border border-card-border bg-popover/95 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-stat-subtitle shadow-md backdrop-blur-[10px] backdrop-saturate-[1.15]">
          <RefreshCw className="h-3 w-3 animate-spin" strokeWidth={1.5} />
          Refreshing
        </div>
      )}
    </div>
  );
}

function PortfolioLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <p className="font-heading text-xl text-stat-value">The portfolio could not be read</p>
      <p className="max-w-md font-mono text-xs text-stat-subtitle">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md border border-card-border bg-card px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-stat-value shadow-btn-glow transition-colors hover:border-card-border-hover"
      >
        Retry
      </button>
    </div>
  );
}

/** Partial-evidence notices; a portfolio that cannot see a node never reads as whole. */
function CoverageNotices({ data }: { data: NonNullable<ReturnType<typeof useGitOpsPortfolio>['data']> }) {
  const degraded = data.coverage.filter(entry => entry.state !== 'ok');
  if (degraded.length === 0) return null;
  return (
    <div className="rounded-lg border border-warning/40 bg-warning/[0.06] px-3 py-2">
      <p className="font-mono text-[11px] text-warning">
        {degraded.length === 1 ? 'One node' : `${degraded.length} nodes`} could not contribute:
        {' '}
        {degraded.map(entry => entry.nodeName ?? `node ${entry.nodeId}`).join(', ')}.
        {' '}Its applications are absent below rather than reported with evidence this instance does not have.
      </p>
    </div>
  );
}
