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
 * Union of PermissionAction values conferred by the user's stack-scoped
 * assignments for one (nodeId, stackName) tuple. Used when the hub builds
 * bound evidence for a remote hop.
 */
export function scopedActionsForStack(
  userId: number,
  nodeId: number,
  stackName: string,
): PermissionAction[] {
  const assignments = DatabaseService.getInstance().getRoleAssignments(
    userId,
    'stack',
    stackName,
    nodeId,
  );
  const actions = new Set<PermissionAction>();
  for (const assignment of assignments) {
    for (const action of ROLE_PERMISSIONS[assignment.role] ?? []) {
      // Evidence is stack-bound only. Never forward node:/system: from a
      // scoped Admin or Node Admin matrix onto the machine-auth hop.
      if (action.startsWith('stack:')) {
        actions.add(action);
      }
    }
  }
  return [...actions];
}

/** Core permission resolver. Admin bypasses all checks; scoped assignments only apply on the paid tier. */
export function checkPermission(
  req: Request,
  action: PermissionAction,
  resourceType?: ResourceType,
  resourceId?: string,
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

  if (effectiveTier(req) !== 'paid') return false;

  const nodeId = resourceType === 'stack' ? req.nodeId : null;
  const assignments = DatabaseService.getInstance().getRoleAssignments(
    req.user.userId,
    resourceType,
    resourceId,
    nodeId,
  );
  if (isDebugEnabled()) console.log('[RBAC:diag] Scoped assignments found:', assignments.length, 'for user:', req.user.userId);
  for (const assignment of assignments) {
    if (ROLE_PERMISSIONS[assignment.role]?.includes(action)) return true;
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
): boolean {
  if (checkPermission(req, action, resourceType, resourceId)) return true;
  res.status(403).json({ error: 'Permission denied.', code: 'PERMISSION_DENIED' });
  return false;
}
