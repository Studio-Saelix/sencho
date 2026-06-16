/**
 * getLatestVulnScanByDigestForNode: the node-scoped, vulnerability-bearing
 * latest-scan lookup that powers the pre-deploy advisory. It must (a) only ever
 * return a scan for the requested node, and (b) only consider scanner sets that
 * actually ran the vulnerability scanner, so a secret-only or config scan is
 * never mistaken for a clean vuln scan.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import type { DatabaseService as DatabaseServiceType, VulnerabilityScan } from '../services/DatabaseService';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

function insertScan(
  db: DatabaseServiceType,
  over: Partial<Omit<VulnerabilityScan, 'id'>>,
): number {
  return db.createVulnerabilityScan({
    node_id: 1,
    image_ref: 'img',
    image_digest: 'sha256:default',
    scanned_at: 1000,
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
    ...over,
  });
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => cleanupTestDb(tmpDir));

describe('getLatestVulnScanByDigestForNode', () => {
  it('includes vuln and vuln,secret rows but excludes secret-only and config scans', () => {
    const db = DatabaseService.getInstance();
    const digest = 'sha256:setfilter';
    // Newer rows that did NOT run the vuln scanner must be ignored even though
    // they are more recent than the vuln-bearing rows.
    insertScan(db, { image_digest: digest, scanners_used: 'secret', scanned_at: 5000, critical_count: 99 });
    insertScan(db, { image_digest: digest, scanners_used: 'config', scanned_at: 4000, critical_count: 88 });
    insertScan(db, { image_digest: digest, scanners_used: 'vuln', scanned_at: 1000, critical_count: 1 });
    insertScan(db, { image_digest: digest, scanners_used: 'vuln,secret', scanned_at: 2000, critical_count: 2 });

    const found = db.getLatestVulnScanByDigestForNode(digest, 1);
    expect(found).not.toBeNull();
    expect(found?.scanners_used).toBe('vuln,secret');
    expect(found?.critical_count).toBe(2);
  });

  it('is node-scoped: a scan from another node is not returned', () => {
    const db = DatabaseService.getInstance();
    const digest = 'sha256:nodescope';
    insertScan(db, { node_id: 2, image_digest: digest, scanners_used: 'vuln', scanned_at: 9000, critical_count: 7 });

    expect(db.getLatestVulnScanByDigestForNode(digest, 1)).toBeNull();
    expect(db.getLatestVulnScanByDigestForNode(digest, 2)?.critical_count).toBe(7);
  });

  it('ignores non-completed scans', () => {
    const db = DatabaseService.getInstance();
    const digest = 'sha256:status';
    insertScan(db, { image_digest: digest, scanners_used: 'vuln', status: 'in_progress', scanned_at: 8000 });
    expect(db.getLatestVulnScanByDigestForNode(digest, 1)).toBeNull();
  });

  it('returns null for an empty digest', () => {
    expect(DatabaseService.getInstance().getLatestVulnScanByDigestForNode('', 1)).toBeNull();
  });
});
