import { useState, useCallback, useEffect } from 'react';
import { SENCHO_OPEN_LOGS_EVENT } from '@/lib/events';
import type { SenchoOpenLogsDetail } from '@/lib/events';
import type { PolicyBlockPayload, PolicyBlockableAction } from '../../stack/PolicyBlockDialog';
import type { PreDeployScanImage } from '@/types/security';
import type { Node } from '@/context/NodeContext';

type DiffPreview = {
  mode: 'save' | 'save-and-deploy';
  language: 'yaml' | 'ini';
  original: string;
  modified: string;
  fileName: string;
};

type PolicyBlock = {
  stackName: string;
  stackFile: string;
  action: PolicyBlockableAction;
  payload: PolicyBlockPayload;
  // Node captured when the block was raised, so a bypass retry (deploy, update,
  // or rollback) targets that node even if the active node changes while the
  // dialog is open.
  nodeId: number | null;
};
type Container = { id: string; name: string };

type InspectImageSelection = {
  Id: string;
  RepoTags: string[];
  usedByStacks: string[];
  nodeId: number;
};

type StackMonitorState = {
  stackName: string;
  tab: 'alerts' | 'auto-heal';
  serviceName?: string;
};

// Kept here (not in useStackActions) so overlay state can hold load options
// without a circular type import between the two hooks.
export type LoadFileOptions = {
  startInComposeEdit?: boolean;
  // Skip the unsaved-changes deferral. Used by discardAndLoadPending after
  // buffers have been reverted via setters that have not re-rendered yet, so
  // hasUnsavedChanges() would still see the pre-discard values.
  skipUnsavedCheck?: boolean;
};

export function useOverlayState() {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [stackToDelete, setStackToDelete] = useState<string | null>(null);
  const openDeleteDialog = useCallback((stackName: string) => {
    setStackToDelete(stackName);
    setDeleteDialogOpen(true);
  }, []);
  const closeDeleteDialog = useCallback(() => {
    setDeleteDialogOpen(false);
    setStackToDelete(null);
  }, []);

  const [takeDownDialogOpen, setTakeDownDialogOpen] = useState(false);
  const [stackToTakeDown, setStackToTakeDown] = useState<string | null>(null);
  const openTakeDownDialog = useCallback((stackName: string) => {
    setStackToTakeDown(stackName);
    setTakeDownDialogOpen(true);
  }, []);
  const closeTakeDownDialog = useCallback(() => {
    setTakeDownDialogOpen(false);
    setStackToTakeDown(null);
  }, []);

  const [pendingUnsavedLoad, setPendingUnsavedLoad] = useState<string | null>(null);
  // Parallel to pendingUnsavedLoad: options for the deferred stack load after
  // the unsaved-changes dialog. Cleared on cancel and on node-switch paths
  // (which use NODE_SWITCH_PENDING_TOKEN and never carry load options).
  const [pendingLoadOptions, setPendingLoadOptions] = useState<LoadFileOptions | null>(null);
  const [pendingUnsavedNode, setPendingUnsavedNode] = useState<Node | null>(null);
  // A deferred "leave the dirty editor" navigation (back to the list, Home, a
  // bottom-tab / hamburger destination). Wrapped in an object so the state
  // setter is not mistaken for a functional update. Runs after the user
  // confirms the unsaved-changes dialog. See useStackActions.attemptLeaveEditor.
  const [pendingLeaveAction, setPendingLeaveAction] = useState<{
    run: () => void;
    onCancel?: () => void;
  } | null>(null);

  const [bashModalOpen, setBashModalOpen] = useState(false);
  const [selectedContainer, setSelectedContainer] = useState<Container | null>(null);
  const openBashModal = useCallback((container: Container) => {
    setSelectedContainer(container);
    setBashModalOpen(true);
  }, []);
  const closeBashModal = useCallback(() => {
    setBashModalOpen(false);
    setSelectedContainer(null);
  }, []);

  const [logViewerOpen, setLogViewerOpen] = useState(false);
  const [logContainer, setLogContainer] = useState<Container | null>(null);
  const openLogViewer = useCallback((container: Container) => {
    setLogContainer(container);
    setLogViewerOpen(true);
  }, []);
  const closeLogViewer = useCallback(() => {
    setLogViewerOpen(false);
    setLogContainer(null);
  }, []);

  const [inspectImage, setInspectImage] = useState<InspectImageSelection | null>(null);
  const openInspectImage = useCallback((image: InspectImageSelection) => setInspectImage(image), []);
  const closeInspectImage = useCallback(() => setInspectImage(null), []);

  // Listen for topology click-to-logs events and open the log viewer.
  // openLogViewer is stable (useCallback with empty deps), so this effect
  // mounts/unmounts once and never re-registers.
  useEffect(() => {
    const handler = (e: Event) => {
      const { containerId, containerName } = (e as CustomEvent<SenchoOpenLogsDetail>).detail;
      openLogViewer({ id: containerId, name: containerName });
    };
    window.addEventListener(SENCHO_OPEN_LOGS_EVENT, handler);
    return () => window.removeEventListener(SENCHO_OPEN_LOGS_EVENT, handler);
  }, [openLogViewer]); // openLogViewer is stable (useCallback with empty deps)

  const [stackMonitor, setStackMonitor] = useState<StackMonitorState | null>(null);
  const openAlertSheet = useCallback((stackName: string, opts?: { serviceName?: string }) => {
    setStackMonitor({ stackName, tab: 'alerts', serviceName: opts?.serviceName });
  }, []);
  const openAutoHeal = useCallback((stackName: string, opts?: { serviceName?: string }) => {
    setStackMonitor({ stackName, tab: 'auto-heal', serviceName: opts?.serviceName });
  }, []);
  const closeStackMonitor = useCallback(() => setStackMonitor(null), []);

  const [policyBlock, setPolicyBlock] = useState<PolicyBlock | null>(null);
  const [policyBypassing, setPolicyBypassing] = useState(false);

  // Pre-update readiness dialog. `proceed` runs the actual update when the
  // user confirms; opened by useStackActions.requestStackUpdate (full stack)
  // or requestServiceUpdate (a single declared service). `nodeId` is captured
  // at open time so both the readiness fetch and the update run against the
  // same node even if the active node changes while the dialog is open.
  // `serviceName`/`mode` are set only for a service-scoped update; absent
  // means the full-stack readiness check, unchanged from before.
  const [updateReadiness, setUpdateReadiness] = useState<{
    stackName: string;
    stackFile: string;
    nodeId: number | null;
    serviceName?: string;
    mode?: 'update' | 'rebuild';
    proceed: () => void;
  } | null>(null);

  // Pre-deploy scan advisory dialog. `proceed` runs the actual deploy when the
  // user confirms; opened by useStackActions.deployStack when the advisory
  // setting is on. Callback continuation (like updateReadiness), so cancel /
  // close / unmount simply discards it with no pending action to leak.
  const [preDeployAdvisory, setPreDeployAdvisory] = useState<{
    stackName: string;
    images: PreDeployScanImage[];
    proceed: () => void;
    cancel: () => void;
  } | null>(null);

  const [missingExternalNetworks, setMissingExternalNetworks] = useState<{
    payload: import('../../stack/MissingExternalNetworksDialog').MissingExternalNetworksPayload;
    creating: boolean;
    cancel: () => void;
    openNetworking: () => void;
    createAndContinue: () => void;
  } | null>(null);

  const [selfStackProtectedOpen, setSelfStackProtectedOpen] = useState(false);
  const openSelfStackProtected = useCallback(() => setSelfStackProtectedOpen(true), []);
  const closeSelfStackProtected = useCallback(() => setSelfStackProtectedOpen(false), []);

  /** Captured when Save & Reapply opens confirm; cleared on cancel, confirm, or ownership drift. */
  const [composeReapplyCapture, setComposeReapplyCapture] = useState<{
    nodeId: number;
    nodeType: 'local' | 'remote';
    nodeName: string;
    stackFile: string;
  } | null>(null);

  const [stackMisconfigScanId, setStackMisconfigScanId] = useState<number | null>(null);

  const [diffPreview, setDiffPreview] = useState<DiffPreview | null>(null);
  const [diffPreviewConfirming, setDiffPreviewConfirming] = useState(false);

  return {
    createDialogOpen, setCreateDialogOpen,
    deleteDialogOpen, stackToDelete, openDeleteDialog, closeDeleteDialog,
    takeDownDialogOpen, stackToTakeDown, openTakeDownDialog, closeTakeDownDialog,
    pendingUnsavedLoad, setPendingUnsavedLoad,
    pendingLoadOptions, setPendingLoadOptions,
    pendingUnsavedNode, setPendingUnsavedNode,
    pendingLeaveAction, setPendingLeaveAction,
    bashModalOpen, selectedContainer, openBashModal, closeBashModal,
    logViewerOpen, logContainer, openLogViewer, closeLogViewer,
    inspectImage, openInspectImage, closeInspectImage,
    stackMonitor, openAlertSheet, openAutoHeal, closeStackMonitor,
    policyBlock, setPolicyBlock, policyBypassing, setPolicyBypassing,
    updateReadiness, setUpdateReadiness,
    preDeployAdvisory, setPreDeployAdvisory,
    missingExternalNetworks, setMissingExternalNetworks,
    selfStackProtectedOpen, setSelfStackProtectedOpen, openSelfStackProtected, closeSelfStackProtected,
    composeReapplyCapture, setComposeReapplyCapture,
    stackMisconfigScanId, setStackMisconfigScanId,
    diffPreview, setDiffPreview, diffPreviewConfirming, setDiffPreviewConfirming,
  } as const;
}

export type OverlayState = ReturnType<typeof useOverlayState>;
