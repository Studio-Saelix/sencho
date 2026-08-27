/**
 * The phone dashboard joins the same GitOps state the desktop table does, from
 * the same hook, so a stack cannot read one way on a laptop and another way on
 * a phone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { GitOpsSourceStateMap } from '@/components/dashboard/useGitOpsSourceStates';
import type { StackStatusEntry } from '@/components/dashboard/types';

const sourceStates = vi.hoisted(() => ({ current: {} as GitOpsSourceStateMap }));
const stackStatuses = vi.hoisted(() => ({
  current: { 'app.yml': { status: 'running', source: 'git' } } as Record<string, StackStatusEntry>,
}));

vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ activeNode: { id: 1, name: 'Local' } }),
}));
vi.mock('@/components/NodeSwitcher', () => ({ NodeSwitcher: () => null }));
vi.mock('@/components/dashboard/useGitOpsSourceStates', () => ({
  useGitOpsSourceStates: () => sourceStates.current,
}));
vi.mock('@/components/dashboard', () => ({
  useDashboardData: () => ({
    stats: { active: 1, managed: 1, unmanaged: 0, exited: 0, total: 1 },
    systemStats: null,
    stackStatuses: stackStatuses.current,
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

import { MobileDashboard } from '../MobileDashboard';

function renderDashboard() {
  return render(
    <MobileDashboard
      notifications={[]}
      headerActions={null}
      onNavigateToStack={vi.fn()}
      onViewAllStacks={vi.fn()}
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
    // Touch has no hover, so the word has to be on screen rather than only in
    // the title. `toHaveTextContent` also matches sr-only text, so it would
    // stay green if the badge were rendered compact, which is the thing this
    // is here to rule out: assert against the visible node instead.
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

    expect(screen.getByText('Local')).toBeInTheDocument();
    expect(screen.getByTestId('gitops-badge')).toBeInTheDocument();
  });
});
