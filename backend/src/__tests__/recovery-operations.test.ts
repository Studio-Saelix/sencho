/**
 * Durable operations and locks: replays return the same operation, a finished
 * operation is never rewritten, and a restart turns whatever was running into
 * completion_unknown with stale locks that need a reviewed release. Work left
 * by a dead process can never be resumed in place, even when boot
 * reconciliation did not run.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let ops: typeof import('../services/recovery/operations');
let points: typeof import('../services/recovery/recoveryPoints');
let identities: typeof import('../services/recovery/storageIdentity');
let repos: typeof import('../services/recovery/repositories');
let recoveryDb: typeof import('../services/recovery/recoveryDb').recoveryDb;

const ENGINE = 'docker-engine:ops-test';
let n = 0;
const key = () => `key-${++n}`;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ops = await import('../services/recovery/operations');
  points = await import('../services/recovery/recoveryPoints');
  identities = await import('../services/recovery/storageIdentity');
  repos = await import('../services/recovery/repositories');
  ({ recoveryDb } = await import('../services/recovery/recoveryDb'));
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

/** A storage that exists, so its key is a valid lock target. */
function storage(locator: string) {
  return identities.StorageIdentityStore.getInstance().observe({
    ownerNodeKey: ENGINE, kind: 'named_volume', locator, generationToken: 'g', dependents: [],
  });
}

function repository(locator: string) {
  return repos.RecoveryRepositoryStore.getInstance().register({
    ownerNodeKey: ENGINE, kind: 'local_volume', locator, failureDomain: 'same_failure_domain',
  });
}

function beginPoint(storageId: string, token: string, repositoryId: string, sourceOperationId: string) {
  return points.RecoveryPointStore.getInstance().begin({
    storageId, expectedGenerationToken: token, repositoryId, kind: 'root', trigger: 'manual', actor: 'admin',
    sourceOperationId, sourceNodeKey: ENGINE, engineId: 'e',
  });
}

const evidence = () => ({
  snapshotId: `snap-${++n}`,
  capture: { fileCount: 1, byteCount: 1, skippedCount: 0 },
  exclusions: [],
  consistency: 'crash_consistent_live' as const,
});

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

  it('refuses a key reused for a different request, actor or transport', () => {
    const s = new ops.RecoveryOperationStore('epoch-a');
    const k = key();
    s.start({ idempotencyKey: k, kind: 'restore', storageId: 's1', actor: 'alice', transport: 'local' });
    for (const other of [
      { kind: 'create_point' as const, storageId: 's1', actor: 'alice', transport: 'local' as const },
      { kind: 'restore' as const, storageId: 's2', actor: 'alice', transport: 'local' as const },
      { kind: 'restore' as const, storageId: 's1', actor: 'mallory', transport: 'local' as const },
      { kind: 'restore' as const, storageId: 's1', actor: 'alice', transport: 'pilot_tunnel' as const },
    ]) {
      expect(classOf(() => s.start({ idempotencyKey: k, ...other }))).toBe('invalid_request');
    }
    expect(classOf(() => s.start({ idempotencyKey: '  ', kind: 'create_point', actor: 'admin', transport: 'local' }))).toBe('invalid_request');
  });

  it('refuses the same key with a different point id, and creates no second operation', () => {
    const s = new ops.RecoveryOperationStore('epoch-a');
    const k = key();
    const first = s.start({ idempotencyKey: k, kind: 'verify_point', pointId: 'point-1', actor: 'alice', transport: 'local' });
    expect(s.start({ idempotencyKey: k, kind: 'verify_point', pointId: 'point-1', actor: 'alice', transport: 'local' })).toEqual({ operation: first.operation, replayed: true });
    for (const pointId of ['point-2', null]) {
      expect(classOf(() => s.start({ idempotencyKey: k, kind: 'verify_point', pointId, actor: 'alice', transport: 'local' }))).toBe('invalid_request');
    }
    // The other direction: a key first used without a point is not handed to a request that names one.
    const bare = key();
    s.start({ idempotencyKey: bare, kind: 'verify_point', actor: 'alice', transport: 'local' });
    expect(classOf(() => s.start({ idempotencyKey: bare, kind: 'verify_point', pointId: 'point-1', actor: 'alice', transport: 'local' }))).toBe('invalid_request');
    const rows = recoveryDb().prepare('SELECT COUNT(*) AS n FROM recovery_operations WHERE idempotency_key IN (?, ?)').get(k, bare) as { n: number };
    expect(rows.n).toBe(2);
  });

  it('records one terminal state; a duplicated or late completion changes nothing', () => {
    const s = new ops.RecoveryOperationStore('epoch-a');
    const { operation } = s.start({ idempotencyKey: key(), kind: 'verify_point', pointId: 'p', actor: 'admin', transport: 'node_proxy' });
    s.markRunning(operation.id);
    expect(s.markRunning(operation.id).state).toBe('running');
    const failed = s.finish(operation.id, { state: 'failed', errorClass: 'integrity_mismatch' }, 100);
    expect(failed).toMatchObject({ state: 'failed', errorClass: 'integrity_mismatch', completedAt: 100 });
    expect(failed.errorDetail).toBe('The recovery point failed its integrity check.');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(s.finish(operation.id, { state: 'succeeded' }, 200)).toMatchObject({ state: 'failed', completedAt: 100 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('late'), 'succeeded', 'no class', operation.id, 'failed', 'integrity_mismatch');
    warn.mockClear();
    // Same ending with a different class is a disagreement too, and is logged.
    expect(s.finish(operation.id, { state: 'failed', errorClass: 'internal' }, 250)).toMatchObject({ errorClass: 'integrity_mismatch' });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
    // An exact duplicate is silent.
    expect(s.finish(operation.id, { state: 'failed', errorClass: 'integrity_mismatch' }, 300)).toMatchObject({ completedAt: 100 });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    expect(classOf(() => s.markRunning(operation.id))).toBe('invalid_request');
  });

  it('ties each ending to its error class', () => {
    const s = new ops.RecoveryOperationStore('epoch-a');
    const ok = s.start({ idempotencyKey: key(), kind: 'verify_point', actor: 'admin', transport: 'local' }).operation;
    expect(s.finish(ok.id, { state: 'succeeded' })).toMatchObject({ errorClass: null, errorDetail: null });
    const lost = s.start({ idempotencyKey: key(), kind: 'verify_point', actor: 'admin', transport: 'local' }).operation;
    expect(s.finish(lost.id, { state: 'completion_unknown' })).toMatchObject({ errorClass: 'interrupted' });
  });

  it('refuses a failed or partial ending without a known error class, even from untyped data', () => {
    const s = new ops.RecoveryOperationStore('epoch-a');
    const op = s.start({ idempotencyKey: key(), kind: 'verify_point', actor: 'admin', transport: 'local' }).operation;
    expect(classOf(() => s.finish(op.id, { state: 'failed' } as never))).toBe('invalid_request');
    expect(classOf(() => s.finish(op.id, { state: 'partial', errorClass: 'whatever' } as never))).toBe('invalid_request');
    expect(s.get(op.id)?.state).toBe('queued');
  });

  it('settles its pending points when an operation ends any other way', () => {
    const s = new ops.RecoveryOperationStore('epoch-a');
    const st = storage('settle_points');
    const repo = repository('settle_points_repo');
    const failing = s.start({ idempotencyKey: key(), kind: 'create_point', storageId: st.id, actor: 'admin', transport: 'local' }).operation;
    const failedPoint = beginPoint(st.id, 'g', repo.id, failing.id);
    s.finish(failing.id, { state: 'failed', errorClass: 'source_unreadable' });
    expect(points.RecoveryPointStore.getInstance().get(failedPoint.id)).toMatchObject({ status: 'failed', failureClass: 'source_unreadable' });
    for (const ending of [{ state: 'cancelled' as const }, { state: 'completion_unknown' as const }]) {
      const op = s.start({ idempotencyKey: key(), kind: 'create_point', storageId: st.id, actor: 'admin', transport: 'local' }).operation;
      const p = beginPoint(st.id, 'g', repo.id, op.id);
      s.finish(op.id, ending);
      expect(points.RecoveryPointStore.getInstance().get(p.id)).toMatchObject({ status: 'completion_unknown', failureClass: 'interrupted' });
    }
    // Another operation's pending point is left alone and can still finish.
    const bystander = s.start({ idempotencyKey: key(), kind: 'create_point', storageId: st.id, actor: 'admin', transport: 'local' }).operation;
    const bystanderPoint = beginPoint(st.id, 'g', repo.id, bystander.id);
    const another = s.start({ idempotencyKey: key(), kind: 'create_point', storageId: st.id, actor: 'admin', transport: 'local' }).operation;
    s.finish(another.id, { state: 'failed', errorClass: 'internal' });
    const third = s.start({ idempotencyKey: key(), kind: 'create_point', storageId: st.id, actor: 'admin', transport: 'local' }).operation;
    s.finish(third.id, { state: 'cancelled' });
    expect(points.RecoveryPointStore.getInstance().get(bystanderPoint.id)?.status).toBe('pending');
    expect(points.RecoveryPointStore.getInstance().finalize(bystanderPoint.id, { status: 'succeeded', evidence: evidence() }).status).toBe('succeeded');
    // A late success for the settled point is refused.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(classOf(() => points.RecoveryPointStore.getInstance().finalize(failedPoint.id, { status: 'succeeded', evidence: evidence() }))).toBe('invalid_request');
    warn.mockRestore();
  });

  it('refuses to finish succeeded or partial while a point of the operation is pending', () => {
    const s = new ops.RecoveryOperationStore('epoch-a');
    const st = storage('finish_guard');
    const repo = repository('finish_guard_repo');
    const op = s.start({ idempotencyKey: key(), kind: 'create_point', storageId: st.id, actor: 'admin', transport: 'local' }).operation;
    const p = beginPoint(st.id, 'g', repo.id, op.id);
    expect(classOf(() => s.finish(op.id, { state: 'succeeded' }))).toBe('invalid_request');
    expect(classOf(() => s.finish(op.id, { state: 'partial', errorClass: 'source_unreadable' }))).toBe('invalid_request');
    expect(s.get(op.id)?.state).toBe('queued');
    points.RecoveryPointStore.getInstance().finalize(p.id, { status: 'succeeded', evidence: evidence() });
    expect(s.finish(op.id, { state: 'succeeded' }).state).toBe('succeeded');
  });
});

describe('locks', () => {
  it('admits one owner per storage, lets the owner re-acquire, and releases on a known outcome', () => {
    const s = new ops.RecoveryOperationStore('epoch-b');
    const st = storage('lock_one');
    const repo = repository('lock_one_repo');
    const a = s.start({ idempotencyKey: key(), kind: 'create_point', actor: 'admin', transport: 'local' }).operation;
    const b = s.start({ idempotencyKey: key(), kind: 'restore', actor: 'admin', transport: 'local' }).operation;
    const lock = s.acquireLock('storage', st.storageKey, a.id);
    expect(lock).toMatchObject({ scope: 'storage', ownerOperationId: a.id, staleSince: null, processEpoch: 'epoch-b' });
    expect(s.acquireLock('storage', st.storageKey, a.id)).toEqual(lock);
    expect(classOf(() => s.acquireLock('storage', st.storageKey, b.id))).toBe('lock_held');
    expect(s.acquireLock('repository', repo.id, b.id).ownerOperationId).toBe(b.id);
    s.finish(a.id, { state: 'succeeded' });
    expect(s.getLock('storage', st.storageKey)).toBeNull();
    expect(s.acquireLock('storage', st.storageKey, b.id).ownerOperationId).toBe(b.id);
  });

  it('refuses a lock on a key that names no storage or repository', () => {
    const s = new ops.RecoveryOperationStore('epoch-b');
    const st = storage('lock_target');
    const a = s.start({ idempotencyKey: key(), kind: 'create_point', actor: 'admin', transport: 'local' }).operation;
    // A generation id is not the storage key: locking it would not exclude the real lock.
    expect(classOf(() => s.acquireLock('storage', st.id, a.id))).toBe('invalid_request');
    expect(classOf(() => s.acquireLock('repository', st.storageKey, a.id))).toBe('invalid_request');
  });

  it('refuses a lock for an operation that already finished', () => {
    const s = new ops.RecoveryOperationStore('epoch-b');
    const st = storage('lock_done');
    const a = s.start({ idempotencyKey: key(), kind: 'create_point', actor: 'admin', transport: 'local' }).operation;
    s.finish(a.id, { state: 'cancelled' });
    expect(classOf(() => s.acquireLock('storage', st.storageKey, a.id))).toBe('invalid_request');
  });

  it('turns locks stale when the outcome is unknown, and only a reviewed release clears them', () => {
    const s = new ops.RecoveryOperationStore('epoch-b');
    const st = storage('lock_unknown');
    const a = s.start({ idempotencyKey: key(), kind: 'restore', actor: 'admin', transport: 'local' }).operation;
    const next = s.start({ idempotencyKey: key(), kind: 'restore', actor: 'admin', transport: 'local' }).operation;
    s.acquireLock('storage', st.storageKey, a.id);
    s.finish(a.id, { state: 'completion_unknown' }, 50);
    expect(s.getLock('storage', st.storageKey)?.staleSince).toBe(50);
    expect(classOf(() => s.acquireLock('storage', st.storageKey, next.id))).toBe('lock_stale');
    expect(classOf(() => s.releaseStaleLock('storage', 'no-such-lock', 'admin'))).toBe('invalid_request');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(s.releaseStaleLock('storage', st.storageKey, 'admin').ownerOperationId).toBe(a.id);
    warn.mockRestore();
    expect(s.acquireLock('storage', st.storageKey, next.id).ownerOperationId).toBe(next.id);
    // A live lock is never released by the review path.
    expect(classOf(() => s.releaseStaleLock('storage', st.storageKey, 'admin'))).toBe('invalid_request');
  });
});

describe('restart reconciliation', () => {
  it('ends what the previous process left running as completion_unknown, with stale locks and unknown points', () => {
    const before = new ops.RecoveryOperationStore('epoch-old');
    const st = storage('restart_data');
    const repo = repository('restart_repo');
    const running = before.start({ idempotencyKey: key(), kind: 'create_point', storageId: st.id, actor: 'admin', transport: 'local' }).operation;
    before.markRunning(running.id);
    before.acquireLock('storage', st.storageKey, running.id);
    const queued = before.start({ idempotencyKey: key(), kind: 'verify_point', actor: 'admin', transport: 'local' }).operation;
    const done = before.start({ idempotencyKey: key(), kind: 'verify_point', actor: 'admin', transport: 'local' }).operation;
    before.finish(done.id, { state: 'succeeded' });
    const pending = beginPoint(st.id, 'g', repo.id, running.id);
    const orphan = beginPoint(st.id, 'g', repo.id, 'never-recorded');

    const db = recoveryDb();
    const expectedOps = (db.prepare(
      "SELECT COUNT(*) AS n FROM recovery_operations WHERE state IN ('queued','running') AND process_epoch <> 'epoch-new'",
    ).get() as { n: number }).n;
    const expectedPoints = (db.prepare("SELECT COUNT(*) AS n FROM recovery_points WHERE status = 'pending'").get() as { n: number }).n;
    const expectedLocks = (db.prepare(
      "SELECT COUNT(*) AS n FROM recovery_locks WHERE process_epoch <> 'epoch-new' AND stale_since IS NULL",
    ).get() as { n: number }).n;

    // The process dies here. The next one boots with a new epoch.
    const after = new ops.RecoveryOperationStore('epoch-new');
    expect(after.reconcileAtStartup(9_000)).toEqual({
      interruptedOperations: expectedOps, unknownPoints: expectedPoints, staleLocks: expectedLocks,
    });

    expect(after.get(running.id)).toMatchObject({ state: 'completion_unknown', errorClass: 'interrupted', completedAt: 9_000 });
    expect(after.get(queued.id)?.state).toBe('completion_unknown');
    expect(after.get(done.id)?.state).toBe('succeeded');
    expect(points.RecoveryPointStore.getInstance().get(pending.id)).toMatchObject({ status: 'completion_unknown', failureClass: 'interrupted' });
    expect(points.RecoveryPointStore.getInstance().get(orphan.id)?.status).toBe('completion_unknown');
    expect(after.getLock('storage', st.storageKey)?.staleSince).toBe(9_000);

    // Completions from the dead process arriving late change nothing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(after.finish(running.id, { state: 'succeeded' }).state).toBe('completion_unknown');
    expect(classOf(() => points.RecoveryPointStore.getInstance().finalize(pending.id, { status: 'succeeded', evidence: evidence() }))).toBe('invalid_request');
    warn.mockRestore();
    expect(points.RecoveryPointStore.getInstance().get(pending.id)?.status).toBe('completion_unknown');

    // Replaying the original request returns the interrupted operation, not a fresh run.
    const replay = after.start({ idempotencyKey: running.idempotencyKey, kind: 'create_point', storageId: st.id, actor: 'admin', transport: 'local' });
    expect(replay).toMatchObject({ replayed: true, operation: { id: running.id, state: 'completion_unknown' } });

    // New work on that storage waits for a reviewed release.
    const fresh = after.start({ idempotencyKey: key(), kind: 'create_point', storageId: st.id, actor: 'admin', transport: 'local' }).operation;
    expect(classOf(() => after.acquireLock('storage', st.storageKey, fresh.id))).toBe('lock_stale');

    // Running it again in the same process changes nothing, even for a point
    // this process has begun under an operation it has not recorded yet.
    const early = beginPoint(st.id, 'g', repo.id, 'not-recorded-yet');
    expect(after.reconcileAtStartup(10_000)).toEqual({ interruptedOperations: 0, unknownPoints: 0, staleLocks: 0 });
    expect(points.RecoveryPointStore.getInstance().get(early.id)?.status).toBe('pending');
  });

  it('keeps a dead process\'s work closed even when reconciliation never ran', () => {
    const before = new ops.RecoveryOperationStore('epoch-crashed');
    const st = storage('unreconciled_data');
    const repo = repository('unreconciled_repo');
    const running = before.start({ idempotencyKey: key(), kind: 'restore', storageId: st.id, actor: 'admin', transport: 'local' }).operation;
    before.markRunning(running.id);
    before.acquireLock('storage', st.storageKey, running.id);
    const pending = beginPoint(st.id, 'g', repo.id, running.id);

    const queued = before.start({ idempotencyKey: key(), kind: 'restore', storageId: st.id, actor: 'admin', transport: 'local' }).operation;

    const after = new ops.RecoveryOperationStore('epoch-without-reconcile');
    // Neither a queued nor a running operation of the dead process can be started here.
    expect(classOf(() => after.markRunning(queued.id))).toBe('invalid_request');
    expect(after.get(queued.id)).toMatchObject({ state: 'queued', processEpoch: 'epoch-crashed' });
    // A replayed request gets the old operation back, but cannot pick it up.
    expect(after.start({ idempotencyKey: running.idempotencyKey, kind: 'restore', storageId: st.id, actor: 'admin', transport: 'local' }).replayed).toBe(true);
    expect(classOf(() => after.markRunning(running.id))).toBe('invalid_request');
    expect(classOf(() => after.acquireLock('storage', st.storageKey, running.id))).toBe('lock_stale');
    const other = after.start({ idempotencyKey: key(), kind: 'restore', storageId: st.id, actor: 'admin', transport: 'local' }).operation;
    expect(classOf(() => after.acquireLock('storage', st.storageKey, other.id))).toBe('lock_stale');

    // Nor can it be finished here: no ending records an outcome for the dead
    // process's restore, releases its lock or settles its point.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const ending of [
      { state: 'succeeded' as const },
      { state: 'failed' as const, errorClass: 'internal' as const },
      { state: 'cancelled' as const },
      { state: 'completion_unknown' as const },
    ]) {
      expect(classOf(() => after.finish(running.id, ending))).toBe('invalid_request');
      expect(classOf(() => after.finish(queued.id, ending))).toBe('invalid_request');
      expect(after.get(running.id)).toMatchObject({ state: 'running', errorClass: null, completedAt: null, processEpoch: 'epoch-crashed' });
      expect(after.get(queued.id)).toMatchObject({ state: 'queued', errorClass: null, completedAt: null });
      expect(after.getLock('storage', st.storageKey)).toMatchObject({ ownerOperationId: running.id, staleSince: null, processEpoch: 'epoch-crashed' });
      expect(points.RecoveryPointStore.getInstance().get(pending.id)?.status).toBe('pending');
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Refused'), 'succeeded', running.id, 'running');
    warn.mockRestore();

    // It cannot take a lock for the dead process's operation either, with or without an existing lock.
    const free = storage('unreconciled_free');
    expect(classOf(() => after.acquireLock('storage', free.storageKey, queued.id))).toBe('invalid_request');
    expect(after.getLock('storage', free.storageKey)).toBeNull();

    // A later boot settles it; only then does the lock become stale.
    new ops.RecoveryOperationStore('epoch-after-crash').reconcileAtStartup(5_000);
    expect(after.get(running.id)).toMatchObject({ state: 'completion_unknown', completedAt: 5_000 });
    expect(after.getLock('storage', st.storageKey)?.staleSince).toBe(5_000);
  });

  it('lets the first committed ending win when a completion races reconciliation', () => {
    const st = storage('race_data');
    const owner = new ops.RecoveryOperationStore('epoch-race-old');
    const op = owner.start({ idempotencyKey: key(), kind: 'restore', storageId: st.id, actor: 'admin', transport: 'local' }).operation;
    owner.markRunning(op.id);
    owner.acquireLock('storage', st.storageKey, op.id);

    // The old process read the operation as running, and the new process's
    // reconcile commits before the old one's write: the reconcile wins.
    const stale = owner.get(op.id) as NonNullable<ReturnType<typeof owner.get>>;
    new ops.RecoveryOperationStore('epoch-race-new').reconcileAtStartup(7_000);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(owner, 'get').mockReturnValueOnce(stale);
    expect(owner.finish(op.id, { state: 'succeeded' }, 8_000)).toMatchObject({ state: 'completion_unknown', errorClass: 'interrupted', completedAt: 7_000 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('late'), 'succeeded', 'no class', op.id, 'completion_unknown', 'interrupted');
    warn.mockRestore();
    expect(owner.getLock('storage', st.storageKey)?.staleSince).toBe(7_000);

    // The other order: the completion commits first and a later reconcile leaves it alone.
    const st2 = storage('race_data_two');
    const second = owner.start({ idempotencyKey: key(), kind: 'restore', storageId: st2.id, actor: 'admin', transport: 'local' }).operation;
    owner.markRunning(second.id);
    owner.finish(second.id, { state: 'succeeded' }, 9_000);
    new ops.RecoveryOperationStore('epoch-race-newer').reconcileAtStartup(10_000);
    expect(owner.get(second.id)).toMatchObject({ state: 'succeeded', errorClass: null, completedAt: 9_000 });
  });

  it('keeps a point finalized before the crash, while its operation ends completion_unknown', () => {
    const before = new ops.RecoveryOperationStore('epoch-crash-a');
    const st = storage('crash_after_point');
    const repo = repository('crash_after_point_repo');
    const op = before.start({ idempotencyKey: key(), kind: 'create_point', storageId: st.id, actor: 'admin', transport: 'local' }).operation;
    before.markRunning(op.id);
    const p = beginPoint(st.id, 'g', repo.id, op.id);
    points.RecoveryPointStore.getInstance().finalize(p.id, { status: 'succeeded', evidence: evidence() });
    // Dies before the operation finishes.
    new ops.RecoveryOperationStore('epoch-crash-a-next').reconcileAtStartup();
    expect(points.RecoveryPointStore.getInstance().get(p.id)?.status).toBe('succeeded');
    expect(before.get(op.id)?.state).toBe('completion_unknown');
  });

  it('leaves the current process\'s own operations and their pending points alone', () => {
    const s = new ops.RecoveryOperationStore('epoch-live');
    const st = storage('live_data');
    const repo = repository('live_repo');
    const live = s.start({ idempotencyKey: key(), kind: 'create_point', storageId: st.id, actor: 'admin', transport: 'local' }).operation;
    s.markRunning(live.id);
    s.acquireLock('storage', st.storageKey, live.id);
    const p = beginPoint(st.id, 'g', repo.id, live.id);
    s.reconcileAtStartup();
    expect(s.get(live.id)?.state).toBe('running');
    expect(s.getLock('storage', st.storageKey)?.staleSince).toBeNull();
    expect(points.RecoveryPointStore.getInstance().get(p.id)?.status).toBe('pending');
  });
});
