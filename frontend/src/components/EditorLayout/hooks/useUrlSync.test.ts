import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Node } from '@/context/NodeContext';
import type { ReachabilityContext } from '@/lib/routing/reachability';
import { useUrlSync, type UseUrlSyncOptions } from './useUrlSync';

function makeNode(over: Partial<Node> = {}): Node {
  return {
    id: 1,
    name: 'local',
    type: 'local',
    is_default: true,
    url: 'http://127.0.0.1:1852',
    compose_dir: '/compose',
    ...over,
  } as Node;
}

function makeReachCtx(over: Partial<ReachabilityContext> = {}): ReachabilityContext {
  return {
    isAdmin: true,
    isPaid: true,
    can: () => true,
    isRemote: false,
    hasFleetCapability: true,
    containerLabelsEnabled: true,
    permissionsStatus: 'ready',
    licenseStatus: 'ready',
    ...over,
  };
}

function makeOpts(over: Partial<UseUrlSyncOptions> = {}): UseUrlSyncOptions {
  const node = makeNode();
  return {
    nodes: [node],
    nodesLoaded: true,
    activeNode: node,
    setActiveNode: vi.fn(),
    activeView: 'dashboard',
    setActiveView: vi.fn(),
    settingsSection: 'appearance',
    setSettingsSection: vi.fn(),
    securityTab: 'overview',
    setSecurityTab: vi.fn(),
    fleetActiveTab: 'overview',
    setFleetActiveTab: vi.fn(),
    filterNodeId: null,
    setFilterNodeId: vi.fn(),
    selectedFile: null,
    files: ['radarr'],
    filesNodeId: 1,
    stacksLoadStatus: 'success',
    stacksLoadNodeId: 1,
    isFileLoading: false,
    activeTab: 'compose',
    setActiveTab: vi.fn(),
    selectedEnvFile: '',
    envFiles: [],
    loadFile: vi.fn().mockResolvedValue(undefined),
    changeEnvFile: vi.fn().mockResolvedValue(undefined),
    refreshStacks: vi.fn().mockResolvedValue(['radarr']),
    reachCtx: makeReachCtx(),
    isMobile: false,
    mobileSurface: null,
    setMobileSurface: vi.fn(),
    mobileSettingsSection: null,
    setMobileSettingsSection: vi.fn(),
    attemptPopstateNavigation: (apply) => { apply(); },
    ...over,
  };
}

describe('useUrlSync', () => {
  beforeEach(() => {
    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/local/dashboard');
  });

  it('mounts and hydrates when history state lacks senchoIdx', () => {
    window.history.replaceState({}, '', '/nodes/local/security');
    const setSecurityTab = vi.fn();

    act(() => {
      renderHook(
        (props) => useUrlSync(props),
        {
          initialProps: makeOpts({
            activeView: 'security',
            setSecurityTab,
          }),
        },
      );
    });

    expect(window.location.pathname).toBe('/nodes/local/security');
  });

  it('pushState increments senchoIdx on user navigation', () => {
    const pushSpy = vi.spyOn(window.history, 'pushState');

    const { rerender } = renderHook(
      (props) => useUrlSync(props),
      { initialProps: makeOpts({ activeView: 'dashboard' }) },
    );

    act(() => {
      rerender(makeOpts({ activeView: 'resources' }));
    });

    const pushed = pushSpy.mock.calls.find(call => String(call[2]).includes('/resources'));
    expect(pushed).toBeDefined();
    expect((pushed?.[0] as { senchoIdx?: number }).senchoIdx).toBe(1);

    pushSpy.mockRestore();
  });

  it('keeps a pending stack deep link when stack list load fails', () => {
    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/local/stacks/radarr/compose');
    const setActiveView = vi.fn();

    act(() => {
      renderHook(
        (props) => useUrlSync(props),
        {
          initialProps: makeOpts({
            activeView: 'editor',
            setActiveView,
            files: [],
            stacksLoadStatus: 'error',
            stacksLoadNodeId: 1,
          }),
        },
      );
    });

    expect(setActiveView).not.toHaveBeenCalledWith('dashboard');
    expect(window.location.pathname).toBe('/nodes/local/stacks/radarr/compose');
  });

  it('routes popstate through attemptPopstateNavigation', () => {
    const attempt = vi.fn();
    renderHook(
      (props) => useUrlSync(props),
      {
        initialProps: makeOpts({
          attemptPopstateNavigation: attempt,
        }),
      },
    );

    act(() => {
      window.history.pushState({ senchoIdx: 1 }, '', '/nodes/local/resources');
      window.dispatchEvent(new PopStateEvent('popstate', { state: { senchoIdx: 0 } }));
    });

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt.mock.calls[0]).toHaveLength(2);
  });

  it('does not normalize a paid URL while permissions metadata is still loading', () => {
    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/local/audit');
    const setActiveView = vi.fn();

    act(() => {
      renderHook(
        (props) => useUrlSync(props),
        {
          initialProps: makeOpts({
            activeView: 'audit-log',
            setActiveView,
            reachCtx: makeReachCtx({ permissionsStatus: 'loading' }),
          }),
        },
      );
    });

    expect(setActiveView).not.toHaveBeenCalledWith('dashboard');
    expect(window.location.pathname).toBe('/nodes/local/audit');
  });

  it('retryFrozenRoute triggers a foreground stack refresh', async () => {
    const refreshStacks = vi.fn().mockResolvedValue(['radarr']);
    const { result } = renderHook(
      (props) => useUrlSync(props),
      {
        initialProps: makeOpts({
          refreshStacks,
          stacksLoadStatus: 'error',
          files: [],
        }),
      },
    );

    await act(async () => {
      await result.current.retryFrozenRoute();
    });
    expect(refreshStacks).toHaveBeenCalledWith(false);
  });
});
