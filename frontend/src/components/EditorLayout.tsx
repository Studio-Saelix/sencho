import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Plus } from 'lucide-react';
import { UserProfileDropdown } from './UserProfileDropdown';
import { NotificationPanel } from './NotificationPanel';
import { TopBar } from './TopBar';
import { ViewRouter } from './EditorLayout/ViewRouter';
import { CreateStackDialog } from './EditorLayout/CreateStackDialog';
import { EditorView } from './EditorLayout/EditorView';
import { ShellOverlays } from './EditorLayout/ShellOverlays';
import { useEditorViewState } from './EditorLayout/hooks/useEditorViewState';
import { useStackListState } from './EditorLayout/hooks/useStackListState';
import { useViewNavigationState } from './EditorLayout/hooks/useViewNavigationState';
import { useOverlayState } from './EditorLayout/hooks/useOverlayState';
import { useStackActions } from './EditorLayout/hooks/useStackActions';
import { useTheme } from './EditorLayout/hooks/useTheme';
import { useNotifications } from './EditorLayout/hooks/useNotifications';
import { useContainerStats } from './EditorLayout/hooks/useContainerStats';
import { useSidebarContextMenu } from './EditorLayout/hooks/useSidebarContextMenu';
import { NodeSwitcher } from './NodeSwitcher';
import {
    GlobalCommandPalette,
    GlobalCommandPaletteProvider,
    GlobalCommandPaletteTrigger,
} from './GlobalCommandPalette';
import { SENCHO_OPEN_LOGS_EVENT } from '@/lib/events';
import type { SenchoOpenLogsDetail } from '@/lib/events';
import { useNodes } from '@/context/NodeContext';
import { useAuth } from '@/context/AuthContext';
import { useLicense } from '@/context/LicenseContext';
import { useDeployFeedback } from '@/context/DeployFeedbackContext';
import { useTrivyStatus } from '@/hooks/useTrivyStatus';
import { StackSidebar } from '@/components/sidebar/StackSidebar';
import type { StackRowStatus } from '@/components/sidebar/stack-status-utils';
import { useSidebarActivitySummary } from '@/components/sidebar/useSidebarActivitySummary';
import { useNextAutoUpdateRun } from '@/components/sidebar/useNextAutoUpdateRun';
import type { SidebarActivityAction } from '@/components/sidebar/SidebarActivityTicker';
import { useComposeDiffPreviewEnabled } from '@/hooks/use-compose-diff-preview-enabled';
import { toast } from '@/components/ui/toast-store';

export default function EditorLayout() {
  const { isAdmin, can } = useAuth();
  const { isPaid, license } = useLicense();
  const { status: trivy } = useTrivyStatus();
  const { runWithLog, panelState } = useDeployFeedback();

  const editorState = useEditorViewState();
  const {
    stackMisconfigScanning,
    copiedDigest, setCopiedDigest,
    copiedDigestTimerRef,
    content, setContent,
    envContent, setEnvContent,
    envExists,
    envFiles,
    selectedEnvFile,
    containers,
    activeTab, setActiveTab,
    logsMode, setLogsMode,
    gitSourceOpen, setGitSourceOpen,
    gitSourcePendingMap,
    isFileLoading,
    backupInfo,
    isEditing,
    editingCompose, setEditingCompose,
  } = editorState;

  const stackListState = useStackListState();
  const {
    files,
    selectedFile,
    isLoading,
    stackActions: stackActionMap,
    isScanning,
    searchQuery, setSearchQuery,
    stackStatuses,
    stackLabelMap,
    autoUpdateSettings,
    filterChip, setFilterChip,
    bulkMode,
    selectedFiles,
    filterCounts,
    chipFilteredFiles,
    remoteResults,
    isStackBusy,
    refreshStacks,
    fetchAutoUpdateSettings,
    handleScanStacks,
    scheduleStateInvalidateRefresh,
    toggleBulkMode, toggleSelect, clearSelection, handleBulkAction,
    stackUpdates,
    fetchImageUpdates,
    pinned,
    isCollapsed, toggleCollapse,
    remoteSearchLoading,
  } = stackListState;

  const { nodes, activeNode, setActiveNode } = useNodes();

  // Mirror activeNode.id in a ref so async handlers (e.g. CreateStackDialog's
  // post-create handoff) can detect a node switch that happened mid-flight.
  // Closure capture of activeNode would always match the value at handler-creation
  // time and miss the switch.
  const activeNodeIdRef = useRef<number | null>(activeNode?.id ?? null);
  useEffect(() => {
    activeNodeIdRef.current = activeNode?.id ?? null;
  }, [activeNode?.id]);

  const overlayState = useOverlayState();
  const {
    createDialogOpen, setCreateDialogOpen,
  } = overlayState;

  const [diffPreviewEnabled] = useComposeDiffPreviewEnabled();

  // Use a ref to break the circular dependency:
  // useViewNavigationState needs onNavigateToDashboard -> resetEditorState
  // but stackActions isn't created until after navState
  const resetEditorStateRef = useRef<() => void>(() => {});

  const navState = useViewNavigationState({
    onNavigateToDashboard: () => resetEditorStateRef.current(),
  });
  const {
    activeView, setActiveView,
    settingsSection, setSettingsSection,
    securityHistoryOpen, setSecurityHistoryOpen,
    filterNodeId, setFilterNodeId,
    schedulePrefill,
    mobileNavOpen, setMobileNavOpen,
    handleOpenSettings,
    handlePrefillConsumed,
    handleNavigate,
    navItems,
  } = navState;

  const isAdmiral = license?.variant === 'admiral';

  const {
    notifications,
    tickerConnected,
    markAllRead,
    deleteNotification,
    clearAllNotifications,
  } = useNotifications({
    nodes,
    onStateInvalidate: scheduleStateInvalidateRefresh,
    onAutoUpdateChange: fetchAutoUpdateSettings,
    onImageUpdatesChange: fetchImageUpdates,
  });

  const containerStats = useContainerStats(containers);

  const stackActions = useStackActions({
    editorState,
    stackListState,
    navState,
    overlayState,
    activeNode,
    setActiveNode,
    nodes,
    isPaid,
    runWithLog,
    diffPreviewEnabled,
  });

  // Wire the ref now that stackActions is available
  resetEditorStateRef.current = stackActions.resetEditorState;

  const buildMenuCtx = useSidebarContextMenu({
    stackListState,
    navState,
    overlayState,
    stackActions,
    activeNode,
    isPaid,
    isAdmiral,
    can,
  });

  const {
    pendingStackLoadRef,
    pendingLogsRef,
  } = stackActions;

  // Track the moment a deploy panel transitioned to open so the sidebar footer
  // can show elapsed time without depending on internal panel state. The
  // composite key (stack + action) is what flips, so close-then-immediately-reopen
  // is treated as a new session even if isOpen stays true across the commit.
  const [panelStartedAt, setPanelStartedAt] = useState<number | null>(null);
  const panelSessionKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const nextKey = panelState.isOpen ? `${panelState.stackName}::${panelState.action}` : null;
    if (nextKey !== panelSessionKeyRef.current) {
      setPanelStartedAt(nextKey ? Date.now() : null);
      panelSessionKeyRef.current = nextKey;
    }
  }, [panelState.isOpen, panelState.stackName, panelState.action]);

  const autoUpdateEnabledCount = useMemo(
    () => files.reduce((acc, f) => acc + (autoUpdateSettings[f] ? 1 : 0), 0),
    [files, autoUpdateSettings],
  );

  const nextAutoUpdateRunAt = useNextAutoUpdateRun();
  const activitySummary = useSidebarActivitySummary({
    notifications,
    tickerConnected,
    panelState,
    panelStartedAt,
    autoUpdateEnabledCount,
    totalStackCount: files.length,
    nextAutoUpdateRunAt,
  });

  const handleActivityAction = useCallback((action: SidebarActivityAction) => {
    switch (action.kind) {
      case 'open-stack-notification':
        stackActions.navigateToNotification(action.summary.notif);
        return;
      case 'open-auto-updates':
        setActiveView('auto-updates');
        return;
      case 'open-activity':
        setActiveView('global-observability');
        return;
      case 'noop':
        return;
    }
  }, [stackActions, setActiveView]);

  const loadingAction = selectedFile ? (stackActionMap[selectedFile] ?? null) : null;
  const stackName = selectedFile || '';

  const { theme, setTheme, isDarkMode } = useTheme();

  // Re-fetch stacks whenever the active node changes (or becomes available on mount).
  // Also clears any stale editor/container state that belonged to the previous node.
  useEffect(() => {
    if (!activeNode) return;
    const pendingStack = pendingStackLoadRef.current;
    pendingStackLoadRef.current = null;

    stackActions.resetEditorState();

    if (pendingStack) {
      void stackActions.loadFile(pendingStack);
    } else {
      setActiveView('dashboard');
    }

    refreshStacks();
    fetchAutoUpdateSettings();
    void stackActions.refreshGitSourcePending();
  }, [activeNode?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve a pending container name (from notification click) to a live
  // container id once the target stack's container list loads, then dispatch
  // the logs event. Only consume when the current stack matches the pending
  // target — prevents a canceled unsaved-load from leaking the pending name
  // into an unrelated container refresh. Container ids churn across
  // recreations, so we store the name and resolve here instead of storing an
  // id at dispatch time.
  useEffect(() => {
    const pending = pendingLogsRef.current;
    if (!pending || selectedFile !== pending.stackName || containers.length === 0) return;
    pendingLogsRef.current = null;
    const match = containers.find(c =>
      (c.Names ?? []).some(n => n.replace(/^\//, '') === pending.containerName),
    );
    if (match) {
      window.dispatchEvent(new CustomEvent<SenchoOpenLogsDetail>(SENCHO_OPEN_LOGS_EVENT, {
        detail: { containerId: match.Id, containerName: pending.containerName },
      }));
    }
  }, [containers, selectedFile]); // eslint-disable-line react-hooks/exhaustive-deps

  const createStackSlot = can('stack:create') ? (
    <>
      <Button
        variant="outline"
        className="rounded-lg w-full"
        onClick={() => setCreateDialogOpen(true)}
      >
        <Plus className="w-4 h-4 mr-2" />
        Create Stack
      </Button>
      <CreateStackDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onStackCreated={async (sName, sourceNodeId) => {
          await refreshStacks();
          // loadFile keeps its own unsaved-changes overlay (intentional safety,
          // shared with every other "switch to a different stack" code path).
          // Skip the load if the user switched nodes mid-create so we do not
          // 404 against a stack name that lives on the previous node.
          if (sourceNodeId != null && activeNodeIdRef.current !== sourceNodeId) {
            toast.info(`Stack "${sName}" created on the previous node.`);
            return;
          }
          await stackActions.loadFile(sName);
        }}
        onStacksChanged={async () => { await refreshStacks(); }}
      />
    </>
  ) : null;

  return (
    <GlobalCommandPaletteProvider>
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <GlobalCommandPalette
        navItems={navItems}
        onNavigate={handleNavigate}
        onSelectStack={stackActions.loadFileOnNode}
      />
      {/* Left Sidebar (Stacks) */}
      <StackSidebar
        isDarkMode={isDarkMode}
        nodeSwitcherSlot={
          <NodeSwitcher
            onManageNodes={() => handleOpenSettings('nodes')}
          />
        }
        createStackSlot={createStackSlot}
        onScan={handleScanStacks}
        isScanning={isScanning}
        canCreate={can('stack:create')}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        filterChip={filterChip}
        filterCounts={filterCounts}
        onFilterChipChange={setFilterChip}
        list={{
          files: chipFilteredFiles,
          isLoading,
          isPaid,
          selectedFile,
          searchQuery,
          stackLabelMap,
          stackStatuses: stackStatuses as Record<string, StackRowStatus | undefined>,
          stackUpdates,
          gitSourcePendingMap,
          pinnedFiles: pinned,
          isCollapsed,
          toggleCollapse,
          isBusy: isStackBusy,
          getDisplayName: stackActions.getDisplayName,
          onSelectFile: stackActions.loadFile,
          buildMenuCtx,
          remoteResults,
          remoteLoading: remoteSearchLoading,
          onSelectRemoteFile: (nodeId, file) => {
            const node = nodes.find(n => n.id === nodeId);
            if (node) void stackActions.loadFileOnNode(node, file);
          },
        }}
        activitySummary={activitySummary}
        onActivityAction={handleActivityAction}
        bulkMode={bulkMode}
        selectedFiles={selectedFiles}
        isPaid={isPaid}
        onToggleBulkMode={toggleBulkMode}
        onToggleSelect={toggleSelect}
        onClearSelection={clearSelection}
        onBulkAction={handleBulkAction}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <TopBar
          activeView={activeView}
          navItems={navItems}
          onNavigate={handleNavigate}
          mobileNavOpen={mobileNavOpen}
          onMobileNavOpenChange={setMobileNavOpen}
          search={<GlobalCommandPaletteTrigger />}
          notifications={
            <NotificationPanel
              notifications={notifications}
              nodes={nodes}
              onMarkAllRead={markAllRead}
              onClearAll={clearAllNotifications}
              onDelete={deleteNotification}
              onNavigate={stackActions.navigateToNotification}
            />
          }
          userMenu={
            <UserProfileDropdown
              theme={theme}
              setTheme={setTheme}
              onOpenSettings={() => handleOpenSettings('account')}
            />
          }
        />

        {/* Main Workspace */}
        <div key={activeView} className="flex-1 overflow-y-auto p-6 animate-fade-up">
          <ViewRouter
            activeView={activeView}
            selectedFile={selectedFile}
            isLoading={isLoading}
            settingsSection={settingsSection}
            onSettingsSectionChange={setSettingsSection}
            onTemplateDeploySuccess={(sName) => {
              refreshStacks();
              void stackActions.loadFile(sName);
            }}
            onHostConsoleClose={() => setActiveView(selectedFile ? 'editor' : 'dashboard')}
            onFleetNavigateToNode={(nodeId, sName) => {
              const node = nodes.find(n => n.id === nodeId);
              if (node) {
                if (activeNode?.id === nodeId) {
                  void stackActions.loadFile(sName);
                } else {
                  pendingStackLoadRef.current = sName;
                  setActiveNode(node);
                }
              }
            }}
            filterNodeId={filterNodeId}
            onClearScheduledOpsFilter={() => setFilterNodeId(null)}
            schedulePrefill={schedulePrefill}
            onPrefillConsumed={handlePrefillConsumed}
            notifications={notifications}
            onNavigateToStack={(stackFile) => { void stackActions.loadFile(stackFile); }}
            onOpenSettingsSection={(section) => handleOpenSettings(section)}
            onClearNotifications={clearAllNotifications}
            renderEditor={() => (
              <EditorView
                stackName={stackName}
                isDarkMode={isDarkMode}
                containers={containers}
                containerStats={containerStats}
                content={content}
                envContent={envContent}
                envExists={envExists}
                envFiles={envFiles}
                selectedEnvFile={selectedEnvFile}
                isFileLoading={isFileLoading}
                backupInfo={backupInfo}
                gitSourcePendingMap={gitSourcePendingMap}
                notifications={notifications}
                activeTab={activeTab}
                isEditing={isEditing}
                editingCompose={editingCompose}
                logsMode={logsMode}
                copiedDigest={copiedDigest}
                loadingAction={loadingAction}
                stackMisconfigScanning={stackMisconfigScanning}
                can={can}
                isAdmin={isAdmin}
                isPaid={isPaid}
                trivy={trivy}
                activeNode={activeNode}
                copiedDigestTimerRef={copiedDigestTimerRef}
                deployStack={stackActions.deployStack}
                restartStack={stackActions.restartStack}
                stopStack={stackActions.stopStack}
                updateStack={stackActions.updateStack}
                rollbackStack={stackActions.rollbackStack}
                scanStackConfig={stackActions.scanStackConfig}
                enterEditMode={stackActions.enterEditMode}
                requestSave={stackActions.requestSave}
                requestSaveAndDeploy={stackActions.requestSaveAndDeploy}
                discardChanges={stackActions.discardChanges}
                setContent={setContent}
                setEnvContent={setEnvContent}
                changeEnvFile={stackActions.changeEnvFile}
                openLogViewer={stackActions.openLogViewer}
                openBashModal={stackActions.openBashModal}
                serviceAction={stackActions.serviceAction}
                setActiveTab={setActiveTab}
                setLogsMode={setLogsMode}
                setEditingCompose={setEditingCompose}
                setGitSourceOpen={setGitSourceOpen}
                setCopiedDigest={setCopiedDigest}
                requestDeleteStack={stackActions.requestDeleteStack}
              />
            )}
          />
        </div>
      </div>

      <ShellOverlays
        overlayState={overlayState}
        stackActions={stackActions}
        isDarkMode={isDarkMode}
        isAdmin={isAdmin}
        can={can}
        selectedFile={selectedFile}
        stackName={stackName}
        gitSourceOpen={gitSourceOpen}
        setGitSourceOpen={setGitSourceOpen}
        securityHistoryOpen={securityHistoryOpen}
        setSecurityHistoryOpen={setSecurityHistoryOpen}
      />
    </div>
    </GlobalCommandPaletteProvider>
  );
}
