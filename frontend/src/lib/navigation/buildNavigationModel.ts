import {
  APP_NAV_REGISTRY,
  NAV_GROUP_META,
  toNavDestination,
  type AppNavItem,
  type NavDestination,
  type NavGroup,
} from '@/lib/navigation/appNavRegistry';
import { isViewHidden, type ReachabilityContext } from '@/lib/routing/reachability';

export interface NavGroupBucket {
  group: NavGroup;
  label: string;
  items: NavDestination[];
}

export interface ReachableNavigationModel {
  /** Palette / mobile page list (excludes Settings). */
  allPageItems: NavDestination[];
  primaryItems: NavDestination[];
  overflowGroups: NavGroupBucket[];
  launcherGroups: NavGroupBucket[];
  quickLinkCandidates: NavDestination[];
}

function isVisuallyDiscoverable(item: AppNavItem, reachCtx: ReachabilityContext): boolean {
  if (item.smart === 'launcher-only') {
    // Settings is always discoverable in the launcher when the operator can open Settings.
    return true;
  }
  return !isViewHidden(item.value, reachCtx);
}

function bucketByGroup(items: AppNavItem[]): NavGroupBucket[] {
  const byGroup = new Map<NavGroup, NavDestination[]>();
  for (const item of items) {
    const list = byGroup.get(item.group) ?? [];
    list.push(toNavDestination(item));
    byGroup.set(item.group, list);
  }
  return NAV_GROUP_META
    .map(({ id, label }) => {
      const groupItems = byGroup.get(id);
      if (!groupItems?.length) return null;
      return { group: id, label, items: groupItems };
    })
    .filter((bucket): bucket is NavGroupBucket => bucket !== null);
}

/** Derive reachable navigation collections from a single ReachabilityContext. */
export function buildNavigationModel(reachCtx: ReachabilityContext): ReachableNavigationModel {
  const reachable = APP_NAV_REGISTRY.filter((item) => isVisuallyDiscoverable(item, reachCtx));

  const pages = reachable
    .filter((item) => item.smart !== 'launcher-only')
    .slice()
    .sort((a, b) => a.navOrder - b.navOrder);

  const allPageItems = pages.map(toNavDestination);
  const primaryItems = pages
    .filter((item) => item.smart === 'primary')
    .map(toNavDestination);
  const overflowItems = pages.filter((item) => item.smart === 'overflow');
  const overflowGroups = bucketByGroup(overflowItems);
  const launcherGroups = bucketByGroup(reachable);
  const quickLinkCandidates = reachable
    .filter((item) => item.quickLinkEligible)
    .map(toNavDestination);

  return {
    allPageItems,
    primaryItems,
    overflowGroups,
    launcherGroups,
    quickLinkCandidates,
  };
}
