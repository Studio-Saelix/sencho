/**
 * Single source of truth for scheduled-operation action metadata that the
 * backend needs for validation and authorization. The route layer derives its
 * allow-list, action/target compatibility checks, and permission enforcement
 * from this table, so adding a new action means adding one entry here
 * (plus its execution logic in SchedulerService).
 *
 * The frontend keeps its own richer registry (labels, categories, tones) in
 * `frontend/src/lib/scheduledActions.ts`; the two cannot share a module because
 * the packages build in isolation. The shapes are kept in lockstep by tests on
 * each side.
 */

import type { PermissionAction } from '../middleware/permissions';
import type { ResourceType } from './DatabaseService';

export const VALID_TARGET_TYPES = ['stack', 'fleet', 'system', 'container'] as const;
export type TargetType = typeof VALID_TARGET_TYPES[number];

export interface BackendScheduledActionDefinition {
  readonly id: string;
  /** Target types this action accepts. `update` is the only multi-target action. */
  readonly targetTypes: readonly TargetType[];
  readonly requiresNode: boolean;
  readonly nodeScope?: 'local';
  /** Permission required to create, edit, enable, run, or delete a schedule for this action. */
  readonly permission: PermissionAction;
}

/**
 * Permission scope resolved from a task's action, target, and node identity.
 * When `resourceType` is omitted the check is unscoped (global role matrix only).
 */
export interface ScheduledActionPermissionScope {
  readonly action: PermissionAction;
  readonly resourceType?: ResourceType;
  readonly resourceId?: string;
  readonly resourceNodeId?: number | null;
}

/**
 * Ordered so the `VALID_ACTIONS` list matches the human-readable error message
 * in `routes/scheduledTasks.ts` ("Must be restart, snapshot, prune, ...").
 */
export const BACKEND_SCHEDULED_ACTIONS = [
  { id: 'restart',    targetTypes: ['stack', 'container'], requiresNode: true,  permission: 'stack:deploy' as const },
  { id: 'snapshot',   targetTypes: ['fleet'],              requiresNode: false, permission: 'node:manage' as const },
  { id: 'prune',      targetTypes: ['system'],             requiresNode: true,  nodeScope: 'local' as const, permission: 'system:settings' as const },
  { id: 'update',     targetTypes: ['stack', 'fleet'],     requiresNode: true,  permission: 'stack:deploy' as const },
  { id: 'scan',       targetTypes: ['system'],             requiresNode: true,  nodeScope: 'local' as const, permission: 'node:manage' as const },
  { id: 'auto_backup',targetTypes: ['stack'],              requiresNode: true,  permission: 'stack:deploy' as const },
  { id: 'auto_stop',  targetTypes: ['stack', 'container'], requiresNode: true,  permission: 'stack:deploy' as const },
  { id: 'auto_down',  targetTypes: ['stack'],              requiresNode: true,  permission: 'stack:deploy' as const },
  { id: 'auto_start', targetTypes: ['stack', 'container'], requiresNode: true,  permission: 'stack:deploy' as const },
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
  restart: 'Restart action requires target_type "stack" or "container".',
  snapshot: 'Snapshot action requires target_type "fleet".',
  prune: 'Prune action requires target_type "system".',
  update: 'Update action requires target_type "stack" or "fleet".',
  scan: 'Scan action requires target_type "system".',
  auto_backup: 'auto_backup action requires target_type "stack".',
  auto_stop: 'auto_stop action requires target_type "stack" or "container".',
  auto_down: 'auto_down action requires target_type "stack".',
  auto_start: 'auto_start action requires target_type "stack" or "container".',
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

/**
 * Resolve the permission scope for a scheduled action + target combination.
 * This is the single source of truth consumed by the route layer and the
 * scheduler revalidation path. Scope resolution is per-action, not per
 * target-type bucket.
 */
export function resolveTaskPermissionScope(
  action: BackendScheduledAction,
  targetType: TargetType,
  targetId: string | null,
  nodeId: number | null,
  _selectorType?: string | null,
): ScheduledActionPermissionScope {
  const def = ACTION_BY_ID.get(action);
  const basePermission = def?.permission ?? 'stack:deploy';

  switch (action) {
    case 'restart':
    case 'auto_stop':
    case 'auto_start': {
      if (targetType === 'container') {
        return { action: 'node:manage', resourceType: 'node', resourceId: nodeId != null ? String(nodeId) : undefined, resourceNodeId: nodeId };
      }
      return { action: basePermission, resourceType: 'stack', resourceId: targetId ?? undefined, resourceNodeId: nodeId };
    }
    case 'auto_down':
    case 'auto_backup':
      return { action: basePermission, resourceType: 'stack', resourceId: targetId ?? undefined, resourceNodeId: nodeId };

    case 'update': {
      if (targetType === 'stack') {
        return { action: basePermission, resourceType: 'stack', resourceId: targetId ?? undefined, resourceNodeId: nodeId };
      }
      if (nodeId != null) {
        return { action: 'node:manage', resourceType: 'node', resourceId: String(nodeId), resourceNodeId: nodeId };
      }
      return { action: 'node:manage' };
    }

    case 'scan':
      return { action: basePermission, resourceType: 'node', resourceId: nodeId != null ? String(nodeId) : undefined, resourceNodeId: nodeId };

    case 'prune':
      return { action: basePermission };

    case 'snapshot':
      return { action: basePermission };

    default: {
      const exhaustive: never = action;
      return { action: exhaustive as never };
    }
  }
}
