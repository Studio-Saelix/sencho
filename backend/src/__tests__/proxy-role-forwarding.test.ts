/**
 * Tests for cross-node RBAC preservation: the forwarding primary asserts the
 * signed-in user's role on PROXY_ROLE_HEADER, and the remote's authMiddleware
 * honors it for node_proxy / pilot_tunnel bearers instead of granting every
 * proxied request blanket admin.
 *
 * The probe route is `GET /api/users` (admin-only, no Docker dependency). A
 * forwarded non-admin role must be denied there; an absent header (a direct
 * instance-to-instance / background service call) must keep admin.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import bcrypt from 'bcrypt';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import {
  setupTestDb,
  cleanupTestDb,
  loginAsTestAdmin,
  TEST_JWT_SECRET,
} from './helpers/setupTestDb';
import { PROXY_ROLE_HEADER } from '../services/license-headers';

let tmpDir: string;
let app: import('express').Express;
let viewerBearer: string;

const VIEWER_USER = 'proxy-role-viewer';

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  const { DatabaseService } = await import('../services/DatabaseService');
  const db = DatabaseService.getInstance();
  const hash = await bcrypt.hash('password123', 1);
  db.addUser({ username: VIEWER_USER, password_hash: hash, role: 'viewer' });
  const viewer = db.getUserByUsername(VIEWER_USER)!;
  viewerBearer = jwt.sign(
    { username: VIEWER_USER, role: 'viewer', tv: viewer.token_version },
    TEST_JWT_SECRET,
    { expiresIn: '1m' },
  );
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

const signToken = (payload: Record<string, unknown>, expiresIn: string | number = '1m') =>
  jwt.sign(payload, TEST_JWT_SECRET, { expiresIn: expiresIn as jwt.SignOptions['expiresIn'] });

const ADMIN_ONLY = '/api/users';
// Docker-free, gated by requirePermission('stack:read'); every role carries it,
// so a 200 here proves a forwarded non-admin retained its legitimate access.
const READ_ONLY = '/api/stacks';

describe('authMiddleware - forwarded actor role (node_proxy)', () => {
  it('keeps admin when no role header is present (direct service call)', async () => {
    const token = signToken({ scope: 'node_proxy' });
    const res = await request(app).get(ADMIN_ONLY).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it('keeps admin when the forwarded role is admin', async () => {
    const token = signToken({ scope: 'node_proxy' });
    const res = await request(app)
      .get(ADMIN_ONLY)
      .set('Authorization', `Bearer ${token}`)
      .set(PROXY_ROLE_HEADER, 'admin');
    expect(res.status).toBe(200);
  });

  it('denies an admin-only route when the forwarded role is viewer', async () => {
    const token = signToken({ scope: 'node_proxy' });
    const res = await request(app)
      .get(ADMIN_ONLY)
      .set('Authorization', `Bearer ${token}`)
      .set(PROXY_ROLE_HEADER, 'viewer');
    expect(res.status).toBe(403);
  });

  it('denies an admin-only route when the forwarded role is deployer', async () => {
    const token = signToken({ scope: 'node_proxy' });
    const res = await request(app)
      .get(ADMIN_ONLY)
      .set('Authorization', `Bearer ${token}`)
      .set(PROXY_ROLE_HEADER, 'deployer');
    expect(res.status).toBe(403);
  });

  it('fails closed to read-only for an unrecognized forwarded role', async () => {
    const token = signToken({ scope: 'node_proxy' });
    const res = await request(app)
      .get(ADMIN_ONLY)
      .set('Authorization', `Bearer ${token}`)
      .set(PROXY_ROLE_HEADER, 'superadmin');
    expect(res.status).toBe(403);
  });

  it('applies the same trust to pilot_tunnel bearers', async () => {
    const token = signToken({ scope: 'pilot_tunnel' });
    const res = await request(app)
      .get(ADMIN_ONLY)
      .set('Authorization', `Bearer ${token}`)
      .set(PROXY_ROLE_HEADER, 'viewer');
    expect(res.status).toBe(403);
  });

  it('still grants a forwarded viewer its legitimate read access', async () => {
    // The fail-closed branch must not over-restrict: a forwarded viewer keeps
    // stack:read, so this is a 200 rather than a blanket denial.
    const token = signToken({ scope: 'node_proxy' });
    const res = await request(app)
      .get(READ_ONLY)
      .set('Authorization', `Bearer ${token}`)
      .set(PROXY_ROLE_HEADER, 'viewer');
    expect(res.status).toBe(200);
  });

  it('treats an unrecognized forwarded role as read-only, not zero access', async () => {
    // "Fails closed to read-only" means viewer-equivalent: denied on admin
    // routes (asserted above) but still allowed on stack:read reads.
    const token = signToken({ scope: 'node_proxy' });
    const res = await request(app)
      .get(READ_ONLY)
      .set('Authorization', `Bearer ${token}`)
      .set(PROXY_ROLE_HEADER, 'superadmin');
    expect(res.status).toBe(200);
  });
});

describe('Security - actor-role header cannot be smuggled by a user session', () => {
  it('ignores the role header on a cookie session (uses the DB role)', async () => {
    const cookie = await loginAsTestAdmin(app);
    // A browser session that tries to downgrade itself (or, by the same path,
    // elevate) via the header must be unaffected: the header is honored only on
    // node_proxy / pilot_tunnel bearers, and the gateway overwrites it anyway.
    const res = await request(app)
      .get(ADMIN_ONLY)
      .set('Cookie', cookie)
      .set(PROXY_ROLE_HEADER, 'viewer');
    expect(res.status).toBe(200);
  });

  it('rejects an unauthenticated request even with a role header set', async () => {
    const res = await request(app).get(ADMIN_ONLY).set(PROXY_ROLE_HEADER, 'admin');
    expect(res.status).toBe(401);
  });

  it('does not let a non-admin session elevate by setting the role header', async () => {
    // The attack the header could enable: a viewer setting x-sencho-actor-role:
    // admin on their own session. The user-session branch never reads the
    // header (only node_proxy/pilot_tunnel does), so the DB role wins -> 403.
    const res = await request(app)
      .get(ADMIN_ONLY)
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set(PROXY_ROLE_HEADER, 'admin');
    expect(res.status).toBe(403);
  });
});

// The gateway half of the fix: the forwarding primary must overwrite the actor
// role header from the authenticated session before forwarding, so a client
// cannot smuggle an elevated role through to the remote. Exercised end-to-end
// by routing a real proxied request to a loopback capture server and asserting
// the header it received.
describe('remote proxy gateway - actor role header forwarding', () => {
  let captured: http.IncomingHttpHeaders | null = null;
  let captureServer: http.Server;
  let remoteNodeId: number;

  beforeAll(async () => {
    captureServer = http.createServer((req, res) => {
      // The proxy gate probes /api/meta first to confirm the remote enforces
      // cross-node RBAC before forwarding a non-admin request; advertise it so
      // the viewer forward is allowed and we can assert the forwarded headers.
      if (req.url?.startsWith('/api/meta')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: '0.93.0', capabilities: ['cross-node-rbac'] }));
        return;
      }
      captured = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    });
    await new Promise<void>((resolve) => captureServer.listen(0, '127.0.0.1', resolve));
    const port = (captureServer.address() as import('net').AddressInfo).port;

    const { DatabaseService } = await import('../services/DatabaseService');
    remoteNodeId = DatabaseService.getInstance().addNode({
      name: 'capture-remote',
      type: 'remote',
      mode: 'proxy',
      compose_dir: '/tmp',
      is_default: false,
      api_url: `http://127.0.0.1:${port}`,
      api_token: 'capture-node-token',
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => captureServer.close(() => resolve()));
  });

  it('overwrites a smuggled actor-role header with the session role', async () => {
    captured = null;
    const res = await request(app)
      .get(READ_ONLY)
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(remoteNodeId))
      .set(PROXY_ROLE_HEADER, 'admin'); // smuggled
    expect(res.status).toBe(200);
    expect(captured?.[PROXY_ROLE_HEADER]).toBe('viewer');
  });

  it('forwards the session role when no header is supplied', async () => {
    captured = null;
    const res = await request(app)
      .get(READ_ONLY)
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(remoteNodeId));
    expect(res.status).toBe(200);
    expect(captured?.[PROXY_ROLE_HEADER]).toBe('viewer');
  });
});
