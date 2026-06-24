import {
  AreaChart, Area, BarChart, Bar, Cell, ScatterChart, Scatter,
  XAxis, YAxis, ZAxis, CartesianGrid, LabelList, ReferenceLine, Tooltip,
} from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { useChartStyle, type ChartStyle } from '@/hooks/use-theme';
import { cn } from '@/lib/utils';
import type { SecurityRiskTrendPoint, SecurityOverview, ExploitIntelFinding } from '@/types/security';

// Severity colours resolve through the --sev-* tokens, which the appearance
// chart-style switches (Signature keeps today's saturated semantics; Muted and
// Heat are calmer ramps). ChartContainer injects them as --color-* for recharts.
const SEVERITY_CONFIG = {
  critical: { label: 'Critical', color: 'var(--sev-critical)' },
  high: { label: 'High', color: 'var(--sev-high)' },
} satisfies ChartConfig;

// Area fill opacity, gradient on/off, and stroke per chart-style.
const TREND_SHAPE: Record<ChartStyle, { fill: number; gradient: boolean; stroke: number }> = {
  signature: { fill: 0.30, gradient: true, stroke: 1.5 },
  muted: { fill: 0.16, gradient: false, stroke: 1.9 },
  heat: { fill: 0.15, gradient: false, stroke: 1.9 },
};

function EmptyChart({ label, height }: { label: string; height: number }) {
  return (
    <div className="flex items-center justify-center text-center text-xs text-stat-subtitle px-4" style={{ height }}>
      {label}
    </div>
  );
}

/** Stacked area of Critical + High findings by scan-day (days with no scans are omitted). */
export function RiskTrendChart({ trend }: { trend: SecurityRiskTrendPoint[] }) {
  const { chartStyle, reduced } = useChartStyle();
  if (trend.length === 0) return <EmptyChart label="No scan history yet" height={220} />;

  const fmtDate = (d: string) => d.slice(5); // MM-DD

  const shape = TREND_SHAPE[chartStyle];
  const gradient = shape.gradient && !reduced;
  const fillOpacity = reduced ? shape.fill * 0.62 : shape.fill;
  const stroke = reduced ? 1.9 : shape.stroke;

  return (
    <ChartContainer config={SEVERITY_CONFIG} className="h-[220px] w-full">
      <AreaChart data={trend} margin={{ left: 4, right: 8, top: 8 }}>
        {gradient && (
          <defs>
            <linearGradient id="riskHigh" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--color-high)" stopOpacity={0.35} />
              <stop offset="95%" stopColor="var(--color-high)" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="riskCritical" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--color-critical)" stopOpacity={0.4} />
              <stop offset="95%" stopColor="var(--color-critical)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
        )}
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="date" tickFormatter={fmtDate} tickLine={false} axisLine={false} fontSize={10} minTickGap={24} />
        <YAxis tickLine={false} axisLine={false} fontSize={10} width={28} allowDecimals={false} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Area
          dataKey="high"
          stackId="risk"
          stroke="var(--color-high)"
          fill={gradient ? 'url(#riskHigh)' : 'var(--color-high)'}
          fillOpacity={gradient ? undefined : fillOpacity}
          strokeWidth={stroke}
        />
        <Area
          dataKey="critical"
          stackId="risk"
          stroke="var(--color-critical)"
          fill={gradient ? 'url(#riskCritical)' : 'var(--color-critical)'}
          fillOpacity={gradient ? undefined : fillOpacity}
          strokeWidth={stroke}
        />
      </AreaChart>
    </ChartContainer>
  );
}

// Action-posture bars. These are independent counts (a finding can be both
// fixable and known-exploited), so they are bars, not a part-of-whole donut.
const POSTURE_CONFIG = { value: { label: 'Findings' } } satisfies ChartConfig;

/** Horizontal bars of the actionability facts, from the overview posture. */
export function ActionPostureChart({ overview }: { overview: SecurityOverview }) {
  const data = [
    { label: 'Fixable', value: overview.fixableCriticalHigh ?? 0, fill: 'var(--sev-high)' },
    { label: 'Known exploited', value: overview.knownExploited ?? 0, fill: 'var(--sev-critical)' },
    { label: 'Needs review', value: overview.needsReview ?? 0, fill: 'var(--sev-medium)' },
    { label: 'Accepted', value: overview.accepted ?? 0, fill: 'var(--stat-icon)' },
    { label: 'Not affected', value: overview.notAffected ?? 0, fill: 'var(--sev-low)' },
  ];
  const known = overview.knownExploited ?? 0;
  const denom = (overview.rawCritical ?? 0) + (overview.rawHigh ?? 0);
  const total = data.reduce((sum, d) => sum + d.value, 0);

  if (denom === 0 && total === 0) return <EmptyChart label="No Critical or High findings" height={220} />;

  return (
    <div>
      <p className="mb-2 text-xs text-stat-subtitle">
        <span className={cn('font-mono tabular-nums', known > 0 ? 'text-destructive' : 'text-stat-value')}>{known}</span>
        {' of '}
        <span className="font-mono tabular-nums text-stat-value">{denom}</span>
        {' Critical+High '}{known === 1 ? 'is' : 'are'} known-exploited.
      </p>
      <ChartContainer config={POSTURE_CONFIG} className="h-[188px] w-full">
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 28, top: 4 }}>
          <XAxis type="number" hide allowDecimals={false} />
          <YAxis type="category" dataKey="label" width={104} tickLine={false} axisLine={false} fontSize={10} />
          <Bar dataKey="value" radius={[0, 2, 2, 0]} maxBarSize={20}>
            {data.map((d) => (<Cell key={d.label} fill={d.fill} />))}
            <LabelList dataKey="value" position="right" className="fill-stat-subtitle" fontSize={10} />
          </Bar>
        </BarChart>
      </ChartContainer>
    </div>
  );
}

// EPSS at or above this is treated as an elevated exploitation likelihood.
const HIGH_EPSS = 0.1;

// Rank by exploitation risk under the "assume it's automatable" principle
// (CISA BOD 26-04): absence of EPSS evidence is NOT treated as low risk. Tiers:
// known-exploited (KEV) > known-elevated EPSS > unknown EPSS > known-low EPSS.
// A finding we have no exploitability evidence for outranks one we have
// evidence is unlikely. CVSS is only a within-tier tiebreaker.
function exploitTier(f: ExploitIntelFinding): number {
  if (f.kev) return 0;
  if (f.epss_score === null) return 2; // unknown: assume potentially automatable
  if (f.epss_score >= HIGH_EPSS) return 1;
  return 3; // evidence of low likelihood
}

function exploitRank(a: ExploitIntelFinding, b: ExploitIntelFinding): number {
  const ta = exploitTier(a);
  const tb = exploitTier(b);
  if (ta !== tb) return ta - tb;
  const ae = a.epss_score ?? -1;
  const be = b.epss_score ?? -1;
  if (ae !== be) return be - ae;
  return (b.cvss_score ?? -1) - (a.cvss_score ?? -1);
}

function shortImage(ref: string): string {
  return ref.length > 30 ? `…${ref.slice(-29)}` : ref;
}

/** Ranked list of the highest exploit-risk actionable findings; row opens the scan. */
export function TopExploitRiskList({
  items,
  onInspect,
}: {
  items: ExploitIntelFinding[];
  onInspect: (scanId: number) => void;
}) {
  if (items.length === 0) return <EmptyChart label="No actionable Critical or High findings" height={220} />;
  const ranked = [...items].sort(exploitRank).slice(0, 8);
  const anyIntel = items.some((i) => i.epss_score !== null || i.kev);

  return (
    <div className="flex flex-col">
      <div className="min-h-[220px]">
        {ranked.map((f) => (
          <button
            key={`${f.scan_id}:${f.vulnerability_id}`}
            type="button"
            onClick={() => onInspect(f.scan_id)}
            className="flex w-full items-center gap-2 border-b border-hairline py-2 text-left last:border-b-0 hover:bg-glass-highlight"
          >
            <span
              className="h-[7px] w-[7px] shrink-0 rounded-full"
              style={{ background: f.severity === 'CRITICAL' ? 'var(--sev-critical)' : 'var(--sev-high)' }}
              aria-hidden
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-xs text-stat-value">{f.vulnerability_id}</span>
              <span className="block truncate font-mono text-[10px] text-stat-icon">{shortImage(f.image_ref)}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {f.kev && (
                <span className="rounded border border-destructive/40 bg-destructive/10 px-1 py-px text-[9px] font-mono uppercase text-destructive">KEV</span>
              )}
              {f.epss_score !== null && (
                <span className="font-mono text-[10px] tabular-nums text-warning">{Math.round(f.epss_score * 100)}%</span>
              )}
              {!f.kev && f.epss_score === null && (
                <span
                  className="font-mono text-[10px] tabular-nums text-stat-subtitle/70"
                  title="Exploitability unrated; treated as potentially automatable"
                >
                  EPSS n/a
                </span>
              )}
              {f.cvss_score !== null && (
                <span className="font-mono text-[10px] tabular-nums text-stat-subtitle">CVSS {f.cvss_score}</span>
              )}
            </span>
          </button>
        ))}
      </div>
      {!anyIntel && (
        <p className="pt-2 text-[10px] leading-snug text-stat-subtitle">
          Ranked by severity. Enable exploit intelligence and re-scan to rank by known-exploited and EPSS.
        </p>
      )}
    </div>
  );
}

interface QuadrantPoint { epssPct: number; cvss: number; cve: string; kev: boolean; image: string }

function QuadrantTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: QuadrantPoint }> }) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-md border border-card-border bg-card px-2 py-1.5 text-xs shadow-card-bevel">
      <div className="font-mono">{p.cve}{p.kev && <span className="ml-1.5 text-destructive">KEV</span>}</div>
      <div className="text-stat-subtitle">CVSS {p.cvss} · EPSS {Math.round(p.epssPct)}%</div>
      <div className="max-w-[220px] truncate text-stat-subtitle">{p.image}</div>
    </div>
  );
}

const QUADRANT_CONFIG = { cvss: { label: 'CVSS' } } satisfies ChartConfig;

/** Scatter of CVSS (severity) by EPSS (exploitability) for actionable findings.
 *  Separates "scary but not exploitable" (high CVSS, low EPSS) from "act first"
 *  (high both). Only findings with both scores can be plotted. */
export function CvssEpssQuadrantChart({ items }: { items: ExploitIntelFinding[] }) {
  const plotted: QuadrantPoint[] = items
    .filter((i) => i.cvss_score !== null && i.epss_score !== null)
    .slice(0, 300)
    .map((i) => ({
      epssPct: (i.epss_score as number) * 100,
      cvss: i.cvss_score as number,
      cve: i.vulnerability_id,
      kev: i.kev,
      image: i.image_ref,
    }));

  if (plotted.length === 0) {
    return <EmptyChart label="Enable exploit intelligence and re-scan to populate" height={220} />;
  }

  const missing = items.length - plotted.length;
  const kevPoints = plotted.filter((p) => p.kev);
  const otherPoints = plotted.filter((p) => !p.kev);

  return (
    <div>
      <ChartContainer config={QUADRANT_CONFIG} className="h-[220px] w-full">
        <ScatterChart margin={{ left: 0, right: 12, top: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            type="number" dataKey="epssPct" name="EPSS" unit="%" domain={[0, 100]}
            tickLine={false} axisLine={false} fontSize={10}
          />
          <YAxis
            type="number" dataKey="cvss" name="CVSS" domain={[0, 10]}
            tickLine={false} axisLine={false} fontSize={10} width={28}
          />
          <ZAxis range={[40, 40]} />
          <ReferenceLine x={10} stroke="var(--border)" strokeDasharray="4 4" />
          <ReferenceLine y={7} stroke="var(--border)" strokeDasharray="4 4" />
          <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<QuadrantTooltip />} />
          <Scatter data={otherPoints} fill="var(--sev-high)" fillOpacity={0.7} />
          <Scatter data={kevPoints} fill="var(--sev-critical)" fillOpacity={0.9} />
        </ScatterChart>
      </ChartContainer>
      {missing > 0 && (
        <p className="pt-2 text-[10px] leading-snug text-stat-subtitle">
          {missing} finding{missing === 1 ? '' : 's'} unrated (missing CVSS or EPSS), not lower risk.
        </p>
      )}
    </div>
  );
}
