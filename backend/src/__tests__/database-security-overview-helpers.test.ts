/**
 * Unit coverage for the two DatabaseService helpers added for the Security
 * overview:
 *   - countScansByStatus: an UNCAPPED count (getVulnerabilityScans applies a
 *     per-image history cap that would undercount failed scans).
 *   - countEligibleBlockPolicies: counts enabled block-on-deploy policies that
 *     apply to a node (fleet-wide or this node), built on getScanPoliciesForUi
 *     so a replica never counts a sibling-identity policy.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import type { ScanPolicy } from '../services/DatabaseService';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => cleanupTestDb(tmpDir));

function db() {
  return DatabaseService.getInstance();
}

function reset(): void {
  const raw = (db() as unknown as { db: { prepare: (s: string) => { run: () => void } } }).db;
  raw.prepare('DELETE FROM vulnerability_scans').run();
  raw.prepare('DELETE FROM scan_policies').run();
}

function seedFailed(imageRef: string): void {
  db().createVulnerabilityScan({
    node_id: 1,
    image_ref: imageRef,
    image_digest: `sha256:${imageRef}-${Math.random().toString(16).slice(2)}`,
    scanned_at: 1,
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
    status: 'failed',
    error: 'boom',
    stack_context: null,
  });
}

/** Midnight (UTC) `daysAgo` days back, so seeded times stay within one calendar day. */
function dayStartMs(daysAgo: number): number {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function seedCompleted(o: { imageRef: string; scannedAt: number; critical: number; high: number; nodeId?: number; status?: 'completed' | 'failed' }): void {
  db().createVulnerabilityScan({
    node_id: o.nodeId ?? 1,
    image_ref: o.imageRef,
    image_digest: `sha256:${o.imageRef}-${Math.random().toString(16).slice(2)}`,
    scanned_at: o.scannedAt,
    total_vulnerabilities: o.critical + o.high,
    critical_count: o.critical,
    high_count: o.high,
    medium_count: 0,
    low_count: 0,
    unknown_count: 0,
    fixable_count: 0,
    secret_count: 0,
    misconfig_count: 0,
    scanners_used: 'vuln',
    highest_severity: o.critical > 0 ? 'CRITICAL' : o.high > 0 ? 'HIGH' : null,
    os_info: null,
    trivy_version: null,
    scan_duration_ms: null,
    triggered_by: 'manual',
    status: o.status ?? 'completed',
    error: o.status === 'failed' ? 'boom' : null,
    stack_context: null,
  });
}

function seedPolicy(overrides: Partial<Omit<ScanPolicy, 'id' | 'created_at' | 'updated_at'>>): void {
  db().createScanPolicy({
    name: overrides.name ?? 'p',
    node_id: overrides.node_id ?? null,
    node_identity: overrides.node_identity ?? '',
    stack_pattern: overrides.stack_pattern ?? null,
    max_severity: overrides.max_severity ?? 'CRITICAL',
    block_on_deploy: overrides.block_on_deploy ?? 1,
    enabled: overrides.enabled ?? 1,
    block_on_severity: overrides.block_on_severity ?? 1,
    block_on_kev: overrides.block_on_kev ?? 0,
    block_on_fixable: overrides.block_on_fixable ?? 0,
    replicated_from_control: overrides.replicated_from_control ?? 0,
  });
}

beforeEach(() => reset());

describe('countScansByStatus', () => {
  it('counts failed scans uncapped, even beyond the per-image history cap', () => {
    // The grouped history view caps rows per image_ref (default 50). All 55 of
    // these are the same image, so a capped path would undercount.
    for (let i = 0; i < 55; i++) seedFailed('same-image:1');
    expect(db().countScansByStatus(1, 'failed')).toBe(55);
  });

  it('is node-scoped', () => {
    seedFailed('a:1');
    db().createVulnerabilityScan({
      node_id: 2, image_ref: 'b:1', image_digest: 'sha256:b', scanned_at: 1,
      total_vulnerabilities: 0, critical_count: 0, high_count: 0, medium_count: 0, low_count: 0,
      unknown_count: 0, fixable_count: 0, secret_count: 0, misconfig_count: 0, scanners_used: 'vuln',
      highest_severity: null, os_info: null, trivy_version: null, scan_duration_ms: null,
      triggered_by: 'manual', status: 'failed', error: 'x', stack_context: null,
    });
    expect(db().countScansByStatus(1, 'failed')).toBe(1);
  });
});

describe('countEligibleBlockPolicies (control)', () => {
  it('counts fleet-wide and this-node block policies, excludes other nodes / disabled / non-blocking', () => {
    seedPolicy({ name: 'fleet-wide', node_id: null });            // counted
    seedPolicy({ name: 'this-node', node_id: 1 });                // counted
    seedPolicy({ name: 'other-node', node_id: 2 });               // excluded (different node)
    seedPolicy({ name: 'disabled', node_id: 1, enabled: 0 });     // excluded (disabled)
    seedPolicy({ name: 'no-block', node_id: 1, block_on_deploy: 0 }); // excluded (not blocking)

    expect(db().countEligibleBlockPolicies(1, 'control', '')).toBe(2);
  });
});

describe('countEligibleBlockPolicies (replica)', () => {
  it('filters a replicated policy scoped to a sibling identity, keeps fleet-wide', () => {
    // Fleet-wide replicated row (empty identity) applies on every replica.
    seedPolicy({ name: 'fleet-wide', node_id: null, replicated_from_control: 1, node_identity: '' });
    // Sibling-scoped replicated row must not be counted on this replica.
    seedPolicy({ name: 'sibling', node_id: null, replicated_from_control: 1, node_identity: 'sibling-id' });

    expect(db().countEligibleBlockPolicies(1, 'replica', 'self-id')).toBe(1);
  });
});

describe('getImageScanSummaries', () => {
  function seedScan(o: { imageRef: string; scannersUsed: string; scannedAt: number; critical?: number; high?: number; secret?: number; misconfig?: number }): number {
    return db().createVulnerabilityScan({
      node_id: 1,
      image_ref: o.imageRef,
      image_digest: `sha256:${o.imageRef}-${Math.random().toString(16).slice(2)}`,
      scanned_at: o.scannedAt,
      total_vulnerabilities: (o.critical ?? 0) + (o.high ?? 0),
      critical_count: o.critical ?? 0,
      high_count: o.high ?? 0,
      medium_count: 0,
      low_count: 0,
      unknown_count: 0,
      fixable_count: 0,
      secret_count: o.secret ?? 0,
      misconfig_count: o.misconfig ?? 0,
      scanners_used: o.scannersUsed,
      highest_severity: (o.critical ?? 0) > 0 ? 'CRITICAL' : (o.high ?? 0) > 0 ? 'HIGH' : null,
      os_info: null,
      trivy_version: null,
      scan_duration_ms: null,
      triggered_by: 'manual',
      status: 'completed',
      error: null,
      stack_context: o.imageRef.startsWith('stack:') ? o.imageRef.slice(6) : null,
    });
  }

  it('sources vuln counts and scan_id from the latest vuln scan, keeping a newer secret-only scan\'s secrets', () => {
    const vulnScan = seedScan({ imageRef: 'app:1', scannersUsed: 'vuln', scannedAt: 1000, critical: 2, high: 1 });
    // A newer secret-only node scan must not erase the vulnerability posture, and
    // the badge's scan_id must open the scan its counts came from (the vuln scan).
    seedScan({ imageRef: 'app:1', scannersUsed: 'secret', scannedAt: 2000, secret: 5 });

    const summary = db().getImageScanSummaries(1)['app:1'];
    expect(summary.critical).toBe(2);
    expect(summary.high).toBe(1);
    expect(summary.secret_count).toBe(5);
    expect(summary.scan_id).toBe(vulnScan);
  });

  it('keeps a compose/config scan row with its misconfig count and zero vuln counts', () => {
    const configScan = seedScan({ imageRef: 'stack:web', scannersUsed: 'config', scannedAt: 1000, misconfig: 3 });
    const summary = db().getImageScanSummaries(1)['stack:web'];
    expect(summary.critical).toBe(0);
    expect(summary.misconfig_count).toBe(3);
    expect(summary.scan_id).toBe(configScan);
  });

  it('treats a combined vuln,secret scan as vulnerability-bearing', () => {
    const scan = seedScan({ imageRef: 'both:1', scannersUsed: 'vuln,secret', scannedAt: 1000, critical: 1, secret: 2 });
    const summary = db().getImageScanSummaries(1)['both:1'];
    expect(summary.critical).toBe(1);
    expect(summary.secret_count).toBe(2);
    expect(summary.scan_id).toBe(scan);
  });

  it('reports zero vuln counts but keeps secrets for an image only ever scanned for secrets', () => {
    const secretScan = seedScan({ imageRef: 'sec:1', scannersUsed: 'secret', scannedAt: 1000, secret: 4 });
    const summary = db().getImageScanSummaries(1)['sec:1'];
    expect(summary.critical).toBe(0);
    expect(summary.high).toBe(0);
    expect(summary.secret_count).toBe(4);
    // No vuln-bearing scan exists, so scan_id falls back to the latest scan overall.
    expect(summary.scan_id).toBe(secretScan);
  });
});

describe('getLatestKevFindingsForNode', () => {
  function rawDb() {
    return (db() as unknown as { db: { prepare: (s: string) => { run: () => void } } }).db;
  }
  beforeEach(() => {
    rawDb().prepare('DELETE FROM vulnerability_details').run();
    rawDb().prepare('DELETE FROM cve_intel').run();
    rawDb().prepare('DELETE FROM vulnerability_scans').run();
  });

  function seedVulnScan(o: { imageRef: string; scannersUsed: string; scannedAt: number; nodeId?: number }): number {
    return db().createVulnerabilityScan({
      node_id: o.nodeId ?? 1, image_ref: o.imageRef, image_digest: `sha256:${o.imageRef}-${Math.random().toString(16).slice(2)}`,
      scanned_at: o.scannedAt, total_vulnerabilities: 0, critical_count: 0, high_count: 0, medium_count: 0,
      low_count: 0, unknown_count: 0, fixable_count: 0, secret_count: 0, misconfig_count: 0,
      scanners_used: o.scannersUsed, highest_severity: null, os_info: null, trivy_version: null,
      scan_duration_ms: null, triggered_by: 'manual', status: 'completed', error: null, stack_context: null,
    });
  }
  const detail = (id: string, severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW') => ({
    vulnerability_id: id, pkg_name: `p-${id}`, installed_version: '1', fixed_version: null,
    severity, title: null, description: null, primary_url: null,
  });

  it('returns KEV findings at any severity from the latest vuln scan, restricted to vuln-bearing scanners', () => {
    const now = Date.now();
    const vulnScan = seedVulnScan({ imageRef: 'app:1', scannersUsed: 'vuln', scannedAt: now - 1000 });
    db().insertVulnerabilityDetails(vulnScan, [detail('CVE-LOW-KEV', 'LOW'), detail('CVE-CRIT-PLAIN', 'CRITICAL')]);
    // A newer secret-only scan also carries a KEV detail; it must be ignored.
    const secretScan = seedVulnScan({ imageRef: 'app:1', scannersUsed: 'secret', scannedAt: now });
    db().insertVulnerabilityDetails(secretScan, [detail('CVE-SECRET-KEV', 'HIGH')]);
    db().replaceKev([
      { cve_id: 'CVE-LOW-KEV', date_added: '2024-01-01' },
      { cve_id: 'CVE-SECRET-KEV', date_added: '2024-01-01' },
    ], now);

    const ids = db().getLatestKevFindingsForNode(1).items.map((i) => i.vulnerability_id);
    expect(ids).toContain('CVE-LOW-KEV');     // any-severity KEV from the vuln scan
    expect(ids).not.toContain('CVE-CRIT-PLAIN'); // Critical but not KEV
    expect(ids).not.toContain('CVE-SECRET-KEV'); // KEV but on a secret-only scan
  });

  it('flags truncated when the row cap is hit', () => {
    const now = Date.now();
    const scan = seedVulnScan({ imageRef: 'many:1', scannersUsed: 'vuln', scannedAt: now });
    db().insertVulnerabilityDetails(scan, [detail('CVE-K1', 'HIGH'), detail('CVE-K2', 'HIGH'), detail('CVE-K3', 'HIGH')]);
    db().replaceKev([{ cve_id: 'CVE-K1', date_added: null }, { cve_id: 'CVE-K2', date_added: null }, { cve_id: 'CVE-K3', date_added: null }], now);
    const res = db().getLatestKevFindingsForNode(1, 2);
    expect(res.truncated).toBe(true);
    expect(res.items).toHaveLength(2);
  });

  it('is node-scoped', () => {
    const now = Date.now();
    const scan = seedVulnScan({ imageRef: 'other:1', scannersUsed: 'vuln', scannedAt: now, nodeId: 2 });
    db().insertVulnerabilityDetails(scan, [detail('CVE-OTHER', 'CRITICAL')]);
    db().replaceKev([{ cve_id: 'CVE-OTHER', date_added: null }], now);
    expect(db().getLatestKevFindingsForNode(1).items).toHaveLength(0);
    expect(db().getLatestKevFindingsForNode(2).items).toHaveLength(1);
  });
});

describe('getDailyRiskTrend', () => {
  it('sums latest-per-image critical/high per day and orders days ascending', () => {
    const day1 = dayStartMs(3);
    const day2 = dayStartMs(2);
    // Day 1: imageA scanned twice; the later scan replaces the earlier one.
    seedCompleted({ imageRef: 'a:1', scannedAt: day1 + 3_600_000, critical: 5, high: 2 });
    seedCompleted({ imageRef: 'a:1', scannedAt: day1 + 7_200_000, critical: 3, high: 1 });
    seedCompleted({ imageRef: 'b:1', scannedAt: day1 + 3_600_000, critical: 1, high: 1 });
    // Day 2: a single image.
    seedCompleted({ imageRef: 'a:1', scannedAt: day2 + 3_600_000, critical: 0, high: 4 });

    const trend = db().getDailyRiskTrend(1, 30);
    expect(trend).toHaveLength(2);
    expect(trend[0]).toMatchObject({ critical: 4, high: 2 }); // latest a (3,1) + b (1,1)
    expect(trend[1]).toMatchObject({ critical: 0, high: 4 });
    expect(trend[0].date < trend[1].date).toBe(true);
  });

  it('excludes other nodes and non-completed scans', () => {
    const day = dayStartMs(1);
    seedCompleted({ imageRef: 'a:1', scannedAt: day + 3_600_000, critical: 2, high: 1 });
    seedCompleted({ imageRef: 'other:1', scannedAt: day + 3_600_000, critical: 9, high: 9, nodeId: 2 });
    seedCompleted({ imageRef: 'failed:1', scannedAt: day + 3_600_000, critical: 7, high: 7, status: 'failed' });

    const trend = db().getDailyRiskTrend(1, 30);
    expect(trend).toHaveLength(1);
    expect(trend[0]).toMatchObject({ critical: 2, high: 1 });
  });
});
