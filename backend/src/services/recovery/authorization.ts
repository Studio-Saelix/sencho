import type { Request, Response } from 'express';
import { checkPermission, type PermissionAction } from '../../middleware/permissions';
import { StorageIdentityStore } from './storageIdentity';
import { errorDetailFor } from './redaction';
import type { StorageDependent } from './types';

/**
 * Recovery authorization, on the canonical RBAC engine.
 *
 *   read      view coverage and history                  stack:read on every dependent stack
 *   content   browse or download a point's contents      stack:read on every dependent stack
 *                                                        (node-wide when a model will not render),
 *                                                        system:settings when no stack depends on it now
 *   protect   create a root or path point                stack:edit on every dependent stack
 *   restore   restore or undo                            stack:edit on every dependent stack
 *   configure repositories, keys, blocking policy        system:settings
 *
 * Storage shared by several stacks is authorized against all of them: the
 * stacks recorded at the last observation and the stacks the caller found
 * using it now, so a dependency added or dropped since cannot narrow the check.
 * Storage with no dependent stack needs the action globally or through a role
 * assigned on the node itself, which covers every volume on that node.
 *
 * The live set must come from the node's own current Compose model, resolved
 * just before the check. A dependent added after the check is covered only by
 * the next check: the storage lock serializes recovery operations, not Compose
 * edits.
 *
 * The check runs on the node that owns the storage, with the request as it
 * arrived there, so a request relayed by the hub (direct proxy or Pilot) is
 * held to the same rule: machine-auth stack evidence names one stack and can
 * never stand in for the others. The hop arrives as user 0, so a role the user
 * holds on the node is resolved by the hub, which forwards the role that carries
 * it (see the recovery node-grant gate in the remote node proxy).
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

/**
 * The decision when no stack is known for the storage (none declares it, or the
 * dependent set could not be resolved): the action globally, or through a role
 * assigned on this node. A node role covers every volume on the node, and a
 * stack check honors it through the same node assignment, so a volume no stack
 * declares must not be the one place it is ignored. Repository and key settings
 * are never checked through a node assignment.
 */
function allowedWithoutStack(req: Request, access: RecoveryAccess, action: PermissionAction): boolean {
  if (checkPermission(req, action)) return true;
  if (access === 'configure' || typeof req.nodeId !== 'number') return false;
  return checkPermission(req, action, 'node', String(req.nodeId));
}

/**
 * The node-wide decision for one access, on its own. A route that has to check a
 * set of stacks one by one and then fall back for a workload no stack owns needs
 * exactly this, and it must be the same rule a storage with no dependent stack
 * gets, or a container started by hand would be the one thing the check misses.
 */
export function authorizeNodeWide(req: Request, access: RecoveryAccess): boolean {
  return allowedWithoutStack(req, access, RECOVERY_ACCESS_ACTION[access]);
}

export function authorizeStorageAccess(
  req: Request,
  access: RecoveryAccess,
  target: { storageKey: string; liveDependents: readonly StorageDependent[] } | null,
): RecoveryAuthorization {
  const action = RECOVERY_ACCESS_ACTION[access];
  if (access === 'configure' || target === null) {
    const allowed = allowedWithoutStack(req, access, action);
    return { allowed, action, checkedStacks: [], deniedStacks: [] };
  }

  const stacks = new Set<string>();
  for (const d of StorageIdentityStore.getInstance().listDependents(target.storageKey)) stacks.add(d.stackName);
  for (const d of target.liveDependents) stacks.add(d.stackName);
  const checkedStacks = [...stacks].sort();

  if (checkedStacks.length === 0) {
    const allowed = allowedWithoutStack(req, access, action);
    return { allowed, action, checkedStacks, deniedStacks: [] };
  }
  const deniedStacks = checkedStacks.filter((stack) => !checkPermission(req, action, 'stack', stack));
  return { allowed: deniedStacks.length === 0, action, checkedStacks, deniedStacks };
}

/**
 * What a content read is decided on, from the dependents resolved for the
 * request:
 *
 * - `attached`: a stack depends on the storage now, and every model rendered;
 *   `dependents` is every recorded and current dependent.
 * - `unrenderable`: a stack depends on it now, but a model could not be
 *   rendered, so the full set is unknown.
 * - `detached`: no stack depends on it now (a deleted stack's recorded rows do
 *   not count), its dependents could not be proven, or its record is missing.
 */
export type PointContentReadTarget =
  | { kind: 'attached'; storageKey: string; dependents: readonly [StorageDependent, ...StorageDependent[]] }
  | { kind: 'unrenderable' }
  | { kind: 'detached' };

/**
 * The target for a resolved storage. No current dependent makes it detached
 * whatever the recorded rows say; only then does an unrenderable model matter.
 */
export function pointContentReadTargetFor(
  storageKey: string,
  resolution: { kind: 'resolved' | 'unrenderable'; dependents: readonly StorageDependent[]; current: readonly StorageDependent[] },
): PointContentReadTarget {
  if (resolution.current.length === 0) return { kind: 'detached' };
  if (resolution.kind === 'unrenderable') return { kind: 'unrenderable' };
  // `current` is a subset of `dependents`, so the list is never empty here; the
  // type says so, which keeps an empty set from ever reaching the stack check.
  const [first, ...rest] = resolution.dependents;
  if (!first) return { kind: 'detached' };
  return { kind: 'attached', storageKey, dependents: [first, ...rest] };
}

/**
 * Whether the caller may read a point's contents.
 *
 * Attached storage is read under the ordinary rule: `stack:read` on every
 * recorded and current dependent. Unrenderable storage falls back to node-wide
 * `stack:read`. Detached storage is readable only with `system:settings`
 * globally: node-wide `stack:read` does not count, a node role never satisfies
 * it, and neither does `stack:read` on a name a deleted stack left in the
 * recorded rows, so an empty dependent set is never the reason a read is
 * allowed. If a dedicated recovery-administration action is added, it replaces
 * `system:settings` here and both read routes follow.
 */
export function authorizePointContentRead(req: Request, target: PointContentReadTarget): boolean {
  switch (target.kind) {
    case 'detached':
      return authorizeNodeWide(req, 'configure');
    case 'unrenderable':
      return authorizeNodeWide(req, 'read');
    case 'attached':
      return authorizeStorageAccess(req, 'read', { storageKey: target.storageKey, liveDependents: target.dependents }).allowed;
  }
}

/**
 * Whether the caller may be told that an id names nothing.
 *
 * A route that looks a record up before it authorizes would answer an unknown id
 * differently from one the caller may not touch, so a caller with no access could
 * learn which ids exist. An id that names nothing is therefore answered as a
 * denial, unless the caller holds every access the record could have required:
 * the same node-wide decision a storage with no dependent stack gets, for each
 * access listed. A caller holding it could read the record anyway.
 */
export function mayLearnIdIsUnknown(req: Request, ...accesses: RecoveryAccess[]): boolean {
  return accesses.every((access) => authorizeStorageAccess(req, access, null).allowed);
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
