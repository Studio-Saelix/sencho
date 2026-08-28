/**
 * Settings visibility: requiredPermission and adminOnly for five built-in roles.
 */
import { describe, it, expect } from 'vitest';
import { SETTINGS_ITEMS, isItemVisible, type VisibilityContext } from '../registry';
import type { PermissionAction } from '@/context/AuthContext';
import { ROLE_PERMISSIONS } from './rolePermissionsFixture';

function visibilityFor(role: keyof typeof ROLE_PERMISSIONS, over: Partial<VisibilityContext> = {}): VisibilityContext {
  const perms = new Set(ROLE_PERMISSIONS[role]);
  return {
    isRemote: false,
    isAdmin: role === 'admin',
    isPaid: true,
    can: (action: PermissionAction) => role === 'admin' || perms.has(action),
    ...over,
  };
}

describe('settings section visibility by role', () => {
  const permissionSections = [
    'users',
    'license',
    'api-tokens',
    'registries',
    'webhooks',
    'nodes',
    'labels',
  ] as const;

  it('shows permission-gated sections only to roles that hold the permission', () => {
    for (const sectionId of permissionSections) {
      const item = SETTINGS_ITEMS.find(i => i.id === sectionId)!;
      const perm = item.requiredPermission!;
      for (const role of Object.keys(ROLE_PERMISSIONS) as (keyof typeof ROLE_PERMISSIONS)[]) {
        const visible = isItemVisible(item, visibilityFor(role));
        const expected = role === 'admin' || ROLE_PERMISSIONS[role].includes(perm);
        expect(visible, `${sectionId} for ${role}`).toBe(expected);
      }
    }
  });

  it('hides license and webhooks from non-admin roles (visibility correction)', () => {
    for (const role of ['node-admin', 'deployer', 'viewer', 'auditor'] as const) {
      const ctx = visibilityFor(role);
      expect(isItemVisible(SETTINGS_ITEMS.find(i => i.id === 'license')!, ctx)).toBe(false);
      expect(isItemVisible(SETTINGS_ITEMS.find(i => i.id === 'webhooks')!, ctx)).toBe(false);
    }
  });

  it('keeps host-alerts visible to all authenticated roles (editability is separate)', () => {
    const item = SETTINGS_ITEMS.find(i => i.id === 'host-alerts')!;
    for (const role of Object.keys(ROLE_PERMISSIONS) as (keyof typeof ROLE_PERMISSIONS)[]) {
      expect(isItemVisible(item, visibilityFor(role)), role).toBe(true);
    }
  });

  it('hides system:settings sections from roles without that permission', () => {
    for (const sectionId of ['developer', 'data-retention', 'image-updates'] as const) {
      const item = SETTINGS_ITEMS.find(i => i.id === sectionId)!;
      expect(isItemVisible(item, visibilityFor('admin'))).toBe(true);
      for (const role of ['node-admin', 'deployer', 'viewer', 'auditor'] as const) {
        expect(isItemVisible(item, visibilityFor(role)), `${sectionId} for ${role}`).toBe(false);
      }
    }
  });

  it('hides adminOnly sections from every non-admin role', () => {
    const adminOnly = SETTINGS_ITEMS.filter(i => i.adminOnly);
    expect(adminOnly.length).toBeGreaterThan(0);
    for (const item of adminOnly) {
      for (const role of ['node-admin', 'deployer', 'viewer', 'auditor'] as const) {
        expect(isItemVisible(item, visibilityFor(role)), `${item.id} for ${role}`).toBe(false);
      }
      expect(isItemVisible(item, visibilityFor('admin'))).toBe(true);
    }
  });

  it('hides SSO from admins when a remote node is active', () => {
    const sso = SETTINGS_ITEMS.find(i => i.id === 'sso')!;
    expect(isItemVisible(sso, visibilityFor('admin', { isRemote: true }))).toBe(false);
  });
});
