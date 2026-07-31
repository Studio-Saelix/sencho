import type { Request, Response } from 'express';
import { DatabaseService, type UserRole, type ResourceType } from '../services/DatabaseService';
import type { LicenseTier } from '../services/license-types';
import { isDebugEnabled } from '../utils/debug';
import { sanitizeForLog } from '../utils/safeLog';
import { effectiveTier } from './tierGates';

// --- Scoped RBAC Permission Engine (paid) ---

/** Permission subject decoupled from Express Request; used by in-process callers like the scheduler. */
export interface PermissionSubject { username: string; role: UserRole; userId: number; }

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

/**
 * Core permission resolver without a Request dependency. Admin bypasses all
 * checks; scoped assignments only apply on the paid tier. Used by in-process
 * callers (e.g. the scheduler) that have a subject + tier but no HTTP context.
 */
export function checkPermissionForSubject(
  subject: PermissionSubject,
  tier: LicenseTier,
  action: PermissionAction,
  resourceType?: ResourceType,
  resourceId?: string,
  resourceNodeId?: number | null,
): boolean {
  if (isDebugEnabled()) console.log('[RBAC:diag] checkPermissionForSubject:', sanitizeForLog(action), 'user:', sanitizeForLog(subject.username), 'globalRole:', sanitizeForLog(subject.role), 'resource:', sanitizeForLog(resourceType), sanitizeForLog(resourceId));

  if (subject.role === 'admin') return true;
  if (ROLE_PERMISSIONS[subject.role]?.includes(action)) return true;

  if (!resourceType || !resourceId) return false;

  if (tier !== 'paid') return false;

  const db = DatabaseService.getInstance();
  const nodeId = resourceType === 'stack' ? resourceNodeId ?? undefined : null;
  const assignments = db.getRoleAssignments(
    subject.userId,
    resourceType,
    resourceId,
    nodeId as number | undefined,
  );
  if (isDebugEnabled()) console.log('[RBAC:diag] Scoped assignments found:', assignments.length, 'for user:', subject.userId);
  for (const assignment of assignments) {
    if (ROLE_PERMISSIONS[assignment.role]?.includes(action)) return true;
  }

  // Node-scoped grants are node-wide: a Node Admin / Deployer / Admin on
  // node N authorizes that role's stack actions for every stack on N.
  if (resourceType === 'stack' && nodeId != null) {
    const nodeAssignments = db.getRoleAssignments(
      subject.userId,
      'node',
      String(nodeId),
    );
    for (const assignment of nodeAssignments) {
      if (ROLE_PERMISSIONS[assignment.role]?.includes(action)) return true;
    }
  }

  return false;
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

  // Bound machine evidence from the hub (node_proxy / pilot_tunnel only).
  // Authorizes exact stack + action members of the evidenced set without a
  // local role_assignments row (remote userId is 0). Resolve before the
  // subject-core call so the evidence short-circuit takes priority.
  if (resourceType && resourceId) {
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
  }

  const resolvedNodeId = resourceType === 'stack'
    ? (resourceNodeId === undefined ? req.nodeId : resourceNodeId)
    : resourceNodeId;

  return checkPermissionForSubject(
    { username: req.user.username, role: req.user.role, userId: req.user.userId },
    effectiveTier(req),
    action,
    resourceType,
    resourceId,
    resolvedNodeId,
  );
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
