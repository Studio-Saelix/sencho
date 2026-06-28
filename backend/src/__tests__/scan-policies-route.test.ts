/**
 * Route-level tests for /api/security/policies risk inputs: the risk-first POST
 * defaults, the "a blocking policy needs an active input" guard (POST and PUT),
 * and round-tripping the three input flags.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let adminAuthHeader: string;
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
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  const db = DatabaseService.getInstance();
  db.getScanPolicies().forEach((p) => db.deleteScanPolicy(p.id));
  vi.restoreAllMocks();
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  vi.spyOn(FleetSyncService, 'getRole').mockReturnValue('control');
  vi.spyOn(FleetSyncService, 'getSelfIdentity').mockReturnValue('');
  vi.spyOn(FleetSyncService.getInstance(), 'pushResourceAsync').mockImplementation(() => {});
  vi.spyOn(FleetSyncService, 'resolveIdentityForNodeId').mockReturnValue('');
});

const post = (body: Record<string, unknown>) =>
  request(app).post('/api/security/policies').set('Authorization', adminAuthHeader).send(body);

describe('POST /api/security/policies risk inputs', () => {
  it('applies risk-first defaults when the input flags are omitted', async () => {
    const res = await post({ name: 'risk-first', max_severity: 'CRITICAL', block_on_deploy: 1 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ block_on_severity: 0, block_on_kev: 1, block_on_fixable: 1 });
  });

  it('persists explicit input flags', async () => {
    const res = await post({
      name: 'sev-only', max_severity: 'HIGH', block_on_deploy: 1,
      block_on_severity: true, block_on_kev: false, block_on_fixable: false,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0 });
  });

  it('rejects a blocking policy with no active input', async () => {
    const res = await post({
      name: 'empty-gate', max_severity: 'CRITICAL', block_on_deploy: 1,
      block_on_severity: false, block_on_kev: false, block_on_fixable: false,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one/i);
  });

  it('allows an evaluate-only policy with no active input', async () => {
    const res = await post({
      name: 'evaluate-only', max_severity: 'CRITICAL', block_on_deploy: 0,
      block_on_severity: false, block_on_kev: false, block_on_fixable: false,
    });
    expect(res.status).toBe(201);
  });
});

describe('PUT /api/security/policies/:id risk inputs', () => {
  it('rejects turning off the last input on a blocking policy', async () => {
    const created = await post({
      name: 'kev-block', max_severity: 'CRITICAL', block_on_deploy: 1,
      block_on_severity: false, block_on_kev: true, block_on_fixable: false,
    });
    const id = created.body.id as number;

    const res = await request(app)
      .put(`/api/security/policies/${id}`)
      .set('Authorization', adminAuthHeader)
      .send({ block_on_kev: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one/i);
  });

  it('rejects enabling block-on-deploy on an evaluate-only policy with no active input', async () => {
    const created = await post({
      name: 'evaluate-only', max_severity: 'CRITICAL', block_on_deploy: 0,
      block_on_severity: false, block_on_kev: false, block_on_fixable: false,
    });
    const id = created.body.id as number;

    const res = await request(app)
      .put(`/api/security/policies/${id}`)
      .set('Authorization', adminAuthHeader)
      .send({ block_on_deploy: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one/i);
  });

  it('updates an input flag when at least one stays active', async () => {
    const created = await post({
      name: 'both', max_severity: 'CRITICAL', block_on_deploy: 1,
      block_on_severity: false, block_on_kev: true, block_on_fixable: true,
    });
    const id = created.body.id as number;

    const res = await request(app)
      .put(`/api/security/policies/${id}`)
      .set('Authorization', adminAuthHeader)
      .send({ block_on_fixable: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ block_on_kev: 1, block_on_fixable: 0 });
  });
});

describe('scan policies on Community (no tier gate)', () => {
  beforeEach(() => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
  });

  it('lets a Community admin create, read, update, and delete a policy', async () => {
    const created = await post({ name: 'community-gate', max_severity: 'CRITICAL', block_on_deploy: 1 });
    expect(created.status).toBe(201);
    const id = created.body.id as number;

    const list = await request(app).get('/api/security/policies').set('Authorization', adminAuthHeader);
    expect(list.status).toBe(200);
    expect((list.body as Array<{ id: number }>).some((p) => p.id === id)).toBe(true);

    const updated = await request(app)
      .put(`/api/security/policies/${id}`)
      .set('Authorization', adminAuthHeader)
      .send({ name: 'community-gate-2' });
    expect(updated.status).toBe(200);

    const removed = await request(app)
      .delete(`/api/security/policies/${id}`)
      .set('Authorization', adminAuthHeader);
    expect(removed.status).toBe(200);
  });

  it('lets a Community viewer read policies but denies a write (admin gate is the sole guard)', async () => {
    const db = DatabaseService.getInstance();
    if (!db.getUserByUsername('pol-viewer')) {
      db.addUser({ username: 'pol-viewer', password_hash: 'x', role: 'viewer' });
    }
    const viewerHeader = `Bearer ${jwt.sign({ username: 'pol-viewer' }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;

    const read = await request(app).get('/api/security/policies').set('Authorization', viewerHeader);
    expect(read.status).toBe(200);

    const write = await request(app)
      .post('/api/security/policies')
      .set('Authorization', viewerHeader)
      .send({ name: 'viewer-blocked', max_severity: 'CRITICAL', block_on_deploy: 1 });
    expect(write.status).toBe(403);
  });
});
