import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Terminal, CloudDownload, Home, HardDrive, ScrollText,
  Activity, Radar, RefreshCw, Clock, ShieldCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
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

export type { ActiveView };
export { HUB_ONLY_VIEWS };

export interface NavItem {
  value: ActiveView;
  label: string;
  icon: LucideIcon;
}

interface UseViewNavigationStateOptions {
  onNavigateToDashboard?: () => void;
  hasFleetCapability?: boolean;
  containerLabelsEnabled?: boolean;
}

export function useViewNavigationState(options?: UseViewNavigationStateOptions) {
  const { onNavigateToDashboard, hasFleetCapability = false, containerLabelsEnabled = false } = options ?? {};
  const { isAdmin, can, permissionsStatus } = useAuth();
  const { isPaid, licenseStatus } = useLicense();
  const { activeNode } = useNodes();
  const isRemote = activeNode?.type === 'remote';
  const { experimental, experimentalReady } = useExperimental();

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
  }), [isAdmin, isPaid, can, isRemote, hasFleetCapability, containerLabelsEnabled, permissionsStatus, licenseStatus, experimental, experimentalReady]);

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

  const navItems = useMemo((): NavItem[] => {
    const items: NavItem[] = [
      { value: 'dashboard', label: 'Home', icon: Home },
    ];
    if (!isViewHidden('fleet', reachCtx)) {
      items.push({ value: 'fleet', label: 'Fleet', icon: Radar });
    }
    items.push(
      { value: 'resources', label: 'Resources', icon: HardDrive },
      { value: 'security', label: 'Security', icon: ShieldCheck },
      { value: 'templates', label: 'App Store', icon: CloudDownload },
    );
    if (!isViewHidden('global-observability', reachCtx)) {
      items.push({ value: 'global-observability', label: 'Logs', icon: Activity });
    }
    if (!isViewHidden('auto-updates', reachCtx)) {
      items.push({ value: 'auto-updates', label: 'Update', icon: RefreshCw });
    }
    if (!isViewHidden('scheduled-ops', reachCtx)) {
      items.push({ value: 'scheduled-ops', label: 'Schedules', icon: Clock });
    }
    // Visual discovery fail-closed: omit Console until /meta settles and the
    // flag is on. URL normalization still waits on experimentalReady inside
    // isViewHidden so enabled deep links are not rewritten during cold load.
    if (experimentalReady && experimental && !isViewHidden('host-console', reachCtx)) {
      items.push({ value: 'host-console', label: 'Console', icon: Terminal });
    }
    if (!isViewHidden('audit-log', reachCtx)) {
      items.push({ value: 'audit-log', label: 'Audit', icon: ScrollText });
    }
    return items;
  }, [reachCtx, experimentalReady, experimental]);

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
    reachCtx,
  } as const;
}
