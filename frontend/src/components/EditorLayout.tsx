import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from './ui/button';
import { Plus, Loader2, ChevronLeft, AlertCircle, RefreshCw } from 'lucide-react';
import { UserProfileDropdown } from './UserProfileDropdown';
import { NotificationPanel } from './NotificationPanel';
import { TopBar } from './TopBar';
import { ViewRouter } from './EditorLayout/ViewRouter';
import { CreateStackDialog, type CreateMode } from './EditorLayout/CreateStackDialog';
import { AdoptExistingDialog } from './EditorLayout/AdoptExistingDialog';
import { EditorView } from './EditorLayout/EditorView';
import { ShellOverlays } from './EditorLayout/ShellOverlays';
import type { VolumePreservationOnDelete } from './EditorLayout/DeleteStackDialog';
import { classifyFailedGate } from './EditorLayout/failed-gate-recovery';
import { useEditorViewState } from './EditorLayout/hooks/useEditorViewState';
import { useStackListState } from './EditorLayout/hooks/useStackListState';
import { useViewNavigationState } from './EditorLayout/hooks/useViewNavigationState';
import { useUrlSync } from './EditorLayout/hooks/useUrlSync';
import { shouldClearPendingDetailStack } from './EditorLayout/mobile-pending-detail';
import { useOverlayState } from './EditorLayout/hooks/useOverlayState';
import { useStackActions, NODE_SWITCH_PENDING_TOKEN } from './EditorLayout/hooks/useStackActions';
import { useSelectedStackLiveRefresh } from './EditorLayout/hooks/useSelectedStackLiveRefresh';
import { useTheme } from '@/hooks/use-theme';
import { ThemeQuickSwitch } from './theme/ThemeQuickSwitch';
import { useNotifications } from './EditorLayout/hooks/useNotifications';
import { useContainerStats } from './EditorLayout/hooks/useContainerStats';
import { useSidebarContextMenu } from './EditorLayout/hooks/useSidebarContextMenu';
import { useActiveNodeReapplyEligibility } from './EditorLayout/hooks/useActiveNodeReapplyEligibility';
import { resolveCanSaveAndReapply } from './EditorLayout/resolveCanSaveAndReapply';
import { useComposeReapplyAction } from './FleetView/hooks/useComposeReapplyAction';
import { NodeSwitcher } from './NodeSwitcher';
import {
    GlobalCommandPalette,
    GlobalCommandPaletteProvider,
    GlobalCommandPaletteTrigger,
} from './GlobalCommandPalette';
import { SENCHO_OPEN_LOGS_EVENT, SENCHO_OPEN_STACK_EVENT } from '@/lib/events';
import type { SenchoOpenLogsDetail, SenchoOpenStackDetail } from '@/lib/events';
import { useNodes } from '@/context/NodeContext';
import { STACK_DOWN_REMOVE_VOLUMES_CAPABILITY, STACK_DELETE_PRUNE_VOLUMES_CAPABILITY } from '@/lib/capabilities';
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
import { useTopNavLabels } from '@/hooks/use-top-nav-labels';
import { useTopNavAlign } from '@/hooks/use-top-nav-align';
import { useTopNavMode } from '@/hooks/use-top-nav-mode';
import { useTopNavQuickLinks } from '@/hooks/use-top-nav-quick-links';
import { getAppNavItem } from '@/lib/navigation/appNavRegistry';
import { useStackMuteActions } from '@/hooks/useMuteRuleActions';
import { useServiceUpdateStatus } from '@/hooks/useServiceUpdateStatus';
import { toast } from '@/components/ui/toast-store';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { MobileTabBar } from './MobileTabBar';
import { MobileMoreMenu } from './MobileMoreMenu';
import { Masthead, type Tone } from './mobile/mobile-ui';
import { MobileDashboard } from './mobile/MobileDashboard';
import { MobileFleet } from './mobile/MobileFleet';
import { MobileSchedules } from './mobile/MobileSchedules';
import { MobileSettings } from './mobile/MobileSettings';
import { deriveMobileSurface, type MobileView } from './EditorLayout/mobile-surface';
import { BESPOKE_MOBILE_VIEWS } from './EditorLayout/mobile-treatments';
import { CapabilityGate } from './CapabilityGate';
import { HubOnlyGate } from './HubOnlyGate';
import { HydrationTimingPanel } from './HydrationTimingPanel';
import { useDeveloperMode } from '@/hooks/useDeveloperMode';
import { markMilestone } from '@/lib/hydrationTiming';
import type { SectionId } from './settings/types';
import type { NotificationItem } from './dashboard/types';

// These bespoke phone screens reuse the desktop view's component (with a mobile
// branch), code-split exactly like the desktop content path so the heavy chunks
// stay out of the main shell bundle.
const SecurityView = lazy(() => import('./SecurityView').then(m => ({ default: m.SecurityView })));
const AutoUpdateReadinessView = lazy(() => import('./AutoUpdateReadinessView'));
const AppStoreView = lazy(() => import('./AppStoreView').then(m => ({ default: m.AppStoreView })));
const AuditLogView = lazy(() => import('./AuditLogView').then(m => ({ default: m.AuditLogView })));
const ResourcesView = lazy(() => import('./ResourcesView'));
const NetworkingView = lazy(() => import('./networking/NetworkingView').then(m => ({ default: m.NetworkingView })));
const GlobalObservabilityView = lazy(() => import('./GlobalObservabilityView').then(m => ({ default: m.GlobalObservabilityView })));

/**
 * NodeContext records an unfetched or failed /api/meta as an empty capability list, so an
 * empty list means "not confirmed either way", never "confirmed without the capability".
 * Reporting that as 'unsupported' would force the destructive delete default onto a node
 * that may well preserve volumes, so it maps to 'unknown' instead.
 */
function resolveDeleteVolumePreservation(capabilities: string[] | undefined): VolumePreservationOnDelete {
  if (capabilities == null || capabilities.length === 0) return 'unknown';
  return capabilities.includes(STACK_DELETE_PRUNE_VOLUMES_CAPABILITY) ? 'supported' : 'unsupported';
}

export default function EditorLayout() {
  const { isAdmin, can, permissions, permissionsStatus } = useAuth();
  const { status: trivy } = useTrivyStatus();
  const { runWithLog, panelState, logRows, healthGate } = useDeployFeedback();

  // The last live output line captured for a stack while its deploy-feedback
  // session is still streaming, used to enrich a failure record's diagnostics.
  // Guards on both the streaming status and an exact stack-name match, so
  // neither another stack's output nor a finished session's stale line leaks in.
  const getLastDeployOutputLine = useCallback(
    (forStack: string): string | undefined =>
      panelState.status === 'streaming' && panelState.stackName === forStack
        ? logRows.at(-1)?.message
        : undefined,
    [panelState.status, panelState.stackName, logRows],
  );

  const editorState = useEditorViewState();
  const {
    stackMisconfigScanning,
    content, setContent,
    envContent, setEnvContent,
    envExists,
    envFiles,
    selectedEnvFile,
    containers,
    containersLoadStatus,
    containersLoadError,
    activeTab, setActiveTab,
    logsMode, setLogsMode,
    gitSourceOpen, setGitSourceOpen,
    gitSourcePendingMap,
    isFileLoading,
    backupInfo,
    isEditing,
    editingCompose, setEditingCompose,
    effectiveServices,
    serviceUpdateInProgress,
  } = editorState;

  const stackListState = useStackListState();
  const {
    selectedFile,
    isLoading,
    stackActions: stackActionMap,
    isScanning,
    searchQuery, setSearchQuery,
    stackStatuses,
    stackSelfFlags,
    stackCounts,
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
    sidebarIndicators,
    sidebarStackUpdates,
    pinned,
    isCollapsed, toggleCollapse,
    remoteSearchLoading,
    remoteSearchFailedNodes,
    lastActionResult,
    clearActionRecords,
    dismissActionResult,
    files,
    filesNodeId,
    stacksLoadStatus,
    stacksLoadError,
    stacksLoadNodeId,
  } = stackListState;

  const { nodes, activeNode, setActiveNode, hasCapability, activeNodeMeta, isLoading: nodesLoading } = useNodes();
  const canOfferVolumeRemoval =
    activeNodeMeta?.capabilities.includes(STACK_DOWN_REMOVE_VOLUMES_CAPABILITY) === true;
  const deleteVolumePreservation = resolveDeleteVolumePreservation(activeNodeMeta?.capabilities);

  // One-shot boot milestone: the app shell has mounted. Developer mode gates the
  // hydration-timing overlay for the active node; it follows node switches.
  useEffect(() => {
    markMilestone('shell_committed');
  }, []);
  const developerMode = useDeveloperMode(activeNode?.id);
  const hydrationOverlay = developerMode ? <HydrationTimingPanel /> : null;

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

  const { canReapply: canReapplyCompose } = useActiveNodeReapplyEligibility(activeNode?.id);
  const composeReapply = useComposeReapplyAction();
  const isSelfStackSelected = selectedFile ? stackSelfFlags[selectedFile] === true : false;
  // Ordinary stacks keep Save & Deploy even when the node supports compose reapply.
  const canSaveAndReapply = resolveCanSaveAndReapply(isAdmin, canReapplyCompose, isSelfStackSelected);

  // Which mode the create dialog opens on (always empty after import tab removal).
  const [createDialogInitialMode, setCreateDialogInitialMode] = useState<CreateMode>('empty');
  const [adoptDialogOpen, setAdoptDialogOpen] = useState(false);
  const adoptOpenedFromSetupRef = useRef(false);

  const openCreateDialog = useCallback((mode: CreateMode = 'empty') => {
    setCreateDialogInitialMode(mode);
    setCreateDialogOpen(true);
  }, [setCreateDialogOpen]);

  const openAdoptDialog = useCallback(() => {
    setCreateDialogOpen(false);
    setAdoptDialogOpen(true);
  }, [setCreateDialogOpen]);

  const [diffPreviewEnabled] = useComposeDiffPreviewEnabled();
  const [topNavLabels] = useTopNavLabels();
  const [topNavAlign] = useTopNavAlign();
  const [topNavMode] = useTopNavMode();
  const { persistedIds: quickLinkIds, addQuickLink, removeQuickLink } = useTopNavQuickLinks();

  // Use a ref to break the circular dependency:
  // useViewNavigationState needs onNavigateToDashboard -> resetEditorState
  // but stackActions isn't created until after navState
  const resetEditorStateRef = useRef<() => void>(() => {});
  // Mobile state is declared after useStackActions; this ref is assigned once
  // pendingDetailStack / mobileView exist so delete-of-open-stack can flip to
  // the list surface without reordering the hook graph.
  const onDeletedOpenStackRef = useRef<() => void>(() => {});

  const navState = useViewNavigationState({
    onNavigateToDashboard: () => resetEditorStateRef.current(),
    hasFleetCapability: hasCapability('fleet'),
    containerLabelsEnabled: hasCapability('container-label-inventory'),
  });
  const {
    activeView, setActiveView,
    settingsSection, setSettingsSection,
    securityTab, setSecurityTab,
    fleetActiveTab, setFleetActiveTab,
    filterNodeId, setFilterNodeId,
    schedulePrefill,
    muteRulePrefill,
    mobileNavOpen, setMobileNavOpen,
    handleOpenSettings,
    handlePrefillConsumed,
    handleMutePrefillConsumed,
    handleNavigate,
    navItems,
    navModel,
    openMuteRulesWithPrefill,
    reachCtx,
  } = navState;

  const visibleQuickLinks = useMemo(() => {
    const candidateSet = new Set(navModel.quickLinkCandidates.map((item) => item.value));
    return quickLinkIds
      .filter((id) => candidateSet.has(id))
      .map((id) => {
        const item = getAppNavItem(id);
        return item ? { value: item.value, label: item.label, icon: item.icon } : null;
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }, [quickLinkIds, navModel.quickLinkCandidates]);

  const {
    notifications,
    tickerConnected,
    markAllRead,
    deleteNotification,
    clearAllNotifications,
    removeNotificationsForStack,
  } = useNotifications({
    nodes,
    onStateInvalidate: scheduleStateInvalidateRefresh,
    onImageUpdatesChange: fetchImageUpdates,
  });

  const { stats: containerStats, error: containerStatsError } = useContainerStats(
    containers,
    activeNode?.id ?? null,
  );

  const serviceUpdateStatuses = useServiceUpdateStatus(stackUpdates, selectedFile);

  const stackActions = useStackActions({
    editorState,
    stackListState,
    navState,
    overlayState,
    activeNode,
    setActiveNode,
    nodes,
    runWithLog,
    getLastDeployOutputLine,
    diffPreviewEnabled,
    hasUpdateGuard: hasCapability('update-guard'),
    hasGuidedExternalNetworkPreflight: hasCapability('guided-external-network-preflight'),
    hasServiceScopedUpdate: hasCapability('service-scoped-update'),
    canEditStack: (stackNameOrFilename) => {
      const stackName = stackNameOrFilename.replace(/\.(ya?ml)$/, '');
      return can('stack:edit', 'stack', stackName, activeNode?.id);
    },
    canOfferVolumeRemoval,
    onDeletedOpenStack: () => onDeletedOpenStackRef.current(),
    removeNotificationsForStack,
    isAdmin,
    canReapplyCompose,
  });

  // Wire the ref now that stackActions is available
  resetEditorStateRef.current = stackActions.resetEditorState;

  const { syncStale: containersSyncStale, retrySync: retryContainersSync } = useSelectedStackLiveRefresh({
    selectedFile,
    activeNodeId: activeNode?.id,
    isDetailVisible: activeView === 'editor',
    containers,
    composeContent: content,
    containersLoadStatus,
    refreshSelectedContainers: stackActions.refreshSelectedContainers,
  });

  // A failed health gate routes into the existing recovery affordance: record
  // a failure for the stack so RecoveryChip/RecoveryPanel offer the same
  // explicit, user-confirmed rollback as any failed operation. Keyed by gate
  // id so one verdict records exactly once.
  const handledGateRef = useRef<string | null>(null);
  useEffect(() => {
    if (!healthGate || handledGateRef.current === healthGate.gateId) return;
    // Record only on the node the gate ran on. A wrong node or a not-yet-loaded
    // stack file leaves it unhandled (not marked), so the effect retries when the
    // active node returns or the files refresh, recording exactly once.
    const outcome = classifyFailedGate(
      healthGate,
      activeNodeIdRef.current,
      stackListState.filesNodeId,
      stackListState.files,
    );
    if (outcome.kind === 'no-file') {
      console.warn('[HealthGate] no stack file matches failed gate for', healthGate.stackName);
      return;
    }
    if (outcome.kind === 'skip') return;
    handledGateRef.current = healthGate.gateId;
    stackListState.recordActionFailure(outcome.stackFile, {
      action: healthGate.trigger,
      rolledBack: false,
      errorMessage: `Health gate failed: ${healthGate.reason ?? 'containers did not stay healthy after the update'}`,
      startedAt: healthGate.startedAt ?? Date.now(),
      endedAt: Date.now(),
      failure: {
        reason: 'healthcheck_failed',
        label: 'Health gate failed',
        suggestion: 'Check the container logs; roll back if the previous version was healthy.',
      },
    });
  }, [healthGate, stackListState.files, stackListState.filesNodeId, stackListState.recordActionFailure]);

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
  // Pending-intent target for a cross-node "open this node's Networking page"
  // request (e.g. a Fleet networking signal). Mirrors pendingStackLoadRef:
  // setActiveNode first, then the node-settled effect below navigates once
  // activeNode actually reflects the target, so Networking never briefly
  // mounts and fetches against the previous node.
  const pendingNetworkingNodeRef = useRef<number | null>(null);

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
  const stackDisplayName = selectedFile ? selectedFile.replace(/\.(yml|yaml)$/, '') : '';
  const stackMuteActions = useStackMuteActions(stackDisplayName, openMuteRulesWithPrefill);

  const { isDarkMode } = useTheme();

  // ---- Mobile shell (below md) ---------------------------------------------
  // Desktop renders the persistent sidebar + workspace untouched. On a phone we
  // show exactly one surface at a time: the stack list, a top-level view, or a
  // full-screen stack detail. `mobileView` is explicit state, decoupled from
  // `activeView`, so 'dashboard' still maps to HomeDashboard everywhere.
  const isMobile = useIsMobile();
  const [mobileView, setMobileView] = useState<MobileView>('list');
  const [mobileSettingsSection, setMobileSettingsSection] = useState<SectionId | null>(null);
  // Optimistically flip to the detail surface the instant a row is tapped,
  // before loadFile's fetch resolves selectedFile; cleared once it settles.
  const [pendingDetailStack, setPendingDetailStack] = useState<string | null>(null);
  const [pendingAnatomyTab, setPendingAnatomyTab] = useState<'networking' | 'doctor' | 'dossier' | 'drift' | undefined>();
  const [fleetUpdatesIntent, setFleetUpdatesIntent] = useState<{ tab: 'nodes' | 'changelog' } | null>(null);
  onDeletedOpenStackRef.current = () => {
    setPendingDetailStack(null);
    setMobileView('list');
  };

  const handleFleetUpdatesIntentConsumed = useCallback(() => setFleetUpdatesIntent(null), []);

  const { surface: mobileSurface, detailReady, detailOpen } = deriveMobileSurface({
    activeView,
    selectedFile,
    mobileView,
    pendingDetailStack,
  });

  const { retryFrozenRoute, urlHydratingStack, routeDetailError } = useUrlSync({
    nodes,
    nodesLoaded: !nodesLoading,
    activeNode,
    setActiveNode,
    activeView,
    setActiveView,
    settingsSection,
    setSettingsSection,
    securityTab,
    setSecurityTab,
    fleetActiveTab,
    setFleetActiveTab,
    filterNodeId,
    setFilterNodeId,
    selectedFile,
    files,
    filesNodeId,
    stacksLoadStatus,
    stacksLoadNodeId,
    isFileLoading,
    activeTab,
    setActiveTab,
    editingCompose,
    setEditingCompose,
    selectedEnvFile,
    envFiles,
    loadFileForRoute: stackActions.loadFileForRoute,
    changeEnvFile: stackActions.changeEnvFile,
    applyEditorRouteState: stackActions.applyEditorRouteState,
    refreshStacks,
    reachCtx,
    isMobile,
    mobileSurface,
    setMobileSurface: (surface) => {
      if (surface === 'list') setMobileView('list');
      else if (surface === 'content') setMobileView('content');
    },
    mobileSettingsSection,
    setMobileSettingsSection,
    setPendingDetailStack,
    attemptPopstateNavigation: stackActions.attemptPopstateNavigation,
  });

  useEffect(() => {
    if (shouldClearPendingDetailStack({
      pendingDetailStack,
      detailReady,
      isFileLoading,
      stacksLoadStatus,
      urlHydratingStack,
      routeDetailError,
    })) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPendingDetailStack(null);
    }
  }, [pendingDetailStack, detailReady, isFileLoading, stacksLoadStatus, urlHydratingStack, routeDetailError]);

  useEffect(() => {
    if (pendingAnatomyTab && selectedFile && !isFileLoading) {
      const timer = window.setTimeout(() => setPendingAnatomyTab(undefined), 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [isFileLoading, pendingAnatomyTab, selectedFile]);

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

  // Open a specific stack on a node (from Fleet): load it directly if that node
  // is already active, else stash it and switch nodes (the node-switch effect
  // loads the pending stack once the registry settles). Mobile shows the
  // optimistic detail surface immediately.
  const handleFleetNavigateToNode = (
    nodeId: number,
    stackName: string,
    destination: SenchoOpenStackDetail['destination'] = 'stack',
  ) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;
    setPendingAnatomyTab(
      destination === 'anatomy-networking' ? 'networking'
        : destination === 'doctor' ? 'doctor'
        : destination === 'dossier' ? 'dossier'
        : destination === 'drift' ? 'drift'
        : undefined,
    );
    if (isMobile) setPendingDetailStack(stackName);
    if (activeNode?.id === nodeId) {
      void stackActions.loadFile(stackName);
    } else {
      pendingStackLoadRef.current = stackName;
      setActiveNode(node);
    }
  };

  // Open a stack from another surface (e.g. a Resources network card). Reuses
  // the Fleet navigation, which loads the stack on its node (switching nodes if
  // needed) and flips to the editor view. A latest-ref keeps the window handler
  // current without re-subscribing every render.
  const openStackFromEventRef = useRef(handleFleetNavigateToNode);
  useEffect(() => { openStackFromEventRef.current = handleFleetNavigateToNode; });
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<SenchoOpenStackDetail>).detail;
      if (detail) openStackFromEventRef.current(detail.nodeId, detail.stackName, detail.destination);
    };
    window.addEventListener(SENCHO_OPEN_STACK_EVENT, handler);
    return () => window.removeEventListener(SENCHO_OPEN_STACK_EVENT, handler);
  }, []);

  // Open a node's Networking page from a Fleet card's networking signal.
  // Pending-intent gated (see pendingNetworkingNodeRef above): if the node is
  // already active, navigate immediately; otherwise switch nodes first and let
  // the node-settled effect complete the navigation once activeNode reflects
  // the switch.
  const handleOpenNodeNetworking = (nodeId: number) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;
    if (activeNode?.id === nodeId) {
      setActiveView('networking');
      return;
    }
    pendingNetworkingNodeRef.current = nodeId;
    setActiveNode(node);
  };

  // "Inspect" a node from the mobile Fleet screen: switch to it and land on its
  // stack list.
  const handleInspectNode = (nodeId: number) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;
    if (activeNode?.id !== nodeId) setActiveNode(node);
    goToMobileList();
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

  // Notification navigation: node_update_available notifications route to the
  // Fleet view and open the Node Updates sheet (desktop only). The intent state
  // handles both cross-view navigation and same-view re-entry (handleNavigate
  // returns early when already on Fleet, but the state change triggers render).
  const handleNotificationNavigate = useCallback((notif: NotificationItem) => {
    if (notif.category === 'node_update_available') {
      if (isMobile) {
        navigateMobileAware('fleet');
      } else {
        setFleetUpdatesIntent({ tab: 'nodes' });
        handleNavigate('fleet');
      }
      return;
    }
    stackActions.navigateToNotification(notif);
  }, [isMobile, navigateMobileAware, handleNavigate, stackActions]);

  const handleNotificationNavigateChangelog = useCallback(() => {
    if (isMobile) {
      navigateMobileAware('fleet');
    } else {
      setFleetUpdatesIntent({ tab: 'changelog' });
      handleNavigate('fleet');
    }
  }, [isMobile, navigateMobileAware, handleNavigate]);

  const renderEditor = (headerActions?: ReactNode) => (
    <EditorView
      headerActions={headerActions}
      requestedAnatomyTab={pendingAnatomyTab}
      stackName={stackName}
      isDarkMode={isDarkMode}
      containers={containers}
      containersLoadStatus={containersLoadStatus}
      containersLoadError={containersLoadError}
      onRetryContainersLoad={() => { void stackActions.retryContainersLoad(); }}
      containersSyncStale={containersSyncStale}
      onRetrySync={retryContainersSync}
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
      loadingAction={loadingAction}
      stackMisconfigScanning={stackMisconfigScanning}
      can={can}
      isAdmin={isAdmin}
      trivy={trivy}
      activeNode={activeNode}
      deployStack={stackActions.deployStack}
      restartStack={stackActions.restartStack}
      stopStack={stackActions.stopStack}
      updateStack={stackActions.updateStack}
      rollbackStack={stackActions.rollbackStack}
      scanStackConfig={stackActions.scanStackConfig}
      openComposeEditor={stackActions.openComposeEditor}
      closeComposeEditor={stackActions.closeComposeEditor}
      requestSave={stackActions.requestSave}
      requestSaveAndDeploy={stackActions.requestSaveAndDeploy}
      discardChanges={stackActions.discardChanges}
      setContent={setContent}
      setEnvContent={setEnvContent}
      changeEnvFile={stackActions.changeEnvFile}
      openLogViewer={stackActions.openLogViewer}
      openBashModal={stackActions.openBashModal}
      onOpenMonitor={stackName ? () => overlayState.openAlertSheet(stackName) : undefined}
      onOpenServiceMonitor={stackName
        ? (serviceName) => overlayState.openAlertSheet(stackName, { serviceName })
        : undefined}
      serviceAction={stackActions.serviceAction}
      effectiveServices={effectiveServices}
      serviceUpdateStatuses={serviceUpdateStatuses}
      serviceUpdateInProgress={serviceUpdateInProgress}
      onRequestServiceUpdate={(serviceName, mode) => {
        if (!selectedFile) return;
        void stackActions.requestServiceUpdate(selectedFile, serviceName, mode);
      }}
      setActiveTab={setActiveTab}
      setLogsMode={setLogsMode}
      setEditingCompose={setEditingCompose}
      setGitSourceOpen={setGitSourceOpen}
      requestDeleteStack={stackActions.requestDeleteStack}
      requestTakeDownStack={stackActions.requestTakeDownStack}
      showTakeDown={selectedFile ? stackActions.getStackMenuVisibility(selectedFile).showTakeDown : false}
      isSelfStack={isSelfStackSelected}
      canSaveAndReapply={canSaveAndReapply}
      recoveryResult={selectedFile ? lastActionResult[selectedFile] : undefined}
      onRefreshState={async () => {
        if (!selectedFile) return;
        const name = selectedFile.replace(/\.(yml|yaml)$/, '');
        const outcome = await stackActions.refreshSelectedContainers(name, selectedFile);
        await refreshStacks(true);
        if (outcome === 'ok') toast.success('Refreshed container state.');
        else if (outcome === 'failed') toast.error('Could not refresh container state.');
      }}
      onDismissRecovery={() => { if (selectedFile) dismissActionResult(selectedFile); }}
      panelStartedAt={panelStartedAt}
      onMobileBack={goToMobileList}
      onCloseEditor={() => stackActions.attemptLeaveEditor(() => stackActions.closeComposeEditor())}
      hasUnsavedChanges={stackActions.hasUnsavedChanges}
      stackMuteActions={selectedFile ? stackMuteActions : undefined}
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
        overlayState.setPendingLoadOptions(null);
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
    const pendingNetworkingNodeId = pendingNetworkingNodeRef.current;
    pendingNetworkingNodeRef.current = null;

    stackActions.resetEditorState();
    // Stack filenames can repeat across nodes; drop the previous node's failure
    // records so a stale recovery panel cannot surface on the new node.
    clearActionRecords();

    if (pendingStack) {
      void stackActions.loadFile(pendingStack);
    } else if (pendingNetworkingNodeId === activeNode.id) {
      setActiveView('networking');
    } else if (isRealSwitch) {
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

  useEffect(() => {
    if (permissions === null) return;
    if (adoptOpenedFromSetupRef.current) return;
    try {
      const raw = sessionStorage.getItem('sencho:post-setup');
      if (!raw) return;
      sessionStorage.removeItem('sencho:post-setup');
      const parsed = JSON.parse(raw) as { openAdopt?: boolean };
      if (parsed.openAdopt && can('stack:create')) {
        adoptOpenedFromSetupRef.current = true;
        setAdoptDialogOpen(true);
      }
    } catch {
      // ignore malformed session flag
    }
  }, [permissions, can]);

  const canCreateStack = can('stack:create');
  const createStackSlot = (canCreateStack || permissionsStatus === 'loading') ? (
    <>
      <Button
        variant="outline"
        className="rounded-lg w-full"
        onClick={() => openCreateDialog('empty')}
        disabled={!canCreateStack}
      >
        <Plus className="w-4 h-4" />
        Create Stack
      </Button>
      <CreateStackDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        initialMode={createDialogInitialMode}
        onStackCreated={async (sName, sourceNodeId, meta) => {
          await refreshStacks();
          // loadFile keeps its own unsaved-changes overlay (intentional safety,
          // shared with every other "switch to a different stack" code path).
          // Skip the load if the user switched nodes mid-create so we do not
          // 404 against a stack name that lives on the previous node.
          if (sourceNodeId != null && activeNodeIdRef.current !== sourceNodeId) {
            toast.info(`Stack "${sName}" created on the previous node.`);
            return;
          }
          // Empty creates land in an editable compose workspace. Other modes
          // (git, docker-run, import) stay browse-first on Anatomy.
          await stackActions.loadFile(
            sName,
            meta?.mode === 'empty' ? { startInComposeEdit: true } : undefined,
          );
        }}
        onStacksChanged={async () => { await refreshStacks(); }}
        onOpenAdopt={openAdoptDialog}
      />
    </>
  ) : null;

  const adoptDialogEl = (
    <AdoptExistingDialog
      open={adoptDialogOpen}
      onOpenChange={setAdoptDialogOpen}
      onStacksChanged={async () => { await refreshStacks(); }}
    />
  );

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
          canCreate={canCreateStack}
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
            stackCounts,
            stackUpdates: sidebarStackUpdates,
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
            onOpenCreate: canCreateStack ? () => openCreateDialog('empty') : undefined,
            onOpenAdopt: can('stack:read') ? openAdoptDialog : undefined,
            onScan: handleScanStacks,
            canCreate: canCreateStack,
            activeNodeId: activeNode?.id ?? null,
            openMuteRulesWithPrefill,
            stacksLoadStatus,
            stacksLoadError,
            onRetryStacksLoad: () => { void retryFrozenRoute(); },
          }}
          activitySummary={activitySummary}
          onActivityAction={handleActivityAction}
          bulkMode={bulkMode}
          selectedFiles={selectedFiles}
          onToggleBulkMode={toggleBulkMode}
          onToggleSelect={toggleSelect}
          onClearSelection={clearSelection}
          onBulkAction={handleBulkAction}
          showUpdatesChip={sidebarIndicators}
        />
      );

      const notificationsEl = (
        <NotificationPanel
          notifications={notifications}
          nodes={nodes}
          onMarkAllRead={markAllRead}
          onClearAll={clearAllNotifications}
          onDelete={deleteNotification}
          onNavigate={handleNotificationNavigate}
          onNavigateChangelog={handleNotificationNavigateChangelog}
        />
      );
      const themeSwitchEl = <ThemeQuickSwitch onOpenAppearance={() => openSettings('appearance')} />;
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
          showLabels={topNavLabels}
          navAlign={topNavAlign}
          navMode={topNavMode}
          navModel={navModel}
          quickLinks={visibleQuickLinks}
          persistedQuickLinkIds={quickLinkIds}
          onAddQuickLink={(value) => addQuickLink(value as typeof quickLinkIds[number])}
          onRemoveQuickLink={(value) => removeQuickLink(value as typeof quickLinkIds[number])}
          onOpenSettings={() => openSettings()}
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
            onFleetNavigateToNode={handleFleetNavigateToNode}
            onOpenNodeNetworking={handleOpenNodeNetworking}
            filterNodeId={filterNodeId}
            onClearScheduledOpsFilter={() => setFilterNodeId(null)}
            schedulePrefill={schedulePrefill}
            onPrefillConsumed={handlePrefillConsumed}
            muteRulePrefill={muteRulePrefill}
            onMutePrefillConsumed={handleMutePrefillConsumed}
            notifications={notifications}
            onNavigateToStack={(stackFile) => { void stackActions.loadFile(stackFile); }}
            onOpenSettingsSection={(section) => openSettings(section)}
            onOpenMuteRulesWithPrefill={openMuteRulesWithPrefill}
            onClearNotifications={clearAllNotifications}
            fleetUpdatesIntent={fleetUpdatesIntent}
            onFleetUpdatesIntentConsumed={handleFleetUpdatesIntentConsumed}
            securityTab={securityTab}
            onSecurityTabChange={setSecurityTab}
            fleetActiveTab={fleetActiveTab}
            onFleetActiveTabChange={setFleetActiveTab}
            renderEditor={renderEditor}
            stackUpdates={stackUpdates}
            urlHydratingStack={urlHydratingStack}
            isFileLoading={isFileLoading}
            quickLinkCandidates={navModel.quickLinkCandidates}
          />
        </div>
      );

      const shellOverlaysEl = (
        <ShellOverlays
          overlayState={overlayState}
          stackActions={stackActions}
          stackActionMap={stackActionMap}
          stackFiles={files}
          isDarkMode={isDarkMode}
          isAdmin={isAdmin}
          can={can}
          selectedFile={selectedFile}
          stackName={stackName}
          activeNodeId={activeNode?.id ?? null}
          gitSourceOpen={gitSourceOpen}
          setGitSourceOpen={setGitSourceOpen}
          canSelfUpdate={hasCapability('self-update')}
          composeReapply={composeReapply}
          canSaveAndReapply={canSaveAndReapply}
          canOfferVolumeRemoval={canOfferVolumeRemoval}
          deleteVolumePreservation={deleteVolumePreservation}
          onOpenFleetNodeUpdates={() => {
            if (isMobile) {
              navigateMobileAware('fleet');
            } else {
              setFleetUpdatesIntent({ tab: 'nodes' });
              handleNavigate('fleet');
            }
          }}
        />
      );

      // Bespoke, masthead-led mobile screens. When showing one, the TopBar is
      // dropped and the screen renders its own masthead (with notifications +
      // more-menu rehomed into the right slot).
      const bespokeContent = mobileSurface === 'content' && BESPOKE_MOBILE_VIEWS.has(activeView);
      // Shared lazy-chunk fallback for the code-split bespoke phone screens.
      const lazyFallback = (
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-stat-subtitle" strokeWidth={1.5} />
        </div>
      );
      const renderMobileBespoke = () => {
        switch (activeView) {
          case 'dashboard':
            return (
              <MobileDashboard
                notifications={notifications}
                headerActions={mobileMastheadActions}
                onNavigateToStack={handleSelectStack}
                onViewAllStacks={goToMobileList}
                onManageNodes={() => openSettings('nodes')}
              />
            );
          case 'fleet':
            // Never mount the mobile fleet view without node:read: the redirect
            // effect bounces the deep-link to the dashboard, but MobileFleet is a
            // static (non-lazy) render, so without this guard it would fire one
            // /fleet/overview (now 403) before the redirect unmounts it.
            if (!can('node:read')) return null;
            return (
              <MobileFleet
                headerActions={mobileMastheadActions}
                onInspectNode={handleInspectNode}
                onInspectStack={handleFleetNavigateToNode}
              />
            );
          case 'scheduled-ops':
            return <MobileSchedules headerActions={mobileMastheadActions} />;
          case 'settings':
            return (
              <MobileSettings
                headerActions={mobileMastheadActions}
                selectedSection={mobileSettingsSection}
                onSelectedSectionChange={setMobileSettingsSection}
                quickLinkCandidates={navModel.quickLinkCandidates}
              />
            );
          case 'security':
            return (
              <Suspense
                fallback={(
                  <div className="flex h-full items-center justify-center">
                    <Loader2 className="h-5 w-5 animate-spin text-stat-subtitle" strokeWidth={1.5} />
                  </div>
                )}
              >
                <SecurityView
                  activeTab={securityTab}
                  onTabChange={setSecurityTab}
                  headerActions={mobileMastheadActions}
                />
              </Suspense>
            );
          case 'auto-updates':
            // Same gates as the desktop content path (ViewRouter): hub-only +
            // the auto-updates capability, preserved on the phone surface.
            return (
              <HubOnlyGate>
                <CapabilityGate capability="auto-updates" featureName="Auto-Update Readiness">
                  <Suspense fallback={lazyFallback}>
                    <AutoUpdateReadinessView headerActions={mobileMastheadActions} />
                  </Suspense>
                </CapabilityGate>
              </HubOnlyGate>
            );
          case 'templates':
            return (
              <Suspense fallback={lazyFallback}>
                <AppStoreView
                  onDeploySuccess={(sName) => { refreshStacks(); void stackActions.loadFile(sName); }}
                  headerActions={mobileMastheadActions}
                />
              </Suspense>
            );
          case 'audit-log':
            return (
              <HubOnlyGate>
                <CapabilityGate capability="audit-log" featureName="Audit Log">
                  <Suspense fallback={lazyFallback}>
                    <AuditLogView headerActions={mobileMastheadActions} />
                  </Suspense>
                </CapabilityGate>
              </HubOnlyGate>
            );
          case 'resources':
            return (
              <Suspense fallback={lazyFallback}>
                <ResourcesView headerActions={mobileMastheadActions} />
              </Suspense>
            );
          case 'networking':
            return (
              <Suspense fallback={lazyFallback}>
                <NetworkingView headerActions={mobileMastheadActions} />
              </Suspense>
            );
          case 'global-observability':
            // Hub-only, like the desktop content path (ViewRouter); no capability gate.
            return (
              <HubOnlyGate>
                <Suspense fallback={lazyFallback}>
                  <GlobalObservabilityView headerActions={mobileMastheadActions} />
                </Suspense>
              </HubOnlyGate>
            );
          default:
            return workspaceEl;
        }
      };

      // The mobile Stacks list leads with the status masthead (no TopBar): the
      // node switcher is its kicker chip, the serif word summarizes stack
      // health, and notifications + the more-menu sit in the right slot.
      // up counts 'running' and down counts 'exited'; any other status (or the
      // window before statuses load) is neither, so "All running" must require
      // every stack to be up rather than just no stack being down.
      const { all: stacksAll, up: stacksUp, down: stacksDown, updates: stacksUpdates } = filterCounts;
      let stacksState = 'All running';
      let stacksTone: Tone = 'success';
      if (stacksAll === 0) {
        stacksState = 'No stacks';
      } else if (stacksDown > 0) {
        stacksState = `${stacksDown} down`;
        stacksTone = 'destructive';
      } else if (stacksUpdates > 0) {
        stacksState = `${stacksUpdates} update${stacksUpdates === 1 ? '' : 's'}`;
        stacksTone = 'warning';
      } else if (stacksUp !== stacksAll) {
        stacksState = `${stacksUp}/${stacksAll} up`;
        stacksTone = 'brand';
      }
      const stacksMasthead = (
        <Masthead
          kickerSlot={<NodeSwitcher compact onManageNodes={() => openSettings('nodes')} />}
          state={stacksState}
          stateTone={stacksTone}
          live={stacksDown > 0}
          meta={`${stacksAll} ${stacksAll === 1 ? 'stack' : 'stacks'} · ${stacksUp} up · ${stacksDown} down`}
          right={mobileMastheadActions}
        />
      );

      if (isMobile) {
        return (
          // h-dvh tracks the visible viewport as the address bar shows and hides, so
          // the bottom tab bar stays on screen (100vh would push it behind the bar).
          <div className="flex h-dvh w-screen flex-col overflow-hidden app-canvas text-foreground">
            {commandPaletteEl}
            {mobileSurface === 'content' && !bespokeContent && topBarEl}
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              {mobileSurface === 'list' && (
                <>
                  {stacksMasthead}
                  {sidebarEl}
                </>
              )}
              {mobileSurface === 'content' && (bespokeContent ? renderMobileBespoke() : workspaceEl)}
              {mobileSurface === 'detail' && (
                detailReady ? (
                  <div className="flex-1 min-h-0 overflow-hidden flex flex-col">{renderEditor(mobileMastheadActions)}</div>
                ) : (
                  (stacksLoadStatus === 'error' && stacksLoadNodeId === activeNode?.id && pendingDetailStack)
                  || (routeDetailError && pendingDetailStack)
                ) ? (
                  <MobileDetailError
                    name={pendingDetailStack}
                    message={routeDetailError ?? stacksLoadError ?? 'Could not load stacks for this node.'}
                    onBack={goToMobileList}
                    onRetry={() => { void retryFrozenRoute(); }}
                    headerActions={mobileMastheadActions}
                  />
                ) : (
                  <MobileDetailLoading name={pendingDetailStack ?? ''} onBack={goToMobileList} headerActions={mobileMastheadActions} />
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
            {adoptDialogEl}
            {shellOverlaysEl}
            {hydrationOverlay}
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
          {adoptDialogEl}
          {shellOverlaysEl}
          {hydrationOverlay}
        </div>
      );
    })()}
    </GlobalCommandPaletteProvider>
  );
}

// Optimistic stack-detail placeholder shown on mobile the instant a row is
// tapped, until loadFile resolves and the real EditorView mounts. Keeps the tap
// feeling immediate on slow networks.
function MobileDetailLoading({ name, onBack, headerActions }: { name: string; onBack: () => void; headerActions?: ReactNode }) {
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
        <span className="min-w-0 flex-1 truncate font-heading text-2xl text-stat-value">
          {name.replace(/\.(ya?ml)$/, '')}
        </span>
        {headerActions ? <div className="shrink-0">{headerActions}</div> : null}
      </div>
      <div className="flex flex-1 items-center justify-center text-stat-subtitle">
        <Loader2 className="h-5 w-5 animate-spin" strokeWidth={1.5} />
      </div>
    </div>
  );
}

function MobileDetailError({
  name,
  message,
  onBack,
  onRetry,
  headerActions,
}: {
  name: string;
  message: string;
  onBack: () => void;
  onRetry: () => void;
  headerActions?: ReactNode;
}) {
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
        <span className="min-w-0 flex-1 truncate font-heading text-2xl text-stat-value">
          {name.replace(/\.(ya?ml)$/, '')}
        </span>
        {headerActions ? <div className="shrink-0">{headerActions}</div> : null}
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-stat-subtitle">
        <AlertCircle className="h-8 w-8 text-muted-foreground" aria-hidden />
        <p className="text-sm">{message}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="w-4 h-4" />
          Retry
        </Button>
      </div>
    </div>
  );
}
