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

/** Open a stack on a given node from elsewhere in the app (e.g. a Resources network card). */
export const SENCHO_OPEN_STACK_EVENT = 'sencho-open-stack';

export interface SenchoOpenStackDetail {
  nodeId: number;
  stackName: string;
}
