import type { StackStatusEntry } from './types';

export type RowState = 'healthy' | 'warn' | 'error';

const WARN = 80;
const CRIT = 90;

export function classifyRow(status: StackStatusEntry['status'], peakCpu: number): RowState {
  if (status === 'exited') return 'error';
  if (peakCpu >= CRIT) return 'error';
  // A partially-crashed stack is degraded, not down: surface it as a warning
  // (the same amber as the sidebar PT pill) unless CPU is already critical.
  if (status === 'partial' || peakCpu >= WARN) return 'warn';
  return 'healthy';
}
