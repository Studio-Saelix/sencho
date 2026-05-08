/**
 * Tests for pilot-agent enrollment lifecycle and rate limiting.
 *
 * Covers:
 *   - POST /api/nodes with mode=pilot_agent mints an enrollment token, persists
 *     the SHA256 hash into pilot_enrollments, and returns a docker run command
 *     containing the bearer token.
 *   - consumePilotEnrollment is one-shot: a second consume on the same hash
 *     returns null (replay protection).
 *   - Expired enrollments are not consumable.
 *   - The enrollment rate limiter (10/min in production, 100/min in dev) is
 *     wired only on routes that mint a pilot enrollment.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let adminCookie: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
});

afterAll(() => cleanupTestDb(tmpDir));

describe('POST /api/nodes (pilot_agent mode)', () => {
  it('mints an enrollment token and returns a docker run command', async () => {
    const res = await request(app)
      .post('/api/nodes')
      .set('Cookie', adminCookie)
      .send({ name: 'pilot-1', type: 'remote', mode: 'pilot_agent' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.enrollment).toBeDefined();
    expect(res.body.enrollment.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(res.body.enrollment.dockerRun).toContain('SENCHO_MODE=pilot');
    expect(res.body.enrollment.dockerRun).toContain(`SENCHO_ENROLL_TOKEN=${res.body.enrollment.token}`);
    expect(res.body.enrollment.expiresAt).toBeGreaterThan(Date.now());
  });

  it('persists the token hash, not the raw token', async () => {
    const res = await request(app)
      .post('/api/nodes')
      .set('Cookie', adminCookie)
      .send({ name: 'pilot-2', type: 'remote', mode: 'pilot_agent' });

    const expectedHash = crypto.createHash('sha256').update(res.body.enrollment.token).digest('hex');
    const row = DatabaseService.getInstance().getDb()
      .prepare('SELECT token_hash, used_at FROM pilot_enrollments WHERE node_id = ?')
      .get(res.body.id) as { token_hash: string; used_at: number | null } | undefined;

    expect(row).toBeDefined();
    expect(row?.token_hash).toBe(expectedHash);
    expect(row?.used_at).toBeNull();
    // The raw token must not appear anywhere in the row.
    expect(row?.token_hash).not.toBe(res.body.enrollment.token);
  });

  it('rejects unauthenticated callers with 401', async () => {
    const res = await request(app)
      .post('/api/nodes')
      .send({ name: 'pilot-anon', type: 'remote', mode: 'pilot_agent' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/nodes/:id/pilot/enroll', () => {
  it('regenerates the enrollment for an existing pilot node', async () => {
    const create = await request(app)
      .post('/api/nodes')
      .set('Cookie', adminCookie)
      .send({ name: 'pilot-regen', type: 'remote', mode: 'pilot_agent' });
    const original = create.body.enrollment.token;

    const regen = await request(app)
      .post(`/api/nodes/${create.body.id}/pilot/enroll`)
      .set('Cookie', adminCookie);

    expect(regen.status).toBe(200);
    expect(regen.body.enrollment.token).not.toBe(original);
  });

  it('rejects regeneration for proxy-mode remote nodes', async () => {
    const create = await request(app)
      .post('/api/nodes')
      .set('Cookie', adminCookie)
      .send({
        name: 'proxy-not-pilot',
        type: 'remote',
        api_url: 'http://192.168.1.50:1852',
        api_token: 'tok',
      });

    const regen = await request(app)
      .post(`/api/nodes/${create.body.id}/pilot/enroll`)
      .set('Cookie', adminCookie);

    expect(regen.status).toBe(400);
    expect(regen.body.error).toMatch(/pilot/i);
  });

  it('rejects unknown nodes with 404', async () => {
    const res = await request(app)
      .post('/api/nodes/999999/pilot/enroll')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(404);
  });
});

describe('consumePilotEnrollment replay protection', () => {
  it('marks the row used and rejects the second consume', () => {
    const db = DatabaseService.getInstance();
    const create = db.addNode({
      name: 'pilot-replay',
      type: 'remote',
      compose_dir: '/tmp/x',
      mode: 'pilot_agent',
      is_default: false,
      api_url: '',
      api_token: '',
    });
    const tokenHash = crypto.createHash('sha256').update('synthetic-test-token').digest('hex');
    db.createPilotEnrollment(create, tokenHash, Date.now() + 60_000);

    const first = db.consumePilotEnrollment(tokenHash);
    expect(first).toBeDefined();
    expect(first?.node_id).toBe(create);

    const second = db.consumePilotEnrollment(tokenHash);
    expect(second).toBeUndefined();
  });

  it('rejects expired enrollments', () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.addNode({
      name: 'pilot-expired',
      type: 'remote',
      compose_dir: '/tmp/x',
      mode: 'pilot_agent',
      is_default: false,
      api_url: '',
      api_token: '',
    });
    const tokenHash = crypto.createHash('sha256').update('expired-test-token').digest('hex');
    db.createPilotEnrollment(nodeId, tokenHash, Date.now() - 1_000);

    expect(db.consumePilotEnrollment(tokenHash)).toBeUndefined();
  });

  it('rejects unknown token hashes', () => {
    const db = DatabaseService.getInstance();
    expect(db.consumePilotEnrollment('0'.repeat(64))).toBeUndefined();
  });
});

describe('Enrollment rate limiter wiring', () => {
  it('POST /api/nodes (pilot mode) advertises a tighter limit than the global limiter', async () => {
    const res = await request(app)
      .post('/api/nodes')
      .set('Cookie', adminCookie)
      .send({ name: 'pilot-headers', type: 'remote', mode: 'pilot_agent' });

    const limit = parseInt(res.headers['ratelimit-limit'], 10);
    // Dev limit is 100/min for the enrollment limiter; global is 1000/min.
    expect(limit).toBe(100);
  });

  it('POST /api/nodes (proxy mode) falls back to the global limiter', async () => {
    const res = await request(app)
      .post('/api/nodes')
      .set('Cookie', adminCookie)
      .send({
        name: 'proxy-global-limit',
        type: 'remote',
        api_url: 'http://192.168.1.51:1852',
        api_token: 'tok',
      });

    const limit = parseInt(res.headers['ratelimit-limit'], 10);
    expect(limit).toBe(1000);
  });

  it('POST /api/nodes/:id/pilot/enroll uses the enrollment limiter', async () => {
    const create = await request(app)
      .post('/api/nodes')
      .set('Cookie', adminCookie)
      .send({ name: 'pilot-regen-headers', type: 'remote', mode: 'pilot_agent' });

    const regen = await request(app)
      .post(`/api/nodes/${create.body.id}/pilot/enroll`)
      .set('Cookie', adminCookie);

    const limit = parseInt(regen.headers['ratelimit-limit'], 10);
    expect(limit).toBe(100);
  });
});
