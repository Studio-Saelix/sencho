import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import * as toastStore from '@/components/ui/toast-store';

beforeEach(() => {
  onConfirmMock.mockReset();
});

// The dialog under test: capture its onConfirm so the tests exercise
// ShellOverlays' gating wiring (the corrected surface) without dragging in
// the real modal or its context providers.
const { onConfirmMock } = vi.hoisted(() => ({ onConfirmMock: vi.fn() }));
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
vi.mock('@/components/stack/PolicyBlockDialog', () => ({ PolicyBlockDialog: () => null }));
vi.mock('@/components/stack/SelfStackProtectedDialog', () => ({
  SelfStackProtectedDialog: (props: { onReapply?: () => Promise<void> }) =>
    props.onReapply ? <button type="button" onClick={() => props.onReapply?.()}>self-reapply</button> : <span>self-info-only</span>,
}));
vi.mock('../FleetView/LocalUpdateConfirmDialog', () => ({ LocalUpdateConfirmDialog: () => null }));
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

function renderShell(
  overlay: OverlayState,
  stackActions: Partial<StackActionsHook>,
  over: {
    hydrationReady?: () => boolean;
    reapplySelfTarget?: { nodeId: number; type: 'local' | 'remote'; name: string } | null;
    composeReapply?: { dispatching: boolean; reconnecting?: boolean; runReapply: () => void };
  } = {},
) {
  return render(
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
      composeReapply={(over.composeReapply ?? {}) as never}
      canSaveAndReapply={false}
      canOfferVolumeRemoval={false}
      deleteVolumePreservation="unknown"
      onOpenFleetNodeUpdates={() => {}}
      hydrationReady={over.hydrationReady ?? (() => false)}
    />,
  );
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
