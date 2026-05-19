/**
 * Pins the DatabaseService sticky-error wiring used by the F-16 fix:
 *   - setFleetSyncSticky writes the code + expected + got fingerprints.
 *   - getFleetSyncStickyCode reads them back.
 *   - getFailedSyncTargets excludes sticky rows (the retry loop must not pick them up).
 *   - recordFleetSyncSuccess clears the sticky on success (operator reset → push resumes).
 *   - clearFleetSyncStickyForNode clears every resource for one node id (used by the reset endpoint).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let nodeId: number;
let siblingId: number;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  const db = DatabaseService.getInstance();
  nodeId = db.addNode({
    name: 'sticky-target',
    type: 'remote',
    compose_dir: '/app/compose',
    is_default: false,
    api_url: 'https://sticky.example',
    api_token: 'tok',
    mode: 'proxy',
  });
  siblingId = db.addNode({
    name: 'sticky-sibling',
    type: 'remote',
    compose_dir: '/app/compose',
    is_default: false,
    api_url: 'https://sibling-sticky.example',
    api_token: 'tok',
    mode: 'proxy',
  });
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  const db = DatabaseService.getInstance();
  // Wipe stale rows from prior tests in this file so each case starts clean.
  db.getDb().prepare('DELETE FROM fleet_sync_status WHERE node_id IN (?, ?)').run(nodeId, siblingId);
});

describe('fleet_sync_status sticky-error column', () => {
  it('setFleetSyncSticky persists the code and fingerprints', () => {
    const db = DatabaseService.getInstance();
    db.setFleetSyncSticky(nodeId, 'scan_policies', 'CONTROL_IDENTITY_MISMATCH', 'aaa111', 'bbb222');

    const row = db.getFleetSyncStatuses().find(
      (s) => s.node_id === nodeId && s.resource === 'scan_policies',
    );
    expect(row).toBeDefined();
    expect(row!.sticky_error_code).toBe('CONTROL_IDENTITY_MISMATCH');
    expect(row!.sticky_error_expected).toBe('aaa111');
    expect(row!.sticky_error_got).toBe('bbb222');
    expect(db.getFleetSyncStickyCode(nodeId, 'scan_policies')).toBe('CONTROL_IDENTITY_MISMATCH');
  });

  it('setFleetSyncSticky upserts when no row exists yet', () => {
    const db = DatabaseService.getInstance();
    // Pre-state: no row.
    expect(db.getFleetSyncStickyCode(nodeId, 'cve_suppressions')).toBeNull();

    db.setFleetSyncSticky(nodeId, 'cve_suppressions', 'CONTROL_IDENTITY_MISMATCH', null, null);

    expect(db.getFleetSyncStickyCode(nodeId, 'cve_suppressions')).toBe('CONTROL_IDENTITY_MISMATCH');
  });

  it('getFailedSyncTargets excludes rows where sticky_error_code is set', () => {
    const db = DatabaseService.getInstance();
    db.recordFleetSyncFailure(nodeId, 'scan_policies', 'timeout');
    db.recordFleetSyncFailure(siblingId, 'scan_policies', 'connection refused');
    // Mark only `nodeId` as sticky; the sibling stays retriable.
    db.setFleetSyncSticky(nodeId, 'scan_policies', 'CONTROL_IDENTITY_MISMATCH', null, null);

    const retriable = db.getFailedSyncTargets('scan_policies', 24 * 60 * 60_000);
    const retriableIds = retriable.map((r) => r.node_id);
    expect(retriableIds).toContain(siblingId);
    expect(retriableIds).not.toContain(nodeId);
  });

  it('recordFleetSyncSuccess clears the sticky flag (operator-reset round-trip)', () => {
    const db = DatabaseService.getInstance();
    db.setFleetSyncSticky(nodeId, 'scan_policies', 'CONTROL_IDENTITY_MISMATCH', 'aaa', 'bbb');
    expect(db.getFleetSyncStickyCode(nodeId, 'scan_policies')).toBe('CONTROL_IDENTITY_MISMATCH');

    db.recordFleetSyncSuccess(nodeId, 'scan_policies');

    expect(db.getFleetSyncStickyCode(nodeId, 'scan_policies')).toBeNull();
    const row = db.getFleetSyncStatuses().find(
      (s) => s.node_id === nodeId && s.resource === 'scan_policies',
    );
    expect(row!.sticky_error_expected).toBeNull();
    expect(row!.sticky_error_got).toBeNull();
  });

  it('clearFleetSyncStickyForNode clears every resource for one node, leaves siblings untouched', () => {
    const db = DatabaseService.getInstance();
    db.setFleetSyncSticky(nodeId, 'scan_policies', 'CONTROL_IDENTITY_MISMATCH', null, null);
    db.setFleetSyncSticky(nodeId, 'cve_suppressions', 'CONTROL_IDENTITY_MISMATCH', null, null);
    db.setFleetSyncSticky(siblingId, 'scan_policies', 'CONTROL_IDENTITY_MISMATCH', null, null);

    db.clearFleetSyncStickyForNode(nodeId);

    expect(db.getFleetSyncStickyCode(nodeId, 'scan_policies')).toBeNull();
    expect(db.getFleetSyncStickyCode(nodeId, 'cve_suppressions')).toBeNull();
    expect(db.getFleetSyncStickyCode(siblingId, 'scan_policies')).toBe('CONTROL_IDENTITY_MISMATCH');
  });

  it('migrateFleetSyncStickyError is idempotent (running twice does not error)', () => {
    // The constructor already runs the migration once at boot. Manually
    // invoke the private method twice via index access to confirm
    // tryAddColumn's idempotency contract holds for this migration.
    const db = DatabaseService.getInstance() as unknown as {
      migrateFleetSyncStickyError: () => void;
    };
    expect(() => {
      db.migrateFleetSyncStickyError();
      db.migrateFleetSyncStickyError();
    }).not.toThrow();
  });
});
