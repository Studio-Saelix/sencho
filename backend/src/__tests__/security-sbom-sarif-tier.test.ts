/**
 * Both scan-export endpoints are available on every tier (admin only, no tier gate):
 *   POST /api/security/sbom            -> per-image SBOM artifact
 *   GET  /api/security/scans/:id/sarif -> SARIF for CI / code-scanning ingestion
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let adminCookie: string;
let viewerCookie: string;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let TrivyService: typeof import('../services/TrivyService').default;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ LicenseService } = await import('../services/LicenseService'));
  TrivyService = (await import('../services/TrivyService')).default;
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);

  const { DatabaseService } = await import('../services/DatabaseService');
  const viewerHash = await bcrypt.hash('sbomviewer1', 1);
  DatabaseService.getInstance().addUser({ username: 'sbom-viewer', password_hash: viewerHash, role: 'viewer' });
  const viewerRes = await request(app).post('/api/auth/login').send({ username: 'sbom-viewer', password: 'sbomviewer1' });
  const cookies = viewerRes.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => cleanupTestDb(tmpDir));

function mockTier(tier: 'paid' | 'community') {
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue(tier);
}

describe('POST /api/security/sbom (Community)', () => {
  afterEach(() => { vi.restoreAllMocks(); mockTier('paid'); });

  it('lets a Community admin generate an SBOM (no PAID_REQUIRED gate)', async () => {
    mockTier('community');
    const svc = TrivyService.getInstance();
    vi.spyOn(svc, 'isTrivyAvailable').mockReturnValue(true);
    vi.spyOn(svc, 'generateSBOM').mockResolvedValue('{"bomFormat":"CycloneDX"}');

    const res = await request(app)
      .post('/api/security/sbom')
      .set('Cookie', adminCookie)
      .send({ imageRef: 'nginx:latest', format: 'cyclonedx' });

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('nginx_latest.cdx.json');
  });

  it('denies a non-admin (viewer) with 403 (admin gate is the sole guard now)', async () => {
    mockTier('community');
    const res = await request(app)
      .post('/api/security/sbom')
      .set('Cookie', viewerCookie)
      .send({ imageRef: 'nginx:latest', format: 'cyclonedx' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/security/scans/:scanId/sarif (Community)', () => {
  afterEach(() => { vi.restoreAllMocks(); mockTier('paid'); });

  it('lets a Community admin reach the route (404 for a missing scan, not 403)', async () => {
    mockTier('community');
    const res = await request(app)
      .get('/api/security/scans/999999/sarif')
      .set('Cookie', adminCookie);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(404);
  });

  it('denies a non-admin (viewer) with 403 (admin gate is the sole guard now)', async () => {
    mockTier('community');
    const res = await request(app)
      .get('/api/security/scans/999999/sarif')
      .set('Cookie', viewerCookie);
    expect(res.status).toBe(403);
  });
});
