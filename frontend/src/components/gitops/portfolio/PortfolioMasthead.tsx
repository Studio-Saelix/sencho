import { useEffect, useState } from 'react';
import { PageMasthead, type MastheadMetadataItem } from '@/components/ui/PageMasthead';
import { portfolioMastheadState } from '@/lib/gitopsPortfolio';
import type { GitOpsPortfolioResponse } from '@/types/gitopsPortfolio';

function formatAgo(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 60_000) return `${Math.round(clamped / 1000)}s`;
  if (clamped < 3_600_000) return `${Math.round(clamped / 60_000)}m`;
  return `${Math.round(clamped / 3_600_000)}h`;
}

// The "updated Xs" label only shifts visibly every few seconds; the Dashboard
// uses a 5 s cadence for the same reason, so reuse it rather than forcing a
// per-second re-render.
const SYNC_LABEL_TICK_MS = 5000;

function useTicker(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * The portfolio's masthead: the shared hero masthead with the verdict as its
 * state word. Freshness lives in its meta line, where a refresh in flight reads
 * "refreshing" and a failed one keeps the last-known data with a qualifier, so
 * there is no separate refresh indicator over the page. Which nodes could not
 * contribute is stated once, in the coverage notice under it.
 */
export function PortfolioMasthead({ data, staleSince, refreshing }: {
  data: GitOpsPortfolioResponse;
  staleSince: number | null;
  refreshing: boolean;
}) {
  const { summary } = data;
  const coverageFailed = data.coverage.some(entry => entry.state === 'unreachable' || entry.state === 'unsupported') || data.truncated;
  const { state, tone } = portfolioMastheadState(summary, coverageFailed);
  const now = useTicker(SYNC_LABEL_TICK_MS);

  const reporting = data.coverage.filter(entry => entry.state === 'ok').length;
  const nodeWord = data.coverage.length === 1 ? 'node' : 'nodes';
  const freshness = refreshing ? 'refreshing' : `updated ${formatAgo(now - data.generatedAt)}`;
  const qualified = summary.convergedQualified > 0 ? ` · ${summary.convergedQualified} converged qualified` : '';
  const subtitle = `${reporting}/${data.coverage.length} ${nodeWord} reporting${qualified} · ${freshness}`;

  const metadata: MastheadMetadataItem[] = [
    { label: 'APPLICATIONS', value: String(summary.applications) },
    { label: 'PENDING', value: String(summary.inProgress) },
    { label: 'DRIFTED', value: String(summary.drifted), tone: summary.drifted > 0 ? 'warn' : 'value' },
    { label: 'CONVERGED', value: String(summary.converged) },
    { label: 'ATTENTION', value: String(summary.attentionRequired), tone: summary.attentionRequired > 0 ? 'warn' : 'value' },
  ];

  return (
    <PageMasthead
      kicker="GITOPS"
      size="hero"
      state={state}
      tone={tone}
      pulsing={staleSince === null}
      subtitle={subtitle}
      metadata={metadata}
      className="mb-4 rounded-lg"
    >
      {staleSince !== null ? (
        <span className="inline-flex items-center rounded-sm border border-warning/30 bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-warning">
          last refresh failed · showing last-known
        </span>
      ) : null}
    </PageMasthead>
  );
}
