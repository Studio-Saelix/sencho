import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStackActions } from './useStackActions';
import type { useEditorViewState } from './useEditorViewState';
import type { useStackListState } from './useStackListState';
import type { useViewNavigationState } from './useViewNavigationState';
import type { OverlayState } from './useOverlayState';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  DEPLOY_SESSION_HEADER: 'x-deploy-session-id',
  withDeploySession: (deploySessionId: string, options: RequestInit = {}) => ({
    ...options,
    headers: { ...(options.headers as Record<string, string> | undefined), 'x-deploy-session-id': deploySessionId },
  }),
}));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), loading: vi.fn(() => 'loading-id'), dismiss: vi.fn() },
}));

import { apiFetch } from '@/lib/api';
import {
  absentRevision,
  missingApplicationLimitation,
  sourceRevision,
} from '@/__tests__/gitopsFixtures';
import { toast } from '@/components/ui/toast-store';

type EditorState = ReturnType<typeof useEditorViewState>;
type StackListState = ReturnType<typeof useStackListState>;
type NavState = ReturnType<typeof useViewNavigationState>;
type ActiveNode = Parameters<typeof useStackActions>[0]['activeNode'];
const DEFAULT_ACTIVE_NODE = { id: 1, name: 'Local', type: 'local' } as ActiveNode;

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeEditorState(over: Partial<EditorState> = {}): EditorState {
  const base = {
    content: 'services: {}',
    originalContent: 'services: {}\n',
    envContent: '',
    originalEnvContent: '',
    activeTab: 'compose' as const,
    selectedEnvFile: '',
    composeEtag: null as string | null,
    envEtag: null as string | null,
    setContent: vi.fn(),
    setOriginalContent: vi.fn(),
    setEnvContent: vi.fn(),
    setOriginalEnvContent: vi.fn(),
    setIsEditing: vi.fn(),
    setEditingCompose: vi.fn(),
    setActiveTab: vi.fn(),
    setContainers: vi.fn(),
    containers: [],
    containersLoadStatus: 'idle' as const,
    containersLoadError: null as string | null,
    setContainersLoadStatus: vi.fn(),
    setContainersLoadError: vi.fn(),
    setEnvFiles: vi.fn(),
    setSelectedEnvFile: vi.fn(),
    setEnvExists: vi.fn(),
    setBackupInfo: vi.fn(),
    setIsFileLoading: vi.fn(),
    setGitSourcePendingMap: vi.fn(),
    setComposeEtag: vi.fn(),
    setEnvEtag: vi.fn(),
    effectiveServices: [],
    setEffectiveServices: vi.fn(),
    serviceUpdateInProgress: null,
    setServiceUpdateInProgress: vi.fn(),
  };
  return { ...base, ...over } as unknown as EditorState;
}

function makeStackListState(over: Partial<StackListState> = {}): StackListState {
  const base = {
    selectedFile: 'web.yml',
    files: ['web.yml'],
    stackStatuses: { 'web.yml': 'running' },
    stackPorts: {},
    stackSelfFlags: {},
    setSelectedFile: vi.fn(),
    setOptimisticStatus: vi.fn(),
    setStackAction: vi.fn(),
    clearStackAction: vi.fn(),
    isStackBusy: vi.fn().mockReturnValue(false),
    refreshStacks: vi.fn(),
    setSearchQuery: vi.fn(),
    fetchImageUpdates: vi.fn(),
    lastActionResult: {},
    recordActionFailure: vi.fn(),
    recordActionSuccess: vi.fn(),
    clearActionRecords: vi.fn(),
    dismissActionResult: vi.fn(),
    hydrationReady: vi.fn().mockReturnValue(true),
  };
  return { ...base, ...over } as unknown as StackListState;
}

function makeOverlay(over: Partial<OverlayState> = {}): OverlayState {
  return {
    setPendingUnsavedLoad: vi.fn(),
    setPendingLoadOptions: vi.fn(),
    setPendingUnsavedNode: vi.fn(),
    setPendingLeaveAction: vi.fn(),
    pendingUnsavedLoad: null,
    pendingLoadOptions: null,
    pendingUnsavedNode: null,
    pendingLeaveAction: null,
    policyBlock: null,
    setPolicyBlock: vi.fn(),
    setPolicyBypassing: vi.fn(),
    updateReadiness: null,
    setUpdateReadiness: vi.fn(),
    preDeployAdvisory: null,
    setPreDeployAdvisory: vi.fn(),
    openSelfStackProtected: vi.fn(),
    setComposeReapplyCapture: vi.fn(),
    composeReapplyCapture: null,
    setDiffPreview: vi.fn(),
    setMissingExternalNetworks: vi.fn(),
    deleteTarget: null,
    closeDeleteDialog: vi.fn(),
    ...over,
  } as unknown as OverlayState;
}

let lastRunWithLogParams: Parameters<Parameters<typeof useStackActions>[0]['runWithLog']>[0] | null = null;
const runWithLog: Parameters<typeof useStackActions>[0]['runWithLog'] = async (params, run) => {
  lastRunWithLogParams = params;
  return run(Promise.resolve(), 'test-session');
};

function setup(over: {
  editorState?: Partial<EditorState>;
  overlay?: Partial<OverlayState>;
  stackList?: Partial<StackListState>;
  navState?: Partial<NavState>;
  getLastDeployOutputLine?: (stackName: string) => string | undefined;
  hasUpdateGuard?: boolean;
  hasGuidedExternalNetworkPreflight?: boolean;
  canEditStack?: (stackNameOrFilename: string) => boolean;
  activeNode?: Parameters<typeof useStackActions>[0]['activeNode'];
  setActiveNode?: Parameters<typeof useStackActions>[0]['setActiveNode'];
  onDeletedOpenStack?: () => void;
  removeNotificationsForStack?: (nodeId: number, stackName: string) => void;
  isAdmin?: boolean;
  canReapplyCompose?: boolean;
  hasServiceScopedUpdate?: boolean;
} = {}) {
  const editorState = makeEditorState(over.editorState);
  const stackListState = makeStackListState(over.stackList);
  const navState = {
    activeView: 'editor',
    setActiveView: vi.fn(),
    ...over.navState,
  } as unknown as NavState;
  const overlayState = makeOverlay(over.overlay);
  const setActiveNode = over.setActiveNode ?? vi.fn();
  const onDeletedOpenStack = over.onDeletedOpenStack ?? vi.fn();
  const removeNotificationsForStack = over.removeNotificationsForStack ?? vi.fn();

  // Live node holder so a test can re-render the hook with a different active
  // node (e.g. to prove a deferred continuation captured for node A is blocked
  // after the operator switches to node B).
  const activeNodeHolder: { current: ActiveNode | null } = {
    current: over.activeNode === undefined ? DEFAULT_ACTIVE_NODE : over.activeNode,
  };
  const { result, rerender } = renderHook(() =>
    useStackActions({
      editorState,
      stackListState,
      navState,
      overlayState,
      activeNode: activeNodeHolder.current,
      setActiveNode,
      nodes: [],
      runWithLog,
      getLastDeployOutputLine: over.getLastDeployOutputLine ?? (() => undefined),
      diffPreviewEnabled: false,
      hasUpdateGuard: over.hasUpdateGuard ?? false,
      hasGuidedExternalNetworkPreflight: over.hasGuidedExternalNetworkPreflight ?? false,
      hasServiceScopedUpdate: over.hasServiceScopedUpdate ?? false,
      canEditStack: over.canEditStack ?? (() => true),
      onDeletedOpenStack,
      removeNotificationsForStack,
      isAdmin: over.isAdmin ?? false,
      canReapplyCompose: over.canReapplyCompose ?? false,
    }),
  );
  return { result, rerender, activeNodeHolder, editorState, stackListState, overlayState, navState, setActiveNode, onDeletedOpenStack, removeNotificationsForStack };
}

describe('useStackActions.saveFile', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('returns true and stores originalContent when the PUT succeeds', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status: 200 }));
    const { result, editorState } = setup({
      editorState: { content: 'new', originalContent: 'old' },
    });
    const ok = await result.current.saveFile();
    expect(ok).toBe(true);
    expect(editorState.setOriginalContent).toHaveBeenCalledWith('new');
    // Stay editable after save (no re-gate into read-only Monaco).
    expect(editorState.setIsEditing).not.toHaveBeenCalledWith(false);
  });

  it('returns false and leaves dirty state intact when the PUT fails', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('boom', { status: 500 }));
    const { result, editorState } = setup({
      editorState: { content: 'new', originalContent: 'old' },
    });
    const ok = await result.current.saveFile();
    expect(ok).toBe(false);
    expect(editorState.setOriginalContent).not.toHaveBeenCalled();
  });

  it('returns false when no stack is selected', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status: 200 }));
    const editorState = makeEditorState();
    const stackListState = makeStackListState({ selectedFile: null });
    const { result } = renderHook(() =>
      useStackActions({
        editorState,
        stackListState,
        navState: { activeView: 'editor', setActiveView: vi.fn() } as unknown as NavState,
        overlayState: makeOverlay(),
        activeNode: { id: 1, type: 'local' } as Parameters<typeof useStackActions>[0]['activeNode'],
        setActiveNode: vi.fn(),
        nodes: [],
        runWithLog,
        getLastDeployOutputLine: () => undefined,
        diffPreviewEnabled: false,
        canEditStack: () => true,
        onDeletedOpenStack: vi.fn(),
      }),
    );
    const ok = await result.current.saveFile();
    expect(ok).toBe(false);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('useStackActions.handleSaveAndDeploy', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('does NOT call /deploy when saveFile fails', async () => {
    // PUT returns 500 → saveFile resolves false → deploy must not be attempted.
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response('save broke', { status: 500 }));
    const { result } = setup();
    await result.current.handleSaveAndDeploy({ preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.MouseEvent);
    const calls = vi.mocked(apiFetch).mock.calls.map(c => c[0]);
    expect(calls.some(c => String(c).includes('/deploy'))).toBe(false);
  });

  it('calls /deploy when saveFile succeeds', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 200 })); // save OK
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 200 })); // deploy OK
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response('[]', { status: 200 })); // containers refresh
    const { result } = setup();
    await result.current.handleSaveAndDeploy({ preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.MouseEvent);
    const calls = vi.mocked(apiFetch).mock.calls.map(c => c[0]);
    expect(calls.some(c => String(c).includes('/deploy'))).toBe(true);
  });
});

describe('useStackActions.checkUpdatesForStack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiFetch).mockReset();
  });

  it('hits the per-stack refresh endpoint and shows success when the stack is cleared', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(JSON.stringify({ outcome: 'cleared', warning: null }), { status: 200 }),
    );
    const { result, stackListState } = setup();
    await result.current.checkUpdatesForStack('web');
    expect(apiFetch).toHaveBeenCalledWith('/image-updates/refresh/web', { method: 'POST' });
    expect(stackListState.fetchImageUpdates).toHaveBeenCalled();
    expect(toast.dismiss).toHaveBeenCalledWith('loading-id');
    expect(toast.success).toHaveBeenCalledWith('Image update check complete.');
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('shows the warning via toast.info instead of success when verification did not cleanly complete', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(
        JSON.stringify({ outcome: 'verification_failed', warning: 'Could not verify the update.' }),
        { status: 200 },
      ),
    );
    const { result } = setup();
    await result.current.checkUpdatesForStack('web');
    expect(toast.dismiss).toHaveBeenCalledWith('loading-id');
    expect(toast.info).toHaveBeenCalledWith('Could not verify the update.');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('replaces the generic post-update warning copy for an incomplete verification too', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          outcome: 'verification_incomplete',
          warning: 'The update command completed, but Sencho could not fully verify whether an image update remains.',
        }),
        { status: 200 },
      ),
    );
    const { result } = setup();
    await result.current.checkUpdatesForStack('web');
    expect(toast.info).toHaveBeenCalledWith('Could not fully verify update status for web.');
    expect(toast.info).not.toHaveBeenCalledWith(expect.stringContaining('update command completed'));
  });

  it('uses stack-scoped copy instead of the backend post-update warning when an update is still present', async () => {
    // The backend reuses its post-update reconciliation result for this
    // manual pre-update check, so its "still_present" warning text ("The
    // update command completed...") does not apply here; the frontend must
    // not forward it verbatim.
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          outcome: 'still_present',
          warning: 'The update command completed, but Sencho still detects an available image update.',
        }),
        { status: 200 },
      ),
    );
    const { result } = setup();
    await result.current.checkUpdatesForStack('web');
    expect(toast.dismiss).toHaveBeenCalledWith('loading-id');
    expect(toast.info).toHaveBeenCalledWith('web still has an update available.');
    expect(toast.info).not.toHaveBeenCalledWith(expect.stringContaining('update command completed'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('shows a loading toast immediately and dismisses it on error', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ error: 'nope' }), { status: 500 }));
    const { result } = setup();
    await result.current.checkUpdatesForStack('web');
    expect(toast.loading).toHaveBeenCalledWith('Checking web for image updates...');
    expect(toast.dismiss).toHaveBeenCalledWith('loading-id');
    expect(toast.error).toHaveBeenCalledWith('nope');
  });
});

describe('useStackActions node binding', () => {
  const mouseEvent = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.MouseEvent;

  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status: 200 }));
    lastRunWithLogParams = null;
  });

  function postCallFor(fragment: string): RequestInit | undefined {
    const call = vi.mocked(apiFetch).mock.calls.find(
      c => String(c[0]).includes(fragment) && (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    return call?.[1] as RequestInit | undefined;
  }

  it('binds the deploy POST and the runWithLog session to the captured node', async () => {
    const { result } = setup(); // activeNode.id = 1
    await result.current.deployStack(mouseEvent);
    expect(postCallFor('/deploy')).toEqual(expect.objectContaining({ nodeId: 1 }));
    expect(lastRunWithLogParams).toEqual(expect.objectContaining({ nodeId: 1 }));
  });

  it('binds the update POST and the runWithLog session to the captured node', async () => {
    const { result } = setup();
    await result.current.updateStack(mouseEvent);
    expect(postCallFor('/update')).toEqual(expect.objectContaining({ nodeId: 1 }));
    expect(lastRunWithLogParams).toEqual(expect.objectContaining({ nodeId: 1 }));
  });

  it('binds a non-update action (restart) POST and session to the captured node', async () => {
    const { result } = setup();
    await result.current.restartStack(mouseEvent);
    expect(postCallFor('/restart')).toEqual(expect.objectContaining({ nodeId: 1 }));
    expect(lastRunWithLogParams).toEqual(expect.objectContaining({ nodeId: 1 }));
  });
});

// Node-pin regression for the compose/env editor chain (#1854): every request a
// loadFile -> edit -> saveFile operation issues must target the node the tab
// captured, never the localStorage value some other tab rewrote mid-session.
// The suite mocks apiFetch, so these assert the explicit nodeId CALL OPTION;
// the option-to-header mapping is proven in src/lib/__tests__/api.test.ts
// ("apiFetch nodeId override"), and browser-level integration by the two-tab
// e2e in e2e/editor-save-deploy.spec.ts.
describe('useStackActions editor request node pinning', () => {
  // URL-keyed dispatcher: order-independent, unlike mockResolvedValueOnce
  // chains that silently desynchronize when the chain changes.
  function mockEditorChain(overrides: { put?: Response } = {}) {
    vi.mocked(apiFetch).mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u === '/stacks/web.yml' && method === 'GET') {
        return Promise.resolve(new Response('services: {}', { status: 200 }));
      }
      if ((u === '/stacks/web.yml' || u.includes('/stacks/web.yml/env?file=')) && method === 'PUT') {
        // A forced retry (no If-Match) always succeeds; the server never
        // answers a forced PUT with 412, and an unconditional 412 here would
        // recurse saveFile forever.
        const hasIfMatch = !!(init?.headers as Record<string, string> | undefined)?.['If-Match'];
        if (overrides.put && hasIfMatch) return Promise.resolve(overrides.put);
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (u === '/stacks/web.yml/envs') {
        return Promise.resolve(new Response(JSON.stringify({ envFiles: ['.env'] }), { status: 200 }));
      }
      if (u.startsWith('/stacks/web.yml/env?file=')) {
        return Promise.resolve(new Response('KEY=value', { status: 200 }));
      }
      if (u === '/stacks/web/containers') {
        return Promise.resolve(new Response('[]', { status: 200 }));
      }
      if (u === '/stacks/web.yml/backup') {
        return Promise.resolve(new Response(JSON.stringify({ exists: false }), { status: 200 }));
      }
      if (u === '/stacks/web/effective-services') {
        return Promise.resolve(new Response(JSON.stringify({ renderable: false, services: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response('', { status: 404 }));
    });
  }

  function callFor(fragment: string, method = 'GET') {
    const call = vi.mocked(apiFetch).mock.calls.find(
      c => String(c[0]).includes(fragment) && ((c[1] as RequestInit | undefined)?.method ?? 'GET') === method,
    );
    expect(call, `expected a ${method} call matching ${fragment}`).toBeDefined();
    return (call![1] ?? {}) as RequestInit & { nodeId?: number | null };
  }

  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    lastRunWithLogParams = null;
  });

  it('saveFile PUT carries the captured active node id', async () => {
    mockEditorChain();
    const { result } = setup();
    const ok = await result.current.saveFile();
    expect(ok).toBe(true);
    expect(callFor('/stacks/web.yml', 'PUT')).toEqual(expect.objectContaining({ nodeId: 1 }));
  });

  it('loadFile pins every hydration GET to the captured node', async () => {
    mockEditorChain();
    // Equal content/originalContent buffers make the fixture a pure load with
    // no dirty-state interaction.
    const { result } = setup({
      hasServiceScopedUpdate: true,
      editorState: { content: 'same', originalContent: 'same' },
    });
    await result.current.loadFile('web.yml');
    const expected = [
      '/stacks/web.yml',            // compose GET
      '/stacks/web.yml/envs',       // env list
      '/stacks/web.yml/env?file=',  // env content
      '/stacks/web/containers',     // container list
      '/stacks/web.yml/backup',     // backup info
      '/stacks/web/effective-services',
    ];
    for (const fragment of expected) {
      expect(callFor(fragment)).toEqual(expect.objectContaining({ nodeId: 1 }));
    }
    const other = vi.mocked(apiFetch).mock.calls.filter(
      c => ((c[1] as RequestInit & { nodeId?: number | null } | undefined)?.nodeId ?? null) !== 1,
    );
    expect(other, 'no request in the load chain may carry a different node').toHaveLength(0);
  });

  it('changeEnvFile GET carries the captured node id', async () => {
    mockEditorChain();
    const { result } = setup();
    await result.current.changeEnvFile('.env');
    expect(callFor('/stacks/web.yml/env?file=', 'GET')).toEqual(
      expect.objectContaining({ nodeId: 1 }),
    );
  });

  it('env saveFile PUT carries the captured node id', async () => {
    mockEditorChain();
    const { result } = setup({
      editorState: { activeTab: 'env', selectedEnvFile: '.env', envContent: 'K=v', originalEnvContent: 'K=v' },
    });
    const ok = await result.current.saveFile();
    expect(ok).toBe(true);
    expect(callFor('/stacks/web.yml/env?file=', 'PUT')).toEqual(expect.objectContaining({ nodeId: 1 }));
  });

  it('the 412 overwrite retry reuses the same captured node id on both PUTs', async () => {
    mockEditorChain({
      put: new Response(
        JSON.stringify({ currentContent: 'remote edit' }),
        { status: 412, headers: { 'Content-Type': 'application/json' } },
      ),
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      // composeEtag gives the initial PUT an If-Match header, which is what the
      // server answers 412 to; the forced retry sends no If-Match and succeeds.
      const { result } = setup({ editorState: { composeEtag: '"etag-1"' } });
      const ok = await result.current.saveFile();
      expect(ok).toBe(true);
      const puts = vi.mocked(apiFetch).mock.calls.filter(
        c => String(c[0]) === '/stacks/web.yml' && (c[1] as RequestInit | undefined)?.method === 'PUT',
      );
      expect(puts).toHaveLength(2); // initial + force retry
      const nodeIds = puts.map(
        c => (c[1] as RequestInit & { nodeId?: number | null }).nodeId,
      );
      expect(nodeIds).toEqual([1, 1]);
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('loadFileOnNode pins the whole chain to the target node and survives a rerender mid-load', async () => {
    // The env-chain GETs are held until the component has re-rendered with the
    // new node active, so the containers fetch is already armed with the load
    // target when the operator's context settles. A live-ref expectation (the
    // pre-fix behavior) would then mark the target node's response stale; the
    // pin must keep it accepted.
    let releaseChain: ((r: Response) => void) | null = null;
    const held = (): Promise<Response> =>
      new Promise<Response>((resolve) => { releaseChain = resolve; });
    vi.mocked(apiFetch).mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u === '/stacks/webapp.yml' && method === 'GET') {
        return Promise.resolve(new Response('services: {}', { status: 200 }));
      }
      if (u === '/stacks/webapp.yml/envs' || u === '/stacks/webapp/containers') {
        return held();
      }
      if (u === '/stacks/webapp.yml/backup') {
        return Promise.resolve(new Response(JSON.stringify({ exists: false }), { status: 200 }));
      }
      if (u === '/stacks/webapp/effective-services') {
        return Promise.resolve(new Response(JSON.stringify({ renderable: false, services: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response('', { status: 404 }));
    });

    const targetNode = { id: 2, type: 'remote' } as Parameters<typeof useStackActions>[0]['activeNode'];
    // Equal content buffers keep the fixture a pure load with no dirty-state
    // interaction (the stackList mock starts with no file selected, so the
    // unsaved-changes gate is not even reached).
    // The stackList mock must track setSelectedFile so the ownership ref
    // (synced from stackListState.selectedFile each render) sees the file the
    // load claimed; a frozen null would mark every mid-flight fetch stale.
    const live = setup({
      hasServiceScopedUpdate: true,
      editorState: { content: 'same', originalContent: 'same' },
      stackList: { selectedFile: null },
    });
    (live.stackListState.setSelectedFile as unknown as { mockImplementation: (fn: (f: string | null) => void) => void })
      .mockImplementation((f: string | null) => {
        (live.stackListState as unknown as { selectedFile: string | null }).selectedFile = f;
      });
    const { result, rerender, activeNodeHolder, editorState } = live;

    let loadPromise!: Promise<void>;
    act(() => {
      loadPromise = result.current.loadFileOnNode(targetNode!, 'webapp.yml');
    });
    // loadFileOnNode captured the target before any re-render.
    expect(callFor('/stacks/webapp.yml')).toEqual(expect.objectContaining({ nodeId: 2 }));

    // The operator's context settles on the new node (rerender) while the
    // envs GET is still in flight, so the containers expectation is built
    // BEFORE the flip (from the captured pin), not after it.
    activeNodeHolder.current = targetNode;
    rerender();
    // Drain the microtask queue so the held envs GET is observed as in-flight.
    await act(async () => { await Promise.resolve(); });
    expect(releaseChain).not.toBeNull();

    await act(async () => {
      releaseChain?.(new Response(JSON.stringify({ envFiles: [] }), { status: 200 }));
      // Let the env chain settle (empty list) so the containers GET fires
      // while the flipped context is live; its response is released next.
      // Bounded drain instead of a fixed tick count: it exits as soon as the
      // containers GET is observed and fails loudly if it never appears.
      for (let i = 0; i < 100; i++) {
        await Promise.resolve();
        if (vi.mocked(apiFetch).mock.calls.some(
          c => String(c[0]) === '/stacks/webapp/containers',
        )) break;
      }
    });
    expect(callFor('/stacks/webapp/containers')).toEqual(expect.objectContaining({ nodeId: 2 }));

    await act(async () => {
      releaseChain?.(new Response(JSON.stringify([{ Id: 'c1', Names: ['/webapp'], State: 'running' }]), { status: 200 }));
      await loadPromise;
    });
    // Target-node containers were ACCEPTED (not rejected as stale).
    expect(editorState.setContainers).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ Id: 'c1' })]),
    );
    expect(editorState.setContainersLoadStatus).toHaveBeenCalledWith('success');

    // Every request in the chain targeted node 2, and none targeted node 1.
    const calls = vi.mocked(apiFetch).mock.calls;
    const wrong = calls.filter(
      c => ((c[1] as RequestInit & { nodeId?: number | null } | undefined)?.nodeId ?? null) !== 2,
    );
    expect(wrong, 'every chained request must carry nodeId: 2').toHaveLength(0);
  });

  it('absent active node and absent expected node are the same local identity (no false stale)', async () => {
    const setContainers = vi.fn();
    const setContainersLoadStatus = vi.fn();
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(JSON.stringify([{ Id: 'c1', Names: ['/web'], State: 'running' }]), { status: 200 }),
    );
    const { result } = setup({
      activeNode: null,
      editorState: {
        containers: [],
        containersLoadStatus: 'success',
        containersLoadError: null,
        setContainers,
        setContainersLoadStatus,
        setContainersLoadError: vi.fn(),
      } as never,
    });
    await act(async () => {
      await result.current.refreshSelectedContainers('web', 'web.yml');
      // The Retry affordance derives its expectation the same way; a regression
      // in either one-line normalization would false-stale on a local load.
      await result.current.retryContainersLoad();
    });
    expect(apiFetch).toHaveBeenCalledWith(
      '/stacks/web/containers',
      expect.objectContaining({ nodeId: null }),
    );
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(setContainers).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ Id: 'c1' })]),
    );
    expect(setContainersLoadStatus).toHaveBeenCalledWith('success');
  });
});

describe('useStackActions policy-block dialog wiring', () => {
  const policyPayload = {
    error: 'Policy "block-high" blocked deploy: 1 image(s) exceed HIGH',
    policy: { id: 1, name: 'block-high', maxSeverity: 'HIGH' },
    violations: [{ imageRef: 'nginx:1.14', severity: 'CRITICAL', criticalCount: 2, highCount: 5, scanId: 9 }],
  };
  const mouseEvent = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.MouseEvent;

  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('opens the dialog with action "deploy" when an editor deploy is blocked', async () => {
    // deployStack first fetches the pre-deploy advisory summary; keep it off so
    // the flow reaches the deploy POST that returns the policy block.
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ enabled: false }), { status: 200 }));
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify(policyPayload), { status: 409 }));
    const { result, overlayState } = setup();
    await result.current.deployStack(mouseEvent);
    expect(overlayState.setPolicyBlock).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: 'web', stackFile: 'web.yml', action: 'deploy' }),
    );
  });

  it('opens the dialog with action "update" when an update is blocked', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify(policyPayload), { status: 409 }));
    const { result, overlayState } = setup();
    await result.current.updateStack(mouseEvent);
    expect(overlayState.setPolicyBlock).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: 'web', stackFile: 'web.yml', action: 'update' }),
    );
  });

  it('opens the dialog with action "deploy" when a sidebar deploy is blocked', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify(policyPayload), { status: 409 }));
    const { result, overlayState } = setup();
    await result.current.executeStackActionByFile('web.yml', 'deploy', 'deploy');
    expect(overlayState.setPolicyBlock).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: 'web', stackFile: 'web.yml', action: 'deploy' }),
    );
  });

  it('does not open the dialog for a stack-op-in-progress 409', async () => {
    const inProgress = JSON.stringify({
      code: 'stack_op_in_progress',
      inProgress: { action: 'deploy', startedAt: Date.now(), user: 'someone' },
    });
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(inProgress, { status: 409 }));
    const { result, overlayState } = setup();
    await result.current.updateStack(mouseEvent);
    expect(overlayState.setPolicyBlock).not.toHaveBeenCalled();
  });

  it('toasts a deletion-in-progress message when the conflict action is delete', async () => {
    const inProgress = JSON.stringify({
      code: 'stack_op_in_progress',
      inProgress: { action: 'delete', startedAt: Date.now(), user: 'admin' },
    });
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(inProgress, { status: 409 }));
    const { result, overlayState } = setup();
    await act(async () => { await result.current.updateStack(mouseEvent); });
    expect(overlayState.setPolicyBlock).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/already deleting/i));
  });

  it('opens the dialog with action "update" via the sidebar update entry point', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify(policyPayload), { status: 409 }));
    const { result, overlayState } = setup();
    await result.current.executeStackActionByFile('web.yml', 'update', 'update');
    expect(overlayState.setPolicyBlock).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: 'web', stackFile: 'web.yml', action: 'update' }),
    );
  });

  it('opens the dialog with action "rollback" when a rollback is blocked', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify(policyPayload), { status: 409 }));
    const { result, overlayState } = setup();
    await result.current.rollbackStack();
    expect(overlayState.setPolicyBlock).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: 'web', stackFile: 'web.yml', action: 'rollback' }),
    );
  });
});

describe('useStackActions pre-deploy advisory', () => {
  const mouseEvent = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.MouseEvent;

  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    lastRunWithLogParams = null;
  });

  it('opens the advisory before deploying and defers the deploy until the user proceeds', async () => {
    const setPreDeployAdvisory = vi.fn();
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (String(url).includes('/pre-deploy-summary')) {
        return new Response(JSON.stringify({ enabled: true, images: [{ imageRef: 'nginx:1.14', scan: null }] }), { status: 200 });
      }
      return new Response(null, { status: 200 });
    });
    const { result } = setup({ overlay: { setPreDeployAdvisory } });

    await result.current.deployStack(mouseEvent);

    // The advisory opened and the deploy has NOT started (no progress log, no POST).
    expect(setPreDeployAdvisory).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: 'web', images: [{ imageRef: 'nginx:1.14', scan: null }] }),
    );
    expect(lastRunWithLogParams).toBeNull();
    expect(vi.mocked(apiFetch).mock.calls.filter(c => String(c[0]).includes('/deploy'))).toHaveLength(0);

    // Proceeding runs the actual deploy.
    const arg = setPreDeployAdvisory.mock.calls[0][0] as { proceed: () => void };
    arg.proceed();
    await vi.waitFor(() => expect(lastRunWithLogParams).not.toBeNull());
  });

  it('deploys directly, with no advisory, when the summary is disabled', async () => {
    const setPreDeployAdvisory = vi.fn();
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ enabled: false }), { status: 200 }));
    const { result } = setup({ overlay: { setPreDeployAdvisory } });

    await result.current.deployStack(mouseEvent);

    expect(setPreDeployAdvisory).not.toHaveBeenCalled();
    expect(lastRunWithLogParams).not.toBeNull();
  });

  it('deploys directly when the advisory is enabled but no images are returned', async () => {
    const setPreDeployAdvisory = vi.fn();
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (String(url).includes('/pre-deploy-summary')) {
        return new Response(JSON.stringify({ enabled: true, images: [] }), { status: 200 });
      }
      return new Response(null, { status: 200 });
    });
    const { result } = setup({ overlay: { setPreDeployAdvisory } });

    await result.current.deployStack(mouseEvent);

    expect(setPreDeployAdvisory).not.toHaveBeenCalled();
    expect(lastRunWithLogParams).not.toBeNull();
  });

  it('binds the advisory fetch and the deferred deploy to the captured node', async () => {
    const setPreDeployAdvisory = vi.fn();
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (String(url).includes('/pre-deploy-summary')) {
        return new Response(JSON.stringify({ enabled: true, images: [{ imageRef: 'nginx:1.14', scan: null }] }), { status: 200 });
      }
      return new Response(null, { status: 200 });
    });
    const { result } = setup({
      overlay: { setPreDeployAdvisory },
      activeNode: { id: 42, type: 'local' } as Parameters<typeof useStackActions>[0]['activeNode'],
    });

    await result.current.deployStack(mouseEvent);

    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining('/pre-deploy-summary'),
      expect.objectContaining({ nodeId: 42 }),
    );
    const arg = (setPreDeployAdvisory.mock.calls[0][0]) as { proceed: () => void };
    arg.proceed();
    await vi.waitFor(() => expect(lastRunWithLogParams?.nodeId).toBe(42));
  });

  it('runs the deploy at most once even if proceed fires twice', async () => {
    const setPreDeployAdvisory = vi.fn();
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (String(url).includes('/pre-deploy-summary')) {
        return new Response(JSON.stringify({ enabled: true, images: [{ imageRef: 'nginx:1.14', scan: null }] }), { status: 200 });
      }
      return new Response(null, { status: 200 });
    });
    const { result } = setup({ overlay: { setPreDeployAdvisory } });

    await result.current.deployStack(mouseEvent);
    const arg = (setPreDeployAdvisory.mock.calls[0][0]) as { proceed: () => void };
    arg.proceed();
    await vi.waitFor(() => expect(lastRunWithLogParams).not.toBeNull());

    lastRunWithLogParams = null;
    arg.proceed();
    await Promise.resolve();
    expect(lastRunWithLogParams).toBeNull();
  });

  it('blocks a second deploy click while the advisory fetch is still pending', async () => {
    const setPreDeployAdvisory = vi.fn();
    const summaryGate: { release: () => void } = { release: () => {} };
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      if (String(url).includes('/pre-deploy-summary')) {
        return new Promise<Response>((resolve) => {
          summaryGate.release = () => resolve(new Response(JSON.stringify({ enabled: false }), { status: 200 }));
        });
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    const { result } = setup({ overlay: { setPreDeployAdvisory } });

    const first = result.current.deployStack(mouseEvent);
    const second = result.current.deployStack(mouseEvent); // double-click while the summary is in flight
    summaryGate.release();
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(lastRunWithLogParams).not.toBeNull());

    // The second click is blocked before it ever issues a request, so exactly
    // one summary fetch and one deploy occur.
    const summaryCalls = vi.mocked(apiFetch).mock.calls.filter(c => String(c[0]).includes('/pre-deploy-summary'));
    expect(summaryCalls).toHaveLength(1);
  });

  it('clears the pending guard on cancel so a later deploy is allowed', async () => {
    const setPreDeployAdvisory = vi.fn();
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (String(url).includes('/pre-deploy-summary')) {
        return new Response(JSON.stringify({ enabled: true, images: [{ imageRef: 'nginx:1.14', scan: null }] }), { status: 200 });
      }
      return new Response(null, { status: 200 });
    });
    const { result } = setup({ overlay: { setPreDeployAdvisory } });

    await result.current.deployStack(mouseEvent);
    const arg = (setPreDeployAdvisory.mock.calls[0][0]) as { cancel: () => void };
    arg.cancel(); // dismiss the advisory; the guard must release

    await result.current.deployStack(mouseEvent); // a fresh deploy must not be blocked
    // Calls: open, null (cancel), open again. The third proves the guard cleared
    // and the later deploy opened a fresh advisory rather than being blocked.
    expect(setPreDeployAdvisory).toHaveBeenCalledTimes(3);
    expect(setPreDeployAdvisory.mock.calls[2][0]).toMatchObject({ stackName: 'web' });
  });
});

describe('useStackActions.bypassPolicyAndRetry', () => {
  const payload = {
    error: 'blocked',
    policy: { id: 1, name: 'block-high', maxSeverity: 'HIGH' },
    violations: [{ imageRef: 'nginx:1.14', severity: 'CRITICAL', criticalCount: 1, highCount: 0, scanId: 1 }],
  };

  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('retries an update bypass against the update endpoint with ?ignorePolicy=true', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 200 })); // update OK
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response('[]', { status: 200 })); // containers refresh
    const { result } = setup({
      overlay: { policyBlock: { stackName: 'web', stackFile: 'web.yml', action: 'update', payload, nodeId: 1 } as never },
    });
    await result.current.bypassPolicyAndRetry();
    const urls = vi.mocked(apiFetch).mock.calls.map(c => String(c[0]));
    expect(urls).toContain('/stacks/web/update?ignorePolicy=true');
    expect(urls.some(u => u.includes('/deploy'))).toBe(false);
  });

  it('retries a deploy bypass against the deploy endpoint with ?ignorePolicy=true', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 200 })); // deploy OK
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response('[]', { status: 200 })); // containers refresh
    const { result } = setup({
      overlay: { policyBlock: { stackName: 'web', stackFile: 'web.yml', action: 'deploy', payload, nodeId: 1 } as never },
    });
    await result.current.bypassPolicyAndRetry();
    const urls = vi.mocked(apiFetch).mock.calls.map(c => String(c[0]));
    expect(urls).toContain('/stacks/web/deploy?ignorePolicy=true');
    expect(urls.some(u => u.includes('/update'))).toBe(false);
  });

  it('retries a rollback bypass against the rollback endpoint with ?ignorePolicy=true', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 200 })); // rollback OK
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response('content', { status: 200 })); // content reload
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ exists: true }), { status: 200 })); // backup info
    const { result } = setup({
      overlay: { policyBlock: { stackName: 'web', stackFile: 'web.yml', action: 'rollback', payload, nodeId: 1 } as never },
    });
    await result.current.bypassPolicyAndRetry();
    const urls = vi.mocked(apiFetch).mock.calls.map(c => String(c[0]));
    expect(urls).toContain('/stacks/web.yml/rollback?ignorePolicy=true');
  });

  it('blocks the bypass when the policy block was captured for another node, even once it is fully hydrated', async () => {
    vi.mocked(apiFetch).mockReset();
    const { result, stackListState, rerender, activeNodeHolder } = setup({
      overlay: { policyBlock: { stackName: 'web', stackFile: 'web.yml', action: 'update', payload, nodeId: 1 } as never },
    });
    // The block was raised on node 1; the operator switches to node 2, which
    // finishes hydrating (readiness true for node 2).
    activeNodeHolder.current = { id: 2, type: 'remote' } as ActiveNode;
    rerender();
    vi.mocked(stackListState.hydrationReady).mockReturnValue(true);
    await result.current.bypassPolicyAndRetry();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('retries on the policy block node when it is still the active node', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 200 })); // update OK
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response('[]', { status: 200 })); // containers refresh
    const { result } = setup({
      overlay: { policyBlock: { stackName: 'web', stackFile: 'web.yml', action: 'update', payload, nodeId: 1 } as never },
    });
    await result.current.bypassPolicyAndRetry();
    const updateCall = vi.mocked(apiFetch).mock.calls.find(c => String(c[0]).includes('/update?ignorePolicy=true'));
    expect(updateCall).toBeDefined();
    expect((updateCall![1] as { nodeId?: number | null }).nodeId).toBe(1);
  });

  it('does nothing when no policy block is stored', async () => {
    const { result } = setup({ overlay: { policyBlock: null as never } });
    await result.current.bypassPolicyAndRetry();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('useStackActions.attemptLeaveEditor (mobile back / nav guard)', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('stashes the navigation when the editor is dirty instead of running it', () => {
    const perform = vi.fn();
    // Default fixture: content !== originalContent and a stack is selected → dirty.
    const { result, overlayState } = setup();
    result.current.attemptLeaveEditor(perform);
    expect(perform).not.toHaveBeenCalled();
    expect(overlayState.setPendingLeaveAction).toHaveBeenCalledWith({ run: perform });
  });

  it('runs the navigation immediately when the editor is clean', () => {
    const perform = vi.fn();
    const { result, overlayState } = setup({
      editorState: { content: 'same', originalContent: 'same' },
    });
    result.current.attemptLeaveEditor(perform);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(overlayState.setPendingLeaveAction).not.toHaveBeenCalled();
  });

  it('runs the stashed leave action and clears it on discardAndLoadPending', () => {
    const run = vi.fn();
    const { result, overlayState, editorState } = setup({ overlay: { pendingLeaveAction: { run } } });
    result.current.discardAndLoadPending();
    expect(run).toHaveBeenCalledTimes(1);
    expect(overlayState.setPendingLeaveAction).toHaveBeenCalledWith(null);
    expect(editorState.setContent).toHaveBeenCalledWith(editorState.originalContent);
  });

  it('gives a stashed leave action precedence over a coexisting pending load', () => {
    const run = vi.fn();
    const { result } = setup({ overlay: { pendingLeaveAction: { run }, pendingUnsavedLoad: 'other.yml' } });
    result.current.discardAndLoadPending();
    expect(run).toHaveBeenCalledTimes(1);
    // The leave branch returns before the load branch, so no stack fetch fires.
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('clears a stashed leave action on cancel', () => {
    const { result, overlayState } = setup({ overlay: { pendingLeaveAction: { run: vi.fn() } } });
    result.current.cancelPendingUnsavedLoad();
    expect(overlayState.setPendingLeaveAction).toHaveBeenCalledWith(null);
    expect(overlayState.setPendingLoadOptions).toHaveBeenCalledWith(null);
  });
});

describe('useStackActions open/close compose editor', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('openComposeEditor sets editingCompose, compose tab, and isEditing when permitted', () => {
    const { result, editorState } = setup();
    result.current.openComposeEditor();
    expect(editorState.setEditingCompose).toHaveBeenCalledWith(true);
    expect(editorState.setActiveTab).toHaveBeenCalledWith('compose');
    expect(editorState.setIsEditing).toHaveBeenCalledWith(true);
  });

  it('openComposeEditor is a no-op when canEditStack returns false', () => {
    const { result, editorState } = setup({ canEditStack: () => false });
    result.current.openComposeEditor();
    expect(editorState.setEditingCompose).not.toHaveBeenCalled();
  });

  it('closeComposeEditor reverts both buffers when .env is dirty and compose tab is active', () => {
    const { result, editorState } = setup({
      editorState: {
        activeTab: 'compose',
        content: 'compose-clean',
        originalContent: 'compose-clean',
        envContent: 'env-dirty',
        originalEnvContent: 'env-clean',
      },
    });
    result.current.closeComposeEditor();
    expect(editorState.setContent).toHaveBeenCalledWith('compose-clean');
    expect(editorState.setEnvContent).toHaveBeenCalledWith('env-clean');
    expect(editorState.setEditingCompose).toHaveBeenCalledWith(false);
  });

  it('closeComposeEditor reverts both buffers when compose is dirty and files tab is active', () => {
    const { result, editorState } = setup({
      editorState: {
        activeTab: 'files',
        content: 'compose-dirty',
        originalContent: 'compose-clean',
        envContent: 'env-clean',
        originalEnvContent: 'env-clean',
      },
    });
    result.current.closeComposeEditor();
    expect(editorState.setContent).toHaveBeenCalledWith('compose-clean');
    expect(editorState.setEnvContent).toHaveBeenCalledWith('env-clean');
    expect(editorState.setEditingCompose).toHaveBeenCalledWith(false);
  });
});

describe('useStackActions loadFile startInComposeEdit + pending options', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('defers a dirty load and stores pendingLoadOptions', async () => {
    const { result, overlayState } = setup({
      editorState: { content: 'dirty', originalContent: 'clean' },
      stackList: { selectedFile: 'web.yml' },
    });
    await result.current.loadFile('new.yml', { startInComposeEdit: true });
    expect(overlayState.setPendingUnsavedLoad).toHaveBeenCalledWith('new.yml');
    expect(overlayState.setPendingLoadOptions).toHaveBeenCalledWith({ startInComposeEdit: true });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('opens compose edit after load when startInComposeEdit and canEditStack(target) both pass', async () => {
    const canEditStack = vi.fn((id: string) => id === 'target.yml' || id === 'target');
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      const u = String(url);
      if (u === '/stacks/target.yml') return Promise.resolve(new Response('services: {}', { status: 200 }));
      if (u.includes('/envs')) return Promise.resolve(new Response(JSON.stringify({ envFiles: [] }), { status: 200 }));
      if (u.includes('/containers')) return Promise.resolve(new Response('[]', { status: 200 }));
      if (u.includes('/backup')) return Promise.resolve(new Response(JSON.stringify({ exists: false }), { status: 200 }));
      return Promise.resolve(new Response('', { status: 404 }));
    });
    const { result, editorState } = setup({
      editorState: { content: 'same', originalContent: 'same' },
      stackList: { selectedFile: null },
      canEditStack,
    });
    await result.current.loadFile('target.yml', { startInComposeEdit: true });
    expect(canEditStack).toHaveBeenCalledWith('target.yml');
    expect(editorState.setEditingCompose).toHaveBeenCalledWith(true);
    expect(editorState.setIsEditing).toHaveBeenCalledWith(true);
  });

  it('does not auto-edit when canEditStack rejects the loaded target', async () => {
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      const u = String(url);
      if (u === '/stacks/target.yml') return Promise.resolve(new Response('services: {}', { status: 200 }));
      if (u.includes('/envs')) return Promise.resolve(new Response(JSON.stringify({ envFiles: [] }), { status: 200 }));
      if (u.includes('/containers')) return Promise.resolve(new Response('[]', { status: 200 }));
      if (u.includes('/backup')) return Promise.resolve(new Response(JSON.stringify({ exists: false }), { status: 200 }));
      return Promise.resolve(new Response('', { status: 404 }));
    });
    const { result, editorState } = setup({
      editorState: { content: 'same', originalContent: 'same' },
      stackList: { selectedFile: null },
      canEditStack: () => false,
    });
    await result.current.loadFile('target.yml', { startInComposeEdit: true });
    // loadFile always clears editingCompose at start; never re-opens.
    expect(editorState.setEditingCompose).toHaveBeenCalledWith(false);
    expect(editorState.setEditingCompose).not.toHaveBeenCalledWith(true);
  });

  it('forwards pendingLoadOptions through discardAndLoadPending for a dirty stack', async () => {
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      const u = String(url);
      if (u === '/stacks/other.yml') return Promise.resolve(new Response('services: {}', { status: 200 }));
      if (u.includes('/envs')) return Promise.resolve(new Response(JSON.stringify({ envFiles: [] }), { status: 200 }));
      if (u.includes('/containers')) return Promise.resolve(new Response('[]', { status: 200 }));
      if (u.includes('/backup')) return Promise.resolve(new Response(JSON.stringify({ exists: false }), { status: 200 }));
      return Promise.resolve(new Response('', { status: 404 }));
    });
    // Buffers stay dirty in the mock (setContent does not update content), so
    // discardAndLoadPending must resume with skipUnsavedCheck or loadFile
    // would re-defer.
    const { result, editorState, overlayState } = setup({
      editorState: { content: 'dirty', originalContent: 'clean', envContent: '', originalEnvContent: '' },
      overlay: {
        pendingUnsavedLoad: 'other.yml',
        pendingLoadOptions: { startInComposeEdit: true },
      },
      stackList: { selectedFile: 'web.yml' },
    });
    result.current.discardAndLoadPending();
    await vi.waitFor(() => {
      expect(editorState.setEditingCompose).toHaveBeenCalledWith(true);
    });
    // Must not re-stash the pending load.
    expect(overlayState.setPendingUnsavedLoad).toHaveBeenCalledWith(null);
    expect(overlayState.setPendingUnsavedLoad).not.toHaveBeenCalledWith('other.yml');
  });

  it('node-switch pending load sets active node and never calls loadFile with the token', async () => {
    const setActiveNode = vi.fn();
    const targetNode = { id: 9, type: 'remote' } as Parameters<typeof useStackActions>[0]['activeNode'];
    const { result } = setup({
      overlay: {
        pendingUnsavedLoad: '__node-switch-pending__',
        pendingUnsavedNode: targetNode as never,
        pendingLoadOptions: { startInComposeEdit: true },
      },
      setActiveNode,
    });
    result.current.discardAndLoadPending();
    expect(setActiveNode).toHaveBeenCalledWith(targetNode);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('loadFileOnNode defers with options when dirty', async () => {
    const node = { id: 2, type: 'remote' } as Parameters<typeof useStackActions>[0]['activeNode'];
    const { result, overlayState } = setup({
      editorState: { content: 'dirty', originalContent: 'clean' },
      stackList: { selectedFile: 'web.yml' },
    });
    await result.current.loadFileOnNode(node!, 'other.yml', { startInComposeEdit: true });
    expect(overlayState.setPendingUnsavedNode).toHaveBeenCalledWith(node);
    expect(overlayState.setPendingUnsavedLoad).toHaveBeenCalledWith('other.yml');
    expect(overlayState.setPendingLoadOptions).toHaveBeenCalledWith({ startInComposeEdit: true });
  });
});

describe('useStackActions update readiness routing', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  function routeUpdateOk() {
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/update')) return Promise.resolve(new Response('', { status: 200 }));
      return Promise.resolve(new Response('[]', { status: 200 }));
    });
  }

  it('opens the readiness dialog instead of posting when the node has update-guard', async () => {
    routeUpdateOk();
    const { result, overlayState } = setup({ hasUpdateGuard: true });
    await act(async () => { await result.current.updateStack(); });
    expect(overlayState.setUpdateReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: 'web', stackFile: 'web.yml' }),
    );
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('routes a sidebar/context-menu update through the readiness dialog too', async () => {
    routeUpdateOk();
    const { result, overlayState } = setup({ hasUpdateGuard: true });
    await act(async () => { await result.current.executeStackActionByFile('web.yml', 'update', 'update'); });
    expect(overlayState.setUpdateReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: 'web', stackFile: 'web.yml' }),
    );
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('runs the shared update executor when the dialog proceeds', async () => {
    routeUpdateOk();
    const { result, overlayState, stackListState } = setup({ hasUpdateGuard: true });
    await act(async () => { await result.current.updateStack(); });
    const pending = vi.mocked(overlayState.setUpdateReadiness).mock.calls[0][0] as
      { stackName: string; stackFile: string; proceed: () => void };
    expect(pending).not.toBeNull();
    await act(async () => { pending.proceed(); });
    expect(overlayState.setUpdateReadiness).toHaveBeenLastCalledWith(null);
    const urls = vi.mocked(apiFetch).mock.calls.map(c => String(c[0]));
    expect(urls).toContain('/stacks/web/update');
    expect(stackListState.recordActionSuccess).toHaveBeenCalledWith('web.yml');
  });

  it('does nothing while the stack is busy, with or without the dialog', async () => {
    routeUpdateOk();
    const { result, overlayState } = setup({
      hasUpdateGuard: true,
      stackList: { isStackBusy: vi.fn().mockReturnValue(true) as never },
    });
    await act(async () => { await result.current.updateStack(); });
    expect(overlayState.setUpdateReadiness).not.toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('updates directly without the capability, from both entry points', async () => {
    routeUpdateOk();
    const { result, overlayState } = setup();
    await act(async () => { await result.current.updateStack(); });
    await act(async () => { await result.current.executeStackActionByFile('web.yml', 'update', 'update'); });
    expect(overlayState.setUpdateReadiness).not.toHaveBeenCalled();
    const updatePosts = vi.mocked(apiFetch).mock.calls.filter(c => String(c[0]) === '/stacks/web/update');
    expect(updatePosts).toHaveLength(2);
  });
});

describe('useStackActions recovery records', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  // Route every apiFetch by URL so the failure paths (which also refetch
  // /containers) get sensible responses.
  function routeApi(updateStatus: number, body = '{"error":"boom"}') {
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/update') || u.includes('/deploy') || u.includes('/restart')) {
        return Promise.resolve(new Response(body, { status: updateStatus }));
      }
      if (u.includes('/containers')) return Promise.resolve(new Response('[]', { status: 200 }));
      if (u.includes('/backup')) return Promise.resolve(new Response('{"exists":false,"timestamp":null}', { status: 200 }));
      return Promise.resolve(new Response('[]', { status: 200 }));
    });
  }

  it('records a failure and refetches containers when an update fails', async () => {
    routeApi(500);
    const { result, stackListState, editorState } = setup();
    await act(async () => { await result.current.updateStack(); });
    expect(stackListState.recordActionFailure).toHaveBeenCalledWith(
      'web.yml',
      expect.objectContaining({ action: 'update', errorMessage: 'boom', rolledBack: false }),
    );
    expect(editorState.setContainers).toHaveBeenCalled();
    expect(stackListState.recordActionSuccess).not.toHaveBeenCalled();
  });

  it('clears the record on a successful update', async () => {
    routeApi(200, '');
    const { result, stackListState } = setup();
    await act(async () => { await result.current.updateStack(); });
    expect(stackListState.recordActionSuccess).toHaveBeenCalledWith('web.yml');
    expect(stackListState.recordActionFailure).not.toHaveBeenCalled();
  });

  it('toasts recheckWarning from a successful update response body', async () => {
    const warning = 'Digest still detected after update.';
    routeApi(200, JSON.stringify({ status: 'Update completed', healthGateId: 'gate-1', recheckWarning: warning }));
    const { result } = setup();
    await act(async () => { await result.current.updateStack(); });
    expect(toast.info).toHaveBeenCalledWith('Stack updated. Verifying health...');
    expect(toast.info).toHaveBeenCalledWith(warning);
  });

  it('does not record a failure for a stack-op-in-progress 409', async () => {
    const inProgress = JSON.stringify({
      code: 'stack_op_in_progress',
      inProgress: { action: 'update', startedAt: 1, user: 'someone' },
    });
    vi.mocked(apiFetch).mockResolvedValue(new Response(inProgress, { status: 409 }));
    const { result, stackListState } = setup();
    await act(async () => { await result.current.updateStack(); });
    expect(stackListState.recordActionFailure).not.toHaveBeenCalled();
  });

  it('stores the deploy-feedback last line only for the matching stack', async () => {
    routeApi(500);
    const getLastDeployOutputLine = (stackName: string) =>
      stackName === 'web' ? 'pulling app ...' : undefined;
    const { result, stackListState } = setup({ getLastDeployOutputLine });
    await act(async () => { await result.current.updateStack(); });
    expect(stackListState.recordActionFailure).toHaveBeenCalledWith(
      'web.yml',
      expect.objectContaining({ lastOutputLine: 'pulling app ...' }),
    );
  });

  it('does not record a recovery panel for a failed stop (not recoverable)', async () => {
    routeApi(500);
    const { result, stackListState } = setup();
    await act(async () => { await result.current.stopStack(); });
    expect(stackListState.recordActionFailure).not.toHaveBeenCalled();
  });

  it('records a deploy failure and carries the rolledBack flag', async () => {
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/deploy')) {
        return Promise.resolve(new Response('{"error":"crash","rolledBack":true}', { status: 500 }));
      }
      if (u.includes('/containers')) return Promise.resolve(new Response('[]', { status: 200 }));
      return Promise.resolve(new Response('[]', { status: 200 }));
    });
    const { result, stackListState } = setup();
    await act(async () => {
      await result.current.deployStack({ preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.MouseEvent);
    });
    expect(stackListState.recordActionFailure).toHaveBeenCalledWith(
      'web.yml',
      expect.objectContaining({ action: 'deploy', rolledBack: true, errorMessage: 'crash' }),
    );
  });

  it('carries the server failure classification into the recovery record', async () => {
    const body = JSON.stringify({
      error: 'port is already allocated',
      rolledBack: false,
      failure: { reason: 'port_conflict', label: 'Host port conflict', suggestion: 'Free the port, then retry.' },
    });
    routeApi(500, body);
    const { result, stackListState } = setup();
    await act(async () => { await result.current.updateStack(); });
    expect(stackListState.recordActionFailure).toHaveBeenCalledWith(
      'web.yml',
      expect.objectContaining({
        failure: { reason: 'port_conflict', label: 'Host port conflict', suggestion: 'Free the port, then retry.' },
      }),
    );
  });

  it('ignores a malformed failure field in the response body', async () => {
    routeApi(500, JSON.stringify({ error: 'boom', failure: { reason: 42 } }));
    const { result, stackListState } = setup();
    await act(async () => { await result.current.updateStack(); });
    expect(stackListState.recordActionFailure).toHaveBeenCalledWith(
      'web.yml',
      expect.objectContaining({ failure: undefined }),
    );
  });

  it('synthesizes a node_unreachable classification for a gateway 502 with no body', async () => {
    routeApi(502, 'Bad Gateway');
    const { result, stackListState } = setup();
    await act(async () => { await result.current.updateStack(); });
    expect(stackListState.recordActionFailure).toHaveBeenCalledWith(
      'web.yml',
      expect.objectContaining({
        failure: expect.objectContaining({ reason: 'node_unreachable' }),
      }),
    );
  });

  it('does not mislabel an unrelated JSON 503 as node_unreachable', async () => {
    routeApi(503, JSON.stringify({ error: 'maintenance window' }));
    const { result, stackListState } = setup();
    await act(async () => { await result.current.updateStack(); });
    expect(stackListState.recordActionFailure).toHaveBeenCalledWith(
      'web.yml',
      expect.objectContaining({ failure: undefined }),
    );
  });

  it('synthesizes node_unreachable for a docker_unavailable 503 without a classified body', async () => {
    routeApi(503, JSON.stringify({ error: 'daemon gone', code: 'docker_unavailable' }));
    const { result, stackListState } = setup();
    await act(async () => { await result.current.updateStack(); });
    expect(stackListState.recordActionFailure).toHaveBeenCalledWith(
      'web.yml',
      expect.objectContaining({
        failure: expect.objectContaining({ reason: 'node_unreachable' }),
      }),
    );
  });

  it('records a rollback failure', async () => {
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/rollback')) return Promise.resolve(new Response('{"error":"no backup"}', { status: 500 }));
      if (u.includes('/containers')) return Promise.resolve(new Response('[]', { status: 200 }));
      return Promise.resolve(new Response('[]', { status: 200 }));
    });
    const { result, stackListState } = setup();
    await act(async () => { await result.current.rollbackStack(); });
    expect(stackListState.recordActionFailure).toHaveBeenCalledWith(
      'web.yml',
      expect.objectContaining({ action: 'rollback', rolledBack: false, errorMessage: 'no backup' }),
    );
  });

  it('does not record a failure when only the post-rollback refetch fails', async () => {
    let rolledBack = false;
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/rollback')) { rolledBack = true; return Promise.resolve(new Response(null, { status: 200 })); }
      // After a successful rollback, the cosmetic content refetch throws.
      if (rolledBack && u.endsWith('/stacks/web.yml')) return Promise.reject(new Error('network blip'));
      return Promise.resolve(new Response('[]', { status: 200 }));
    });
    const { result, stackListState } = setup();
    await act(async () => { await result.current.rollbackStack(); });
    expect(stackListState.recordActionSuccess).toHaveBeenCalledWith('web.yml');
    expect(stackListState.recordActionFailure).not.toHaveBeenCalled();
  });

  it('refreshes containers after a successful rollback (rollback redeploys)', async () => {
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/rollback')) return Promise.resolve(new Response(null, { status: 200 }));
      if (u.includes('/containers')) {
        return Promise.resolve(new Response('[{"Id":"c1","Names":["/web"],"State":"running"}]', { status: 200 }));
      }
      return Promise.resolve(new Response('', { status: 200 }));
    });
    const { result, stackListState, editorState } = setup();
    await act(async () => { await result.current.rollbackStack(); });
    expect(stackListState.recordActionSuccess).toHaveBeenCalledWith('web.yml');
    expect(editorState.setContainers).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ Id: 'c1' })]),
    );
    expect(stackListState.recordActionFailure).not.toHaveBeenCalled();
  });

  it('does not record a rollback failure when the post-rollback container refresh fails', async () => {
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/rollback')) return Promise.resolve(new Response(null, { status: 200 }));
      if (u.includes('/containers')) return Promise.reject(new Error('network blip'));
      return Promise.resolve(new Response('', { status: 200 }));
    });
    const { result, stackListState } = setup();
    await act(async () => { await result.current.rollbackStack(); });
    expect(stackListState.recordActionSuccess).toHaveBeenCalledWith('web.yml');
    expect(stackListState.recordActionFailure).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Stack rolled back from recovery generation.');
  });

  it('toasts the backend generation rollback message', async () => {
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/rollback')) {
        return Promise.resolve(new Response(
          JSON.stringify({ message: 'Restored generation gen-1.', recoveryId: 'gen-1' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
      }
      return Promise.resolve(new Response('[]', { status: 200 }));
    });
    const { result } = setup();
    await act(async () => { await result.current.rollbackStack(); });
    expect(toast.success).toHaveBeenCalledWith('Restored generation gen-1.');
  });
});

describe('useStackActions.getStackMenuVisibility', () => {
  it('gives a partial stack the running-stack lifecycle actions', () => {
    const { result } = setup({ stackList: { stackStatuses: { 'web.yml': 'partial' } as never } });
    expect(result.current.getStackMenuVisibility('web.yml')).toEqual({
      showDeploy: false, showStop: true, showRestart: true, showUpdate: true, showTakeDown: true,
    });
  });

  it('offers Take down for a running non-self stack', () => {
    const { result } = setup({ stackList: { stackStatuses: { 'web.yml': 'running' } as never } });
    expect(result.current.getStackMenuVisibility('web.yml')).toEqual({
      showDeploy: false, showStop: true, showRestart: true, showUpdate: true, showTakeDown: true,
    });
  });

  it('shows deploy (not stop/restart/update) for an exited stack', () => {
    const { result } = setup({ stackList: { stackStatuses: { 'web.yml': 'exited' } as never } });
    expect(result.current.getStackMenuVisibility('web.yml')).toEqual({
      showDeploy: true, showStop: false, showRestart: false, showUpdate: false, showTakeDown: true,
    });
  });

  it('hides guarded lifecycle actions for the self stack but keeps restart', () => {
    const { result } = setup({
      stackList: {
        stackStatuses: { 'sencho.yml': 'running' } as never,
        stackSelfFlags: { 'sencho.yml': true },
      },
    });
    expect(result.current.getStackMenuVisibility('sencho.yml')).toEqual({
      showDeploy: false, showStop: false, showRestart: true, showUpdate: false, showTakeDown: false,
    });
  });

  it('opens the self-stack modal instead of calling update on a protected stack', async () => {
    const { result, overlayState, stackListState } = setup({
      stackList: {
        selectedFile: 'sencho.yml',
        stackSelfFlags: { 'sencho.yml': true },
      },
    });
    await act(async () => { await result.current.updateStack(); });
    expect(overlayState.openSelfStackProtected).toHaveBeenCalled();
    expect(stackListState.setStackAction).not.toHaveBeenCalled();
  });

  it('opens reapply capture for eligible admin Save & Deploy on self-stack without posting deploy', async () => {
    vi.mocked(apiFetch).mockReset();
    const { result, overlayState } = setup({
      isAdmin: true,
      canReapplyCompose: true,
      activeNode: { id: 7, name: 'Gateway', type: 'local' } as Parameters<typeof useStackActions>[0]['activeNode'],
      stackList: {
        selectedFile: 'sencho.yml',
        stackSelfFlags: { 'sencho.yml': true },
      },
    });
    await act(async () => { await result.current.deployStack({ preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.MouseEvent); });
    expect(overlayState.setComposeReapplyCapture).toHaveBeenCalledWith({
      nodeId: 7,
      nodeType: 'local',
      nodeName: 'Gateway',
      stackFile: 'sencho.yml',
    });
    expect(overlayState.openSelfStackProtected).not.toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('does not open reapply capture for ordinary stacks when canReapplyCompose is true', async () => {
    // Node eligibility alone must not retarget ordinary stacks; isSelfStackFile gates capture.
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ hasIssues: false }), { status: 200 }));
    const { result, overlayState, stackListState } = setup({
      isAdmin: true,
      canReapplyCompose: true,
      activeNode: { id: 7, name: 'Gateway', type: 'local' } as Parameters<typeof useStackActions>[0]['activeNode'],
      stackList: {
        selectedFile: 'web.yml',
        stackSelfFlags: { 'web.yml': false },
      },
    });
    await act(async () => {
      await result.current.deployStack({ preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.MouseEvent);
    });
    expect(overlayState.setComposeReapplyCapture).not.toHaveBeenCalled();
    expect(overlayState.openSelfStackProtected).not.toHaveBeenCalled();
    expect(stackListState.setStackAction).toHaveBeenCalled();
  });

  it('opens protected dialog for self-stack deploy when reapply is not eligible', async () => {
    const { result, overlayState } = setup({
      isAdmin: true,
      canReapplyCompose: false,
      stackList: {
        selectedFile: 'sencho.yml',
        stackSelfFlags: { 'sencho.yml': true },
      },
    });
    await act(async () => { await result.current.deployStack({ preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.MouseEvent); });
    expect(overlayState.openSelfStackProtected).toHaveBeenCalled();
    expect(overlayState.setComposeReapplyCapture).not.toHaveBeenCalled();
  });

  it('opens protected dialog for non-admin even when canReapplyCompose is true', async () => {
    const { result, overlayState } = setup({
      isAdmin: false,
      canReapplyCompose: true,
      stackList: {
        selectedFile: 'sencho.yml',
        stackSelfFlags: { 'sencho.yml': true },
      },
    });
    await act(async () => { await result.current.deployStack({ preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as React.MouseEvent); });
    expect(overlayState.openSelfStackProtected).toHaveBeenCalled();
    expect(overlayState.setComposeReapplyCapture).not.toHaveBeenCalled();
  });

  it('cancels open reapply capture when the active node changes', async () => {
    const setComposeReapplyCapture = vi.fn();
    const activeNodeA = { id: 1, name: 'A', type: 'local' as const };
    const { rerender } = renderHook(
      ({ activeNode }: { activeNode: typeof activeNodeA }) =>
        useStackActions({
          editorState: makeEditorState(),
          stackListState: makeStackListState({
            selectedFile: 'sencho.yml',
            stackSelfFlags: { 'sencho.yml': true },
          }),
          navState: { activeView: 'editor', setActiveView: vi.fn() } as unknown as NavState,
          overlayState: makeOverlay({
            composeReapplyCapture: {
              nodeId: 1,
              nodeType: 'local',
              nodeName: 'A',
              stackFile: 'sencho.yml',
            },
            setComposeReapplyCapture,
          }),
          activeNode: activeNode as unknown as Parameters<typeof useStackActions>[0]['activeNode'],
          setActiveNode: vi.fn(),
          nodes: [],
          runWithLog,
          getLastDeployOutputLine: () => undefined,
          diffPreviewEnabled: false,
          canEditStack: () => true,
          onDeletedOpenStack: vi.fn(),
          isAdmin: true,
          canReapplyCompose: true,
        }),
      { initialProps: { activeNode: activeNodeA } },
    );
    rerender({ activeNode: { id: 2, name: 'B', type: 'local' as const } });
    expect(setComposeReapplyCapture).toHaveBeenCalledWith(null);
  });

  it('cancels open reapply capture when the selected stack changes', async () => {
    const setComposeReapplyCapture = vi.fn();
    const { rerender } = renderHook(
      ({ selectedFile }: { selectedFile: string }) =>
        useStackActions({
          editorState: makeEditorState(),
          stackListState: makeStackListState({
            selectedFile,
            stackSelfFlags: { 'sencho.yml': true, 'other.yml': true },
          }),
          navState: { activeView: 'editor', setActiveView: vi.fn() } as unknown as NavState,
          overlayState: makeOverlay({
            composeReapplyCapture: {
              nodeId: 1,
              nodeType: 'local',
              nodeName: 'A',
              stackFile: 'sencho.yml',
            },
            setComposeReapplyCapture,
          }),
          activeNode: { id: 1, name: 'A', type: 'local' } as unknown as Parameters<typeof useStackActions>[0]['activeNode'],
          setActiveNode: vi.fn(),
          nodes: [],
          runWithLog,
          getLastDeployOutputLine: () => undefined,
          diffPreviewEnabled: false,
          canEditStack: () => true,
          onDeletedOpenStack: vi.fn(),
          isAdmin: true,
          canReapplyCompose: true,
        }),
      { initialProps: { selectedFile: 'sencho.yml' } },
    );
    rerender({ selectedFile: 'other.yml' });
    expect(setComposeReapplyCapture).toHaveBeenCalledWith(null);
  });

  it('opens the self-stack modal instead of calling rollback on a protected stack', async () => {
    vi.mocked(apiFetch).mockReset();
    const { result, overlayState, stackListState } = setup({
      stackList: {
        selectedFile: 'sencho.yml',
        stackSelfFlags: { 'sencho.yml': true },
      },
    });
    await act(async () => { await result.current.rollbackStack(); });
    expect(overlayState.openSelfStackProtected).toHaveBeenCalled();
    expect(stackListState.setStackAction).not.toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('opens the self-stack modal for rollback 409 fallback', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ code: 'self_stack_protected' }), { status: 409 }));
    const { result, overlayState, stackListState } = setup();
    await act(async () => { await result.current.rollbackStack(); });
    expect(overlayState.openSelfStackProtected).toHaveBeenCalled();
    expect(stackListState.recordActionFailure).not.toHaveBeenCalled();
  });

  it('opens the self-stack modal instead of calling service stop on a protected stack', async () => {
    vi.mocked(apiFetch).mockReset();
    const { result, overlayState } = setup({
      stackList: {
        selectedFile: 'sencho.yml',
        stackSelfFlags: { 'sencho.yml': true },
      },
    });
    await act(async () => { await result.current.serviceAction('stop', 'web'); });
    expect(overlayState.openSelfStackProtected).toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('opens the self-stack modal for service stop 409 fallback', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ code: 'self_stack_protected' }), { status: 409 }));
    const { result, overlayState } = setup();
    await act(async () => { await result.current.serviceAction('stop', 'web'); });
    expect(overlayState.openSelfStackProtected).toHaveBeenCalled();
  });
});

describe('useStackActions.openStackApp', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  function openAndCaptureHref(over: Parameters<typeof setup>[0]): {
    href: string | undefined;
    clickCount: number;
  } {
    let href: string | undefined;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        href = this.href;
      });
    try {
      const { result } = setup(over);
      result.current.openStackApp('web.yml');
      return { href, clickCount: click.mock.calls.length };
    } finally {
      click.mockRestore();
    }
  }

  it('opens the published port on the browser host for a local node', () => {
    const { href } = openAndCaptureHref({ stackList: { stackPorts: { 'web.yml': 8989 } } });
    expect(href).toBe('http://localhost:8989/');
  });

  it('opens on the remote node host derived from its api_url', () => {
    const { href } = openAndCaptureHref({
      stackList: { stackPorts: { 'web.yml': 8989 } },
      activeNode: { id: 2, type: 'remote', api_url: 'http://10.0.0.5:1852' } as Parameters<typeof useStackActions>[0]['activeNode'],
    });
    expect(href).toBe('http://10.0.0.5:8989/');
  });

  it('does nothing for a remote node with no api_url (pilot) and does not throw', () => {
    const { href, clickCount } = openAndCaptureHref({
      stackList: { stackPorts: { 'web.yml': 8989 } },
      activeNode: { id: 3, type: 'remote', api_url: '' } as Parameters<typeof useStackActions>[0]['activeNode'],
    });
    expect(clickCount).toBe(0);
    expect(href).toBeUndefined();
  });

  it('appends a known service path via the published port', () => {
    const { href } = openAndCaptureHref({ stackList: { stackPorts: { 'web.yml': 32400 } } });
    expect(href).toBe('http://localhost:32400/web');
  });

  it('does nothing when the stack has no published port', () => {
    const { clickCount } = openAndCaptureHref({});
    expect(clickCount).toBe(0);
  });
});


describe('container fetch contract', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('soft refresh prior empty transitions to error instead of confirmed empty', async () => {
    const setContainersLoadStatus = vi.fn();
    const setContainersLoadError = vi.fn();
    vi.mocked(apiFetch).mockResolvedValue(new Response('fail', { status: 500 }));
    const { result } = setup({
      editorState: {
        containers: [],
        containersLoadStatus: 'success',
        containersLoadError: null,
        setContainersLoadStatus,
        setContainersLoadError,
      } as never,
    });
    let ok: 'ok' | 'skipped' | 'failed' = 'ok';
    await act(async () => {
      ok = await result.current.refreshSelectedContainers('web', 'web.yml');
    });
    expect(ok).toBe('failed');
    expect(setContainersLoadStatus).toHaveBeenCalledWith('error');
    expect(setContainersLoadError).toHaveBeenCalled();
  });

  it('soft refresh preserves prior non-empty containers on failure', async () => {
    const setContainers = vi.fn();
    const prior = [{ Id: 'abc', Names: ['/web'], State: 'running' }];
    vi.mocked(apiFetch).mockResolvedValue(new Response('fail', { status: 500 }));
    const { result } = setup({
      editorState: {
        containers: prior,
        containersLoadStatus: 'success',
        containersLoadError: null,
        setContainers,
      } as never,
    });
    await act(async () => {
      await result.current.refreshSelectedContainers('web', 'web.yml');
    });
    expect(setContainers).not.toHaveBeenCalled();
  });

  it('malformed 200 is not treated as success empty in foreground retry', async () => {
    const setContainersLoadStatus = vi.fn();
    const setContainersLoadError = vi.fn();
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(JSON.stringify({ not: 'an-array' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const { result } = setup({
      editorState: {
        containers: [],
        setContainersLoadStatus,
        setContainersLoadError,
        setContainers: vi.fn(),
      } as never,
    });
    await act(async () => {
      await result.current.retryContainersLoad();
    });
    expect(setContainersLoadStatus).toHaveBeenCalledWith('error');
  });

  it('same-owner soft refreshes: older success does not overwrite newer', async () => {
    const resolvers: Array<(r: Response) => void> = [];
    vi.mocked(apiFetch).mockImplementation((endpoint: unknown) => {
      if (typeof endpoint === 'string' && endpoint.includes('/containers')) {
        return new Promise<Response>((resolve) => { resolvers.push(resolve); });
      }
      return Promise.resolve(new Response('[]', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    const setContainers = vi.fn();
    const setContainersLoadStatus = vi.fn();
    const { result } = setup({
      editorState: {
        containers: [],
        containersLoadStatus: 'success',
        containersLoadError: null,
        setContainers,
        setContainersLoadStatus,
        setContainersLoadError: vi.fn(),
      } as never,
    });

    let olderPromise!: Promise<'ok' | 'skipped' | 'failed'>;
    let newerPromise!: Promise<'ok' | 'skipped' | 'failed'>;
    await act(async () => {
      olderPromise = result.current.refreshSelectedContainers('web', 'web.yml');
    });
    await act(async () => {
      newerPromise = result.current.refreshSelectedContainers('web', 'web.yml');
    });
    expect(resolvers).toHaveLength(2);

    const older = [{ Id: 'old', Names: ['/old'], State: 'running' }];
    const newer = [{ Id: 'new', Names: ['/new'], State: 'running' }];
    const json = (body: unknown) => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    await act(async () => {
      resolvers[1](json(newer));
      await newerPromise;
    });
    expect(setContainers).toHaveBeenLastCalledWith(newer);
    expect(setContainersLoadStatus).toHaveBeenCalledWith('success');

    setContainers.mockClear();
    setContainersLoadStatus.mockClear();
    await act(async () => {
      resolvers[0](json(older));
      await olderPromise;
    });
    expect(setContainers).not.toHaveBeenCalled();
    expect(setContainersLoadStatus).not.toHaveBeenCalled();
  });

  it('deferred response after stack switch does not apply setters', async () => {
    let resolveContainers: ((r: Response) => void) | null = null;
    vi.mocked(apiFetch).mockImplementation((endpoint: unknown) => {
      if (typeof endpoint === 'string' && endpoint.includes('/containers')) {
        return new Promise<Response>((resolve) => { resolveContainers = resolve; });
      }
      return Promise.resolve(new Response('[]', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    const setContainers = vi.fn();
    const setContainersLoadStatus = vi.fn();
    const editorState = makeEditorState({
      containers: [],
      containersLoadStatus: 'success',
      containersLoadError: null,
      setContainers,
      setContainersLoadStatus,
      setContainersLoadError: vi.fn(),
    });
    const { result, rerender } = renderHook(
      ({ selectedFile }) =>
        useStackActions({
          editorState,
          stackListState: makeStackListState({ selectedFile }),
          navState: { setActiveView: vi.fn() } as unknown as NavState,
          overlayState: makeOverlay(),
          activeNode: { id: 1, type: 'local' } as Parameters<typeof useStackActions>[0]['activeNode'],
          setActiveNode: vi.fn(),
          nodes: [],
          runWithLog,
          getLastDeployOutputLine: () => undefined,
          diffPreviewEnabled: false,
          canEditStack: () => true,
          onDeletedOpenStack: vi.fn(),
        }),
      { initialProps: { selectedFile: 'web.yml' as string | null } },
    );

    let refreshPromise!: Promise<'ok' | 'skipped' | 'failed'>;
    await act(async () => {
      refreshPromise = result.current.refreshSelectedContainers('web', 'web.yml');
    });
    expect(resolveContainers).not.toBeNull();

    rerender({ selectedFile: 'api.yml' });
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      resolveContainers?.(new Response(JSON.stringify([{ Id: 'stale', Names: ['/web'], State: 'running' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      await refreshPromise;
    });
    expect(setContainers).not.toHaveBeenCalled();
    expect(setContainersLoadStatus).not.toHaveBeenCalledWith('success');
  });

  it('deferred response after node switch does not apply setters', async () => {
    let resolveContainers: ((r: Response) => void) | null = null;
    vi.mocked(apiFetch).mockImplementation((endpoint: unknown) => {
      if (typeof endpoint === 'string' && endpoint.includes('/containers')) {
        return new Promise<Response>((resolve) => { resolveContainers = resolve; });
      }
      return Promise.resolve(new Response('[]', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    });
    const setContainers = vi.fn();
    const setContainersLoadStatus = vi.fn();
    const editorState = makeEditorState({
      containers: [],
      containersLoadStatus: 'success',
      containersLoadError: null,
      setContainers,
      setContainersLoadStatus,
      setContainersLoadError: vi.fn(),
    });
    type NodeArg = Parameters<typeof useStackActions>[0]['activeNode'];
    const { result, rerender } = renderHook(
      ({ activeNode }) =>
        useStackActions({
          editorState,
          stackListState: makeStackListState({ selectedFile: 'web.yml' }),
          navState: { setActiveView: vi.fn() } as unknown as NavState,
          overlayState: makeOverlay(),
          activeNode,
          setActiveNode: vi.fn(),
          nodes: [],
          runWithLog,
          getLastDeployOutputLine: () => undefined,
          diffPreviewEnabled: false,
          canEditStack: () => true,
          onDeletedOpenStack: vi.fn(),
        }),
      {
        initialProps: {
          activeNode: { id: 1, type: 'local' } as NodeArg,
        },
      },
    );

    let refreshPromise!: Promise<'ok' | 'skipped' | 'failed'>;
    await act(async () => {
      refreshPromise = result.current.refreshSelectedContainers('web', 'web.yml');
    });

    rerender({ activeNode: { id: 2, type: 'remote', api_url: 'http://192.168.1.50:1852' } as NodeArg });
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      resolveContainers?.(new Response(JSON.stringify([{ Id: 'stale', Names: ['/web'], State: 'running' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      await refreshPromise;
    });
    expect(setContainers).not.toHaveBeenCalled();
    expect(setContainersLoadStatus).not.toHaveBeenCalledWith('success');
  });
});

describe('useStackActions.deleteStack', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('leaves the editor for dashboard when deleting the open stack by filename', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status: 200 }));
    const { result, stackListState, overlayState, navState, onDeletedOpenStack } = setup({
      overlay: { deleteTarget: { name: 'web.yml', nodeId: 1 } },
      stackList: { selectedFile: 'web.yml', files: ['web.yml'] },
      navState: { activeView: 'editor' },
    });

    await act(async () => {
      await result.current.deleteStack(false);
    });

    expect(apiFetch).toHaveBeenCalledWith('/stacks/web.yml', { method: 'DELETE', nodeId: 1 });
    expect(stackListState.setSelectedFile).toHaveBeenCalledWith(null);
    expect(navState.setActiveView).toHaveBeenCalledWith('dashboard');
    expect(navState.setActiveView).toHaveBeenCalledTimes(1);
    expect(onDeletedOpenStack).toHaveBeenCalledTimes(1);
    expect(overlayState.closeDeleteDialog).toHaveBeenCalled();
    expect(stackListState.refreshStacks).toHaveBeenCalled();
  });

  it('passes pruneVolumes=true through unconditionally, including on nodes without the capability', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status: 200 }));
    const { result } = setup({
      overlay: { deleteTarget: { name: 'web.yml', nodeId: 1 } },
      stackList: { selectedFile: 'web.yml', files: ['web.yml'] },
      navState: { activeView: 'editor' },
    });

    await act(async () => {
      await result.current.deleteStack(true);
    });

    expect(apiFetch).toHaveBeenCalledWith('/stacks/web.yml?pruneVolumes=true', { method: 'DELETE', nodeId: 1 });
  });

  it('clears isFileLoading on delete-leave so the URL writer is not blocked', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status: 200 }));
    const { result, editorState } = setup({
      overlay: { deleteTarget: { name: 'web.yml', nodeId: 1 } },
      stackList: { selectedFile: 'web.yml', files: ['web.yml'] },
      editorState: { isFileLoading: true },
      navState: { activeView: 'editor' },
    });

    await act(async () => {
      await result.current.deleteStack(false);
    });

    expect(editorState.setIsFileLoading).toHaveBeenCalledWith(false);
  });

  it('leaves the editor when sidebar delete passes a basename', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status: 200 }));
    const { result, stackListState, navState, onDeletedOpenStack } = setup({
      overlay: { deleteTarget: { name: 'web', nodeId: 1 } },
      stackList: { selectedFile: 'web.yml', files: ['web.yml'] },
      navState: { activeView: 'editor' },
    });

    await act(async () => {
      await result.current.deleteStack(false);
    });

    expect(apiFetch).toHaveBeenCalledWith('/stacks/web', { method: 'DELETE', nodeId: 1 });
    expect(stackListState.setSelectedFile).toHaveBeenCalledWith(null);
    expect(navState.setActiveView).toHaveBeenCalledWith('dashboard');
    expect(onDeletedOpenStack).toHaveBeenCalledTimes(1);
  });

  it('does not navigate when deleting a different stack', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status: 200 }));
    const { result, stackListState, navState, onDeletedOpenStack } = setup({
      overlay: { deleteTarget: { name: 'other.yml', nodeId: 1 } },
      stackList: {
        selectedFile: 'web.yml',
        files: ['web.yml', 'other.yml'],
      },
      navState: { activeView: 'editor' },
    });

    await act(async () => {
      await result.current.deleteStack(false);
    });

    expect(stackListState.setSelectedFile).not.toHaveBeenCalledWith(null);
    expect(navState.setActiveView).not.toHaveBeenCalled();
    expect(onDeletedOpenStack).not.toHaveBeenCalled();
    expect(stackListState.refreshStacks).toHaveBeenCalled();
  });

  it('clears selection without navigating when the matching stack is hidden behind another view', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status: 200 }));
    const { result, stackListState, navState, onDeletedOpenStack } = setup({
      overlay: { deleteTarget: { name: 'web.yml', nodeId: 1 } },
      stackList: { selectedFile: 'web.yml', files: ['web.yml'] },
      navState: { activeView: 'resources' },
    });

    await act(async () => {
      await result.current.deleteStack(false);
    });

    expect(stackListState.setSelectedFile).toHaveBeenCalledWith(null);
    expect(navState.setActiveView).not.toHaveBeenCalled();
    expect(onDeletedOpenStack).not.toHaveBeenCalled();
    expect(stackListState.refreshStacks).toHaveBeenCalled();
  });

  it('does not reset or navigate on a non-OK delete response', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('boom', { status: 500 }));
    const { toast } = await import('@/components/ui/toast-store');
    const { result, stackListState, overlayState, navState, onDeletedOpenStack } = setup({
      overlay: { deleteTarget: { name: 'web.yml', nodeId: 1 } },
      stackList: { selectedFile: 'web.yml', files: ['web.yml'] },
      navState: { activeView: 'editor' },
    });

    await act(async () => {
      await result.current.deleteStack(false);
    });

    expect(stackListState.setSelectedFile).not.toHaveBeenCalledWith(null);
    expect(navState.setActiveView).not.toHaveBeenCalled();
    expect(onDeletedOpenStack).not.toHaveBeenCalled();
    expect(overlayState.closeDeleteDialog).not.toHaveBeenCalled();
    expect(stackListState.refreshStacks).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it('surfaces the parsed error message, not the raw JSON body, on a non-OK delete response', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'This node cannot guarantee volumes are preserved on delete.',
          code: 'capability_unavailable',
        }),
        { status: 400 },
      ),
    );
    const { toast } = await import('@/components/ui/toast-store');
    const { result } = setup({
      overlay: { deleteTarget: { name: 'web.yml', nodeId: 1 } },
      stackList: { selectedFile: 'web.yml', files: ['web.yml'] },
      navState: { activeView: 'editor' },
    });

    await act(async () => {
      await result.current.deleteStack(true);
    });

    expect(toast.error).toHaveBeenCalledWith('This node cannot guarantee volumes are preserved on delete.');
  });

  it('does not navigate on a self-stack-protected response', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(JSON.stringify({ code: 'self_stack_protected' }), { status: 409 }),
    );
    const { result, stackListState, overlayState, navState, onDeletedOpenStack } = setup({
      overlay: { deleteTarget: { name: 'web.yml', nodeId: 1 } },
      stackList: { selectedFile: 'web.yml', files: ['web.yml'] },
      navState: { activeView: 'editor' },
    });

    await act(async () => {
      await result.current.deleteStack(false);
    });

    expect(overlayState.openSelfStackProtected).toHaveBeenCalled();
    expect(overlayState.closeDeleteDialog).toHaveBeenCalled();
    expect(stackListState.setSelectedFile).not.toHaveBeenCalledWith(null);
    expect(navState.setActiveView).not.toHaveBeenCalled();
    expect(onDeletedOpenStack).not.toHaveBeenCalled();
    expect(stackListState.refreshStacks).not.toHaveBeenCalled();
  });

  it('calls removeNotificationsForStack with node id and canonical name on success', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status: 200 }));
    const removeNotificationsForStack = vi.fn();
    const { result } = setup({
      overlay: { deleteTarget: { name: 'web.yml', nodeId: 7 } },
      stackList: { selectedFile: 'web.yml', files: ['web.yml'] },
      navState: { activeView: 'editor' },
      activeNode: { id: 7, type: 'local' } as Parameters<typeof useStackActions>[0]['activeNode'],
      removeNotificationsForStack,
    });

    await act(async () => {
      await result.current.deleteStack(false);
    });

    expect(removeNotificationsForStack).toHaveBeenCalledTimes(1);
    expect(removeNotificationsForStack).toHaveBeenCalledWith(7, 'web');
  });

  it('does not call removeNotificationsForStack on a non-OK delete', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('boom', { status: 500 }));
    const removeNotificationsForStack = vi.fn();
    const { result } = setup({
      overlay: { deleteTarget: { name: 'web.yml', nodeId: 1 } },
      stackList: { selectedFile: 'web.yml', files: ['web.yml'] },
      navState: { activeView: 'editor' },
      removeNotificationsForStack,
    });

    await act(async () => {
      await result.current.deleteStack(false);
    });

    expect(removeNotificationsForStack).not.toHaveBeenCalled();
  });
});

describe('useStackActions.openInspectImage', () => {
  it('builds a slim selection from the selected stack and active node', () => {
    const openInspectImage = vi.fn();
    const { result } = setup({
      overlay: { openInspectImage },
      stackList: { selectedFile: 'web.yml' },
      activeNode: { id: 3, name: 'Local', type: 'local' } as ActiveNode,
    });

    act(() => {
      result.current.openInspectImage('sha256:abc', 'nginx:latest');
    });

    expect(openInspectImage).toHaveBeenCalledWith({
      Id: 'sha256:abc',
      RepoTags: ['nginx:latest'],
      usedByStacks: ['web'],
      nodeId: 3,
    });
  });

  it('strips yaml suffix from selectedFile for usedByStacks', () => {
    const openInspectImage = vi.fn();
    const { result } = setup({
      overlay: { openInspectImage },
      stackList: { selectedFile: 'api.yaml' },
    });

    act(() => {
      result.current.openInspectImage('sha256:def', 'redis:7');
    });

    expect(openInspectImage).toHaveBeenCalledWith(expect.objectContaining({
      usedByStacks: ['api'],
      RepoTags: ['redis:7'],
    }));
  });

  it('no-ops when no stack is selected', () => {
    const openInspectImage = vi.fn();
    const { result } = setup({
      overlay: { openInspectImage },
      stackList: { selectedFile: null },
    });

    act(() => {
      result.current.openInspectImage('sha256:abc', 'nginx:latest');
    });

    expect(openInspectImage).not.toHaveBeenCalled();
  });

  it('no-ops when there is no active node', () => {
    const openInspectImage = vi.fn();
    const { result } = setup({
      overlay: { openInspectImage },
      stackList: { selectedFile: 'web.yml' },
      activeNode: null,
    });

    act(() => {
      result.current.openInspectImage('sha256:abc', 'nginx:latest');
    });

    expect(openInspectImage).not.toHaveBeenCalled();
  });
});

describe('useStackActions hydration readiness gates', () => {
  it('fails all lifecycle actions closed while readiness is absent', () => {
    const { result } = setup({ stackList: { hydrationReady: () => false } as never });
    expect(result.current.getStackMenuVisibility('web.yml')).toEqual({
      showDeploy: false, showStop: false, showRestart: false, showUpdate: false, showTakeDown: false,
    });
  });

  it('blocks openStackApp without opening the self-stack modal while readiness is absent', () => {
    const { result, overlayState } = setup({ stackList: { hydrationReady: () => false } as never });
    result.current.openStackApp('web.yml');
    expect(overlayState.openSelfStackProtected).not.toHaveBeenCalled();
  });

  it('blocks restartStack while readiness is absent without starting an operation session', async () => {
    lastRunWithLogParams = null;
    const { result } = setup({ stackList: { hydrationReady: () => false } as never });
    await result.current.restartStack();
    expect(result.current.getStackMenuVisibility('web.yml')).toEqual({
      showDeploy: false, showStop: false, showRestart: false, showUpdate: false, showTakeDown: false,
    });
    // No deploy-feedback session may start while blocked.
    expect(lastRunWithLogParams).toBeNull();
  });

  it('keeps restart available for a confirmed self stack when ready', () => {
    const { result } = setup({
      stackList: {
        stackStatuses: { 'sencho.yml': 'running' } as never,
        stackSelfFlags: { 'sencho.yml': true },
      },
    });
    const v = result.current.getStackMenuVisibility('sencho.yml');
    expect(v.showRestart).toBe(true);
    expect(v.showDeploy).toBe(false);
  });
});

describe('useStackActions deferred readiness-loss guards', () => {
  it('blocks the update-readiness proceed when readiness was lost after the dialog opened', async () => {
    lastRunWithLogParams = null;
    const { result, overlayState, stackListState } = setup({ hasUpdateGuard: true });
    await act(async () => {
      await result.current.updateStack();
    });
    // The mock was invoked with the object form (never the setter form).
    const proceed = (
      vi.mocked(overlayState.setUpdateReadiness).mock.calls[0][0] as { proceed: () => void }
    ).proceed;
    // Readiness lost while the dialog is open (node switch, failed refresh).
    vi.mocked(stackListState.hydrationReady).mockReturnValue(false);
    await act(async () => {
      proceed();
    });
    // No operation session may start against either the current or captured node.
    expect(lastRunWithLogParams).toBeNull();
  });

  it('blocks a deferred service update when readiness was lost after the dialog opened', async () => {
    lastRunWithLogParams = null;
    const { result, overlayState, stackListState } = setup({ hasUpdateGuard: true });
    await act(async () => {
      await result.current.requestServiceUpdate('web.yml', 'web');
    });
    const proceed = (
      vi.mocked(overlayState.setUpdateReadiness).mock.calls[0][0] as { proceed: () => void }
    ).proceed;
    vi.mocked(stackListState.hydrationReady).mockReturnValue(false);
    await act(async () => {
      proceed();
    });
    expect(lastRunWithLogParams).toBeNull();
  });

  it('blocks a deferred stack update captured for node A after the switch to node B is fully hydrated', async () => {
    lastRunWithLogParams = null;
    const { result, overlayState, stackListState, rerender, activeNodeHolder } = setup({ hasUpdateGuard: true });
    await act(async () => {
      await result.current.updateStack();
    });
    const proceed = (
      vi.mocked(overlayState.setUpdateReadiness).mock.calls[0][0] as { proceed: () => void }
    ).proceed;
    // Switch to node B and let it finish hydrating: readiness is true for B,
    // but the captured operation node is still A.
    activeNodeHolder.current = { id: 2, name: 'B', type: 'remote' } as ActiveNode;
    rerender();
    vi.mocked(stackListState.hydrationReady).mockReturnValue(true);
    await act(async () => {
      proceed();
    });
    expect(lastRunWithLogParams).toBeNull();
  });

  it('blocks a deferred service update captured for node A after the switch to node B is fully hydrated', async () => {
    lastRunWithLogParams = null;
    const { result, overlayState, stackListState, rerender, activeNodeHolder } = setup({ hasUpdateGuard: true });
    await act(async () => {
      await result.current.requestServiceUpdate('web.yml', 'web');
    });
    const proceed = (
      vi.mocked(overlayState.setUpdateReadiness).mock.calls[0][0] as { proceed: () => void }
    ).proceed;
    activeNodeHolder.current = { id: 2, name: 'B', type: 'remote' } as ActiveNode;
    rerender();
    vi.mocked(stackListState.hydrationReady).mockReturnValue(true);
    await act(async () => {
      proceed();
    });
    expect(lastRunWithLogParams).toBeNull();
  });

  it('blocks a deferred deploy captured for node A after the switch to node B is fully hydrated', async () => {
    lastRunWithLogParams = null;
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(JSON.stringify({ enabled: true, images: [{}] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const { result, overlayState, stackListState, rerender, activeNodeHolder } = setup();
    await act(async () => {
      await result.current.deployStack();
    });
    // The advisory dialog opened; its proceed is the deferred continuation.
    const proceed = (
      vi.mocked(overlayState.setPreDeployAdvisory).mock.calls[0][0] as { proceed: () => void }
    ).proceed;
    // Switch to node B and let it finish hydrating: readiness is true for B,
    // but the captured operation node is still A.
    activeNodeHolder.current = { id: 2, name: 'B', type: 'remote' } as ActiveNode;
    rerender();
    vi.mocked(stackListState.hydrationReady).mockReturnValue(true);
    await act(async () => {
      proceed();
    });
    expect(lastRunWithLogParams).toBeNull();
  });
});

describe('useStackActions external-network ownership guards', () => {
  function okJson(payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('does not create networks on the captured node from the proactive dialog after a switch', async () => {
    lastRunWithLogParams = null;
    vi.mocked(apiFetch).mockReset();
    const networkPosts: string[] = [];
    vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/security/stacks/web/pre-deploy-summary') {
        return okJson({ enabled: false });
      }
      if (url === '/stacks/web/missing-external-networks') {
        return okJson({
          status: 'ok',
          stackName: 'web',
          networks: [{ name: 'ext-net', safe: false }],
          autoCreateEnabled: false,
          declaredExternalCount: 1,
        });
      }
      if (url === '/system/networks' && init?.method === 'POST') {
        networkPosts.push(url);
        return new Response(null, { status: 201 });
      }
      return new Response(null, { status: 200 });
    });
    const { result, overlayState, stackListState, rerender, activeNodeHolder } = setup({
      hasGuidedExternalNetworkPreflight: true,
    });
    await act(async () => {
      await result.current.deployStack();
    });
    const dialog = (
      vi.mocked(overlayState.setMissingExternalNetworks).mock.calls[0][0] as unknown as {
        createAndContinue: () => Promise<void>;
      }
    );
    // Switch to node B and let it finish hydrating: readiness is true for B,
    // but the dialog was captured for node A.
    activeNodeHolder.current = { id: 2, name: 'B', type: 'remote' } as ActiveNode;
    rerender();
    vi.mocked(stackListState.hydrationReady).mockReturnValue(true);
    await act(async () => {
      await dialog.createAndContinue();
    });
    expect(networkPosts).toEqual([]);
    expect(lastRunWithLogParams).toBeNull();
  });

  it('does not create networks on the captured node from the reactive 409 dialog after a switch', async () => {
    lastRunWithLogParams = null;
    vi.mocked(apiFetch).mockReset();
    const networkPosts: string[] = [];
    vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/security/stacks/web/pre-deploy-summary') {
        return okJson({ enabled: false });
      }
      if (url === '/stacks/web/deploy') {
        // Reactive 409: the backend reports missing external networks.
        return new Response(JSON.stringify({ code: 'missing_external_networks' }), { status: 409 });
      }
      if (url === '/stacks/web/missing-external-networks') {
        return okJson({
          status: 'ok',
          stackName: 'web',
          networks: [{ name: 'ext-net', safe: false }],
          autoCreateEnabled: false,
          declaredExternalCount: 1,
        });
      }
      if (url === '/system/networks' && init?.method === 'POST') {
        networkPosts.push(url);
        return new Response(null, { status: 201 });
      }
      return new Response(null, { status: 200 });
    });
    const { result, overlayState, stackListState, rerender, activeNodeHolder } = setup({
      hasGuidedExternalNetworkPreflight: true,
    });
    await act(async () => {
      await result.current.deployStack();
    });
    const dialog = (
      vi.mocked(overlayState.setMissingExternalNetworks).mock.calls[0][0] as unknown as {
        createAndContinue: () => Promise<void>;
      }
    );
    activeNodeHolder.current = { id: 2, name: 'B', type: 'remote' } as ActiveNode;
    rerender();
    vi.mocked(stackListState.hydrationReady).mockReturnValue(true);
    await act(async () => {
      await dialog.createAndContinue();
    });
    expect(networkPosts).toEqual([]);
    expect(lastRunWithLogParams).toBeNull();
  });
});

describe('useStackActions delete/take-down node-bound confirmations', () => {
  it('blocks delete confirmed for node A after the switch to node B is fully hydrated', async () => {
    vi.mocked(apiFetch).mockReset();
    const { result, stackListState, rerender, activeNodeHolder } = setup({
      overlay: { deleteTarget: { name: 'web.yml', nodeId: 1 } },
      stackList: { selectedFile: 'web.yml', files: ['web.yml'] },
    });
    // The dialog opened on node 1; the operator switched to node 2, which
    // finished hydrating (readiness true for node 2).
    activeNodeHolder.current = { id: 2, type: 'remote' } as ActiveNode;
    rerender();
    vi.mocked(stackListState.hydrationReady).mockReturnValue(true);
    await act(async () => {
      await result.current.deleteStack(false);
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('blocks take down confirmed for node A after the switch to node B is fully hydrated', async () => {
    vi.mocked(apiFetch).mockReset();
    const { result, stackListState, rerender, activeNodeHolder } = setup({
      overlay: { takeDownTarget: { name: 'web.yml', nodeId: 1 } },
      stackList: { selectedFile: 'web.yml', files: ['web.yml'] },
    });
    activeNodeHolder.current = { id: 2, type: 'remote' } as ActiveNode;
    rerender();
    vi.mocked(stackListState.hydrationReady).mockReturnValue(true);
    await act(async () => {
      await result.current.takeDownStack(false);
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('useStackActions reactive external-network retry ownership', () => {
  it('prevents the reactive retry from starting after ownership changes during creation', async () => {
    lastRunWithLogParams = null;
    vi.mocked(apiFetch).mockReset();
    let resolveNetworkCreate: (r: Response) => void;
    const networkCreateGate = new Promise<Response>((r) => { resolveNetworkCreate = r; });
    let missingNetworksCalls = 0;
    const deployCalls: string[] = [];
    vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/security/stacks/web/pre-deploy-summary') {
        return okJson({ enabled: false });
      }
      if (url === '/stacks/web/missing-external-networks') {
        missingNetworksCalls += 1;
        if (missingNetworksCalls === 1) {
          // Proactive preflight: nothing missing, deploy proceeds.
          return okJson({ status: 'ok', stackName: 'web', networks: [], autoCreateEnabled: true, declaredExternalCount: 0 });
        }
        if (missingNetworksCalls === 2) {
          // Reactive refetch after the 409: networks are missing.
          return okJson({ status: 'ok', stackName: 'web', networks: [{ name: 'ext-net', safe: false }], autoCreateEnabled: false, declaredExternalCount: 1 });
        }
        // Post-create verification: everything present.
        return okJson({ status: 'ok', stackName: 'web', networks: [{ name: 'ext-net', safe: true }], autoCreateEnabled: true, declaredExternalCount: 1 });
      }
      if (url === '/stacks/web/deploy') {
        deployCalls.push(url);
        if (deployCalls.length === 1) {
          // The original deploy hits the reactive 409.
          return new Response(JSON.stringify({ code: 'missing_external_networks' }), { status: 409 });
        }
        return new Response(null, { status: 200 });
      }
      if (url === '/system/networks' && init?.method === 'POST') {
        return networkCreateGate;
      }
      return new Response(null, { status: 200 });
    });
    const { result, overlayState, stackListState, rerender, activeNodeHolder } = setup({
      hasGuidedExternalNetworkPreflight: true,
    });
    await act(async () => {
      await result.current.deployStack();
    });
    // The reactive 409 opened the dialog (second missing-networks call).
    expect(missingNetworksCalls).toBe(2);
    const dialog = (
      vi.mocked(overlayState.setMissingExternalNetworks).mock.calls[0][0] as unknown as {
        createAndContinue: () => Promise<void>;
      }
    );
    // Start create-and-continue; the network creation is pending when the
    // operator switches to node B and node B finishes hydrating.
    let createPromise: Promise<void> | undefined;
    await act(async () => {
      createPromise = dialog.createAndContinue();
      await new Promise((r) => setTimeout(r, 0));
    });
    activeNodeHolder.current = { id: 2, type: 'remote' } as ActiveNode;
    rerender();
    vi.mocked(stackListState.hydrationReady).mockReturnValue(true);
    await act(async () => {
      resolveNetworkCreate!(new Response(null, { status: 201 }));
      await createPromise;
    });
    // The create succeeded and reached the guarded retry callback: the retry
    // (a second deploy POST) must NOT start. The single deploy call is the
    // original attempt that hit the 409.
    expect(deployCalls).toHaveLength(1);
  });
});

describe('useStackActions.refreshGitSourcePending', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  function gitSourceRow(stackName: string, revision: unknown, pendingSha: string | null = null) {
    return { stack_name: stackName, pending_commit_sha: pendingSha, gitopsRevision: revision };
  }

  it('records the derived state of each waiting candidate', async () => {
    vi.mocked(apiFetch).mockResolvedValue(okJson([
      gitSourceRow('web', sourceRevision('candidate_ready')),
      gitSourceRow('api', sourceRevision('source_conflict_blocker')),
    ]));
    const { result, editorState } = setup();
    await result.current.refreshGitSourcePending();
    expect(editorState.setGitSourcePendingMap).toHaveBeenCalledWith({
      web: 'candidate_ready',
      api: 'source_conflict_blocker',
    });
  });

  it('skips a stack whose projection has no candidate waiting', async () => {
    // The raw pointer is set, but the model says the candidate is gone. The
    // model wins: this is the conflation the derived read exists to remove.
    vi.mocked(apiFetch).mockResolvedValue(okJson([
      gitSourceRow('web', sourceRevision('source_reconcile_required', { candidateGenerationId: null }), 'a1b2c3d'),
    ]));
    const { result, editorState } = setup();
    await result.current.refreshGitSourcePending();
    expect(editorState.setGitSourcePendingMap).toHaveBeenCalledWith({});
  });

  it('falls back to the raw pointer only when there is no projection to read', async () => {
    vi.mocked(apiFetch).mockResolvedValue(okJson([
      gitSourceRow('web', absentRevision(), 'a1b2c3d'),
      gitSourceRow('api', absentRevision(), null),
    ]));
    const { result, editorState } = setup();
    await result.current.refreshGitSourcePending();
    expect(editorState.setGitSourcePendingMap).toHaveBeenCalledWith({ web: 'candidate_ready' });
  });

  it('keeps reading the rest of the list when a row predates the revision model', async () => {
    // /git-sources is proxied, so an older node answers rows with no
    // projection at all. Throwing on one row would abandon the whole map.
    vi.mocked(apiFetch).mockResolvedValue(okJson([
      { stack_name: 'legacy', pending_commit_sha: 'a1b2c3d' },
      gitSourceRow('web', sourceRevision('candidate_ready')),
    ]));
    const { result, editorState } = setup();
    await result.current.refreshGitSourcePending();
    expect(editorState.setGitSourcePendingMap).toHaveBeenCalledWith({
      legacy: 'candidate_ready',
      web: 'candidate_ready',
    });
  });

  it('does not fabricate a ready candidate when the projection reports a fault', async () => {
    // A fault means an application was expected and could not be read, so the
    // flat pointer is not evidence that anything is ready to apply.
    vi.mocked(apiFetch).mockResolvedValue(okJson([
      gitSourceRow('web', absentRevision([missingApplicationLimitation]), 'a1b2c3d'),
    ]));
    const { result, editorState } = setup();
    await result.current.refreshGitSourcePending();
    expect(editorState.setGitSourcePendingMap).toHaveBeenCalledWith({});
  });

  it('leaves the prior map alone when the request fails', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('boom', { status: 500 }));
    const { result, editorState } = setup();
    await result.current.refreshGitSourcePending();
    expect(editorState.setGitSourcePendingMap).not.toHaveBeenCalled();
  });

  it('leaves the prior map alone when the request throws', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('offline'));
    const { result, editorState } = setup();
    await result.current.refreshGitSourcePending();
    expect(editorState.setGitSourcePendingMap).not.toHaveBeenCalled();
  });
});
