export type StackRowStatus = 'running' | 'exited' | 'unknown' | 'partial';

export function statusText(status: StackRowStatus): string {
  if (status === 'running') return 'UP';
  if (status === 'exited') return 'DN';
  if (status === 'partial') return 'PT';
  return '--';
}

export function statusColor(status: StackRowStatus, isBusy: boolean): string {
  if (isBusy) return 'text-muted-foreground';
  if (status === 'running') return 'text-success';
  if (status === 'exited') return 'text-destructive';
  if (status === 'partial') return 'text-warning';
  return 'text-stat-icon';
}

/** Stacks the Down filter surfaces: fully stopped, or partially crashed. */
export function isDownStatus(status: StackRowStatus | undefined): boolean {
  return status === 'exited' || status === 'partial';
}
