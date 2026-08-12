import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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
vi.mock('@/components/stack/SelfStackProtectedDialog', () => ({ SelfStackProtectedDialog: () => null }));
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

function renderShell(overlay: OverlayState, stackActions: Partial<StackActionsHook>) {
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
      composeReapply={{} as never}
      canSaveAndReapply={false}
      canOfferVolumeRemoval={false}
      deleteVolumePreservation="unknown"
      onOpenFleetNodeUpdates={() => {}}
      hydrationReady={() => false}
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
});
