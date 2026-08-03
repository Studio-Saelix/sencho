/** Mirrors backend ROLE_PERMISSIONS for Settings visibility matrix tests. */
import type { PermissionAction } from '@/context/AuthContext';

export const ROLE_PERMISSIONS: Record<string, PermissionAction[]> = {
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
