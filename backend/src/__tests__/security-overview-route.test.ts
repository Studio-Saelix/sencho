/**
 * GET /api/security/overview  -> node-scoped posture rollup (Community, auth-only)
 * GET /api/security/policy-packs -> static catalog (Community, auth-only, identical per tier)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let adminCookie: string;
let viewerCookie: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let TrivyService: typeof import('../services/TrivyService').default;

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ LicenseService } = await import('../services/LicenseService'));
  TrivyService = (await import('../services/TrivyService')).default;
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
  // Deterministic scanner readout for the overview's scanner block.
  const svc = TrivyService.getInstance();
  vi.spyOn(svc, 'isTrivyAvailable').mockReturnValue(true);
  vi.spyOn(svc, 'getVersion').mockReturnValue('0.52.0');
  vi.spyOn(svc, 'getSource').mockReturnValue('managed');
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);

  const viewerHash = await bcrypt.hash('ovviewer1', 1);
  DatabaseService.getInstance().addUser({ username: 'ov-viewer', password_hash: viewerHash, role: 'viewer' });
  const res = await request(app).post('/api/auth/login').send({ username: 'ov-viewer', password: 'ovviewer1' });
  const cookies = res.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => cleanupTestDb(tmpDir));

function db() {
  return DatabaseService.getInstance();
}

function seedScan(o: {
  node_id?: number;
  image_ref: string;
  scanned_at: number;
  status?: 'completed' | 'failed';
  critical?: number;
  high?: number;
  fixable?: number;
  secret?: number;
  misconfig?: number;
}): void {
  db().createVulnerabilityScan({
    node_id: o.node_id ?? 1,
    image_ref: o.image_ref,
    image_digest: `sha256:${o.image_ref}-${Math.random().toString(16).slice(2)}`,
    scanned_at: o.scanned_at,
    total_vulnerabilities: (o.critical ?? 0) + (o.high ?? 0),
    critical_count: o.critical ?? 0,
    high_count: o.high ?? 0,
    medium_count: 0,
    low_count: 0,
    unknown_count: 0,
    fixable_count: o.fixable ?? 0,
    secret_count: o.secret ?? 0,
    misconfig_count: o.misconfig ?? 0,
    scanners_used: 'vuln',
    highest_severity: (o.critical ?? 0) > 0 ? 'CRITICAL' : null,
    os_info: null,
    trivy_version: null,
    scan_duration_ms: null,
    triggered_by: 'manual',
    status: o.status ?? 'completed',
    error: o.status === 'failed' ? 'boom' : null,
    stack_context: o.image_ref.startsWith('stack:') ? o.image_ref.slice(6) : null,
  });
}

function resetSecurity(): void {
  const raw = (db() as unknown as { db: { prepare: (s: string) => { run: () => void } } }).db;
  raw.prepare('DELETE FROM vulnerability_details').run();
  raw.prepare('DELETE FROM vulnerability_scans').run();
  raw.prepare('DELETE FROM scan_policies').run();
  raw.prepare('DELETE FROM cve_suppressions').run();
  raw.prepare('DELETE FROM misconfig_acknowledgements').run();
  raw.prepare('DELETE FROM cve_intel').run();
}

describe('GET /api/security/overview', () => {
  beforeEach(() => {
    resetSecurity();
    db().updateGlobalSetting('deploy_block_honor_suppressions', '1');
  });

  it('aggregates node-scoped counts with the documented shape', async () => {
    const now = Date.now();
    seedScan({ image_ref: 'imgA:1', scanned_at: now - 1000, critical: 2, high: 1, fixable: 3, secret: 1 });
    seedScan({ image_ref: 'imgB:1', scanned_at: now - 8 * DAY }); // stale
    seedScan({ image_ref: 'stack:web', scanned_at: now - 2000, misconfig: 2 });
    // Failed scans (same image) beyond a single row prove the uncapped count.
    for (let i = 0; i < 4; i++) seedScan({ image_ref: 'imgA:1', scanned_at: now, status: 'failed' });
    // Other node's data must be excluded.
    seedScan({ node_id: 2, image_ref: 'other:1', scanned_at: now, critical: 99 });

    // One fleet-wide and one this-node block policy count; an other-node one does not.
    db().createScanPolicy({ name: 'fw', node_id: null, node_identity: '', stack_pattern: null, max_severity: 'CRITICAL', block_on_deploy: 1, block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0, enabled: 1, replicated_from_control: 0 });
    db().createScanPolicy({ name: 'n1', node_id: 1, node_identity: '', stack_pattern: null, max_severity: 'CRITICAL', block_on_deploy: 1, block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0, enabled: 1, replicated_from_control: 0 });
    db().createScanPolicy({ name: 'n2', node_id: 2, node_identity: '', stack_pattern: null, max_severity: 'CRITICAL', block_on_deploy: 1, block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0, enabled: 1, replicated_from_control: 0 });

    const res = await request(app).get('/api/security/overview').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      scannedImages: 2,       // imgA + imgB, stack:web excluded
      critical: 2,            // node-2's 99 excluded
      high: 1,
      fixable: 3,
      secrets: 1,
      misconfigs: 2,
      staleScans: 1,          // imgB only
      failedScans: 4,         // uncapped
    });
    expect(res.body.lastSuccessfulScanAt).toBeGreaterThan(0);
    expect(res.body.scanner).toMatchObject({ available: true, source: 'managed', version: '0.52.0' });
    expect(res.body.deployEnforcement).toMatchObject({
      honorSuppressionsOnDeploy: true,
      eligibleBlockPolicies: 2,
    });
  });

  it('derives suppression- and ack-aware posture facts from detail rows', async () => {
    const now = Date.now();
    const scanId = db().createVulnerabilityScan({
      node_id: 1,
      image_ref: 'app:1',
      image_digest: `sha256:app-${Math.random().toString(16).slice(2)}`,
      scanned_at: now,
      total_vulnerabilities: 3,
      critical_count: 2,
      high_count: 1,
      medium_count: 0,
      low_count: 0,
      unknown_count: 0,
      fixable_count: 2,
      secret_count: 0,
      misconfig_count: 2,
      scanners_used: 'vuln',
      highest_severity: 'CRITICAL',
      os_info: null,
      trivy_version: null,
      scan_duration_ms: null,
      triggered_by: 'manual',
      status: 'completed',
      error: null,
      stack_context: null,
    });
    const detail = (vulnerability_id: string, severity: 'CRITICAL' | 'HIGH', fixed_version: string | null) => ({
      vulnerability_id, pkg_name: `pkg-${vulnerability_id}`, installed_version: '1', fixed_version,
      severity, title: null, description: null, primary_url: null,
    });
    db().insertVulnerabilityDetails(scanId, [
      detail('CVE-2024-0001', 'CRITICAL', '2'),   // fixable, counts
      detail('CVE-2024-0002', 'HIGH', null),       // unfixable, does not count
      detail('CVE-2024-0003', 'CRITICAL', '9'),    // fixable but suppressed -> accepted, not fixable
    ]);
    db().createCveSuppression({
      cve_id: 'CVE-2024-0003', pkg_name: null, image_pattern: null, reason: 'accepted risk',
      created_by: 'admin', created_at: now, expires_at: null, replicated_from_control: 0,
    });
    db().insertMisconfigFindings(scanId, [
      { rule_id: 'DS001', check_id: null, severity: 'HIGH', title: null, message: null, resolution: null, target: 'app', primary_url: null },
      { rule_id: 'DS002', check_id: null, severity: 'CRITICAL', title: null, message: null, resolution: null, target: 'app', primary_url: null },
    ]);
    db().createMisconfigAcknowledgement({
      rule_id: 'DS001', stack_pattern: null, reason: 'acknowledged',
      created_by: 'admin', created_at: now, expires_at: null, replicated_from_control: 0,
    });

    const res = await request(app).get('/api/security/overview').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      rawCritical: 2,
      rawHigh: 1,
      fixableCriticalHigh: 1,   // 0001 only (0003 suppressed, 0002 unfixable)
      accepted: 1,              // 0003 suppressed
      dangerousCompose: 1,      // DS002 (DS001 acknowledged)
      knownExploited: 0,
      publiclyExposed: 0,
      needsReview: 0,
      notAffected: 0,
      posture: 'Action needed',
      posturePartial: false,
    });
  });

  it('separates not_affected and needs_review triage facts in the overview', async () => {
    const now = Date.now();
    const scanId = db().createVulnerabilityScan({
      node_id: 1, image_ref: 'triage:1', image_digest: 'sha256:triage', scanned_at: now,
      total_vulnerabilities: 2, critical_count: 2, high_count: 0, medium_count: 0, low_count: 0,
      unknown_count: 0, fixable_count: 0, secret_count: 0, misconfig_count: 0, scanners_used: 'vuln',
      highest_severity: 'CRITICAL', os_info: null, trivy_version: null, scan_duration_ms: null,
      triggered_by: 'manual', status: 'completed', error: null, stack_context: null,
    });
    db().insertVulnerabilityDetails(scanId, [
      { vulnerability_id: 'CVE-2024-0010', pkg_name: 'a', installed_version: '1', fixed_version: null, severity: 'CRITICAL', title: null, description: null, primary_url: null },
      { vulnerability_id: 'CVE-2024-0011', pkg_name: 'b', installed_version: '1', fixed_version: null, severity: 'CRITICAL', title: null, description: null, primary_url: null },
    ]);
    db().createCveSuppression({ cve_id: 'CVE-2024-0010', pkg_name: null, image_pattern: null, reason: 'not affected', created_by: 'admin', created_at: now, expires_at: null, replicated_from_control: 0, status: 'not_affected' });
    db().createCveSuppression({ cve_id: 'CVE-2024-0011', pkg_name: null, image_pattern: null, reason: 'reviewing', created_by: 'admin', created_at: now, expires_at: null, replicated_from_control: 0, status: 'needs_review' });

    const res = await request(app).get('/api/security/overview').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ notAffected: 1, needsReview: 1, accepted: 0, fixableCriticalHigh: 0, posture: 'Monitoring' });
  });

  it('escalates an unfixable known-exploited (KEV) finding to Action needed', async () => {
    const now = Date.now();
    const scanId = db().createVulnerabilityScan({
      node_id: 1, image_ref: 'kev:1', image_digest: 'sha256:kev', scanned_at: now,
      total_vulnerabilities: 1, critical_count: 1, high_count: 0, medium_count: 0, low_count: 0,
      unknown_count: 0, fixable_count: 0, secret_count: 0, misconfig_count: 0, scanners_used: 'vuln',
      highest_severity: 'CRITICAL', os_info: null, trivy_version: null, scan_duration_ms: null,
      triggered_by: 'manual', status: 'completed', error: null, stack_context: null,
    });
    db().insertVulnerabilityDetails(scanId, [{
      vulnerability_id: 'CVE-2024-9999', pkg_name: 'libkev', installed_version: '1', fixed_version: null,
      severity: 'CRITICAL', title: null, description: null, primary_url: null,
    }]);
    // No fix available, but the CVE is known-exploited: KEV overrides "no fix".
    db().replaceKev([{ cve_id: 'CVE-2024-9999', date_added: '2024-01-01' }], now);

    const res = await request(app).get('/api/security/overview').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ knownExploited: 1, fixableCriticalHigh: 0, posture: 'Action needed' });
  });

  it('preserves vulnerability posture when a newer secret-only scan exists for the same image', async () => {
    const now = Date.now();
    // Vulnerability scan: one unfixable Critical that is known-exploited.
    const vulnScan = db().createVulnerabilityScan({
      node_id: 1, image_ref: 'app:1', image_digest: 'sha256:app-vuln', scanned_at: now - 1000,
      total_vulnerabilities: 1, critical_count: 1, high_count: 0, medium_count: 0, low_count: 0,
      unknown_count: 0, fixable_count: 0, secret_count: 0, misconfig_count: 0, scanners_used: 'vuln',
      highest_severity: 'CRITICAL', os_info: null, trivy_version: null, scan_duration_ms: null,
      triggered_by: 'manual', status: 'completed', error: null, stack_context: null,
    });
    db().insertVulnerabilityDetails(vulnScan, [{
      vulnerability_id: 'CVE-2024-5001', pkg_name: 'libkev', installed_version: '1', fixed_version: null,
      severity: 'CRITICAL', title: null, description: null, primary_url: null,
    }]);
    db().replaceKev([{ cve_id: 'CVE-2024-5001', date_added: '2024-01-01' }], now);
    // Newer secret-only node scan for the SAME image: no vuln details, carries a secret.
    db().createVulnerabilityScan({
      node_id: 1, image_ref: 'app:1', image_digest: 'sha256:app-secret', scanned_at: now,
      total_vulnerabilities: 0, critical_count: 0, high_count: 0, medium_count: 0, low_count: 0,
      unknown_count: 0, fixable_count: 0, secret_count: 1, misconfig_count: 0, scanners_used: 'secret',
      highest_severity: null, os_info: null, trivy_version: null, scan_duration_ms: null,
      triggered_by: 'manual', status: 'completed', error: null, stack_context: null,
    });

    const res = await request(app).get('/api/security/overview').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    // The secret-only scan must not erase the vulnerability posture, and its
    // secret finding is still counted.
    expect(res.body).toMatchObject({
      critical: 1,
      knownExploited: 1,
      secrets: 1,
      posture: 'Action needed',
    });
  });

  it('counts a Low/Medium known-exploited finding in knownExploited and posture (matches the deploy gate)', async () => {
    const now = Date.now();
    const scanId = db().createVulnerabilityScan({
      node_id: 1, image_ref: 'lowkev:1', image_digest: 'sha256:lowkev', scanned_at: now,
      total_vulnerabilities: 1, critical_count: 0, high_count: 0, medium_count: 0, low_count: 1,
      unknown_count: 0, fixable_count: 0, secret_count: 0, misconfig_count: 0, scanners_used: 'vuln',
      highest_severity: 'LOW', os_info: null, trivy_version: null, scan_duration_ms: null,
      triggered_by: 'manual', status: 'completed', error: null, stack_context: null,
    });
    db().insertVulnerabilityDetails(scanId, [{
      vulnerability_id: 'CVE-2024-5002', pkg_name: 'liblow', installed_version: '1', fixed_version: null,
      severity: 'LOW', title: null, description: null, primary_url: null,
    }]);
    // The deploy gate blocks a KEV at any severity; the overview must agree.
    db().replaceKev([{ cve_id: 'CVE-2024-5002', date_added: '2024-01-01' }], now);

    const res = await request(app).get('/api/security/overview').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ knownExploited: 1, posture: 'Action needed' });
  });

  it('excludes a suppressed (accepted) KEV from knownExploited', async () => {
    const now = Date.now();
    const scanId = db().createVulnerabilityScan({
      node_id: 1, image_ref: 'suppkev:1', image_digest: 'sha256:suppkev', scanned_at: now,
      total_vulnerabilities: 2, critical_count: 0, high_count: 0, medium_count: 2, low_count: 0,
      unknown_count: 0, fixable_count: 0, secret_count: 0, misconfig_count: 0, scanners_used: 'vuln',
      highest_severity: 'MEDIUM', os_info: null, trivy_version: null, scan_duration_ms: null,
      triggered_by: 'manual', status: 'completed', error: null, stack_context: null,
    });
    db().insertVulnerabilityDetails(scanId, [
      { vulnerability_id: 'CVE-2024-KEVA', pkg_name: 'a', installed_version: '1', fixed_version: null, severity: 'MEDIUM', title: null, description: null, primary_url: null },
      { vulnerability_id: 'CVE-2024-KEVB', pkg_name: 'b', installed_version: '1', fixed_version: null, severity: 'MEDIUM', title: null, description: null, primary_url: null },
    ]);
    db().replaceKev([{ cve_id: 'CVE-2024-KEVA', date_added: '2024-01-01' }, { cve_id: 'CVE-2024-KEVB', date_added: '2024-01-01' }], now);
    // KEVA is accepted (dismissed); only the live KEVB remains actionable.
    db().createCveSuppression({ cve_id: 'CVE-2024-KEVA', pkg_name: null, image_pattern: null, reason: 'accepted', created_by: 'admin', created_at: now, expires_at: null, replicated_from_control: 0, status: 'accepted' });

    const res = await request(app).get('/api/security/overview').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.knownExploited).toBe(1);
  });

  it('reads Secure when a scan completed with nothing actionable or severe', async () => {
    db().createVulnerabilityScan({
      node_id: 1, image_ref: 'clean:1', image_digest: 'sha256:clean', scanned_at: Date.now(),
      total_vulnerabilities: 0, critical_count: 0, high_count: 0, medium_count: 0, low_count: 0,
      unknown_count: 0, fixable_count: 0, secret_count: 0, misconfig_count: 0, scanners_used: 'vuln',
      highest_severity: null, os_info: null, trivy_version: null, scan_duration_ms: null,
      triggered_by: 'manual', status: 'completed', error: null, stack_context: null,
    });
    const res = await request(app).get('/api/security/overview').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.posture).toBe('Secure');
  });

  it('is reachable by a Community viewer (read-only, auth-only)', async () => {
    const res = await request(app).get('/api/security/overview').set('Cookie', viewerCookie);
    expect(res.status).toBe(200);
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/security/overview');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/security/overview/trend', () => {
  beforeEach(() => resetSecurity());

  const dayStart = (daysAgo: number): number => {
    const d = new Date(Date.now() - daysAgo * DAY);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  };

  it('returns ascending daily critical/high points, node-scoped and completed only', async () => {
    const d1 = dayStart(3);
    const d2 = dayStart(2);
    seedScan({ image_ref: 'a:1', scanned_at: d1 + 3_600_000, critical: 4, high: 2 });
    seedScan({ image_ref: 'a:1', scanned_at: d2 + 3_600_000, critical: 1, high: 5 });
    seedScan({ node_id: 2, image_ref: 'x:1', scanned_at: d2 + 3_600_000, critical: 9, high: 9 }); // other node
    seedScan({ image_ref: 'f:1', scanned_at: d2 + 3_600_000, critical: 7, high: 7, status: 'failed' }); // failed

    const res = await request(app).get('/api/security/overview/trend').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ critical: 4, high: 2 });
    expect(res.body[1]).toMatchObject({ critical: 1, high: 5 });
    expect(res.body[0].date < res.body[1].date).toBe(true);
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/security/overview/trend');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/security/policy-packs', () => {
  it('returns the 5 default packs with fully-formed rules (auth-only)', async () => {
    const res = await request(app).get('/api/security/policy-packs').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(5);
    for (const pack of res.body) {
      expect(pack).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        tagline: expect.any(String),
        tierCopy: expect.any(String),
      });
      expect(Array.isArray(pack.rules)).toBe(true);
      expect(pack.rules.length).toBeGreaterThan(0);
      for (const rule of pack.rules) {
        expect(rule).toMatchObject({
          id: expect.any(String),
          name: expect.any(String),
          severity: expect.stringMatching(/^(CRITICAL|HIGH|MEDIUM|LOW)$/),
          whatItChecks: expect.any(String),
          why: expect.any(String),
          howToFix: expect.any(String),
          enforcement: expect.stringMatching(/^(warning|enforceable)$/),
        });
      }
    }
  });

  it('returns 401 unauthenticated', async () => {
    const res = await request(app).get('/api/security/policy-packs');
    expect(res.status).toBe(401);
  });

  it('returns an identical catalog regardless of tier', async () => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    const community = await request(app).get('/api/security/policy-packs').set('Cookie', adminCookie);
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    const paid = await request(app).get('/api/security/policy-packs').set('Cookie', adminCookie);
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    expect(paid.body).toEqual(community.body);
  });
});

describe('GET /api/security/scans/:scanId/vulnerabilities', () => {
  beforeEach(() => resetSecurity());

  it('attaches read-time exploit intel (KEV/EPSS) to each finding', async () => {
    const now = Date.now();
    const scanId = db().createVulnerabilityScan({
      node_id: 1, image_ref: 'vex:1', image_digest: 'sha256:vex', scanned_at: now,
      total_vulnerabilities: 1, critical_count: 1, high_count: 0, medium_count: 0, low_count: 0,
      unknown_count: 0, fixable_count: 0, secret_count: 0, misconfig_count: 0, scanners_used: 'vuln',
      highest_severity: 'CRITICAL', os_info: null, trivy_version: null, scan_duration_ms: null,
      triggered_by: 'manual', status: 'completed', error: null, stack_context: null,
    });
    db().insertVulnerabilityDetails(scanId, [{
      vulnerability_id: 'CVE-2024-7777', pkg_name: 'p', installed_version: '1', fixed_version: null,
      severity: 'CRITICAL', title: null, description: null, primary_url: null,
    }]);
    db().replaceKev([{ cve_id: 'CVE-2024-7777', date_added: '2024-02-02' }], now);
    db().upsertEpss([{ cve_id: 'CVE-2024-7777', epss_score: 0.42, epss_percentile: 0.95 }], now);

    const res = await request(app).get(`/api/security/scans/${scanId}/vulnerabilities`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    const item = (res.body.items as Array<{ vulnerability_id: string; kev: boolean; epss_score: number }>)
      .find((i) => i.vulnerability_id === 'CVE-2024-7777');
    expect(item).toMatchObject({ kev: true, epss_score: 0.42, epss_percentile: 0.95 });
  });
});

describe('GET /api/security/vex/export (Admiral)', () => {
  beforeEach(() => {
    resetSecurity();
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
  });
  afterAll(() => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
  });

  it('is gated to Admiral: 403 for Community', async () => {
    const res = await request(app).get('/api/security/vex/export').set('Cookie', adminCookie);
    expect(res.status).toBe(403);
  });

  it('exports an OpenVEX document from triage decisions for Admiral', async () => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    db().createCveSuppression({
      cve_id: 'CVE-2024-2222', pkg_name: null, image_pattern: 'nginx*', reason: 'not present in build',
      created_by: 'admin', created_at: Date.now(), expires_at: null, replicated_from_control: 0,
      status: 'not_affected', justification: 'component_not_present',
    });
    const res = await request(app).get('/api/security/vex/export').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body['@context']).toContain('openvex');
    const stmt = (res.body.statements as Array<{ vulnerability: { name: string }; status: string; justification?: string; products: string[] }>)
      .find((s) => s.vulnerability.name === 'CVE-2024-2222');
    expect(stmt).toMatchObject({ status: 'not_affected', justification: 'component_not_present', products: ['nginx*'] });
  });
});

describe('GET /api/security/overview/exploit-intel', () => {
  beforeEach(() => resetSecurity());

  it('returns actionable Crit/High findings with KEV/EPSS joined and dismissed excluded', async () => {
    const now = Date.now();
    const scanId = db().createVulnerabilityScan({
      node_id: 1, image_ref: 'app:1', image_digest: 'sha256:app', scanned_at: now,
      total_vulnerabilities: 3, critical_count: 2, high_count: 1, medium_count: 0, low_count: 0,
      unknown_count: 0, fixable_count: 2, secret_count: 0, misconfig_count: 0, scanners_used: 'vuln',
      highest_severity: 'CRITICAL', os_info: null, trivy_version: null, scan_duration_ms: null,
      triggered_by: 'manual', status: 'completed', error: null, stack_context: null,
    });
    const d = (id: string, severity: 'CRITICAL' | 'HIGH', cvss: number | null, fixed: string | null) => ({
      vulnerability_id: id, pkg_name: `p-${id}`, installed_version: '1', fixed_version: fixed,
      severity, title: null, description: null, primary_url: null, cvss_score: cvss,
    });
    db().insertVulnerabilityDetails(scanId, [
      d('CVE-2024-AAAA', 'CRITICAL', 9.8, '2'),   // actionable, has KEV + EPSS
      d('CVE-2024-BBBB', 'HIGH', 7.2, null),       // actionable, no intel yet
      d('CVE-2024-CCCC', 'CRITICAL', 8.1, '3'),    // dismissed -> excluded
    ]);
    db().replaceKev([{ cve_id: 'CVE-2024-AAAA', date_added: '2024-01-01' }], now);
    db().upsertEpss([{ cve_id: 'CVE-2024-AAAA', epss_score: 0.6, epss_percentile: 0.97 }], now);
    db().createCveSuppression({
      cve_id: 'CVE-2024-CCCC', pkg_name: null, image_pattern: null, reason: 'accepted',
      created_by: 'admin', created_at: now, expires_at: null, replicated_from_control: 0, status: 'accepted',
    });

    const res = await request(app).get('/api/security/overview/exploit-intel').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ vulnerability_id: string; cvss_score: number | null; epss_score: number | null; kev: boolean; severity: string; scan_id: number }>;
    const ids = items.map((i) => i.vulnerability_id);
    expect(ids).toContain('CVE-2024-AAAA');
    expect(ids).toContain('CVE-2024-BBBB');
    expect(ids).not.toContain('CVE-2024-CCCC'); // dismissed triage decision
    expect(items.find((i) => i.vulnerability_id === 'CVE-2024-AAAA')).toMatchObject({ cvss_score: 9.8, epss_score: 0.6, kev: true, severity: 'CRITICAL', scan_id: scanId });
    expect(items.find((i) => i.vulnerability_id === 'CVE-2024-BBBB')).toMatchObject({ cvss_score: 7.2, epss_score: null, kev: false });
    expect(res.body.truncated).toBe(false);
  });

  it('includes a Medium/Low known-exploited finding alongside Critical/High', async () => {
    const now = Date.now();
    const scanId = db().createVulnerabilityScan({
      node_id: 1, image_ref: 'mix:1', image_digest: 'sha256:mix', scanned_at: now,
      total_vulnerabilities: 2, critical_count: 0, high_count: 0, medium_count: 1, low_count: 1,
      unknown_count: 0, fixable_count: 0, secret_count: 0, misconfig_count: 0, scanners_used: 'vuln',
      highest_severity: 'MEDIUM', os_info: null, trivy_version: null, scan_duration_ms: null,
      triggered_by: 'manual', status: 'completed', error: null, stack_context: null,
    });
    db().insertVulnerabilityDetails(scanId, [
      { vulnerability_id: 'CVE-2024-MEDK', pkg_name: 'm', installed_version: '1', fixed_version: null, severity: 'MEDIUM', title: null, description: null, primary_url: null, cvss_score: 5.5 },
      { vulnerability_id: 'CVE-2024-LOWN', pkg_name: 'l', installed_version: '1', fixed_version: null, severity: 'LOW', title: null, description: null, primary_url: null, cvss_score: 3.1 },
    ]);
    // Only the Medium finding is known-exploited; the Low non-KEV stays out.
    db().replaceKev([{ cve_id: 'CVE-2024-MEDK', date_added: '2024-01-01' }], now);

    const res = await request(app).get('/api/security/overview/exploit-intel').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    const ids = (res.body.items as Array<{ vulnerability_id: string }>).map((i) => i.vulnerability_id);
    expect(ids).toContain('CVE-2024-MEDK');
    expect(ids).not.toContain('CVE-2024-LOWN');
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/security/overview/exploit-intel');
    expect(res.status).toBe(401);
  });
});
