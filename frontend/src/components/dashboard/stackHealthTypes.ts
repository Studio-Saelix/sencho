import type { Node } from '@/context/NodeContext';
import type { GitOpsSourceStatus } from '@/types/gitops';
import type { RowState } from './classifyRow';
import type { StackStatusEntry } from './types';

export type StackHealthScopeMode = 'this-node' | 'all-nodes';

export type StackHealthNavTarget = { node: Node; file: string };

export type NodeHealthState = 'pending' | 'current' | 'stale' | 'failed' | 'offline';

/** Why a node's stack health could not be read. `unreadable` covers every cause
 *  where the hub had no readable path to the node (a disconnected Pilot, an
 *  unconfigured target, a refused address) besides the named deadline. */
export type NodeHealthFailureReason = 'timeout' | 'unreadable' | 'denied' | 'error' | 'malformed';

export type StackHealthFreshness = 'current' | 'stale';

export interface StackHealthRow {
  key: string;
  node: Node;
  file: string;
  name: string;
  status: StackStatusEntry['status'];
  networks?: string[];
  memory: number | null;
  cpu: number | null;
  peakCpu: number;
  series: number[];
  peakIndex: number;
  state: RowState;
  runningSince: number | null;
  source: 'local' | 'git';
  mainPort: number | null;
  hasUpdate: boolean;
  outdatedServices: string[];
  gitopsSourceState?: GitOpsSourceStatus;
  freshness: StackHealthFreshness;
}

export type StackHealthViewKind = 'loading' | 'unavailable' | 'empty' | 'ready';

export interface StackHealthCoverage {
  k: number;
  m: number;
  n: number;
}
