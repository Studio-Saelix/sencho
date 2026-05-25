import { useEffect, useMemo, useState } from 'react';
import { Bell } from 'lucide-react';
import {
  CursorProvider,
  Cursor,
  CursorContainer,
  CursorFollow,
} from '@/components/animate-ui/primitives/animate/cursor';
import type { Stats, SystemStats, NotificationItem, HealthLevel } from './types';

interface HealthStatusBarProps {
  stats: Stats;
  systemStats: SystemStats | null;
  notifications: NotificationItem[];
  activeNodeName: string;
  nodeCount: number;
  lastSyncAt: number | null;
  /** True after several consecutive metrics polls have failed (Docker socket or metrics path down). */
  metricsStale?: boolean;
}

interface HealthResult {
  level: HealthLevel;
  reasons: string[];
}

function deriveHealth(stats: Stats, systemStats: SystemStats | null, notifications: NotificationItem[]): HealthResult {
  const cpu = parseFloat(systemStats?.cpu.usage || '0');
  const ram = parseFloat(systemStats?.memory.usagePercent || '0');
  const disk = parseFloat(systemStats?.disk?.usagePercent || '0');
  const unreadErrors = notifications.filter(n => !n.is_read && n.level === 'error').length;

  const reasons: string[] = [];
  if (cpu >= 80) reasons.push(`CPU ${cpu.toFixed(0)}%`);
  if (ram >= 80) reasons.push(`RAM ${ram.toFixed(0)}%`);
  if (disk >= 80) reasons.push(`Disk ${disk.toFixed(0)}%`);
  if (stats.exited > 0) reasons.push(`${stats.exited} exited`);
  if (unreadErrors > 0) reasons.push(`${unreadErrors} unread ${unreadErrors === 1 ? 'error' : 'errors'}`);

  if (cpu >= 90 || ram >= 90 || disk >= 90 || (stats.exited > 0 && unreadErrors > 0)) {
    return { level: 'critical', reasons };
  }
  if (cpu >= 80 || ram >= 80 || disk >= 80 || stats.exited > 0 || unreadErrors > 0) {
    return { level: 'degraded', reasons };
  }
  return { level: 'healthy', reasons: ['All systems nominal'] };
}

const healthConfig: Record<HealthLevel, { label: string; dotClass: string; textClass: string; railClass: string; tintClass: string }> = {
  healthy: {
    label: 'Healthy',
    dotClass: 'bg-success shadow-[0_0_0_3px_color-mix(in_oklch,var(--success)_20%,transparent)]',
    textClass: 'text-stat-value',
    railClass: 'bg-brand',
    tintClass: 'from-brand/[0.06] via-transparent to-transparent',
  },
  degraded: {
    label: 'Degraded',
    dotClass: 'bg-warning shadow-[0_0_0_3px_color-mix(in_oklch,var(--warning)_22%,transparent)]',
    textClass: 'text-warning',
    railClass: 'bg-warning',
    tintClass: 'from-warning/[0.06] via-transparent to-transparent',
  },
  critical: {
    label: 'Critical',
    dotClass: 'bg-destructive shadow-[0_0_0_3px_color-mix(in_oklch,var(--destructive)_24%,transparent)]',
    textClass: 'text-destructive',
    railClass: 'bg-destructive',
    tintClass: 'from-destructive/[0.06] via-transparent to-transparent',
  },
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

export function HealthStatusBar({
  stats,
  systemStats,
  notifications,
  activeNodeName,
  nodeCount,
  lastSyncAt,
  metricsStale = false,
}: HealthStatusBarProps) {
  const { level, reasons } = useMemo(
    () => deriveHealth(stats, systemStats, notifications),
    [stats, systemStats, notifications],
  );
  const config = healthConfig[level];
  const now = useTicker(1000);
  const unreadAlerts = notifications.filter(n => !n.is_read).length;
  const running = `${stats.active}/${stats.total}`;
  const cpuLabel = systemStats ? `${parseFloat(systemStats.cpu.usage).toFixed(0)}%` : '--';
  const memLabel = systemStats ? formatGib(systemStats.memory.used) : '--';
  const lastSyncLabel = lastSyncAt ? `last sync ${formatAgo(now - lastSyncAt)}` : 'connecting…';
  const metaLine = `${activeNodeName} · ${nodeCount} ${nodeCount === 1 ? 'node' : 'nodes'} · ${lastSyncLabel}`;
  const reasonsLine = reasons.join(' · ');

  return (
    <div
      className={`relative overflow-hidden rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel transition-colors`}
    >
      <div className={`pointer-events-none absolute inset-0 bg-gradient-to-r ${config.tintClass}`} />
      <div className={`absolute inset-y-0 left-0 w-[3px] ${config.railClass}`} />
      <div className="relative grid grid-cols-[auto_1fr_auto] items-center gap-6 py-5 pl-7 pr-6">
        {/* State column */}
        <div className="flex items-center gap-4">
          <span
            aria-hidden="true"
            className={`h-2.5 w-2.5 rounded-full ${config.dotClass} ${level === 'healthy' ? '' : 'animate-[pulse_2.4s_ease-in-out_infinite]'}`}
          />
          <div className="flex flex-col gap-1">
            <span className={`font-display italic text-3xl leading-none tracking-tight ${config.textClass}`}>
              {config.label}
            </span>
            <span className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">
              {metaLine}
              {metricsStale ? (
                <span className="ml-2 inline-flex items-center rounded-sm border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[10px] font-mono tracking-wide uppercase text-warning">
                  metrics paused
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
          <CursorProvider>
            <CursorContainer>
              <StatTile label="RUNNING" value={running} tone="value" />
            </CursorContainer>
            <Cursor>
              <span className="h-2 w-2 rounded-full bg-brand" />
            </Cursor>
            <CursorFollow
              side="bottom"
              sideOffset={8}
              align="center"
              transition={{ stiffness: 400, damping: 40, bounce: 0 }}
            >
              <div className="rounded-md border border-card-border bg-popover/95 backdrop-blur-[10px] backdrop-saturate-[1.15] px-3 py-2 shadow-md">
                <div className="flex items-center gap-3 font-mono text-xs tabular-nums">
                  <span className="text-stat-value">
                    {stats.managed}
                    <span className="ml-1 font-sans text-stat-subtitle">managed</span>
                  </span>
                  <span className="text-stat-icon">·</span>
                  <span className="text-stat-value">
                    {stats.unmanaged}
                    <span className="ml-1 font-sans text-stat-subtitle">external</span>
                  </span>
                  {stats.exited > 0 ? (
                    <>
                      <span className="text-stat-icon">·</span>
                      <span className="text-destructive">
                        {stats.exited}
                        <span className="ml-1 font-sans text-stat-subtitle">exited</span>
                      </span>
                    </>
                  ) : null}
                </div>
              </div>
            </CursorFollow>
          </CursorProvider>
          <StatTile label="CPU" value={cpuLabel} tone={parseFloat(systemStats?.cpu.usage || '0') >= 80 ? 'warn' : 'value'} divider />
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
