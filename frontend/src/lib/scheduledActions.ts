import type { ScheduledTask } from '@/types/scheduling';

/**
 * Single source of truth for scheduled-operation action metadata on the
 * frontend. Drives the create-flow action picker, the All Tasks label column,
 * the Timeline lanes, and the mobile schedule labels/tones. Adding a new action
 * means adding one entry here (plus its execution logic on the backend).
 *
 * The backend keeps a leaner validation-only registry in
 * `backend/src/services/scheduledActionRegistry.ts`; the packages build in
 * isolation so the two cannot share a module. Tests on each side keep the
 * action sets in lockstep.
 */

/** Backend action ids (the 9 values that travel on the wire). */
export type BackendAction = ScheduledTask['action'];

/**
 * UI action ids. `update-fleet` is a frontend-only alias for `update` with
 * `target_type: 'fleet'`; it never reaches the backend.
 */
export type ScheduledActionId = BackendAction | 'update-fleet';

export type ScheduledActionCategory = 'lifecycle' | 'updates' | 'security' | 'maintenance' | 'backups';
export type ScheduledActionTone = 'success' | 'warning' | 'destructive' | 'brand';

export interface ScheduledActionDefinition {
  id: ScheduledActionId;
  /** The action value sent to the backend (`update-fleet` maps to `update`). */
  backendAction: BackendAction;
  label: string;
  /** Compact label used on the mobile schedule view. */
  shortLabel: string;
  category: ScheduledActionCategory;
  targetType: ScheduledTask['target_type'];
  tone: ScheduledActionTone;
  requiresNode: boolean;
  requiresStack: boolean;
  supportsServiceSelection: boolean;
  nodeScope?: 'local';
  helperText?: string;
}

/** Ordered for the create-flow action picker. */
export const SCHEDULED_ACTIONS: ScheduledActionDefinition[] = [
  { id: 'restart', backendAction: 'restart', label: 'Restart Stack', shortLabel: 'restart', category: 'lifecycle', targetType: 'stack', tone: 'brand', requiresNode: true, requiresStack: true, supportsServiceSelection: true },
  { id: 'update', backendAction: 'update', label: 'Auto-update Stack', shortLabel: 'update', category: 'updates', targetType: 'stack', tone: 'success', requiresNode: true, requiresStack: true, supportsServiceSelection: false },
  { id: 'update-fleet', backendAction: 'update', label: 'Auto-update All Stacks', shortLabel: 'update', category: 'updates', targetType: 'fleet', tone: 'success', requiresNode: true, requiresStack: false, supportsServiceSelection: false, helperText: 'Every stack on the selected node will be checked and updated when new images are available.' },
  { id: 'snapshot', backendAction: 'snapshot', label: 'Fleet Snapshot', shortLabel: 'snapshot', category: 'backups', targetType: 'fleet', tone: 'warning', requiresNode: false, requiresStack: false, supportsServiceSelection: false },
  { id: 'prune', backendAction: 'prune', label: 'System Prune', shortLabel: 'prune', category: 'maintenance', targetType: 'system', tone: 'warning', requiresNode: true, requiresStack: false, supportsServiceSelection: false, nodeScope: 'local', helperText: 'Resources are pruned on the selected node. Prunes run on local nodes only.' },
  { id: 'scan', backendAction: 'scan', label: 'Vulnerability Scan', shortLabel: 'scan', category: 'security', targetType: 'system', tone: 'success', requiresNode: true, requiresStack: false, supportsServiceSelection: false, nodeScope: 'local', helperText: 'Every image on the selected node will be scanned. Scans run on local nodes only.' },
  { id: 'auto_backup', backendAction: 'auto_backup', label: 'Backup Stack Files', shortLabel: 'backup', category: 'lifecycle', targetType: 'stack', tone: 'brand', requiresNode: true, requiresStack: true, supportsServiceSelection: false },
  { id: 'auto_stop', backendAction: 'auto_stop', label: 'Stop Stack (keep containers)', shortLabel: 'stop', category: 'lifecycle', targetType: 'stack', tone: 'warning', requiresNode: true, requiresStack: true, supportsServiceSelection: false },
  { id: 'auto_down', backendAction: 'auto_down', label: 'Take Stack Down (remove containers)', shortLabel: 'down', category: 'lifecycle', targetType: 'stack', tone: 'destructive', requiresNode: true, requiresStack: true, supportsServiceSelection: false },
  { id: 'auto_start', backendAction: 'auto_start', label: 'Start Stack', shortLabel: 'start', category: 'lifecycle', targetType: 'stack', tone: 'success', requiresNode: true, requiresStack: true, supportsServiceSelection: false },
];

const ACTION_BY_ID = new Map<string, ScheduledActionDefinition>(SCHEDULED_ACTIONS.map(a => [a.id, a]));

export function getActionById(id: string): ScheduledActionDefinition | undefined {
  return ACTION_BY_ID.get(id);
}

/**
 * Resolve a stored task to its action definition. A stored `update` task with a
 * `fleet` target maps to the `update-fleet` UI entry; everything else maps by
 * its backend action id.
 */
export function resolveTaskAction(
  task: Pick<ScheduledTask, 'action' | 'target_type'>,
): ScheduledActionDefinition | undefined {
  if (task.action === 'update' && task.target_type === 'fleet') {
    return getActionById('update-fleet');
  }
  return getActionById(task.action);
}

export interface ScheduledActionCategoryLane {
  key: ScheduledActionCategory;
  label: string;
  color: string;
  bg: string;
}

/** Ordered Timeline lanes; each scheduled action maps to one lane by category. */
export const SCHEDULED_ACTION_CATEGORIES: ScheduledActionCategoryLane[] = [
  { key: 'lifecycle', label: 'Lifecycle', color: 'var(--label-blue)', bg: 'var(--label-blue-bg)' },
  { key: 'updates', label: 'Updates', color: 'var(--success)', bg: 'oklch(from var(--success) l c h / 0.18)' },
  { key: 'security', label: 'Security', color: 'var(--label-purple)', bg: 'var(--label-purple-bg)' },
  { key: 'maintenance', label: 'Maintenance', color: 'var(--warning)', bg: 'oklch(from var(--warning) l c h / 0.18)' },
  { key: 'backups', label: 'Backups', color: 'var(--brand)', bg: 'oklch(from var(--brand) l c h / 0.18)' },
];
