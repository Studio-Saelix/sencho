/**
 * Durable operations and locks: replays return the same operation, a finished
 * operation is never rewritten, and a restart turns whatever was running into
 * completion_unknown with stale locks that need a reviewed release.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let ops: typeof import('../services/recovery/operations');
let points: typeof import('../services/recovery/recoveryPoints');
let identities: typeof import('../services/recovery/storageIdentity');
let repos: typeof import('../services/recovery/repositories');

const ENGINE = 'docker-engine:ops-test';
let n = 0;
const key = () => `key-${++n}`;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ops = await import('../services/recovery/operations');
  points = await import('../services/recovery/recoveryPoints');
  identities = await import('../services/recovery/storageIdentity');
  repos = await import('../services/recovery/repositories');
});

afterAll(() => cleanupTestDb(tmpDir));

function classOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as { errorClass?: string }).errorClass ?? `unexpected:${String(err)}`;
  }
}

describe('operations', () => {
  it('creates once and returns the same operation on replay', () => {
    const s = new ops.RecoveryOperationStore('epoch-a');
    const k = key();
    const first = s.start({ idempotencyKey: k, kind: 'create_point', storageId: 's1', actor: 'admin', transport: 'pilot_tunnel' });
    expect(first.replayed).toBe(false);
    expect(first.operation).toMatchObject({ state: 'queued', transport: 'pilot_tunnel', processEpoch: 'epoch-a', errorClass: null });
    const replay = s.start({ idempotencyKey: k, kind: 'create_point', storageId: 's1', actor: 'admin', transport: 'pilot_tunnel' });
    expect(replay).toEqual({ operation: first.operation, replayed: true });
  });

  it('refuses a key reused for a different request', () => {
    const s = new ops.RecoveryOperationStore('epoch-a');
    const k = key();
    s.start({ idempotencyKey: k, kind: 'create_point', storageId: 's1', actor: 'admin', transport: 'local' });
    expect(classOf(() => s.start({ idempotencyKey: k, kind: 'restore', storageId: 's1', actor: 'admin', transport: 'local' }))).toBe('invalid_request');
    expect(classOf(() => s.start({ idempotencyKey: k, kind: 'create_point', storageId: 's2', actor: 'admin', transport: 'local' }))).toBe('invalid_request');
    expect(classOf(() => s.start({ idempotencyKey: '  ', kind: 'create_point', actor: 'admin', transport: 'local' }))).toBe('invalid_request');
  });

  it('records one terminal state; a duplicated or late completion changes nothing', () => {
    const s = new ops.RecoveryOperationStore('epoch-a');
    const { operation } = s.start({ idempotencyKey: key(), kind: 'verify_point', pointId: 'p', actor: 'admin', transport: 'node_proxy' });
    s.markRunning(operation.id);
    const failed = s.finish(operation.id, 'failed', 'integrity_mismatch', 100);
    expect(failed).toMatchObject({ state: 'failed', errorClass: 'integrity_mismatch', completedAt: 100 });
    expect(failed.errorDetail).toBe('The recovery point failed its integrity check.');
    expect(s.finish(operation.id, 'succeeded', null, 200)).toMatchObject({ state: 'failed', completedAt: 100 });
    expect(s.finish(operation.id, 'failed', 'integrity_mismatch', 300)).toMatchObject({ completedAt: 100 });
    expect(classOf(() => s.markRunning(operation.id))).toBe('invalid_request');
  });

  it('requires an error class on failure', () => {
    const s = new ops.RecoveryOperationStore('epoch-a');
    const { operation } = s.start({ idempotencyKey: key(), kind: 'verify_point', actor: 'admin', transport: 'local' });
    expect(classOf(() => s.finish(operation.id, 'failed'))).toBe('invalid_request');
  });
});

describe('locks', () => {
  it('admits one owner per storage, lets the owner re-acquire, and releases on a known outcome', () => {
    const s = new ops.RecoveryOperationStore('epoch-b');
    const a = s.start({ idempotencyKey: key(), kind: 'create_point', actor: 'admin', transport: 'local' }).operation;
    const b = s.start({ idempotencyKey: key(), kind: 'restore', actor: 'admin', transport: 'local' }).operation;
    const lock = s.acquireLock('storage', 'k-1', a.id);
    expect(lock).toMatchObject({ ownerOperationId: a.id, staleSince: null, processEpoch: 'epoch-b' });
    expect(s.acquireLock('storage', 'k-1', a.id)).toEqual(lock);
    expect(classOf(() => s.acquireLock('storage', 'k-1', b.id))).toBe('lock_held');
    // A repository lock is a separate scope.
    expect(s.acquireLock('repository', 'k-1', b.id).ownerOperationId).toBe(b.id);
    s.finish(a.id, 'succeeded');
    expect(s.getLock('storage', 'k-1')).toBeNull();
    expect(s.acquireLock('storage', 'k-1', b.id).ownerOperationId).toBe(b.id);
  });

  it('refuses a lock for an operation that already finished', () => {
    const s = new ops.RecoveryOperationStore('epoch-b');
    const a = s.start({ idempotencyKey: key(), kind: 'create_point', actor: 'admin', transport: 'local' }).operation;
    s.finish(a.id, 'cancelled');
    expect(classOf(() => s.acquireLock('storage', 'k-done', a.id))).toBe('invalid_request');
  });

  it('turns locks stale when the outcome is unknown, and only a reviewed release clears them', () => {
    const s = new ops.RecoveryOperationStore('epoch-b');
    const a = s.start({ idempotencyKey: key(), kind: 'restore', actor: 'admin', transport: 'local' }).operation;
    const next = s.start({ idempotencyKey: key(), kind: 'restore', actor: 'admin', transport: 'local' }).operation;
    s.acquireLock('storage', 'k-unknown', a.id);
    s.finish(a.id, 'completion_unknown', 'interrupted', 50);
    expect(s.getLock('storage', 'k-unknown')?.staleSince).toBe(50);
    expect(classOf(() => s.acquireLock('storage', 'k-unknown', next.id))).toBe('lock_stale');
    expect(classOf(() => s.releaseStaleLock('storage', 'no-such-lock', 'admin'))).toBe('invalid_request');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(s.releaseStaleLock('storage', 'k-unknown', 'admin').ownerOperationId).toBe(a.id);
    warn.mockRestore();
    expect(s.acquireLock('storage', 'k-unknown', next.id).ownerOperationId).toBe(next.id);
    // A live lock is never released by the review path.
    expect(classOf(() => s.releaseStaleLock('storage', 'k-unknown', 'admin'))).toBe('invalid_request');
  });
});

describe('restart reconciliation', () => {
  it('ends what the previous process left running as completion_unknown, with stale locks and unknown points', () => {
    const before = new ops.RecoveryOperationStore('epoch-old');
    const storage = identities.StorageIdentityStore.getInstance().observe({
      ownerNodeKey: ENGINE, kind: 'named_volume', locator: 'restart_data', generationToken: 'g', dependents: [],
    });
    const repo = repos.RecoveryRepositoryStore.getInstance().register({
      ownerNodeKey: ENGINE, kind: 'local_volume', locator: 'restart_repo', failureDomain: 'same_failure_domain',
    });
    const running = before.start({ idempotencyKey: key(), kind: 'create_point', storageId: storage.id, actor: 'admin', transport: 'local' }).operation;
    before.markRunning(running.id);
    before.acquireLock('storage', storage.storageKey, running.id);
    const queued = before.start({ idempotencyKey: key(), kind: 'verify_point', actor: 'admin', transport: 'local' }).operation;
    const done = before.start({ idempotencyKey: key(), kind: 'verify_point', actor: 'admin', transport: 'local' }).operation;
    before.finish(done.id, 'succeeded');
    const pending = points.RecoveryPointStore.getInstance().begin({
      storageId: storage.id, repositoryId: repo.id, kind: 'root', trigger: 'manual', actor: 'admin',
      sourceOperationId: running.id, sourceNodeKey: ENGINE, engineId: 'e',
    });
    const orphan = points.RecoveryPointStore.getInstance().begin({
      storageId: storage.id, repositoryId: repo.id, kind: 'root', trigger: 'manual', actor: 'admin',
      sourceOperationId: 'never-recorded', sourceNodeKey: ENGINE, engineId: 'e',
    });

    // The process dies here. The next one boots with a new epoch.
    const after = new ops.RecoveryOperationStore('epoch-new');
    const settled = after.reconcileAtStartup(9_000);
    expect(settled.interruptedOperations).toBeGreaterThanOrEqual(2);
    expect(settled.unknownPoints).toBeGreaterThanOrEqual(2);
    expect(settled.staleLocks).toBeGreaterThanOrEqual(1);

    expect(after.get(running.id)).toMatchObject({ state: 'completion_unknown', errorClass: 'interrupted', completedAt: 9_000 });
    expect(after.get(queued.id)?.state).toBe('completion_unknown');
    expect(after.get(done.id)?.state).toBe('succeeded');
    expect(points.RecoveryPointStore.getInstance().get(pending.id)).toMatchObject({ status: 'completion_unknown', failureClass: 'interrupted' });
    expect(points.RecoveryPointStore.getInstance().get(orphan.id)?.status).toBe('completion_unknown');
    expect(after.getLock('storage', storage.storageKey)?.staleSince).toBe(9_000);

    // A completion from the dead process arriving late cannot turn it into a success.
    expect(after.finish(running.id, 'succeeded').state).toBe('completion_unknown');

    // Replaying the original request returns the interrupted operation, not a fresh run.
    const replay = after.start({ idempotencyKey: running.idempotencyKey, kind: 'create_point', storageId: storage.id, actor: 'admin', transport: 'local' });
    expect(replay).toMatchObject({ replayed: true, operation: { id: running.id, state: 'completion_unknown' } });

    // New work on that storage waits for a reviewed release.
    const fresh = after.start({ idempotencyKey: key(), kind: 'create_point', storageId: storage.id, actor: 'admin', transport: 'local' }).operation;
    expect(classOf(() => after.acquireLock('storage', storage.storageKey, fresh.id))).toBe('lock_stale');

    // Running it again changes nothing.
    expect(after.reconcileAtStartup(10_000)).toEqual({ interruptedOperations: 0, unknownPoints: 0, staleLocks: 0 });
  });

  it('leaves the current process\'s own operations alone', () => {
    const s = new ops.RecoveryOperationStore('epoch-live');
    const live = s.start({ idempotencyKey: key(), kind: 'create_point', actor: 'admin', transport: 'local' }).operation;
    s.markRunning(live.id);
    s.acquireLock('storage', 'k-live', live.id);
    s.reconcileAtStartup();
    expect(s.get(live.id)?.state).toBe('running');
    expect(s.getLock('storage', 'k-live')?.staleSince).toBeNull();
  });
});
