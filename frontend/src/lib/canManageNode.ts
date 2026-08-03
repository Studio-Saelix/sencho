import type { PermissionAction } from '@/context/AuthContext';

type CanFn = (
  action: PermissionAction,
  resourceType?: string,
  resourceId?: string,
  nodeId?: number | null,
) => boolean;

/**
 * Resolve node:manage for the active node so scoped Node Admin grants apply.
 * When nodeId is missing, falls back to the unscoped check (same as Auth.can()).
 */
export function canManageNode(can: CanFn, nodeId: number | null | undefined): boolean {
  if (nodeId != null) {
    return can('node:manage', 'node', String(nodeId), nodeId);
  }
  return can('node:manage');
}
