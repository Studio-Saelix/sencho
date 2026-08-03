import { describe, it, expect } from 'vitest';
import { resolveCan, type PermissionsSnapshot } from '../resolveCan';

const viewerBase: PermissionsSnapshot = {
  globalRole: 'viewer',
  globalPermissions: ['stack:read', 'node:read'],
  scopedPermissions: {},
};

describe('resolveCan', () => {
  it('admin bypasses all checks', () => {
    const perms: PermissionsSnapshot = {
      globalRole: 'admin',
      globalPermissions: [],
      scopedPermissions: {},
    };
    expect(resolveCan(perms, 'system:users')).toBe(true);
    expect(resolveCan(perms, 'stack:delete', 'stack', 'app', 1)).toBe(true);
  });

  it('grants from the global matrix without needing a resource', () => {
    expect(resolveCan(viewerBase, 'stack:read')).toBe(true);
    expect(resolveCan(viewerBase, 'stack:deploy')).toBe(false);
  });

  it('treats same stack name on different nodes as independent grants', () => {
    const perms: PermissionsSnapshot = {
      ...viewerBase,
      scopedPermissions: {
        'stack:1:frontend': ['stack:read', 'stack:deploy'],
        'stack:2:frontend': ['stack:read', 'stack:edit', 'stack:deploy', 'stack:create', 'stack:delete', 'node:read', 'node:manage'],
      },
    };
    expect(resolveCan(perms, 'stack:deploy', 'stack', 'frontend', 1)).toBe(true);
    expect(resolveCan(perms, 'stack:edit', 'stack', 'frontend', 1)).toBe(false);
    expect(resolveCan(perms, 'stack:edit', 'stack', 'frontend', 2)).toBe(true);
    expect(resolveCan(perms, 'stack:deploy', 'stack', 'frontend', 2)).toBe(true);
  });

  it('fails closed for stack lookups when nodeId is missing', () => {
    const perms: PermissionsSnapshot = {
      ...viewerBase,
      scopedPermissions: {
        'stack:1:frontend': ['stack:deploy'],
      },
    };
    expect(resolveCan(perms, 'stack:deploy', 'stack', 'frontend')).toBe(false);
    expect(resolveCan(perms, 'stack:deploy', 'stack', 'frontend', null)).toBe(false);
    expect(resolveCan(perms, 'stack:deploy', 'stack', 'frontend', 1)).toBe(true);
  });

  it('keeps node scopes keyed as node:id without a nodeId argument', () => {
    const perms: PermissionsSnapshot = {
      ...viewerBase,
      scopedPermissions: {
        'node:7': ['node:read', 'node:manage', 'stack:read', 'stack:edit', 'stack:deploy', 'stack:create', 'stack:delete'],
      },
    };
    expect(resolveCan(perms, 'node:manage', 'node', '7')).toBe(true);
    expect(resolveCan(perms, 'stack:deploy', 'node', '7')).toBe(true);
    expect(resolveCan(perms, 'node:manage', 'node', '8')).toBe(false);
  });

  it('node-scoped grants authorize stack actions on that node only', () => {
    const perms: PermissionsSnapshot = {
      ...viewerBase,
      scopedPermissions: {
        'node:7': ['node:read', 'node:manage', 'stack:read', 'stack:edit', 'stack:deploy', 'stack:create', 'stack:delete'],
      },
    };
    expect(resolveCan(perms, 'stack:edit', 'stack', 'frontend', 7)).toBe(true);
    expect(resolveCan(perms, 'stack:deploy', 'stack', 'other', 7)).toBe(true);
    expect(resolveCan(perms, 'stack:edit', 'stack', 'frontend', 8)).toBe(false);
  });

  it('returns false when permissions are null', () => {
    expect(resolveCan(null, 'stack:read')).toBe(false);
  });
});
