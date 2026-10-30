import { randomUUID } from 'crypto';
import { sanitizeForLog } from '../../utils/safeLog';
import { recoveryDb } from './recoveryDb';
import { errorDetailFor, RecoveryError } from './redaction';
import { TERMINAL_OPERATION_STATES } from './types';
import type {
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

const isTerminal = (state: RecoveryOperationState): boolean => TERMINAL_OPERATION_STATES.includes(state);

export interface StartOperationInput {
  idempotencyKey: string;
  kind: RecoveryOperationKind;
  storageId?: string | null;
  pointId?: string | null;
  actor: string;
  transport: RecoveryTransport;
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

export type FinishState = Exclude<RecoveryOperationState, 'queued' | 'running'>;

export class RecoveryOperationStore {
  private static instance: RecoveryOperationStore;
  readonly processEpoch: string;

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
    const db = recoveryDb();
    return db.transaction((): StartedOperation => {
      const existing = db.prepare('SELECT * FROM recovery_operations WHERE idempotency_key = ?').get(key) as OperationRow | undefined;
      if (existing) {
        // The same key for a different request is a client bug, not a replay.
        if (existing.kind !== input.kind || existing.storage_id !== storageId || existing.point_id !== pointId) {
          throw new RecoveryError('invalid_request');
        }
        return { operation: toOperation(existing), replayed: true };
      }
      const id = randomUUID();
      db.prepare(`
        INSERT INTO recovery_operations
          (id, idempotency_key, kind, storage_id, point_id, actor, transport, state, process_epoch, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
      `).run(id, key, input.kind, storageId, pointId, input.actor, input.transport, this.processEpoch, now, now);
      return { operation: this.require(id), replayed: false };
    })();
  }

  get(id: string): RecoveryOperation | null {
    const row = recoveryDb().prepare('SELECT * FROM recovery_operations WHERE id = ?').get(id) as OperationRow | undefined;
    return row ? toOperation(row) : null;
  }

  markRunning(id: string, now = Date.now()): RecoveryOperation {
    const result = recoveryDb().prepare(`
      UPDATE recovery_operations SET state = 'running', process_epoch = ?, updated_at = ?
      WHERE id = ? AND state = 'queued'
    `).run(this.processEpoch, now, id);
    const op = this.require(id);
    if (result.changes === 0 && op.state !== 'running') throw new RecoveryError('invalid_request');
    return op;
  }

  /**
   * Record the one terminal state. A finished operation is never rewritten, so
   * a late or duplicated completion cannot turn a failure into a success.
   * Locks are released on a known outcome and turned stale on
   * `completion_unknown`, which needs review before the storage is reused.
   */
  finish(id: string, state: FinishState, errorClass: RecoveryErrorClass | null = null, now = Date.now()): RecoveryOperation {
    if (state === 'failed' && !errorClass) throw new RecoveryError('invalid_request');
    const db = recoveryDb();
    return db.transaction((): RecoveryOperation => {
      const current = this.require(id);
      if (isTerminal(current.state)) return current;
      db.prepare(`
        UPDATE recovery_operations SET state = ?, error_class = ?, updated_at = ?, completed_at = ? WHERE id = ?
      `).run(state, errorClass, now, now, id);
      if (state === 'completion_unknown') {
        db.prepare('UPDATE recovery_locks SET stale_since = ? WHERE owner_operation_id = ? AND stale_since IS NULL').run(now, id);
      } else {
        db.prepare('DELETE FROM recovery_locks WHERE owner_operation_id = ?').run(id);
      }
      return this.require(id);
    })();
  }

  /**
   * Take the lock for one storage or repository. The owner taking it again is
   * a replay and succeeds; anyone else gets `lock_held`, or `lock_stale` when
   * an interrupted operation still holds it.
   */
  acquireLock(scope: RecoveryLockScope, resourceKey: string, operationId: string, now = Date.now()): RecoveryLock {
    const db = recoveryDb();
    return db.transaction((): RecoveryLock => {
      const op = this.require(operationId);
      if (isTerminal(op.state)) throw new RecoveryError('invalid_request');
      const existing = db.prepare(
        'SELECT * FROM recovery_locks WHERE scope = ? AND resource_key = ?',
      ).get(scope, resourceKey) as LockRow | undefined;
      if (existing) {
        if (existing.stale_since !== null) throw new RecoveryError('lock_stale');
        if (existing.owner_operation_id !== operationId) throw new RecoveryError('lock_held');
        return toLock(existing);
      }
      db.prepare(`
        INSERT INTO recovery_locks (scope, resource_key, owner_operation_id, process_epoch, acquired_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(scope, resourceKey, operationId, this.processEpoch, now);
      return toLock(db.prepare('SELECT * FROM recovery_locks WHERE scope = ? AND resource_key = ?').get(scope, resourceKey) as LockRow);
    })();
  }

  getLock(scope: RecoveryLockScope, resourceKey: string): RecoveryLock | null {
    const row = recoveryDb().prepare(
      'SELECT * FROM recovery_locks WHERE scope = ? AND resource_key = ?',
    ).get(scope, resourceKey) as LockRow | undefined;
    return row ? toLock(row) : null;
  }

  /**
   * Release a stale lock after someone has reviewed the interrupted operation.
   * A live lock is never released here: its owner releases it by finishing.
   */
  releaseStaleLock(scope: RecoveryLockScope, resourceKey: string, reviewedBy: string): RecoveryLock {
    const db = recoveryDb();
    return db.transaction((): RecoveryLock => {
      const row = db.prepare(
        'SELECT * FROM recovery_locks WHERE scope = ? AND resource_key = ?',
      ).get(scope, resourceKey) as LockRow | undefined;
      if (!row || row.stale_since === null) throw new RecoveryError('invalid_request');
      db.prepare('DELETE FROM recovery_locks WHERE scope = ? AND resource_key = ?').run(scope, resourceKey);
      console.warn(
        '[Recovery] Stale %s lock released after review by %s (operation %s)',
        scope, sanitizeForLog(reviewedBy), row.owner_operation_id,
      );
      return toLock(row);
    })();
  }

  /** Settle what a previous process left behind. Run once at boot, before any new recovery work. */
  reconcileAtStartup(now = Date.now()): StartupReconciliation {
    const db = recoveryDb();
    return db.transaction((): StartupReconciliation => {
      const interrupted = db.prepare(`
        SELECT id FROM recovery_operations
        WHERE state IN ('queued','running') AND process_epoch <> ?
      `).all(this.processEpoch) as Array<{ id: string }>;
      const markOp = db.prepare(`
        UPDATE recovery_operations
        SET state = 'completion_unknown', error_class = 'interrupted', updated_at = ?, completed_at = ?
        WHERE id = ?
      `);
      for (const { id } of interrupted) markOp.run(now, now, id);
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
      return { interruptedOperations: interrupted.length, unknownPoints, staleLocks };
    })();
  }

  private require(id: string): RecoveryOperation {
    const op = this.get(id);
    if (!op) throw new RecoveryError('invalid_request');
    return op;
  }
}
