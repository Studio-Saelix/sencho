import { useState, useCallback, useEffect } from 'react';
import { SENCHO_OPEN_LOGS_EVENT } from '@/lib/events';
import type { SenchoOpenLogsDetail } from '@/lib/events';
import type { PolicyBlockPayload } from '../../stack/PolicyBlockDialog';
import type { Node } from '@/context/NodeContext';

type DiffPreview = {
  mode: 'save' | 'save-and-deploy';
  language: 'yaml' | 'ini';
  original: string;
  modified: string;
  fileName: string;
};

type PolicyBlock = { stackName: string; payload: PolicyBlockPayload };
type Container = { id: string; name: string };

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

  const [pendingUnsavedLoad, setPendingUnsavedLoad] = useState<string | null>(null);
  const [pendingUnsavedNode, setPendingUnsavedNode] = useState<Node | null>(null);

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

  const [stackMonitor, setStackMonitor] = useState<{ stackName: string; tab: 'alerts' | 'auto-heal' } | null>(null);
  const openAlertSheet = useCallback((stackName: string) => {
    setStackMonitor({ stackName, tab: 'alerts' });
  }, []);
  const openAutoHeal = useCallback((stackName: string) => {
    setStackMonitor({ stackName, tab: 'auto-heal' });
  }, []);
  const closeStackMonitor = useCallback(() => setStackMonitor(null), []);

  const [policyBlock, setPolicyBlock] = useState<PolicyBlock | null>(null);
  const [policyBypassing, setPolicyBypassing] = useState(false);

  const [stackMisconfigScanId, setStackMisconfigScanId] = useState<number | null>(null);

  const [diffPreview, setDiffPreview] = useState<DiffPreview | null>(null);
  const [diffPreviewConfirming, setDiffPreviewConfirming] = useState(false);

  return {
    createDialogOpen, setCreateDialogOpen,
    deleteDialogOpen, stackToDelete, openDeleteDialog, closeDeleteDialog,
    pendingUnsavedLoad, setPendingUnsavedLoad,
    pendingUnsavedNode, setPendingUnsavedNode,
    bashModalOpen, selectedContainer, openBashModal, closeBashModal,
    logViewerOpen, logContainer, openLogViewer, closeLogViewer,
    stackMonitor, openAlertSheet, openAutoHeal, closeStackMonitor,
    policyBlock, setPolicyBlock, policyBypassing, setPolicyBypassing,
    stackMisconfigScanId, setStackMisconfigScanId,
    diffPreview, setDiffPreview, diffPreviewConfirming, setDiffPreviewConfirming,
  } as const;
}

export type OverlayState = ReturnType<typeof useOverlayState>;
