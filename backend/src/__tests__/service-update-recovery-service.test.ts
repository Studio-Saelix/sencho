/**
 * Coverage for ServiceUpdateRecoveryService against a real DatabaseService
 * (temp DB) with fake timers: eligibility computation (§8 "Unavailable"
 * cases), the claim/renewal lifecycle (RECOVERY-CLAIM-2, no revive of a
 * terminal row), the sweep timer, held image ids, and start/stop timer
 * hygiene.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import type { ServiceReplicaSnapshot } from '../services/ServiceUpdateRecoveryService';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let ServiceUpdateRecoveryService: typeof import('../services/ServiceUpdateRecoveryService').ServiceUpdateRecoveryService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ ServiceUpdateRecoveryService } = await import('../services/ServiceUpdateRecoveryService'));
});

afterAll(() => cleanupTestDb(tmpDir));

function db() {
  return DatabaseService.getInstance();
}

const svc = () => ServiceUpdateRecoveryService.getInstance();

const BASE_INPUT = {
  nodeId: 1,
  stackName: 'web',
  serviceName: 'api',
  declaredImageRef: 'ghcr.io/acme/api:v1',
  createdBy: 'tester',
};

beforeEach(() => {
  vi.useFakeTimers();
  const raw = (db() as unknown as { db: { prepare: (s: string) => { run: () => void } } }).db;
  raw.prepare('DELETE FROM service_update_recovery').run();
  raw.prepare("DELETE FROM global_settings WHERE key = 'health_gate_window_seconds'").run();
  // updateGlobalSetting() invalidates this cache; the raw DELETE above bypasses
  // it, so a value set by a previous test would otherwise leak into this one.
  (db() as unknown as { cachedGlobalSettings: unknown }).cachedGlobalSettings = null;
  svc().start();
});

afterEach(() => {
  svc().stop();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('createIfEligible - unavailable cases', () => {
  it('rejects a service with no replicas', () => {
    const result = svc().createIfEligible({ ...BASE_INPUT, replicas: [] });
    expect(result).toEqual({ eligible: false, reason: 'no_replicas' });
  });

  it('rejects replicas with no local image id', () => {
    const replicas: ServiceReplicaSnapshot[] = [{ imageId: '', repoDigest: null }, { imageId: '   ', repoDigest: null }];
    const result = svc().createIfEligible({ ...BASE_INPUT, replicas });
    expect(result).toEqual({ eligible: false, reason: 'missing_local_id' });
  });

  it('rejects a majority tie between two equally-common images', () => {
    const replicas: ServiceReplicaSnapshot[] = [
      { imageId: 'sha256:aaa', repoDigest: null },
      { imageId: 'sha256:bbb', repoDigest: null },
    ];
    const result = svc().createIfEligible({ ...BASE_INPUT, replicas });
    expect(result).toEqual({ eligible: false, reason: 'majority_tie' });
  });

  it('rejects a pure-build service with no declared image ref', () => {
    const replicas: ServiceReplicaSnapshot[] = [{ imageId: 'sha256:aaa', repoDigest: null }];
    const result = svc().createIfEligible({ ...BASE_INPUT, declaredImageRef: null, replicas });
    expect(result).toEqual({ eligible: false, reason: 'build_only' });
  });

  it('rejects a digest-pinned declared image ref', () => {
    const replicas: ServiceReplicaSnapshot[] = [{ imageId: 'sha256:aaa', repoDigest: null }];
    const result = svc().createIfEligible({
      ...BASE_INPUT,
      declaredImageRef: 'ghcr.io/acme/api@sha256:' + 'a'.repeat(64),
      replicas,
    });
    expect(result).toEqual({ eligible: false, reason: 'digest_pinned_declared_ref' });
  });
});

describe('createIfEligible - eligible cases', () => {
  it('persists the majority image and flags a weak floating tag when no replica has a captured digest', () => {
    const replicas: ServiceReplicaSnapshot[] = [
      { imageId: 'sha256:aaa', repoDigest: null },
      { imageId: 'sha256:aaa', repoDigest: null },
      { imageId: 'sha256:bbb', repoDigest: null },
    ];
    const result = svc().createIfEligible({ ...BASE_INPUT, replicas });
    expect(result.eligible).toBe(true);
    if (!result.eligible) throw new Error('expected eligible');
    expect(result.row).toMatchObject({
      node_id: 1, stack_name: 'web', service_name: 'api',
      majority_image_id: 'sha256:aaa', declared_image_ref: 'ghcr.io/acme/api:v1',
      weak_floating_tag: 1, status: 'active', health_gate_id: null,
    });
    expect(db().getServiceUpdateRecovery(result.row.id)).toBeTruthy();
  });

  it('clears the weak floating tag flag when a majority replica has a captured digest', () => {
    const replicas: ServiceReplicaSnapshot[] = [
      { imageId: 'sha256:aaa', repoDigest: 'sha256:digest-aaa' },
      { imageId: 'sha256:aaa', repoDigest: 'sha256:digest-aaa' },
      { imageId: 'sha256:bbb', repoDigest: null },
    ];
    const result = svc().createIfEligible({ ...BASE_INPUT, replicas });
    if (!result.eligible) throw new Error('expected eligible');
    expect(result.row.weak_floating_tag).toBe(0);
  });

  it('sets expires_at from health_gate_window_seconds with a 90s floor', () => {
    db().updateGlobalSetting('health_gate_window_seconds', '120');
    const now = Date.now();
    const replicas: ServiceReplicaSnapshot[] = [{ imageId: 'sha256:aaa', repoDigest: null }];
    const result = svc().createIfEligible({ ...BASE_INPUT, replicas });
    if (!result.eligible) throw new Error('expected eligible');
    expect(result.row.expires_at).toBe(now + 120_000 + 30 * 60_000);
  });

  it('floors expires_at to 90s when the setting is below the floor or unset', () => {
    db().updateGlobalSetting('health_gate_window_seconds', '15');
    const now = Date.now();
    const replicas: ServiceReplicaSnapshot[] = [{ imageId: 'sha256:aaa', repoDigest: null }];
    const result = svc().createIfEligible({ ...BASE_INPUT, replicas });
    if (!result.eligible) throw new Error('expected eligible');
    expect(result.row.expires_at).toBe(now + 90_000 + 30 * 60_000);
  });
});

describe('claim + mandatory renewal (RECOVERY-CLAIM-2)', () => {
  function seedEligible(): string {
    const replicas: ServiceReplicaSnapshot[] = [{ imageId: 'sha256:aaa', repoDigest: 'sha256:digest-aaa' }];
    const result = svc().createIfEligible({ ...BASE_INPUT, replicas });
    if (!result.eligible) throw new Error('expected eligible');
    return result.row.id;
  }

  it('claims an active row and moves it to restoring with a claim window at least 30m + 5m out', () => {
    const id = seedEligible();
    const now = Date.now();
    const claimed = svc().claim(id);
    expect(claimed?.status).toBe('restoring');
    expect(claimed?.claim_expires_at).toBeGreaterThanOrEqual(now + 30 * 60_000 + 5 * 60_000);
  });

  it('renews the claim every 5 minutes while restoring, keeping a long restore held', () => {
    const id = seedEligible();
    svc().claim(id);
    const firstExpiry = db().getServiceUpdateRecovery(id)?.claim_expires_at ?? 0;

    svc().startClaimRenewal(id);
    vi.advanceTimersByTime(5 * 60_000);

    const renewedExpiry = db().getServiceUpdateRecovery(id)?.claim_expires_at ?? 0;
    expect(renewedExpiry).toBeGreaterThan(firstExpiry);
    expect(db().getServiceUpdateRecovery(id)?.status).toBe('restoring');

    svc().stopClaimRenewal(id);
  });

  it('does not revive a row that left restoring mid-loop (renewal self-stops, never overwrites the terminal status)', () => {
    const id = seedEligible();
    svc().claim(id);
    svc().startClaimRenewal(id);

    // Simulate the restore finishing (consumed) between renewal ticks.
    db().markServiceUpdateRecoveryConsumed(id, 'restore-gate');
    const claimExpiresBefore = db().getServiceUpdateRecovery(id)?.claim_expires_at;

    vi.advanceTimersByTime(5 * 60_000);

    const row = db().getServiceUpdateRecovery(id);
    expect(row?.status).toBe('consumed');
    expect(row?.claim_expires_at).toBe(claimExpiresBefore);

    svc().stopClaimRenewal(id);
  });

  it('stops renewing once stopClaimRenewal is called (finally-block contract)', () => {
    const id = seedEligible();
    svc().claim(id);
    svc().startClaimRenewal(id);
    svc().stopClaimRenewal(id);

    const expiryAtStop = db().getServiceUpdateRecovery(id)?.claim_expires_at;
    vi.advanceTimersByTime(15 * 60_000);
    expect(db().getServiceUpdateRecovery(id)?.claim_expires_at).toBe(expiryAtStop);
  });

  it('is idempotent: a second startClaimRenewal call for the same id does not schedule a duplicate timer', () => {
    const id = seedEligible();
    svc().claim(id);
    const before = vi.getTimerCount();
    svc().startClaimRenewal(id);
    svc().startClaimRenewal(id);
    expect(vi.getTimerCount()).toBe(before + 1);
    svc().stopClaimRenewal(id);
  });

  it('refuses to start a renewal loop once the service has been stopped', () => {
    const id = seedEligible();
    svc().claim(id);
    svc().stop();
    const before = vi.getTimerCount();
    svc().startClaimRenewal(id);
    expect(vi.getTimerCount()).toBe(before);
  });
});

describe('sweep()', () => {
  it('expires an abandoned restoring claim but leaves a live one and an unexpired active one alone', () => {
    const now = Date.now();
    db().insertServiceUpdateRecovery({
      id: 'rec-abandoned', node_id: 1, stack_name: 'web', service_name: 'api',
      replicas_json: '[]', majority_image_id: 'sha256:aaa', declared_image_ref: 'x:1',
      weak_floating_tag: 0, health_gate_id: null, status: 'restoring',
      expires_at: now - 1_000, claim_expires_at: now - 1_000, created_at: now - 60_000, created_by: null,
    });
    db().insertServiceUpdateRecovery({
      id: 'rec-live', node_id: 1, stack_name: 'web', service_name: 'db',
      replicas_json: '[]', majority_image_id: 'sha256:bbb', declared_image_ref: 'x:2',
      weak_floating_tag: 0, health_gate_id: null, status: 'restoring',
      expires_at: now - 1_000, claim_expires_at: now + 60 * 60_000, created_at: now - 60_000, created_by: null,
    });
    db().insertServiceUpdateRecovery({
      id: 'rec-active', node_id: 1, stack_name: 'web', service_name: 'cache',
      replicas_json: '[]', majority_image_id: 'sha256:ccc', declared_image_ref: 'x:3',
      weak_floating_tag: 0, health_gate_id: null, status: 'active',
      expires_at: now + 60 * 60_000, claim_expires_at: null, created_at: now, created_by: null,
    });

    svc().sweep();

    expect(db().getServiceUpdateRecovery('rec-abandoned')?.status).toBe('expired');
    expect(db().getServiceUpdateRecovery('rec-live')?.status).toBe('restoring');
    expect(db().getServiceUpdateRecovery('rec-active')?.status).toBe('active');
  });

  it('runs automatically on the interval timer after start()', () => {
    const now = Date.now();
    db().insertServiceUpdateRecovery({
      id: 'rec-ttl', node_id: 1, stack_name: 'web', service_name: 'api',
      replicas_json: '[]', majority_image_id: 'sha256:aaa', declared_image_ref: 'x:1',
      weak_floating_tag: 0, health_gate_id: null, status: 'active',
      expires_at: now + 1_000, claim_expires_at: null, created_at: now, created_by: null,
    });

    vi.advanceTimersByTime(30_000 + 5 * 60_000 + 1_000);

    expect(db().getServiceUpdateRecovery('rec-ttl')?.status).toBe('expired');
  });
});

describe('getHeldImageIds', () => {
  it('wraps the DB projection for one node', () => {
    const now = Date.now();
    db().insertServiceUpdateRecovery({
      id: 'rec-held', node_id: 1, stack_name: 'web', service_name: 'api',
      replicas_json: '[]', majority_image_id: 'sha256:held', declared_image_ref: 'x:1',
      weak_floating_tag: 0, health_gate_id: null, status: 'active',
      expires_at: now + 60_000, claim_expires_at: null, created_at: now, created_by: null,
    });
    expect(svc().getHeldImageIds(1)).toEqual(new Set(['sha256:held']));
  });

  it('fails closed (null) when the DB read throws', () => {
    const spy = vi.spyOn(db(), 'listHeldServiceUpdateRecoveryImageIds').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(svc().getHeldImageIds(1)).toBeNull();
    spy.mockRestore();
  });
});

describe('start() / stop() timer hygiene', () => {
  it('clears the sweep timer and stops firing after stop()', () => {
    const spy = vi.spyOn(svc(), 'sweep');
    svc().stop();
    expect(vi.getTimerCount()).toBe(0);
    svc().start();
    vi.advanceTimersByTime(30_000);
    expect(spy).toHaveBeenCalledTimes(1);
    svc().stop();
    vi.advanceTimersByTime(5 * 60_000);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
