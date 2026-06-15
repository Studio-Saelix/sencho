/**
 * PUT /api/security/pre-deploy-scan-advisory.
 *
 * Flips the per-instance `pre_deploy_scan_advisory` setting that drives the
 * manual-deploy scan advisory. Visibility only, so it is admin-gated but carries
 * no tier gate: reachable by any admin on Community as well as Admiral. The
 * value is reflected back on GET /trivy-status.
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

  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);

  const viewerHash = await bcrypt.hash('viewerpass4', 1);
  DatabaseService.getInstance().addUser({ username: 'advisory-viewer', password_hash: viewerHash, role: 'viewer' });
  const viewerRes = await request(app).post('/api/auth/login').send({ username: 'advisory-viewer', password: 'viewerpass4' });
  const cookies = viewerRes.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => cleanupTestDb(tmpDir));

describe('PUT /api/security/pre-deploy-scan-advisory', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).put('/api/security/pre-deploy-scan-advisory').send({ enabled: true });
    expect(res.status).toBe(401);
  });

  it('rejects an authenticated viewer with 403', async () => {
    const res = await request(app)
      .put('/api/security/pre-deploy-scan-advisory')
      .set('Cookie', viewerCookie)
      .send({ enabled: true });
    expect(res.status).toBe(403);
  });

  it('rejects a non-boolean enabled with 400', async () => {
    const res = await request(app)
      .put('/api/security/pre-deploy-scan-advisory')
      .set('Cookie', adminCookie)
      .send({ enabled: 'yes' });
    expect(res.status).toBe(400);
  });

  it('accepts a Community admin (no tier gate) and persists the setting', async () => {
    const { LicenseService } = await import('../services/LicenseService');
    const spy = vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    try {
      const res = await request(app)
        .put('/api/security/pre-deploy-scan-advisory')
        .set('Cookie', adminCookie)
        .send({ enabled: true });
      expect(res.status).toBe(200);
      expect(res.body.preDeployScanAdvisory).toBe(true);
      expect(DatabaseService.getInstance().getGlobalSettings().pre_deploy_scan_advisory).toBe('1');
    } finally {
      spy.mockReturnValue('paid');
    }
  });

  it('reflects the persisted value on GET /trivy-status', async () => {
    await request(app)
      .put('/api/security/pre-deploy-scan-advisory')
      .set('Cookie', adminCookie)
      .send({ enabled: true });
    const res = await request(app).get('/api/security/trivy-status').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.preDeployScanAdvisory).toBe(true);
  });

  it('disables the setting', async () => {
    const res = await request(app)
      .put('/api/security/pre-deploy-scan-advisory')
      .set('Cookie', adminCookie)
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.preDeployScanAdvisory).toBe(false);
    expect(DatabaseService.getInstance().getGlobalSettings().pre_deploy_scan_advisory).toBe('0');
  });
});
