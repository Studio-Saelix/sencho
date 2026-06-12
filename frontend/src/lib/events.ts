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
