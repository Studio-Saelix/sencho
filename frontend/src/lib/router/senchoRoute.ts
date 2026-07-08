import type { FleetTab, SecurityTab } from '@/lib/events';
import type { SectionId } from '@/components/settings/types';
import type { ActiveView, EditorTab, ParsedRoute, RouteState } from './routeTypes';

const VIEW_SEGMENTS = {
  dashboard: 'dashboard',
  editor: 'stacks',
  'host-console': 'host-console',
  resources: 'resources',
  templates: 'templates',
  'global-observability': 'logs',
  fleet: 'fleet',
  security: 'security',
  'audit-log': 'audit',
  'scheduled-ops': 'schedules',
  'auto-updates': 'updates',
  settings: 'settings',
} as const satisfies Record<ActiveView, string>;

const SEGMENT_TO_VIEW: Record<string, ActiveView> = Object.fromEntries(
  Object.entries(VIEW_SEGMENTS).map(([view, seg]) => [seg, view as ActiveView]),
) as Record<string, ActiveView>;

const EDITOR_TABS = new Set<EditorTab>(['compose', 'env', 'files']);
const SECURITY_TABS = new Set<SecurityTab>([
  'overview', 'images', 'compose', 'secrets', 'policies', 'suppressions', 'history', 'scanner',
]);
const FLEET_TABS = new Set<FleetTab>([
  'overview', 'snapshots', 'configuration', 'dependencies', 'container-labels',
  'deployments', 'routing', 'federation', 'actions', 'secrets',
]);

const MAX_QUERY_LEN = 512;

function normalizePathname(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '') || '/';
  return trimmed.toLowerCase();
}

function parseBoundedPositiveInt(raw: string | null): number | null {
  if (!raw || raw.length > 12) return null;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

function safeDecodeQueryValue(raw: string): string | null {
  if (raw.length > MAX_QUERY_LEN) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export function parsePath(pathname: string, search: string): ParsedRoute {
  const empty: ParsedRoute = {
    nodeSlug: null,
    view: null,
    stackName: null,
    editorTab: null,
    envFile: null,
    securityTab: null,
    fleetTab: null,
    settingsSection: null,
    filterNodeId: null,
    isStackList: false,
  };

  const path = normalizePathname(pathname);
  if (path === '/') return empty;

  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'nodes' || parts.length < 3) return empty;

  const nodeSlug = parts[1];
  const segment = parts[2];

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  } catch {
    return { ...empty, nodeSlug };
  }

  const filterNodeId = parseBoundedPositiveInt(params.get('node'));
  const envFile = safeDecodeQueryValue(params.get('env') ?? '');

  if (segment === 'stacks') {
    if (parts.length === 3) {
      return { ...empty, nodeSlug, view: 'dashboard', isStackList: true };
    }
    const stackName = parts[3];
    const tabRaw = parts[4]?.toLowerCase();
    const editorTab = tabRaw && EDITOR_TABS.has(tabRaw as EditorTab)
      ? (tabRaw as EditorTab)
      : 'compose';
    return {
      ...empty,
      nodeSlug,
      view: 'editor',
      stackName,
      editorTab,
      envFile: envFile || null,
      filterNodeId,
    };
  }

  const view = SEGMENT_TO_VIEW[segment];
  if (!view) return { ...empty, nodeSlug };

  const result: ParsedRoute = { ...empty, nodeSlug, view, filterNodeId };

  if (view === 'security' && parts[3]) {
    const tab = parts[3].toLowerCase();
    if (SECURITY_TABS.has(tab as SecurityTab)) result.securityTab = tab as SecurityTab;
  }
  if (view === 'fleet' && parts[3]) {
    const tab = parts[3].toLowerCase();
    if (FLEET_TABS.has(tab as FleetTab)) result.fleetTab = tab as FleetTab;
  }
  if (view === 'settings' && parts[3]) {
    result.settingsSection = parts[3] as SectionId;
  }

  if (view === 'host-console' && parts[3]) {
    result.stackName = parts[3];
  }

  return result;
}

export function buildPath(state: RouteState): string {
  const base = `/nodes/${encodeURIComponent(state.nodeSlug)}`;
  const url = new URL('http://local');

  if (state.activeView === 'editor' && state.stackName) {
    const tab = state.editorTab || 'compose';
    url.pathname = `${base}/stacks/${encodeURIComponent(state.stackName)}/${tab}`;
    if (tab === 'env' && state.envFile) {
      url.searchParams.set('env', state.envFile);
    }
    if (state.filterNodeId != null) {
      url.searchParams.set('node', String(state.filterNodeId));
    }
    return url.pathname + url.search;
  }

  if (state.isMobile && state.mobileSurface === 'list') {
    url.pathname = `${base}/stacks`;
    return url.pathname;
  }

  if (state.activeView === 'dashboard') {
    url.pathname = `${base}/dashboard`;
    return url.pathname;
  }

  const segment = VIEW_SEGMENTS[state.activeView];
  url.pathname = `${base}/${segment}`;

  if (state.activeView === 'security' && state.securityTab !== 'overview') {
    url.pathname += `/${state.securityTab}`;
  }
  if (state.activeView === 'fleet' && state.fleetActiveTab !== 'overview') {
    if (!state.isMobile) {
      url.pathname += `/${state.fleetActiveTab}`;
    }
  }
  if (state.activeView === 'settings') {
    const section = state.isMobile
      ? state.settingsSection
      : (state.settingsSection ?? 'appearance');
    if (section) {
      url.pathname += `/${section}`;
    }
  }
  if (state.activeView === 'host-console' && state.stackName) {
    url.pathname += `/${encodeURIComponent(state.stackName)}`;
  }
  if (state.activeView === 'scheduled-ops' && state.filterNodeId != null) {
    url.searchParams.set('node', String(state.filterNodeId));
  }

  return url.pathname + url.search;
}

export { VIEW_SEGMENTS, SEGMENT_TO_VIEW };
