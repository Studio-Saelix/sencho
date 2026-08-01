/**
 * Hub → remote proxy coverage for scoped stack-evidence forwarding to
 * alerts, auto-heal, and node-wide image-refresh routes. Exercises the
 * three new proxy gates in createRemoteProxyMiddleware through live
 * loopback remotes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import bcrypt from 'bcrypt';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET } from './helpers/setupTestDb';
import {
  PROXY_ROLE_HEADER,
  PROXY_SCOPED_STACK_NAME_HEADER,
  PROXY_SCOPED_STACK_ACTIONS_HEADER,
} from '../services/license-headers';
import { DatabaseService } from '../services/DatabaseService';
import { classifyStackApiPath } from '../helpers/stackRouteAuth';

let tmpDir: string;
let app: import('express').Express;
let deployerBearer: string;
let deployerId: number;
let nodeAdminBearer: string;

let grantedServer: http.Server;
let ungrantedServer: http.Server;
let noEvidenceServer: http.Server;
let grantedNodeId: number;
let ungrantedNodeId: number;
let noEvidenceNodeId: number;

interface CapturedHop {
  method: string;
  url: string;
  roleHeader: string | undefined;
  stackNameHeader: string | undefined;
  stackActionsHeader: string | undefined;
}

const grantedHops: CapturedHop[] = [];
const ungrantedHops: CapturedHop[] = [];

function captureHop(req: http.IncomingMessage, into: CapturedHop[]): void {
  into.push({
    method: req.method ?? '',
    url: req.url ?? '',
    roleHeader: req.headers[PROXY_ROLE_HEADER] as string | undefined,
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
        capabilities: ['cross-node-rbac', 'scoped-stack-auth-evidence'],
      }));
      return;
    }
    captureHop(req, grantedHops);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
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

  // Deployer (no global stack:edit; needs scoped evidence)
  deployerId = db.addUser({
    username: 'proxy-evid-deployer',
    password_hash: hash,
    role: 'deployer',
  });
  const deployerUser = db.getUserByUsername('proxy-evid-deployer')!;
  deployerBearer = jwt.sign(
    { username: 'proxy-evid-deployer', role: 'deployer', tv: deployerUser.token_version },
    TEST_JWT_SECRET,
    { expiresIn: '5m' },
  );

  // Node-admin (has global stack:edit; should skip gates)
  db.addUser({
    username: 'proxy-evid-nodeadmin',
    password_hash: hash,
    role: 'node-admin',
  });
  const naUser = db.getUserByUsername('proxy-evid-nodeadmin')!;
  nodeAdminBearer = jwt.sign(
    { username: 'proxy-evid-nodeadmin', role: 'node-admin', tv: naUser.token_version },
    TEST_JWT_SECRET,
    { expiresIn: '5m' },
  );

  grantedServer = evidenceRemote();
  ungrantedServer = evidenceRemote();
  noEvidenceServer = noEvidenceRemote();
  const grantedPort = await listen(grantedServer);
  const ungrantedPort = await listen(ungrantedServer);
  const noEvidencePort = await listen(noEvidenceServer);

  grantedNodeId = db.addNode({
    name: 'evidence-granted-remote',
    type: 'remote',
    mode: 'proxy',
    compose_dir: '/tmp',
    is_default: false,
    api_url: `http://127.0.0.1:${grantedPort}`,
    api_token: 'granted-token',
  });
  ungrantedNodeId = db.addNode({
    name: 'evidence-ungranted-remote',
    type: 'remote',
    mode: 'proxy',
    compose_dir: '/tmp',
    is_default: false,
    api_url: `http://127.0.0.1:${ungrantedPort}`,
    api_token: 'ungranted-token',
  });
  noEvidenceNodeId = db.addNode({
    name: 'evidence-noevidence-remote',
    type: 'remote',
    mode: 'proxy',
    compose_dir: '/tmp',
    is_default: false,
    api_url: `http://127.0.0.1:${noEvidencePort}`,
    api_token: 'noev-token',
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => grantedServer.close(() => resolve()));
  await new Promise<void>((resolve) => ungrantedServer.close(() => resolve()));
  await new Promise<void>((resolve) => noEvidenceServer.close(() => resolve()));
  cleanupTestDb(tmpDir);
});

beforeEach(async () => {
  vi.restoreAllMocks();
  const { LicenseService } = await import('../services/LicenseService');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  grantedHops.length = 0;
  ungrantedHops.length = 0;
});

function grantScopedStackEdit(userId: number, nodeId: number, stackName: string): void {
  // node-admin role grants stack:edit (plus all stack permissions).
  // Scoped to a single stack so the user only gets stack:edit on that stack.
  DatabaseService.getInstance().addRoleAssignment({
    user_id: userId,
    role: 'node-admin',
    resource_type: 'stack',
    resource_id: stackName,
    node_id: nodeId,
  });
}

function grantScopedNodeManage(userId: number, nodeId: number): void {
  DatabaseService.getInstance().addRoleAssignment({
    user_id: userId,
    role: 'node-admin',
    resource_type: 'node',
    resource_id: String(nodeId),
  });
}

function clearAssignments(userId: number): void {
  DatabaseService.getInstance().deleteRoleAssignmentsByUser(userId);
}

describe('remote proxy alerts scoped-evidence gate', () => {
  it('forwards scoped stack:edit evidence for scoped deployer on POST /alerts', async () => {
    grantScopedStackEdit(deployerId, grantedNodeId, 'web');

    const res = await request(app)
      .post('/api/alerts')
      .set('Authorization', `Bearer ${deployerBearer}`)
      .set('x-node-id', String(grantedNodeId))
      .send({ stack_name: 'web', metric: 'cpu_percent', operator: '>', threshold: 90, duration_mins: 5, cooldown_mins: 5 });

    expect(res.status).toBe(200);
    const hop = grantedHops.find((h) => h.url?.includes('/api/alerts'));
    expect(hop).toBeDefined();
    expect(hop!.stackNameHeader).toBe('web');
    expect(hop!.stackActionsHeader).toContain('stack:edit');

    clearAssignments(deployerId);
  });

  it('denies scoped deployer on ungranted stack for POST /alerts', async () => {
    grantScopedStackEdit(deployerId, grantedNodeId, 'web');

    const res = await request(app)
      .post('/api/alerts')
      .set('Authorization', `Bearer ${deployerBearer}`)
      .set('x-node-id', String(grantedNodeId))
      .send({ stack_name: 'other-stack', metric: 'cpu_percent', operator: '>', threshold: 90, duration_mins: 5, cooldown_mins: 5 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');

    clearAssignments(deployerId);
  });

  it('denies when remote lacks scoped-stack-auth-evidence capability', async () => {
    grantScopedStackEdit(deployerId, noEvidenceNodeId, 'web');

    const res = await request(app)
      .post('/api/alerts')
      .set('Authorization', `Bearer ${deployerBearer}`)
      .set('x-node-id', String(noEvidenceNodeId))
      .send({ stack_name: 'web', metric: 'cpu_percent', operator: '>', threshold: 90, duration_mins: 5, cooldown_mins: 5 });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('does not support scoped stack authorization');

    clearAssignments(deployerId);
  });

  it('passes through without evidence for node-admin (global stack:edit)', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Authorization', `Bearer ${nodeAdminBearer}`)
      .set('x-node-id', String(grantedNodeId))
      .send({ stack_name: 'web', metric: 'cpu_percent', operator: '>', threshold: 90, duration_mins: 5, cooldown_mins: 5 });

    expect(res.status).toBe(200);
    const hop = grantedHops.find((h) => h.url?.includes('/api/alerts'));
    expect(hop).toBeDefined();
    // Node-admin global role grants stack:edit; no evidence needed.
    expect(hop!.stackNameHeader).toBeUndefined();
  });
});

describe('remote proxy auto-heal scoped-evidence gate', () => {
  it('forwards scoped stack:edit evidence for scoped deployer on POST /auto-heal/policies', async () => {
    grantScopedStackEdit(deployerId, grantedNodeId, 'web');

    const res = await request(app)
      .post('/api/auto-heal/policies')
      .set('Authorization', `Bearer ${deployerBearer}`)
      .set('x-node-id', String(grantedNodeId))
      .send({ stack_name: 'web', service_name: 'app', unhealthy_duration_mins: 5, cooldown_mins: 5, max_restarts_per_hour: 3, auto_disable_after_failures: 5 });

    expect(res.status).toBe(200);
    const hop = grantedHops.find((h) => h.url?.includes('/api/auto-heal'));
    expect(hop).toBeDefined();
    expect(hop!.stackNameHeader).toBe('web');
    expect(hop!.stackActionsHeader).toContain('stack:edit');

    clearAssignments(deployerId);
  });

  it('rejects compressed body with 415', async () => {
    grantScopedStackEdit(deployerId, grantedNodeId, 'web');

    const res = await request(app)
      .post('/api/auto-heal/policies')
      .set('Authorization', `Bearer ${deployerBearer}`)
      .set('x-node-id', String(grantedNodeId))
      .set('Content-Encoding', 'gzip')
      .send(Buffer.alloc(32));

    expect(res.status).toBe(415);
    expect(res.body.code).toBe('encoding_unsupported');

    clearAssignments(deployerId);
  });

  it('denies when body is unparseable (fail closed)', async () => {
    grantScopedStackEdit(deployerId, grantedNodeId, 'web');

    const res = await request(app)
      .post('/api/auto-heal/policies')
      .set('Authorization', `Bearer ${deployerBearer}`)
      .set('x-node-id', String(grantedNodeId))
      .set('Content-Type', 'application/json')
      .send('not json');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not valid JSON');

    clearAssignments(deployerId);
  });
});

describe('remote proxy node-wide image refresh elevation gate', () => {
  it('elevates role to node-admin for scoped node-manager on POST /image-updates/refresh', async () => {
    grantScopedNodeManage(deployerId, grantedNodeId);

    const res = await request(app)
      .post('/api/image-updates/refresh')
      .set('Authorization', `Bearer ${deployerBearer}`)
      .set('x-node-id', String(grantedNodeId));

    expect(res.status).toBe(200);
    const hop = grantedHops.find((h) => h.url?.includes('/api/image-updates/refresh'));
    expect(hop).toBeDefined();
    expect(hop!.roleHeader).toBe('node-admin');

    clearAssignments(deployerId);
  });

  it('denies scoped node-manager on ungranted node', async () => {
    grantScopedNodeManage(deployerId, grantedNodeId);

    const res = await request(app)
      .post('/api/image-updates/refresh')
      .set('Authorization', `Bearer ${deployerBearer}`)
      .set('x-node-id', String(ungrantedNodeId));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');

    clearAssignments(deployerId);
  });

  it('does not elevate role header for POST /image-updates/fleet/refresh', async () => {
    // /fleet/refresh is the separate fleet-wide fan-out route; must not be
    // matched by the isImageRefreshNodeWide predicate.
    grantScopedNodeManage(deployerId, grantedNodeId);

    await request(app)
      .post('/api/image-updates/fleet/refresh')
      .set('Authorization', `Bearer ${deployerBearer}`)
      .set('x-node-id', String(grantedNodeId));

    // The route is requireAdmin on main today, but our gate must not interfere
    // regardless. The role header should carry the caller's real role, not
    // an elevated one (since the predicate excludes fleet/refresh).
    const hop = grantedHops.find((h) => h.url?.includes('/api/image-updates/fleet'));
    if (hop) {
      expect(hop.roleHeader).not.toBe('node-admin');
    }

    clearAssignments(deployerId);
  });
});

describe('classifyStackApiPath per-stack image refresh', () => {
  it('classifies POST /image-updates/refresh/web as named-stack with stack:deploy', () => {
    const result = classifyStackApiPath('POST', '/image-updates/refresh/web');
    expect(result.kind).toBe('named-stack');
    if (result.kind === 'named-stack') {
      expect(result.stackName).toBe('web');
      expect(result.action).toBe('stack:deploy');
    }
  });

  it('classifies POST /image-updates/refresh (no stack name) as static', () => {
    const result = classifyStackApiPath('POST', '/image-updates/refresh');
    expect(result.kind).toBe('static');
  });
});
