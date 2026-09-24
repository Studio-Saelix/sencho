import { ChevronLeft, ChevronRight, RefreshCw, Search, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Masthead, SectionHead, StateDot } from '@/components/mobile/mobile-ui';
import { attentionLabel, PORTFOLIO_EMPTY_COPY, portfolioMastheadState, POSTURE_TONE_CLASS } from '@/lib/gitopsPortfolio';
import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/lib/utils';
import type { GitOpsPortfolioRow } from '@/types/gitopsPortfolio';
import { openPortfolioApplication } from '../gitops/portfolio/portfolioNavigation';
import { useGitOpsPortfolio } from '../gitops/portfolio/useGitOpsPortfolio';
import { WorkplaceActions } from '../gitops/portfolio/WorkplaceActions';
import { GitOpsApplicationView } from '../gitops/application/GitOpsApplicationView';
import { useGitOpsApplicationSelection } from '../gitops/application/useGitOpsApplicationSelection';

/**
 * The GitOps portfolio on a phone: the operate loop's review-and-triage face
 * (bespoke treatment, per mobile-treatments.ts).
 *
 * Same data hook as the desktop workplace: the phone presentation is a
 * re-skin of hub-aggregated evidence, never a second fetch path. Summary and
 * attention stay in the masthead, search and mode filters stay reachable, and
 * attention reasons stay inline under each application name, because a narrow
 * viewport is exactly where triage cannot afford to hide them. Consequential
 * operations stay where they always were: on the owning detail surfaces the
 * application view hands off to. The application view itself is the same
 * read-only component the desktop workplace uses, reflowed to one column.
 */
export function MobileGitOps({ headerActions }: { headerActions?: ReactNode }) {
  const portfolio = useGitOpsPortfolio();
  const { data, loading, error, staleSince } = portfolio;
  const selectedApplication = useGitOpsApplicationSelection();

  const masthead = data
    ? portfolioMastheadState(data.summary, data.coverage.some(entry => entry.state !== 'ok'))
    : { state: 'Loading', tone: 'idle' as const };
  // The mobile Tone set has no neutral: an unproven portfolio reads as brand
  // (data color, no urgency claim), which is also what the schedules masthead
  // uses for a state with nothing to flag.
  const mastheadTone = masthead.tone === 'error' ? 'destructive'
    : masthead.tone === 'warn' ? 'warning'
    : masthead.tone === 'live' ? 'success'
    : 'brand';
  const meta = data
    ? `${data.summary.applications} apps · ${data.summary.attentionRequired} attention${
        staleSince ? ' · stale' : ''}${
        data.coverage.some(entry => entry.state !== 'ok') ? ' · partial' : ''}`
    : '';

  const filters = portfolio.filters;
  // Locally controlled so typing is immediate; the fetch and URL write stay
  // debounced in the hook, and external resets (the All chip) sync back down.
  const [query, setQuery] = useState(filters.q ?? '');
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQuery(filters.q ?? '');
  }, [filters.q]);
  const modeChips: Array<{ value: 'all' | 'attention' | 'direct' | 'blueprint'; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'attention', label: 'Attention' },
    { value: 'direct', label: 'Direct' },
    { value: 'blueprint', label: 'Blueprint' },
  ];
  const activeChip: typeof modeChips[number]['value'] | null =
    filters.attention === '1' ? 'attention' : filters.mode === 'direct' ? 'direct' : filters.mode === 'blueprint' ? 'blueprint'
      // "All" reads as pressed only when nothing narrows the list.
      : Object.keys(filters).length === 0 ? 'all' : null;

  if (selectedApplication !== null) {
    return <GitOpsApplicationView key={selectedApplication} id={selectedApplication} className="p-4" headerActions={headerActions} />;
  }

  return (
    <div className="flex h-full flex-col">
      <Masthead
        kicker="GITOPS · PORTFOLIO"
        state={masthead.state}
        stateTone={mastheadTone}
        live={staleSince === null}
        meta={meta}
        right={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={portfolio.refresh}
              aria-label="Refresh GitOps portfolio"
              className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-stat-subtitle transition-colors hover:text-stat-value"
            >
              <RefreshCw className={cn('h-4 w-4', portfolio.refreshing && 'animate-spin')} strokeWidth={1.5} />
            </button>
            {headerActions}
          </div>
        }
      />

      <div className="shrink-0 border-b border-hairline px-4 pb-2 pt-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stat-icon" strokeWidth={1.5} />
          <input
            type="search"
            value={query}
            onChange={event => {
              setQuery(event.target.value);
              portfolio.setQuery(event.target.value);
            }}
            placeholder="Search applications"
            aria-label="Search GitOps applications"
            className="h-11 w-full rounded-md border border-card-border bg-card pl-8 pr-3 font-mono text-sm text-stat-value placeholder:text-stat-icon focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
          />
        </div>
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Filter by triage dimension">
          {filters.stack !== undefined && (
            <button
              type="button"
              onClick={() => {
                const next = { ...filters };
                delete next.stack;
                portfolio.setFilters(next);
              }}
              aria-label="Remove stack filter"
              className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-md border border-brand/50 bg-brand/10 px-3 font-mono text-[11px] tracking-[0.04em] text-brand"
            >
              {filters.stack}
              <X className="h-3.5 w-3.5" strokeWidth={1.5} />
            </button>
          )}
          {modeChips.map(chip => (
            <button
              key={chip.value}
              type="button"
              onClick={() => {
                // "All" is the phone's single escape hatch: there is no Clear
                // affordance on a narrow layout, so it must clear every filter
                // a deep link could have brought in, not only this row's.
                if (chip.value === 'all') {
                  setQuery('');
                  portfolio.clearFilters();
                  return;
                }
                const next = { ...filters };
                delete next.attention;
                delete next.mode;
                if (chip.value === 'attention') next.attention = '1';
                if (chip.value === 'direct' || chip.value === 'blueprint') next.mode = chip.value;
                portfolio.setFilters(next);
              }}
              aria-pressed={activeChip === chip.value}
              className={cn(
                'min-h-11 shrink-0 rounded-md border px-3 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors',
                activeChip === chip.value
                  ? 'border-brand/50 bg-brand/10 text-brand'
                  : 'border-card-border bg-card text-stat-subtitle',
              )}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {loading ? (
          <div className="space-y-2 pt-3">
            {[0, 1, 2, 3].map(i => (
              <div key={i} className="h-20 animate-pulse rounded-lg border border-card-border bg-card" />
            ))}
          </div>
        ) : error ? (
          <div className="pt-6 text-center">
            <p className="font-heading text-xl text-stat-value">Couldn’t read the portfolio</p>
            <p className="mt-1 font-mono text-xs text-stat-subtitle">{error}</p>
            <button
              type="button"
              onClick={portfolio.refresh}
              className="mt-3 min-h-11 rounded-md border border-card-border bg-card px-4 font-mono text-[11px] uppercase tracking-[0.14em] text-stat-value shadow-btn-glow"
            >
              Retry
            </button>
          </div>
        ) : data && data.applications.length === 0 ? (
          <div className="pt-6 text-center">
            <p className="font-heading text-xl text-stat-value">
              {data.summary.applications === 0 ? 'No applications yet' : 'Nothing matches'}
            </p>
            <p className="mt-1 font-mono text-xs text-stat-subtitle">
              {data.summary.applications === 0 ? PORTFOLIO_EMPTY_COPY : 'No GitOps application matches the current filters.'}
            </p>
            {data.summary.applications === 0 && <WorkplaceActions className="mt-4 justify-center" includeBlueprint={false} />}
          </div>
        ) : data ? (
          <>
            <SectionHead right={String(data.applications.length)}>Applications</SectionHead>
            <ul className="divide-y divide-card-border/60 rounded-lg border border-card-border bg-card">
              {data.applications.map(row => (
                <MobileGitOpsRow key={row.id} row={row} />
              ))}
            </ul>
            {(data.nextCursor !== null || portfolio.pageLoaded > 1) && (
              // Pages replace each other (server cursor), so the controls say
              // so rather than implying an appended "load more" list.
              <div className="mt-3 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={portfolio.prevPage}
                  disabled={portfolio.pageLoaded <= 1}
                  aria-label="Previous page"
                  className="flex min-h-11 min-w-11 items-center justify-center rounded-md border border-card-border bg-card text-stat-value disabled:opacity-40"
                >
                  <ChevronLeft className="h-4 w-4" strokeWidth={1.5} />
                </button>
                <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-stat-subtitle">
                  Page {portfolio.pageLoaded}
                </span>
                <button
                  type="button"
                  onClick={portfolio.nextPage}
                  disabled={data.nextCursor === null}
                  aria-label="Next page"
                  className="flex min-h-11 min-w-11 items-center justify-center rounded-md border border-card-border bg-card text-stat-value disabled:opacity-40"
                >
                  <ChevronRight className="h-4 w-4" strokeWidth={1.5} />
                </button>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

function MobileGitOpsRow({ row }: { row: GitOpsPortfolioRow }) {
  const postureTone = {
    failed: 'destructive',
    attention: 'warning',
    in_progress: 'brand',
    converged: 'success',
    converged_qualified: 'success',
  } as const;

  return (
    <li>
      <button
        type="button"
        onClick={() => openPortfolioApplication(row)}
        className="block w-full min-h-11 px-3 py-2.5 text-left"
      >
        <span className="flex items-center gap-2">
          {row.posture === 'unknown'
            ? <span className="inline-block h-[7px] w-[7px] shrink-0 rounded-full bg-stat-icon" />
            : <StateDot tone={postureTone[row.posture]} size={7} glow={row.posture === 'failed'} />}
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-[13px] text-stat-value">{row.name}</span>
            <span className="block truncate font-mono text-[11px] text-stat-subtitle">
              {row.repository ? `${row.repository.host}${row.repository.pathname} · ${row.repository.configuredRef}` : (row.stackName ?? 'no source')}
            </span>
          </span>
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-stat-icon">
            {row.targetMode === 'direct' ? 'direct' : `${row.targets.length}t`}
          </span>
        </span>
        {row.attention.length > 0 && (
          <span className="mt-1.5 flex flex-wrap gap-1 pl-5">
            {row.attention.map(reason => {
              const label = attentionLabel(reason);
              return (
                <span
                  key={reason}
                  className={cn('rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em]', POSTURE_TONE_CLASS[label.tone])}
                >
                  {label.label}
                </span>
              );
            })}
          </span>
        )}
        <span className="mt-1 block pl-5 font-mono text-[10px] text-stat-icon">
          {row.lastActivityAt !== null ? `last change ${formatRelativeTime(Math.floor(row.lastActivityAt / 1000))}` : 'no activity evidence'}
          {row.evidence.unknown ? ' · evidence unknown' : ''}
        </span>
      </button>
    </li>
  );
}
