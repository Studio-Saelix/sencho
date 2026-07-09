import type { FleetTab, SecurityTab } from '@/lib/events';
import type { SectionId } from '@/components/settings/types';

/** Hub-owned views hidden when a remote node is active. */
export const HUB_ONLY_VIEWS: ReadonlySet<ActiveView> = new Set([
  'fleet',
  'scheduled-ops',
  'audit-log',
  'global-observability',
  'auto-updates',
]);

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

export type EditorTab = 'compose' | 'env' | 'files';

/** Mobile shell surface encoded in the URL (desktop uses subset). */
export type MobileRouteSurface = 'list' | 'content' | 'detail';

export interface RouteState {
  nodeSlug: string;
  activeView: ActiveView;
  /** Stack directory name when activeView is editor or host-console. */
  stackName: string | null;
  /**
   * Monaco editor tab when the compose/env/files surface is open.
   * Null means stack detail (anatomy) at `/stacks/:name` with no tab segment.
   */
  editorTab: EditorTab | null;
  envFile: string | null;
  securityTab: SecurityTab;
  fleetActiveTab: FleetTab;
  settingsSection: SectionId | null;
  filterNodeId: number | null;
  mobileSurface: MobileRouteSurface | null;
  isMobile: boolean;
}

/** Result of loading a stack for URL hydration (includes env inventory snapshot). */
export type RouteStackLoadResult =
  | { ok: false }
  | { ok: true; envFiles: string[] };

export interface ParsedRoute {
  nodeSlug: string | null;
  view: ActiveView | null;
  stackName: string | null;
  editorTab: EditorTab | null;
  envFile: string | null;
  securityTab: SecurityTab | null;
  fleetTab: FleetTab | null;
  settingsSection: SectionId | null;
  filterNodeId: number | null;
  /** True when path is /stacks without a stack segment (stack list). */
  isStackList: boolean;
}
