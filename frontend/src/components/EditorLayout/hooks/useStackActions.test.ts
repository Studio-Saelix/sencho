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
import { toast } from '@/components/ui/toast-store';

type EditorState = ReturnType<typeof useEditorViewState>;
type StackListState = ReturnType<typeof useStackListState>;
type NavState = ReturnType<typeof useViewNavigationState>;
type ActiveNode = Parameters<typeof useStackActions>[0]['activeNode'];
const DEFAULT_ACTIVE_NODE = { id: 1, name: 'Local', type: 'local' } as ActiveNode;

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
    stackToDelete: null,
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
  canEditStack?: (stackNameOrFilename: string) => boolean;
  activeNode?: Parameters<typeof useStackActions>[0]['activeNode'];
  setActiveNode?: Parameters<typeof useStackActions>[0]['setActiveNode'];
  onDeletedOpenStack?: () => void;
  removeNotificationsForStack?: (nodeId: number, stackName: string) => void;
  isAdmin?: boolean;
  canReapplyCompose?: boolean;
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

  const { result } = renderHook(() =>
    useStackActions({
      editorState,
      stackListState,
      navState,
      overlayState,
      activeNode: over.activeNode === undefined ? DEFAULT_ACTIVE_NODE : over.activeNode,
      setActiveNode,
      nodes: [],
      runWithLog,
      getLastDeployOutputLine: over.getLastDeployOutputLine ?? (() => undefined),
      diffPreviewEnabled: false,
      hasUpdateGuard: over.hasUpdateGuard ?? false,
      canEditStack: over.canEditStack ?? (() => true),
      onDeletedOpenStack,
      removeNotificationsForStack,
      isAdmin: over.isAdmin ?? false,
      canReapplyCompose: over.canReapplyCompose ?? false,
    }),
  );
  return { result, editorState, stackListState, overlayState, navState, setActiveNode, onDeletedOpenStack, removeNotificationsForStack };
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
      overlay: { policyBlock: { stackName: 'web', stackFile: 'web.yml', action: 'update', payload } as never },
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
      overlay: { policyBlock: { stackName: 'web', stackFile: 'web.yml', action: 'deploy', payload } as never },
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
      overlay: { policyBlock: { stackName: 'web', stackFile: 'web.yml', action: 'rollback', payload } as never },
    });
    await result.current.bypassPolicyAndRetry();
    const urls = vi.mocked(apiFetch).mock.calls.map(c => String(c[0]));
    expect(urls).toContain('/stacks/web.yml/rollback?ignorePolicy=true');
  });

  it('retries on the node captured in the policy block, not the live active node', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(null, { status: 200 })); // update OK
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response('[]', { status: 200 })); // containers refresh
    const { result } = setup({
      activeNode: { id: 1, type: 'local' } as never, // active node has since moved to 1
      overlay: { policyBlock: { stackName: 'web', stackFile: 'web.yml', action: 'update', payload, nodeId: 9 } as never },
    });
    await result.current.bypassPolicyAndRetry();
    const updateCall = vi.mocked(apiFetch).mock.calls.find(c => String(c[0]).includes('/update?ignorePolicy=true'));
    expect(updateCall).toBeDefined();
    expect((updateCall![1] as { nodeId?: number | null }).nodeId).toBe(9);
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
      overlay: { stackToDelete: 'web.yml' },
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
      overlay: { stackToDelete: 'web.yml' },
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
      overlay: { stackToDelete: 'web.yml' },
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
      overlay: { stackToDelete: 'web' },
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
      overlay: { stackToDelete: 'other.yml' },
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
      overlay: { stackToDelete: 'web.yml' },
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
      overlay: { stackToDelete: 'web.yml' },
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
      overlay: { stackToDelete: 'web.yml' },
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
      overlay: { stackToDelete: 'web.yml' },
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
      overlay: { stackToDelete: 'web.yml' },
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
      overlay: { stackToDelete: 'web.yml' },
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

