export interface ScheduledTask {
  id: number;
  name: string;
  target_type: 'stack' | 'fleet' | 'system';
  target_id: string | null;
  node_id: number | null;
  action: 'restart' | 'snapshot' | 'prune' | 'update' | 'scan' | 'auto_backup' | 'auto_stop' | 'auto_down' | 'auto_start';
  cron_expression: string;
  enabled: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  next_run_at: number | null;
  last_status: 'success' | 'failure' | null;
  last_error: string | null;
  prune_targets: string | null;
  target_services: string | null;
  prune_label_filter: string | null;
  delete_after_run?: number;
  next_runs?: number[];
}

export interface TaskRun {
  id: number;
  task_id: number;
  started_at: number;
  completed_at: number | null;
  status: 'running' | 'success' | 'failure';
  output: string | null;
  error: string | null;
  triggered_by: 'scheduler' | 'manual';
}

export interface NodeOption {
  id: number;
  name: string;
  type: 'local' | 'remote';
}
