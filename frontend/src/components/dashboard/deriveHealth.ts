import type { Stats, SystemStats, NotificationItem, HealthLevel } from './types';

export interface HealthResult {
  level: HealthLevel;
  reasons: string[];
}

// Single source of truth for the overall-health verdict, shared by the desktop
// HealthStatusBar and the mobile dashboard masthead so their thresholds never
// drift apart.
export function deriveHealth(stats: Stats, systemStats: SystemStats | null, notifications: NotificationItem[]): HealthResult {
  const cpu = parseFloat(systemStats?.cpu.usage || '0');
  // Health follows the same balloon-adjusted percent the Memory tile shows so
  // the verdict never contradicts the gauge. Host RAM alerts (MonitorService)
  // deliberately keep the raw working-set usagePercent: unlike ARC, ballooned
  // pages are host-reclaimed and the guest cannot get them back on demand, so
  // a hypervisor squeezing a healthy-looking VM must still fire an alert.
  const ram = parseFloat(systemStats?.memory.effectiveUsagePercent ?? systemStats?.memory.usagePercent ?? '0');
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
