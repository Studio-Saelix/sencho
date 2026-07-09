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

/** True when the current URL is a stack editor deep link (cold-load bootstrap). */
export function isStackEditorDeepLink(): boolean {
  if (typeof window === 'undefined') return false;
  const parsed = parsePath(window.location.pathname, window.location.search);
  return parsed.view === 'editor' && parsed.stackName != null;
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
