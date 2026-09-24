import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Node } from '@/context/NodeContext';
import type { NotificationItem } from '@/components/dashboard/types';
import type { ReachabilityContext } from '@/lib/routing/reachability';

const toastError = vi.fn();
vi.mock('@/components/ui/toast-store', () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }));

import { useHomeNavigation, PENDING_NODE_INTENT_TTL_MS } from '../useHomeNavigation';

const HUB = { id: 1, name: 'hub', type: 'local' } as Node;
const EDGE = { id: 2, name: 'edge', type: 'remote' } as Node;
const NODES = [HUB, EDGE];

function reach(overrides: Partial<ReachabilityContext> = {}): ReachabilityContext {
  return {
    isAdmin: true,
    isPaid: true,
    can: () => true,
    isRemote: false,
    hasFleetCapability: true,
    containerLabelsEnabled: true,
    permissionsStatus: 'ready',
    licenseStatus: 'ready',
    experimental: false,
    experimentalReady: true,
    scheduledOpsAccessible: true,
    ...overrides,
  };
}

function setup(opts: { active?: Node; reachCtx?: ReachabilityContext; can?: () => boolean; isMobile?: boolean } = {}) {
  const active = opts.active ?? HUB;
  const deps = {
    nodes: NODES,
    activeNode: active,
    setActiveNode: vi.fn(),
    reachCtx: opts.reachCtx ?? reach({ isRemote: active.type === 'remote' }),
    can: opts.can ?? (() => true),
    isMobile: opts.isMobile ?? false,
    navigateMobileAware: vi.fn(),
    handleNavigate: vi.fn(),
    setActiveView: vi.fn(),
    setSecurityTab: vi.fn(),
    openSettings: vi.fn(),
    toStack: vi.fn(),
    openStackOnNode: vi.fn(),
    pendingLogsRef: { current: null as { stackName: string; containerName: string } | null },
    openNotifications: vi.fn(),
  };
  const hook = renderHook(() => useHomeNavigation(deps));
  return { deps, hook, nav: () => hook.result.current.homeNavigation };
}

function notif(overrides: Partial<NotificationItem>): NotificationItem {
  return { id: 1, level: 'error', message: 'm', timestamp: 0, is_read: 0, nodeId: 1, ...overrides };
}

beforeEach(() => toastError.mockReset());

describe('useHomeNavigation alert rows', () => {
  it('opens a stack on its own node through the shared open-in-editor path and queues its logs', () => {
    const { deps, nav } = setup();
    const n = notif({ nodeId: 2, stack_name: 'web', container_name: 'web-1' });

    const destination = nav().alerts.destinationFor(n);
    expect(destination).not.toBeNull();
    act(() => nav().alerts.open(destination!));

    expect(deps.openStackOnNode).toHaveBeenCalledWith(2, 'web', 'stack');
    expect(deps.pendingLogsRef.current).toEqual({ stackName: 'web', containerName: 'web-1' });
  });

  it('opens the Drift tab for a drift row', () => {
    const { deps, nav } = setup();
    act(() => nav().alerts.open(nav().alerts.destinationFor(notif({ stack_name: 'web', category: 'drift_detected' }))!));
    expect(deps.openStackOnNode).toHaveBeenCalledWith(1, 'web', 'drift');
  });

  it('withholds a stack destination the role cannot read', () => {
    const can = vi.fn(() => false);
    const { nav } = setup({ can });

    expect(nav().alerts.destinationFor(notif({ nodeId: 2, stack_name: 'web' }))).toBeNull();
    expect(can).toHaveBeenCalledWith('stack:read', 'stack', 'web', 2);
  });

  it('switches to the owning node before opening its scan history', () => {
    const { deps, hook, nav } = setup({ active: HUB });
    act(() => nav().alerts.open(nav().alerts.destinationFor(notif({ nodeId: 2, category: 'scan_finding' }))!));

    // Nothing lands on the hub while the switch is in flight.
    expect(deps.setActiveNode).toHaveBeenCalledWith(EDGE);
    expect(deps.setActiveView).not.toHaveBeenCalled();

    // A settle on some other node does not run it.
    expect(hook.result.current.takePendingNodeIntent(1)).toBeNull();
  });

  it('runs the queued destination only when the target node settles', () => {
    const { deps, hook, nav } = setup({ active: HUB });
    act(() => nav().alerts.open({ kind: 'security', nodeId: 2, tab: 'history' }));

    const run = hook.result.current.takePendingNodeIntent(2);
    expect(run).not.toBeNull();
    act(() => run!());
    expect(deps.setSecurityTab).toHaveBeenCalledWith('history');
    expect(deps.setActiveView).toHaveBeenCalledWith('security');
    // One-shot: a later settle finds nothing queued.
    expect(hook.result.current.takePendingNodeIntent(2)).toBeNull();
  });

  it('opens the full notification feed', () => {
    const { deps, nav } = setup();
    nav().alerts.viewAll();
    expect(deps.openNotifications).toHaveBeenCalled();
  });
});

describe('useHomeNavigation Fleet destinations', () => {
  it('opens a node in Fleet directly from the hub', () => {
    const { deps, hook, nav } = setup({ active: HUB });
    act(() => nav().toFleetNode(2));

    expect(deps.setActiveNode).not.toHaveBeenCalled();
    expect(deps.handleNavigate).toHaveBeenCalledWith('fleet');
    expect(hook.result.current.fleetNodeIntent).toBe(2);
  });

  it('switches back to the hub first when a remote node is active', () => {
    const { deps, hook, nav } = setup({ active: EDGE });
    act(() => nav().toFleetNode(2));

    expect(toastError).not.toHaveBeenCalled();
    expect(deps.setActiveNode).toHaveBeenCalledWith(HUB);
    expect(deps.handleNavigate).not.toHaveBeenCalled();

    act(() => hook.result.current.takePendingNodeIntent(1)!());
    expect(deps.handleNavigate).toHaveBeenCalledWith('fleet');
    expect(hook.result.current.fleetNodeIntent).toBe(2);
  });

  it('arms the update sheet for an update row, via the hub', () => {
    const { deps, hook, nav } = setup({ active: EDGE });
    const destination = nav().alerts.destinationFor(notif({ category: 'node_update_available', level: 'info' }));
    act(() => nav().alerts.open(destination!));
    act(() => hook.result.current.takePendingNodeIntent(1)!());

    expect(deps.handleNavigate).toHaveBeenCalledWith('fleet');
    expect(hook.result.current.fleetUpdatesIntent).toEqual({ tab: 'nodes' });
  });

  it('withholds Fleet destinations from a role without node:read', () => {
    const reachCtx = reach({ can: (a: string) => a !== 'node:read' });
    const { deps, nav } = setup({ reachCtx });

    expect(nav().alerts.destinationFor(notif({ category: 'node_update_available', level: 'info' }))).toBeNull();
    act(() => nav().toFleetNode(2));
    expect(toastError).toHaveBeenCalled();
    expect(deps.handleNavigate).not.toHaveBeenCalled();
  });

  it('does not arm a node deep link Fleet cannot consume behind its capability lock', () => {
    const { hook, nav } = setup({ reachCtx: reach({ hasFleetCapability: false }) });
    act(() => nav().toFleetNode(2));
    expect(hook.result.current.fleetNodeIntent).toBeNull();
  });
});

describe('useHomeNavigation configuration rows', () => {
  it('opens settings, security tabs, and views where they are managed', () => {
    const { deps, nav } = setup();
    nav().config.open({ kind: 'settings', section: 'webhooks' });
    nav().config.open({ kind: 'security', tab: 'scanner' });
    nav().config.open({ kind: 'view', view: 'scheduled-ops' });

    expect(deps.openSettings).toHaveBeenCalledWith('webhooks');
    expect(deps.setSecurityTab).toHaveBeenCalledWith('scanner');
    expect(deps.setActiveView).toHaveBeenCalledWith('security');
    expect(deps.handleNavigate).toHaveBeenCalledWith('scheduled-ops');
  });

  it('reports hub-only and hidden destinations as unreachable from a remote node', () => {
    const { nav } = setup({ active: EDGE });

    // Account settings are hidden on a remote node; Scheduled Operations is hub-only.
    expect(nav().config.canOpen({ kind: 'settings', section: 'account' })).toBe(false);
    expect(nav().config.canOpen({ kind: 'view', view: 'scheduled-ops' })).toBe(false);
    expect(nav().config.canOpen({ kind: 'settings', section: 'notifications' })).toBe(true);
  });
});

describe('useHomeNavigation pending intent safety', () => {
  afterEach(() => vi.useRealTimers());

  it('drops an intent whose switch never settled in time', () => {
    vi.useFakeTimers();
    const { hook, nav } = setup({ active: HUB });
    act(() => nav().alerts.open({ kind: 'security', nodeId: 2, tab: 'history' }));

    vi.advanceTimersByTime(PENDING_NODE_INTENT_TTL_MS + 1);
    expect(hook.result.current.takePendingNodeIntent(2)).toBeNull();
  });

  it('clears an older intent when a destination opens on the active node', () => {
    const { hook, nav } = setup({ active: HUB });
    act(() => nav().alerts.open({ kind: 'security', nodeId: 2, tab: 'history' }));
    act(() => nav().alerts.open({ kind: 'security', nodeId: 1, tab: 'history' }));

    expect(hook.result.current.takePendingNodeIntent(2)).toBeNull();
  });

  it('clears a stale logs target when the next stack row names no container', () => {
    const { deps, nav } = setup();
    deps.pendingLogsRef.current = { stackName: 'web', containerName: 'web-1' };
    act(() => nav().alerts.open({ kind: 'stack', nodeId: 1, stackName: 'web', tab: 'stack', containerName: null }));

    expect(deps.pendingLogsRef.current).toBeNull();
  });

  it('judges the Fleet capability lock on the node the switch landed on', () => {
    // The remote reports Fleet locked; the hub does not. The deep link must survive.
    const deps = {
      nodes: NODES, activeNode: EDGE as Node, setActiveNode: vi.fn(),
      reachCtx: reach({ isRemote: true, hasFleetCapability: false }), can: () => true, isMobile: false,
      navigateMobileAware: vi.fn(), handleNavigate: vi.fn(), setActiveView: vi.fn(), setSecurityTab: vi.fn(),
      openSettings: vi.fn(), toStack: vi.fn(), openStackOnNode: vi.fn(),
      pendingLogsRef: { current: null }, openNotifications: vi.fn(),
    };
    const hook = renderHook((props: typeof deps) => useHomeNavigation(props), { initialProps: deps });
    act(() => hook.result.current.homeNavigation.toFleetNode(3));

    hook.rerender({ ...deps, activeNode: HUB, reachCtx: reach({ isRemote: false, hasFleetCapability: true }) });
    act(() => hook.result.current.takePendingNodeIntent(1)!());
    expect(hook.result.current.fleetNodeIntent).toBe(3);
  });

  it('switches a phone back to the hub before opening Fleet', () => {
    const { deps, hook, nav } = setup({ active: EDGE, isMobile: true });
    act(() => nav().alerts.open({ kind: 'fleet-updates', tab: 'nodes' }));

    expect(deps.setActiveNode).toHaveBeenCalledWith(HUB);
    act(() => hook.result.current.takePendingNodeIntent(1)!());
    expect(deps.navigateMobileAware).toHaveBeenCalledWith('fleet');
    expect(deps.handleNavigate).not.toHaveBeenCalled();
  });

  it('says so when the target node left the roster between render and click', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { deps, nav } = setup();
    act(() => nav().alerts.open({ kind: 'security', nodeId: 99, tab: 'history' }));

    expect(toastError).toHaveBeenCalledWith('That node is no longer registered.');
    expect(deps.setActiveNode).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

