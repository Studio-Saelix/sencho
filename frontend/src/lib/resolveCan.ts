/** Mirrors AuthContext PermissionAction / UserRole for the pure resolver (no circular import). */
export type ResolveCanRole = 'admin' | 'viewer' | 'deployer' | 'node-admin' | 'auditor';

export type ResolveCanAction =
  | 'stack:read' | 'stack:edit' | 'stack:deploy' | 'stack:create' | 'stack:delete'
  | 'node:read' | 'node:manage'
  | 'system:settings' | 'system:users' | 'system:license' | 'system:webhooks'
  | 'system:tokens' | 'system:console' | 'system:audit' | 'system:registries';

export interface PermissionsSnapshot {
  globalRole: ResolveCanRole;
  globalPermissions: ResolveCanAction[];
  scopedPermissions: Record<string, ResolveCanAction[]>;
}

/**
 * Pure permission resolver for AuthContext.can and unit tests.
 * Stack scopes are keyed `stack:${nodeId}:${stackName}`; missing nodeId
 * fails closed for stack lookups after the global matrix is checked.
 * Node scopes stay `node:${id}`.
 */
export function resolveCan(
  permissions: PermissionsSnapshot | null,
  action: ResolveCanAction,
  resourceType?: string,
  resourceId?: string,
  nodeId?: number | null,
): boolean {
  if (!permissions) return false;

  if (permissions.globalRole === 'admin') return true;

  if (permissions.globalPermissions.includes(action)) return true;

  if (!resourceType || !resourceId) return false;

  if (resourceType === 'stack') {
    if (nodeId === undefined || nodeId === null) return false;
    const key = `stack:${nodeId}:${resourceId}`;
    return permissions.scopedPermissions[key]?.includes(action) ?? false;
  }

  const key = `${resourceType}:${resourceId}`;
  return permissions.scopedPermissions[key]?.includes(action) ?? false;
}
