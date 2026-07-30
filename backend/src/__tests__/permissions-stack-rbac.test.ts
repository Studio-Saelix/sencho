/**
 * Unit tests for checkPermission evidence + scopedActionsForStack with
 * node-qualified stack grants. Uses mocked Request objects where possible.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Request } from 'express';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import {
  checkPermission,
  scopedActionsForStack,
  type PermissionAction,
} from '../middleware/permissions';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let viewerId: number;
let defaultNodeId: number;
let otherNodeId: number;

function mockReq(partial: {
  userId: number;
  role: 'admin' | 'viewer' | 'deployer' | 'node-admin' | 'auditor';
  username?: string;
  nodeId?: number;
  proxyTier?: 'paid' | 'community';
  scopedStackEvidence?: {
    stackName: string;
    actions: ReadonlySet<PermissionAction>;
  };
}): Request {
  return {
    user: {
      username: partial.username ?? 'test-user',
      role: partial.role,
      userId: partial.userId,
    },
    nodeId: partial.nodeId ?? defaultNodeId,
    proxyTier: partial.proxyTier ?? 'paid',
    scopedStackEvidence: partial.scopedStackEvidence,
  } as Request;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  const { LicenseService } = await import('../services/LicenseService');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');

  const db = DatabaseService.getInstance();
  defaultNodeId = db.getDefaultNode()!.id!;
  otherNodeId = db.addNode({
    name: 'perm-other-node',
    type: 'remote',
    api_url: 'http://192.168.1.60:1852',
    api_token: '',
    compose_dir: '/tmp',
    is_default: false,
  });
  const hash = await bcrypt.hash('password123', 1);
  viewerId = db.addUser({ username: 'perm-viewer', password_hash: hash, role: 'viewer' });
});

afterAll(() => {
  const db = DatabaseService.getInstance();
  db.deleteRoleAssignmentsByUser(viewerId);
  db.deleteUser(viewerId);
  db.deleteNode(otherNodeId);
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

describe('scopedActionsForStack', () => {
  it('includes edit and deploy for a node-admin stack assignment', () => {
    const db = DatabaseService.getInstance();
    db.addRoleAssignment({
      user_id: viewerId,
      role: 'node-admin',
      resource_type: 'stack',
      resource_id: 'actions-stack',
      node_id: defaultNodeId,
    });

    const actions = scopedActionsForStack(viewerId, defaultNodeId, 'actions-stack');
    expect(actions).toContain('stack:edit');
    expect(actions).toContain('stack:deploy');
    expect(actions).toContain('stack:read');
    expect(actions).toContain('stack:delete');
    expect(actions).toContain('stack:create');
    expect(actions).not.toContain('node:manage');
    expect(actions).not.toContain('system:users');
    expect(actions.every((a) => a.startsWith('stack:'))).toBe(true);

    expect(scopedActionsForStack(viewerId, otherNodeId, 'actions-stack')).toEqual([]);

    db.deleteRoleAssignmentsByStack(defaultNodeId, 'actions-stack');
  });
});

describe('checkPermission with node-scoped stack grants', () => {
  it('viewer + scoped deploy grant succeeds for stack:deploy when req.nodeId matches', () => {
    const db = DatabaseService.getInstance();
    db.addRoleAssignment({
      user_id: viewerId,
      role: 'deployer',
      resource_type: 'stack',
      resource_id: 'deploy-me',
      node_id: defaultNodeId,
    });

    const req = mockReq({ userId: viewerId, role: 'viewer', nodeId: defaultNodeId });
    expect(checkPermission(req, 'stack:deploy', 'stack', 'deploy-me')).toBe(true);
    expect(checkPermission(req, 'stack:read', 'stack', 'deploy-me')).toBe(true);
    expect(checkPermission(req, 'stack:edit', 'stack', 'deploy-me')).toBe(false);

    const wrongNode = mockReq({ userId: viewerId, role: 'viewer', nodeId: otherNodeId });
    expect(checkPermission(wrongNode, 'stack:deploy', 'stack', 'deploy-me')).toBe(false);

    db.deleteRoleAssignmentsByStack(defaultNodeId, 'deploy-me');
  });

  it('node-scoped Node Admin authorizes stack actions on that node only', () => {
    const db = DatabaseService.getInstance();
    db.addRoleAssignment({
      user_id: viewerId,
      role: 'node-admin',
      resource_type: 'node',
      resource_id: String(defaultNodeId),
    });

    const sameNode = mockReq({ userId: viewerId, role: 'viewer', nodeId: defaultNodeId });
    expect(checkPermission(sameNode, 'stack:edit', 'stack', 'any-stack')).toBe(true);
    expect(checkPermission(sameNode, 'stack:deploy', 'stack', 'other-stack')).toBe(true);
    expect(checkPermission(sameNode, 'node:manage', 'node', String(defaultNodeId))).toBe(true);

    const wrongNode = mockReq({ userId: viewerId, role: 'viewer', nodeId: otherNodeId });
    expect(checkPermission(wrongNode, 'stack:edit', 'stack', 'any-stack')).toBe(false);

    const assignments = db.getAllRoleAssignments(viewerId).filter(
      (a) => a.resource_type === 'node' && a.resource_id === String(defaultNodeId),
    );
    for (const a of assignments) db.deleteRoleAssignment(a.id!);
  });

  it('uses an explicit target node for hub-orchestrated stack checks', () => {
    const db = DatabaseService.getInstance();
    db.addRoleAssignment({
      user_id: viewerId,
      role: 'deployer',
      resource_type: 'stack',
      resource_id: 'remote-stack',
      node_id: otherNodeId,
    });

    const hubRequest = mockReq({ userId: viewerId, role: 'viewer', nodeId: defaultNodeId });
    expect(checkPermission(hubRequest, 'stack:deploy', 'stack', 'remote-stack')).toBe(false);
    expect(checkPermission(hubRequest, 'stack:deploy', 'stack', 'remote-stack', otherNodeId)).toBe(true);
    expect(checkPermission(hubRequest, 'stack:edit', 'stack', 'remote-stack', otherNodeId)).toBe(false);

    db.deleteRoleAssignmentsByStack(otherNodeId, 'remote-stack');
  });
});

describe('scopedActionsForStack with node-scoped grants', () => {
  it('includes stack:* actions from a node-wide grant on the same node', () => {
    const db = DatabaseService.getInstance();
    db.addRoleAssignment({
      user_id: viewerId,
      role: 'node-admin',
      resource_type: 'node',
      resource_id: String(defaultNodeId),
    });

    const actions = scopedActionsForStack(viewerId, defaultNodeId, 'fleet-wide');
    expect(actions).toContain('stack:edit');
    expect(actions).toContain('stack:deploy');
    expect(actions).not.toContain('node:manage');
    expect(scopedActionsForStack(viewerId, otherNodeId, 'fleet-wide')).toEqual([]);

    const assignments = db.getAllRoleAssignments(viewerId).filter(
      (a) => a.resource_type === 'node' && a.resource_id === String(defaultNodeId),
    );
    for (const a of assignments) db.deleteRoleAssignment(a.id!);
  });
});

describe('checkPermission scopedStackEvidence', () => {
  it('allows when action is a member of the evidenced set for the same stack', () => {
    // Use actions the global viewer role does not already grant so the
    // evidence path is what authorizes (not ROLE_PERMISSIONS.viewer).
    const req = mockReq({
      userId: 0,
      role: 'viewer',
      scopedStackEvidence: {
        stackName: 'evidenced',
        actions: new Set<PermissionAction>(['stack:deploy', 'stack:edit']),
      },
    });
    expect(checkPermission(req, 'stack:deploy', 'stack', 'evidenced')).toBe(true);
    expect(checkPermission(req, 'stack:edit', 'stack', 'evidenced')).toBe(true);
  });

  it('denies when the action is absent from the evidenced set', () => {
    const req = mockReq({
      userId: 0,
      role: 'viewer',
      scopedStackEvidence: {
        stackName: 'evidenced',
        actions: new Set<PermissionAction>(['stack:read']),
      },
    });
    expect(checkPermission(req, 'stack:deploy', 'stack', 'evidenced')).toBe(false);
    expect(checkPermission(req, 'stack:edit', 'stack', 'evidenced')).toBe(false);
  });

  it('denies when the stack name does not match evidence', () => {
    const req = mockReq({
      userId: 0,
      role: 'viewer',
      scopedStackEvidence: {
        stackName: 'evidenced',
        actions: new Set<PermissionAction>(['stack:deploy']),
      },
    });
    expect(checkPermission(req, 'stack:deploy', 'stack', 'other-stack')).toBe(false);
  });

  it('ignores evidence for unscoped checks (no resourceType/resourceId)', () => {
    const req = mockReq({
      userId: 0,
      role: 'viewer',
      scopedStackEvidence: {
        stackName: 'evidenced',
        actions: new Set<PermissionAction>(['stack:deploy', 'system:users']),
      },
    });
    expect(checkPermission(req, 'stack:deploy')).toBe(false);
    expect(checkPermission(req, 'system:users')).toBe(false);
  });

  it('does not honor non-stack actions even when present in the evidence set', () => {
    const req = mockReq({
      userId: 0,
      role: 'viewer',
      scopedStackEvidence: {
        stackName: 'evidenced',
        actions: new Set<PermissionAction>(['stack:deploy', 'system:users', 'node:manage']),
      },
    });
    expect(checkPermission(req, 'system:users', 'stack', 'evidenced')).toBe(false);
    expect(checkPermission(req, 'node:manage', 'stack', 'evidenced')).toBe(false);
    expect(checkPermission(req, 'stack:deploy', 'stack', 'evidenced')).toBe(true);
  });
});
