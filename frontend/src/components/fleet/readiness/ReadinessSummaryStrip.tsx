import { cn } from '@/lib/utils';
import { formatAgeShort } from '@/lib/relativeTime';
import { DOMAIN_STATE_ORDER, type DomainState, type FleetReadinessResponse } from '@/types/readiness';
import { TONE_TEXT, domainMeta, stateMeta } from '../readinessMeta';
import { useNow } from './useNow';

const LABEL = 'font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle';

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

/** The "needs attention" tile's tone: destructive for attention, warning when only degraded nodes remain. */
function attentionTone(counts: Record<DomainState, number>): string | undefined {
  if (counts.attention > 0) return 'text-destructive';
  if (counts.degraded > 0) return 'text-warning';
  return undefined;
}

function StatTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="flex min-w-[112px] flex-col justify-center gap-1.5 border-l border-card-border px-5 py-4 max-md:border-l-0 max-md:border-t">
      <span className={LABEL}>{label}</span>
      <span className={cn('font-mono text-xl leading-none tabular-nums tracking-tight', tone ?? 'text-stat-value')}>{value}</span>
      {sub && <span className="font-mono text-[10px] text-stat-subtitle/80">{sub}</span>}
    </div>
  );
}

/**
 * The readiness summary: the fleet's worst state as a short phrase, then node counts
 * by state and when the check ran. One strip with hairline dividers, not a row
 * of floating cards.
 */
export function ReadinessSummaryStrip({ data, checking }: { data: FleetReadinessResponse; checking: boolean }) {
  const now = useNow(1000);
  const counts = data.summary.nodes;
  const worst = worstState(counts);
  const total = data.nodes.length;
  const problemNodes = total - counts.healthy;
  const unverified = counts.unknown + counts.unavailable;
  const findingCount = data.findings.length;

  const subline = problemNodes === 0
    ? `Every node checked out across ${data.domains.length} ${data.domains.length === 1 ? 'domain' : 'domains'}.`
    : `${problemNodes} of ${total} ${total === 1 ? 'node has' : 'nodes have'} something to review.`;

  return (
    <section
      aria-label="Readiness summary"
      className="flex flex-wrap items-stretch rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel max-md:flex-col"
    >
      <div className="min-w-0 flex-1 px-5 py-4">
        <div className={LABEL}>fleet readiness</div>
        <div className={cn('mt-1 font-heading text-[1.375rem] leading-7', TONE_TEXT[stateMeta(worst).tone])}>
          {HEADLINE[worst]}
        </div>
        <p className="mt-0.5 text-sm text-stat-subtitle">{subline}</p>
        {/* The headline judges the domains this account was given. When the
            server withheld one, say so rather than letting the others read as a
            statement about the whole fleet. */}
        {data.domainsOmitted.length > 0 && (
          <p className="mt-1 text-[11px] text-stat-subtitle">
            Not evaluated for this account: {data.domainsOmitted.map(key => domainMeta(key).label).join(', ')}.
          </p>
        )}
      </div>
      <StatTile
        label="needs attention"
        value={String(counts.attention)}
        sub={counts.degraded > 0 ? `+${counts.degraded} degraded` : 'nodes'}
        tone={attentionTone(counts)}
      />
      <StatTile label="unverified" value={String(unverified)} sub="nodes" />
      <StatTile
        label="healthy"
        value={String(counts.healthy)}
        sub={`of ${total} ${total === 1 ? 'node' : 'nodes'}`}
        tone={counts.healthy > 0 ? 'text-success' : undefined}
      />
      <StatTile
        label="last checked"
        value={checking ? 'checking' : `${formatAgeShort(now - data.generatedAt)} ago`}
        sub={`${findingCount} ${findingCount === 1 ? 'finding' : 'findings'}`}
      />
    </section>
  );
}
