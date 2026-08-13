import { describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, type PermissionAction } from '../middleware/permissions';
import { classifyStackApiPath } from '../helpers/stackRouteAuth';

describe('operational role matrix', () => {
  /**
   * Lockstep guard: every role's full permission set must match exactly.
   * Any addition or removal to ROLE_PERMISSIONS must update this table;
   * the full-set equality catches drift that a subset check would miss.
   */
  const expectedRoleActions: Record<string, PermissionAction[]> = {
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
    deployer: ['stack:read', 'stack:deploy'],
    viewer: ['stack:read', 'node:read'],
    auditor: ['stack:read', 'node:read', 'system:audit'],
  };

  for (const [role, expected] of Object.entries(expectedRoleActions)) {
    it(`${role} has exactly the expected permission set`, () => {
      const actual = [...(ROLE_PERMISSIONS[role as keyof typeof ROLE_PERMISSIONS] ?? [])].sort();
      expect(actual).toEqual([...expected].sort());
    });
  }
});

describe('named stack route permission inventory', () => {
  const routes: Array<[string, string, PermissionAction]> = [
    ['GET', '/stacks/web', 'stack:read'],
    ['GET', '/stacks/web/env', 'stack:read'],
    ['GET', '/stacks/web/services', 'stack:read'],
    ['GET', '/stacks/web/update-preview', 'stack:read'],
    ['GET', '/stacks/web/files/content', 'stack:read'],
    ['PUT', '/stacks/web', 'stack:edit'],
    ['PUT', '/stacks/web/env', 'stack:edit'],
    ['PUT', '/stacks/web/dossier', 'stack:edit'],
    ['PUT', '/stacks/web/labels', 'stack:edit'],
    ['POST', '/stacks/web/fleet-snapshot-apply', 'stack:edit'],
    ['POST', '/stacks/web/deploy', 'stack:deploy'],
    ['POST', '/stacks/web/stop', 'stack:deploy'],
    ['POST', '/stacks/web/services/api/update', 'stack:deploy'],
    ['POST', '/stacks/web/rollback', 'stack:deploy'],
    ['DELETE', '/stacks/web', 'stack:delete'],
  ];

  for (const [method, path, action] of routes) {
    it(`${method} ${path} requires ${action}`, () => {
      expect(classifyStackApiPath(method, path)).toEqual({
        kind: 'named-stack',
        stackName: 'web',
        action,
      });
    });
  }
});
