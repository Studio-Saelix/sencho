/**
 * Coverage for the service_update_recovery accessors on the real
 * DatabaseService (against a temp DB, so the CAS WHERE clauses run against
 * actual SQLite semantics rather than a mock):
 *   - insert / get / list active
 *   - atomic claim CAS (active -> restoring) and its race/expiry guards
 *   - renewal CAS never revives a terminal or already-active row
 *   - mark consumed / reactivate / invalidate transitions
 *   - sweep of abandoned restoring claims vs a still-live claim
 *   - held image id projection and stack-delete cleanup
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import type { ServiceUpdateRecoveryRow } from '../services/DatabaseService';

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

beforeEach(() => {
  const raw = (db() as unknown as { db: { prepare: (s: string) => { run: () => void } } }).db;
  raw.prepare('DELETE FROM service_update_recovery').run();
});

const NODE = 1;

function makeRow(overrides: Partial<ServiceUpdateRecoveryRow> = {}): ServiceUpdateRecoveryRow {
  return {
    id: overrides.id ?? 'rec-1',
    node_id: NODE,
    stack_name: 'web',
    service_name: 'api',
    replicas_json: JSON.stringify([{ imageId: 'sha256:aaa', repoDigest: 'sha256:digest-aaa' }]),
    majority_image_id: 'sha256:aaa',
    declared_image_ref: 'ghcr.io/acme/api:v1',
    weak_floating_tag: 0,
    health_gate_id: null,
    status: 'active',
    expires_at: 10_000,
    claim_expires_at: null,
    created_at: 1_000,
    created_by: 'tester',
    ...overrides,
  };
}

describe('service_update_recovery accessors', () => {
  it('inserts and reads a row back by id', () => {
    db().insertServiceUpdateRecovery(makeRow());
    const row = db().getServiceUpdateRecovery('rec-1');
    expect(row).toMatchObject({ id: 'rec-1', stack_name: 'web', service_name: 'api', status: 'active' });
  });

  it('lists only active rows for a service, most recent first', () => {
    db().insertServiceUpdateRecovery(makeRow({ id: 'rec-old', created_at: 1_000 }));
    db().insertServiceUpdateRecovery(makeRow({ id: 'rec-new', created_at: 2_000 }));
    db().insertServiceUpdateRecovery(makeRow({ id: 'rec-consumed', status: 'consumed' }));
    db().insertServiceUpdateRecovery(makeRow({ id: 'rec-other-service', service_name: 'db' }));

    const active = db().listActiveServiceUpdateRecoveries(NODE, 'web', 'api');
    expect(active.map(r => r.id)).toEqual(['rec-new', 'rec-old']);
  });

  it('links a health gate id only while the row is still active', () => {
    db().insertServiceUpdateRecovery(makeRow());
    db().linkServiceUpdateRecoveryHealthGate('rec-1', 'gate-1');
    expect(db().getServiceUpdateRecovery('rec-1')?.health_gate_id).toBe('gate-1');

    db().insertServiceUpdateRecovery(makeRow({ id: 'rec-consumed', status: 'consumed' }));
    db().linkServiceUpdateRecoveryHealthGate('rec-consumed', 'gate-2');
    expect(db().getServiceUpdateRecovery('rec-consumed')?.health_gate_id).toBeNull();
  });

  describe('claim CAS', () => {
    it('claims an active, unexpired row and moves it to restoring', () => {
      db().insertServiceUpdateRecovery(makeRow({ expires_at: 50_000 }));
      const claimed = db().claimServiceUpdateRecovery('rec-1', 100_000, 20_000);
      expect(claimed).toMatchObject({ id: 'rec-1', status: 'restoring', claim_expires_at: 100_000 });
    });

    it('refuses to claim an already-expired active row', () => {
      db().insertServiceUpdateRecovery(makeRow({ expires_at: 10_000 }));
      const claimed = db().claimServiceUpdateRecovery('rec-1', 100_000, 20_000);
      expect(claimed).toBeUndefined();
      expect(db().getServiceUpdateRecovery('rec-1')?.status).toBe('active');
    });

    it('refuses a second claim on an already-restoring row (no double claim)', () => {
      db().insertServiceUpdateRecovery(makeRow({ expires_at: 50_000 }));
      const first = db().claimServiceUpdateRecovery('rec-1', 100_000, 20_000);
      expect(first).toBeTruthy();
      const second = db().claimServiceUpdateRecovery('rec-1', 200_000, 21_000);
      expect(second).toBeUndefined();
    });

    it('refuses to claim a consumed/expired/invalidated row', () => {
      for (const status of ['consumed', 'expired', 'invalidated'] as const) {
        db().insertServiceUpdateRecovery(makeRow({ id: `rec-${status}`, status, expires_at: 50_000 }));
        const claimed = db().claimServiceUpdateRecovery(`rec-${status}`, 100_000, 20_000);
        expect(claimed).toBeUndefined();
      }
    });
  });

  describe('renewal CAS (no revive of terminal)', () => {
    it('extends claim_expires_at while restoring', () => {
      db().insertServiceUpdateRecovery(makeRow({ status: 'restoring', claim_expires_at: 100_000 }));
      const renewed = db().renewServiceUpdateRecoveryClaim('rec-1', 200_000);
      expect(renewed).toBe(true);
      expect(db().getServiceUpdateRecovery('rec-1')?.claim_expires_at).toBe(200_000);
    });

    it.each(['active', 'consumed', 'expired', 'invalidated'] as const)(
      'never revives a %s row via renewal',
      (status) => {
        db().insertServiceUpdateRecovery(makeRow({ status, claim_expires_at: status === 'active' ? null : 100_000 }));
        const renewed = db().renewServiceUpdateRecoveryClaim('rec-1', 999_000);
        expect(renewed).toBe(false);
        expect(db().getServiceUpdateRecovery('rec-1')?.status).toBe(status);
      },
    );
  });

  describe('terminal transitions', () => {
    it('marks a restoring row consumed and links the restore health gate id', () => {
      db().insertServiceUpdateRecovery(makeRow({ status: 'restoring', claim_expires_at: 100_000, health_gate_id: 'update-gate' }));
      const ok = db().markServiceUpdateRecoveryConsumed('rec-1', 'restore-gate');
      expect(ok).toBe(true);
      const row = db().getServiceUpdateRecovery('rec-1');
      expect(row).toMatchObject({ status: 'consumed', claim_expires_at: null, health_gate_id: 'restore-gate' });
    });

    it('keeps the prior health gate id when marking consumed with no runId', () => {
      db().insertServiceUpdateRecovery(makeRow({ status: 'restoring', health_gate_id: 'update-gate' }));
      db().markServiceUpdateRecoveryConsumed('rec-1', null);
      expect(db().getServiceUpdateRecovery('rec-1')?.health_gate_id).toBe('update-gate');
    });

    it('cannot mark an already-active row consumed', () => {
      db().insertServiceUpdateRecovery(makeRow({ status: 'active' }));
      expect(db().markServiceUpdateRecoveryConsumed('rec-1')).toBe(false);
    });

    it('reactivates a restoring row on a mid-flight failure with the image still local', () => {
      db().insertServiceUpdateRecovery(makeRow({ status: 'restoring', claim_expires_at: 100_000 }));
      const ok = db().reactivateServiceUpdateRecovery('rec-1');
      expect(ok).toBe(true);
      expect(db().getServiceUpdateRecovery('rec-1')).toMatchObject({ status: 'active', claim_expires_at: null });
    });

    it('invalidates a restoring row on a mid-flight failure with the image gone', () => {
      db().insertServiceUpdateRecovery(makeRow({ status: 'restoring', claim_expires_at: 100_000 }));
      const ok = db().invalidateServiceUpdateRecovery('rec-1');
      expect(ok).toBe(true);
      expect(db().getServiceUpdateRecovery('rec-1')).toMatchObject({ status: 'invalidated', claim_expires_at: null });
    });

    it('cannot reactivate or invalidate a row that is not restoring', () => {
      db().insertServiceUpdateRecovery(makeRow({ status: 'active' }));
      expect(db().reactivateServiceUpdateRecovery('rec-1')).toBe(false);
      expect(db().invalidateServiceUpdateRecovery('rec-1')).toBe(false);
    });
  });

  describe('sweep', () => {
    it('expires an active row whose TTL has lapsed', () => {
      db().insertServiceUpdateRecovery(makeRow({ expires_at: 10_000 }));
      const count = db().sweepExpiredActiveServiceUpdateRecoveries(20_000);
      expect(count).toBe(1);
      expect(db().getServiceUpdateRecovery('rec-1')?.status).toBe('expired');
    });

    it('leaves an unexpired active row alone', () => {
      db().insertServiceUpdateRecovery(makeRow({ expires_at: 50_000 }));
      expect(db().sweepExpiredActiveServiceUpdateRecoveries(20_000)).toBe(0);
      expect(db().getServiceUpdateRecovery('rec-1')?.status).toBe('active');
    });

    it('expires an abandoned restoring row (dead claim) but never a live one, even past the original expires_at', () => {
      db().insertServiceUpdateRecovery(makeRow({
        id: 'rec-abandoned', status: 'restoring', expires_at: 10_000, claim_expires_at: 15_000,
      }));
      db().insertServiceUpdateRecovery(makeRow({
        id: 'rec-live', status: 'restoring', expires_at: 10_000, claim_expires_at: 100_000,
      }));

      const count = db().sweepAbandonedRestoringServiceUpdateRecoveries(20_000);
      expect(count).toBe(1);
      expect(db().getServiceUpdateRecovery('rec-abandoned')?.status).toBe('expired');
      // Original expires_at (10_000) is long past, but the claim is still live: not swept.
      expect(db().getServiceUpdateRecovery('rec-live')?.status).toBe('restoring');
    });

    it('never touches an active row from the restoring sweep, and vice versa', () => {
      db().insertServiceUpdateRecovery(makeRow({ id: 'rec-active', status: 'active', expires_at: 10_000 }));
      db().insertServiceUpdateRecovery(makeRow({
        id: 'rec-restoring', status: 'restoring', expires_at: 999_000, claim_expires_at: 10_000,
      }));

      expect(db().sweepAbandonedRestoringServiceUpdateRecoveries(20_000)).toBe(1);
      expect(db().getServiceUpdateRecovery('rec-active')?.status).toBe('active');

      expect(db().sweepExpiredActiveServiceUpdateRecoveries(20_000)).toBe(1);
      expect(db().getServiceUpdateRecovery('rec-active')?.status).toBe('expired');
    });
  });

  describe('held image ids', () => {
    it('holds the image for an active row and a restoring row with a live claim, not a terminal or abandoned one', () => {
      db().insertServiceUpdateRecovery(makeRow({ id: 'rec-active', majority_image_id: 'sha256:held-1', status: 'active', expires_at: 999_000 }));
      db().insertServiceUpdateRecovery(makeRow({
        id: 'rec-live-claim', majority_image_id: 'sha256:held-2', status: 'restoring', claim_expires_at: 100_000,
      }));
      db().insertServiceUpdateRecovery(makeRow({
        id: 'rec-dead-claim', majority_image_id: 'sha256:not-held-1', status: 'restoring', claim_expires_at: 5_000,
      }));
      db().insertServiceUpdateRecovery(makeRow({ id: 'rec-consumed', majority_image_id: 'sha256:not-held-2', status: 'consumed' }));

      const held = db().listHeldServiceUpdateRecoveryImageIds(NODE, 20_000);
      expect(new Set(held)).toEqual(new Set(['sha256:held-1', 'sha256:held-2']));
    });

    it('scopes held image ids per node', () => {
      db().insertServiceUpdateRecovery(makeRow({ id: 'rec-node-1', node_id: 1, majority_image_id: 'sha256:node-1', expires_at: 999_000 }));
      db().insertServiceUpdateRecovery(makeRow({ id: 'rec-node-2', node_id: 2, majority_image_id: 'sha256:node-2', expires_at: 999_000 }));

      expect(db().listHeldServiceUpdateRecoveryImageIds(1, 0)).toEqual(['sha256:node-1']);
      expect(db().listHeldServiceUpdateRecoveryImageIds(2, 0)).toEqual(['sha256:node-2']);
    });
  });

  it('deletes every row for a stack on stack delete, leaving other stacks untouched', () => {
    db().insertServiceUpdateRecovery(makeRow({ id: 'rec-web', stack_name: 'web' }));
    db().insertServiceUpdateRecovery(makeRow({ id: 'rec-api', stack_name: 'api' }));

    db().deleteServiceUpdateRecoveries(NODE, 'web');

    expect(db().getServiceUpdateRecovery('rec-web')).toBeUndefined();
    expect(db().getServiceUpdateRecovery('rec-api')).toBeTruthy();
  });
});
