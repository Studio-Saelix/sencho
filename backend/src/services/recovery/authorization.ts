import type { Request, Response } from 'express';
import { checkPermission, type PermissionAction } from '../../middleware/permissions';
import { StorageIdentityStore } from './storageIdentity';
import { errorDetailFor } from './redaction';
import type { StorageDependent } from './types';

/**
 * Recovery authorization, on the canonical RBAC engine.
 *
 *   read      view coverage, history, browse, download   stack:read on every dependent stack
 *   protect   create a root or path point                stack:edit on every dependent stack
 *   restore   restore or undo                            stack:edit on every dependent stack
 *   configure repositories, keys, blocking policy        system:settings
 *
 * Storage shared by several stacks is authorized against all of them: the
 * stacks recorded at the last observation and the stacks the caller found
 * using it now, so a dependency added or dropped since cannot narrow the check.
 * Storage with no dependent stack needs the action globally.
 *
 * The live set must come from the node's own current Compose model, resolved
 * just before the check. A dependent added after the check is covered only by
 * the next check: the storage lock serializes recovery operations, not Compose
 * edits.
 *
 * The check runs on the node that owns the storage, with the request as it
 * arrived there, so a request relayed by the hub (direct proxy or Pilot) is
 * held to the same rule: machine-auth stack evidence names one stack and can
 * never stand in for the others.
 */
export type RecoveryAccess = 'read' | 'protect' | 'restore' | 'configure';

export const RECOVERY_ACCESS_ACTION: Readonly<Record<RecoveryAccess, PermissionAction>> = {
  read: 'stack:read',
  protect: 'stack:edit',
  restore: 'stack:edit',
  configure: 'system:settings',
};

export interface RecoveryAuthorization {
  allowed: boolean;
  action: PermissionAction;
  /** Every stack the decision covered. */
  checkedStacks: string[];
  /** The stacks the caller lacks the action on. Never sent to the client. */
  deniedStacks: string[];
}

export function authorizeStorageAccess(
  req: Request,
  access: RecoveryAccess,
  target: { storageKey: string; liveDependents: readonly StorageDependent[] } | null,
): RecoveryAuthorization {
  const action = RECOVERY_ACCESS_ACTION[access];
  if (access === 'configure' || target === null) {
    const allowed = checkPermission(req, action);
    return { allowed, action, checkedStacks: [], deniedStacks: [] };
  }

  const stacks = new Set<string>();
  for (const d of StorageIdentityStore.getInstance().listDependents(target.storageKey)) stacks.add(d.stackName);
  for (const d of target.liveDependents) stacks.add(d.stackName);
  const checkedStacks = [...stacks].sort();

  if (checkedStacks.length === 0) {
    const allowed = checkPermission(req, action);
    return { allowed, action, checkedStacks, deniedStacks: [] };
  }
  const deniedStacks = checkedStacks.filter((stack) => !checkPermission(req, action, 'stack', stack));
  return { allowed: deniedStacks.length === 0, action, checkedStacks, deniedStacks };
}

/** Guard form: answers 403 without naming the stacks, so a denial leaks no stack names. */
export function requireStorageAccess(
  req: Request,
  res: Response,
  access: RecoveryAccess,
  target: { storageKey: string; liveDependents: readonly StorageDependent[] } | null,
): boolean {
  if (authorizeStorageAccess(req, access, target).allowed) return true;
  res.status(403).json({ error: errorDetailFor('permission_denied'), code: 'PERMISSION_DENIED' });
  return false;
}
