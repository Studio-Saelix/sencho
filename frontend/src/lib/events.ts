/** Cross-component custom event constants and typed detail interfaces. */

export const SENCHO_OPEN_LOGS_EVENT = 'sencho-open-logs';

export interface SenchoOpenLogsDetail {
  containerId: string;
  containerName: string;
}

export const SENCHO_SETTINGS_CHANGED = 'sencho-settings-changed';

export interface SenchoSettingsChangedDetail {
  changedKeys: string[];
}

export const SENCHO_LABELS_CHANGED = 'sencho-labels-changed';

/**
 * Cross-component request to switch the active view.
 *
 * Lives here rather than beside its original dispatcher (`NodeManager`) so
 * lib-level callers (the GitOps portfolio's navigation helpers) do not import
 * a page component; `NodeManager` re-exports both for existing call sites.
 */
export const SENCHO_NAVIGATE_EVENT = 'sencho-navigate';

export interface SenchoNavigateDetail {
  view: 'scheduled-ops' | 'auto-updates' | 'security' | 'fleet' | 'networking' | 'resources' | 'gitops';
  nodeId?: number;
  /** Target tab when navigating to the Security view. */
  tab?: SecurityTab;
  /** Target tab when navigating to the Fleet view (e.g. 'snapshots'). */
  fleetTab?: FleetTab;
}

/** Open a stack on a given node from elsewhere in the app (e.g. a Resources network card). */
export const SENCHO_OPEN_STACK_EVENT = 'sencho-open-stack';

export interface SenchoOpenStackDetail {
  nodeId: number;
  stackName: string;
  destination?: 'stack' | 'editor' | 'anatomy-networking' | 'doctor' | 'dossier' | 'drift' | 'git';
}

/** Tabs of the top-level Security view. Used by the nav state and by
 *  cross-component navigate events that deep-link into a specific tab. */
export type SecurityTab =
  | 'overview'
  | 'images'
  | 'compose'
  | 'secrets'
  | 'policies'
  | 'suppressions'
  | 'history'
  | 'scanner';

/** Tabs of the Fleet update-availability sheet. */
export type FleetUpdatesTab = 'nodes' | 'changelog';

/** Fleet view sub-tabs, used for deep-link navigation (e.g. the stack storage
 *  warning linking to Snapshots). Mirrors the TabsTrigger values in FleetView. */
export type FleetTab =
  | 'overview'
  | 'snapshots'
  | 'configuration'
  | 'dependencies'
  | 'container-labels'
  | 'deployments'
  | 'routing'
  | 'federation'
  | 'actions'
  | 'secrets';
