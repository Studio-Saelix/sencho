/**
 * Single source of truth for scheduled-operation action metadata that the
 * backend needs for validation. The route layer derives its allow-list and
 * action/target compatibility checks from this table, so adding a new action
 * means adding one entry here (plus its execution logic in SchedulerService).
 *
 * The frontend keeps its own richer registry (labels, categories, tones) in
 * `frontend/src/lib/scheduledActions.ts`; the two cannot share a module because
 * the packages build in isolation. The shapes are kept in lockstep by tests on
 * each side.
 */

export const VALID_TARGET_TYPES = ['stack', 'fleet', 'system'] as const;
export type TargetType = typeof VALID_TARGET_TYPES[number];

export interface BackendScheduledActionDefinition {
  readonly id: string;
  /** Target types this action accepts. `update` is the only multi-target action. */
  readonly targetTypes: readonly TargetType[];
  readonly requiresNode: boolean;
  readonly nodeScope?: 'local';
}

/**
 * Ordered so the `VALID_ACTIONS` list matches the human-readable error message
 * in `routes/scheduledTasks.ts` ("Must be restart, snapshot, prune, ...").
 */
export const BACKEND_SCHEDULED_ACTIONS = [
  { id: 'restart', targetTypes: ['stack'], requiresNode: true },
  { id: 'snapshot', targetTypes: ['fleet'], requiresNode: false },
  { id: 'prune', targetTypes: ['system'], requiresNode: true, nodeScope: 'local' },
  { id: 'update', targetTypes: ['stack', 'fleet'], requiresNode: true },
  { id: 'scan', targetTypes: ['system'], requiresNode: true, nodeScope: 'local' },
  { id: 'auto_backup', targetTypes: ['stack'], requiresNode: true },
  { id: 'auto_stop', targetTypes: ['stack'], requiresNode: true },
  { id: 'auto_down', targetTypes: ['stack'], requiresNode: true },
  { id: 'auto_start', targetTypes: ['stack'], requiresNode: true },
] as const satisfies readonly BackendScheduledActionDefinition[];

export type BackendScheduledAction = typeof BACKEND_SCHEDULED_ACTIONS[number]['id'];

export const VALID_ACTIONS: readonly BackendScheduledAction[] =
  BACKEND_SCHEDULED_ACTIONS.map(a => a.id);

/**
 * Human-readable allow-list for the route's 400 response. Built from
 * VALID_ACTIONS so a new action cannot leave this enumeration stale.
 */
export const INVALID_ACTION_MESSAGE =
  `Invalid action. Must be ${VALID_ACTIONS.join(', ').replace(/, ([^,]+)$/, ', or $1')}.`;

const ACTION_BY_ID = new Map<BackendScheduledAction, BackendScheduledActionDefinition>(
  BACKEND_SCHEDULED_ACTIONS.map(a => [a.id, a]),
);

/**
 * Per-action mismatch message. The wording differs per action and is part of
 * the API contract, so it is kept explicit rather than templated.
 */
const TARGET_MISMATCH_MESSAGE: Record<BackendScheduledAction, string> = {
  restart: 'Restart action requires target_type "stack".',
  snapshot: 'Snapshot action requires target_type "fleet".',
  prune: 'Prune action requires target_type "system".',
  update: 'Update action requires target_type "stack" or "fleet".',
  scan: 'Scan action requires target_type "system".',
  auto_backup: 'auto_backup action requires target_type "stack".',
  auto_stop: 'auto_stop action requires target_type "stack".',
  auto_down: 'auto_down action requires target_type "stack".',
  auto_start: 'auto_start action requires target_type "stack".',
};

/**
 * Validate that the target_type is compatible with the action. Returns an error
 * message on mismatch and null otherwise. Callers must already have confirmed
 * the action is in `VALID_ACTIONS`.
 */
export function validateActionTarget(action: BackendScheduledAction, targetType: TargetType): string | null {
  const def = ACTION_BY_ID.get(action);
  if (!def) return null;
  return def.targetTypes.includes(targetType) ? null : TARGET_MISMATCH_MESSAGE[action];
}

export function getScheduledActionDefinition(action: BackendScheduledAction): BackendScheduledActionDefinition | undefined {
  return ACTION_BY_ID.get(action);
}
