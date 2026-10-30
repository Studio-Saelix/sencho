/**
 * Recovery authorization on the canonical RBAC engine: every stack that uses a
 * storage must allow the action, the dependents recorded earlier and those
 * found now are both checked, repository and key settings stay on
 * system:settings, and a request relayed by the hub is held to the same rule.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Request, Response } from 'express';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import type { PermissionAction } from '../middleware/permissions';
import type { UserRole } from '../services/DatabaseService';

let tmpDir: string;
let auth: typeof import('../services/recovery/authorization');
let identities: typeof import('../services/recovery/storageIdentity');
let nodeId: number;
let otherNodeId: number;
let scopedUserId: number;
let sharedKey: string;
let soloKey: string;
let orphanKey: string;

const ENGINE = 'docker-engine:authz-test';

function req(partial: {
  role: UserRole;
  userId?: number;
  nodeId?: number;
  evidence?: { stackName: string; actions: ReadonlySet<PermissionAction> };
  machine?: 'node_proxy' | 'pilot_tunnel';
}): Request {
  return {
    user: { username: 'u', role: partial.role, userId: partial.userId ?? 0 },
    nodeId: partial.nodeId ?? nodeId,
    proxyTier: 'community',
    scopedStackEvidence: partial.evidence,
    machineAuthScope: partial.machine,
  } as unknown as Request;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  const { DatabaseService } = await import('../services/DatabaseService');
  auth = await import('../services/recovery/authorization');
  identities = await import('../services/recovery/storageIdentity');
  const db = DatabaseService.getInstance();
  nodeId = db.getDefaultNode()!.id!;
  otherNodeId = db.addNode({ name: 'authz-other', type: 'remote', api_url: 'http://192.168.1.60:1852', api_token: '', compose_dir: '/tmp', is_default: false });
  scopedUserId = db.addUser({ username: 'scoped-operator', password_hash: 'x', role: 'viewer' });
  // Node Admin on `photos` only, on this node; and on `tools` only on another node.
  db.addRoleAssignment({ user_id: scopedUserId, role: 'node-admin', resource_type: 'stack', resource_id: 'photos', node_id: nodeId });
  db.addRoleAssignment({ user_id: scopedUserId, role: 'node-admin', resource_type: 'stack', resource_id: 'tools', node_id: otherNodeId });

  const store = identities.StorageIdentityStore.getInstance();
  sharedKey = store.observe({
    ownerNodeKey: ENGINE, kind: 'named_volume', locator: 'shared_media', generationToken: 't',
    dependents: [{ stackName: 'photos', serviceName: 'app' }, { stackName: 'tools', serviceName: null }],
  }).storageKey;
  soloKey = store.observe({
    ownerNodeKey: ENGINE, kind: 'named_volume', locator: 'photos_only', generationToken: 't',
    dependents: [{ stackName: 'photos', serviceName: 'app' }],
  }).storageKey;
  orphanKey = store.observe({
    ownerNodeKey: ENGINE, kind: 'named_volume', locator: 'orphan_data', generationToken: 't', dependents: [],
  }).storageKey;
});

afterAll(() => cleanupTestDb(tmpDir));

const target = (storageKey: string, live: Array<{ stackName: string; serviceName: string | null }> = []) =>
  ({ storageKey, liveDependents: live });

describe('authorizeStorageAccess', () => {
  it('maps each access to the canonical action', () => {
    expect(auth.RECOVERY_ACCESS_ACTION).toEqual({
      read: 'stack:read', protect: 'stack:edit', restore: 'stack:edit', configure: 'system:settings',
    });
  });

  it('lets an Admin do everything', () => {
    for (const access of ['read', 'protect', 'restore'] as const) {
      expect(auth.authorizeStorageAccess(req({ role: 'admin' }), access, target(sharedKey)).allowed).toBe(true);
    }
    expect(auth.authorizeStorageAccess(req({ role: 'admin' }), 'configure', null).allowed).toBe(true);
  });

  it('lets a global Viewer read but not protect, restore or configure', () => {
    const viewer = req({ role: 'viewer', userId: 999 });
    expect(auth.authorizeStorageAccess(viewer, 'read', target(sharedKey)).allowed).toBe(true);
    expect(auth.authorizeStorageAccess(viewer, 'protect', target(sharedKey)).allowed).toBe(false);
    expect(auth.authorizeStorageAccess(viewer, 'restore', target(sharedKey)).allowed).toBe(false);
    expect(auth.authorizeStorageAccess(viewer, 'configure', null).allowed).toBe(false);
  });

  it('keeps a global Deployer, who cannot edit stacks, from protecting or restoring', () => {
    expect(auth.authorizeStorageAccess(req({ role: 'deployer', userId: 998 }), 'protect', target(soloKey)).allowed).toBe(false);
  });

  it('keeps repository and key settings on system:settings, even for a global Node Admin', () => {
    expect(auth.authorizeStorageAccess(req({ role: 'node-admin', userId: 997 }), 'configure', null).allowed).toBe(false);
    expect(auth.authorizeStorageAccess(req({ role: 'node-admin', userId: 997 }), 'protect', target(sharedKey)).allowed).toBe(true);
  });

  it('allows a stack-scoped operator on storage only their stack uses', () => {
    const verdict = auth.authorizeStorageAccess(req({ role: 'viewer', userId: scopedUserId }), 'restore', target(soloKey));
    expect(verdict).toMatchObject({ allowed: true, checkedStacks: ['photos'], deniedStacks: [] });
  });

  it('refuses shared storage unless the operator may act on every stack that uses it', () => {
    const verdict = auth.authorizeStorageAccess(req({ role: 'viewer', userId: scopedUserId }), 'protect', target(sharedKey));
    expect(verdict).toMatchObject({ allowed: false, action: 'stack:edit', checkedStacks: ['photos', 'tools'], deniedStacks: ['tools'] });
  });

  it('checks a stack that started using the storage since it was last observed', () => {
    const verdict = auth.authorizeStorageAccess(
      req({ role: 'viewer', userId: scopedUserId }), 'restore',
      target(soloKey, [{ stackName: 'photos', serviceName: 'app' }, { stackName: 'newcomer', serviceName: 'db' }]),
    );
    expect(verdict).toMatchObject({ allowed: false, checkedStacks: ['newcomer', 'photos'], deniedStacks: ['newcomer'] });
  });

  it('still checks a recorded dependent the caller left out of the live set', () => {
    const verdict = auth.authorizeStorageAccess(
      req({ role: 'viewer', userId: scopedUserId }), 'protect',
      target(sharedKey, [{ stackName: 'photos', serviceName: 'app' }]),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.deniedStacks).toEqual(['tools']);
  });

  it('honors a grant only on the node it was given for', () => {
    // `tools` is granted on another node, so it does not count here.
    expect(auth.authorizeStorageAccess(req({ role: 'viewer', userId: scopedUserId }), 'protect', target(sharedKey)).allowed).toBe(false);
  });

  it('needs the action globally for storage no stack uses', () => {
    expect(auth.authorizeStorageAccess(req({ role: 'viewer', userId: scopedUserId }), 'protect', target(orphanKey)).allowed).toBe(false);
    expect(auth.authorizeStorageAccess(req({ role: 'node-admin', userId: 997 }), 'protect', target(orphanKey)).allowed).toBe(true);
  });

  describe('a request relayed by the hub', () => {
    for (const machine of ['node_proxy', 'pilot_tunnel'] as const) {
      it(`over ${machine}: one stack's evidence cannot authorize storage another stack shares`, () => {
        const relayed = req({ role: 'viewer', machine, evidence: { stackName: 'photos', actions: new Set<PermissionAction>(['stack:read', 'stack:edit']) } });
        expect(auth.authorizeStorageAccess(relayed, 'protect', target(soloKey)).allowed).toBe(true);
        expect(auth.authorizeStorageAccess(relayed, 'protect', target(sharedKey))).toMatchObject({ allowed: false, deniedStacks: ['tools'] });
        expect(auth.authorizeStorageAccess(relayed, 'configure', null).allowed).toBe(false);
      });

      it(`over ${machine}: read evidence does not grant restore`, () => {
        const relayed = req({ role: 'deployer', machine, evidence: { stackName: 'photos', actions: new Set<PermissionAction>(['stack:read']) } });
        expect(auth.authorizeStorageAccess(relayed, 'read', target(soloKey)).allowed).toBe(true);
        expect(auth.authorizeStorageAccess(relayed, 'restore', target(soloKey)).allowed).toBe(false);
      });
    }
  });
});

describe('requireStorageAccess', () => {
  it('answers 403 without naming the stacks', () => {
    let status = 0;
    let body: unknown;
    const res = {
      status(code: number) { status = code; return this; },
      json(payload: unknown) { body = payload; return this; },
    } as unknown as Response;
    expect(auth.requireStorageAccess(req({ role: 'viewer', userId: scopedUserId }), res, 'protect', target(sharedKey))).toBe(false);
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'You do not have permission for every stack that uses this storage.', code: 'PERMISSION_DENIED' });
    expect(JSON.stringify(body)).not.toContain('tools');
  });
});
