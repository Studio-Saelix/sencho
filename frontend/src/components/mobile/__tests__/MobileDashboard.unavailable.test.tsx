/**
 * The phone dashboard must not present a derived health level for a node that
 * did not answer. It mirrors the desktop HealthStatusBar: "Unknown" when the
 * metrics stopped at an unreadable node, the derived level plus the stale chip
 * when the meters are merely stale for a local reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const dataState = vi.hoisted(() => ({
  metricsStale: false,
  metricsUnreadable: false,
  metricsSettled: true,
  unreadableCause: null as string | null,
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
    systemStats: null,
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
    metricsStale: dataState.metricsStale,
    metricsUnreadable: dataState.metricsUnreadable,
    unreadableCause: dataState.unreadableCause,
    metricsSettled: dataState.metricsSettled,
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

describe('MobileDashboard unavailable state', () => {
  beforeEach(() => {
    dataState.metricsStale = false;
    dataState.metricsUnreadable = false;
    dataState.metricsSettled = true;
    dataState.unreadableCause = null;
  });

  it('reads Unknown when the node did not answer, not a derived health level', () => {
    dataState.metricsStale = true;
    dataState.metricsUnreadable = true;
    renderDashboard();

    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.queryByText('Healthy')).toBeNull();
    // The phone headline must carry the same sentence as the desktop bar for a
    // silent node.
    expect(screen.getByText('This node is not answering.')).toBeInTheDocument();
  });

  it('names a disconnected Pilot on the phone instead of the silent-node sentence', () => {
    dataState.metricsStale = true;
    dataState.metricsUnreadable = true;
    dataState.unreadableCause = 'pilot-disconnected';
    renderDashboard();

    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(
      screen.getByText('The Pilot tunnel to "Local" is disconnected. It resumes when the agent reconnects.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('This node is not answering.')).toBeNull();
  });

  it('does not claim a health level before the first metrics read settles', () => {
    dataState.metricsSettled = false;
    renderDashboard();

    expect(screen.getByText('Checking')).toBeInTheDocument();
    expect(screen.getByText(/reading this node/)).toBeInTheDocument();
    expect(screen.queryByText('Healthy')).toBeNull();
  });

  it('keeps the derived level and the stale chip for stale meters with a local cause', () => {
    dataState.metricsStale = true;
    renderDashboard();

    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).toBeNull();
    expect(screen.queryByText('This node is not answering.')).toBeNull();
    expect(screen.getByText('metrics stale')).toBeInTheDocument();
  });
});
