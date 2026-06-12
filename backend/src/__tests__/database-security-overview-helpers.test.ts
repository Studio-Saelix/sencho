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

function seedPolicy(overrides: Partial<Omit<ScanPolicy, 'id' | 'created_at' | 'updated_at'>>): void {
  db().createScanPolicy({
    name: overrides.name ?? 'p',
    node_id: overrides.node_id ?? null,
    node_identity: overrides.node_identity ?? '',
    stack_pattern: overrides.stack_pattern ?? null,
    max_severity: overrides.max_severity ?? 'CRITICAL',
    block_on_deploy: overrides.block_on_deploy ?? 1,
    enabled: overrides.enabled ?? 1,
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
