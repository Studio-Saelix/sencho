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

/** Risk level assigned to each scheduled action, shown as a badge in the create/edit form. */
export type ScheduledActionRiskLevel = 'safe' | 'read-only' | 'interruptive' | 'runtime-change' | 'removes-containers' | 'destructive';

/** Human-readable label for each risk level. */
export const RISK_LABEL: Record<ScheduledActionRiskLevel, string> = {
  'safe': 'Safe',
  'read-only': 'Read-only',
  'interruptive': 'Interruptive',
  'runtime-change': 'Runtime change',
  'removes-containers': 'Removes containers',
  'destructive': 'Destructive',
};

/** Design-system tone for each risk level. */
export const RISK_TONE: Record<ScheduledActionRiskLevel, ScheduledActionTone> = {
  'safe': 'success',
  'read-only': 'brand',
  'interruptive': 'warning',
  'runtime-change': 'warning',
  'removes-containers': 'destructive',
  'destructive': 'destructive',
};

/** Chip border/background/text classes for each risk level. */
export const RISK_BADGE_CLASSES: Record<ScheduledActionRiskLevel, string> = {
  'safe': 'border-success/25 bg-success/8 text-success',
  'read-only': 'border-brand/25 bg-brand/8 text-brand',
  'interruptive': 'border-warning/25 bg-warning/8 text-warning',
  'runtime-change': 'border-warning/25 bg-warning/8 text-warning',
  'removes-containers': 'border-destructive/25 bg-destructive/8 text-destructive',
  'destructive': 'border-destructive/25 bg-destructive/8 text-destructive',
};

/** Leading dot fill class for each risk level. */
export const RISK_DOT_CLASSES: Record<ScheduledActionRiskLevel, string> = {
  'safe': 'bg-success',
  'read-only': 'bg-brand',
  'interruptive': 'bg-warning',
  'runtime-change': 'bg-warning',
  'removes-containers': 'bg-destructive',
  'destructive': 'bg-destructive',
};

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
  /** One-line explanation shown below the action picker in the create/edit form. */
  helperText: string;
  /** Risk level shown as a coloured chip next to the helper text. */
  riskLevel: ScheduledActionRiskLevel;
}

/** Action pre-selected when the create modal opens. Decoupled from picker order. */
export const DEFAULT_SCHEDULED_ACTION_ID: ScheduledActionId = 'restart';

/** Ordered for the create-flow action picker, grouped by category. */
export const SCHEDULED_ACTIONS: ScheduledActionDefinition[] = [
  // Lifecycle
  { id: 'auto_backup', backendAction: 'auto_backup', label: 'Backup Stack Compose Files', shortLabel: 'backup', category: 'lifecycle', targetType: 'stack', tone: 'brand', requiresNode: true, requiresStack: true, supportsServiceSelection: false, helperText: 'Backs up compose and env files only. This does not back up application volumes.', riskLevel: 'safe' },
  { id: 'auto_start', backendAction: 'auto_start', label: 'Start / Bring Up Stack', shortLabel: 'start', category: 'lifecycle', targetType: 'stack', tone: 'success', requiresNode: true, requiresStack: true, supportsServiceSelection: false, helperText: 'Creates containers if they do not exist, or starts existing stopped containers.', riskLevel: 'runtime-change' },
  { id: 'restart', backendAction: 'restart', label: 'Restart Stack', shortLabel: 'restart', category: 'lifecycle', targetType: 'stack', tone: 'brand', requiresNode: true, requiresStack: true, supportsServiceSelection: true, helperText: 'Restarts containers in place. Running services are stopped and started again on the same configuration.', riskLevel: 'interruptive' },
  { id: 'auto_stop', backendAction: 'auto_stop', label: 'Stop Stack', shortLabel: 'stop', category: 'lifecycle', targetType: 'stack', tone: 'warning', requiresNode: true, requiresStack: true, supportsServiceSelection: false, helperText: 'Stops containers but keeps them in place for a faster start later.', riskLevel: 'interruptive' },
  { id: 'auto_down', backendAction: 'auto_down', label: 'Take Stack Down', shortLabel: 'down', category: 'lifecycle', targetType: 'stack', tone: 'destructive', requiresNode: true, requiresStack: true, supportsServiceSelection: false, helperText: 'Runs compose down. Containers are removed, but compose files remain on disk.', riskLevel: 'removes-containers' },
  // Updates
  { id: 'update', backendAction: 'update', label: 'Auto-update Stack', shortLabel: 'update', category: 'updates', targetType: 'stack', tone: 'success', requiresNode: true, requiresStack: true, supportsServiceSelection: false, helperText: 'Checks this stack\'s images and recreates the stack only when newer images are available.', riskLevel: 'runtime-change' },
  { id: 'update-fleet', backendAction: 'update', label: 'Auto-update All Stacks on Node', shortLabel: 'update node', category: 'updates', targetType: 'fleet', tone: 'success', requiresNode: true, requiresStack: false, supportsServiceSelection: false, helperText: 'Checks every stack on the selected node and updates stacks with newer images.', riskLevel: 'runtime-change' },
  // Security
  { id: 'scan', backendAction: 'scan', label: 'Scan Node Images', shortLabel: 'scan', category: 'security', targetType: 'system', tone: 'success', requiresNode: true, requiresStack: false, supportsServiceSelection: false, nodeScope: 'local', helperText: 'Runs Trivy against images on the selected local node and records the findings.', riskLevel: 'read-only' },
  // Maintenance
  { id: 'prune', backendAction: 'prune', label: 'Prune Node Resources', shortLabel: 'prune', category: 'maintenance', targetType: 'system', tone: 'warning', requiresNode: true, requiresStack: false, supportsServiceSelection: false, nodeScope: 'local', helperText: 'Removes unused Docker resources on the selected node. Be careful when pruning volumes.', riskLevel: 'destructive' },
  // Backups
  { id: 'snapshot', backendAction: 'snapshot', label: 'Create Fleet Snapshot', shortLabel: 'snapshot', category: 'backups', targetType: 'fleet', tone: 'warning', requiresNode: false, requiresStack: false, supportsServiceSelection: false, helperText: 'Creates a versioned snapshot of compose and env files across the fleet.', riskLevel: 'safe' },
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
