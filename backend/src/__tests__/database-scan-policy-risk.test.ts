/**
 * Risk-input persistence and the informational post-scan evaluation:
 * createScanPolicy/updateScanPolicy round-trip the three flags, a raw legacy
 * insert migrates to severity-only defaults, and evaluateScanAgainstPolicies
 * keys the banner on the same KEV/fixable/severity inputs as enforcement.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import type { VulnerabilityScan, VulnerabilityDetail } from '../services/DatabaseService';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let parsePolicyEvaluation: typeof import('../services/DatabaseService').parsePolicyEvaluation;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService, parsePolicyEvaluation } = await import('../services/DatabaseService'));
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  const db = DatabaseService.getInstance();
  db.getScanPolicies().forEach((p) => db.deleteScanPolicy(p.id));
});

const basePolicy = {
  name: 'p',
  node_id: null,
  node_identity: '',
  stack_pattern: null,
  max_severity: 'HIGH' as const,
  block_on_deploy: 1,
  enabled: 1,
  block_on_severity: 1,
  block_on_kev: 0,
  block_on_fixable: 0,
  replicated_from_control: 0,
};

const detail = (over: Partial<VulnerabilityDetail>): Omit<VulnerabilityDetail, 'id' | 'scan_id'> => ({
  vulnerability_id: 'CVE-2026-0001',
  pkg_name: 'openssl',
  installed_version: '1.0',
  fixed_version: null,
  severity: 'HIGH',
  title: null,
  description: null,
  primary_url: null,
  ...over,
});

function seedScan(stackContext: string, highest: VulnerabilityScan['highest_severity'], details: Array<Omit<VulnerabilityDetail, 'id' | 'scan_id'>>): VulnerabilityScan {
  const db = DatabaseService.getInstance();
  const id = db.createVulnerabilityScan({
    node_id: 1, image_ref: 'nginx:1.14', image_digest: null, scanned_at: Date.now(),
    total_vulnerabilities: details.length, critical_count: 0, high_count: 0, medium_count: 0,
    low_count: 0, unknown_count: 0, fixable_count: 0, secret_count: 0, misconfig_count: 0,
    scanners_used: 'vuln', highest_severity: highest, os_info: null, trivy_version: '0.50.0',
    scan_duration_ms: null, triggered_by: 'manual', status: 'completed', error: null,
    stack_context: stackContext,
  });
  db.insertVulnerabilityDetails(id, details);
  return db.getVulnerabilityScan(id) as VulnerabilityScan;
}

describe('scan_policies risk-input persistence', () => {
  it('round-trips the three input flags on create', () => {
    const db = DatabaseService.getInstance();
    const p = db.createScanPolicy({ ...basePolicy, block_on_severity: 0, block_on_kev: 1, block_on_fixable: 1 });
    const read = db.getScanPolicy(p.id)!;
    expect(read).toMatchObject({ block_on_severity: 0, block_on_kev: 1, block_on_fixable: 1 });
  });

  it('updates input flags through updateScanPolicy', () => {
    const db = DatabaseService.getInstance();
    const p = db.createScanPolicy({ ...basePolicy });
    const updated = db.updateScanPolicy(p.id, { block_on_kev: 1, block_on_fixable: 1 })!;
    expect(updated).toMatchObject({ block_on_severity: 1, block_on_kev: 1, block_on_fixable: 1 });
  });

  it('migrates a raw row that omits the columns to severity-only defaults', () => {
    const db = DatabaseService.getInstance();
    // Simulate a legacy insert that predates the risk columns.
    db.transaction(() => {
      (db as unknown as { db: import('better-sqlite3').Database }).db
        .prepare('INSERT INTO scan_policies (name, node_identity, max_severity, block_on_deploy, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('legacy', '', 'CRITICAL', 1, 1, Date.now(), Date.now());
    });
    const legacy = db.getScanPolicies().find((p) => p.name === 'legacy')!;
    expect(legacy).toMatchObject({ block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0 });
  });
});

describe('evaluateScanAgainstPolicies risk inputs', () => {
  it('flags a fixable-only policy when a Critical/High finding has a fix', () => {
    const db = DatabaseService.getInstance();
    db.createScanPolicy({ ...basePolicy, stack_pattern: 'web', block_on_severity: 0, block_on_fixable: 1 });
    const scan = seedScan('web', 'HIGH', [detail({ severity: 'HIGH', fixed_version: '1.1' })]);
    expect(db.evaluateScanAgainstPolicies(1, scan, '')!.violated).toBe(true);
  });

  it('does not flag a fixable-only policy when nothing is fixable', () => {
    const db = DatabaseService.getInstance();
    db.createScanPolicy({ ...basePolicy, stack_pattern: 'web', block_on_severity: 0, block_on_fixable: 1 });
    const scan = seedScan('web', 'CRITICAL', [detail({ severity: 'CRITICAL', fixed_version: null })]);
    expect(db.evaluateScanAgainstPolicies(1, scan, '')!.violated).toBe(false);
  });

  it('uses the aggregate severity for a severity-only policy (no detail read needed)', () => {
    const db = DatabaseService.getInstance();
    db.createScanPolicy({ ...basePolicy, stack_pattern: 'web', max_severity: 'HIGH' });
    const scan = seedScan('web', 'CRITICAL', []);
    expect(db.evaluateScanAgainstPolicies(1, scan, '')!.violated).toBe(true);
  });

  it('flags a KEV-only policy when a finding is known-exploited, and not otherwise', () => {
    const db = DatabaseService.getInstance();
    db.createScanPolicy({ ...basePolicy, stack_pattern: 'web', block_on_severity: 0, block_on_kev: 1 });
    db.replaceKev([{ cve_id: 'CVE-2026-9100', date_added: '2026-01-01' }], Date.now());

    const kevScan = seedScan('web', 'LOW', [detail({ vulnerability_id: 'CVE-2026-9100', severity: 'LOW' })]);
    expect(db.evaluateScanAgainstPolicies(1, kevScan, '')!.violated).toBe(true);

    const cleanScan = seedScan('web', 'CRITICAL', [detail({ vulnerability_id: 'CVE-2026-9200', severity: 'CRITICAL' })]);
    expect(db.evaluateScanAgainstPolicies(1, cleanScan, '')!.violated).toBe(false);
  });

  it('records the matched inputs as reasons so the banner can name them', () => {
    const db = DatabaseService.getInstance();
    db.createScanPolicy({ ...basePolicy, stack_pattern: 'web', block_on_severity: 0, block_on_kev: 1, block_on_fixable: 1 });
    db.replaceKev([{ cve_id: 'CVE-2026-9100', date_added: '2026-01-01' }], Date.now());
    const scan = seedScan('web', 'CRITICAL', [
      detail({ vulnerability_id: 'CVE-2026-9100', severity: 'CRITICAL', fixed_version: '2.0' }),
    ]);
    expect(db.evaluateScanAgainstPolicies(1, scan, '')!.reasons).toEqual(['kev', 'fixable']);
  });

  it('records ["severity"] for a severity-only violation and [] when within limits', () => {
    const db = DatabaseService.getInstance();
    db.createScanPolicy({ ...basePolicy, stack_pattern: 'web', max_severity: 'HIGH' });
    expect(db.evaluateScanAgainstPolicies(1, seedScan('web', 'CRITICAL', []), '')!.reasons).toEqual(['severity']);
    expect(db.evaluateScanAgainstPolicies(1, seedScan('web', 'LOW', []), '')!.reasons).toEqual([]);
  });
});

describe('parsePolicyEvaluation', () => {
  const base = { policyId: 1, policyName: 'p', maxSeverity: 'HIGH', violated: true };

  it('defaults reasons to [] for rows persisted before reason tracking', () => {
    expect(parsePolicyEvaluation(JSON.stringify(base))).toMatchObject({ violated: true, reasons: [] });
  });

  it('drops reason values outside the known set', () => {
    const tampered = JSON.stringify({ ...base, reasons: ['kev', 'banana', 'fixable'] });
    expect(parsePolicyEvaluation(tampered)!.reasons).toEqual(['kev', 'fixable']);
  });

  it('returns null for null or malformed input', () => {
    expect(parsePolicyEvaluation(null)).toBeNull();
    expect(parsePolicyEvaluation('not json')).toBeNull();
  });
});
