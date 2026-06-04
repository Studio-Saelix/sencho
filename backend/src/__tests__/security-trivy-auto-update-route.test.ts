/**
 * Tests for the role + tier gate on PUT /api/security/trivy-auto-update.
 *
 * The route flips the global `trivy_auto_update` setting that the scheduler
 * reads every 24h to decide whether to pull newer Trivy binary releases.
 * It must be reachable only by an admin on a paid (Skipper or Admiral) tier.
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

  const viewerHash = await bcrypt.hash('viewerpass3', 1);
  DatabaseService.getInstance().addUser({ username: 'trivy-viewer', password_hash: viewerHash, role: 'viewer' });
  const viewerRes = await request(app).post('/api/auth/login').send({ username: 'trivy-viewer', password: 'viewerpass3' });
  const cookies = viewerRes.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => cleanupTestDb(tmpDir));

describe('PUT /api/security/trivy-auto-update', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app)
      .put('/api/security/trivy-auto-update')
      .send({ enabled: true });
    expect(res.status).toBe(401);
  });

  it('rejects authenticated viewer with 403', async () => {
    const res = await request(app)
      .put('/api/security/trivy-auto-update')
      .set('Cookie', viewerCookie)
      .send({ enabled: true });
    expect(res.status).toBe(403);
  });

  it('rejects Community tier with 403', async () => {
    const { LicenseService } = await import('../services/LicenseService');
    const spy = vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    try {
      const res = await request(app)
        .put('/api/security/trivy-auto-update')
        .set('Cookie', adminCookie)
        .send({ enabled: true });
      expect(res.status).toBe(403);
    } finally {
      spy.mockReturnValue('paid');
    }
  });

  it('accepts paid admin and persists the setting (enable)', async () => {
    const res = await request(app)
      .put('/api/security/trivy-auto-update')
      .set('Cookie', adminCookie)
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.autoUpdate).toBe(true);
    expect(DatabaseService.getInstance().getGlobalSettings().trivy_auto_update).toBe('1');
  });

  it('accepts paid admin and persists the setting (disable)', async () => {
    const res = await request(app)
      .put('/api/security/trivy-auto-update')
      .set('Cookie', adminCookie)
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.autoUpdate).toBe(false);
    expect(DatabaseService.getInstance().getGlobalSettings().trivy_auto_update).toBe('0');
  });
});
