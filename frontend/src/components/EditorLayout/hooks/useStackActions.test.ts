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
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { apiFetch } from '@/lib/api';

type EditorState = ReturnType<typeof useEditorViewState>;
type StackListState = ReturnType<typeof useStackListState>;
type NavState = ReturnType<typeof useViewNavigationState>;

function makeEditorState(over: Partial<EditorState> = {}): EditorState {
  const base = {
    content: 'services: {}',
    originalContent: 'services: {}\n',
    envContent: '',
    originalEnvContent: '',
    activeTab: 'compose' as const,
    selectedEnvFile: '',
    setContent: vi.fn(),
    setOriginalContent: vi.fn(),
    setEnvContent: vi.fn(),
    setOriginalEnvContent: vi.fn(),
    setIsEditing: vi.fn(),
    setEditingCompose: vi.fn(),
    setActiveTab: vi.fn(),
    setContainers: vi.fn(),
    setEnvFiles: vi.fn(),
    setSelectedEnvFile: vi.fn(),
    setEnvExists: vi.fn(),
    setBackupInfo: vi.fn(),
    setIsFileLoading: vi.fn(),
    setGitSourcePendingMap: vi.fn(),
  };
  return { ...base, ...over } as unknown as EditorState;
}

function makeStackListState(over: Partial<StackListState> = {}): StackListState {
  const base = {
    selectedFile: 'web.yml',
    files: ['web.yml'],
    stackStatuses: { 'web.yml': 'running' },
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
    setPendingUnsavedNode: vi.fn(),
    setPendingLeaveAction: vi.fn(),
    pendingUnsavedLoad: null,
    pendingUnsavedNode: null,
    pendingLeaveAction: null,
    policyBlock: null,
    setPolicyBlock: vi.fn(),
    setPolicyBypassing: vi.fn(),
    setDiffPreview: vi.fn(),
    ...over,
  } as unknown as OverlayState;
}

const runWithLog: Parameters<typeof useStackActions>[0]['runWithLog'] = async (_p, run) =>
  run(Promise.resolve(), 'test-session');

function setup(over: {
  editorState?: Partial<EditorState>;
  overlay?: Partial<OverlayState>;
  stackList?: Partial<StackListState>;
  getLastDeployOutputLine?: (stackName: string) => string | undefined;
} = {}) {
  const editorState = makeEditorState(over.editorState);
  const stackListState = makeStackListState(over.stackList);
  const navState = { setActiveView: vi.fn() } as unknown as NavState;
  const overlayState = makeOverlay(over.overlay);

  const { result } = renderHook(() =>
    useStackActions({
      editorState,
      stackListState,
      navState,
      overlayState,
      activeNode: { id: 1, type: 'local' } as Parameters<typeof useStackActions>[0]['activeNode'],
      setActiveNode: vi.fn(),
      nodes: [],
      runWithLog,
      getLastDeployOutputLine: over.getLastDeployOutputLine ?? (() => undefined),
      diffPreviewEnabled: false,
    }),
  );
  return { result, editorState, stackListState, overlayState };
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
        navState: { setActiveView: vi.fn() } as unknown as NavState,
        overlayState: makeOverlay(),
        activeNode: { id: 1, type: 'local' } as Parameters<typeof useStackActions>[0]['activeNode'],
        setActiveNode: vi.fn(),
        nodes: [],
        runWithLog,
        getLastDeployOutputLine: () => undefined,
        diffPreviewEnabled: false,
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
