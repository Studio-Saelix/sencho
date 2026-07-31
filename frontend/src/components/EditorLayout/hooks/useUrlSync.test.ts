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
    experimental: true,
    experimentalReady: true,
    scheduledOpsAccessible: false,
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
    editingCompose: false,
    setEditingCompose: vi.fn(),
    selectedEnvFile: '',
    envFiles: [],
    loadFileForRoute: vi.fn().mockResolvedValue({ ok: true, envFiles: [] }),
    changeEnvFile: vi.fn().mockResolvedValue(undefined),
    applyEditorRouteState: vi.fn(),
    refreshStacks: vi.fn().mockResolvedValue(['radarr']),
    reachCtx: makeReachCtx(),
    isMobile: false,
    mobileSurface: null,
    setMobileSurface: vi.fn(),
    mobileSettingsSection: null,
    setMobileSettingsSection: vi.fn(),
    setPendingDetailStack: vi.fn(),
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

  it('does not write local node URL while hydrating a remote node deep link', () => {
    const remote = makeNode({ id: 2, name: 'nas', type: 'remote', is_default: false });
    const local = makeNode();
    const setActiveNode = vi.fn();
    const pushSpy = vi.spyOn(window.history, 'pushState');

    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/nas-2/fleet/snapshots');

    act(() => {
      renderHook(
        (props) => useUrlSync(props),
        {
          initialProps: makeOpts({
            nodes: [local, remote],
            activeNode: local,
            activeView: 'fleet',
            fleetActiveTab: 'snapshots',
            setActiveNode,
          }),
        },
      );
    });

    const badPush = pushSpy.mock.calls.find((call) => String(call[2]).includes('/nodes/local/'));
    expect(badPush).toBeUndefined();
    expect(setActiveNode).toHaveBeenCalledWith(remote);

    pushSpy.mockRestore();
  });

  it('does not resolve remote stack against stale local node files', async () => {
    const remote = makeNode({ id: 2, name: 'nas', type: 'remote', is_default: false });
    const local = makeNode();
    const setActiveNode = vi.fn();
    const setActiveView = vi.fn();
    const loadFileForRoute = vi.fn().mockResolvedValue({ ok: true, envFiles: [] });

    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/nas-2/stacks/remote-stack/compose');

    const { rerender } = renderHook(
      (props) => useUrlSync(props),
      {
        initialProps: makeOpts({
          nodes: [local, remote],
          activeNode: local,
          activeView: 'dashboard',
          files: ['local-only'],
          filesNodeId: 1,
          stacksLoadStatus: 'success',
          stacksLoadNodeId: 1,
          setActiveNode,
          setActiveView,
          loadFileForRoute,
        }),
      },
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(setActiveNode).toHaveBeenCalledWith(remote);
    expect(setActiveView).not.toHaveBeenCalledWith('dashboard');
    expect(loadFileForRoute).not.toHaveBeenCalled();

    rerender(makeOpts({
      nodes: [local, remote],
      activeNode: remote,
      activeView: 'dashboard',
      files: ['remote-stack'],
      filesNodeId: 2,
      stacksLoadStatus: 'success',
      stacksLoadNodeId: 2,
      setActiveNode,
      setActiveView,
      loadFileForRoute,
    }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(loadFileForRoute).toHaveBeenCalledWith('remote-stack');
    expect(setActiveView).not.toHaveBeenCalledWith('dashboard');
  });

  it('settles env tab route when stack has no env files', async () => {
    const loadFileForRoute = vi.fn().mockResolvedValue({ ok: true, envFiles: [] });
    const applyEditorRouteState = vi.fn();

    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/local/stacks/radarr/env');

    renderHook(
      (props) => useUrlSync(props),
      {
        initialProps: makeOpts({
          activeView: 'editor',
          files: ['radarr'],
          selectedFile: null,
          envFiles: [],
          loadFileForRoute,
          applyEditorRouteState,
        }),
      },
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(loadFileForRoute).toHaveBeenCalledWith('radarr');
    expect(applyEditorRouteState).toHaveBeenCalledWith('compose');
  });

  it('restores non-default env selection after stack load populates file list', async () => {
    const prodPath = '/compose/radarr/.env.prod';
    const fileList = ['/compose/radarr/.env', prodPath];
    const loadFileForRoute = vi.fn().mockResolvedValue({ ok: true, envFiles: fileList });
    const changeEnvFile = vi.fn().mockResolvedValue(undefined);

    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/local/stacks/radarr/env?env=.env.prod');

    const { rerender } = renderHook(
      (props) => useUrlSync(props),
      {
        initialProps: makeOpts({
          activeView: 'editor',
          files: ['radarr'],
          selectedFile: null,
          envFiles: [],
          loadFileForRoute,
          changeEnvFile,
        }),
      },
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(loadFileForRoute).toHaveBeenCalledWith('radarr');

    rerender(makeOpts({
      activeView: 'editor',
      files: ['radarr'],
      selectedFile: 'radarr',
      envFiles: fileList,
      loadFileForRoute,
      changeEnvFile,
    }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(changeEnvFile).toHaveBeenCalledWith(prodPath);
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

  it('hydrates fleet view from URL', () => {
    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/local/fleet');
    const setActiveView = vi.fn();

    act(() => {
      renderHook(
        (props) => useUrlSync(props),
        {
          initialProps: makeOpts({
            activeView: 'fleet',
            setActiveView,
          }),
        },
      );
    });

    expect(setActiveView).toHaveBeenCalledWith('fleet');
  });

  it('normalizes unknown view segments to dashboard', () => {
    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/local/not-a-view');
    const setActiveView = vi.fn();

    act(() => {
      renderHook(
        (props) => useUrlSync(props),
        {
          initialProps: makeOpts({
            activeView: 'dashboard',
            setActiveView,
          }),
        },
      );
    });

    expect(window.location.pathname).toBe('/nodes/local/dashboard');
  });

  it('hydrates mobile dashboard to the content surface', () => {
    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/local/dashboard');
    const setMobileSurface = vi.fn();

    act(() => {
      renderHook(
        (props) => useUrlSync(props),
        {
          initialProps: makeOpts({
            isMobile: true,
            mobileSurface: null,
            setMobileSurface,
          }),
        },
      );
    });

    expect(setMobileSurface).toHaveBeenCalledWith('content');
  });

  it('sets pending detail stack on mobile stack URL hydrate', () => {
    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/local/stacks/radarr/compose');
    const setPendingDetailStack = vi.fn();

    act(() => {
      renderHook(
        (props) => useUrlSync(props),
        {
          initialProps: makeOpts({
            isMobile: true,
            setPendingDetailStack,
          }),
        },
      );
    });

    expect(setPendingDetailStack).toHaveBeenCalledWith('radarr');
  });

  it('freezes route and sets routeDetailError when compose load fails', async () => {
    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/local/stacks/radarr/compose');
    const loadFileForRoute = vi.fn().mockResolvedValue({ ok: false });
    const setPendingDetailStack = vi.fn();

    const { result } = renderHook(
      (props) => useUrlSync(props),
      {
        initialProps: makeOpts({
          isMobile: true,
          setPendingDetailStack,
          loadFileForRoute,
          activeView: 'editor',
        }),
      },
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(loadFileForRoute).toHaveBeenCalledWith('radarr');
    expect(result.current.routeDetailError).toContain('Could not open');
    expect(window.location.pathname).toBe('/nodes/local/stacks/radarr/compose');
  });

  it('clears routeDetailError after a successful retry', async () => {
    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/local/stacks/radarr/compose');
    const loadFileForRoute = vi.fn().mockResolvedValue({ ok: false });

    const { result, rerender } = renderHook(
      (props) => useUrlSync(props),
      {
        initialProps: makeOpts({
          isMobile: true,
          loadFileForRoute,
          activeView: 'editor',
        }),
      },
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.routeDetailError).not.toBeNull();

    loadFileForRoute.mockResolvedValue({ ok: true, envFiles: [] });

    rerender(makeOpts({
      isMobile: true,
      loadFileForRoute,
      activeView: 'editor',
      selectedFile: 'radarr',
    }));

    await act(async () => {
      await result.current.retryFrozenRoute();
    });

    expect(result.current.routeDetailError).toBeNull();
  });

  it('hydrates tabless stack URL as detail without opening Monaco', async () => {
    const loadFileForRoute = vi.fn().mockResolvedValue({ ok: true, envFiles: [] });
    const applyEditorRouteState = vi.fn();
    const setEditingCompose = vi.fn();

    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/local/stacks/radarr');

    renderHook(
      (props) => useUrlSync(props),
      {
        initialProps: makeOpts({
          activeView: 'editor',
          files: ['radarr'],
          selectedFile: null,
          envFiles: [],
          loadFileForRoute,
          applyEditorRouteState,
          setEditingCompose,
        }),
      },
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(loadFileForRoute).toHaveBeenCalledWith('radarr');
    expect(applyEditorRouteState).not.toHaveBeenCalled();
    expect(setEditingCompose).toHaveBeenCalledWith(false);
  });

  it('writes tabless stack URL when detail is open', () => {
    const pushSpy = vi.spyOn(window.history, 'pushState');

    const { rerender } = renderHook(
      (props) => useUrlSync(props),
      { initialProps: makeOpts({ activeView: 'dashboard' }) },
    );

    act(() => {
      rerender(makeOpts({
        activeView: 'editor',
        selectedFile: 'radarr',
        editingCompose: false,
        activeTab: 'compose',
      }));
    });

    const pushed = pushSpy.mock.calls.map((call) => String(call[2] ?? ''));
    expect(pushed.some((p) => p === '/nodes/local/stacks/radarr')).toBe(true);
    expect(pushed.some((p) => p.includes('/compose'))).toBe(false);

    pushSpy.mockRestore();
  });

  it('writes dashboard URL after leaving a deleted editor stack', () => {
    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/local/stacks/radarr');
    const pushSpy = vi.spyOn(window.history, 'pushState');

    const { rerender } = renderHook(
      (props) => useUrlSync(props),
      {
        initialProps: makeOpts({
          activeView: 'editor',
          selectedFile: 'radarr',
          files: ['radarr'],
        }),
      },
    );

    act(() => {
      rerender(makeOpts({
        activeView: 'dashboard',
        selectedFile: null,
        files: [],
      }));
    });

    const paths = [
      ...pushSpy.mock.calls.map((call) => String(call[2] ?? '')),
      window.location.pathname,
    ];
    expect(paths.some((p) => p === '/nodes/local/dashboard')).toBe(true);
    expect(window.location.pathname).not.toContain('/stacks/radarr');

    pushSpy.mockRestore();
  });

  it('writes mobile stack-list URL after leaving a deleted editor stack', () => {
    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/local/stacks/radarr');
    const pushSpy = vi.spyOn(window.history, 'pushState');

    const { rerender } = renderHook(
      (props) => useUrlSync(props),
      {
        initialProps: makeOpts({
          activeView: 'editor',
          selectedFile: 'radarr',
          files: ['radarr'],
          isMobile: true,
          mobileSurface: 'detail',
        }),
      },
    );

    act(() => {
      rerender(makeOpts({
        activeView: 'dashboard',
        selectedFile: null,
        files: [],
        isMobile: true,
        mobileSurface: 'list',
      }));
    });

    const paths = [
      ...pushSpy.mock.calls.map((call) => String(call[2] ?? '')),
      window.location.pathname,
    ];
    expect(paths.some((p) => p === '/nodes/local/stacks')).toBe(true);
    expect(window.location.pathname).not.toContain('/stacks/radarr');

    pushSpy.mockRestore();
  });

  it('opens Monaco when hydrating /compose deep link', async () => {
    const loadFileForRoute = vi.fn().mockResolvedValue({ ok: true, envFiles: [] });
    const applyEditorRouteState = vi.fn();

    window.history.replaceState({ senchoIdx: 0 }, '', '/nodes/local/stacks/radarr/compose');

    renderHook(
      (props) => useUrlSync(props),
      {
        initialProps: makeOpts({
          activeView: 'editor',
          files: ['radarr'],
          selectedFile: null,
          loadFileForRoute,
          applyEditorRouteState,
        }),
      },
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(loadFileForRoute).toHaveBeenCalledWith('radarr');
    expect(applyEditorRouteState).toHaveBeenCalledWith('compose');
  });
});
