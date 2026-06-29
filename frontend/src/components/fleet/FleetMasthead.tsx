import { useEffect, useMemo, useState } from 'react';
import { Bell } from 'lucide-react';
import { MastheadRail } from '@/components/ui/MastheadRail';
type FleetHealth = 'healthy' | 'degraded' | 'critical';

interface FleetMastheadProps {
  nodeCount: number;
  onlineCount: number;
  criticalCount: number;
  totalCpuPercent: number;
  worstCpu: { name: string; percent: number } | null;
  totalMemUsed: number;
  totalMemTotal: number;
  activeContainers: number;
  totalContainers: number;
  lastSyncAt: number | null;
  loading: boolean;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 GiB';
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function formatAgo(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 60_000) return `${Math.round(clamped / 1000)}s`;
  if (clamped < 3_600_000) return `${Math.round(clamped / 60_000)}m`;
  return `${Math.round(clamped / 3_600_000)}h`;
}

function useTicker(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const healthConfig: Record<FleetHealth, { label: string; textClass: string; railClass: string; tintClass: string }> = {
  healthy: {
    label: 'The fleet',
    textClass: 'text-stat-value',
    railClass: 'bg-brand',
    tintClass: 'from-brand/[0.06] via-transparent to-transparent',
  },
  degraded: {
    label: 'The fleet',
    textClass: 'text-warning',
    railClass: 'bg-warning',
    tintClass: 'from-warning/[0.06] via-transparent to-transparent',
  },
  critical: {
    label: 'The fleet',
    textClass: 'text-destructive',
    railClass: 'bg-destructive',
    tintClass: 'from-destructive/[0.06] via-transparent to-transparent',
  },
};

export function FleetMasthead({
  nodeCount,
  onlineCount,
  criticalCount,
  totalCpuPercent,
  worstCpu,
  totalMemUsed,
  totalMemTotal,
  activeContainers,
  totalContainers,
  lastSyncAt,
  loading,
}: FleetMastheadProps) {
  const level: FleetHealth = useMemo(() => {
    if (criticalCount > 0) return 'critical';
    if (onlineCount < nodeCount) return 'degraded';
    return 'healthy';
  }, [criticalCount, onlineCount, nodeCount]);
  const config = healthConfig[level];
  const now = useTicker(1000);

  const offlineCount = Math.max(0, nodeCount - onlineCount);
  const reasons: string[] = [];
  if (offlineCount > 0) reasons.push(`${offlineCount} offline`);
  if (criticalCount > 0) reasons.push(`${criticalCount} critical`);

  const lastSyncLabel = loading
    ? 'syncing…'
    : lastSyncAt
      ? `last sync ${formatAgo(now - lastSyncAt)}`
      : 'no sync yet';

  const metaLine = `${nodeCount} ${nodeCount === 1 ? 'node' : 'nodes'} · ${onlineCount} online · ${lastSyncLabel}`;
  const reasonsLine = reasons.join(' · ');

  const cpuTone = totalCpuPercent >= 80 ? 'warn' : 'value';
  const memPercent = totalMemTotal > 0 ? (totalMemUsed / totalMemTotal) * 100 : 0;

  return (
    <div className="relative overflow-hidden rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel transition-colors mb-4">
      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-r ${config.tintClass}`} />
      <MastheadRail variant={level === 'healthy' ? 'shimmer' : 'glow'} className={config.railClass} />
      <div className="relative grid grid-cols-[auto_1fr_auto] items-center gap-6 py-5 pl-7 pr-6">
        <div className="flex items-center gap-4">
          <div className="flex flex-col gap-1">
            <span className={`font-heading text-3xl leading-none tracking-tight ${config.textClass}`}>
              {config.label}
            </span>
            <span className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">
              {metaLine}
            </span>
            {reasonsLine ? (
              <span className="font-mono text-[11px] text-stat-subtitle/90">
                {reasonsLine}
              </span>
            ) : null}
          </div>
        </div>

        <div className="hidden items-stretch justify-end gap-0 md:flex">
          <StatTile
            label="CPU"
            value={`${totalCpuPercent.toFixed(0)}%`}
            sub={worstCpu ? `peak ${worstCpu.name} ${worstCpu.percent.toFixed(0)}%` : undefined}
            tone={cpuTone}
          />
          <StatTile
            label="MEM"
            value={formatBytes(totalMemUsed)}
            sub={totalMemTotal > 0 ? `of ${formatBytes(totalMemTotal)} · ${memPercent.toFixed(0)}%` : undefined}
            tone="value"
            divider
          />
          <StatTile
            label="CONTAINERS"
            value={`${activeContainers}`}
            sub={`of ${totalContainers} total`}
            tone="value"
            divider
          />
        </div>

        <div className="flex items-center gap-2 pl-4">
          <Bell
            className={`h-3.5 w-3.5 ${criticalCount > 0 ? 'text-destructive' : 'text-stat-icon'}`}
            strokeWidth={1.5}
          />
          <span
            className={`font-mono text-sm tabular-nums ${criticalCount > 0 ? 'text-destructive' : 'text-stat-subtitle'}`}
          >
            {criticalCount}
          </span>
          <span className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">
            {criticalCount === 1 ? 'alert' : 'alerts'}
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
