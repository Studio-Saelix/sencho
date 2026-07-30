import { describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, type PermissionAction } from '../middleware/permissions';
import { classifyStackApiPath } from '../helpers/stackRouteAuth';

describe('operational role matrix', () => {
  const expectations: Record<string, { allow: PermissionAction[]; deny: PermissionAction[] }> = {
    admin: {
      allow: ['stack:read', 'stack:edit', 'stack:deploy', 'stack:create', 'stack:delete', 'node:read', 'node:manage', 'system:settings'],
      deny: [],
    },
    'node-admin': {
      allow: ['stack:read', 'stack:edit', 'stack:deploy', 'stack:create', 'stack:delete', 'node:read', 'node:manage'],
      deny: ['system:settings', 'system:users', 'system:license', 'system:registries'],
    },
    deployer: {
      allow: ['stack:read', 'stack:deploy'],
      deny: ['stack:edit', 'stack:create', 'stack:delete', 'node:read', 'node:manage', 'system:settings'],
    },
    viewer: {
      allow: ['stack:read', 'node:read'],
      deny: ['stack:edit', 'stack:deploy', 'stack:create', 'stack:delete', 'node:manage', 'system:audit'],
    },
    auditor: {
      allow: ['stack:read', 'node:read', 'system:audit'],
      deny: ['stack:edit', 'stack:deploy', 'stack:create', 'stack:delete', 'node:manage', 'system:settings'],
    },
  };

  for (const [role, expected] of Object.entries(expectations)) {
    it(`${role} exposes only its intended operational actions`, () => {
      const actions = ROLE_PERMISSIONS[role as keyof typeof ROLE_PERMISSIONS];
      for (const action of expected.allow) expect(actions).toContain(action);
      for (const action of expected.deny) expect(actions).not.toContain(action);
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
