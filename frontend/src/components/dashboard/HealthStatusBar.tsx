import { useEffect, useMemo, useState } from 'react';
import { Bell } from 'lucide-react';
import { MastheadRail } from '@/components/ui/MastheadRail';
import type { Stats, SystemStats, NotificationItem, HealthLevel } from './types';
import { deriveHealth } from './deriveHealth';
import { countVisibleUnread } from '@/lib/notificationVisibility';
import { unreadableNodeHeadline, type UnreadableNodeFailure } from '@/lib/remoteReadFailure';
import { parseHostUsage } from '@/lib/hostUsage';

interface HealthStatusBarProps {
  stats: Stats;
  systemStats: SystemStats | null;
  notifications: NotificationItem[];
  activeNodeName: string;
  nodeCount: number;
  lastSyncAt: number | null;
  /** True when the metrics reads are not answering: several consecutive failures,
   *  or the first read that shows the hub has no readable path to the selected node. */
  metricsStale?: boolean;
  /** True when a read stopped at a state where the hub has no readable path to
   *  the node, as opposed to stale meters. */
  metricsUnreadable?: boolean;
  /** Why the node is unreadable, so the bar names a disconnected Pilot or an
   *  unconfigured node instead of calling every cause "not answering". */
  unreadableCause?: UnreadableNodeFailure | null;
  /** True until the first metrics read for the active node settles. The headline
   *  must not claim the default (healthy) level while that read is still queued. */
  metricsPending?: boolean;
}

const healthConfig: Record<HealthLevel, { label: string; textClass: string; railClass: string; tintClass: string }> = {
  healthy: {
    label: 'Healthy',
    textClass: 'text-stat-value',
    railClass: 'bg-brand/70',
    tintClass: 'from-brand/[0.06] via-transparent to-transparent',
  },
  degraded: {
    label: 'Degraded',
    textClass: 'text-warning',
    railClass: 'bg-warning/70',
    tintClass: 'from-warning/[0.06] via-transparent to-transparent',
  },
  critical: {
    label: 'Critical',
    textClass: 'text-destructive',
    railClass: 'bg-destructive/70',
    tintClass: 'from-destructive/[0.06] via-transparent to-transparent',
  },
};

/**
 * Shown instead of the derived level when the metrics reads are not answering.
 * A node nobody can reach has no health to report, and its last known zeros must
 * not be read as a clean bill of health.
 */
const unavailableHealth = {
  label: 'Unknown',
  textClass: 'text-muted-foreground',
  railClass: 'bg-muted-foreground/40',
  tintClass: 'from-muted-foreground/[0.04] via-transparent to-transparent',
};

/**
 * Shown until the first metrics read settles. The default counters are zeros,
 * which would derive "Healthy"; that is a claim about a node nobody has read yet.
 */
const pendingHealth = {
  label: 'Checking',
  textClass: 'text-muted-foreground',
  railClass: 'bg-muted-foreground/40',
  tintClass: 'from-muted-foreground/[0.04] via-transparent to-transparent',
};

function formatGib(bytes: number): string {
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

// The "last sync Xs" label only shifts visibly every few seconds, so a 5 s
// re-render cadence keeps the freshness signal accurate without forcing the
// dashboard tree through the reconciler once per second.
const SYNC_LABEL_TICK_MS = 5000;

export function HealthStatusBar({
  stats,
  systemStats,
  notifications,
  activeNodeName,
  nodeCount,
  lastSyncAt,
  metricsStale = false,
  metricsUnreadable = false,
  unreadableCause = null,
  metricsPending = false,
}: HealthStatusBarProps) {
  const { level, reasons } = useMemo(
    () => deriveHealth(stats, systemStats, notifications),
    [stats, systemStats, notifications],
  );
  // "Unknown" is reserved for a node the hub cannot read. Stale meters with a
  // known local cause (the Docker socket, the metrics service) keep the derived
  // level and the stale chip, so the copy does not blame the network for them.
  const config = metricsUnreadable ? unavailableHealth : metricsPending ? pendingHealth : healthConfig[level];
  const now = useTicker(SYNC_LABEL_TICK_MS);
  const unreadAlerts = countVisibleUnread(notifications);
  const running = `${stats.active}/${stats.total}`;
  // Null usage (nested container, no cgroup mount) reads `--`, never 0%.
  const cpuReading = parseHostUsage(systemStats?.cpu.usage);
  const memReading = systemStats?.memory.effectiveUsed ?? systemStats?.memory.used ?? null;
  const cpuLabel = cpuReading !== null ? `${cpuReading.toFixed(0)}%` : '--';
  const memLabel = memReading !== null ? formatGib(memReading) : '--';
  const lastSyncLabel = lastSyncAt ? `last sync ${formatAgo(now - lastSyncAt)}` : 'connecting…';
  const metaLine = `${activeNodeName} · ${nodeCount} ${nodeCount === 1 ? 'node' : 'nodes'} · ${lastSyncLabel}`;
  const reasonsLine = metricsUnreadable
    ? unreadableNodeHeadline(unreadableCause, activeNodeName)
    : metricsPending
      ? 'Reading this node…'
      : reasons.join(' · ');
  const live = !metricsUnreadable && !metricsPending && level === 'healthy';

  return (
    <div
      className={`relative overflow-hidden rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel transition-colors`}
    >
      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-r ${config.tintClass}`} />
      <MastheadRail variant={live ? 'shimmer' : 'glow'} className={config.railClass} />
      <div className="relative grid grid-cols-[auto_1fr_auto] items-center gap-6 py-5 pl-7 pr-6">
        {/* State column */}
        <div className="flex items-center gap-4">
          <div className="flex flex-col gap-1">
            <span className={`font-heading text-3xl leading-none tracking-tight ${config.textClass}`}>
              {config.label}
            </span>
            <span className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">
              {metaLine}
              {metricsStale ? (
                <span className="ml-2 inline-flex items-center rounded-sm border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[10px] font-mono tracking-wide uppercase text-warning">
                  metrics stale
                </span>
              ) : null}
            </span>
            {reasonsLine ? (
              <span className="font-mono text-[11px] text-stat-subtitle/90">
                {reasonsLine}
              </span>
            ) : null}
          </div>
        </div>

        {/* Stats column */}
        <div className="hidden items-stretch justify-end gap-0 md:flex">
          <StatTile label="RUNNING" value={running} tone="value" />
          <StatTile label="CPU" value={cpuLabel} tone={(cpuReading ?? 0) >= 80 ? 'warn' : 'value'} divider />
          <StatTile label="MEM" value={memLabel} tone="value" divider />
        </div>

        {/* Right column */}
        <div className="flex items-center gap-2 pl-4">
          <Bell
            className={`h-3.5 w-3.5 ${unreadAlerts > 0 ? 'text-warning' : 'text-stat-icon'}`}
            strokeWidth={1.5}
          />
          <span
            className={`font-mono text-sm tabular-nums ${unreadAlerts > 0 ? 'text-warning' : 'text-stat-subtitle'}`}
          >
            {unreadAlerts}
          </span>
          <span className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">
            {unreadAlerts === 1 ? 'alert' : 'alerts'}
          </span>
        </div>
      </div>
    </div>
  );
}

function StatTile({
  label,
  value,
  tone,
  divider,
}: {
  label: string;
  value: string;
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
    </div>
  );
}
