import { cn } from '@/lib/utils';
import { formatAgeShort } from '@/lib/relativeTime';
import { DOMAIN_STATE_ORDER, type DomainState, type FleetReadinessResponse } from '@/types/readiness';
import { TONE_DOT, TONE_TEXT, domainMeta, stateMeta } from '../readinessMeta';
import { useNow } from './useNow';

/** The headline for the fleet's worst node state. Not a score: a short phrase. */
const HEADLINE: Record<DomainState, string> = {
  attention: 'Needs attention',
  degraded: 'Degraded',
  unavailable: 'Partly checked',
  unknown: 'Partly verified',
  healthy: 'All clear',
};

function worstState(counts: Record<DomainState, number>): DomainState {
  // Falls back to `unknown`, never to `healthy`: an all-zero tally means this
  // build cannot read it, and "cannot tell" must not read as "all clear".
  return DOMAIN_STATE_ORDER.find(state => counts[state] > 0) ?? 'unknown';
}

/**
 * The readiness status row: the fleet's worst state as a short phrase, node
 * counts by state, and when the check ran. One flat line, not a second
 * masthead; the Fleet masthead above it stays the page's only hero.
 */
export function ReadinessSummaryStrip({ data, checking, dismissedCount = 0 }: {
  data: FleetReadinessResponse;
  checking: boolean;
  /** Findings a team dismissal still covers. They stay out of the finding count and are named beside it. */
  dismissedCount?: number;
}) {
  const now = useNow(1000);
  const counts = data.summary.nodes;
  const worst = worstState(counts);
  const tone = stateMeta(worst).tone;
  const total = data.nodes.length;
  const unverified = counts.unknown + counts.unavailable;
  const findingCount = data.findings.length - dismissedCount;

  const parts = [
    counts.attention > 0 ? `${counts.attention} attention` : null,
    counts.degraded > 0 ? `${counts.degraded} degraded` : null,
    unverified > 0 ? `${unverified} unverified` : null,
    `${counts.healthy} of ${total} healthy`,
    `${findingCount} ${findingCount === 1 ? 'finding' : 'findings'}`,
    dismissedCount > 0 ? `${dismissedCount} dismissed` : null,
  ].filter((part): part is string => part !== null);

  return (
    <section aria-label="Readiness summary" className="border-b border-card-border pb-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <div className="flex items-center gap-2">
          <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', TONE_DOT[tone])} />
          <span className={cn('text-sm font-medium', TONE_TEXT[tone])}>{HEADLINE[worst]}</span>
        </div>
        <span className="font-mono text-[11px] tabular-nums text-stat-subtitle">{parts.join(' · ')}</span>
        <span className="font-mono text-[11px] tabular-nums text-stat-subtitle ml-auto max-md:ml-0">
          {checking ? 'checking' : `checked ${formatAgeShort(now - data.generatedAt)} ago`}
        </span>
      </div>
      {/* The headline judges the domains this account was given. When the
          server withheld one, say so rather than letting the others read as a
          statement about the whole fleet. */}
      {data.domainsOmitted.length > 0 && (
        <p className="mt-1 text-[11px] text-stat-subtitle">
          Not evaluated for this account: {data.domainsOmitted.map(key => domainMeta(key).label).join(', ')}.
        </p>
      )}
    </section>
  );
}
