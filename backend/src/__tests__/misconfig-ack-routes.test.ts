/**
 * Route-level tests for /api/security/misconfig-acks CRUD.
 *
 * Mirrors suppression-routes.test.ts: auth gating, admin-only writes, replica
 * rejection, rule_id format validation, UNIQUE conflict, audit-log entries
 * (without leaking the reason field), read-time enrichment on
 * /scans/:id/misconfigs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import bcrypt from 'bcrypt';

let tmpDir: string;
let app: import('express').Express;
let adminAuthHeader: string;
let viewerAuthHeader: string;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let FleetSyncService: typeof import('../services/FleetSyncService').FleetSyncService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ LicenseService } = await import('../services/LicenseService'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ FleetSyncService } = await import('../services/FleetSyncService'));

  const adminToken = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
  adminAuthHeader = `Bearer ${adminToken}`;

  const viewerHash = await bcrypt.hash('viewerpass', 1);
  DatabaseService.getInstance().addUser({ username: 'viewer1', password_hash: viewerHash, role: 'viewer' });
  const viewerToken = jwt.sign({ username: 'viewer1' }, TEST_JWT_SECRET, { expiresIn: '1m' });
  viewerAuthHeader = `Bearer ${viewerToken}`;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  const db = DatabaseService.getInstance();
  db.getMisconfigAcknowledgements().forEach((a) => db.deleteMisconfigAcknowledgement(a.id));
  vi.restoreAllMocks();
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  vi.spyOn(FleetSyncService, 'getRole').mockReturnValue('control');
  vi.spyOn(FleetSyncService.getInstance(), 'pushResourceAsync').mockImplementation(() => {});
});

describe('GET /api/security/misconfig-acks', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/security/misconfig-acks');
    expect(res.status).toBe(401);
  });

  it('is accessible on community tier (mirrors CVE suppressions)', async () => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    const res = await request(app).get('/api/security/misconfig-acks').set('Authorization', adminAuthHeader);
    expect(res.status).toBe(200);
    expect(res.body.code).not.toBe('PAID_REQUIRED');
  });

  it('returns an empty list when no acks exist', async () => {
    const res = await request(app).get('/api/security/misconfig-acks').set('Authorization', adminAuthHeader);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns rows with active flag computed from expires_at', async () => {
    const db = DatabaseService.getInstance();
    db.createMisconfigAcknowledgement({
      rule_id: 'DS001',
      stack_pattern: null,
      reason: 'still active',
      created_by: TEST_USERNAME,
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
      replicated_from_control: 0,
    });
    db.createMisconfigAcknowledgement({
      rule_id: 'DS002',
      stack_pattern: null,
      reason: 'already expired',
      created_by: TEST_USERNAME,
      created_at: Date.now() - 10_000,
      expires_at: Date.now() - 1,
      replicated_from_control: 0,
    });

    const res = await request(app).get('/api/security/misconfig-acks').set('Authorization', adminAuthHeader);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const byRule = Object.fromEntries(
      res.body.map((a: { rule_id: string; active: boolean }) => [a.rule_id, a.active]),
    );
    expect(byRule['DS001']).toBe(true);
    expect(byRule['DS002']).toBe(false);
  });
});

describe('POST /api/security/misconfig-acks', () => {
  const validBody = {
    rule_id: 'DS002',
    stack_pattern: 'traefik-*',
    reason: 'Traefik legitimately needs root for binding privileged ports.',
  };

  it('rejects unauthenticated callers with 401', async () => {
    const res = await request(app).post('/api/security/misconfig-acks').send(validBody);
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users with 403', async () => {
    const res = await request(app)
      .post('/api/security/misconfig-acks')
      .set('Authorization', viewerAuthHeader)
      .send(validBody);
    expect(res.status).toBe(403);
  });

  it('rejects writes from a replica with 403', async () => {
    vi.spyOn(FleetSyncService, 'getRole').mockReturnValue('replica');
    const res = await request(app)
      .post('/api/security/misconfig-acks')
      .set('Authorization', adminAuthHeader)
      .send(validBody);
    expect(res.status).toBe(403);
  });

  it('rejects an empty rule_id', async () => {
    const res = await request(app)
      .post('/api/security/misconfig-acks')
      .set('Authorization', adminAuthHeader)
      .send({ ...validBody, rule_id: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rule_id/);
  });

  it('rejects rule_id with shell metacharacters', async () => {
    const res = await request(app)
      .post('/api/security/misconfig-acks')
      .set('Authorization', adminAuthHeader)
      .send({ ...validBody, rule_id: 'DS002; rm -rf /' });
    expect(res.status).toBe(400);
  });

  it('accepts the AVD long-form rule id', async () => {
    const res = await request(app)
      .post('/api/security/misconfig-acks')
      .set('Authorization', adminAuthHeader)
      .send({ ...validBody, rule_id: 'AVD-DS-0002' });
    expect(res.status).toBe(201);
    expect(res.body.rule_id).toBe('AVD-DS-0002');
  });

  it('rejects empty reason', async () => {
    const res = await request(app)
      .post('/api/security/misconfig-acks')
      .set('Authorization', adminAuthHeader)
      .send({ ...validBody, reason: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason/);
  });

  it('rejects an over-length stack_pattern', async () => {
    const res = await request(app)
      .post('/api/security/misconfig-acks')
      .set('Authorization', adminAuthHeader)
      .send({ ...validBody, stack_pattern: 'a'.repeat(301) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/stack_pattern/);
  });

  it('rejects redos-prone wildcard runs in stack_pattern', async () => {
    const res = await request(app)
      .post('/api/security/misconfig-acks')
      .set('Authorization', adminAuthHeader)
      .send({ ...validBody, stack_pattern: '****a' });
    expect(res.status).toBe(400);
  });

  it('creates an ack and pushes the fleet resource', async () => {
    const pushSpy = vi.spyOn(FleetSyncService.getInstance(), 'pushResourceAsync')
      .mockImplementation(() => {});
    const res = await request(app)
      .post('/api/security/misconfig-acks')
      .set('Authorization', adminAuthHeader)
      .send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.rule_id).toBe('DS002');
    expect(res.body.stack_pattern).toBe('traefik-*');
    expect(res.body.replicated_from_control).toBe(0);
    expect(pushSpy).toHaveBeenCalledWith('misconfig_acknowledgements');
  });

  it('rejects a duplicate ack on the same (rule_id, stack_pattern) with 409', async () => {
    const first = await request(app)
      .post('/api/security/misconfig-acks')
      .set('Authorization', adminAuthHeader)
      .send(validBody);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/security/misconfig-acks')
      .set('Authorization', adminAuthHeader)
      .send(validBody);
    expect(second.status).toBe(409);
  });

  it('rejects a duplicate fleet-wide ack (null stack_pattern) with 409', async () => {
    // The UNIQUE index uses COALESCE(stack_pattern, ''), so two fleet-wide
    // acks for the same rule must collide as if both were the empty string.
    const fleetWide = { rule_id: 'DS099', reason: 'fleet-wide accept' };
    const first = await request(app)
      .post('/api/security/misconfig-acks')
      .set('Authorization', adminAuthHeader)
      .send(fleetWide);
    expect(first.status).toBe(201);
    expect(first.body.stack_pattern).toBeNull();

    const second = await request(app)
      .post('/api/security/misconfig-acks')
      .set('Authorization', adminAuthHeader)
      .send(fleetWide);
    expect(second.status).toBe(409);
  });

  it('writes an audit log entry that names the scope but not the reason', async () => {
    await request(app)
      .post('/api/security/misconfig-acks')
      .set('Authorization', adminAuthHeader)
      .send(validBody);

    const logs = DatabaseService.getInstance().getAuditLogs({ limit: 5 });
    const entry = logs.entries.find((l) => l.summary.startsWith('misconfig_ack.create'));
    expect(entry).toBeDefined();
    expect(entry!.summary).toMatch(/DS002/);
    expect(entry!.summary).toMatch(/stack=traefik-\*/);
    // Reason text is private; the audit log must not echo it.
    expect(entry!.summary.toLowerCase()).not.toContain('legitimately');
  });
});

describe('PUT /api/security/misconfig-acks/:id', () => {
  it('rejects updates from a replica with 403', async () => {
    const db = DatabaseService.getInstance();
    const ack = db.createMisconfigAcknowledgement({
      rule_id: 'DS002',
      stack_pattern: null,
      reason: 'r',
      created_by: TEST_USERNAME,
      created_at: Date.now(),
      expires_at: null,
      replicated_from_control: 0,
    });
    vi.spyOn(FleetSyncService, 'getRole').mockReturnValue('replica');
    const res = await request(app)
      .put(`/api/security/misconfig-acks/${ack.id}`)
      .set('Authorization', adminAuthHeader)
      .send({ reason: 'updated' });
    expect(res.status).toBe(403);
  });

  it('returns 404 for a missing id', async () => {
    const res = await request(app)
      .put('/api/security/misconfig-acks/9999')
      .set('Authorization', adminAuthHeader)
      .send({ reason: 'whatever' });
    expect(res.status).toBe(404);
  });

  it('updates only provided fields and leaves rule_id immutable', async () => {
    const db = DatabaseService.getInstance();
    const ack = db.createMisconfigAcknowledgement({
      rule_id: 'DS002',
      stack_pattern: null,
      reason: 'original reason',
      created_by: TEST_USERNAME,
      created_at: Date.now(),
      expires_at: null,
      replicated_from_control: 0,
    });
    const res = await request(app)
      .put(`/api/security/misconfig-acks/${ack.id}`)
      .set('Authorization', adminAuthHeader)
      .send({ reason: 'updated reason', stack_pattern: 'web-*' });
    expect(res.status).toBe(200);
    expect(res.body.rule_id).toBe('DS002');
    expect(res.body.reason).toBe('updated reason');
    expect(res.body.stack_pattern).toBe('web-*');
  });

  it('audit-log update entry names the changed fields but not their values', async () => {
    const db = DatabaseService.getInstance();
    const ack = db.createMisconfigAcknowledgement({
      rule_id: 'DS002',
      stack_pattern: null,
      reason: 'r',
      created_by: TEST_USERNAME,
      created_at: Date.now(),
      expires_at: null,
      replicated_from_control: 0,
    });
    await request(app)
      .put(`/api/security/misconfig-acks/${ack.id}`)
      .set('Authorization', adminAuthHeader)
      .send({ reason: 'this is super secret', expires_at: Date.now() + 1000 });
    const logs = DatabaseService.getInstance().getAuditLogs({ limit: 5 });
    const entry = logs.entries.find((l) => l.summary.startsWith('misconfig_ack.update'));
    expect(entry).toBeDefined();
    expect(entry!.summary).toMatch(/fields=\[reason,expires_at\]/);
    expect(entry!.summary).not.toContain('super secret');
  });
});

describe('DELETE /api/security/misconfig-acks/:id', () => {
  it('rejects deletes from a replica with 403', async () => {
    const db = DatabaseService.getInstance();
    const ack = db.createMisconfigAcknowledgement({
      rule_id: 'DS002',
      stack_pattern: null,
      reason: 'r',
      created_by: TEST_USERNAME,
      created_at: Date.now(),
      expires_at: null,
      replicated_from_control: 0,
    });
    vi.spyOn(FleetSyncService, 'getRole').mockReturnValue('replica');
    const res = await request(app)
      .delete(`/api/security/misconfig-acks/${ack.id}`)
      .set('Authorization', adminAuthHeader);
    expect(res.status).toBe(403);
  });

  it('removes the row and writes an audit entry naming the scope', async () => {
    const db = DatabaseService.getInstance();
    const ack = db.createMisconfigAcknowledgement({
      rule_id: 'DS002',
      stack_pattern: 'traefik',
      reason: 'r',
      created_by: TEST_USERNAME,
      created_at: Date.now(),
      expires_at: null,
      replicated_from_control: 0,
    });
    const res = await request(app)
      .delete(`/api/security/misconfig-acks/${ack.id}`)
      .set('Authorization', adminAuthHeader);
    expect(res.status).toBe(200);
    expect(db.getMisconfigAcknowledgement(ack.id)).toBeNull();
    const logs = db.getAuditLogs({ limit: 5 });
    const entry = logs.entries.find((l) => l.summary.startsWith('misconfig_ack.delete'));
    expect(entry).toBeDefined();
    expect(entry!.summary).toMatch(/DS002/);
    expect(entry!.summary).toMatch(/stack=traefik/);
  });
});
