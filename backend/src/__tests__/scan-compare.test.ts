/**
 * Coverage for GET /api/security/compare (index.ts:7966-7999).
 *
 * Locks behavior before H-2 (truncation signal) and H-3 (scan-history
 * pagination) land. Scenarios cover tier gating, input validation, cross-node
 * isolation, diff partitioning, suppression application, and cross-image
 * comparison. Truncation-signal assertions are added alongside the H-2 fix.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import type { VulnSeverity } from '../services/DatabaseService';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let tierSpy: ReturnType<typeof vi.spyOn>;

const LOCAL_NODE = 1;
const OTHER_NODE = 99;

function adminToken(): string {
  const db = DatabaseService.getInstance();
  const user = db.getUserByUsername(TEST_USERNAME)!;
  return jwt.sign(
    { username: TEST_USERNAME, role: 'admin', tv: user.token_version },
    TEST_JWT_SECRET,
    { expiresIn: '1m' },
  );
}

function seedScan(opts: {
  nodeId?: number;
  imageRef?: string;
  scannedAt?: number;
  totalVulnerabilities?: number;
} = {}): number {
  const db = DatabaseService.getInstance();
  return db.createVulnerabilityScan({
    node_id: opts.nodeId ?? LOCAL_NODE,
    image_ref: opts.imageRef ?? 'alpine:3.19',
    image_digest: `sha256:${Math.random().toString(16).slice(2)}`,
    scanned_at: opts.scannedAt ?? Date.now(),
    total_vulnerabilities: opts.totalVulnerabilities ?? 0,
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
    os_info: 'alpine 3.19',
    trivy_version: '0.56.0',
    scan_duration_ms: 100,
    triggered_by: 'manual',
    status: 'completed',
    error: null,
    stack_context: null,
  });
}

function seedVuln(
  scanId: number,
  cve: string,
  pkg: string,
  severity: VulnSeverity = 'HIGH',
): void {
  DatabaseService.getInstance().insertVulnerabilityDetails(scanId, [
    {
      vulnerability_id: cve,
      pkg_name: pkg,
      installed_version: '1.0.0',
      fixed_version: '1.0.1',
      severity,
      title: `${cve} in ${pkg}`,
      description: null,
      primary_url: `https://example.com/${cve}`,
    },
  ]);
}

function resetTables(): void {
  const db = DatabaseService.getInstance();
  // CASCADE on vulnerability_details FK wipes children too.
  (db as unknown as { db: { prepare: (s: string) => { run: () => void } } }).db
    .prepare('DELETE FROM vulnerability_scans')
    .run();
  (db as unknown as { db: { prepare: (s: string) => { run: () => void } } }).db
    .prepare('DELETE FROM cve_suppressions')
    .run();
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));

  const { LicenseService } = await import('../services/LicenseService');
  tierSpy = vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');

  ({ app } = await import('../index'));
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  resetTables();
  tierSpy.mockReturnValue('paid');
});

describe('GET /api/security/compare', () => {
  it('is accessible on community tier', async () => {
    tierSpy.mockReturnValue('community');
    const a = seedScan();
    const b = seedScan({ scannedAt: Date.now() + 1000 });

    const res = await request(app)
      .get(`/api/security/compare?scanId1=${a}&scanId2=${b}`)
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.body.code).not.toBe('PAID_REQUIRED');
  });

  it('returns 400 for non-finite scanId params', async () => {
    const res = await request(app)
      .get('/api/security/compare?scanId1=foo&scanId2=bar')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('returns 400 when only one scanId is provided', async () => {
    const a = seedScan();
    const res = await request(app)
      .get(`/api/security/compare?scanId1=${a}`)
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(400);
  });

  it('returns 404 when either scan is missing', async () => {
    const a = seedScan();
    const res = await request(app)
      .get(`/api/security/compare?scanId1=${a}&scanId2=99999`)
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 404 when scans belong to different nodes', async () => {
    const a = seedScan({ nodeId: LOCAL_NODE });
    const b = seedScan({ nodeId: OTHER_NODE });
    const res = await request(app)
      .get(`/api/security/compare?scanId1=${a}&scanId2=${b}`)
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when a scan belongs to a different node than the request', async () => {
    const a = seedScan({ nodeId: OTHER_NODE });
    const b = seedScan({ nodeId: OTHER_NODE, scannedAt: Date.now() + 1000 });
    // request goes to LOCAL_NODE (default), so scans belong to OTHER_NODE are invisible
    const res = await request(app)
      .get(`/api/security/compare?scanId1=${a}&scanId2=${b}`)
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(404);
  });

  it('partitions findings into added / removed / unchanged', async () => {
    const baseline = seedScan({ scannedAt: 1000 });
    seedVuln(baseline, 'CVE-2024-0001', 'openssl', 'CRITICAL'); // unchanged
    seedVuln(baseline, 'CVE-2024-0002', 'curl', 'HIGH'); // removed

    const current = seedScan({ scannedAt: 2000 });
    seedVuln(current, 'CVE-2024-0001', 'openssl', 'CRITICAL'); // unchanged
    seedVuln(current, 'CVE-2024-0003', 'zlib', 'MEDIUM'); // added

    const res = await request(app)
      .get(`/api/security/compare?scanId1=${baseline}&scanId2=${current}`)
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.scanA.id).toBe(baseline);
    expect(res.body.scanB.id).toBe(current);
    expect(res.body.added).toHaveLength(1);
    expect(res.body.added[0].vulnerability_id).toBe('CVE-2024-0003');
    expect(res.body.removed).toHaveLength(1);
    expect(res.body.removed[0].vulnerability_id).toBe('CVE-2024-0002');
    expect(res.body.unchanged).toHaveLength(1);
    expect(res.body.unchanged[0].vulnerability_id).toBe('CVE-2024-0001');
  });

  it('keys the diff by vulnerability_id::pkg_name (same CVE on different packages is not "unchanged")', async () => {
    const baseline = seedScan({ scannedAt: 1000 });
    seedVuln(baseline, 'CVE-2024-1000', 'libfoo', 'HIGH');

    const current = seedScan({ scannedAt: 2000 });
    seedVuln(current, 'CVE-2024-1000', 'libbar', 'HIGH');

    const res = await request(app)
      .get(`/api/security/compare?scanId1=${baseline}&scanId2=${current}`)
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.added).toHaveLength(1);
    expect(res.body.removed).toHaveLength(1);
    expect(res.body.unchanged).toHaveLength(0);
  });

  it('applies cve_suppressions to all three buckets', async () => {
    const baseline = seedScan({ scannedAt: 1000 });
    seedVuln(baseline, 'CVE-2024-0100', 'openssl'); // unchanged
    seedVuln(baseline, 'CVE-2024-0101', 'curl'); // removed

    const current = seedScan({ scannedAt: 2000 });
    seedVuln(current, 'CVE-2024-0100', 'openssl'); // unchanged
    seedVuln(current, 'CVE-2024-0102', 'zlib'); // added

    DatabaseService.getInstance().createCveSuppression({
      cve_id: 'CVE-2024-0100',
      pkg_name: null,
      image_pattern: null,
      reason: 'false positive',
      created_by: TEST_USERNAME,
      created_at: Date.now(),
      expires_at: null,
      replicated_from_control: 0,
    });
    DatabaseService.getInstance().createCveSuppression({
      cve_id: 'CVE-2024-0101',
      pkg_name: null,
      image_pattern: null,
      reason: 'accepted risk',
      created_by: TEST_USERNAME,
      created_at: Date.now(),
      expires_at: null,
      replicated_from_control: 0,
    });

    const res = await request(app)
      .get(`/api/security/compare?scanId1=${baseline}&scanId2=${current}`)
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    const unchanged0100 = res.body.unchanged.find(
      (v: { vulnerability_id: string }) => v.vulnerability_id === 'CVE-2024-0100',
    );
    expect(unchanged0100.suppressed).toBe(true);
    expect(unchanged0100.suppression_reason).toBe('false positive');

    const removed0101 = res.body.removed.find(
      (v: { vulnerability_id: string }) => v.vulnerability_id === 'CVE-2024-0101',
    );
    expect(removed0101.suppressed).toBe(true);

    const added0102 = res.body.added.find(
      (v: { vulnerability_id: string }) => v.vulnerability_id === 'CVE-2024-0102',
    );
    expect(added0102.suppressed).toBe(false);
  });

  it('flags truncated=true when either scan exceeds the 1000-row cap', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = seedScan({ scannedAt: 1000, totalVulnerabilities: 1500 });
    const b = seedScan({ scannedAt: 2000, totalVulnerabilities: 10 });

    const res = await request(app)
      .get(`/api/security/compare?scanId1=${a}&scanId2=${b}`)
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.row_limit).toBe(1000);
    expect(res.body.scanA.total_vulnerabilities).toBe(1500);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('returns truncated=false when both scans fit within the row cap', async () => {
    const a = seedScan({ scannedAt: 1000, totalVulnerabilities: 5 });
    const b = seedScan({ scannedAt: 2000, totalVulnerabilities: 10 });

    const res = await request(app)
      .get(`/api/security/compare?scanId1=${a}&scanId2=${b}`)
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(false);
  });

  it('allows cross-image comparison on the same node and preserves distinct image refs', async () => {
    const a = seedScan({ imageRef: 'alpine:3.18', scannedAt: 1000 });
    const b = seedScan({ imageRef: 'alpine:3.19', scannedAt: 2000 });

    const res = await request(app)
      .get(`/api/security/compare?scanId1=${a}&scanId2=${b}`)
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.scanA.image_ref).toBe('alpine:3.18');
    expect(res.body.scanB.image_ref).toBe('alpine:3.19');
  });
});
