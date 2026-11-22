/**
 * The phone dashboard's network rate uses the shared byte formatter, so a host
 * rate under one byte per second still shows a number and a unit.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SystemStats } from '@/components/dashboard/types';

const dataState = vi.hoisted(() => ({
  systemStats: null as SystemStats | null,
}));

const localNode = {
  id: 1,
  name: 'Local',
  type: 'local' as const,
  api_url: '',
  compose_dir: '',
  is_default: true,
  status: 'online' as const,
  created_at: 0,
};

vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ activeNode: localNode, nodes: [localNode] }),
}));
vi.mock('@/components/NodeSwitcher', () => ({ NodeSwitcher: () => null }));
vi.mock('@/components/dashboard/useGitOpsSourceStates', () => ({
  useGitOpsSourceStates: () => ({}),
}));
vi.mock('@/components/dashboard', () => ({
  useDashboardData: () => ({
    stats: { active: 1, managed: 1, unmanaged: 0, exited: 0, total: 1 },
    systemStats: dataState.systemStats,
    stackStatuses: {},
    stackStatusesFreshness: 'current',
    stackCpuSeries: {},
    stackStatusesLoadStatus: 'success',
    stackStatusesLoadError: null,
    retryStackStatuses: vi.fn(),
    cpuHistory: [],
    netHistory: [],
    historyEndAt: null,
    lastSyncAt: null,
    metricsStale: false,
    metricsUnreadable: false,
    unreadableCause: null,
    metricsSettled: true,
    metrics: [],
    nodeCount: 1,
  }),
}));
vi.mock('@/components/dashboard/useStackHealthScope', () => ({
  STACK_HEALTH_COLLAPSE_SIZE: 5,
  useStackHealthScope: () => ({
    view: 'empty' as const,
    viewError: null,
    rows: [],
    coverage: { k: 0, m: 0, n: 0 },
    incomplete: false,
    showScopeControl: false,
    retry: vi.fn(),
    retryFailedOrStale: vi.fn(),
  }),
}));
vi.mock('@/components/dashboard/useStackHealthScopePreference', () => ({
  useStackHealthScopePreference: () => ['this-node', vi.fn()],
}));

import { MobileDashboard } from '../MobileDashboard';

function renderDashboard() {
  return render(
    <MobileDashboard
      notifications={[]}
      headerActions={null}
      onNavigateToStack={vi.fn()}
      onManageNodes={vi.fn()}
    />,
  );
}

describe('MobileDashboard network rate', () => {
  it('shows a real unit for a host rate under one byte per second', () => {
    dataState.systemStats = {
      cpu: { usage: '4.0', cores: 8 },
      memory: { total: 8 * 1024 ** 3, used: 2 * 1024 ** 3, free: 6 * 1024 ** 3, usagePercent: '25' },
      disk: { fs: '/', mount: '/', total: 100 * 1024 ** 3, used: 40 * 1024 ** 3, free: 60 * 1024 ** 3, usagePercent: '40' },
      network: { rxBytes: 10, txBytes: 10, rxSec: 0.5, txSec: 0.2 },
    };
    renderDashboard();
    expect(screen.getByText('0.7 B/s')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/undefined|NaN/);
  });
});
