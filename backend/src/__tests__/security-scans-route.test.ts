/**
 * Route wiring for GET /api/security/scans: auth, legacy imageRefLike,
 * additive imageIdentityLike, exact imageDigest, node isolation, and
 * cappedIdentities response shape.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let adminCookie: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  const { LicenseService } = await import('../services/LicenseService');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
});

afterAll(() => cleanupTestDb(tmpDir));

function seedScan(overrides: {
  node_id?: number;
  image_ref?: string;
  image_digest?: string | null;
  scanned_at?: number;
} = {}): number {
  const db = DatabaseService.getInstance();
  return db.createVulnerabilityScan({
    node_id: overrides.node_id ?? 1,
    image_ref: overrides.image_ref ?? 'alpine:3.19',
    image_digest: overrides.image_digest === undefined
      ? `sha256:${Math.random().toString(16).slice(2)}`
      : overrides.image_digest,
    scanned_at: overrides.scanned_at ?? Date.now(),
    total_vulnerabilities: 0,
    critical_count: 0,
    high_count: 0,
    medium_count: 0,
    low_count: 0,
    unknown_count: 0,
    fixable_count: 0,
    secret_count: 0,
    misconfig_count: 0,
    scanners_used: 'vuln',
    highest_severity: null,
    os_info: null,
    trivy_version: null,
    scan_duration_ms: null,
    triggered_by: 'manual',
    status: 'completed',
    error: null,
    stack_context: null,
  });
}

beforeEach(() => {
  DatabaseService.getInstance().getDb().prepare('DELETE FROM vulnerability_scans').run();
});

describe('GET /api/security/scans query wiring', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/security/scans');
    expect(res.status).toBe(401);
  });

  it('forwards legacy imageRefLike as reference-only', async () => {
    seedScan({ image_ref: 'alpine:3.19', image_digest: 'sha256:aaa', scanned_at: 1 });
    seedScan({ image_ref: 'nginx:1', image_digest: 'sha256:alpinezzz', scanned_at: 2 });

    const res = await request(app)
      .get('/api/security/scans?imageRefLike=alpine&status=completed')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].image_ref).toBe('alpine:3.19');
    expect(Array.isArray(res.body.cappedIdentities)).toBe(true);
  });

  it('forwards imageIdentityLike matching ref or digest', async () => {
    seedScan({ image_ref: 'nginx:1', image_digest: 'sha256:deadbeef99', scanned_at: 1 });
    seedScan({ image_ref: 'redis:7', image_digest: 'sha256:other', scanned_at: 2 });

    const byDigest = await request(app)
      .get('/api/security/scans?imageIdentityLike=deadbeef&status=completed')
      .set('Cookie', adminCookie);
    expect(byDigest.status).toBe(200);
    expect(byDigest.body.total).toBe(1);
    expect(byDigest.body.items[0].image_ref).toBe('nginx:1');

    const byRef = await request(app)
      .get('/api/security/scans?imageIdentityLike=redis&status=completed')
      .set('Cookie', adminCookie);
    expect(byRef.body.total).toBe(1);
    expect(byRef.body.items[0].image_ref).toBe('redis:7');
  });

  it('forwards exact imageDigest', async () => {
    const digest = 'sha256:exactroute01';
    seedScan({ image_ref: 'a:1', image_digest: digest, scanned_at: 1 });
    seedScan({ image_ref: 'a:2', image_digest: 'sha256:other', scanned_at: 2 });

    const res = await request(app)
      .get(`/api/security/scans?imageDigest=${encodeURIComponent(digest)}&status=completed`)
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].image_digest).toBe(digest);
  });

  it('scopes listing and cappedIdentities to the request node', async () => {
    const db = DatabaseService.getInstance();
    db.updateGlobalSetting('scan_history_per_image_limit', '2');
    db.getDb()
      .prepare(`INSERT OR IGNORE INTO nodes (id, name, type, compose_dir, is_default, status, created_at)
                VALUES (2, 'Peer', 'remote', '/tmp', 0, 'online', ?)`)
      .run(Date.now());
    const digest = 'sha256:noderoute00';
    for (let i = 0; i < 4; i++) {
      seedScan({ node_id: 1, image_ref: 'a:1', image_digest: digest, scanned_at: 1000 + i });
    }
    for (let i = 0; i < 4; i++) {
      seedScan({ node_id: 2, image_ref: 'a:1', image_digest: digest, scanned_at: 2000 + i });
    }

    const res = await request(app)
      .get('/api/security/scans?status=completed&limit=50')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items.every((s: { node_id: number }) => s.node_id === 1)).toBe(true);
    expect(res.body.cappedIdentities).toEqual([
      { key: digest, kind: 'digest', displayRef: 'a:1' },
    ]);
  });
});

describe('POST /api/security/scan hold refs', () => {
  it('rejects Sencho rollback-hold image refs with 400 before starting a scan', async () => {
    const { default: TrivyService } = await import('../services/TrivyService');
    vi.spyOn(TrivyService.getInstance(), 'isTrivyAvailable').mockReturnValue(true);
    const begin = vi.spyOn(TrivyService.getInstance(), 'beginScan');

    const res = await request(app)
      .post('/api/security/scan')
      .set('Cookie', adminCookie)
      .send({ imageRef: 'sencho-rb/aaaaaaaaaaaa/web:hold' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rollback-hold/i);
    expect(begin).not.toHaveBeenCalled();
  });
});
