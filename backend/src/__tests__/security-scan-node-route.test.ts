/**
 * POST /api/security/scan-node -> on-demand node-wide scan (admin, scanner-gated).
 * Covers the route contract: auth, admin, scanner availability, strict body
 * validation, the success summary, and the per-node-busy conflict. The scan
 * engine itself is mocked; TrivyService.scanNode is unit-tested separately.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import type { ScanNodeResult } from '../services/TrivyService';

let tmpDir: string;
let app: import('express').Express;
let adminCookie: string;
let viewerCookie: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let TrivyService: typeof import('../services/TrivyService').default;

const SUMMARY: ScanNodeResult = {
  images: { scanned: 2, skipped: 1, failed: 0, totalImages: 3, processedImages: 3, truncated: false, severity: { critical: 1, high: 2, medium: 0, low: 0, unknown: 0 }, violations: [] },
  stacks: { scanned: 1, failed: 0, total: 1 },
  severity: { critical: 1, high: 2, medium: 0, low: 0, unknown: 0 },
  violations: [],
};

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ LicenseService } = await import('../services/LicenseService'));
  TrivyService = (await import('../services/TrivyService')).default;
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);

  const viewerHash = await bcrypt.hash('snviewer1', 1);
  DatabaseService.getInstance().addUser({ username: 'sn-viewer', password_hash: viewerHash, role: 'viewer' });
  const res = await request(app).post('/api/auth/login').send({ username: 'sn-viewer', password: 'snviewer1' });
  const cookies = res.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => cleanupTestDb(tmpDir));

function svc() {
  return TrivyService.getInstance();
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
  vi.spyOn(svc(), 'isTrivyAvailable').mockReturnValue(true);
});

describe('POST /api/security/scan-node', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/security/scan-node').send({ vulns: true });
    expect(res.status).toBe(401);
  });

  it('requires admin (viewer is rejected)', async () => {
    const res = await request(app).post('/api/security/scan-node').set('Cookie', viewerCookie).send({ vulns: true });
    expect(res.status).toBe(403);
  });

  it('returns 503 when the scanner is unavailable', async () => {
    vi.spyOn(svc(), 'isTrivyAvailable').mockReturnValue(false);
    const res = await request(app).post('/api/security/scan-node').set('Cookie', adminCookie).send({ vulns: true });
    expect(res.status).toBe(503);
  });

  it('returns 400 when no scan type is selected', async () => {
    const scanNode = vi.spyOn(svc(), 'scanNode');
    const res = await request(app).post('/api/security/scan-node').set('Cookie', adminCookie)
      .send({ vulns: false, secrets: false, misconfig: false });
    expect(res.status).toBe(400);
    expect(scanNode).not.toHaveBeenCalled();
  });

  it('returns 400 when a scan-type flag is not a boolean', async () => {
    const res = await request(app).post('/api/security/scan-node').set('Cookie', adminCookie).send({ vulns: 'yes' });
    expect(res.status).toBe(400);
  });

  it('runs the scan and returns the summary, passing the selected types', async () => {
    const scanNode = vi.spyOn(svc(), 'scanNode').mockResolvedValue(SUMMARY);
    const res = await request(app).post('/api/security/scan-node').set('Cookie', adminCookie)
      .send({ vulns: true, secrets: false, misconfig: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stacks: { scanned: 1 }, severity: { critical: 1, high: 2 } });
    // No progress socket is opened in the test, so onProgress resolves undefined.
    expect(scanNode).toHaveBeenCalledWith(
      expect.any(Number),
      { vulns: true, secrets: false, misconfig: true },
      'manual',
      undefined,
    );
  });

  it('returns 409 when the node is already being scanned', async () => {
    vi.spyOn(svc(), 'scanNode').mockRejectedValue(new Error('Already scanning this node'));
    const res = await request(app).post('/api/security/scan-node').set('Cookie', adminCookie).send({ vulns: true });
    expect(res.status).toBe(409);
  });
});
