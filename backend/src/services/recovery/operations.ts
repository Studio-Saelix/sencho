import { randomUUID } from 'crypto';
import { sanitizeForLog } from '../../utils/safeLog';
import { recoveryDb } from './recoveryDb';
import { errorDetailFor, isRecoveryErrorClass, RecoveryError } from './redaction';
import { TERMINAL_OPERATION_STATES } from './types';
import type {
  OperationFinish,
  RecoveryErrorClass,
  RecoveryLock,
  RecoveryLockScope,
  RecoveryOperation,
  RecoveryOperationKind,
  RecoveryOperationState,
  RecoveryTransport,
} from './types';

/**
 * Durable recovery operations and the storage and repository locks they hold.
 *
 * Restart safety rests on the process epoch, a random id minted once per
 * process. Every operation and lock records the epoch that owns it. At boot,
 * anything still `queued` or `running` under another epoch was interrupted: it
 * becomes `completion_unknown` (never success, never silently retried), its
 * pending points become `completion_unknown`, and its locks turn stale. A stale
 * lock keeps the storage closed to new work until someone releases it on
 * purpose, because an interrupted restore may have left the data half written.
 *
 * Replays are safe: a request carries an idempotency key, and the same key
 * returns the operation it already created instead of starting a second one.
 * The key is honored only for the same request from the same actor over the
 * same transport; anything else is refused rather than handed someone else's
 * operation.
 *
 * Work left by a dead process can never be resumed or completed in place:
 * `markRunning`, `finish`, a lock owner's re-acquire and a new lock for that
 * operation all require the current epoch, so even if boot reconciliation
 * failed, an interrupted operation keeps its state and its locks until a later
 * boot settles them (after which a stale lock can be released on review).
 * Every terminal write is conditional on the operation still being `queued` or
 * `running`, so whichever of `finish` and reconciliation commits first wins.
 */

interface OperationRow {
  id: string;
  idempotency_key: string;
  kind: RecoveryOperationKind;
  storage_id: string | null;
  point_id: string | null;
  actor: string;
  transport: RecoveryTransport;
  state: RecoveryOperationState;
  error_class: RecoveryErrorClass | null;
  request_digest: string | null;
  process_epoch: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

interface LockRow {
  scope: RecoveryLockScope;
  resource_key: string;
  owner_operation_id: string;
  process_epoch: string;
  acquired_at: number;
  stale_since: number | null;
}

function toOperation(row: OperationRow): RecoveryOperation {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    kind: row.kind,
    storageId: row.storage_id,
    pointId: row.point_id,
    actor: row.actor,
    transport: row.transport,
    state: row.state,
    errorClass: row.error_class,
    errorDetail: row.error_class ? errorDetailFor(row.error_class) : null,
    processEpoch: row.process_epoch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function toLock(row: LockRow): RecoveryLock {
  return {
    scope: row.scope,
    resourceKey: row.resource_key,
    ownerOperationId: row.owner_operation_id,
    processEpoch: row.process_epoch,
    acquiredAt: row.acquired_at,
    staleSince: row.stale_since,
  };
}

const isTerminal = (state: RecoveryOperationState): boolean => TERMINAL_OPERATION_STATES.some((t) => t === state);

export interface StartOperationInput {
  idempotencyKey: string;
  kind: RecoveryOperationKind;
  storageId?: string | null;
  pointId?: string | null;
  actor: string;
  transport: RecoveryTransport;
  /**
   * sha256 of the canonical request this operation is for (the storage, the
   * method, the target name). A replay with the same key but a different request
   * is a different operation and is refused, so one key can never answer for two
   * requests. Required for a new row; an operation created before schema v2 has
   * no digest and only matches a replay that carries none.
   */
  requestDigest?: string | null;
}

/** What a caller supplies to look up a replay before it validates the request again. */
export interface ReplayLookup {
  idempotencyKey: string;
  kind: RecoveryOperationKind;
  actor: string;
  transport: RecoveryTransport;
  requestDigest?: string | null;
  pointId?: string | null;
}

export interface StartedOperation {
  operation: RecoveryOperation;
  /** True when the key matched an operation an earlier request created. */
  replayed: boolean;
}

export interface StartupReconciliation {
  interruptedOperations: number;
  unknownPoints: number;
  staleLocks: number;
}

export class RecoveryOperationStore {
  private static instance: RecoveryOperationStore;
  readonly processEpoch: string;
  private reconciled = false;

  constructor(processEpoch: string = randomUUID()) {
    this.processEpoch = processEpoch;
  }

  static getInstance(): RecoveryOperationStore {
    if (!RecoveryOperationStore.instance) RecoveryOperationStore.instance = new RecoveryOperationStore();
    return RecoveryOperationStore.instance;
  }

  start(input: StartOperationInput, now = Date.now()): StartedOperation {
    const key = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
    if (key === '' || key.length > 200) throw new RecoveryError('invalid_request');
    const storageId = input.storageId ?? null;
    const pointId = input.pointId ?? null;
    const requestDigest = input.requestDigest ?? null;
    if (requestDigest !== null && !/^[0-9a-f]{64}$/.test(requestDigest)) throw new RecoveryError('invalid_request');
    const db = recoveryDb();
    return db.transaction((): StartedOperation => {
      const existing = db.prepare('SELECT * FROM recovery_operations WHERE idempotency_key = ?').get(key) as OperationRow | undefined;
      if (existing) {
        // The same key for a different request, actor or transport is not a replay.
        if (existing.kind !== input.kind || existing.storage_id !== storageId || existing.point_id !== pointId
          || existing.actor !== input.actor || existing.transport !== input.transport
          || (existing.request_digest ?? null) !== requestDigest) {
          throw new RecoveryError('invalid_request');
        }
        return { operation: toOperation(existing), replayed: true };
      }
      const id = randomUUID();
      db.prepare(`
        INSERT INTO recovery_operations
          (id, idempotency_key, kind, storage_id, point_id, actor, transport, state, request_digest,
           process_epoch, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
      `).run(id, key, input.kind, storageId, pointId, input.actor, input.transport, requestDigest, this.processEpoch, now, now);
      return { operation: this.require(id), replayed: false };
    }).immediate();
  }

  /**
   * Admit an operation: record it, mark it running and take every lock it needs,
   * as one step. A refusal at any point (a held or stale lock, a second restore
   * into the same target) rolls the whole step back, so a refused request leaves
   * no operation behind. That matters for retries: the idempotency key of a
   * request that was answered `409` is still free, and the same request can be
   * sent again once the lock is gone instead of replaying a failure that never
   * ran. `setup` runs inside the same step, after the locks, for rows that must
   * exist if and only if the operation is admitted.
   */
  admit<T = void>(
    input: StartOperationInput,
    locks: ReadonlyArray<{ scope: RecoveryLockScope; resourceKey: string }>,
    setup?: (operation: RecoveryOperation) => T,
    now = Date.now(),
  ): StartedOperation & { setup: T | undefined } {
    return recoveryDb().transaction((): StartedOperation & { setup: T | undefined } => {
      const started = this.start(input, now);
      if (started.replayed) return { ...started, setup: undefined };
      const operationId = started.operation.id;
      this.markRunning(operationId, now);
      for (const lock of locks) this.acquireLock(lock.scope, lock.resourceKey, operationId, now);
      const prepared = setup ? setup(this.require(operationId)) : undefined;
      return { operation: this.require(operationId), replayed: false, setup: prepared };
    }).immediate();
  }

  /**
   * The operation an earlier request with this key created, or null when there is
   * none or it belongs to a different request. A route uses this before its own
   * validation, so a retry after a lost response returns the work that is already
   * running instead of failing on state that work has since changed (a restore
   * target that now exists, for instance).
   */
  findReplay(lookup: ReplayLookup): RecoveryOperation | null {
    const key = typeof lookup.idempotencyKey === 'string' ? lookup.idempotencyKey.trim() : '';
    if (key === '') return null;
    const row = recoveryDb().prepare('SELECT * FROM recovery_operations WHERE idempotency_key = ?')
      .get(key) as OperationRow | undefined;
    if (!row) return null;
    if (row.kind !== lookup.kind || row.actor !== lookup.actor || row.transport !== lookup.transport) return null;
    if ((row.request_digest ?? null) !== (lookup.requestDigest ?? null)) return null;
    if (lookup.pointId !== undefined && row.point_id !== lookup.pointId) return null;
    return toOperation(row);
  }

  get(id: string): RecoveryOperation | null {
    const row = recoveryDb().prepare('SELECT * FROM recovery_operations WHERE id = ?').get(id) as OperationRow | undefined;
    return row ? toOperation(row) : null;
  }

  /**
   * Move an operation this process queued to running. Running one this process
   * already moved is a no-op replay. An operation queued or running under
   * another process is refused: it waits for boot reconciliation, never runs here.
   */
  markRunning(id: string, now = Date.now()): RecoveryOperation {
    const result = recoveryDb().prepare(`
      UPDATE recovery_operations SET state = 'running', updated_at = ?
      WHERE id = ? AND state = 'queued' AND process_epoch = ?
    `).run(now, id, this.processEpoch);
    const op = this.require(id);
    if (result.changes > 0 || (op.state === 'running' && op.processEpoch === this.processEpoch)) return op;
    if (!isTerminal(op.state) && op.processEpoch !== this.processEpoch) this.refuseOtherProcess('run', op);
    throw new RecoveryError('invalid_request');
  }

  /**
   * Record the one terminal state. A finished operation is never rewritten, so
   * a late or duplicated completion cannot turn a failure into a success; one
   * that disagrees with the stored outcome is logged. Only the process that owns
   * the operation can finish it: another process's `queued` or `running`
   * operation is refused and keeps its state and its locks until boot
   * reconciliation settles it. The write is conditional on the operation still
   * being live and owned by this process, so a completion that loses a race
   * with reconciliation changes nothing. An operation cannot end `succeeded`
   * or `partial` while one of its points is still pending: the point is
   * finalized first. Any other ending
   * settles the operation's own pending points in the same transaction
   * (`failed` with the operation's class, otherwise `completion_unknown`). A
   * point begun after its operation finished stays pending until the next boot
   * settles it.
   * Locks are released on a known outcome and turned stale on
   * `completion_unknown`, which needs review before the storage is reused.
   * The returned operation is the stored one: a caller reports its `state`, not
   * the outcome it asked for.
   */
  finish(id: string, outcome: OperationFinish, now = Date.now()): RecoveryOperation {
    // The union already fixes these rules; they hold for a caller that built
    // the outcome from untyped data. Only an ending in `failed` or `partial`
    // carries the caller's class, and a live state is not an ending.
    if (!isTerminal(outcome.state)) throw new RecoveryError('invalid_request');
    let errorClass: RecoveryErrorClass | null = null;
    if (outcome.state === 'failed' || outcome.state === 'partial') {
      errorClass = outcome.errorClass;
      if (!isRecoveryErrorClass(errorClass)) throw new RecoveryError('invalid_request');
    } else if (outcome.state === 'completion_unknown') {
      errorClass = 'interrupted';
    }
    // These endings need the operation's points finalized first; the rest settle them.
    const pointsFinalizedFirst = outcome.state === 'succeeded' || outcome.state === 'partial';
    const db = recoveryDb();
    const logLate = (stored: RecoveryOperation): void => {
      if (stored.state !== outcome.state || stored.errorClass !== errorClass) {
        console.warn(
          '[Recovery] Ignored a late %s (%s) completion for operation %s, already %s (%s)',
          outcome.state, errorClass ?? 'no class', id, stored.state, stored.errorClass ?? 'no class',
        );
      }
    };
    // Immediate, so a second process finishing or reconciling the same row
    // waits for this write and then finds it terminal, instead of failing on
    // the upgrade from a read to a write. Every transaction here that reads
    // before it writes is immediate for the same reason.
    return db.transaction((): RecoveryOperation => {
      const current = this.require(id);
      if (isTerminal(current.state)) {
        logLate(current);
        return current;
      }
      if (current.processEpoch !== this.processEpoch) this.refuseOtherProcess('finish', current);
      if (pointsFinalizedFirst) {
        const pending = db.prepare(
          "SELECT 1 FROM recovery_points WHERE source_operation_id = ? AND status = 'pending'",
        ).get(id);
        if (pending) throw new RecoveryError('invalid_request');
      }
      const ended = db.prepare(`
        UPDATE recovery_operations SET state = ?, error_class = ?, updated_at = ?, completed_at = ?
        WHERE id = ? AND state IN ('queued','running') AND process_epoch = ?
      `).run(outcome.state, errorClass, now, now, id, this.processEpoch);
      if (ended.changes === 0) {
        // Defensive: the transaction holds the write lock from its start,
        // so this is not reachable today. If another writer did end the
        // operation after it was read, its outcome and its locks stand. An
        // operation that is still live was not ours to end (the write also
        // requires this process's epoch), so it is refused like any other
        // process's work.
        const stored = this.require(id);
        if (!isTerminal(stored.state)) this.refuseOtherProcess('finish', stored);
        logLate(stored);
        return stored;
      }
      if (outcome.state === 'failed') {
        db.prepare(`
          UPDATE recovery_points SET status = 'failed', failure_class = ?, completed_at = ?
          WHERE source_operation_id = ? AND status = 'pending'
        `).run(errorClass, now, id);
      } else if (!pointsFinalizedFirst) {
        db.prepare(`
          UPDATE recovery_points SET status = 'completion_unknown', failure_class = 'interrupted', completed_at = ?
          WHERE source_operation_id = ? AND status = 'pending'
        `).run(now, id);
      }
      if (outcome.state === 'completion_unknown') {
        db.prepare('UPDATE recovery_locks SET stale_since = ? WHERE owner_operation_id = ? AND stale_since IS NULL').run(now, id);
      } else {
        db.prepare('DELETE FROM recovery_locks WHERE owner_operation_id = ?').run(id);
      }
      return this.require(id);
    }).immediate();
  }

  /**
   * Take the lock for one storage (keyed by its storage key, which is the same
   * for every generation) or one repository (keyed by its id); a key that names
   * neither is refused, so a lock taken on the wrong id cannot sit beside the
   * real one. The owner taking it again in this process is a replay and
   * succeeds; anyone else gets `lock_held`, and a lock that is stale or left by
   * a dead process gets `lock_stale`. An operation a dead process left is never
   * given a lock here, even when none exists: it is refused as `interrupted`.
   */
  acquireLock(scope: RecoveryLockScope, resourceKey: string, operationId: string, now = Date.now()): RecoveryLock {
    const db = recoveryDb();
    return db.transaction((): RecoveryLock => {
      const op = this.require(operationId);
      if (isTerminal(op.state)) throw new RecoveryError('invalid_request');
      const target = scope === 'storage'
        ? db.prepare('SELECT 1 FROM recovery_storage_identities WHERE storage_key = ? LIMIT 1').get(resourceKey)
        : db.prepare('SELECT 1 FROM recovery_repositories WHERE id = ?').get(resourceKey);
      if (!target) throw new RecoveryError('invalid_request');
      const existing = this.findLockRow(scope, resourceKey);
      if (existing) {
        if (existing.stale_since !== null || existing.process_epoch !== this.processEpoch) {
          throw new RecoveryError('lock_stale');
        }
        if (existing.owner_operation_id !== operationId) throw new RecoveryError('lock_held');
        return toLock(existing);
      }
      // A dead process's operation can never take a lock here, even if boot reconciliation failed.
      if (op.processEpoch !== this.processEpoch) this.refuseOtherProcess('take a lock for', op);
      db.prepare(`
        INSERT INTO recovery_locks (scope, resource_key, owner_operation_id, process_epoch, acquired_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(scope, resourceKey, operationId, this.processEpoch, now);
      return toLock(this.findLockRow(scope, resourceKey) as LockRow);
    }).immediate();
  }

  getLock(scope: RecoveryLockScope, resourceKey: string): RecoveryLock | null {
    const row = this.findLockRow(scope, resourceKey);
    return row ? toLock(row) : null;
  }

  /**
   * Release a stale lock after someone has reviewed the interrupted operation.
   * A live lock is never released here: its owner releases it by finishing.
   */
  releaseStaleLock(scope: RecoveryLockScope, resourceKey: string, reviewedBy: string): RecoveryLock {
    const db = recoveryDb();
    return db.transaction((): RecoveryLock => {
      const row = this.findLockRow(scope, resourceKey);
      if (!row || row.stale_since === null) throw new RecoveryError('invalid_request');
      db.prepare('DELETE FROM recovery_locks WHERE scope = ? AND resource_key = ?').run(scope, resourceKey);
      console.warn(
        '[Recovery] Stale %s lock released after review by %s (operation %s)',
        scope, sanitizeForLog(reviewedBy), row.owner_operation_id,
      );
      return toLock(row);
    }).immediate();
  }

  /**
   * Release the repository locks that interrupted work left, once the helpers of
   * the dead process are gone. Captures, checks and restores only read or append
   * to the active repository: once restic's own locks are cleared (`activeId` is
   * set) an interrupted one leaves its point or its target volume settled by their
   * own records, and nothing in the repository that needs a person's review. A
   * provisioning operation is released on any repository, because the next
   * provision request continues a half-made repository and takes the lock itself;
   * with no active repository to unlock there is nothing else to wait for. Every
   * storage lock stays until it is released on purpose.
   */
  releaseInterruptedRepositoryLocks(activeId: string | null): number {
    return recoveryDb().prepare(`
      DELETE FROM recovery_locks
      WHERE scope = 'repository' AND stale_since IS NOT NULL
        AND owner_operation_id IN (
          SELECT id FROM recovery_operations
          WHERE kind = 'repository_init'
             OR (? IS NOT NULL AND recovery_locks.resource_key = ?
                 AND kind IN ('create_point','verify_point','restore'))
        )
    `).run(activeId, activeId).changes;
  }

  /** Whether any repository lock is stale, for the log line boot writes when it releases none. */
  hasStaleRepositoryLock(): boolean {
    return recoveryDb().prepare(
      `SELECT 1 FROM recovery_locks WHERE scope = 'repository' AND stale_since IS NOT NULL LIMIT 1`,
    ).get() !== undefined;
  }

  /**
   * Settle what a previous process left behind. Run at boot, before any new
   * recovery work; a second call in the same process does nothing, so it can
   * never mistake this process's own pending work for a dead process's.
   */
  reconcileAtStartup(now = Date.now()): StartupReconciliation {
    if (this.reconciled) return { interruptedOperations: 0, unknownPoints: 0, staleLocks: 0 };
    const db = recoveryDb();
    const settled = db.transaction((): StartupReconciliation => {
      // One conditional statement, so an operation that already reached a
      // terminal state is never rewritten.
      const interruptedOperations = db.prepare(`
        UPDATE recovery_operations
        SET state = 'completion_unknown', error_class = 'interrupted', updated_at = ?, completed_at = ?
        WHERE state IN ('queued','running') AND process_epoch <> ?
      `).run(now, now, this.processEpoch).changes;
      // A pending point whose operation is no longer live was cut off mid-capture,
      // including one whose operation row was never written.
      const unknownPoints = db.prepare(`
        UPDATE recovery_points SET status = 'completion_unknown', failure_class = 'interrupted', completed_at = ?
        WHERE status = 'pending' AND source_operation_id NOT IN (
          SELECT id FROM recovery_operations WHERE state IN ('queued','running')
        )
      `).run(now).changes;
      const staleLocks = db.prepare(`
        UPDATE recovery_locks SET stale_since = ? WHERE process_epoch <> ? AND stale_since IS NULL
      `).run(now, this.processEpoch).changes;
      return { interruptedOperations, unknownPoints, staleLocks };
    }).immediate();
    this.reconciled = true;
    return settled;
  }

  private findLockRow(scope: RecoveryLockScope, resourceKey: string): LockRow | undefined {
    return recoveryDb().prepare(
      'SELECT * FROM recovery_locks WHERE scope = ? AND resource_key = ?',
    ).get(scope, resourceKey) as LockRow | undefined;
  }

  /**
   * An operation a dead process left queued or running is never moved to
   * running, finished or locked here; it waits for boot reconciliation.
   * Reported as `interrupted`, which is what happened to it.
   */
  private refuseOtherProcess(action: string, op: RecoveryOperation): never {
    console.warn('[Recovery] Refused to %s operation %s: it is %s under another process', action, op.id, op.state);
    throw new RecoveryError('interrupted');
  }

  private require(id: string): RecoveryOperation {
    const op = this.get(id);
    if (!op) throw new RecoveryError('invalid_request');
    return op;
  }
}
