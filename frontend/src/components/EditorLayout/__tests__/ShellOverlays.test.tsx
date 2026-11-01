import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import * as toastStore from '@/components/ui/toast-store';

beforeEach(() => {
  onConfirmMock.mockReset();
  policyDialogProps.current = null;
});

// The dialog under test: capture its onConfirm so the tests exercise
// ShellOverlays' gating wiring (the corrected surface) without dragging in
// the real modal or its context providers.
const { onConfirmMock, policyDialogProps } = vi.hoisted(() => ({
  onConfirmMock: vi.fn(),
  policyDialogProps: { current: null as null | Record<string, unknown> },
}));
vi.mock('@/components/ComposeDiffPreviewDialog', () => ({
  ComposeDiffPreviewDialog: (props: { onConfirm: () => void | Promise<void> }) => {
    onConfirmMock.mockImplementation(() => props.onConfirm());
    return <button type="button" onClick={() => props.onConfirm()}>diff-confirm</button>;
  },
}));

// ShellOverlays mounts several context-hungry sheets unconditionally; the
// diff-preview tests exercise only the confirm path, so stub them.
vi.mock('@/components/resources/ImageDetailsSheet', () => ({ ImageDetailsSheet: () => null }));
vi.mock('@/components/VulnerabilityScanSheet', () => ({ VulnerabilityScanSheet: () => null }));
vi.mock('@/components/StackAlertSheet', () => ({ StackAlertSheet: () => null }));
vi.mock('@/components/LogViewer', () => ({ default: () => null }));
vi.mock('@/components/stack/GitSourcePanel', () => ({ GitSourcePanel: () => null }));
vi.mock('@/components/BashExecModal', () => ({ default: () => null }));
vi.mock('@/components/stack/UpdateReadinessDialog', () => ({ UpdateReadinessDialog: () => null }));
vi.mock('@/components/stack/PreDeployScanDialog', () => ({ PreDeployScanDialog: () => null }));
vi.mock('@/components/stack/MissingExternalNetworksDialog', () => ({ MissingExternalNetworksDialog: () => null }));
vi.mock('@/components/stack/PolicyBlockDialog', () => ({
  PolicyBlockDialog: (props: Record<string, unknown>) => {
    policyDialogProps.current = props;
    return null;
  },
}));
vi.mock('@/components/stack/SelfStackProtectedDialog', () => ({
  SelfStackProtectedDialog: (props: { onReapply?: () => Promise<void> }) =>
    props.onReapply ? <button type="button" onClick={() => props.onReapply?.()}>self-reapply</button> : <span>self-info-only</span>,
}));
vi.mock('../FleetView/LocalUpdateConfirmDialog', () => ({
  LocalUpdateConfirmDialog: (props: { open: boolean; initialScope?: string; nodeName?: string }) =>
    props.open ? <span>{`reapply-confirm:${props.initialScope ?? 'none'}:${props.nodeName ?? ''}`}</span> : null,
}));
vi.mock('@/components/stack/DockerEndpointProtectedDialog', () => ({
  DockerEndpointProtectedDialog: (props: {
    open: boolean; message: string; canRecreate: boolean; contextMoved?: boolean; onRecreate?: () => void; onOpenChange: (open: boolean) => void;
  }) => props.open ? (
    <div>
      <span>{`endpoint-protected:${props.canRecreate ? 'eligible' : 'ineligible'}${props.contextMoved ? ':moved' : ''}`}</span>
      <span>{props.message}</span>
      <button type="button" onClick={() => { props.onOpenChange(false); props.onRecreate?.(); }}>recreate-endpoint</button>
    </div>
  ) : null,
}));
vi.mock('../FleetView/ReconnectingOverlay', () => ({ ReconnectingOverlay: () => null }));
vi.mock('./DeleteStackDialog', () => ({ DeleteStackDialog: () => null }));
vi.mock('./TakeDownStackDialog', () => ({ TakeDownStackDialog: () => null }));
vi.mock('./UnsavedChangesDialog', () => ({ UnsavedChangesDialog: () => null }));

import { ShellOverlays } from '../ShellOverlays';
import type { OverlayState } from '../hooks/useOverlayState';
import type { StackActionsHook } from '../hooks/useStackActions';

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
    dockerEndpointProtected: null,
    setDockerEndpointProtected: vi.fn(),
    openDockerEndpointProtected: vi.fn(),
    setComposeReapplyCapture: vi.fn(),
    composeReapplyCapture: null,
    diffPreview: null,
    setDiffPreview: vi.fn(),
    diffPreviewConfirming: false,
    setDiffPreviewConfirming: vi.fn(),
    stackToDelete: null,
    closeDeleteDialog: vi.fn(),
    stackToTakeDown: null,
    closeTakeDownDialog: vi.fn(),
    ...over,
  } as unknown as OverlayState;
}

function shellElement(
  overlay: OverlayState,
  stackActions: Partial<StackActionsHook>,
  over: {
    hydrationReady?: () => boolean;
    reapplySelfTarget?: { nodeId: number; type: 'local' | 'remote'; name: string } | null;
    composeReapply?: { dispatching: boolean; reconnecting?: boolean; runReapply: () => void };
    onOpenPolicySettings?: (nodeId: number | null) => boolean;
  } = {},
) {
  return (
    <ShellOverlays
      overlayState={overlay}
      stackActions={stackActions as unknown as StackActionsHook}
      stackActionMap={{}}
      stackFiles={['web.yml']}
      isDarkMode={false}
      isAdmin={false}
      can={() => false}
      selectedFile="web.yml"
      stackName="web"
      activeNodeId={1}
      gitSourceOpen={false}
      setGitSourceOpen={() => {}}
      canSelfUpdate={false}
      reapplySelfTarget={(over.reapplySelfTarget ?? null) as never}
      activeStackFile="web.yml"
      isSelfStackSelected={false}
      composeReapply={(over.composeReapply ?? {}) as never}
      canSaveAndReapply={false}
      canOfferVolumeRemoval={false}
      deleteVolumePreservation="unknown"
      onOpenFleetNodeUpdates={() => {}}
      onOpenPolicySettings={over.onOpenPolicySettings ?? (() => true)}
      hydrationReady={over.hydrationReady ?? (() => false)}
    />
  );
}

function renderShell(...args: Parameters<typeof shellElement>) {
  return render(shellElement(...args));
}

describe('ShellOverlays diff-preview confirmation', () => {
  it('lets plain Save through the diff preview while readiness is absent', async () => {
    const saveFile = vi.fn().mockResolvedValue(true);
    const deployStack = vi.fn();
    renderShell(
      makeOverlay({
        diffPreview: {
          fileName: 'compose.yml',
          language: 'yaml',
          original: 'a',
          modified: 'b',
          mode: 'save',
        },
      }),
      { saveFile, deployStack },
    );
    fireEvent.click(screen.getByRole('button', { name: 'diff-confirm' }));
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(deployStack).not.toHaveBeenCalled();
  });

  it('blocks Save & Deploy through the diff preview while readiness is absent', async () => {
    const saveFile = vi.fn().mockResolvedValue(true);
    const deployStack = vi.fn();
    renderShell(
      makeOverlay({
        diffPreview: {
          fileName: 'compose.yml',
          language: 'yaml',
          original: 'a',
          modified: 'b',
          mode: 'save-and-deploy',
        },
      }),
      { saveFile, deployStack },
    );
    fireEvent.click(screen.getByRole('button', { name: 'diff-confirm' }));
    expect(saveFile).not.toHaveBeenCalled();
    expect(deployStack).not.toHaveBeenCalled();
  });

  it('blocks Save & Pull Images through the diff preview while readiness is absent', async () => {
    const saveFile = vi.fn().mockResolvedValue(true);
    const pullStackImages = vi.fn();
    renderShell(
      makeOverlay({
        diffPreview: {
          fileName: 'compose.yml',
          language: 'yaml',
          original: 'a',
          modified: 'b',
          mode: 'save-and-pull-images',
        },
      }),
      { saveFile, pullStackImages },
    );
    fireEvent.click(screen.getByRole('button', { name: 'diff-confirm' }));
    // This action writes the file first, so it inherits the Save & Deploy
    // readiness contract rather than the unconditional plain-Save one.
    expect(saveFile).not.toHaveBeenCalled();
    expect(pullStackImages).not.toHaveBeenCalled();
  });

  it('saves before pulling when the diff preview is confirmed', async () => {
    const order: string[] = [];
    const saveFile = vi.fn().mockImplementation(async () => {
      order.push('save');
      return true;
    });
    const pullStackImages = vi.fn().mockImplementation(async () => {
      order.push('pull');
    });
    renderShell(
      makeOverlay({
        diffPreview: {
          fileName: 'compose.yml',
          language: 'yaml',
          original: 'a',
          modified: 'b',
          mode: 'save-and-pull-images',
        },
      }),
      { saveFile, pullStackImages },
      { hydrationReady: () => true },
    );
    fireEvent.click(screen.getByRole('button', { name: 'diff-confirm' }));
    await vi.waitFor(() => expect(pullStackImages).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['save', 'pull']);
    // afterSave travels with the call: this path saved first too, so a pull that
    // skips has to report itself rather than hide behind the save's own toast.
    expect(pullStackImages).toHaveBeenCalledWith(undefined, { afterSave: true });
  });
});

describe('ShellOverlays self-stack Reapply confirmation', () => {
  const target = { nodeId: 1, type: 'local' as const, name: 'Local' };

  it('offers no Reapply to a caller without a reapply target', () => {
    renderShell(makeOverlay({ selfStackProtectedOpen: true, setSelfStackProtectedOpen: vi.fn() }), {});
    expect(screen.getByText('self-info-only')).toBeInTheDocument();
  });

  it('keeps the dialog open, says why, and sends nothing while the node is not ready', async () => {
    const runReapply = vi.fn();
    const setOpen = vi.fn();
    const toastError = vi.spyOn(toastStore.toast, 'error').mockImplementation(() => '' as never);
    renderShell(
      makeOverlay({ selfStackProtectedOpen: true, setSelfStackProtectedOpen: setOpen }),
      {},
      { reapplySelfTarget: target, composeReapply: { dispatching: false, runReapply }, hydrationReady: () => false },
    );
    fireEvent.click(screen.getByRole('button', { name: 'self-reapply' }));
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith('Status data unavailable. Refresh and try again.'));
    expect(setOpen).not.toHaveBeenCalled();
    expect(runReapply).not.toHaveBeenCalled();
  });

  it('closes the dialog and reapplies once the node is ready', () => {
    const runReapply = vi.fn();
    const setOpen = vi.fn();
    renderShell(
      makeOverlay({ selfStackProtectedOpen: true, setSelfStackProtectedOpen: setOpen }),
      {},
      { reapplySelfTarget: target, composeReapply: { dispatching: false, runReapply }, hydrationReady: () => true },
    );
    fireEvent.click(screen.getByRole('button', { name: 'self-reapply' }));
    expect(setOpen).toHaveBeenCalledWith(false);
    expect(runReapply).toHaveBeenCalledWith(target);
  });

  it('closes the dialog when the active node changes, so Reapply never targets a different Sencho', () => {
    const setOpen = vi.fn();
    const overlay = makeOverlay({ selfStackProtectedOpen: true, setSelfStackProtectedOpen: setOpen });
    const composeReapply = { dispatching: false, runReapply: vi.fn() };
    const { rerender } = renderShell(overlay, {}, { reapplySelfTarget: target, composeReapply, hydrationReady: () => true });
    expect(setOpen).not.toHaveBeenCalled();

    rerender(shellElement(overlay, {}, { reapplySelfTarget: { ...target, nodeId: 2, name: 'Remote' }, composeReapply, hydrationReady: () => true }));

    expect(setOpen).toHaveBeenCalledWith(false);
  });

  it('closes the dialog without starting a second reapply while one is in flight', () => {
    const runReapply = vi.fn();
    const setOpen = vi.fn();
    renderShell(
      makeOverlay({ selfStackProtectedOpen: true, setSelfStackProtectedOpen: setOpen }),
      {},
      { reapplySelfTarget: target, composeReapply: { dispatching: true, runReapply }, hydrationReady: () => true },
    );
    fireEvent.click(screen.getByRole('button', { name: 'self-reapply' }));
    expect(setOpen).toHaveBeenCalledWith(false);
    expect(runReapply).not.toHaveBeenCalled();
  });
});

describe('ShellOverlays Docker endpoint refusal handoff', () => {
  const target = { nodeId: 1, type: 'local' as const, name: 'Local' };

  it('opens the endpoint preview for the active node and preselects endpoint-only', () => {
    const setCapture = vi.fn();
    const setProtected = vi.fn();
    renderShell(
      makeOverlay({
        dockerEndpointProtected: { message: 'This deploy would recreate socket-proxy.', reason: 'provider', service: 'socket-proxy', nodeId: 1, nodeName: 'Local', nodeType: 'local', stackFile: 'web.yml' },
        setDockerEndpointProtected: setProtected,
        setComposeReapplyCapture: setCapture,
      }),
      {},
      { reapplySelfTarget: target, composeReapply: { dispatching: false, runReapply: vi.fn() }, hydrationReady: () => true },
    );
    expect(screen.getByText('endpoint-protected:eligible')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'recreate-endpoint' }));
    expect(setProtected).toHaveBeenCalledWith(null);
    expect(setCapture).toHaveBeenCalledWith({
      nodeId: 1,
      nodeType: 'local',
      nodeName: 'Local',
      stackFile: 'web.yml',
      initialScope: 'only',
    });
  });

  it('offers no replacement to a caller who cannot reapply the node', () => {
    renderShell(
      makeOverlay({
        dockerEndpointProtected: { message: 'refused', reason: 'provider', service: 'socket-proxy', nodeId: 1, nodeName: 'Local', nodeType: 'local', stackFile: 'web.yml' },
        setDockerEndpointProtected: vi.fn(),
      }),
      {},
      { reapplySelfTarget: null, hydrationReady: () => true },
    );
    expect(screen.getByText('endpoint-protected:ineligible')).toBeInTheDocument();
  });

  it('does not offer the replacement after the editor moved to another node', () => {
    renderShell(
      makeOverlay({
        dockerEndpointProtected: { message: 'refused', reason: 'provider', service: 'socket-proxy', nodeId: 2, nodeName: 'Edge', nodeType: 'remote', stackFile: 'web.yml' },
        setDockerEndpointProtected: vi.fn(),
      }),
      {},
      { reapplySelfTarget: target, hydrationReady: () => true },
    );
    expect(screen.getByText('endpoint-protected:ineligible:moved')).toBeInTheDocument();
  });

  it('does not offer the replacement after the editor moved to another stack', () => {
    renderShell(
      makeOverlay({
        dockerEndpointProtected: { message: 'refused', reason: 'provider', service: 'socket-proxy', nodeId: 1, nodeName: 'Local', nodeType: 'local', stackFile: 'other.yml' },
        setDockerEndpointProtected: vi.fn(),
      }),
      {},
      { reapplySelfTarget: target, hydrationReady: () => true },
    );
    expect(screen.getByText('endpoint-protected:ineligible:moved')).toBeInTheDocument();
  });

  it('sends nothing when status evidence is not authoritative', () => {
    const setCapture = vi.fn();
    const toastError = vi.spyOn(toastStore.toast, 'error').mockImplementation(() => '' as never);
    renderShell(
      makeOverlay({
        dockerEndpointProtected: { message: 'refused', reason: 'provider', service: 'socket-proxy', nodeId: 1, nodeName: 'Local', nodeType: 'local', stackFile: 'web.yml' },
        setDockerEndpointProtected: vi.fn(),
        setComposeReapplyCapture: setCapture,
      }),
      {},
      { reapplySelfTarget: target, hydrationReady: () => false },
    );
    fireEvent.click(screen.getByRole('button', { name: 'recreate-endpoint' }));
    expect(toastError).toHaveBeenCalledWith('Status data unavailable. Refresh and try again.');
    expect(setCapture).not.toHaveBeenCalled();
  });
});

describe('ShellOverlays policy block dialog', () => {
  const block = (action: 'deploy' | 'update' | 'rollback', nodeId: number | null) => ({
    stackName: 'web',
    stackFile: 'web.yml',
    action,
    payload: { error: 'blocked', policy: null, violations: [] },
    nodeId,
  });

  it('tells the dialog which operation was blocked', () => {
    renderShell(makeOverlay({ policyBlock: block('rollback', 1) }), {});
    expect(policyDialogProps.current).toMatchObject({ open: true, action: 'rollback' });
  });

  it('opens the settings on the node the block was raised against, not the active node', () => {
    const onOpenPolicySettings = vi.fn(() => true);
    // Node 1 is the active node; the operation was sent to node 7.
    renderShell(makeOverlay({ policyBlock: block('deploy', 7) }), {}, { onOpenPolicySettings });
    (policyDialogProps.current!.onOpenSettings as () => void)();
    expect(onOpenPolicySettings).toHaveBeenCalledTimes(1);
    expect(onOpenPolicySettings).toHaveBeenCalledWith(7);
  });

  it('reports back whether the settings could be opened, so the dialog knows whether to close', () => {
    const onOpenPolicySettings = vi.fn(() => false);
    renderShell(makeOverlay({ policyBlock: block('deploy', 7) }), {}, { onOpenPolicySettings });
    expect((policyDialogProps.current!.onOpenSettings as () => boolean)()).toBe(false);
  });

  it('passes no node when the block recorded none', () => {
    const onOpenPolicySettings = vi.fn(() => true);
    renderShell(makeOverlay({ policyBlock: block('update', null) }), {}, { onOpenPolicySettings });
    (policyDialogProps.current!.onOpenSettings as () => void)();
    expect(onOpenPolicySettings).toHaveBeenCalledWith(null);
  });
});
