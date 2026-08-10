/**
 * GET /api/security/image-summaries — route-level publicly_exposed enrichment.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let adminCookie: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ LicenseService } = await import('../services/LicenseService'));
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
});

afterAll(() => cleanupTestDb(tmpDir));

function db() {
  return DatabaseService.getInstance();
}

function reset(): void {
  const raw = (db() as unknown as { db: { prepare: (s: string) => { run: () => void } } }).db;
  raw.prepare('DELETE FROM vulnerability_scans').run();
  raw.prepare('DELETE FROM stack_exposure').run();
}

describe('GET /api/security/image-summaries', () => {
  beforeEach(() => reset());

  it('attaches publicly_exposed true/false/null without changing existing fields', async () => {
    const now = Date.now();
    for (const ref of ['pub:1', 'int:1', 'unknown:1']) {
      db().createVulnerabilityScan({
        node_id: 1, image_ref: ref, image_digest: `sha256:${ref}`, scanned_at: now,
        total_vulnerabilities: 0, critical_count: 0, high_count: 0, medium_count: 0, low_count: 0,
        unknown_count: 0, fixable_count: 0, secret_count: 0, misconfig_count: 0, scanners_used: 'vuln',
        highest_severity: null, os_info: null, trivy_version: null, scan_duration_ms: null,
        triggered_by: 'manual', status: 'completed', error: null, stack_context: null,
      });
    }
    db().upsertStackExposure(1, 'web', JSON.stringify({
      stack: 'web',
      computedAt: now,
      services: [
        { service: 'a', image: 'pub:1', publiclyExposed: true, reason: 'published-port', bindings: ['0.0.0.0:80/tcp'] },
        { service: 'b', image: 'int:1', publiclyExposed: false, reason: null, bindings: [] },
      ],
    }), now);

    const res = await request(app).get('/api/security/image-summaries').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body['pub:1']).toMatchObject({ image_ref: 'pub:1', publicly_exposed: true, scan_id: expect.any(Number) });
    expect(res.body['int:1']).toMatchObject({ image_ref: 'int:1', publicly_exposed: false });
    expect(res.body['unknown:1']).toMatchObject({ image_ref: 'unknown:1', publicly_exposed: null });
  });

  it('does not 500 when a stack exposure descriptor is malformed', async () => {
    const now = Date.now();
    db().createVulnerabilityScan({
      node_id: 1, image_ref: 'ok:1', image_digest: 'sha256:ok', scanned_at: now,
      total_vulnerabilities: 0, critical_count: 0, high_count: 0, medium_count: 0, low_count: 0,
      unknown_count: 0, fixable_count: 0, secret_count: 0, misconfig_count: 0, scanners_used: 'vuln',
      highest_severity: null, os_info: null, trivy_version: null, scan_duration_ms: null,
      triggered_by: 'manual', status: 'completed', error: null, stack_context: null,
    });
    db().upsertStackExposure(1, 'bad', 'not-json{{{', now);

    const res = await request(app).get('/api/security/image-summaries').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body['ok:1']).toMatchObject({ image_ref: 'ok:1', publicly_exposed: null });
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/security/image-summaries');
    expect(res.status).toBe(401);
  });
});
