/**
 * GET /api/security/stacks/:stackName/pre-deploy-summary.
 *
 * Read-only advisory data for the pre-deploy dialog. It must:
 *  - short-circuit (no compose/digest/scan work) when the advisory is off,
 *  - resolve each image ref to a digest before the node-scoped scan lookup,
 *  - never trigger a scan (cache-only),
 *  - reject an invalid stack name, and require auth.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import type { VulnerabilityScan } from '../services/DatabaseService';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let ComposeService: typeof import('../services/ComposeService').ComposeService;
let TrivyService: typeof import('../services/TrivyService').default;
let adminCookie: string;
let viewerCookie: string;

function makeScan(over: Partial<VulnerabilityScan>): VulnerabilityScan {
  return {
    id: 1, node_id: 1, image_ref: 'img', image_digest: 'sha256:a', scanned_at: 1000,
    total_vulnerabilities: 5, critical_count: 3, high_count: 2, medium_count: 1, low_count: 4,
    unknown_count: 0, fixable_count: 0, secret_count: 0, misconfig_count: 0,
    scanners_used: 'vuln', highest_severity: 'CRITICAL', os_info: null, trivy_version: null,
    scan_duration_ms: null, triggered_by: 'manual', status: 'completed', error: null,
    stack_context: null, policy_evaluation: null, ...over,
  };
}

function setAdvisory(enabled: boolean): void {
  DatabaseService.getInstance().updateGlobalSetting('pre_deploy_scan_advisory', enabled ? '1' : '0');
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ ComposeService } = await import('../services/ComposeService'));
  TrivyService = (await import('../services/TrivyService')).default;
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);

  const viewerHash = await bcrypt.hash('viewerpass5', 1);
  DatabaseService.getInstance().addUser({ username: 'summary-viewer', password_hash: viewerHash, role: 'viewer' });
  const viewerRes = await request(app).post('/api/auth/login').send({ username: 'summary-viewer', password: 'viewerpass5' });
  const cookies = viewerRes.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => {
  setAdvisory(false);
  cleanupTestDb(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  setAdvisory(false);
});

describe('GET /api/security/stacks/:stackName/pre-deploy-summary', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/security/stacks/web/pre-deploy-summary');
    expect(res.status).toBe(401);
  });

  it('short-circuits to { enabled: false } without any compose/digest work when off', async () => {
    setAdvisory(false);
    const listImages = vi.spyOn(ComposeService.prototype, 'listStackImages');
    const getDigest = vi.spyOn(TrivyService.getInstance(), 'getImageDigest');

    const res = await request(app).get('/api/security/stacks/web/pre-deploy-summary').set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false });
    expect(listImages).not.toHaveBeenCalled();
    expect(getDigest).not.toHaveBeenCalled();
  });

  it('returns per-image cached scan counts, resolving refs to digests (cache-only)', async () => {
    setAdvisory(true);
    vi.spyOn(ComposeService.prototype, 'listStackImages').mockResolvedValue(['nginx:1.14', 'redis:7']);
    vi.spyOn(TrivyService.getInstance(), 'getImageDigest').mockImplementation(
      async (ref: string) => (ref === 'nginx:1.14' ? 'sha256:nginx' : null),
    );
    const lookup = vi
      .spyOn(DatabaseService.getInstance(), 'getLatestVulnScanByDigestForNode')
      .mockImplementation((digest: string) => (digest === 'sha256:nginx' ? makeScan({ critical_count: 31, high_count: 82, highest_severity: 'CRITICAL', scanned_at: 4242 }) : null));
    // Cache-only: the advisory must never kick off a scan.
    const runScan = vi.spyOn(TrivyService.getInstance(), 'scanImagePreflight');

    const res = await request(app).get('/api/security/stacks/web/pre-deploy-summary').set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.images).toEqual([
      {
        imageRef: 'nginx:1.14',
        scan: { criticalCount: 31, highCount: 82, mediumCount: 1, lowCount: 4, highestSeverity: 'CRITICAL', scannedAt: 4242 },
      },
      { imageRef: 'redis:7', scan: null },
    ]);
    expect(lookup).toHaveBeenCalled();
    expect(runScan).not.toHaveBeenCalled();
  });

  it('rejects an invalid stack name with 400 when enabled', async () => {
    setAdvisory(true);
    const res = await request(app).get('/api/security/stacks/bad%20name/pre-deploy-summary').set('Cookie', adminCookie);
    expect(res.status).toBe(400);
  });

  it('is readable by a non-admin (advisory visibility is not admin-gated)', async () => {
    setAdvisory(true);
    vi.spyOn(ComposeService.prototype, 'listStackImages').mockResolvedValue(['nginx:1.14']);
    vi.spyOn(TrivyService.getInstance(), 'getImageDigest').mockResolvedValue(null);

    const res = await request(app).get('/api/security/stacks/web/pre-deploy-summary').set('Cookie', viewerCookie);

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });

  it('returns a generic 500 (no internal detail) when image enumeration fails', async () => {
    setAdvisory(true);
    vi.spyOn(ComposeService.prototype, 'listStackImages').mockRejectedValue(new Error('/secret/path: compose parse boom'));

    const res = await request(app).get('/api/security/stacks/web/pre-deploy-summary').set('Cookie', adminCookie);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to build pre-deploy summary');
    expect(JSON.stringify(res.body)).not.toContain('/secret/path');
  });
});
