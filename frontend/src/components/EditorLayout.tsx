import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import { Plus, Loader2, ChevronLeft } from 'lucide-react';
import { UserProfileDropdown } from './UserProfileDropdown';
import { NotificationPanel } from './NotificationPanel';
import { TopBar } from './TopBar';
import { ViewRouter } from './EditorLayout/ViewRouter';
import { CreateStackDialog, type CreateMode } from './EditorLayout/CreateStackDialog';
import { EditorView } from './EditorLayout/EditorView';
import { ShellOverlays } from './EditorLayout/ShellOverlays';
import { useEditorViewState } from './EditorLayout/hooks/useEditorViewState';
import { useStackListState } from './EditorLayout/hooks/useStackListState';
import { useViewNavigationState } from './EditorLayout/hooks/useViewNavigationState';
import { useOverlayState } from './EditorLayout/hooks/useOverlayState';
import { useStackActions, NODE_SWITCH_PENDING_TOKEN } from './EditorLayout/hooks/useStackActions';
import { useTheme } from '@/hooks/use-theme';
import { ThemeQuickSwitch } from './theme/ThemeQuickSwitch';
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
import { useDeployFeedback } from '@/context/DeployFeedbackContext';
import { useTrivyStatus } from '@/hooks/useTrivyStatus';
import { StackSidebar } from '@/components/sidebar/StackSidebar';
import type { StackRowStatus } from '@/components/sidebar/stack-status-utils';
import { useSidebarActivitySummary } from '@/components/sidebar/useSidebarActivitySummary';
import { useNextAutoUpdateRun } from '@/components/sidebar/useNextAutoUpdateRun';
import { usePanelSessionStartedAt } from '@/components/sidebar/usePanelSessionStartedAt';
import type { SidebarActivityAction } from '@/components/sidebar/SidebarActivityTicker';
import { useComposeDiffPreviewEnabled } from '@/hooks/use-compose-diff-preview-enabled';
import { toast } from '@/components/ui/toast-store';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { MobileTabBar } from './MobileTabBar';
import { MobileMoreMenu } from './MobileMoreMenu';
import { MobileDashboard } from './mobile/MobileDashboard';
import { deriveMobileSurface, type MobileView } from './EditorLayout/mobile-surface';
import type { SectionId } from './settings/types';

// Content views that render a bespoke, masthead-led mobile screen instead of the
// reflowed desktop workspace. For these the global TopBar is dropped on mobile
// (each screen's masthead leads). The set grows as screens are re-skinned.
const BESPOKE_MOBILE_VIEWS = new Set<string>(['dashboard']);

export default function EditorLayout() {
  const { isAdmin, can } = useAuth();
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
    selectedFile,
    isLoading,
    stackActions: stackActionMap,
    isScanning,
    searchQuery, setSearchQuery,
    stackStatuses,
    stackLabelMap,
    filterChip, setFilterChip,
    bulkMode,
    selectedFiles,
    filterCounts,
    chipFilteredFiles,
    remoteResults,
    isStackBusy,
    refreshStacks,
    handleScanStacks,
    scheduleStateInvalidateRefresh,
    toggleBulkMode, toggleSelect, clearSelection, handleBulkAction,
    stackUpdates,
    fetchImageUpdates,
    pinned,
    isCollapsed, toggleCollapse,
    remoteSearchLoading,
    remoteSearchFailedNodes,
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

  // Which mode the create dialog opens on. The toolbar Create button opens on
  // 'empty'; the zero-stacks empty state opens on 'import'.
  const [createDialogInitialMode, setCreateDialogInitialMode] = useState<CreateMode>('empty');
  const openCreateDialog = useCallback((mode: CreateMode) => {
    setCreateDialogInitialMode(mode);
    setCreateDialogOpen(true);
  }, [setCreateDialogOpen]);

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

  const {
    notifications,
    tickerConnected,
    markAllRead,
    deleteNotification,
    clearAllNotifications,
  } = useNotifications({
    nodes,
    onStateInvalidate: scheduleStateInvalidateRefresh,
    onImageUpdatesChange: fetchImageUpdates,
  });

  const { stats: containerStats, error: containerStatsError } = useContainerStats(
    containers,
    activeNode?.id ?? null,
  );

  const stackActions = useStackActions({
    editorState,
    stackListState,
    navState,
    overlayState,
    activeNode,
    setActiveNode,
    nodes,
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
    isAdmin,
    can,
  });

  const {
    pendingStackLoadRef,
    pendingLogsRef,
  } = stackActions;

  const panelStartedAt = usePanelSessionStartedAt(panelState);

  const nextAutoUpdateRunAt = useNextAutoUpdateRun();
  const activitySummary = useSidebarActivitySummary({
    notifications,
    tickerConnected,
    panelState,
    panelStartedAt,
    nextAutoUpdateRunAt,
  });

  const loadingAction = selectedFile ? (stackActionMap[selectedFile] ?? null) : null;
  const stackName = selectedFile || '';

  const { isDarkMode } = useTheme();

  // ---- Mobile shell (below md) ---------------------------------------------
  // Desktop renders the persistent sidebar + workspace untouched. On a phone we
  // show exactly one surface at a time: the stack list, a top-level view, or a
  // full-screen stack detail. `mobileView` is explicit state, decoupled from
  // `activeView`, so 'dashboard' still maps to HomeDashboard everywhere.
  const isMobile = useIsMobile();
  const [mobileView, setMobileView] = useState<MobileView>('list');
  // Optimistically flip to the detail surface the instant a row is tapped,
  // before loadFile's fetch resolves selectedFile; cleared once it settles.
  const [pendingDetailStack, setPendingDetailStack] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!isFileLoading && pendingDetailStack) setPendingDetailStack(null);
  }, [isFileLoading, pendingDetailStack]);

  const { surface: mobileSurface, detailReady, detailOpen } = deriveMobileSurface({
    activeView,
    selectedFile,
    mobileView,
    pendingDetailStack,
  });

  // A phone shows one surface at a time, so every mobile navigation tears down
  // the current detail and switches surfaces, guarding a dirty editor first.
  // `then` runs the destination-specific work (navigate to a view, open
  // settings) after the surface flips.
  const leaveToMobileSurface = (target: MobileView, then?: () => void) => {
    stackActions.attemptLeaveEditor(() => {
      stackActions.resetEditorState();
      setPendingDetailStack(null);
      setMobileView(target);
      then?.();
    });
  };

  const goToMobileList = () => leaveToMobileSurface('list');
  const navigateMobileAware = (view: string) => leaveToMobileSurface('content', () => handleNavigate(view));
  const openSettingsMobileAware = (section?: SectionId) =>
    leaveToMobileSurface('content', () => handleOpenSettings(section));

  // Settings navigation from outside the bottom bar (profile menu, node
  // switcher, dashboard config links). On mobile it flips to the content
  // surface so the section is actually shown instead of leaving the user on
  // the stack list; on desktop it is the plain open.
  const openSettings = (section?: SectionId) =>
    (isMobile ? openSettingsMobileAware(section) : handleOpenSettings(section));

  // Tapping a stack row on mobile flips to the detail surface immediately.
  const handleSelectStack = (file: string) => {
    if (isMobile) setPendingDetailStack(file);
    void stackActions.loadFile(file);
  };

  // Hamburger / command-palette navigation is mobile-aware so it collapses the
  // current surface and honors the unsaved-changes guard; desktop is untouched.
  const navHandler = isMobile ? navigateMobileAware : handleNavigate;

  // Sidebar activity actions navigate to top-level views. On mobile they must
  // flip the surface to content (otherwise the user stays on the stack list);
  // on desktop they set the view directly as before.
  const handleActivityAction = useCallback((action: SidebarActivityAction) => {
    switch (action.kind) {
      case 'open-stack-notification':
        stackActions.navigateToNotification(action.summary.notif);
        return;
      case 'open-auto-updates':
        if (isMobile) navigateMobileAware('auto-updates');
        else setActiveView('auto-updates');
        return;
      case 'open-activity':
        if (isMobile) navigateMobileAware('global-observability');
        else setActiveView('global-observability');
        return;
      case 'noop':
        return;
    }
  }, [stackActions, setActiveView, isMobile, navigateMobileAware]);

  const renderEditor = () => (
    <EditorView
      stackName={stackName}
      isDarkMode={isDarkMode}
      containers={containers}
      containerStats={containerStats}
      containerStatsError={containerStatsError}
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
      onMobileBack={goToMobileList}
    />
  );

  // Track the last "committed" node id so the node-switch dirty guard can
  // detect an actual switch (vs the initial mount or an internal revert).
  const lastSeenNodeIdRef = useRef<number | null>(activeNode?.id ?? null);
  // Set true when we revert activeNode after stashing a pending switch, so the
  // re-fire of this effect on the reverted id is a no-op.
  const revertingNodeSwitchRef = useRef(false);

  // Re-fetch stacks whenever the active node changes (or becomes available on mount).
  // Also clears any stale editor/container state that belonged to the previous node.
  useEffect(() => {
    if (revertingNodeSwitchRef.current) {
      revertingNodeSwitchRef.current = false;
      return;
    }
    if (!activeNode) return;

    const previousId = lastSeenNodeIdRef.current;
    const isRealSwitch = previousId !== null && previousId !== activeNode.id;

    // A node-switch prompt is already open. Ignore any further activeNode
    // changes until the user resolves the current dialog; revert silently so
    // the dialog's pendingUnsavedNode stays anchored to the first attempt.
    if (isRealSwitch && overlayState.pendingUnsavedLoad === NODE_SWITCH_PENDING_TOKEN) {
      const previousNode = nodes.find(n => n.id === previousId);
      if (previousNode) {
        revertingNodeSwitchRef.current = true;
        setActiveNode(previousNode);
      }
      return;
    }

    if (isRealSwitch && stackActions.hasUnsavedChanges()) {
      const previousNode = nodes.find(n => n.id === previousId);
      if (previousNode) {
        // Stash the attempted node + open the unsaved-changes dialog via the
        // existing pendingUnsavedLoad/Node fields. Revert activeNode back to
        // the previous node; the revertingNodeSwitchRef makes the resulting
        // effect fire a no-op so dirty content survives.
        overlayState.setPendingUnsavedNode(activeNode);
        overlayState.setPendingUnsavedLoad(NODE_SWITCH_PENDING_TOKEN);
        revertingNodeSwitchRef.current = true;
        setActiveNode(previousNode);
        return;
      }
      // Previous node is no longer reachable from the nodes list (deleted or
      // dropped from the registry). We cannot revert, so the unsaved edits
      // will be lost. Warn the operator before the wipe so the loss is at
      // least visible.
      toast.warning('Unsaved changes were discarded: the previous node is no longer available.');
    }

    lastSeenNodeIdRef.current = activeNode.id;

    const pendingStack = pendingStackLoadRef.current;
    pendingStackLoadRef.current = null;

    stackActions.resetEditorState();

    if (pendingStack) {
      void stackActions.loadFile(pendingStack);
    } else {
      setActiveView('dashboard');
    }

    refreshStacks();
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
        onClick={() => openCreateDialog('empty')}
      >
        <Plus className="w-4 h-4" />
        Create Stack
      </Button>
      <CreateStackDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        initialMode={createDialogInitialMode}
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
    {(() => {
      const commandPaletteEl = (
        <GlobalCommandPalette
          navItems={navItems}
          onNavigate={navHandler}
          onSelectStack={stackActions.loadFileOnNode}
        />
      );

      const sidebarEl = (
        <StackSidebar
          isDarkMode={isDarkMode}
          nodeSwitcherSlot={
            <NodeSwitcher
              onManageNodes={() => openSettings('nodes')}
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
            onSelectFile: handleSelectStack,
            buildMenuCtx,
            remoteResults,
            remoteLoading: remoteSearchLoading,
            remoteFailedNodes: remoteSearchFailedNodes,
            onSelectRemoteFile: (nodeId, file) => {
              const node = nodes.find(n => n.id === nodeId);
              if (node) void stackActions.loadFileOnNode(node, file);
            },
            filterChip,
            onOpenCreate: can('stack:create') ? openCreateDialog : undefined,
          }}
          activitySummary={activitySummary}
          onActivityAction={handleActivityAction}
          bulkMode={bulkMode}
          selectedFiles={selectedFiles}
          onToggleBulkMode={toggleBulkMode}
          onToggleSelect={toggleSelect}
          onClearSelection={clearSelection}
          onBulkAction={handleBulkAction}
        />
      );

      const notificationsEl = (
        <NotificationPanel
          notifications={notifications}
          nodes={nodes}
          onMarkAllRead={markAllRead}
          onClearAll={clearAllNotifications}
          onDelete={deleteNotification}
          onNavigate={stackActions.navigateToNotification}
        />
      );
      const themeSwitchEl = <ThemeQuickSwitch />;
      const userMenuEl = <UserProfileDropdown onOpenSettings={() => openSettings('account')} />;

      const topBarEl = (
        <TopBar
          activeView={activeView}
          navItems={navItems}
          onNavigate={navHandler}
          mobileNavOpen={mobileNavOpen}
          onMobileNavOpenChange={setMobileNavOpen}
          search={<GlobalCommandPaletteTrigger />}
          themeSwitch={themeSwitchEl}
          notifications={notificationsEl}
          userMenu={userMenuEl}
        />
      );

      // On the bespoke mobile screens the TopBar is dropped, so notifications and
      // the secondary-destinations menu are rehomed into each screen's masthead
      // right slot.
      const mobileMastheadActions = (
        <div className="flex items-center gap-0.5">
          {notificationsEl}
          <MobileMoreMenu
            navItems={navItems}
            activeView={activeView}
            onNavigate={navigateMobileAware}
            footer={<>{themeSwitchEl}{userMenuEl}</>}
          />
        </div>
      );

      const workspaceEl = (
        <div key={activeView} className="flex-1 overflow-y-auto p-6 max-md:p-4 animate-fade-up">
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
            onOpenSettingsSection={(section) => openSettings(section)}
            onClearNotifications={clearAllNotifications}
            renderEditor={renderEditor}
          />
        </div>
      );

      const shellOverlaysEl = (
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
      );

      // Bespoke, masthead-led mobile screens. When showing one, the TopBar is
      // dropped and the screen renders its own masthead (with notifications +
      // more-menu rehomed into the right slot).
      const bespokeContent = mobileSurface === 'content' && BESPOKE_MOBILE_VIEWS.has(activeView);
      const renderMobileBespoke = () => {
        switch (activeView) {
          case 'dashboard':
            return (
              <MobileDashboard
                notifications={notifications}
                headerActions={mobileMastheadActions}
                onNavigateToStack={handleSelectStack}
                onViewAllStacks={goToMobileList}
              />
            );
          default:
            return workspaceEl;
        }
      };

      if (isMobile) {
        return (
          <div className="flex h-screen w-screen flex-col overflow-hidden app-canvas text-foreground">
            {commandPaletteEl}
            {mobileSurface !== 'detail' && !bespokeContent && topBarEl}
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              {mobileSurface === 'list' && sidebarEl}
              {mobileSurface === 'content' && (bespokeContent ? renderMobileBespoke() : workspaceEl)}
              {mobileSurface === 'detail' && (
                detailReady ? (
                  <div className="flex-1 min-h-0 overflow-hidden flex flex-col">{renderEditor()}</div>
                ) : (
                  <MobileDetailLoading name={pendingDetailStack ?? ''} onBack={goToMobileList} />
                )
              )}
            </div>
            <MobileTabBar
              navItems={navItems}
              activeView={activeView}
              mobileView={mobileView}
              detailOpen={detailOpen}
              onHome={() => navigateMobileAware('dashboard')}
              onStacks={goToMobileList}
              onNavigate={navigateMobileAware}
              onSettings={openSettingsMobileAware}
            />
            {shellOverlaysEl}
          </div>
        );
      }

      return (
        <div className="flex h-screen w-screen overflow-hidden app-canvas text-foreground">
          {commandPaletteEl}
          {/* Left Sidebar (Stacks) */}
          {sidebarEl}
          {/* Main Content Area */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {topBarEl}
            {/* Main Workspace */}
            {workspaceEl}
          </div>
          {shellOverlaysEl}
        </div>
      );
    })()}
    </GlobalCommandPaletteProvider>
  );
}

// Optimistic stack-detail placeholder shown on mobile the instant a row is
// tapped, until loadFile resolves and the real EditorView mounts. Keeps the tap
// feeling immediate on slow networks.
function MobileDetailLoading({ name, onBack }: { name: string; onBack: () => void }) {
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-1 border-b border-hairline px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to stacks"
          className="inline-flex min-h-11 items-center gap-1 pr-3 font-mono text-xs text-brand"
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={1.6} />
          Stacks
        </button>
        <span className="truncate font-display text-2xl italic text-stat-value">
          {name.replace(/\.(ya?ml)$/, '')}
        </span>
      </div>
      <div className="flex flex-1 items-center justify-center text-stat-subtitle">
        <Loader2 className="h-5 w-5 animate-spin" strokeWidth={1.5} />
      </div>
    </div>
  );
}
