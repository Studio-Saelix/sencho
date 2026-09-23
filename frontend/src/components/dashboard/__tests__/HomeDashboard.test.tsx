import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import * as NodeContext from '@/context/NodeContext';
import * as AuthContext from '@/context/AuthContext';
import type { NotificationItem } from '../types';
import HomeDashboard, { type HomeNavigation } from '../../HomeDashboard';

vi.mock('@/context/NodeContext');
vi.mock('@/context/AuthContext');

vi.mock('../useStackHealthScope', () => ({
  useStackHealthScope: () => ({
    showScopeControl: false,
    view: 'this-node',
    viewError: null,
    rows: [],
    coverage: null,
    incomplete: false,
    retry: vi.fn(),
    retryFailedOrStale: vi.fn(),
  }),
}));

vi.mock('../useGitOpsSourceStates', () => ({
  useGitOpsSourceStates: () => ({}),
}));

// The dashboard's composition is what is under test, so each card stands in as
// a labelled placeholder. RecentAlerts echoes what it was handed and the
// heartbeat forwards a click, so the prop threading stays covered.
vi.mock('../index', () => ({
  HealthStatusBar: () => <div data-testid="health-status-bar" />,
  ResourceGauges: () => <div data-testid="resource-gauges" />,
  StackHealthTable: () => <div data-testid="stack-health-table" />,
  ConfigurationSummary: () => <div data-testid="configuration-summary" />,
  FleetHeartbeat: ({ onOpenNode, className }: { onOpenNode: (nodeId: number) => void; className?: string }) => (
    <div data-testid="fleet-heartbeat" className={className}>
      <button type="button" onClick={() => onOpenNode(9)}>open-fleet-node</button>
    </div>
  ),
  RecentAlerts: ({ notifications, nodes, activeNodeId, unreportedNodeIds, className }: {
    notifications: unknown[];
    nodes: unknown[];
    activeNodeId: number | null;
    unreportedNodeIds: ReadonlySet<number> | null;
    className?: string;
  }) => (
    <div
      data-testid="recent-alerts"
      className={className}
      data-active-node={String(activeNodeId)}
      data-notification-count={String(notifications.length)}
      data-node-count={String(nodes.length)}
      data-unreported={[...(unreportedNodeIds ?? [])].join(',')}
    />
  ),
  useDashboardData: () => ({}),
}));

function setup(opts: { remote: boolean; nodeRead: boolean; activeNodeId?: number }) {
  const nodes = opts.remote
    ? [{ id: 1, name: 'local', type: 'local' }, { id: 2, name: 'edge', type: 'remote' }]
    : [{ id: 1, name: 'local', type: 'local' }];
  vi.mocked(NodeContext.useNodes).mockReturnValue({
    nodes,
    activeNode: { id: opts.activeNodeId ?? 1, name: 'local', type: 'local' },
  } as unknown as ReturnType<typeof NodeContext.useNodes>);
  vi.mocked(AuthContext.useAuth).mockReturnValue({
    can: (p: string) => opts.nodeRead && p === 'node:read',
  } as unknown as ReturnType<typeof AuthContext.useAuth>);
}

function makeNavigation(overrides: Partial<HomeNavigation> = {}): HomeNavigation {
  return {
    toStack: vi.fn(),
    toFleetNode: vi.fn(),
    alerts: { destinationFor: () => null, open: vi.fn(), viewAll: vi.fn() },
    config: { open: vi.fn(), canOpen: () => true },
    ...overrides,
  };
}

function renderDashboard(extra: {
  navigation?: HomeNavigation;
  notifications?: NotificationItem[];
  unreportedNodeIds?: ReadonlySet<number>;
} = {}) {
  return render(
    <HomeDashboard
      notifications={extra.notifications ?? []}
      unreportedNodeIds={extra.unreportedNodeIds ?? new Set()}
      navigation={extra.navigation ?? makeNavigation()}
    />,
  );
}

function testIdOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-testid]'))
    .map(el => el.getAttribute('data-testid')!);
}

beforeEach(() => vi.clearAllMocks());

describe('HomeDashboard card order', () => {
  it('reads problem, then impact, then change, then configuration', () => {
    setup({ remote: true, nodeRead: true });
    const { container } = renderDashboard();

    // Pinned as a whole rather than as adjacent pairs: the one-column fallback
    // below xl follows source order, so alerts must lead the operational row,
    // connectivity follows, and the summary stays last.
    expect(testIdOrder(container)).toEqual([
      'health-status-bar',
      'resource-gauges',
      'stack-health-table',
      'recent-alerts',
      'fleet-heartbeat',
      'configuration-summary',
    ]);
  });
});

describe('HomeDashboard operational row', () => {
  it('pairs the alerts with the heartbeat, which takes its height from the alerts card', () => {
    setup({ remote: true, nodeRead: true });
    renderDashboard();

    expect(screen.getByTestId('recent-alerts')).toHaveClass('xl:col-span-3');
    // Out of flow inside its cell, so Recent alerts alone sets the row height.
    expect(screen.getByTestId('fleet-heartbeat')).toHaveClass('xl:absolute', 'xl:inset-0');
    expect(screen.getByTestId('fleet-heartbeat').parentElement).toHaveClass('xl:relative', 'xl:col-span-2');
  });

  it('gives the alerts the full width without node:read', () => {
    setup({ remote: true, nodeRead: false });
    renderDashboard();

    expect(screen.queryByTestId('fleet-heartbeat')).not.toBeInTheDocument();
    expect(screen.getByTestId('recent-alerts')).not.toHaveClass('xl:col-span-3');
  });

  it('gives the alerts the full width on a single-node setup', () => {
    setup({ remote: false, nodeRead: true });
    renderDashboard();

    expect(screen.queryByTestId('fleet-heartbeat')).not.toBeInTheDocument();
    expect(screen.getByTestId('recent-alerts')).not.toHaveClass('xl:col-span-3');
  });

  it('forwards a heartbeat row click to the fleet deep link', () => {
    setup({ remote: true, nodeRead: true });
    const navigation = makeNavigation();
    renderDashboard({ navigation });

    fireEvent.click(screen.getByRole('button', { name: 'open-fleet-node' }));
    expect(navigation.toFleetNode).toHaveBeenCalledWith(9);
  });
});

describe('HomeDashboard alert scope', () => {
  it('hands the alerts preview the active node, the feed, and the roster', () => {
    setup({ remote: true, nodeRead: true, activeNodeId: 2 });
    renderDashboard({ notifications: [{ id: 1 } as NotificationItem], unreportedNodeIds: new Set([2]) });

    const card = screen.getByTestId('recent-alerts');
    expect(card.getAttribute('data-active-node')).toBe('2');
    expect(card.getAttribute('data-notification-count')).toBe('1');
    // The card resolves a row's node against the roster to decide whether the
    // row leads anywhere, so the full node list has to arrive, not just the id.
    expect(card.getAttribute('data-node-count')).toBe('2');
    // Feed gaps reach the card so a silent node never reads as an all-clear.
    expect(card.getAttribute('data-unreported')).toBe('2');
  });
});
