import { lazy, Suspense } from 'react';
import BashExecModal from '../BashExecModal';
import LazyBoundary from '../LazyBoundary';
import { PolicyBlockDialog } from '../stack/PolicyBlockDialog';
import { DeleteStackDialog } from './DeleteStackDialog';
import { UnsavedChangesDialog } from './UnsavedChangesDialog';
import { StackAlertSheet } from '../StackAlertSheet';
import { GitSourcePanel } from '../stack/GitSourcePanel';
import { LogViewer } from '../LogViewer';
import { VulnerabilityScanSheet } from '../VulnerabilityScanSheet';
import { ComposeDiffPreviewDialog } from '@/components/ComposeDiffPreviewDialog';
import type { OverlayState } from './hooks/useOverlayState';
import type { StackActionsHook } from './hooks/useStackActions';
import type { PermissionAction } from '@/context/AuthContext';

// SecurityHistoryView is the only lazy-loaded view that lives outside
// the ViewRouter switch -- it renders as an overlay sheet wired into the
// settings flow, not as a top-level tab. The other tab-level lazy views
// (HostConsole, FleetView, AuditLogView, etc.) live inside ViewRouter.
const SecurityHistoryView = lazy(() =>
  import('../SecurityHistoryView').then(m => ({ default: m.SecurityHistoryView })),
);

interface ShellOverlaysProps {
  overlayState: OverlayState;
  stackActions: StackActionsHook;
  isDarkMode: boolean;
  isAdmin: boolean;
  can: (action: PermissionAction, resourceType?: string, resourceId?: string) => boolean;
  selectedFile: string | null;
  stackName: string;
  gitSourceOpen: boolean;
  setGitSourceOpen: (open: boolean) => void;
  securityHistoryOpen: boolean;
  setSecurityHistoryOpen: (open: boolean) => void;
}

export function ShellOverlays({
  overlayState,
  stackActions,
  isDarkMode,
  isAdmin,
  can,
  selectedFile,
  stackName,
  gitSourceOpen,
  setGitSourceOpen,
  securityHistoryOpen,
  setSecurityHistoryOpen,
}: ShellOverlaysProps) {
  const {
    deleteDialogOpen, closeDeleteDialog, stackToDelete,
    pendingUnsavedLoad,
    bashModalOpen, selectedContainer,
    logViewerOpen, logContainer,
    stackMonitor, closeStackMonitor,
    policyBlock, setPolicyBlock, policyBypassing,
    stackMisconfigScanId, setStackMisconfigScanId,
    diffPreview, setDiffPreview, diffPreviewConfirming, setDiffPreviewConfirming,
  } = overlayState;

  return (
    <>
      <DeleteStackDialog
        open={deleteDialogOpen}
        onOpenChange={(open) => { if (!open) closeDeleteDialog(); }}
        stackName={stackToDelete}
        onConfirm={stackActions.deleteStack}
      />

      <UnsavedChangesDialog
        open={!!pendingUnsavedLoad}
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

      {/* Stack monitor (alerts + auto-heal as tabs) */}
      <StackAlertSheet
        open={stackMonitor !== null}
        onOpenChange={(open) => { if (!open) closeStackMonitor(); }}
        stackName={stackMonitor?.stackName ?? ''}
        initialTab={stackMonitor?.tab ?? 'alerts'}
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
          canEdit={can('stack:edit', 'stack', stackName)}
          isDarkMode={isDarkMode}
          onSourceChanged={stackActions.refreshGitSourcePending}
        />
      )}

      {/* Stack config misconfig scan results */}
      <VulnerabilityScanSheet
        scanId={stackMisconfigScanId}
        onClose={() => setStackMisconfigScanId(null)}
        canManageSuppressions={isAdmin}
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
        actionLabel={diffPreview?.mode === 'save-and-deploy' ? 'Save & deploy' : 'Save'}
        confirming={diffPreviewConfirming}
        isDarkMode={isDarkMode}
        onConfirm={async () => {
          const snapshot = diffPreview;
          setDiffPreviewConfirming(true);
          try {
            if (snapshot?.mode === 'save-and-deploy') {
              const saved = await stackActions.saveFile();
              if (saved) await stackActions.deployStack();
            } else {
              await stackActions.saveFile();
            }
          } finally {
            setDiffPreviewConfirming(false);
            setDiffPreview(null);
          }
        }}
      />

      {/* Scan history overlay. Conditionally mounted so the lazy chunk
          only fetches when the user opens the overlay; an always-mounted
          lazy component would fetch on EditorLayout's first render and
          defeat the split. The overlay has no internal state that needs
          to persist across opens. */}
      {securityHistoryOpen ? (
        <LazyBoundary>
          <Suspense fallback={null}>
            <SecurityHistoryView
              open
              onClose={() => setSecurityHistoryOpen(false)}
            />
          </Suspense>
        </LazyBoundary>
      ) : null}
    </>
  );
}
