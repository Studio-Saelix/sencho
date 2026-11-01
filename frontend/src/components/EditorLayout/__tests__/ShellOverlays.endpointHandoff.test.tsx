/**
 * The refusal dialog's confirmation through the real ShellOverlays wiring: an
 * eligible provider refusal (bound to the active node and stack) opens the
 * endpoint-only Reapply preview for that same node and stack, and can never be
 * confirmed after the editor moved elsewhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { OverlayState } from '../hooks/useOverlayState';
import type { StackActionsHook } from '../hooks/useStackActions';

vi.mock('@/components/FleetView/hooks/useEndpointProviderOption', () => ({
  useEndpointProviderOption: () => ({
    state: 'available',
    service: 'socket-proxy',
    containerName: 'stack-socket-proxy-1',
    project: 'stack',
    providerOnly: true,
  }),
  fetchEndpointProviderOption: vi.fn(),
}));

// Heavy siblings stay out of the way; the Docker endpoint dialog and the
// dialog primitives under test are real.
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
vi.mock('@/components/ComposeDiffPreviewDialog', () => ({ ComposeDiffPreviewDialog: () => null }));
vi.mock('../FleetView/LocalUpdateConfirmDialog', () => ({ LocalUpdateConfirmDialog: () => null }));
vi.mock('../FleetView/ReconnectingOverlay', () => ({ ReconnectingOverlay: () => null }));
vi.mock('./DeleteStackDialog', () => ({ DeleteStackDialog: () => null }));
vi.mock('./TakeDownStackDialog', () => ({ TakeDownStackDialog: () => null }));
vi.mock('./UnsavedChangesDialog', () => ({ UnsavedChangesDialog: () => null }));

import { ShellOverlays } from '../ShellOverlays';

const refusal = {
  message: 'Deploying "socket-proxy" would cut the Docker connection Sencho is using, so it was refused.',
  reason: 'provider' as const,
  service: 'socket-proxy',
  nodeId: 1,
  nodeName: 'node-1',
  nodeType: 'local' as const,
  stackFile: 'sencho.yml',
};

function overlayState(over: Partial<OverlayState> = {}): OverlayState {
  return {
    dockerEndpointProtected: refusal,
    setDockerEndpointProtected: vi.fn(),
    setComposeReapplyCapture: vi.fn(),
    composeReapplyCapture: null,
    diffPreview: null,
    policyBlock: null,
    ...over,
  } as unknown as OverlayState;
}

function renderShell(overlay: OverlayState, options: { reapplySelfTarget?: { nodeId: number; type: 'local' | 'remote'; name: string } | null; isSelfStackSelected?: boolean } = {}) {
  return render(
    <ShellOverlays
      overlayState={overlay}
      stackActions={{} as unknown as StackActionsHook}
      stackActionMap={{}}
      stackFiles={['sencho.yml']}
      isDarkMode={false}
      isAdmin
      can={() => true}
      selectedFile="sencho.yml"
      stackName="sencho"
      activeNodeId={1}
      gitSourceOpen={false}
      setGitSourceOpen={() => {}}
      canSelfUpdate
      reapplySelfTarget={(options.reapplySelfTarget === undefined
        ? { nodeId: 1, type: 'local', name: 'node-1' }
        : options.reapplySelfTarget) as never}
      activeStackFile="sencho.yml"
      isSelfStackSelected={options.isSelfStackSelected ?? true}
      composeReapply={{ dispatching: false } as never}
      canSaveAndReapply
      canOfferVolumeRemoval={false}
      deleteVolumePreservation="unknown"
      onOpenFleetNodeUpdates={() => {}}
      onOpenPolicySettings={() => true}
      hydrationReady={() => true}
    />,
  );
}

beforeEach(() => { vi.clearAllMocks(); });

describe('the Docker endpoint refusal confirmation', () => {
  it('opens the endpoint-only Reapply preview for the refused node and stack', () => {
    const overlay = overlayState();
    renderShell(overlay);
    fireEvent.click(screen.getByRole('button', { name: /Recreate endpoint/i }));
    expect(overlay.setDockerEndpointProtected).toHaveBeenCalledWith(null);
    expect(overlay.setComposeReapplyCapture).toHaveBeenCalledWith({
      nodeId: 1,
      nodeType: 'local',
      nodeName: 'node-1',
      stackFile: 'sencho.yml',
      initialScope: 'only',
    });
  });

  it('does not offer the replacement after the editor moved to another stack', () => {
    renderShell(overlayState({
      dockerEndpointProtected: { ...refusal, stackFile: 'other.yml' },
    }));
    expect(screen.queryByRole('button', { name: /Recreate endpoint/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Got it/i })).toBeVisible();
  });

  it('does not offer the replacement for a same-named service outside Sencho\'s own stack', () => {
    renderShell(overlayState(), { isSelfStackSelected: false });
    expect(screen.queryByRole('button', { name: /Recreate endpoint/i })).toBeNull();
    expect(screen.getByRole('button', { name: /Got it/i })).toBeVisible();
  });
});
