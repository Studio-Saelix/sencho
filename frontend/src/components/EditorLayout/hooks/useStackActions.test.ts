import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
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
  };
  return { ...base, ...over } as unknown as StackListState;
}

function makeOverlay(over: Partial<OverlayState> = {}): OverlayState {
  return {
    setPendingUnsavedLoad: vi.fn(),
    setPendingUnsavedNode: vi.fn(),
    pendingUnsavedLoad: null,
    pendingUnsavedNode: null,
    policyBlock: null,
    setPolicyBlock: vi.fn(),
    setPolicyBypassing: vi.fn(),
    setDiffPreview: vi.fn(),
    ...over,
  } as unknown as OverlayState;
}

const runWithLog: Parameters<typeof useStackActions>[0]['runWithLog'] = async (_p, run) =>
  run(Promise.resolve(), 'test-session');

function setup(over: { editorState?: Partial<EditorState>; overlay?: Partial<OverlayState> } = {}) {
  const editorState = makeEditorState(over.editorState);
  const stackListState = makeStackListState();
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
      isPaid: false,
      runWithLog,
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
        isPaid: false,
        runWithLog,
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

  it('does nothing when no policy block is stored', async () => {
    const { result } = setup({ overlay: { policyBlock: null as never } });
    await result.current.bypassPolicyAndRetry();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
