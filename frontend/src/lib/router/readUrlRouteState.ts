import type { FleetTab, SecurityTab } from '@/lib/events';
import type { SectionId } from '@/components/settings/types';
import type { ActiveView } from './routeTypes';
import { parsePath } from './senchoRoute';

export interface UrlRouteState {
  activeView: ActiveView;
  settingsSection: SectionId;
  securityTab: SecurityTab;
  fleetActiveTab: FleetTab;
  filterNodeId: number | null;
}

const DEFAULT: UrlRouteState = {
  activeView: 'dashboard',
  settingsSection: 'appearance',
  securityTab: 'overview',
  fleetActiveTab: 'overview',
  filterNodeId: null,
};

/** True when the URL is a stack-scoped deep link for the given view. */
function isStackScopedDeepLink(view: ActiveView): boolean {
  if (typeof window === 'undefined') return false;
  const parsed = parsePath(window.location.pathname, window.location.search);
  return parsed.view === view && parsed.stackName != null;
}

/** True when the current URL is a stack workspace deep link (detail or editor). */
export function isStackEditorDeepLink(): boolean {
  return isStackScopedDeepLink('editor');
}

/** True when the URL targets Host Console rooted in a stack directory. */
export function isHostConsoleStackDeepLink(): boolean {
  return isStackScopedDeepLink('host-console');
}

/** Read shell navigation fields from the current browser URL (cold-load bootstrap). */
export function readUrlRouteState(): UrlRouteState {
  if (typeof window === 'undefined') return DEFAULT;
  const parsed = parsePath(window.location.pathname, window.location.search);
  return {
    activeView: parsed.view ?? 'dashboard',
    settingsSection: (parsed.settingsSection ?? 'appearance') as SectionId,
    securityTab: parsed.securityTab ?? 'overview',
    fleetActiveTab: parsed.fleetTab ?? 'overview',
    filterNodeId: parsed.filterNodeId,
  };
}
