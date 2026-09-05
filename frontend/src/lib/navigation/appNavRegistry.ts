import {
  Terminal, CloudDownload, Home, HardDrive, ScrollText,
  Activity, Radar, RefreshCw, Clock, ShieldCheck, Network, Settings,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ActiveView } from '@/lib/router/routeTypes';

export type NavGroup =
  | 'overview'
  | 'stack-workspace'
  | 'fleet'
  | 'security-review'
  | 'operations'
  | 'tools'
  | 'settings';

export type SmartPlacement = 'primary' | 'overflow' | 'launcher-only';

/** Shared destination shape for TopBar, palette, and mobile consumers. */
export interface NavDestination {
  value: ActiveView;
  label: string;
  icon: LucideIcon;
}

export interface AppNavItem extends NavDestination {
  group: NavGroup;
  /** Flat page-list order (ascending), used by the command palette and mobile sheet. Settings uses a high value and is excluded (launcher-only). */
  navOrder: number;
  smart: SmartPlacement;
  quickLinkEligible: boolean;
  defaultQuickLink: boolean;
}

export const NAV_GROUP_META: readonly { id: NavGroup; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'stack-workspace', label: 'Stack workspace' },
  { id: 'fleet', label: 'Fleet' },
  { id: 'security-review', label: 'Security & review' },
  { id: 'operations', label: 'Operations' },
  { id: 'tools', label: 'Tools' },
  { id: 'settings', label: 'Settings' },
] as const;

export const APP_NAV_REGISTRY: readonly AppNavItem[] = [
  {
    value: 'dashboard',
    label: 'Home',
    icon: Home,
    group: 'overview',
    navOrder: 10,
    smart: 'primary',
    quickLinkEligible: true,
    defaultQuickLink: true,
  },
  {
    value: 'fleet',
    label: 'Fleet',
    icon: Radar,
    group: 'fleet',
    navOrder: 20,
    smart: 'primary',
    quickLinkEligible: true,
    defaultQuickLink: true,
  },
  {
    value: 'resources',
    label: 'Resources',
    icon: HardDrive,
    group: 'fleet',
    navOrder: 30,
    smart: 'primary',
    quickLinkEligible: true,
    defaultQuickLink: true,
  },
  {
    value: 'networking',
    label: 'Networking',
    icon: Network,
    group: 'fleet',
    navOrder: 40,
    smart: 'primary',
    quickLinkEligible: true,
    defaultQuickLink: false,
  },
  {
    value: 'security',
    label: 'Security',
    icon: ShieldCheck,
    group: 'security-review',
    navOrder: 50,
    smart: 'primary',
    quickLinkEligible: true,
    defaultQuickLink: true,
  },
  {
    value: 'templates',
    label: 'App Store',
    icon: CloudDownload,
    group: 'stack-workspace',
    navOrder: 60,
    smart: 'primary',
    quickLinkEligible: true,
    defaultQuickLink: false,
  },
  {
    value: 'global-observability',
    label: 'Logs',
    icon: Activity,
    group: 'operations',
    navOrder: 70,
    smart: 'overflow',
    quickLinkEligible: true,
    defaultQuickLink: false,
  },
  {
    value: 'auto-updates',
    label: 'Update',
    icon: RefreshCw,
    group: 'operations',
    navOrder: 80,
    smart: 'overflow',
    quickLinkEligible: true,
    defaultQuickLink: true,
  },
  {
    value: 'scheduled-ops',
    label: 'Schedules',
    icon: Clock,
    group: 'operations',
    navOrder: 90,
    smart: 'overflow',
    quickLinkEligible: true,
    defaultQuickLink: true,
  },
  {
    value: 'host-console',
    label: 'Console',
    icon: Terminal,
    group: 'tools',
    navOrder: 100,
    smart: 'overflow',
    quickLinkEligible: true,
    defaultQuickLink: false,
  },
  {
    value: 'audit-log',
    label: 'Audit',
    icon: ScrollText,
    group: 'security-review',
    navOrder: 110,
    smart: 'overflow',
    quickLinkEligible: true,
    defaultQuickLink: false,
  },
  {
    value: 'settings',
    label: 'Settings',
    icon: Settings,
    group: 'settings',
    navOrder: 999,
    smart: 'launcher-only',
    quickLinkEligible: false,
    defaultQuickLink: false,
  },
] as const;

/**
 * Recommended quick-link pins for missing/malformed storage and Reset.
 * Order is intentional (Home, Fleet, Resources, Security, Update, Schedules), not page order.
 */
export const recommendedQuickLinkIds: readonly ActiveView[] = [
  'dashboard',
  'fleet',
  'resources',
  'security',
  'auto-updates',
  'scheduled-ops',
] as const;

const BY_VALUE = new Map(APP_NAV_REGISTRY.map((item) => [item.value, item]));

export function getAppNavItem(value: ActiveView): AppNavItem | undefined {
  return BY_VALUE.get(value);
}

export function isQuickLinkEligibleId(value: string): value is ActiveView {
  const item = BY_VALUE.get(value as ActiveView);
  return Boolean(item?.quickLinkEligible);
}

export function toNavDestination(item: AppNavItem): NavDestination {
  return { value: item.value, label: item.label, icon: item.icon };
}
