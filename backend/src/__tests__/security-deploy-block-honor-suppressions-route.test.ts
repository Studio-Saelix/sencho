/**
 * Tests for the role + tier gate on PUT /api/security/deploy-block-honor-suppressions.
 *
 * The route flips the global `deploy_block_honor_suppressions` setting that the
 * pre-deploy policy gate reads to decide whether a suppressed CVE still counts
 * toward a block-on-deploy policy. It must be reachable only by an admin on a
 * paid (Skipper or Admiral) tier, matching the trivy-auto-update toggle.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let adminCookie: string;
let viewerCookie: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));

  const { LicenseService } = await import('../services/LicenseService');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('admiral');
  vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: null, maxViewers: null });

  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);

  const viewerHash = await bcrypt.hash('viewerpass4', 1);
  DatabaseService.getInstance().addUser({ username: 'suppr-viewer', password_hash: viewerHash, role: 'viewer' });
  const viewerRes = await request(app).post('/api/auth/login').send({ username: 'suppr-viewer', password: 'viewerpass4' });
  const cookies = viewerRes.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => cleanupTestDb(tmpDir));

describe('PUT /api/security/deploy-block-honor-suppressions', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app)
      .put('/api/security/deploy-block-honor-suppressions')
      .send({ enabled: true });
    expect(res.status).toBe(401);
  });

  it('rejects authenticated viewer with 403', async () => {
    const res = await request(app)
      .put('/api/security/deploy-block-honor-suppressions')
      .set('Cookie', viewerCookie)
      .send({ enabled: true });
    expect(res.status).toBe(403);
  });

  it('rejects Community tier with 403', async () => {
    const { LicenseService } = await import('../services/LicenseService');
    const spy = vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    try {
      const res = await request(app)
        .put('/api/security/deploy-block-honor-suppressions')
        .set('Cookie', adminCookie)
        .send({ enabled: true });
      expect(res.status).toBe(403);
    } finally {
      spy.mockReturnValue('paid');
    }
  });

  it('accepts paid admin and persists the setting (enable)', async () => {
    const res = await request(app)
      .put('/api/security/deploy-block-honor-suppressions')
      .set('Cookie', adminCookie)
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.honorSuppressionsOnDeploy).toBe(true);
    expect(DatabaseService.getInstance().getGlobalSettings().deploy_block_honor_suppressions).toBe('1');
  });

  it('accepts paid admin and persists the setting (disable)', async () => {
    const res = await request(app)
      .put('/api/security/deploy-block-honor-suppressions')
      .set('Cookie', adminCookie)
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.honorSuppressionsOnDeploy).toBe(false);
    expect(DatabaseService.getInstance().getGlobalSettings().deploy_block_honor_suppressions).toBe('0');
  });

  it('rejects a non-boolean enabled with 400', async () => {
    const res = await request(app)
      .put('/api/security/deploy-block-honor-suppressions')
      .set('Cookie', adminCookie)
      .send({ enabled: '1' });
    expect(res.status).toBe(400);
  });

  it('exposes the current value via GET /trivy-status', async () => {
    DatabaseService.getInstance().updateGlobalSetting('deploy_block_honor_suppressions', '1');
    const res = await request(app)
      .get('/api/security/trivy-status')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.honorSuppressionsOnDeploy).toBe(true);
  });
});
