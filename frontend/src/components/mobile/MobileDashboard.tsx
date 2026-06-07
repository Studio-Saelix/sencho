import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNodes } from '@/context/NodeContext';
import { useDashboardData } from '@/components/dashboard';
import { deriveHealth } from '@/components/dashboard/deriveHealth';
import type { HealthLevel, NotificationItem, StackCpuSeries, StackStatusEntry } from '@/components/dashboard/types';
import { Bar, Kicker, Masthead, MSparkline, SectionHead, StateDot } from './mobile-ui';

interface MobileDashboardProps {
  notifications: NotificationItem[];
  /** Notification bell + more-menu cluster for the masthead right slot. */
  headerActions: ReactNode;
  onNavigateToStack: (stackFile: string) => void;
  onViewAllStacks: () => void;
}

const SPARK_WINDOW_MS = 10 * 60 * 1000;

const LEVEL_LABEL: Record<HealthLevel, string> = { healthy: 'Healthy', degraded: 'Degraded', critical: 'Critical' };
const LEVEL_TONE: Record<HealthLevel, 'success' | 'warning' | 'destructive'> = {
  healthy: 'success',
  degraded: 'warning',
  critical: 'destructive',
};

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatAgo(ms: number): string {
  const c = Math.max(0, ms);
  if (c < 60_000) return `${Math.round(c / 1000)}s`;
  if (c < 3_600_000) return `${Math.round(c / 60_000)}m`;
  return `${Math.round(c / 3_600_000)}h`;
}

type RowState = 'healthy' | 'warn' | 'error';

function classifyRow(status: StackStatusEntry['status'], peakCpu: number): RowState {
  if (status === 'exited') return 'error';
  if (peakCpu >= 90) return 'error';
  if (peakCpu >= 80) return 'warn';
  return 'healthy';
}

const ROW_TINT: Record<RowState, string> = {
  healthy: '',
  warn: 'bg-warning-muted',
  error: 'bg-destructive-muted',
};
const ROW_TONE: Record<RowState, 'success' | 'warning' | 'destructive'> = {
  healthy: 'success',
  warn: 'warning',
  error: 'destructive',
};
const ROW_STROKE: Record<RowState, string> = {
  healthy: 'var(--brand)',
  warn: 'var(--warning)',
  error: 'var(--destructive)',
};

// One labeled metric cell inside the 3-up strip (memory / disk / network).
function StripCell({ label, value, bar }: { label: string; value: string; bar?: ReactNode }) {
  return (
    <div className="min-w-0 flex-1 px-[13px] py-3">
      <Kicker>{label}</Kicker>
      <div className="mt-1.5 font-mono tabular-nums text-[17px] leading-none text-stat-value truncate">{value}</div>
      {bar}
    </div>
  );
}

export function MobileDashboard({ notifications, headerActions, onNavigateToStack, onViewAllStacks }: MobileDashboardProps) {
  const { activeNode } = useNodes();
  const data = useDashboardData();
  const activeNodeName = activeNode?.name || 'Local';
  const locality = activeNode?.type === 'remote' ? 'remote' : 'local';

  // Re-render every few seconds so the "sync Xs" freshness label advances
  // without a parent refetch, mirroring the desktop HealthStatusBar ticker.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const { level } = useMemo(
    () => deriveHealth(data.stats, data.systemStats, notifications),
    [data.stats, data.systemStats, notifications],
  );

  const cpuVal = parseFloat(data.systemStats?.cpu.usage || '0');
  const ramVal = parseFloat(data.systemStats?.memory.usagePercent || '0');
  const diskVal = parseFloat(data.systemStats?.disk?.usagePercent || '0');
  const netPerSec = (data.systemStats?.network?.rxSec ?? 0) + (data.systemStats?.network?.txSec ?? 0);

  const cpuHistory = data.cpuHistory;
  const cpuPeak = cpuHistory.length > 0 ? Math.max(...cpuHistory) : 0;
  const cpuAvg = cpuHistory.length > 0 ? cpuHistory.reduce((s, v) => s + v, 0) / cpuHistory.length : 0;
  const cpuPeakLabel = useMemo(() => {
    if (cpuHistory.length === 0 || data.historyEndAt === null) return null;
    const peakIndex = cpuHistory.indexOf(cpuPeak);
    if (peakIndex < 0) return null;
    const bucketMs = SPARK_WINDOW_MS / cpuHistory.length;
    const ts = data.historyEndAt - (cpuHistory.length - 1 - peakIndex) * bucketMs;
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, [cpuHistory, cpuPeak, data.historyEndAt]);

  const healthRows = useMemo(() => {
    const list = Object.entries(data.stackStatuses).map(([file, entry]) => {
      const name = file.replace(/\.(ya?ml)$/, '');
      const series: StackCpuSeries | undefined = data.stackCpuSeries[name];
      const peakCpu = series?.peakValue ?? 0;
      return {
        file,
        name,
        status: entry.status,
        cpu: series?.latestValue ?? 0,
        points: series?.points ?? [],
        peakCpu,
        state: classifyRow(entry.status, peakCpu),
      };
    });
    const order: Record<RowState, number> = { error: 0, warn: 1, healthy: 2 };
    list.sort((a, b) => order[a.state] - order[b.state] || b.peakCpu - a.peakCpu);
    return list;
  }, [data.stackStatuses, data.stackCpuSeries]);

  const visibleRows = healthRows.slice(0, 6);
  const stackCount = healthRows.length;
  const upCount = healthRows.filter(r => r.status === 'running').length;
  const downCount = healthRows.filter(r => r.status === 'exited').length;
  const syncLabel = data.lastSyncAt ? `sync ${formatAgo(now - data.lastSyncAt)}` : 'connecting…';

  const cpuSub = cpuHistory.length > 0
    ? `avg ${cpuAvg.toFixed(0)}% last 10m · peak ${cpuPeak.toFixed(0)}%${cpuPeakLabel ? ` @ ${cpuPeakLabel}` : ''}`
    : 'collecting metrics…';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Masthead
        kicker={`${activeNodeName} · ${locality}`}
        state={LEVEL_LABEL[level]}
        stateTone={LEVEL_TONE[level]}
        live={level !== 'healthy' || data.metricsStale}
        meta={
          <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
            {/* When metrics polling has died, "sync Xs" would falsely imply
                liveness, so swap it for a stale marker and a warning chip
                (mirrors the desktop HealthStatusBar badge). */}
            <span>{`${stackCount} stacks · ${upCount} up · ${downCount} dn · ${data.metricsStale ? 'metrics paused' : syncLabel}`}</span>
            {data.metricsStale ? (
              <span className="rounded-sm border border-warning/30 bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-warning">
                metrics stale
              </span>
            ) : null}
          </span>
        }
        right={headerActions}
      />

      <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden p-[14px] [&>*+*]:mt-[14px]">
        {/* CPU hero */}
        <div className="rounded-[12px] border border-card-border border-t-card-border-top bg-card px-[15px] pt-[13px] pb-2 shadow-card-bevel">
          <div className="flex items-start justify-between gap-3">
            <Kicker>{`cpu${data.systemStats ? ` · ${data.systemStats.cpu.cores} cores` : ''}`}</Kicker>
            <span className="font-mono tabular-nums text-[30px] leading-none tracking-[-0.02em] text-stat-value">
              {data.systemStats ? `${cpuVal.toFixed(0)}%` : '--'}
            </span>
          </div>
          <div className="mx-[-3px] mb-1 mt-1.5">
            <MSparkline values={cpuHistory} height={46} peak={false} />
          </div>
          <div className="font-mono text-[10.5px] text-stat-subtitle">{cpuSub}</div>
        </div>

        {/* mem / disk / net 3-up */}
        <div className="flex items-stretch divide-x divide-hairline overflow-hidden rounded-[12px] border border-card-border border-t-card-border-top bg-card shadow-card-bevel">
          <StripCell
            label="mem"
            value={data.systemStats ? `${ramVal.toFixed(0)}%` : '--'}
            bar={data.systemStats ? <Bar pct={ramVal} /> : undefined}
          />
          <StripCell
            label="disk"
            value={data.systemStats?.disk ? `${diskVal.toFixed(0)}%` : '--'}
            bar={data.systemStats?.disk ? <Bar pct={diskVal} /> : undefined}
          />
          <StripCell
            label="net"
            value={data.systemStats?.network ? `${formatBytes(netPerSec)}/s` : '--'}
          />
        </div>

        {/* stack health */}
        <div>
          <SectionHead right={<button type="button" onClick={onViewAllStacks} className="text-brand">view all →</button>}>
            stack health
          </SectionHead>
          {visibleRows.length === 0 ? (
            <p className="px-1 py-4 font-mono text-[12px] text-stat-subtitle">No stacks yet.</p>
          ) : (
            <div className="flex flex-col gap-px">
              {visibleRows.map(row => (
                <button
                  key={row.file}
                  type="button"
                  onClick={() => onNavigateToStack(row.file)}
                  className={`flex min-h-11 items-center gap-2.5 rounded-[7px] px-2.5 py-[9px] text-left ${ROW_TINT[row.state]}`}
                >
                  <StateDot tone={ROW_TONE[row.state]} size={7} glow={row.state !== 'healthy'} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[13px] text-stat-value">{row.name}</span>
                    <span className="block truncate font-mono text-[10px] text-stat-icon">{activeNodeName}</span>
                  </span>
                  <span className="block h-[18px] w-[60px] shrink-0">
                    {row.points.length > 1 ? (
                      <MSparkline values={row.points} height={18} color={ROW_STROKE[row.state]} peak={false} />
                    ) : (
                      <span className="block h-full w-full border-b border-dashed border-hairline" />
                    )}
                  </span>
                  <span
                    className={`w-[34px] shrink-0 text-right font-mono tabular-nums text-[12px] ${row.cpu >= 80 ? 'text-warning' : 'text-stat-subtitle'}`}
                  >
                    {`${row.cpu.toFixed(0)}%`}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
