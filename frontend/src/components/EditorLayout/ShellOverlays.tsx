import BashExecModal from '../BashExecModal';
import { toast } from '@/components/ui/toast-store';
import { PolicyBlockDialog } from '../stack/PolicyBlockDialog';
import { PreDeployScanDialog } from '../stack/PreDeployScanDialog';
import { MissingExternalNetworksDialog } from '../stack/MissingExternalNetworksDialog';
import { UpdateReadinessDialog } from '../stack/UpdateReadinessDialog';
import { SelfStackProtectedDialog } from '../stack/SelfStackProtectedDialog';
import { LocalUpdateConfirmDialog } from '../FleetView/LocalUpdateConfirmDialog';
import { ReconnectingOverlay } from '../FleetView/ReconnectingOverlay';
import { DeleteStackDialog, type VolumePreservationOnDelete } from './DeleteStackDialog';
import { TakeDownStackDialog } from './TakeDownStackDialog';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';
import { StackAlertSheet } from '../StackAlertSheet';
import { GitSourcePanel } from '../stack/GitSourcePanel';
import { LogViewer } from '../LogViewer';
import { ImageDetailsSheet } from '../resources/ImageDetailsSheet';
import { VulnerabilityScanSheet } from '../VulnerabilityScanSheet';
import { ComposeDiffPreviewDialog } from '@/components/ComposeDiffPreviewDialog';
import { resolveComposeDiffActionLabel } from '@/components/resolveComposeDiffActionLabel';
import type { OverlayState } from './hooks/useOverlayState';
import type { StackActionsHook } from './hooks/useStackActions';
import type { PermissionAction } from '@/context/AuthContext';
import type { useComposeReapplyAction } from '../FleetView/hooks/useComposeReapplyAction';
import type { StackAction } from './EditorView';
import { resolveStackFileKey } from './hooks/resolveStackFileKey';

interface ShellOverlaysProps {
  overlayState: OverlayState;
  stackActions: StackActionsHook;
  /** Filename-keyed busy map from stack list state (not the stackActions hook). */
  stackActionMap: Record<string, StackAction>;
  /** Stack filenames for resolveStackFileKey (overlay holds bare names). */
  stackFiles: string[];
  isDarkMode: boolean;
  isAdmin: boolean;
  can: (action: PermissionAction, resourceType?: string, resourceId?: string, nodeId?: number | null) => boolean;
  selectedFile: string | null;
  stackName: string;
  activeNodeId: number | null;
  gitSourceOpen: boolean;
  setGitSourceOpen: (open: boolean) => void;
  canSelfUpdate: boolean;
  composeReapply: ReturnType<typeof useComposeReapplyAction>;
  canSaveAndReapply: boolean;
  canOfferVolumeRemoval: boolean;
  deleteVolumePreservation: VolumePreservationOnDelete;
  onOpenFleetNodeUpdates: () => void;
  /** Ref-backed readiness check, evaluated at confirmation time so a dialog
   *  opened while ready cannot dispatch after a node switch or failed refresh. */
  hydrationReady: () => boolean;
}

export function ShellOverlays({
  overlayState,
  stackActions,
  stackActionMap,
  stackFiles,
  isDarkMode,
  isAdmin,
  can,
  selectedFile,
  stackName,
  activeNodeId,
  gitSourceOpen,
  setGitSourceOpen,
  canSelfUpdate,
  composeReapply,
  canSaveAndReapply,
  canOfferVolumeRemoval,
  deleteVolumePreservation,
  onOpenFleetNodeUpdates,
  hydrationReady,
}: ShellOverlaysProps) {
  const {
    deleteDialogOpen, closeDeleteDialog, deleteTarget,
    takeDownDialogOpen, closeTakeDownDialog, takeDownTarget,
    pendingUnsavedLoad, pendingLeaveAction,
    bashModalOpen, selectedContainer,
    logViewerOpen, logContainer,
    inspectImage, closeInspectImage,
    stackMonitor, closeStackMonitor,
    policyBlock, setPolicyBlock, policyBypassing,
    updateReadiness, setUpdateReadiness,
    preDeployAdvisory,
    missingExternalNetworks, setMissingExternalNetworks,
    selfStackProtectedOpen, setSelfStackProtectedOpen,
    composeReapplyCapture, setComposeReapplyCapture,
    stackMisconfigScanId, setStackMisconfigScanId,
    diffPreview, setDiffPreview, diffPreviewConfirming, setDiffPreviewConfirming,
  } = overlayState;

  const isDeleteConfirming =
    deleteTarget != null &&
    stackActionMap[resolveStackFileKey(stackFiles, deleteTarget.name)] === 'delete';
  const isTakeDownConfirming =
    takeDownTarget != null &&
    stackActionMap[resolveStackFileKey(stackFiles, takeDownTarget.name)] === 'down';
  const sheetImage = inspectImage && inspectImage.nodeId === activeNodeId
    ? inspectImage
    : null;
  const inspectCrumb = sheetImage
    ? [sheetImage.usedByStacks[0] || 'Stack', sheetImage.RepoTags[0] || 'Image']
    : undefined;

  return (
    <>
      <DeleteStackDialog
        open={deleteDialogOpen}
        onOpenChange={(open) => { if (!open) closeDeleteDialog(); }}
        stackName={deleteTarget?.name ?? null}
        volumePreservation={deleteVolumePreservation}
        onConfirm={stackActions.deleteStack}
        confirming={isDeleteConfirming}
      />

      <TakeDownStackDialog
        open={takeDownDialogOpen}
        onOpenChange={(open) => { if (!open) closeTakeDownDialog(); }}
        stackName={takeDownTarget?.name ?? null}
        showVolumeOption={canOfferVolumeRemoval}
        onConfirm={stackActions.takeDownStack}
        confirming={isTakeDownConfirming}
      />

      <SelfStackProtectedDialog
        open={selfStackProtectedOpen}
        onOpenChange={setSelfStackProtectedOpen}
        canOpenFleetUpdates={canSelfUpdate}
        onOpenFleetUpdates={onOpenFleetNodeUpdates}
      />

      <LocalUpdateConfirmDialog
        open={composeReapplyCapture !== null}
        mode="reapply"
        nodeType={composeReapplyCapture?.nodeType ?? 'local'}
        onOpenChange={(open) => {
          if (!open) setComposeReapplyCapture(null);
        }}
        onConfirm={() => {
          // Readiness loss keeps the dialog open with the confirmation blocked;
          // the capture is only cleared on an actual dispatch.
          if (!hydrationReady()) return;
          const capture = composeReapplyCapture;
          setComposeReapplyCapture(null);
          if (!capture || composeReapply.dispatching) return;
          void composeReapply.runReapply({
            nodeId: capture.nodeId,
            type: capture.nodeType,
            name: capture.nodeName,
          });
        }}
      />

      {composeReapply.reconnecting && (
        <ReconnectingOverlay
          preUpdateStartedAt={composeReapply.preUpdateStartedAt}
          mode="reapply"
        />
      )}

      <UnsavedChangesDialog
        open={!!pendingUnsavedLoad || !!pendingLeaveAction}
        onCancel={stackActions.cancelPendingUnsavedLoad}
        onConfirm={stackActions.discardAndLoadPending}
      />

      {/* Bash Exec Modal */}
      {selectedContainer && (
        <BashExecModal
          isOpen={bashModalOpen}
          onClose={stackActions.closeBashModal}
          containerId={selectedContainer.id}
          containerName={selectedContainer.name}
        />
      )}

      {/* LogViewer Modal */}
      {logContainer && (
        <LogViewer
          isOpen={logViewerOpen}
          onClose={stackActions.closeLogViewer}
          containerId={logContainer.id}
          containerName={logContainer.name}
        />
      )}

      <ImageDetailsSheet
        image={sheetImage}
        onClose={closeInspectImage}
        crumb={inspectCrumb}
      />

      {/* Stack monitor (alerts + auto-heal as tabs) */}
      <StackAlertSheet
        open={stackMonitor !== null}
        onOpenChange={(open) => { if (!open) closeStackMonitor(); }}
        stackName={stackMonitor?.stackName ?? ''}
        initialTab={stackMonitor?.tab ?? 'alerts'}
        initialService={stackMonitor?.serviceName}
      />

      {/* Pre-update readiness check */}
      <UpdateReadinessDialog
        open={updateReadiness !== null}
        stackName={updateReadiness?.stackName ?? ''}
        nodeId={updateReadiness?.nodeId ?? null}
        serviceName={updateReadiness?.serviceName}
        mode={updateReadiness?.mode}
        onCancel={() => setUpdateReadiness(null)}
        onProceed={() => updateReadiness?.proceed()}
      />

      {/* Pre-deploy scan advisory (visibility only; never blocks) */}
      <PreDeployScanDialog
        open={preDeployAdvisory !== null}
        stackName={preDeployAdvisory?.stackName ?? ''}
        images={preDeployAdvisory?.images ?? []}
        onCancel={() => preDeployAdvisory?.cancel()}
        onDeploy={() => preDeployAdvisory?.proceed()}
      />

      <MissingExternalNetworksDialog
        open={missingExternalNetworks !== null}
        payload={missingExternalNetworks?.payload ?? null}
        isAdmin={isAdmin}
        creating={missingExternalNetworks?.creating ?? false}
        onCancel={() => {
          missingExternalNetworks?.cancel();
          setMissingExternalNetworks(null);
        }}
        onOpenNetworking={() => {
          missingExternalNetworks?.openNetworking();
          setMissingExternalNetworks(null);
        }}
        onCreateAndContinue={() => {
          void missingExternalNetworks?.createAndContinue();
        }}
      />

      {/* Pre-deploy policy block */}
      <PolicyBlockDialog
        open={policyBlock !== null}
        payload={policyBlock?.payload ?? null}
        stackName={policyBlock?.stackName ?? ''}
        canBypass={isAdmin}
        bypassing={policyBypassing}
        onClose={() => setPolicyBlock(null)}
        onBypass={stackActions.bypassPolicyAndRetry}
      />

      {/* Git Source Panel */}
      {stackName && (
        <GitSourcePanel
          open={gitSourceOpen}
          onOpenChange={setGitSourceOpen}
          stackName={stackName}
          canEdit={can('stack:edit', 'stack', stackName, activeNodeId)}
          isDarkMode={isDarkMode}
          onSourceChanged={stackActions.refreshGitSourcePending}
        />
      )}

      {/* Stack config misconfig scan results */}
      <VulnerabilityScanSheet
        scanId={stackMisconfigScanId}
        onClose={() => setStackMisconfigScanId(null)}
        canManageSuppressions={can('stack:edit')}
      />

      {/* Compose diff preview */}
      <ComposeDiffPreviewDialog
        open={diffPreview !== null}
        onOpenChange={(open) => { if (!open && !diffPreviewConfirming) setDiffPreview(null); }}
        stackName={selectedFile ? selectedFile.replace(/\.(yml|yaml)$/, '') : ''}
        fileName={diffPreview?.fileName ?? ''}
        language={diffPreview?.language ?? 'yaml'}
        original={diffPreview?.original ?? ''}
        modified={diffPreview?.modified ?? ''}
        actionLabel={resolveComposeDiffActionLabel(diffPreview?.mode, canSaveAndReapply)}
        confirming={diffPreviewConfirming}
        isDarkMode={isDarkMode}
        onConfirm={async () => {
          const snapshot = diffPreview;
          setDiffPreviewConfirming(true);
          try {
            if (snapshot?.mode === 'save-and-deploy') {
              // Recheck before the PUT: Save & Deploy from the diff preview must
              // not write the file while status evidence is not authoritative.
              if (!hydrationReady()) {
                toast.error('Status data unavailable. Refresh and try again.');
                return;
              }
              const saved = await stackActions.saveFile();
              if (saved) await stackActions.deployStack();
            } else {
              // Plain Save is never gated by status readiness.
              await stackActions.saveFile();
            }
          } finally {
            setDiffPreviewConfirming(false);
            setDiffPreview(null);
          }
        }}
      />

    </>
  );
}
