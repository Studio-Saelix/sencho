import { useMemo } from 'react';
import { Sparkline } from '@/components/ui/sparkline';
import { ShowUsageLink } from '@/components/ui/show-usage-link';
import { parseHostUsage } from '@/lib/hostUsage';
import type { SystemStats } from './types';

interface ResourceGaugesProps {
  systemStats: SystemStats | null;
  cpuHistory: number[];
  netHistory: number[];
  historyEndAt: number | null;
}

const SPARK_WINDOW_MS = 10 * 60 * 1000;

const formatBytes = (bytes: number): string => {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

const getValueTone = (value: number, warn = 80, crit = 90): string => {
  if (value >= crit) return 'text-destructive';
  if (value >= warn) return 'text-warning';
  return 'text-stat-value';
};

const getBarColor = (value: number, warn = 80, crit = 90): string => {
  if (value >= crit) return 'var(--destructive)';
  if (value >= warn) return 'var(--warning)';
  return 'var(--brand)';
};

function GaugeBar({ value, warn = 80, crit = 90 }: { value: number; warn?: number; crit?: number }) {
  const color = getBarColor(value, warn, crit);
  return (
    <div className="mt-3 h-1 rounded-full bg-muted/60 overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{
          width: `${Math.min(value, 100)}%`,
          backgroundColor: color,
          boxShadow: `0 0 8px ${color}, 0 0 2px ${color}`,
        }}
      />
    </div>
  );
}

export function ResourceGauges({ systemStats, cpuHistory, netHistory, historyEndAt }: ResourceGaugesProps) {
  // Null usage means the host cannot be measured from here (a nested container
  // with no cgroup mount). It is not zero, so it reads `--` with no threshold
  // tone and no bar.
  const cpuVal = parseHostUsage(systemStats?.cpu.usage);
  const cpuUnknown = systemStats !== null && cpuVal === null;
  const memory = systemStats?.memory;
  // Balloon-adjusted percent so hero, tone, bar, and used/total agree with the
  // shared health verdict. Host RAM alerts still read working-set usagePercent.
  const ramVal = parseHostUsage(memory?.effectiveUsagePercent ?? memory?.usagePercent);
  const ramUnknown = systemStats !== null && ramVal === null;
  const ramUsed = memory?.effectiveUsed ?? memory?.used ?? null;
  // Raw working set, kept separately: the ARC line reports memory in use
  // before the balloon adjustment, as it always has.
  const ramRawUsed = memory?.used ?? null;
  const ramTotal = memory?.effectiveTotal ?? memory?.total ?? 0;
  const ramBallooned = memory?.ballooned ?? 0;
  const ramArcReclaimable = memory?.arcReclaimable ?? 0;
  // Memory retained by the guest after hypervisor reclaim, with pressure as
  // effective used over that retained amount. The retained line needs a
  // positive value; pressure additionally needs the balloon-adjusted numerator
  // (never raw used).
  const vmRetained = ramTotal - ramBallooned;
  // Call sites are already inside the ramBallooned > 0 block.
  const showVmRetained = vmRetained > 0;
  const diskVal = parseFloat(systemStats?.disk?.usagePercent || '0');

  const cpuPeak = cpuHistory.length > 0 ? Math.max(...cpuHistory) : 0;
  const cpuPeakIndex = cpuHistory.length > 0 ? cpuHistory.indexOf(cpuPeak) : -1;
  const cpuAvg = cpuHistory.length > 0
    ? cpuHistory.reduce((sum, v) => sum + v, 0) / cpuHistory.length
    : 0;

  const cpuPeakLabel = useMemo(() => {
    if (cpuPeakIndex < 0 || cpuHistory.length === 0 || historyEndAt === null) return null;
    const bucketMs = SPARK_WINDOW_MS / cpuHistory.length;
    const ts = historyEndAt - (cpuHistory.length - 1 - cpuPeakIndex) * bucketMs;
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, [cpuPeakIndex, cpuHistory.length, historyEndAt]);

  const netHasSignal = netHistory.some((v) => v > 0);
  const netTotalPerSec = (systemStats?.network?.rxSec ?? 0) + (systemStats?.network?.txSec ?? 0);

  return (
    <div className="grid grid-cols-1 overflow-hidden rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel md:grid-cols-[2fr_1fr_1fr_1fr]">
      {/* CPU hero */}
      <div className="relative px-[var(--density-row-x)] py-[var(--density-tile-y)] md:border-r md:border-border/60">
        <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle">
          CPU{cpuUnknown ? '' : systemStats ? ` · ${systemStats.cpu.cores} cores` : ''}
        </div>
        <div className={`mt-2 font-mono tabular-nums text-4xl leading-none ${cpuVal !== null ? getValueTone(cpuVal) : 'text-stat-value'}`}>
          {cpuVal !== null ? `${cpuVal.toFixed(1)}%` : '--'}
        </div>
        <div className="mt-1.5 font-mono text-[11px] text-stat-subtitle">
          {cpuUnknown ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>{systemStats.cpu.cores} cores · usage unknown</span>
              <ShowUsageLink />
            </span>
          ) : cpuHistory.length > 0
            ? `avg ${cpuAvg.toFixed(0)}% last 10m · peak ${cpuPeak.toFixed(0)}%${cpuPeakLabel ? ` @ ${cpuPeakLabel}` : ''}`
            : 'collecting metrics…'}
        </div>
        <div className="mt-3 h-14 w-full">
          <Sparkline
            points={cpuHistory}
            stroke="var(--chart-1)"
            fill="var(--chart-1)"
            showPeak={false}
          />
        </div>
      </div>

      {/* Memory */}
      <div className="px-[var(--density-row-x)] py-[var(--density-tile-y)] border-t border-border/60 md:border-t-0 md:border-r">
        <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle">
          MEMORY
        </div>
        <div className={`mt-2 font-mono tabular-nums text-2xl leading-none ${ramVal !== null ? getValueTone(ramVal) : 'text-stat-value'}`}>
          {ramVal !== null ? `${ramVal.toFixed(0)}%` : '--'}
        </div>
        <div className="mt-1.5 font-mono text-[11px] text-stat-subtitle">
          {ramUnknown ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>{formatBytes(ramTotal)} total · usage unknown</span>
              <ShowUsageLink />
            </span>
          ) : ramUsed !== null ? `${formatBytes(ramUsed)} / ${formatBytes(ramTotal)}` : '\u00A0'}
        </div>
        {ramBallooned > 0 ? (
          <div className="mt-1 font-mono text-[10px] text-stat-subtitle/70">
            {showVmRetained ? (
              <div>Current VM Memory: {formatBytes(vmRetained)}</div>
            ) : null}
            {showVmRetained && memory?.effectiveUsed !== undefined ? (
              <div>Current pressure: {((memory.effectiveUsed / vmRetained) * 100).toFixed(0)}%</div>
            ) : null}
            <div>Balloon reclaimable: {formatBytes(ramBallooned)}</div>
          </div>
        ) : null}
        {ramRawUsed !== null && ramArcReclaimable > 0 ? (
          <div className="mt-1 font-mono text-[10px] text-stat-subtitle/70">
            <div>Current memory in use: {formatBytes(ramRawUsed + ramArcReclaimable)}</div>
            <div>ZFS ARC reclaimable: {formatBytes(ramArcReclaimable)}</div>
          </div>
        ) : null}
        {ramVal !== null ? <GaugeBar value={ramVal} /> : null}
      </div>

      {/* Disk */}
      <div className="px-[var(--density-row-x)] py-[var(--density-tile-y)] border-t border-border/60 md:border-t-0 md:border-r">
        <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle">
          DISK
        </div>
        <div className={`mt-2 font-mono tabular-nums text-2xl leading-none ${systemStats?.disk ? getValueTone(diskVal) : 'text-stat-value'}`}>
          {systemStats?.disk ? `${diskVal.toFixed(0)}%` : '--'}
        </div>
        <div className="mt-1.5 font-mono text-[11px] text-stat-subtitle">
          {systemStats?.disk ? `${formatBytes(systemStats.disk.used)} / ${formatBytes(systemStats.disk.total)}` : '\u00A0'}
        </div>
        {systemStats?.disk ? <GaugeBar value={diskVal} /> : null}
      </div>

      {/* Network */}
      <div className="px-[var(--density-row-x)] py-[var(--density-tile-y)] border-t border-border/60 md:border-t-0">
        <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle">
          NETWORK
        </div>
        <div className="mt-2 font-mono tabular-nums text-2xl leading-none text-stat-value">
          {systemStats?.network ? `${formatBytes(netTotalPerSec)}/s` : '--'}
        </div>
        <div className="mt-1.5 flex items-center gap-2 font-mono text-[11px] text-stat-subtitle">
          {systemStats?.network ? (
            <>
              <span className="text-stat-icon">↓</span>
              <span className="tabular-nums text-stat-value">{formatBytes(systemStats.network.rxSec)}/s</span>
              <span className="text-stat-icon">·</span>
              <span className="text-stat-icon">↑</span>
              <span className="tabular-nums text-stat-value">{formatBytes(systemStats.network.txSec)}/s</span>
            </>
          ) : (
            <span>{'\u00A0'}</span>
          )}
        </div>
        <div className="mt-3 h-5 w-full">
          {systemStats?.network && netHasSignal ? (
            <Sparkline
              points={netHistory}
              stroke="var(--chart-1)"
              fill="var(--chart-1)"
              showPeak={false}
              strokeWidth={1}
            />
          ) : systemStats?.network ? (
            <span className="block h-full w-full border-b border-dashed border-border/60" />
          ) : null}
        </div>
      </div>
    </div>
  );
}
