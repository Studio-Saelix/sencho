/**
 * Route-level tests for fleet sync endpoints introduced by PR 3.
 * Focus: auth gating on /api/fleet/sync/:resource (node_proxy only) and
 * payload validation. Service-level behavior is covered separately in
 * fleet-sync-service.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let adminAuthHeader: string;
let nodeProxyAuthHeader: string;
let LicenseService: typeof import('../services/LicenseService').LicenseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ LicenseService } = await import('../services/LicenseService'));
  const adminToken = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
  adminAuthHeader = `Bearer ${adminToken}`;
  const proxyToken = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
  nodeProxyAuthHeader = `Bearer ${proxyToken}`;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('GET /api/fleet/role', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/fleet/role');
    expect(res.status).toBe(401);
  });

  it('returns the current role for an authenticated admin', async () => {
    const res = await request(app).get('/api/fleet/role').set('Authorization', adminAuthHeader);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ role: 'control' });
  });
});

describe('POST /api/fleet/sync/:resource auth gate', () => {
  const validRow = {
    name: 'from-control',
    node_identity: '',
    stack_pattern: null,
    max_severity: 'CRITICAL',
    block_on_deploy: 0,
    enabled: 1,
  };

  it('rejects unauthenticated callers with 401', async () => {
    const res = await request(app).post('/api/fleet/sync/scan_policies').send({ rows: [validRow] });
    expect(res.status).toBe(401);
  });

  it('rejects admin user session tokens with 403 NODE_PROXY_REQUIRED', async () => {
    const res = await request(app)
      .post('/api/fleet/sync/scan_policies')
      .set('Authorization', adminAuthHeader)
      .send({ rows: [validRow] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NODE_PROXY_REQUIRED');
  });

  it('rejects unknown resources with 400', async () => {
    const res = await request(app)
      .post('/api/fleet/sync/foo')
      .set('Authorization', nodeProxyAuthHeader)
      .send({ rows: [] });
    expect(res.status).toBe(400);
  });

  it('rejects payloads without a rows array', async () => {
    const res = await request(app)
      .post('/api/fleet/sync/scan_policies')
      .set('Authorization', nodeProxyAuthHeader)
      .send({});
    expect(res.status).toBe(400);
  });

  it('rejects rows with invalid max_severity', async () => {
    const res = await request(app)
      .post('/api/fleet/sync/scan_policies')
      .set('Authorization', nodeProxyAuthHeader)
      .send({ rows: [{ ...validRow, max_severity: 'GIGA' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/max_severity/);
  });

  it('rejects rows with non-flag enabled value', async () => {
    const res = await request(app)
      .post('/api/fleet/sync/scan_policies')
      .set('Authorization', nodeProxyAuthHeader)
      .send({ rows: [{ ...validRow, enabled: 2 }] });
    expect(res.status).toBe(400);
  });

  it('rejects payloads exceeding the row cap', async () => {
    const bigRows = Array.from({ length: 5001 }, () => validRow);
    const res = await request(app)
      .post('/api/fleet/sync/scan_policies')
      .set('Authorization', nodeProxyAuthHeader)
      .send({ rows: bigRows });
    expect(res.status).toBe(413);
  });
});

describe('GET /api/fleet/sync-status', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/fleet/sync-status');
    expect(res.status).toBe(401);
  });

  it('returns 403 PAID_REQUIRED on community tier', async () => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    const res = await request(app).get('/api/fleet/sync-status').set('Authorization', adminAuthHeader);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PAID_REQUIRED');
    vi.restoreAllMocks();
  });

  it('returns an empty list for an admin on paid tier', async () => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    const res = await request(app).get('/api/fleet/sync-status').set('Authorization', adminAuthHeader);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    vi.restoreAllMocks();
  });
});

describe('POST /api/fleet/sync/:resource pushedAt protocol', () => {
  const validRow = {
    name: 'from-control',
    node_identity: '',
    stack_pattern: null,
    max_severity: 'CRITICAL' as const,
    block_on_deploy: 0,
    enabled: 1,
  };

  it('accepts payloads without pushedAt for back-compat with legacy controls', async () => {
    const res = await request(app)
      .post('/api/fleet/sync/scan_policies')
      .set('Authorization', nodeProxyAuthHeader)
      .send({ rows: [validRow], targetIdentity: 'https://me.example' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('accepts a fresh pushedAt and persists it for stale-rejection compare', async () => {
    const res = await request(app)
      .post('/api/fleet/sync/scan_policies')
      .set('Authorization', nodeProxyAuthHeader)
      .send({ rows: [validRow], targetIdentity: 'https://me.example', pushedAt: 1_700_000_000_000 });
    expect(res.status).toBe(200);
  });

  it('rejects a stale pushedAt with 409 STALE_SYNC_PUSH', async () => {
    // Send fresh, then send strictly-older.
    await request(app)
      .post('/api/fleet/sync/scan_policies')
      .set('Authorization', nodeProxyAuthHeader)
      .send({ rows: [validRow], targetIdentity: 'https://me.example', pushedAt: 1_800_000_000_000 });
    const stale = await request(app)
      .post('/api/fleet/sync/scan_policies')
      .set('Authorization', nodeProxyAuthHeader)
      .send({ rows: [validRow], targetIdentity: 'https://me.example', pushedAt: 1_700_000_000_000 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_SYNC_PUSH');
  });

  it('returns a friendly 413 SYNC_PAYLOAD_TOO_LARGE when the body exceeds the parser limit', async () => {
    // ~6 MB of padding pushes past the 5mb route-level limit. Keeps a single
    // valid row so any path that did parse would succeed; we want the parser
    // to reject before the handler runs.
    const padding = 'x'.repeat(6 * 1024 * 1024);
    const res = await request(app)
      .post('/api/fleet/sync/scan_policies')
      .set('Authorization', nodeProxyAuthHeader)
      .send({ rows: [validRow], targetIdentity: 'https://me.example', pad: padding });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('SYNC_PAYLOAD_TOO_LARGE');
    expect(res.body.error).toMatch(/Sync payload too large/);
  });
});

describe('POST /api/fleet/sync/:resource control anchor', () => {
  // One ordered scenario rather than four cross-dependent it() blocks: anchor,
  // then exercise reject / legacy-empty / matching paths against the anchored
  // state. Keeps the chronology explicit so reordering or test-isolation
  // changes cannot silently break the suite.
  it('anchors on first sync, then enforces / accepts / re-allows in order', async () => {
    const reanchorRes = await request(app)
      .post('/api/fleet/role/reanchor')
      .set('Authorization', adminAuthHeader)
      .send({ override: true });
    expect(reanchorRes.status).toBe(200);

    const firstSync = await request(app)
      .post('/api/fleet/sync/cve_suppressions')
      .set('Authorization', nodeProxyAuthHeader)
      .send({ rows: [], targetIdentity: 'https://me.example', controlIdentity: 'fingerprint-anchor1' });
    expect(firstSync.status).toBe(200);

    const mismatch = await request(app)
      .post('/api/fleet/sync/cve_suppressions')
      .set('Authorization', nodeProxyAuthHeader)
      .send({ rows: [], targetIdentity: 'https://me.example', controlIdentity: 'fingerprint-different' });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe('CONTROL_IDENTITY_MISMATCH');
    expect(mismatch.body.expected).toBe('fingerprint-anchor1');
    expect(mismatch.body.got).toBe('fingerprint-different');

    const legacy = await request(app)
      .post('/api/fleet/sync/cve_suppressions')
      .set('Authorization', nodeProxyAuthHeader)
      .send({ rows: [], targetIdentity: 'https://me.example' });
    expect(legacy.status).toBe(200);

    const matching = await request(app)
      .post('/api/fleet/sync/cve_suppressions')
      .set('Authorization', nodeProxyAuthHeader)
      .send({ rows: [], targetIdentity: 'https://me.example', controlIdentity: 'fingerprint-anchor1' });
    expect(matching.status).toBe(200);
  });
});

describe('POST /api/fleet/role/reanchor', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).post('/api/fleet/role/reanchor').send({ override: true });
    expect(res.status).toBe(401);
  });

  it('returns 400 without override:true (no accidental reanchor)', async () => {
    const res = await request(app)
      .post('/api/fleet/role/reanchor')
      .set('Authorization', adminAuthHeader)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/override/);
  });

  it('clears the cached fingerprint and accepts the next push from a different control', async () => {
    // Establish a known anchor first so the assertion of "different control
    // can now write" actually proves the reanchor cleared something.
    const reanchorBefore = await request(app)
      .post('/api/fleet/role/reanchor')
      .set('Authorization', adminAuthHeader)
      .send({ override: true });
    expect(reanchorBefore.status).toBe(200);

    const anchor = await request(app)
      .post('/api/fleet/sync/cve_suppressions')
      .set('Authorization', nodeProxyAuthHeader)
      .send({ rows: [], targetIdentity: 'https://me.example', controlIdentity: 'fingerprint-prior' });
    expect(anchor.status).toBe(200);

    const reanchor = await request(app)
      .post('/api/fleet/role/reanchor')
      .set('Authorization', adminAuthHeader)
      .send({ override: true });
    expect(reanchor.status).toBe(200);
    expect(reanchor.body.success).toBe(true);

    const next = await request(app)
      .post('/api/fleet/sync/cve_suppressions')
      .set('Authorization', nodeProxyAuthHeader)
      .send({ rows: [], targetIdentity: 'https://me.example', controlIdentity: 'fingerprint-newcontrol' });
    expect(next.status).toBe(200);
  });
});
