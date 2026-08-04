/**
 * Orchestrated hub → remote proxy coverage for scoped stack elevation and
 * DELETE tuple cleanup. Exercises createRemoteProxyMiddleware through
 * live loopback remotes (not helper-only unit tests).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import bcrypt from 'bcrypt';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET } from './helpers/setupTestDb';
import {
  PROXY_SCOPED_STACK_NAME_HEADER,
  PROXY_SCOPED_STACK_ACTIONS_HEADER,
} from '../services/license-headers';

let tmpDir: string;
let app: import('express').Express;
let viewerBearer: string;
let viewerId: number;
let evidenceServer: http.Server;
let noEvidenceServer: http.Server;
let failDeleteServer: http.Server;
let wrongNodeServer: http.Server;
let evidenceNodeId: number;
let noEvidenceNodeId: number;
let failDeleteNodeId: number;
let wrongNodeId: number;

interface CapturedHop {
  method: string;
  url: string;
  stackNameHeader: string | undefined;
  stackActionsHeader: string | undefined;
}

const evidenceHops: CapturedHop[] = [];
const failDeleteHops: CapturedHop[] = [];

function captureHop(req: http.IncomingMessage, into: CapturedHop[]): void {
  into.push({
    method: req.method ?? '',
    url: req.url ?? '',
    stackNameHeader: req.headers[PROXY_SCOPED_STACK_NAME_HEADER] as string | undefined,
    stackActionsHeader: req.headers[PROXY_SCOPED_STACK_ACTIONS_HEADER] as string | undefined,
  });
}

function evidenceRemote(): http.Server {
  return http.createServer((req, res) => {
    if (req.url?.startsWith('/api/meta')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        version: '0.93.0',
        capabilities: ['cross-node-rbac', 'scoped-stack-auth-evidence', 'stack-delete-prune-volumes'],
      }));
      return;
    }
    captureHop(req, evidenceHops);
    if (req.method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
}

function noEvidenceRemote(): http.Server {
  return http.createServer((req, res) => {
    if (req.url?.startsWith('/api/meta')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        version: '0.93.0',
        capabilities: ['cross-node-rbac'],
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
}

function failDeleteRemote(): http.Server {
  return http.createServer((req, res) => {
    if (req.url?.startsWith('/api/meta')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        version: '0.93.0',
        capabilities: ['cross-node-rbac', 'scoped-stack-auth-evidence', 'stack-delete-prune-volumes'],
      }));
      return;
    }
    captureHop(req, failDeleteHops);
    if (req.method === 'DELETE') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream delete failed' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as import('net').AddressInfo).port;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  const { DatabaseService } = await import('../services/DatabaseService');
  const { LicenseService } = await import('../services/LicenseService');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');

  const db = DatabaseService.getInstance();
  const hash = await bcrypt.hash('password123', 1);
  viewerId = db.addUser({ username: 'scoped-proxy-viewer', password_hash: hash, role: 'viewer' });
  const viewer = db.getUserByUsername('scoped-proxy-viewer')!;
  viewerBearer = jwt.sign(
    { username: 'scoped-proxy-viewer', role: 'viewer', tv: viewer.token_version },
    TEST_JWT_SECRET,
    { expiresIn: '5m' },
  );

  evidenceServer = evidenceRemote();
  noEvidenceServer = noEvidenceRemote();
  failDeleteServer = failDeleteRemote();
  wrongNodeServer = evidenceRemote();
  const evidencePort = await listen(evidenceServer);
  const noEvidencePort = await listen(noEvidenceServer);
  const failDeletePort = await listen(failDeleteServer);
  const wrongNodePort = await listen(wrongNodeServer);

  evidenceNodeId = db.addNode({
    name: 'evidence-remote',
    type: 'remote',
    mode: 'proxy',
    compose_dir: '/tmp',
    is_default: false,
    api_url: `http://127.0.0.1:${evidencePort}`,
    api_token: 'evidence-token',
  });
  noEvidenceNodeId = db.addNode({
    name: 'no-evidence-remote',
    type: 'remote',
    mode: 'proxy',
    compose_dir: '/tmp',
    is_default: false,
    api_url: `http://127.0.0.1:${noEvidencePort}`,
    api_token: 'no-evidence-token',
  });
  failDeleteNodeId = db.addNode({
    name: 'fail-delete-remote',
    type: 'remote',
    mode: 'proxy',
    compose_dir: '/tmp',
    is_default: false,
    api_url: `http://127.0.0.1:${failDeletePort}`,
    api_token: 'fail-delete-token',
  });
  wrongNodeId = db.addNode({
    name: 'wrong-node-remote',
    type: 'remote',
    mode: 'proxy',
    compose_dir: '/tmp',
    is_default: false,
    api_url: `http://127.0.0.1:${wrongNodePort}`,
    api_token: 'wrong-node-token',
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => evidenceServer.close(() => resolve()));
  await new Promise<void>((resolve) => noEvidenceServer.close(() => resolve()));
  await new Promise<void>((resolve) => failDeleteServer.close(() => resolve()));
  await new Promise<void>((resolve) => wrongNodeServer.close(() => resolve()));
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

describe('remote proxy scoped stack evidence and DELETE cleanup', () => {
  it('elevates a matching stack grant and forwards bound evidence headers', async () => {
    const db = (await import('../services/DatabaseService')).DatabaseService.getInstance();
    db.addRoleAssignment({
      user_id: viewerId,
      role: 'deployer',
      resource_type: 'stack',
      resource_id: 'shared-name',
      node_id: evidenceNodeId,
    });
    evidenceHops.length = 0;

    const res = await request(app)
      .post('/api/stacks/shared-name/deploy')
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(evidenceNodeId));

    expect(res.status).toBe(200);
    const hop = evidenceHops.find((h) => h.url?.includes('/stacks/shared-name/deploy'));
    expect(hop).toBeDefined();
    expect(hop!.stackNameHeader).toBe('shared-name');
    expect(hop!.stackActionsHeader).toContain('stack:deploy');
    expect(hop!.stackActionsHeader).not.toContain('node:manage');

    db.deleteRoleAssignmentsByStack(evidenceNodeId, 'shared-name');
  });

  it('denies the same stack name on a node without a grant', async () => {
    const db = (await import('../services/DatabaseService')).DatabaseService.getInstance();
    db.addRoleAssignment({
      user_id: viewerId,
      role: 'deployer',
      resource_type: 'stack',
      resource_id: 'shared-name',
      node_id: evidenceNodeId,
    });

    const res = await request(app)
      .post('/api/stacks/shared-name/deploy')
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(wrongNodeId));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');

    db.deleteRoleAssignmentsByStack(evidenceNodeId, 'shared-name');
  });

  it('denies scoped elevation when the remote lacks scoped-stack-auth-evidence', async () => {
    const db = (await import('../services/DatabaseService')).DatabaseService.getInstance();
    db.addRoleAssignment({
      user_id: viewerId,
      role: 'deployer',
      resource_type: 'stack',
      resource_id: 'needs-evidence',
      node_id: noEvidenceNodeId,
    });

    const res = await request(app)
      .post('/api/stacks/needs-evidence/deploy')
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(noEvidenceNodeId));

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/scoped stack authorization/i);

    db.deleteRoleAssignmentsByStack(noEvidenceNodeId, 'needs-evidence');
  });

  it('clears the hub grant tuple after a successful remote DELETE', async () => {
    const db = (await import('../services/DatabaseService')).DatabaseService.getInstance();
    db.addRoleAssignment({
      user_id: viewerId,
      role: 'node-admin',
      resource_type: 'stack',
      resource_id: 'doomed',
      node_id: evidenceNodeId,
    });
    expect(
      db.getRoleAssignments(viewerId, 'stack', 'doomed', evidenceNodeId),
    ).toHaveLength(1);

    const res = await request(app)
      .delete('/api/stacks/doomed')
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(evidenceNodeId));

    expect(res.status).toBe(204);
    expect(
      db.getRoleAssignments(viewerId, 'stack', 'doomed', evidenceNodeId),
    ).toHaveLength(0);
  });

  it('preserves the hub grant tuple when remote DELETE is non-2xx', async () => {
    const db = (await import('../services/DatabaseService')).DatabaseService.getInstance();
    db.addRoleAssignment({
      user_id: viewerId,
      role: 'node-admin',
      resource_type: 'stack',
      resource_id: 'keep-me',
      node_id: failDeleteNodeId,
    });

    const res = await request(app)
      .delete('/api/stacks/keep-me')
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(failDeleteNodeId));

    expect(res.status).toBe(500);
    expect(
      db.getRoleAssignments(viewerId, 'stack', 'keep-me', failDeleteNodeId),
    ).toHaveLength(1);

    db.deleteRoleAssignmentsByStack(failDeleteNodeId, 'keep-me');
  });

  it('builds evidence from a node-scoped grant on the target node', async () => {
    const db = (await import('../services/DatabaseService')).DatabaseService.getInstance();
    db.addRoleAssignment({
      user_id: viewerId,
      role: 'node-admin',
      resource_type: 'node',
      resource_id: String(evidenceNodeId),
    });
    evidenceHops.length = 0;

    const res = await request(app)
      .post('/api/stacks/node-wide-stack/deploy')
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(evidenceNodeId));

    expect(res.status).toBe(200);
    const hop = evidenceHops.find((h) => h.url?.includes('/stacks/node-wide-stack/deploy'));
    expect(hop).toBeDefined();
    expect(hop!.stackNameHeader).toBe('node-wide-stack');
    expect(hop!.stackActionsHeader).toContain('stack:deploy');
    expect(hop!.stackActionsHeader).toContain('stack:edit');

    const assignments = db.getAllRoleAssignments(viewerId).filter(
      (a) => a.resource_type === 'node' && a.resource_id === String(evidenceNodeId),
    );
    for (const a of assignments) db.deleteRoleAssignment(a.id!);
  });
});
