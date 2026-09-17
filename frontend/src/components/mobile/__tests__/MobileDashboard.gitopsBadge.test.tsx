/**
 * The phone dashboard joins the same GitOps state the desktop table does, from
 * the same hook, so a stack cannot read one way on a laptop and another way on
 * a phone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { GitOpsSourceStateMap } from '@/components/dashboard/useGitOpsSourceStates';
import type { StackHealthRow } from '@/components/dashboard/stackHealthTypes';

const sourceStates = vi.hoisted(() => ({ current: {} as GitOpsSourceStateMap }));

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
  useGitOpsSourceStates: () => sourceStates.current,
}));
vi.mock('@/components/dashboard', () => ({
  useDashboardData: () => ({
    stats: { active: 1, managed: 1, unmanaged: 0, exited: 0, total: 1 },
    systemStats: null,
    stackStatuses: { 'app.yml': { status: 'running', source: 'git' } },
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
    metrics: [],
    nodeCount: 1,
  }),
}));

vi.mock('@/components/dashboard/useStackHealthScope', async () => {
  const actual = await vi.importActual<typeof import('@/components/dashboard/useStackHealthScope')>(
    '@/components/dashboard/useStackHealthScope',
  );
  return {
    ...actual,
    useStackHealthScope: () => {
      const gitops = sourceStates.current;
      const row: StackHealthRow = {
        key: '1:app.yml',
        node: localNode,
        file: 'app.yml',
        name: 'app',
        status: 'running',
        memory: null,
        cpu: null,
        peakCpu: 0,
        series: [],
        peakIndex: -1,
        state: 'healthy',
        runningSince: null,
        source: 'git',
        mainPort: null,
        hasUpdate: false,
        outdatedServices: [],
        gitopsSourceState: gitops.app,
        freshness: 'current',
      };
      return {
        view: 'ready' as const,
        viewError: null,
        rows: [row],
        coverage: { k: 1, m: 1, n: 1 },
        incomplete: false,
        showScopeControl: false,
        retry: vi.fn(),
        retryFailedOrStale: vi.fn(),
      };
    },
  };
});

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

describe('MobileDashboard GitOps badge', () => {
  beforeEach(() => {
    sourceStates.current = {};
  });

  it('badges a stack the model has state for', () => {
    sourceStates.current = { app: 'candidate_ready' };
    renderDashboard();

    const badge = screen.getByTestId('gitops-badge');
    expect(badge).toHaveAttribute('data-state', 'candidate_ready');
    const visible = badge.querySelector(':scope > span:not(.sr-only)');
    expect(visible?.textContent).toBe('pending update');
  });

  it('renders no badge for a stack the model says nothing about', () => {
    renderDashboard();
    expect(screen.queryByTestId('gitops-badge')).toBeNull();
  });

  it('keeps the node name on the row alongside the badge', () => {
    sourceStates.current = { app: 'source_review_pending' };
    renderDashboard();

    expect(screen.getByText(/Local/)).toBeInTheDocument();
    expect(screen.getByTestId('gitops-badge')).toBeInTheDocument();
  });
});
