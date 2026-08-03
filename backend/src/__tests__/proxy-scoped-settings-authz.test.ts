/**
 * Hub → remote proxy coverage for scoped node-admin Settings writes.
 * Exercises the settings pre-authorization gate in createRemoteProxyMiddleware
 * through live loopback remotes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import bcrypt from 'bcrypt';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { PROXY_ROLE_HEADER } from '../services/license-headers';

let tmpDir: string;
let app: import('express').Express;
let viewerBearer: string;
let viewerId: number;

let grantedServer: http.Server;
let ungrantedServer: http.Server;
let grantedNodeId: number;
let ungrantedNodeId: number;

interface CapturedHop {
  method: string;
  url: string;
  roleHeader: string | undefined;
}
const grantedHops: CapturedHop[] = [];
const ungrantedHops: CapturedHop[] = [];

function captureHop(req: http.IncomingMessage, into: CapturedHop[]): void {
  into.push({
    method: req.method ?? '',
    url: req.url ?? '',
    roleHeader: req.headers[PROXY_ROLE_HEADER] as string | undefined,
  });
}

function grantedRemote(): http.Server {
  return http.createServer((req, res) => {
    if (req.url?.startsWith('/api/meta')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        version: '0.93.0',
        capabilities: ['cross-node-rbac'],
      }));
      return;
    }
    captureHop(req, grantedHops);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  });
}

function ungrantedRemote(): http.Server {
  return http.createServer((req, res) => {
    if (req.url?.startsWith('/api/meta')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        version: '0.93.0',
        capabilities: ['cross-node-rbac'],
      }));
      return;
    }
    captureHop(req, ungrantedHops);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
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
  viewerId = db.addUser({
    username: 'settings-scoped-viewer',
    password_hash: hash,
    role: 'viewer',
  });
  const viewer = db.getUserByUsername('settings-scoped-viewer')!;
  viewerBearer = jwt.sign(
    { username: 'settings-scoped-viewer', role: 'viewer', tv: viewer.token_version },
    TEST_JWT_SECRET,
    { expiresIn: '5m' },
  );

  grantedServer = grantedRemote();
  ungrantedServer = ungrantedRemote();
  const grantedPort = await listen(grantedServer);
  const ungrantedPort = await listen(ungrantedServer);

  grantedNodeId = db.addNode({
    name: 'settings-granted-remote',
    type: 'remote',
    mode: 'proxy',
    compose_dir: '/tmp',
    is_default: false,
    api_url: `http://127.0.0.1:${grantedPort}`,
    api_token: 'granted-token',
  });
  ungrantedNodeId = db.addNode({
    name: 'settings-ungranted-remote',
    type: 'remote',
    mode: 'proxy',
    compose_dir: '/tmp',
    is_default: false,
    api_url: `http://127.0.0.1:${ungrantedPort}`,
    api_token: 'ungranted-token',
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => grantedServer.close(() => resolve()));
  await new Promise<void>((resolve) => ungrantedServer.close(() => resolve()));
  cleanupTestDb(tmpDir);
});

beforeEach(async () => {
  vi.restoreAllMocks();
  const { LicenseService } = await import('../services/LicenseService');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  grantedHops.length = 0;
  ungrantedHops.length = 0;
});

describe('remote proxy scoped node-admin settings writes', () => {
  it('allows scoped node-admin on granted remote node and elevates role header', async () => {
    const db = (await import('../services/DatabaseService')).DatabaseService.getInstance();
    db.addRoleAssignment({
      user_id: viewerId,
      role: 'node-admin',
      resource_type: 'node',
      resource_id: String(grantedNodeId),
    });

    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(grantedNodeId))
      .send({ host_cpu_limit: 85 });

    expect(res.status).toBe(200);
    const hop = grantedHops.find((h) => h.url?.includes('/settings'));
    expect(hop).toBeDefined();
    expect(hop!.roleHeader).toBe('node-admin');

    db.deleteRoleAssignmentsByUser(viewerId);
  });

  it('denies scoped node-admin on ungranted remote node', async () => {
    const db = (await import('../services/DatabaseService')).DatabaseService.getInstance();
    db.addRoleAssignment({
      user_id: viewerId,
      role: 'node-admin',
      resource_type: 'node',
      resource_id: String(grantedNodeId),
    });

    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(ungrantedNodeId))
      .send({ host_cpu_limit: 85 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');

    db.deleteRoleAssignmentsByUser(viewerId);
  });

  it('denies viewer with no scoped grant on any remote node', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(grantedNodeId))
      .send({ host_cpu_limit: 85 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('denies empty-body PATCH from viewer with no grant (fail-closed)', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(grantedNodeId))
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('allows empty-body PATCH from scoped node-admin on granted node', async () => {
    const db = (await import('../services/DatabaseService')).DatabaseService.getInstance();
    db.addRoleAssignment({
      user_id: viewerId,
      role: 'node-admin',
      resource_type: 'node',
      resource_id: String(grantedNodeId),
    });

    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(grantedNodeId))
      .send({});

    expect(res.status).toBe(200);
    const hop = grantedHops.find((h) => h.url?.includes('/settings'));
    expect(hop).toBeDefined();
    expect(hop!.roleHeader).toBe('node-admin');

    db.deleteRoleAssignmentsByUser(viewerId);
  });

  it('denies mixed node:manage + system:settings PATCH from scoped node-admin', async () => {
    const db = (await import('../services/DatabaseService')).DatabaseService.getInstance();
    db.addRoleAssignment({
      user_id: viewerId,
      role: 'node-admin',
      resource_type: 'node',
      resource_id: String(grantedNodeId),
    });

    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(grantedNodeId))
      .send({ host_cpu_limit: 85, developer_mode: '1' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');

    db.deleteRoleAssignmentsByUser(viewerId);
  });

  it('rejects compressed settings body with 415', async () => {
    const db = (await import('../services/DatabaseService')).DatabaseService.getInstance();
    db.addRoleAssignment({
      user_id: viewerId,
      role: 'node-admin',
      resource_type: 'node',
      resource_id: String(grantedNodeId),
    });

    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(grantedNodeId))
      .set('Content-Encoding', 'gzip')
      .send(Buffer.from('compressed'));

    expect(res.status).toBe(415);
    expect(res.body.code).toBe('encoding_unsupported');

    db.deleteRoleAssignmentsByUser(viewerId);
  });

  it('rejects oversized settings body with 413', async () => {
    const db = (await import('../services/DatabaseService')).DatabaseService.getInstance();
    db.addRoleAssignment({
      user_id: viewerId,
      role: 'node-admin',
      resource_type: 'node',
      resource_id: String(grantedNodeId),
    });

    // Build a body larger than 100 KB
    const bigValue = 'x'.repeat(102 * 1024);
    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(grantedNodeId))
      .set('Content-Length', String(bigValue.length + 30))
      .send(Buffer.from(bigValue));

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('entity_too_large');

    db.deleteRoleAssignmentsByUser(viewerId);
  });

  it('allows global node-admin to write on remote without elevation gate', async () => {
    const db = (await import('../services/DatabaseService')).DatabaseService.getInstance();
    // The viewer already has role viewer; create a global node-admin
    const nodeAdminHash = await bcrypt.hash('nodeadmin123', 1);
    const nodeAdminId = db.addUser({
      username: 'settings-global-na',
      password_hash: nodeAdminHash,
      role: 'node-admin',
    });
    const nodeAdmin = db.getUserByUsername('settings-global-na')!;
    const nodeAdminBearer = jwt.sign(
      { username: 'settings-global-na', role: 'node-admin', tv: nodeAdmin.token_version },
      TEST_JWT_SECRET,
      { expiresIn: '5m' },
    );

    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${nodeAdminBearer}`)
      .set('x-node-id', String(grantedNodeId))
      .send({ host_cpu_limit: 90 });

    expect(res.status).toBe(200);

    db.deleteUser(nodeAdminId);
  });

  it('allows scoped node-admin POST single key on granted node', async () => {
    const db = (await import('../services/DatabaseService')).DatabaseService.getInstance();
    db.addRoleAssignment({
      user_id: viewerId,
      role: 'node-admin',
      resource_type: 'node',
      resource_id: String(grantedNodeId),
    });

    const res = await request(app)
      .post('/api/settings')
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(grantedNodeId))
      .send({ key: 'host_cpu_limit', value: 95 });

    expect(res.status).toBe(200);
    const hop = grantedHops.find((h) => h.url?.includes('/settings'));
    expect(hop).toBeDefined();
    expect(hop!.roleHeader).toBe('node-admin');

    db.deleteRoleAssignmentsByUser(viewerId);
  });
});
