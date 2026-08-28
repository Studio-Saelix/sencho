/**
 * Hub → remote proxy coverage for SSO configuration rejection.
 * API tokens are blocked by the proxy-side rejectApiTokenScope gate (SCOPE_DENIED).
 * Browser sessions with a remote x-node-id are blocked by hubOnlyGuard (HUB_ONLY_ENDPOINT)
 * before any upstream hop, since SSO config is control-plane identity state.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET } from './helpers/setupTestDb';
import jwt from 'jsonwebtoken';
import { createTestApiToken } from './helpers/apiTokenTestHelper';
import { PROXY_ROLE_HEADER } from '../services/license-headers';

let tmpDir: string;
let app: import('express').Express;
let adminToken: string;
let fullAdminApiToken: string;
let remoteNodeId: number;

interface CapturedHop {
  method: string;
  url: string;
  roleHeader: string | undefined;
}
const capturedHops: CapturedHop[] = [];

function captureHop(req: http.IncomingMessage, into: CapturedHop[]): void {
  into.push({
    method: req.method ?? '',
    url: req.url ?? '',
    roleHeader: req.headers[PROXY_ROLE_HEADER] as string | undefined,
  });
}

function createRemoteServer(): http.Server {
  return http.createServer((req, res) => {
    // Always serve /api/meta so the proxy can discover capabilities
    if (req.url?.startsWith('/api/meta')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '0.97.1', capabilities: ['cross-node-rbac'] }));
      return;
    }
    captureHop(req, capturedHops);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  });
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as import('net').AddressInfo).port;
}

let remoteServer: http.Server;
let remotePort: number;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));

  const { DatabaseService } = await import('../services/DatabaseService');
  const db = DatabaseService.getInstance();

  adminToken = jwt.sign({ username: 'testadmin', role: 'admin' }, TEST_JWT_SECRET, { expiresIn: '1h' });

  // Create a full-admin API token via the shared test helper
  const admin = db.getUserByUsername('testadmin');
  fullAdminApiToken = createTestApiToken({
    db: DatabaseService,
    scope: 'full-admin',
    userId: admin!.id,
    name: `sso-config-proxy-test-${Date.now()}`,
  });

  // Set up the remote server
  remoteServer = createRemoteServer();
  remotePort = await listen(remoteServer);

  remoteNodeId = db.addNode({
    name: 'sso-config-remote',
    type: 'remote',
    mode: 'proxy',
    compose_dir: '/tmp',
    is_default: false,
    api_url: `http://127.0.0.1:${remotePort}`,
    api_token: 'remote-sso-token',
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => remoteServer.close(() => resolve()));
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  capturedHops.length = 0;
});

describe('Hub-side rejection for remote SSO config', () => {
  const blockedRequests: Array<{ method: 'get' | 'put'; path: string; body?: Record<string, unknown> }> = [
    { method: 'get', path: '/api/sso/config/role-sync' },
    { method: 'get', path: '/api/sso/config' },
    { method: 'put', path: '/api/sso/config/role-sync', body: { enabled: true } },
    { method: 'get', path: '/api/sso/config/ldap' },
    { method: 'put', path: '/api/sso/config/ldap', body: { enabled: true } },
    // Case variants: Express routes case-insensitively, so the hub guard must
    // reject them too (regression for a case-sensitive guard bypass).
    { method: 'get', path: '/api/SSO/config/role-sync' },
    { method: 'put', path: '/api/SSO/config/role-sync', body: { enabled: true } },
    { method: 'get', path: '/api/Sso/Config/Role-Sync' },
    { method: 'put', path: '/api/Sso/Config/Role-Sync', body: { enabled: true } },
  ];

  for (const { method, path, body } of blockedRequests) {
    it(`returns 403 HUB_ONLY_ENDPOINT for ${method.toUpperCase()} ${path} (API token), no upstream hop`, async () => {
      let req = request(app)[method](path)
        .set('Authorization', `Bearer ${fullAdminApiToken}`)
        .set('x-node-id', String(remoteNodeId));
      if (body) req = req.send(body);
      const res = await req;

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('HUB_ONLY_ENDPOINT');
      expect(capturedHops).toHaveLength(0);
    });
  }

  it('Browser admin session is rejected by hubOnlyGuard for GET /api/sso/config/role-sync', async () => {
    const res = await request(app)
      .get('/api/sso/config/role-sync')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-node-id', String(remoteNodeId));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('HUB_ONLY_ENDPOINT');
    expect(capturedHops).toHaveLength(0);
  });

  it('Browser admin session is rejected by hubOnlyGuard for PUT /api/sso/config/role-sync', async () => {
    const res = await request(app)
      .put('/api/sso/config/role-sync')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('x-node-id', String(remoteNodeId))
      .send({ enabled: true });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('HUB_ONLY_ENDPOINT');
    expect(capturedHops).toHaveLength(0);
  });
});
