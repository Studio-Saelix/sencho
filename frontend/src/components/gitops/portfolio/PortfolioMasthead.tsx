import { PageMasthead, type MastheadMetadataItem } from '@/components/ui/PageMasthead';
import { portfolioMastheadState } from '@/lib/gitopsPortfolio';
import { formatRelativeTime } from '@/lib/utils';
import type { GitOpsPortfolioResponse } from '@/types/gitopsPortfolio';

/**
 * The portfolio's one-line verdict: state word, metadata strip
 * (§9.1 status masthead), and a freshness line that names what is partial.
 *
 * The counts and pose come from the server's summary; this component never
 * re-derives them from rows, so the masthead cannot disagree with the list.
 */
export function PortfolioMasthead({ data, staleSince }: {
  data: GitOpsPortfolioResponse;
  staleSince: number | null;
}) {
  const unreachable = data.coverage.filter(entry => entry.state === 'unreachable').length;
  const unsupported = data.coverage.filter(entry => entry.state === 'unsupported').length;
  const coverageFailed = unreachable + unsupported > 0;
  const { state, tone } = portfolioMastheadState(data.summary, coverageFailed);

  const metadata: MastheadMetadataItem[] = [
    { label: 'Applications', value: String(data.summary.applications) },
    {
      label: 'Attention',
      value: String(data.summary.attentionRequired),
      tone: data.summary.attentionRequired > 0 ? 'warn' : 'value',
    },
    {
      label: 'Drifted',
      value: String(data.summary.drifted),
      tone: data.summary.drifted > 0 ? 'warn' : 'value',
    },
    { label: 'Pending', value: String(data.summary.inProgress) },
    {
      label: 'Converged',
      value: String(data.summary.converged),
      tone: data.summary.converged > 0 ? 'value' : 'subtitle',
    },
    {
      label: 'Qualified',
      value: String(data.summary.convergedQualified),
      tone: 'subtitle',
    },
  ];

  // "Updated" always reports the age of the data on screen. When a refresh
  // failed, the failure time is named separately rather than replacing the
  // data's real age.
  const freshness: string[] = [`updated ${formatRelativeTime(Math.floor(data.generatedAt / 1000))}`];
  if (staleSince !== null) {
    freshness.push(`last refresh failed ${formatRelativeTime(Math.floor(staleSince / 1000))} · showing last-known`);
  }
  if (unreachable > 0) freshness.push(`${unreachable} node${unreachable === 1 ? '' : 's'} unreachable`);
  if (unsupported > 0) freshness.push(`${unsupported} node${unsupported === 1 ? '' : 's'} too old to answer`);

  return (
    <PageMasthead
      kicker="GITOPS · PORTFOLIO"
      state={state}
      tone={tone}
      size="hero"
      pulsing={staleSince === null}
      metadata={metadata}
      subtitle={freshness.join(' · ')}
    />
  );
}
