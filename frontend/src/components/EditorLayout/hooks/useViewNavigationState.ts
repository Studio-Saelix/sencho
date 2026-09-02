import { useState, useEffect, useMemo, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useLicense } from '@/context/LicenseContext';
import { useNodes } from '@/context/NodeContext';
import { SENCHO_NAVIGATE_EVENT } from '@/components/NodeManager';
import type { SenchoNavigateDetail } from '@/components/NodeManager';
import type { SecurityTab, FleetTab } from '@/lib/events';
import type { SectionId } from '@/components/settings/types';
import type { ScheduleTaskPrefill } from '@/components/ScheduledOperationsView';
import type { MuteRuleDraft } from '@/lib/muteRules';
import type { ActiveView } from '@/lib/router/routeTypes';
import { HUB_ONLY_VIEWS } from '@/lib/router/routeTypes';
import { readUrlRouteState } from '@/lib/router/readUrlRouteState';
import {
  authzReady,
  isViewHidden,
  normalizeHiddenView,
  type ReachabilityContext,
} from '@/lib/routing/reachability';
import { useExperimental } from '@/hooks/useExperimental';
import { canScheduleAny } from '@/lib/scheduledActions';
import { buildNavigationModel } from '@/lib/navigation/buildNavigationModel';
import { recommendedQuickLinkIds, type NavDestination } from '@/lib/navigation/appNavRegistry';

export type { ActiveView };
export { HUB_ONLY_VIEWS };

/** @deprecated Prefer NavDestination from appNavRegistry; alias kept for mobile/palette imports. */
export type NavItem = NavDestination;

interface UseViewNavigationStateOptions {
  onNavigateToDashboard?: () => void;
  hasFleetCapability?: boolean;
  containerLabelsEnabled?: boolean;
}

export function useViewNavigationState(options?: UseViewNavigationStateOptions) {
  const { onNavigateToDashboard, hasFleetCapability = false, containerLabelsEnabled = false } = options ?? {};
  const { isAdmin, can, permissionsStatus, permissions } = useAuth();
  const { isPaid, licenseStatus } = useLicense();
  const { activeNode } = useNodes();
  const isRemote = activeNode?.type === 'remote';
  const { experimental, experimentalReady } = useExperimental();

  const scheduledOpsAccessible = useMemo(() => canScheduleAny(
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    (action, resourceType, resourceId, nodeId) => can(action as Parameters<typeof can>[0], resourceType, resourceId, nodeId),
    permissions,
  ), [can, permissions]);

  const initialRoute = readUrlRouteState();

  const [activeView, setActiveView] = useState<ActiveView>(initialRoute.activeView);
  const [settingsSection, setSettingsSection] = useState<SectionId>(initialRoute.settingsSection);
  const [securityTab, setSecurityTab] = useState<SecurityTab>(initialRoute.securityTab);
  const [fleetActiveTab, setFleetActiveTab] = useState<FleetTab>(initialRoute.fleetActiveTab);
  const [filterNodeId, setFilterNodeId] = useState<number | null>(initialRoute.filterNodeId);
  const [schedulePrefill, setSchedulePrefill] = useState<ScheduleTaskPrefill | null>(null);
  const [muteRulePrefill, setMuteRulePrefill] = useState<MuteRuleDraft | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const reachCtx: ReachabilityContext = useMemo(() => ({
    isAdmin,
    isPaid,
    can: (action: string) => can(action as Parameters<typeof can>[0]),
    isRemote,
    hasFleetCapability,
    containerLabelsEnabled,
    permissionsStatus,
    licenseStatus,
    experimental,
    experimentalReady,
    scheduledOpsAccessible,
  }), [isAdmin, isPaid, can, isRemote, hasFleetCapability, containerLabelsEnabled, permissionsStatus, licenseStatus, experimental, experimentalReady, scheduledOpsAccessible]);

  const handleOpenSettings = useCallback((section?: SectionId) => {
    if (section) setSettingsSection(section);
    setActiveView('settings');
    setFilterNodeId(null);
  }, []);

  const handlePrefillConsumed = useCallback(() => setSchedulePrefill(null), []);
  const handleMutePrefillConsumed = useCallback(() => setMuteRulePrefill(null), []);

  const openMuteRulesWithPrefill = useCallback((draft: MuteRuleDraft) => {
    setMuteRulePrefill(draft);
    setSettingsSection('notification-suppression');
    setActiveView('settings');
    setFilterNodeId(null);
  }, []);

  const handleNavigate = useCallback((value: string) => {
    if (value === activeView) return;
    if (value === 'fleet') {
      setFleetActiveTab('overview');
    }
    if (value === 'dashboard') {
      onNavigateToDashboard?.();
      setActiveView('dashboard');
    } else {
      setActiveView(value as ActiveView);
      setFilterNodeId(null);
    }
  }, [activeView, onNavigateToDashboard]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<SenchoNavigateDetail & { view: string }>).detail;
      if (!detail?.view) return;
      if (detail.view === 'security') {
        setSecurityTab(detail.tab ?? 'overview');
        setActiveView('security');
        setFilterNodeId(detail.nodeId ?? null);
        return;
      }
      if (detail.view === 'fleet') {
        if (detail.fleetTab) setFleetActiveTab(detail.fleetTab);
        setActiveView('fleet');
        setFilterNodeId(detail.nodeId ?? null);
        return;
      }
      setActiveView(detail.view as ActiveView);
      setFilterNodeId(detail.nodeId ?? null);
    };
    window.addEventListener(SENCHO_NAVIGATE_EVENT, handler);
    return () => window.removeEventListener(SENCHO_NAVIGATE_EVENT, handler);
  }, []);

  const navModel = useMemo(() => buildNavigationModel(reachCtx), [reachCtx]);
  const navItems = navModel.allPageItems;

  // Settled default eligibility for quick-link seeding/reset: distinct from navModel's
  // quickLinkCandidates (current-context, fail-open display filtering). Requires authzReady
  // (role/license settled) before returning anything, so a still-loading permissions/license
  // fetch never causes an incomplete default set to be seeded/persisted. isRemote is
  // deliberately overridden to false: default eligibility reflects the operator's role, not
  // which node tab happens to be open. Three of the six recommended defaults (fleet,
  // auto-updates, scheduled-ops) are HUB_ONLY_VIEWS, and evaluating with the real isRemote
  // would silently drop them whenever a remote node is active.
  const defaultQuickLinkEligibility = useMemo(() => {
    if (!authzReady(reachCtx)) return null;
    const roleCtx: ReachabilityContext = { ...reachCtx, isRemote: false };
    return recommendedQuickLinkIds.filter((id) => !isViewHidden(id, roleCtx));
  }, [reachCtx]);

  useEffect(() => {
    if (!authzReady(reachCtx)) return;
    const normalized = normalizeHiddenView(activeView, reachCtx);
    if (normalized !== activeView) {
      onNavigateToDashboard?.();
      setActiveView(normalized);
      setFilterNodeId(null);
    }
  }, [reachCtx, activeView, onNavigateToDashboard]);

  return {
    activeView, setActiveView,
    settingsSection, setSettingsSection,
    securityTab, setSecurityTab,
    fleetActiveTab, setFleetActiveTab,
    filterNodeId, setFilterNodeId,
    schedulePrefill, setSchedulePrefill,
    muteRulePrefill, setMuteRulePrefill,
    mobileNavOpen, setMobileNavOpen,
    handleOpenSettings,
    handlePrefillConsumed,
    handleMutePrefillConsumed,
    openMuteRulesWithPrefill,
    handleNavigate,
    navItems,
    navModel,
    reachCtx,
    defaultQuickLinkEligibility,
  } as const;
}
