import type { Stats, SystemStats, NotificationItem, HealthLevel } from './types';

export interface HealthResult {
  level: HealthLevel;
  reasons: string[];
}

/**
 * Parse a usage reading. `null` means the host cannot measure it (a nested
 * container with no cgroup mount); that is not zero and must never move the
 * verdict, it only makes the unknown state visible in the reasons.
 */
function readUsage(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const value = parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

// Single source of truth for the overall-health verdict, shared by the desktop
// HealthStatusBar and the mobile dashboard masthead so their thresholds never
// drift apart.
export function deriveHealth(stats: Stats, systemStats: SystemStats | null, notifications: NotificationItem[]): HealthResult {
  const cpuReading = systemStats ? readUsage(systemStats.cpu.usage) : null;
  // Health follows the same balloon-adjusted percent the Memory tile shows so
  // the verdict never contradicts the gauge. Host RAM alerts (MonitorService)
  // deliberately keep the raw working-set usagePercent: unlike ARC, ballooned
  // pages are host-reclaimed and the guest cannot get them back on demand, so
  // a hypervisor squeezing a healthy-looking VM must still fire an alert.
  const ramReading = systemStats
    ? readUsage(systemStats.memory.effectiveUsagePercent ?? systemStats.memory.usagePercent)
    : null;
  const disk = parseFloat(systemStats?.disk?.usagePercent || '0');
  const unreadErrors = notifications.filter(n => !n.is_read && n.level === 'error').length;

  const cpu = cpuReading ?? 0;
  const ram = ramReading ?? 0;

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

  // Healthy, but an unknown reading is still a fact the operator needs: naming
  // it here keeps the verdict from claiming knowledge it does not have.
  // A missing sample (`systemStats === null`) is "not loaded yet", not a host
  // that cannot be measured, so it keeps the neutral verdict it always had.
  const unknown: string[] = [];
  if (systemStats !== null && cpuReading === null) unknown.push('CPU');
  if (systemStats !== null && ramReading === null) unknown.push('memory');
  if (unknown.length === 2) {
    reasons.push('CPU and memory usage unknown');
  } else if (unknown.length === 1) {
    reasons.push(`${unknown[0]} usage unknown`);
  } else {
    reasons.push('All systems nominal');
  }
  return { level: 'healthy', reasons };
}
