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

export type ActiveView =
  | 'dashboard'
  | 'editor'
  | 'host-console'
  | 'resources'
  | 'templates'
  | 'global-observability'
  | 'fleet'
  | 'security'
  | 'audit-log'
  | 'scheduled-ops'
  | 'auto-updates'
  | 'settings';

// Views that operate on hub-owned state (node registry, fleet schedules,
// centralized audit, fleet-wide log aggregation, fleet-wide update preview).
// Hidden from the nav strip and force-redirect to dashboard when the active
// node is remote, since proxying them would surface that remote's own
// disconnected state instead of the hub's. Settings sub-sections use the
// parallel `hiddenOnRemote` registry (see settings/registry.ts).
export const HUB_ONLY_VIEWS: ReadonlySet<ActiveView> = new Set([
  'fleet',
  'scheduled-ops',
  'audit-log',
  'global-observability',
  'auto-updates',
]);

export interface NavItem {
  value: ActiveView;
  label: string;
  icon: LucideIcon;
}

interface UseViewNavigationStateOptions {
  onNavigateToDashboard?: () => void;
}

export function useViewNavigationState(options?: UseViewNavigationStateOptions) {
  const { onNavigateToDashboard } = options ?? {};
  const { isAdmin, can } = useAuth();
  const { isPaid } = useLicense();
  const { activeNode } = useNodes();
  const isRemote = activeNode?.type === 'remote';

  const [activeView, setActiveView] = useState<ActiveView>('dashboard');
  const [settingsSection, setSettingsSection] = useState<SectionId>('appearance');
  const [securityTab, setSecurityTab] = useState<SecurityTab>('overview');
  const [fleetTab, setFleetTab] = useState<FleetTab | null>(null);
  const [filterNodeId, setFilterNodeId] = useState<number | null>(null);
  const [schedulePrefill, setSchedulePrefill] = useState<ScheduleTaskPrefill | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const handleOpenSettings = useCallback((section?: SectionId) => {
    if (section) setSettingsSection(section);
    setActiveView('settings');
    setFilterNodeId(null);
  }, []);

  const handlePrefillConsumed = useCallback(() => setSchedulePrefill(null), []);

  const handleNavigate = useCallback((value: string) => {
    if (value === activeView) return;
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
        // Set the target tab before switching the view so the controlled
        // SecurityView lands on it deterministically (no mount race).
        setSecurityTab(detail.tab ?? 'overview');
        setActiveView('security');
        setFilterNodeId(detail.nodeId ?? null);
        return;
      }
      if (detail.view === 'fleet') {
        // Set the target sub-tab before switching so the controlled FleetView
        // lands on it (e.g. Snapshots from the stack storage warning).
        if (detail.fleetTab) setFleetTab(detail.fleetTab);
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
      { value: 'fleet', label: 'Fleet', icon: Radar },
      { value: 'resources', label: 'Resources', icon: HardDrive },
      // Security is a Community, node-scoped review surface (not hub-only), so
      // it shows for every authenticated user and on remote nodes too.
      { value: 'security', label: 'Security', icon: ShieldCheck },
      { value: 'templates', label: 'App Store', icon: CloudDownload },
    ];
    // The aggregated Logs feed crosses every managed stack, so it is an
    // admin-only operator view (the backend gates the same routes on admin).
    if (isAdmin) items.push({ value: 'global-observability', label: 'Logs', icon: Activity });
    if (isAdmin) {
      items.push({ value: 'auto-updates', label: 'Update', icon: RefreshCw });
      items.push({ value: 'scheduled-ops', label: 'Schedules', icon: Clock });
    }
    if (isPaid) {
      if (isAdmin) items.push({ value: 'host-console', label: 'Console', icon: Terminal });
      if (can('system:audit')) items.push({ value: 'audit-log', label: 'Audit', icon: ScrollText });
    }
    return isRemote
      ? items.filter(i => !HUB_ONLY_VIEWS.has(i.value))
      : items;
  }, [isAdmin, isPaid, can, isRemote]);

  useEffect(() => {
    // Redirect off a view the active context can't reach: a hub-only view while
    // a remote node is active, or the admin-only Logs view as a non-admin (e.g.
    // arrived via a deep-link event rather than the now-hidden nav item).
    const blockedByRemote = isRemote && HUB_ONLY_VIEWS.has(activeView);
    const blockedByRole = !isAdmin && activeView === 'global-observability';
    if (blockedByRemote || blockedByRole) {
      onNavigateToDashboard?.();
      setActiveView('dashboard');
      setFilterNodeId(null);
    }
  }, [isRemote, isAdmin, activeView, onNavigateToDashboard]);

  return {
    activeView, setActiveView,
    settingsSection, setSettingsSection,
    securityTab, setSecurityTab,
    fleetTab, setFleetTab,
    filterNodeId, setFilterNodeId,
    schedulePrefill, setSchedulePrefill,
    mobileNavOpen, setMobileNavOpen,
    handleOpenSettings,
    handlePrefillConsumed,
    handleNavigate,
    navItems,
  } as const;
}
