export interface Stats {
  active: number;
  managed: number;
  unmanaged: number;
  exited: number;
  total: number;
}

export interface SystemStats {
  cpu: {
    usage: string;
    cores: number;
  };
  memory: {
    total: number;
    used: number;
    free: number;
    usagePercent: string;
  };
  disk: {
    fs: string;
    mount: string;
    total: number;
    used: number;
    free: number;
    usagePercent: string;
  } | null;
  network?: {
    rxBytes: number;
    txBytes: number;
    rxSec: number;
    txSec: number;
  };
}

export interface MetricPoint {
  container_id: string;
  stack_name: string;
  timestamp: number;
  cpu_percent: number;
  memory_mb: number;
  net_rx_mb: number;
  net_tx_mb: number;
}

export type NotificationCategory =
    | 'deploy_success'
    | 'deploy_failure'
    | 'stack_started'
    | 'stack_stopped'
    | 'stack_restarted'
    | 'image_update_available'
    | 'image_update_applied'
    | 'autoheal_triggered'
    | 'monitor_alert'
    | 'scan_finding'
    | 'drift_detected'
    | 'drift_resolved'
    | 'update_started'
    | 'health_gate_passed'
    | 'health_gate_failed'
    | 'node_update_available'
    | 'system';

export interface NotificationItem {
  id: number;
  level: 'info' | 'warning' | 'error';
  category?: NotificationCategory | string;
  message: string;
  timestamp: number;
  is_read: number;
  nodeId?: number;
  nodeName?: string;
  stack_name?: string;
  container_name?: string;
  actor_username?: string | null;
}

export interface StackStatusEntry {
  status: 'running' | 'exited' | 'unknown' | 'partial';
  mainPort?: number;
  /** Unix seconds of the oldest running container (approximates stack uptime). */
  runningSince?: number;
  /** Provenance of the stack: 'git' when linked to a Git source, else 'local'. */
  source?: 'local' | 'git';
}

export type HealthLevel = 'healthy' | 'degraded' | 'critical';

export interface StackCpuSeries {
  stackName: string;
  points: number[];
  peakValue: number;
  peakIndex: number;
  latestValue: number;
}

export interface DashboardData {
  stats: Stats;
  systemStats: SystemStats | null;
  metrics: MetricPoint[];
  stackStatuses: Record<string, StackStatusEntry>;
  lastSyncAt: number | null;
  nodeCount: number;
  stackCpuSeries: Record<string, StackCpuSeries>;
  cpuHistory: number[];
  netHistory: number[];
  /** Anchor timestamp (ms) for the sparkline 10-minute window: the newest metric sample. */
  historyEndAt: number | null;
  /** True after several consecutive `/stats` or `/system/stats` polls have failed; surfaces a "metrics paused" indicator. */
  metricsStale: boolean;
}
