import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NotificationItem } from '../types';
import type { Node } from '@/context/NodeContext';
import { resolveAlertDestination } from '@/lib/alertDestination';
import { RECENT_ALERTS_PREVIEW_SIZE, RecentAlerts, type AlertNavigation } from '../RecentAlerts';
import { RECENT_ALERTS_SCOPE_KEY } from '../useRecentAlertsScopePreference';

function notif(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 1,
    level: 'warning',
    message: 'test alert',
    timestamp: 1_000,
    is_read: 0,
    nodeId: 1,
    ...overrides,
  };
}

function node(id: number, type: 'local' | 'remote' = 'local'): Node {
  return { id, name: `node-${id}`, type } as unknown as Node;
}

const SINGLE = [node(1)];
const FLEET = [node(1), node(2, 'remote'), node(3, 'remote')];

/** Resolves destinations the way the shell does, minus the permission layer. */
function makeNavigation(nodes: Node[]): AlertNavigation {
  const known = new Set(nodes.map(n => n.id));
  return {
    destinationFor: n => resolveAlertDestination(n, known),
    open: vi.fn(),
    viewAll: vi.fn(),
  };
}

function renderAlerts(props: {
  notifications: NotificationItem[];
  nodes?: Node[];
  activeNodeId?: number | null;
  unreportedNodeIds?: ReadonlySet<number>;
  navigation?: AlertNavigation;
  reserveHeight?: boolean;
  onMarkRead?: (n: NotificationItem) => void;
  canMute?: boolean;
}) {
  const nodes = props.nodes ?? SINGLE;
  const navigation = props.navigation ?? makeNavigation(nodes);
  const view = render(
    <RecentAlerts
      notifications={props.notifications}
      nodes={nodes}
      activeNodeId={props.activeNodeId === undefined ? 1 : props.activeNodeId}
      unreportedNodeIds={props.unreportedNodeIds ?? new Set()}
      navigation={navigation}
      onMarkRead={props.onMarkRead ?? vi.fn()}
      canMute={props.canMute ?? false}
      reserveHeight={props.reserveHeight}
    />,
  );
  return { ...view, navigation };
}

const rows = () => screen.queryAllByTestId('recent-alert-row');

beforeEach(() => {
  window.localStorage.clear();
});

describe('RecentAlerts severity contract', () => {
  it('shows the all-clear when nothing is actionable', () => {
    renderAlerts({ notifications: [notif({ level: 'info', category: 'image_update_applied', actor_username: 'system:scheduler' })] });

    expect(screen.getByText('No recent alerts.')).toBeInTheDocument();
    expect(rows()).toHaveLength(0);
  });

  it('renders warnings and errors alongside an allowlisted info row, but not routine info', () => {
    renderAlerts({
      notifications: [
        notif({ id: 1, level: 'warning', message: 'disk high' }),
        notif({ id: 2, level: 'error', message: 'crashed' }),
        notif({ id: 3, level: 'info', category: 'image_update_available', message: 'update ready' }),
        notif({ id: 4, level: 'info', category: 'deploy_success', message: 'deployed', actor_username: 'system:scheduler' }),
      ],
    });

    expect(rows()).toHaveLength(3);
    expect(screen.queryByText('deployed')).not.toBeInTheDocument();
  });

  it('names the severity in text, not only by icon color', () => {
    renderAlerts({ notifications: [notif({ level: 'error', message: 'crashed' })] });

    expect(within(rows()[0]).getByText('Error')).toHaveClass('sr-only');
  });
});

describe('RecentAlerts node scope', () => {
  it('offers no scope control without a remote node', () => {
    renderAlerts({ notifications: [] });
    expect(screen.queryByRole('radiogroup', { name: 'Recent alerts node scope' })).not.toBeInTheDocument();
  });

  it('defaults to This node and shows only the active node rows', () => {
    renderAlerts({
      nodes: FLEET,
      activeNodeId: 2,
      notifications: [
        notif({ id: 1, nodeId: 1, message: 'on local' }),
        notif({ id: 2, nodeId: 2, message: 'on node two' }),
      ],
    });

    expect(screen.getByRole('radio', { name: 'This node' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('on node two')).toBeInTheDocument();
    expect(screen.queryByText('on local')).not.toBeInTheDocument();
    expect(screen.getByText('1 alert · node-2')).toBeInTheDocument();
  });

  it('follows the active node rather than the node active when the scope was picked', () => {
    const notifications = [
      notif({ id: 1, nodeId: 1, message: 'on local' }),
      notif({ id: 2, nodeId: 2, message: 'on node two' }),
    ];
    const { rerender, navigation } = renderAlerts({ nodes: FLEET, activeNodeId: 1, notifications });
    expect(screen.getByText('on local')).toBeInTheDocument();

    rerender(
      <RecentAlerts
        notifications={notifications}
        nodes={FLEET}
        activeNodeId={2}
        unreportedNodeIds={new Set()}
        navigation={navigation}
        onMarkRead={vi.fn()}
        canMute={false}
      />,
    );
    expect(screen.getByText('on node two')).toBeInTheDocument();
    expect(screen.queryByText('on local')).not.toBeInTheDocument();
  });

  it('shows every node, with a node column, under All nodes', () => {
    renderAlerts({
      nodes: FLEET,
      activeNodeId: 1,
      notifications: [notif({ id: 1, nodeId: 1, nodeName: 'node-1' }), notif({ id: 2, nodeId: 2, nodeName: 'node-2' })],
    });

    fireEvent.click(screen.getByRole('radio', { name: 'All nodes' }));

    expect(rows()).toHaveLength(2);
    expect(screen.getByRole('columnheader', { name: 'Node' })).toBeInTheDocument();
    expect(window.localStorage.getItem(RECENT_ALERTS_SCOPE_KEY)).toBe('all-nodes');
    expect(screen.getByText('2 alerts · 3 nodes')).toBeInTheDocument();
  });

  it('ignores a stored All nodes preference when there is no remote node', () => {
    window.localStorage.setItem(RECENT_ALERTS_SCOPE_KEY, 'all-nodes');
    renderAlerts({ notifications: [notif({ id: 1, nodeId: 1 })] });

    expect(screen.queryByRole('columnheader', { name: 'Node' })).not.toBeInTheDocument();
  });
});

describe('RecentAlerts feed gaps', () => {
  it('does not read a silent active node as an all-clear', () => {
    renderAlerts({ nodes: FLEET, activeNodeId: 2, unreportedNodeIds: new Set([2]), notifications: [] });

    expect(screen.queryByText('No recent alerts.')).not.toBeInTheDocument();
    expect(screen.getByText(/No current feed from node-2\./)).toBeInTheDocument();
  });

  it('keeps retained rows visible and says which nodes are not reporting under All nodes', () => {
    window.localStorage.setItem(RECENT_ALERTS_SCOPE_KEY, 'all-nodes');
    renderAlerts({
      nodes: FLEET,
      activeNodeId: 1,
      unreportedNodeIds: new Set([3]),
      notifications: [notif({ id: 1, nodeId: 3, message: 'retained from node three' })],
    });

    expect(screen.getByText('retained from node three')).toBeInTheDocument();
    expect(screen.getByText(/No current feed from node-3\. Showing what was last received\./)).toBeInTheDocument();
    expect(screen.getByText('1 alert · 2/3 nodes reporting')).toBeInTheDocument();
  });

  it('ignores a gap on a node outside the This node scope', () => {
    renderAlerts({ nodes: FLEET, activeNodeId: 1, unreportedNodeIds: new Set([3]), notifications: [] });

    expect(screen.getByText('No recent alerts.')).toBeInTheDocument();
  });
});

describe('RecentAlerts preview', () => {
  it('caps the preview, keeps the newest rows, and says how many are hidden', () => {
    const notifications = Array.from({ length: RECENT_ALERTS_PREVIEW_SIZE + 3 }, (_, i) =>
      notif({ id: i + 1, timestamp: 1_000 + i, message: `alert ${i + 1}` }));
    renderAlerts({ notifications });

    expect(rows()).toHaveLength(RECENT_ALERTS_PREVIEW_SIZE);
    expect(screen.getByText(`alert ${RECENT_ALERTS_PREVIEW_SIZE + 3}`)).toBeInTheDocument();
    expect(screen.queryByText('alert 1')).not.toBeInTheDocument();
    expect(screen.getByText(`Latest ${RECENT_ALERTS_PREVIEW_SIZE} of ${RECENT_ALERTS_PREVIEW_SIZE + 3}`)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /page/i })).not.toBeInTheDocument();
  });

  it('renders two rows that share a notification id on different nodes', () => {
    window.localStorage.setItem(RECENT_ALERTS_SCOPE_KEY, 'all-nodes');
    renderAlerts({
      nodes: FLEET,
      notifications: [notif({ id: 7, nodeId: 1, message: 'local seven' }), notif({ id: 7, nodeId: 2, message: 'remote seven' })],
    });

    expect(screen.getByText('local seven')).toBeInTheDocument();
    expect(screen.getByText('remote seven')).toBeInTheDocument();
  });

  it('has no clear-all action and opens the full feed from the footer', () => {
    const { navigation } = renderAlerts({ notifications: [notif()] });

    expect(screen.queryByRole('button', { name: /clear/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /View all alerts/ }));
    expect(navigation.viewAll).toHaveBeenCalledTimes(1);
  });
});

describe('RecentAlerts row actions', () => {
  it('opens the resolved destination from a pointer click anywhere on the row and from the keyboard', async () => {
    const user = userEvent.setup();
    const { navigation } = renderAlerts({ notifications: [notif({ stack_name: 'web', message: 'web crashed' })] });
    const row = rows()[0];

    // The row stays a table row; its primary cell carries the button.
    expect(row).not.toHaveAttribute('role');
    fireEvent.click(within(row).getAllByRole('cell')[2]);
    within(row).getByRole('button', { name: /web crashed/ }).focus();
    await user.keyboard('{Enter}');
    expect(navigation.open).toHaveBeenCalledTimes(2);
    expect(navigation.open).toHaveBeenCalledWith(expect.objectContaining({ kind: 'stack', nodeId: 1, stackName: 'web' }));
  });

  it('leaves a row without a destination inert and unfocusable', () => {
    // Read, so there is no Mark read button; with no destination there is no navigation button either.
    const { navigation } = renderAlerts({ notifications: [notif({ category: 'monitor_alert', message: 'CPU high', is_read: 1 })] });
    const row = rows()[0];

    expect(within(row).queryByRole('button')).toBeNull();
    fireEvent.click(row);
    expect(navigation.open).not.toHaveBeenCalled();
  });

  it('leaves a row inert when the shell withholds its destination', () => {
    const navigation: AlertNavigation = { destinationFor: () => null, open: vi.fn(), viewAll: vi.fn() };
    renderAlerts({ navigation, notifications: [notif({ stack_name: 'web', is_read: 1 })] });

    expect(within(rows()[0]).queryByRole('button')).toBeNull();
  });
});

describe('RecentAlerts before the first fetch', () => {
  it('shows a loading state, not the all-clear, until the feed has reported', () => {
    render(
      <RecentAlerts notifications={[]} nodes={SINGLE} activeNodeId={1} unreportedNodeIds={null} navigation={makeNavigation(SINGLE)} onMarkRead={vi.fn()} canMute={false} />,
    );
    expect(screen.queryByText('No recent alerts.')).not.toBeInTheDocument();
  });
});

describe('RecentAlerts row identity', () => {
  it('keys rows by node and id, so equal ids on two nodes never collide', () => {
    window.localStorage.setItem(RECENT_ALERTS_SCOPE_KEY, 'all-nodes');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { navigation } = renderAlerts({
      nodes: FLEET,
      notifications: [notif({ id: 7, nodeId: 1, stack_name: 'a' }), notif({ id: 7, nodeId: 2, stack_name: 'b' })],
    });

    expect(errors.mock.calls.some(call => String(call[0]).includes('same key'))).toBe(false);
    errors.mockRestore();
    fireEvent.click(rows()[1]);
    expect(navigation.open).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 2, stackName: 'b' }));
  });
});

describe('RecentAlerts fixed height', () => {
  const body = () => screen.getByText('Recent alerts').closest('section')!.querySelector('div.overflow-hidden')!;

  it('keeps the full-preview body height whether it holds eight rows, one row, or none when reserving height', () => {
    const full = Array.from({ length: RECENT_ALERTS_PREVIEW_SIZE }, (_, i) => notif({ id: i + 1, timestamp: i }));
    const { unmount } = renderAlerts({ notifications: full, reserveHeight: true });
    const fullClass = body().className;
    unmount();

    const one = renderAlerts({ notifications: [notif()], reserveHeight: true });
    expect(body().className).toBe(fullClass);
    one.unmount();

    renderAlerts({ notifications: [], reserveHeight: true });
    expect(screen.getByText('No recent alerts.')).toBeInTheDocument();
    expect(body().className).toBe(fullClass);
  });

  it('collapses the empty state to its natural height when not reserving height', () => {
    const one = renderAlerts({ notifications: [notif()] });
    const rowsClass = body().className;
    one.unmount();

    renderAlerts({ notifications: [] });
    expect(body().className).not.toBe(rowsClass);
  });

  it('puts the silent-node notice in the footer so it never changes the card height', () => {
    window.localStorage.setItem(RECENT_ALERTS_SCOPE_KEY, 'all-nodes');
    renderAlerts({ nodes: FLEET, unreportedNodeIds: new Set([3]), notifications: [notif({ nodeId: 1 })] });

    const notice = screen.getByText(/No current feed from node-3\./);
    expect(body().contains(notice)).toBe(false);
  });
});


vi.mock('@/lib/muteRules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/muteRules')>()),
  createMuteFromNotification: vi.fn().mockResolvedValue(true),
}));

describe('RecentAlerts read and mute', () => {
  it('marks an unread row read without navigating', async () => {
    const user = userEvent.setup();
    const onMarkRead = vi.fn();
    const target = notif({ id: 5, message: 'disk is full', stack_name: 'web' });
    const { navigation } = renderAlerts({ notifications: [target], onMarkRead });

    await user.click(screen.getByRole('button', { name: 'Mark read' }));

    expect(onMarkRead).toHaveBeenCalledTimes(1);
    expect(onMarkRead).toHaveBeenCalledWith(expect.objectContaining({ id: 5, nodeId: 1 }));
    expect(navigation.open).not.toHaveBeenCalled();
  });

  it('offers no Mark read on a row that is already read', () => {
    renderAlerts({ notifications: [notif({ is_read: 1, stack_name: 'web' })] });
    expect(screen.queryByRole('button', { name: 'Mark read' })).not.toBeInTheDocument();
  });

  it('hands the row to its own node when two nodes share an id', async () => {
    window.localStorage.setItem(RECENT_ALERTS_SCOPE_KEY, 'all-nodes');
    const user = userEvent.setup();
    const onMarkRead = vi.fn();
    renderAlerts({
      nodes: FLEET,
      activeNodeId: 1,
      onMarkRead,
      notifications: [
        notif({ id: 7, nodeId: 1, message: 'on local', timestamp: 2_000 }),
        notif({ id: 7, nodeId: 2, message: 'on node two', timestamp: 1_000 }),
      ],
    });

    const row = screen.getByText('on node two').closest('[data-testid="recent-alert-row"]') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Mark read' }));

    expect(onMarkRead).toHaveBeenCalledWith(expect.objectContaining({ id: 7, nodeId: 2 }));
  });

  it('shows Mute only when the account can create mute rules', () => {
    const rows = [notif({ stack_name: 'web' })];
    const first = renderAlerts({ notifications: rows, canMute: false });
    expect(screen.queryByRole('button', { name: 'Mute options' })).not.toBeInTheDocument();
    first.unmount();

    renderAlerts({ notifications: rows, canMute: true });
    expect(screen.getByRole('button', { name: 'Mute options' })).toBeInTheDocument();
  });

  it('mutes from the menu without navigating', async () => {
    const { createMuteFromNotification } = await import('@/lib/muteRules');
    const user = userEvent.setup();
    const target = notif({ id: 9, stack_name: 'web', category: 'monitor_alert' });
    const { navigation } = renderAlerts({ notifications: [target], canMute: true });

    await user.click(screen.getByRole('button', { name: 'Mute options' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Mute this stack' }));

    expect(createMuteFromNotification).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }), 'stack');
    expect(navigation.open).not.toHaveBeenCalled();
  });

  it('still navigates when the row itself is clicked', async () => {
    const user = userEvent.setup();
    const { navigation } = renderAlerts({ notifications: [notif({ stack_name: 'web' })] });

    await user.click(screen.getByText('test alert'));

    expect(navigation.open).toHaveBeenCalledTimes(1);
  });
});
