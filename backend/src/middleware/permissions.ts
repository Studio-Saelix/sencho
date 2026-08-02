import type { Request, Response } from 'express';
import { DatabaseService, type UserRole, type ResourceType } from '../services/DatabaseService';
import { isDebugEnabled } from '../utils/debug';
import { sanitizeForLog } from '../utils/safeLog';
import { effectiveTier } from './tierGates';

// --- Scoped RBAC Permission Engine (paid) ---

export type PermissionAction =
  | 'stack:read' | 'stack:edit' | 'stack:deploy' | 'stack:create' | 'stack:delete'
  | 'node:read' | 'node:manage'
  | 'system:settings' | 'system:users' | 'system:license' | 'system:webhooks'
  | 'system:tokens' | 'system:console' | 'system:audit' | 'system:registries';

export const ROLE_PERMISSIONS: Record<UserRole, PermissionAction[]> = {
  admin: [
    'stack:read', 'stack:edit', 'stack:deploy', 'stack:create', 'stack:delete',
    'node:read', 'node:manage',
    'system:settings', 'system:users', 'system:license', 'system:webhooks',
    'system:tokens', 'system:console', 'system:audit', 'system:registries',
  ],
  'node-admin': [
    'stack:read', 'stack:edit', 'stack:deploy', 'stack:create', 'stack:delete',
    'node:read', 'node:manage',
  ],
  deployer: [
    'stack:read', 'stack:deploy',
  ],
  viewer: [
    'stack:read', 'node:read',
  ],
  auditor: [
    'stack:read', 'node:read', 'system:audit',
  ],
};

/** Canonical PermissionAction set (admin matrix covers every action). */
export const ALL_PERMISSION_ACTIONS: readonly PermissionAction[] = ROLE_PERMISSIONS.admin;

export function isPermissionAction(value: string): value is PermissionAction {
  return (ALL_PERMISSION_ACTIONS as readonly string[]).includes(value);
}

/**
 * Collect stack:* actions from role matrices. Used for remote evidence so
 * node:/system: never leave the hub on a machine-auth hop.
 */
function addStackActionsFromRole(
  actions: Set<PermissionAction>,
  role: UserRole,
): void {
  for (const action of ROLE_PERMISSIONS[role] ?? []) {
    if (action.startsWith('stack:')) {
      actions.add(action);
    }
  }
}

/**
 * Union of PermissionAction values conferred by the user's exact stack
 * grant for (nodeId, stackName), plus any node-scoped grant on that node
 * (node-wide roles cover every stack on the node). Used when the hub
 * builds bound evidence for a remote hop.
 */
export function scopedActionsForStack(
  userId: number,
  nodeId: number,
  stackName: string,
): PermissionAction[] {
  const db = DatabaseService.getInstance();
  const actions = new Set<PermissionAction>();
  for (const assignment of db.getRoleAssignments(userId, 'stack', stackName, nodeId)) {
    addStackActionsFromRole(actions, assignment.role);
  }
  for (const assignment of db.getRoleAssignments(userId, 'node', String(nodeId))) {
    addStackActionsFromRole(actions, assignment.role);
  }
  return [...actions];
}

/** Core permission resolver. Admin bypasses all checks; scoped assignments only apply on the paid tier. */
export function checkPermission(
  req: Request,
  action: PermissionAction,
  resourceType?: ResourceType,
  resourceId?: string,
  resourceNodeId?: number | null,
): boolean {
  if (!req.user) return false;

  const globalRole = req.user.role;

  if (isDebugEnabled()) console.log('[RBAC:diag] checkPermission:', sanitizeForLog(action), 'user:', sanitizeForLog(req.user.username), 'globalRole:', globalRole, 'resource:', sanitizeForLog(resourceType), sanitizeForLog(resourceId));

  if (globalRole === 'admin') return true;
  if (ROLE_PERMISSIONS[globalRole]?.includes(action)) return true;

  if (!resourceType || !resourceId) return false;

  // Bound machine evidence from the hub (node_proxy / pilot_tunnel only).
  // Authorizes exact stack + action members of the evidenced set without a
  // local role_assignments row (remote userId is 0).
  const evidence = req.scopedStackEvidence;
  if (
    evidence
    && resourceType === 'stack'
    && resourceId === evidence.stackName
    && action.startsWith('stack:')
    && evidence.actions.has(action)
  ) {
    return true;
  }

  const tier = effectiveTier(req);
  if (tier !== 'paid') {
    console.warn('[RBAC] Scoped assignment check blocked: effective tier is', sanitizeForLog(tier), 'license_status:', sanitizeForLog(DatabaseService.getInstance().getSystemState('license_status') ?? ''));
    return false;
  }

  const db = DatabaseService.getInstance();
  const nodeId = resourceType === 'stack'
    ? (resourceNodeId === undefined ? req.nodeId : resourceNodeId)
    : null;
  const assignments = db.getRoleAssignments(
    req.user.userId,
    resourceType,
    resourceId,
    nodeId,
  );
  for (const assignment of assignments) {
    if (ROLE_PERMISSIONS[assignment.role]?.includes(action)) return true;
  }

  // Node-scoped grants are node-wide: a Node Admin / Deployer / Admin on
  // node N authorizes that role's stack actions for every stack on N.
  if (resourceType === 'stack' && nodeId != null) {
    const nodeAssignments = db.getRoleAssignments(
      req.user.userId,
      'node',
      String(nodeId),
    );
    for (const assignment of nodeAssignments) {
      if (ROLE_PERMISSIONS[assignment.role]?.includes(action)) return true;
    }
  }

  return false;
}

/** Generic permission guard: sends 403 if denied. */
export function requirePermission(
  req: Request,
  res: Response,
  action: PermissionAction,
  resourceType?: ResourceType,
  resourceId?: string,
  resourceNodeId?: number | null,
): boolean {
  if (checkPermission(req, action, resourceType, resourceId, resourceNodeId)) return true;
  res.status(403).json({ error: 'Permission denied.', code: 'PERMISSION_DENIED' });
  return false;
}
