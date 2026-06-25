/**
 * End-to-end apply-flow integration test for Fleet Sync against a real
 * in-process SQLite database.
 *
 * The unit suite (`fleet-sync-service.test.ts`) mocks every DatabaseService
 * method, so it proves the service calls the right methods but not that the
 * SQLite transaction actually flips the role, replaces the replicated rows,
 * persists the watermark, and leaves local rows alone. This file drives the
 * receive path on a real DB: build the wire payload a control would send,
 * call `applyIncomingSync`, and assert the replica's observable state plus
 * `blockIfReplica` enforcement. It also covers the two rejection branches
 * (stale watermark, control-anchor mismatch): each throws before any row
 * mutation, so the assertion is that the prior accepted state is preserved.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Response } from 'express';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { SYNC_STATE_KEYS } from '../services/fleetSyncConstants';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let FleetSyncService: typeof import('../services/FleetSyncService').FleetSyncService;
let StaleSyncPushError: typeof import('../services/FleetSyncService').StaleSyncPushError;
let ControlIdentityMismatchError: typeof import('../services/FleetSyncService').ControlIdentityMismatchError;
let blockIfReplica: typeof import('../middleware/fleetSyncGuards').blockIfReplica;

type ScanPolicy = import('../services/DatabaseService').ScanPolicy;

function makeRow(name: string, overrides: Partial<ScanPolicy> = {}): ScanPolicy {
  return {
    id: 0,
    name,
    node_id: null,
    node_identity: '',
    stack_pattern: null,
    max_severity: 'CRITICAL',
    block_on_deploy: 1, block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0,
    enabled: 1,
    replicated_from_control: 1,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

/** Minimal Response double capturing the status/body blockIfReplica writes. */
function fakeRes(): { res: Response; captured: { statusCode: number; body: unknown } } {
  const captured = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { captured.statusCode = code; return res; },
    json(body: unknown) { captured.body = body; return res; },
  };
  return { res: res as unknown as Response, captured };
}

/** Force this instance back to a clean control state between cases. */
function resetToControl(): void {
  const db = DatabaseService.getInstance();
  db.setSystemState(SYNC_STATE_KEYS.fleetRole, 'control');
  db.setSystemState(SYNC_STATE_KEYS.fleetSelfIdentity, '');
  db.setSystemState(SYNC_STATE_KEYS.fleetControlIdentity, '');
  db.setSystemState(SYNC_STATE_KEYS.receivedPushedAt('scan_policies'), '');
  db.setSystemState(SYNC_STATE_KEYS.receivedPushedAt('cve_suppressions'), '');
  db.clearReplicatedRows();
  // Drop any local scan policies seeded by a prior case.
  db.getDb().prepare('DELETE FROM scan_policies WHERE replicated_from_control = 0').run();
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ FleetSyncService, StaleSyncPushError, ControlIdentityMismatchError } = await import('../services/FleetSyncService'));
  ({ blockIfReplica } = await import('../middleware/fleetSyncGuards'));
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  resetToControl();
});

describe('Fleet Sync apply flow (real DB round trip)', () => {
  it('flips control -> replica, persists identity + watermark, and installs replicated rows', () => {
    const db = DatabaseService.getInstance();
    expect(FleetSyncService.getRole()).toBe('control');

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const rows = [makeRow('block-critical'), makeRow('warn-high', { max_severity: 'HIGH', block_on_deploy: 0 })];
    FleetSyncService.getInstance().applyIncomingSync(
      'scan_policies',
      rows,
      'https://replica.example',
      1_000,
      'control-fp-1',
    );

    expect(FleetSyncService.getRole()).toBe('replica');
    expect(db.getSystemState(SYNC_STATE_KEYS.fleetSelfIdentity)).toBe('https://replica.example');
    expect(db.getSystemState(SYNC_STATE_KEYS.fleetControlIdentity)).toBe('control-fp-1');
    expect(db.getSystemState(SYNC_STATE_KEYS.receivedPushedAt('scan_policies'))).toBe('1000');

    const installed = db.getScanPolicies();
    expect(installed).toHaveLength(2);
    expect(installed.every((p) => p.replicated_from_control === 1)).toBe(true);
    expect(installed.map((p) => p.name).sort()).toEqual(['block-critical', 'warn-high']);

    // The transition log fires exactly once on the actual flip.
    expect(infoSpy.mock.calls.filter((c) => String(c[0]).includes('now a replica'))).toHaveLength(1);
    infoSpy.mockRestore();
  });

  it('blocks local writes on a replica and allows them on a control', () => {
    // Control: guard is a no-op.
    const control = fakeRes();
    expect(blockIfReplica(control.res, 'scan_policies')).toBe(false);
    expect(control.captured.statusCode).toBe(0);

    // After an apply, the same guard rejects with 403 REPLICA_READ_ONLY.
    FleetSyncService.getInstance().applyIncomingSync('scan_policies', [], 'https://replica.example', 1_000, 'fp');
    const replica = fakeRes();
    expect(blockIfReplica(replica.res, 'scan_policies')).toBe(true);
    expect(replica.captured.statusCode).toBe(403);
    expect(replica.captured.body).toMatchObject({ code: 'REPLICA_READ_ONLY' });
  });

  it('replaces the prior replicated set wholesale and leaves local rows untouched', () => {
    const db = DatabaseService.getInstance();
    // A local policy authored on this instance before it became a replica.
    db.createScanPolicy({
      name: 'local-keepme', node_id: null, node_identity: '', stack_pattern: null,
      max_severity: 'CRITICAL', block_on_deploy: 1, block_on_severity: 1, block_on_kev: 0, block_on_fixable: 0, enabled: 1, replicated_from_control: 0,
    });

    FleetSyncService.getInstance().applyIncomingSync('scan_policies', [makeRow('first-gen')], 'https://r.example', 1_000, 'fp');
    expect(db.getScanPolicies().filter((p) => p.replicated_from_control === 1).map((p) => p.name)).toEqual(['first-gen']);

    // Second push with a higher watermark fully replaces the replicated set.
    // The transition log must stay silent now that the instance is already a replica.
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    FleetSyncService.getInstance().applyIncomingSync('scan_policies', [makeRow('second-gen')], 'https://r.example', 2_000, 'fp');
    expect(infoSpy.mock.calls.filter((c) => String(c[0]).includes('now a replica'))).toHaveLength(0);
    infoSpy.mockRestore();

    const replicated = db.getScanPolicies().filter((p) => p.replicated_from_control === 1);
    expect(replicated.map((p) => p.name)).toEqual(['second-gen']);
    expect(db.getSystemState(SYNC_STATE_KEYS.receivedPushedAt('scan_policies'))).toBe('2000');

    // The local row survives both pushes.
    expect(db.getLocalScanPolicies().map((p) => p.name)).toEqual(['local-keepme']);
  });

  it('installs cve_suppressions through the real DB (multi-resource dispatch)', () => {
    const db = DatabaseService.getInstance();
    const rows = [{
      cve_id: 'CVE-2024-0001', pkg_name: 'openssl', image_pattern: null,
      reason: 'fixed upstream, not exploitable', created_by: 'control',
      created_at: 1, expires_at: null, replicated_from_control: 1,
    }];
    FleetSyncService.getInstance().applyIncomingSync('cve_suppressions', rows, 'https://r.example', 1_000, 'fp');

    expect(FleetSyncService.getRole()).toBe('replica');
    const installed = db.getCveSuppressions();
    expect(installed).toHaveLength(1);
    expect(installed[0]).toMatchObject({ cve_id: 'CVE-2024-0001', pkg_name: 'openssl', replicated_from_control: 1 });
    expect(db.getSystemState(SYNC_STATE_KEYS.receivedPushedAt('cve_suppressions'))).toBe('1000');
  });

  it('rejects a stale push and rolls back so replica state is unchanged', () => {
    const db = DatabaseService.getInstance();
    FleetSyncService.getInstance().applyIncomingSync('scan_policies', [makeRow('current')], 'https://r.example', 5_000, 'fp');

    expect(() => {
      FleetSyncService.getInstance().applyIncomingSync('scan_policies', [makeRow('stale')], 'https://r.example', 4_999, 'fp');
    }).toThrow(StaleSyncPushError);

    // Watermark and rows reflect the accepted push, not the stale one.
    expect(db.getSystemState(SYNC_STATE_KEYS.receivedPushedAt('scan_policies'))).toBe('5000');
    expect(db.getScanPolicies().map((p) => p.name)).toEqual(['current']);
  });

  it('rejects a push from a different control anchor and rolls back the rows', () => {
    const db = DatabaseService.getInstance();
    // First push anchors the replica to control A.
    FleetSyncService.getInstance().applyIncomingSync('scan_policies', [makeRow('from-A')], 'https://r.example', 1_000, 'control-A');
    expect(db.getSystemState(SYNC_STATE_KEYS.fleetControlIdentity)).toBe('control-A');

    // A push from control B is rejected; control A's rows remain.
    expect(() => {
      FleetSyncService.getInstance().applyIncomingSync('scan_policies', [makeRow('from-B')], 'https://r.example', 2_000, 'control-B');
    }).toThrow(ControlIdentityMismatchError);

    expect(db.getSystemState(SYNC_STATE_KEYS.fleetControlIdentity)).toBe('control-A');
    expect(db.getScanPolicies().map((p) => p.name)).toEqual(['from-A']);
  });
});
