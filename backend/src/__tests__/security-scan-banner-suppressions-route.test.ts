/**
 * GET /api/security/scans/:scanId banner consistency with the deploy gate.
 *
 * The verdict stored on a scan at scan time is a one-time snapshot. Once the
 * deploy gate is set to honor suppressions, the gate re-reads current
 * suppressions on every deploy while the stored verdict does not, so creating,
 * deleting, or expiring a suppression used to leave the scan-detail banner
 * disagreeing with what the gate would actually do. The detail route now
 * recomputes the banner verdict against current suppressions; these tests pin
 * that the banner tracks the gate across the suppression lifecycle, and that the
 * stored snapshot is still used verbatim when honor-suppressions is off.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import type { VulnerabilityScan } from '../services/DatabaseService';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let parsePolicyEvaluation: typeof import('../services/DatabaseService').parsePolicyEvaluation;
let FleetSyncService: typeof import('../services/FleetSyncService').FleetSyncService;
let adminCookie: string;

const KEV_CVE = 'CVE-2026-8000';

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService, parsePolicyEvaluation } = await import('../services/DatabaseService'));
  ({ FleetSyncService } = await import('../services/FleetSyncService'));

  const { LicenseService } = await import('../services/LicenseService');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');

  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
});

afterAll(() => cleanupTestDb(tmpDir));

/**
 * Seed a node-1 scan of a KEV finding under a block-on-KEV policy, then store
 * the verdict computed with no suppressions in place (violated). This mirrors
 * finishScan persisting a snapshot at scan time.
 */
function seedViolatingScan(): number {
  const db = DatabaseService.getInstance();
  db.createScanPolicy({
    name: 'kev', node_id: null, node_identity: '', stack_pattern: 'web',
    max_severity: 'HIGH', block_on_deploy: 1, enabled: 1,
    block_on_severity: 0, block_on_kev: 1, block_on_fixable: 0, replicated_from_control: 0,
  });
  db.replaceKev([{ cve_id: KEV_CVE, date_added: '2026-01-01' }], Date.now());
  const scanId = db.createVulnerabilityScan({
    node_id: 1, image_ref: 'nginx:1.14', image_digest: null, scanned_at: Date.now(),
    total_vulnerabilities: 1, critical_count: 1, high_count: 0, medium_count: 0, low_count: 0,
    unknown_count: 0, fixable_count: 0, secret_count: 0, misconfig_count: 0, scanners_used: 'vuln',
    highest_severity: 'CRITICAL', os_info: null, trivy_version: '0.50.0', scan_duration_ms: null,
    triggered_by: 'manual', status: 'completed', error: null, stack_context: 'web',
  });
  db.insertVulnerabilityDetails(scanId, [{
    vulnerability_id: KEV_CVE, pkg_name: 'openssl', installed_version: '1.0', fixed_version: null,
    severity: 'CRITICAL', title: null, description: null, primary_url: null,
  }]);
  const scan = db.getVulnerabilityScan(scanId) as VulnerabilityScan;
  db.setScanPolicyEvaluation(scanId, db.evaluateScanAgainstPolicies(1, scan, FleetSyncService.getSelfIdentity()));
  return scanId;
}

function suppress(expiresAt: number | null): number {
  return DatabaseService.getInstance().createCveSuppression({
    cve_id: KEV_CVE, pkg_name: null, image_pattern: null, reason: 'accepted', created_by: 'admin',
    created_at: Date.now(), expires_at: expiresAt, replicated_from_control: 0, status: 'accepted',
  }).id;
}

async function bannerViolated(scanId: number): Promise<boolean | undefined> {
  const res = await request(app).get(`/api/security/scans/${scanId}`).set('Cookie', adminCookie);
  expect(res.status).toBe(200);
  return res.body.policy_evaluation?.violated;
}

beforeEach(() => {
  const db = DatabaseService.getInstance();
  db.getScanPolicies().forEach((p) => db.deleteScanPolicy(p.id));
  db.getDb().prepare('DELETE FROM cve_suppressions').run();
  db.getDb().prepare('DELETE FROM vulnerability_scans').run();
  db.updateGlobalSetting('deploy_block_honor_suppressions', '1');
});

describe('GET /api/security/scans/:scanId banner vs deploy gate', () => {
  it('shows the stored violation when honor-suppressions is on and nothing is suppressed', async () => {
    const scanId = seedViolatingScan();
    expect(await bannerViolated(scanId)).toBe(true);
  });

  it('clears the banner after a matching suppression is created (the gate would now pass)', async () => {
    const scanId = seedViolatingScan();
    suppress(null);
    expect(await bannerViolated(scanId)).toBe(false);
    // The stored snapshot is untouched: the banner is recomputed at read time.
    const stored = parsePolicyEvaluation(
      DatabaseService.getInstance().getVulnerabilityScan(scanId)?.policy_evaluation,
    );
    expect(stored?.violated).toBe(true);
  });

  it('restores the banner after the suppression is deleted (the gate would block again)', async () => {
    const scanId = seedViolatingScan();
    const id = suppress(null);
    expect(await bannerViolated(scanId)).toBe(false);
    DatabaseService.getInstance().deleteCveSuppression(id);
    expect(await bannerViolated(scanId)).toBe(true);
  });

  it('restores the banner after a suppression is edited to no longer match the finding', async () => {
    const scanId = seedViolatingScan();
    const id = suppress(null);
    expect(await bannerViolated(scanId)).toBe(false);
    // Narrow the suppression onto a different image so it stops covering this scan.
    DatabaseService.getInstance().updateCveSuppression(id, { image_pattern: 'other:*' });
    expect(await bannerViolated(scanId)).toBe(true);
  });

  it('ignores an expired suppression so the banner matches the gate', async () => {
    const scanId = seedViolatingScan();
    suppress(Date.now() - 1000); // already expired
    expect(await bannerViolated(scanId)).toBe(true);
  });

  it('clears a stale violation when no policy matches at read time (e.g. the policy was disabled)', async () => {
    const scanId = seedViolatingScan();
    // Disable the policy after the snapshot was stored: getMatchingPolicy no longer
    // returns it, so the recompute yields no verdict and the banner must clear.
    const db = DatabaseService.getInstance();
    db.getScanPolicies().forEach((p) => db.updateScanPolicy(p.id, { enabled: 0 }));
    expect(await bannerViolated(scanId)).toBeFalsy();
  });

  it('falls back to the stored snapshot (HTTP 200) when the recompute throws', async () => {
    const scanId = seedViolatingScan();
    suppress(null); // recompute would clear it, but the recompute is made to throw
    const spy = vi
      .spyOn(DatabaseService.getInstance(), 'evaluateScanAgainstPolicies')
      .mockImplementationOnce(() => { throw new Error('boom'); });
    try {
      expect(await bannerViolated(scanId)).toBe(true); // stored snapshot, not a 500
    } finally {
      spy.mockRestore();
    }
  });

  it('uses the stored snapshot verbatim when honor-suppressions is off', async () => {
    const scanId = seedViolatingScan();
    suppress(null);
    DatabaseService.getInstance().updateGlobalSetting('deploy_block_honor_suppressions', '0');
    // Setting off: the gate ignores suppressions too, so the raw stored verdict stands.
    expect(await bannerViolated(scanId)).toBe(true);
  });
});
