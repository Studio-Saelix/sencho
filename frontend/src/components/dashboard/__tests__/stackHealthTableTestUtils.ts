import { vi } from 'vitest';
import type { Node } from '@/context/NodeContext';
import type { StackUpdateInfo } from '@/types/imageUpdates';
import { projectStackHealthRows } from '../projectStackHealthRows';
import type { GitOpsSourceStateMap } from '../useGitOpsSourceStates';
import type { StackHealthRow, StackHealthScopeMode, StackHealthViewKind } from '../stackHealthTypes';
import type { StackStatusEntry } from '../types';
import type { ComponentProps } from 'react';
import { StackHealthTable } from '../StackHealthTable';

export const LOCAL_NODE: Node = {
  id: 1,
  name: 'Local',
  type: 'local',
  api_url: '',
  compose_dir: '',
  is_default: true,
  status: 'online',
  created_at: 0,
};

export function rowsFromStatuses(
  statuses: Record<string, StackStatusEntry>,
  gitops: GitOpsSourceStateMap = {},
  stackUpdates: Record<string, StackUpdateInfo> = {},
  node: Node = LOCAL_NODE,
): StackHealthRow[] {
  return projectStackHealthRows({
    node,
    statuses,
    metrics: [],
    series: {},
    gitops,
    stackUpdates,
    freshness: 'current',
    includeUpdates: true,
  });
}

export function tableProps(
  overrides: Partial<ComponentProps<typeof StackHealthTable>> = {},
): ComponentProps<typeof StackHealthTable> {
  return {
    scope: 'this-node' as StackHealthScopeMode,
    onScopeChange: vi.fn(),
    showScopeControl: false,
    view: 'ready' as StackHealthViewKind,
    viewError: null,
    rows: [],
    coverage: { k: 1, m: 1, n: 0 },
    incomplete: false,
    onRetry: vi.fn(),
    onNavigateToStack: vi.fn(),
    ...overrides,
  };
}
