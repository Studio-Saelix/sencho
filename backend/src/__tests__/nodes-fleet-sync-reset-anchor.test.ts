/**
 * Tests for POST /api/nodes/:id/fleet-sync/reset-anchor.
 *
 * The endpoint proxies the peer's reanchor endpoint and clears every
 * sticky-error row for the node on success. Covers:
 *   - happy path: 200 from peer → sticky rows cleared, 200 returned.
 *   - peer 401/403 → 502 with helpful message.
 *   - peer unreachable → 504.
 *   - missing/non-proxy node → 400.
 *   - Community admin success (no paid gate).
 *   - non-admin viewer → 403.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let peerNodeId: number;

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
  authHeader = `Bearer ${token}`;

  // Seed a proxy-mode remote node and a sticky row for it. Tests then drive
  // the route handler and assert side effects on the test DB.
  const { DatabaseService } = await import('../services/DatabaseService');
  const db = DatabaseService.getInstance();
  peerNodeId = db.addNode({
    name: 'sticky-peer',
    type: 'remote',
    compose_dir: '/app/compose',
    is_default: false,
    api_url: 'http://192.168.1.99:1852',
    api_token: 'peer-token',
    mode: 'proxy',
  });
  db.setFleetSyncSticky(
    peerNodeId,
    'scan_policies',
    'CONTROL_IDENTITY_MISMATCH',
    'cb45a2eff9db81d8',
    '555f8d1f7e7e71e3',
  );
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe('POST /api/nodes/:id/fleet-sync/reset-anchor', () => {
  it('proxies to the peer reanchor, clears sticky rows, returns 200', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await request(app)
      .post(`/api/nodes/${peerNodeId}/fleet-sync/reset-anchor`)
      .set('Authorization', authHeader)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://192.168.1.99:1852/api/fleet/role/reanchor');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer peer-token');
    expect(JSON.parse(init.body as string)).toEqual({ override: true });

    const { DatabaseService } = await import('../services/DatabaseService');
    const sticky = DatabaseService.getInstance().getFleetSyncStickyCode(peerNodeId, 'scan_policies');
    expect(sticky).toBeNull();
  });

  it('returns 502 with a helpful message when peer responds 401', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    DatabaseService.getInstance().setFleetSyncSticky(
      peerNodeId, 'cve_suppressions', 'CONTROL_IDENTITY_MISMATCH', 'aaa', 'bbb',
    );
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Admin access required.' }), { status: 401 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await request(app)
      .post(`/api/nodes/${peerNodeId}/fleet-sync/reset-anchor`)
      .set('Authorization', authHeader)
      .send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Admin access required/);
    // Sticky rows must remain set so the operator can retry.
    const sticky = DatabaseService.getInstance().getFleetSyncStickyCode(peerNodeId, 'cve_suppressions');
    expect(sticky).toBe('CONTROL_IDENTITY_MISMATCH');
  });

  it('returns 504 when the peer is unreachable', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await request(app)
      .post(`/api/nodes/${peerNodeId}/fleet-sync/reset-anchor`)
      .set('Authorization', authHeader)
      .send({});

    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/unreachable/i);
  });

  it('returns 400 for a local node', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const local = DatabaseService.getInstance().getNodes().find((n) => n.type === 'local');
    expect(local).toBeTruthy();
    const res = await request(app)
      .post(`/api/nodes/${local!.id}/fleet-sync/reset-anchor`)
      .set('Authorization', authHeader)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown node id', async () => {
    const res = await request(app)
      .post('/api/nodes/9999/fleet-sync/reset-anchor')
      .set('Authorization', authHeader)
      .send({});
    expect(res.status).toBe(404);
  });

  it('succeeds for a Community admin', async () => {
    const { LicenseService } = await import('../services/LicenseService');
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    const { DatabaseService } = await import('../services/DatabaseService');
    DatabaseService.getInstance().setFleetSyncSticky(
      peerNodeId, 'scan_policies', 'CONTROL_IDENTITY_MISMATCH', 'aaa', 'bbb',
    );
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await request(app)
      .post(`/api/nodes/${peerNodeId}/fleet-sync/reset-anchor`)
      .set('Authorization', authHeader)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns 403 PERMISSION_DENIED for a viewer', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    DatabaseService.getInstance().addUser({
      username: 'reset-anchor-viewer',
      password_hash: 'x',
      role: 'viewer',
    });
    const viewerAuth = `Bearer ${jwt.sign(
      { username: 'reset-anchor-viewer', role: 'viewer' },
      TEST_JWT_SECRET,
      { expiresIn: '1m' },
    )}`;

    const res = await request(app)
      .post(`/api/nodes/${peerNodeId}/fleet-sync/reset-anchor`)
      .set('Authorization', viewerAuth)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('returns 403 ADMIN_REQUIRED for a node-admin (status is admin-only)', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    DatabaseService.getInstance().addUser({
      username: 'reset-anchor-node-admin',
      password_hash: 'x',
      role: 'node-admin',
    });
    const nodeAdminAuth = `Bearer ${jwt.sign(
      { username: 'reset-anchor-node-admin', role: 'node-admin' },
      TEST_JWT_SECRET,
      { expiresIn: '1m' },
    )}`;

    const res = await request(app)
      .post(`/api/nodes/${peerNodeId}/fleet-sync/reset-anchor`)
      .set('Authorization', nodeAdminAuth)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');
  });
});
