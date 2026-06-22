import { useMemo } from 'react';
import { PieChart, Pie, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, LabelList } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { useChartStyle, type ChartStyle } from '@/hooks/use-theme';
import type { ScanSummary, SecurityRiskTrendPoint } from '@/types/security';

// Severity colours resolve through the --sev-* tokens, which the appearance
// chart-style switches (Signature keeps today's saturated semantics; Muted and
// Heat are calmer ramps). ChartContainer injects them as --color-* for recharts.
const SEVERITY_CONFIG = {
  critical: { label: 'Critical', color: 'var(--sev-critical)' },
  high: { label: 'High', color: 'var(--sev-high)' },
  medium: { label: 'Medium', color: 'var(--sev-medium)' },
  low: { label: 'Low', color: 'var(--sev-low)' },
} satisfies ChartConfig;

// Area fill opacity, gradient on/off, and stroke per chart-style. Colours stay in
// the --sev-* tokens; only these shape values vary. Reduced effects flattens
// (no gradient) and dims the fill, matching the calm material direction.
const TREND_SHAPE: Record<ChartStyle, { fill: number; gradient: boolean; stroke: number }> = {
  signature: { fill: 0.30, gradient: true, stroke: 1.5 },
  muted: { fill: 0.16, gradient: false, stroke: 1.9 },
  heat: { fill: 0.15, gradient: false, stroke: 1.9 },
};

// The trend and top-exposed charts both plot only the Critical + High slots.
const CRITICAL_HIGH_CONFIG = {
  critical: SEVERITY_CONFIG.critical,
  high: SEVERITY_CONFIG.high,
} satisfies ChartConfig;

function EmptyChart({ label, height }: { label: string; height: number }) {
  return (
    <div className="flex items-center justify-center text-xs text-stat-subtitle" style={{ height }}>
      {label}
    </div>
  );
}

/** Donut of total findings by severity across the node's scanned images. */
export function SeverityDonutChart({ summaries }: { summaries: ScanSummary[] }) {
  const data = useMemo(() => {
    const totals = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const s of summaries) {
      totals.critical += s.critical;
      totals.high += s.high;
      totals.medium += s.medium;
      totals.low += s.low;
    }
    return (['critical', 'high', 'medium', 'low'] as const)
      .map((k) => ({ key: k, label: SEVERITY_CONFIG[k].label, value: totals[k], fill: `var(--color-${k})` }))
      .filter((d) => d.value > 0);
  }, [summaries]);

  const total = data.reduce((sum, d) => sum + d.value, 0);
  if (total === 0) return <EmptyChart label="No findings to chart" height={220} />;

  return (
    <ChartContainer config={SEVERITY_CONFIG} className="h-[220px] w-full">
      <PieChart>
        <ChartTooltip content={<ChartTooltipContent nameKey="label" hideLabel />} />
        <Pie data={data} dataKey="value" nameKey="label" innerRadius={55} outerRadius={85} strokeWidth={2} paddingAngle={2} />
      </PieChart>
    </ChartContainer>
  );
}

/** Stacked area of Critical + High findings by scan-day (days with no scans are omitted). */
export function RiskTrendChart({ trend }: { trend: SecurityRiskTrendPoint[] }) {
  const { chartStyle, reduced } = useChartStyle();
  if (trend.length === 0) return <EmptyChart label="No scan history yet" height={220} />;

  const fmtDate = (d: string) => d.slice(5); // MM-DD

  const shape = TREND_SHAPE[chartStyle];
  // Signature (gradient, stroke 1.5) is the no-op baseline. Flat styles and
  // reduced effects drop the gradient for a solid low-opacity fill + thicker line.
  const gradient = shape.gradient && !reduced;
  const fillOpacity = reduced ? shape.fill * 0.62 : shape.fill;
  const stroke = reduced ? 1.9 : shape.stroke;

  return (
    <ChartContainer config={CRITICAL_HIGH_CONFIG} className="h-[220px] w-full">
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

interface TopImageDatum { name: string; critical: number; high: number; scanId: number }

/** Horizontal stacked bars of the top images by Critical+High; click opens the scan. */
export function TopExposedImagesChart({
  summaries,
  onInspect,
}: {
  summaries: ScanSummary[];
  onInspect: (scanId: number) => void;
}) {
  const data: TopImageDatum[] = useMemo(
    () =>
      summaries
        .filter((s) => !s.image_ref.startsWith('stack:') && s.critical + s.high > 0)
        .sort((a, b) => b.critical + b.high - (a.critical + a.high))
        .slice(0, 6)
        .map((s) => ({
          name: s.image_ref.length > 28 ? `…${s.image_ref.slice(-27)}` : s.image_ref,
          critical: s.critical,
          high: s.high,
          scanId: s.scan_id,
        })),
    [summaries],
  );

  if (data.length === 0) return <EmptyChart label="No exposed images" height={220} />;

  const handleBarClick = (d: unknown) => {
    const dd = d as TopImageDatum;
    if (dd?.scanId != null) onInspect(dd.scanId);
  };

  return (
    <ChartContainer config={CRITICAL_HIGH_CONFIG} className="h-[220px] w-full">
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }}>
        <XAxis type="number" hide allowDecimals={false} />
        <YAxis type="category" dataKey="name" width={150} tickLine={false} axisLine={false} fontSize={10} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="critical" stackId="r" fill="var(--color-critical)" radius={[2, 0, 0, 2]} className="cursor-pointer" onClick={handleBarClick} />
        <Bar dataKey="high" stackId="r" fill="var(--color-high)" radius={[0, 2, 2, 0]} className="cursor-pointer" onClick={handleBarClick} />
      </BarChart>
    </ChartContainer>
  );
}

/** Vertical bars comparing the three finding types. */
export function FindingsByTypeChart({ summaries }: { summaries: ScanSummary[] }) {
  const data = useMemo(() => {
    let vulnerabilities = 0;
    let secrets = 0;
    let misconfigs = 0;
    for (const s of summaries) {
      vulnerabilities += s.total;
      secrets += s.secret_count;
      misconfigs += s.misconfig_count;
    }
    // Route every series through the severity ramp (or a neutral for misconfigs)
    // so no two complementary hues sit adjacent (the old cyan-next-to-rose clash).
    // --stat-icon is palette-invariant by design: misconfigs stay neutral across
    // Muted/Heat rather than picking up a severity hue.
    return [
      { type: 'Vulnerabilities', value: vulnerabilities, fill: 'var(--sev-vuln)' },
      { type: 'Secrets', value: secrets, fill: 'var(--sev-critical)' },
      { type: 'Misconfigs', value: misconfigs, fill: 'var(--stat-icon)' },
    ];
  }, [summaries]);

  const total = data.reduce((sum, d) => sum + d.value, 0);
  if (total === 0) return <EmptyChart label="No findings to chart" height={220} />;

  const config = {
    value: { label: 'Findings' },
  } satisfies ChartConfig;

  return (
    <ChartContainer config={config} className="h-[220px] w-full">
      <BarChart data={data} margin={{ left: 4, right: 8, top: 16 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="type" tickLine={false} axisLine={false} fontSize={10} />
        <YAxis tickLine={false} axisLine={false} fontSize={10} width={28} allowDecimals={false} />
        <ChartTooltip content={<ChartTooltipContent hideLabel />} />
        <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={64}>
          <LabelList dataKey="value" position="top" className="fill-stat-subtitle" fontSize={10} />
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
