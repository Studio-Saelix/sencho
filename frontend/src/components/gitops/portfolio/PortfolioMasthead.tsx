import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { MastheadRail } from '@/components/ui/MastheadRail';
import { portfolioMastheadState } from '@/lib/gitopsPortfolio';
import type { GitOpsPortfolioResponse } from '@/types/gitopsPortfolio';

/**
 * The portfolio's masthead, built on the same recipe as the Dashboard and
 * Fleet mastheads: one card with a directional bevel, a tinted accent wash,
 * a rail that shimmers while the data is live, the state word, a mono meta
 * line, stat tiles, and the attention bell in the right slot. Motion and
 * freshness behaviour are shared with those pages deliberately: a live
 * ticker keeps "updated Xs ago" shifting, and the stale qualifier uses the
 * same chip as the Dashboard's stale-metrics marker.
 */

type MastheadConfig = {
  textClass: string;
  railClass: string;
  tintClass: string;
};

const TONE_CONFIG: Record<'live' | 'warn' | 'error' | 'idle', MastheadConfig> = {
  live: {
    textClass: 'text-stat-value',
    railClass: 'bg-brand/70',
    tintClass: 'from-brand/[0.06] via-transparent to-transparent',
  },
  warn: {
    textClass: 'text-warning',
    railClass: 'bg-warning/70',
    tintClass: 'from-warning/[0.06] via-transparent to-transparent',
  },
  error: {
    textClass: 'text-destructive',
    railClass: 'bg-destructive/70',
    tintClass: 'from-destructive/[0.06] via-transparent to-transparent',
  },
  idle: {
    textClass: 'text-stat-value',
    railClass: 'bg-stat-subtitle/70',
    tintClass: 'from-transparent via-transparent to-transparent',
  },
};

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

export function PortfolioMasthead({ data, staleSince }: {
  data: GitOpsPortfolioResponse;
  staleSince: number | null;
}) {
  const unreachable = data.coverage.filter(entry => entry.state === 'unreachable');
  const unsupported = data.coverage.filter(entry => entry.state === 'unsupported');
  const coverageFailed = unreachable.length + unsupported.length > 0 || data.truncated;
  const { state, tone } = portfolioMastheadState(data.summary, coverageFailed);
  const config = TONE_CONFIG[tone];
  const now = useTicker(SYNC_LABEL_TICK_MS);

  const reporting = data.coverage.filter(entry => entry.state === 'ok').length;
  const nodeWord = data.coverage.length === 1 ? 'node' : 'nodes';
  const metaLine = `${data.summary.applications} ${data.summary.applications === 1 ? 'application' : 'applications'} · ${reporting}/${data.coverage.length} ${nodeWord} reporting · updated ${formatAgo(now - data.generatedAt)}`;

  const reasons: string[] = [];
  if (unreachable.length > 0) reasons.push(`unreachable: ${unreachable.map(entry => entry.nodeName ?? `node ${entry.nodeId}`).join(', ')}`);
  if (unsupported.length > 0) reasons.push(`too old to answer: ${unsupported.map(entry => entry.nodeName ?? `node ${entry.nodeId}`).join(', ')}`);
  if (data.truncated) reasons.push('more applications than this view can show');

  return (
    <div className="relative overflow-hidden rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel transition-colors mb-4">
      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-r ${config.tintClass}`} />
      <MastheadRail
        variant={tone === 'live' && staleSince === null ? 'shimmer' : 'glow'}
        className={config.railClass}
      />
      <div className="relative grid grid-cols-[auto_1fr_auto] items-center gap-6 py-5 pl-7 pr-6">
        {/* State column */}
        <div className="flex items-center gap-4">
          <div className="flex flex-col gap-1">
            <span className={`font-heading text-3xl leading-none tracking-tight ${config.textClass}`}>
              {state}
            </span>
            <span className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">
              {metaLine}
              {staleSince !== null ? (
                <span className="ml-2 inline-flex items-center rounded-sm border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[10px] font-mono tracking-wide uppercase text-warning">
                  last refresh failed · showing last-known
                </span>
              ) : null}
            </span>
            {reasons.length > 0 ? (
              <span className="font-mono text-[11px] text-stat-subtitle/90">
                {reasons.join(' · ')}
              </span>
            ) : null}
          </div>
        </div>

        {/* Stats column */}
        <div className="hidden items-stretch justify-end gap-0 md:flex">
          <StatTile label="APPLICATIONS" value={String(data.summary.applications)} tone="value" />
          <StatTile label="PENDING" value={String(data.summary.inProgress)} tone="value" divider />
          <StatTile
            label="DRIFTED"
            value={String(data.summary.drifted)}
            tone={data.summary.drifted > 0 ? 'warn' : 'value'}
            divider
          />
          <StatTile
            label="CONVERGED"
            value={String(data.summary.converged)}
            sub={data.summary.convergedQualified > 0 ? `${data.summary.convergedQualified} qualified` : undefined}
            tone="value"
            divider
          />
        </div>

        {/* Right column: the attention count, the same slot the Dashboard and
            Fleet use for their alerts bell. */}
        <div className="flex items-center gap-2 pl-4">
          <Bell
            className={`h-3.5 w-3.5 ${data.summary.attentionRequired > 0 ? 'text-warning' : 'text-stat-icon'}`}
            strokeWidth={1.5}
          />
          <span
            className={`font-mono text-sm tabular-nums ${data.summary.attentionRequired > 0 ? 'text-warning' : 'text-stat-subtitle'}`}
          >
            {data.summary.attentionRequired}
          </span>
          <span className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">
            attention
          </span>
        </div>
      </div>
    </div>
  );
}

function StatTile({
  label,
  value,
  sub,
  tone,
  divider,
}: {
  label: string;
  value: string;
  sub?: string;
  tone: 'value' | 'warn';
  divider?: boolean;
}) {
  return (
    <div className={`flex flex-col gap-1 px-5 ${divider ? 'border-l border-border/60' : ''}`}>
      <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle">
        {label}
      </span>
      <span
        className={`font-mono tabular-nums text-xl leading-none ${tone === 'warn' ? 'text-warning' : 'text-stat-value'}`}
      >
        {value}
      </span>
      {sub ? (
        <span className="font-mono text-[10px] text-stat-subtitle/80">{sub}</span>
      ) : null}
    </div>
  );
}
