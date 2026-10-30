import { randomUUID } from 'crypto';
import path from 'path';
import { errorMessageForLog, sanitizeForLog } from '../../utils/safeLog';
import { recoveryDb } from './recoveryDb';
import { assertMetadataOnly, isRecoveryErrorClass, RecoveryError, redactRecoveryLogText } from './redaction';
import { RECOVERY_POINT_SCHEMA_VERSION, VOLUME_PROTECTION_CAPABILITY_VERSION } from './types';
import type {
  CaptureSummary,
  ConsistencyClass,
  ExclusionReason,
  IntegrityMethod,
  IntegrityResult,
  IntegrityVerification,
  PointCaptureEvidence,
  PointExclusion,
  PointHolderKind,
  RecoveryErrorClass,
  RecoveryPoint,
  RecoveryPointHold,
  RecoveryPointKind,
  RecoveryPointOutcome,
  RecoveryPointScope,
  RecoveryPointStatus,
  RecoveryPointTrigger,
} from './types';

/**
 * Versioned recovery-point records.
 *
 * A point is written `pending` before the engine runs and finalized once. After
 * that the database refuses any update (trigger `recovery_points_immutable`).
 * Later facts about a point are separate rows: verifications are appended,
 * holds are added and removed, and neither rewrites the evidence.
 *
 * A point's own status is the authority on the data it captured. The operation
 * that produced it is the authority on the request: an operation interrupted
 * after its point was finalized ends `completion_unknown` while the point keeps
 * its evidence, and an operation cannot finish `succeeded` or `partial` while
 * one of its points is still pending.
 */

interface PointRow {
  id: string;
  schema_version: number;
  storage_id: string;
  storage_generation: number;
  kind: RecoveryPointKind;
  path_scope: string | null;
  repository_id: string;
  snapshot_id: string | null;
  status: RecoveryPointStatus;
  consistency: ConsistencyClass;
  capture_json: string | null;
  exclusions_json: string;
  trigger_kind: RecoveryPointTrigger;
  actor: string;
  source_operation_id: string;
  source_node_key: string;
  engine_id: string;
  capability_version: number;
  started_at: number;
  completed_at: number | null;
  failure_class: RecoveryErrorClass | null;
}

/**
 * The schema's CHECKs guarantee each status carries the evidence its branch
 * names (snapshot, capture and completion for a finished capture, a failure
 * class for `failed`, a completion time for every final status), so the
 * fallbacks below only satisfy the compiler.
 */
function outcomeOf(row: PointRow): RecoveryPointOutcome {
  switch (row.status) {
    case 'pending':
      return { status: 'pending', snapshotId: null, consistency: 'unknown', capture: null, exclusions: [], completedAt: null, failureClass: null };
    case 'succeeded':
    case 'partial':
      return {
        status: row.status,
        snapshotId: row.snapshot_id ?? '',
        consistency: row.consistency,
        capture: JSON.parse(row.capture_json ?? 'null') as CaptureSummary,
        exclusions: JSON.parse(row.exclusions_json) as PointExclusion[],
        completedAt: row.completed_at ?? 0,
        failureClass: null,
      };
    case 'failed':
      return {
        status: 'failed', snapshotId: null, consistency: 'unknown', capture: null, exclusions: [],
        completedAt: row.completed_at ?? 0, failureClass: row.failure_class ?? 'internal',
      };
    case 'completion_unknown':
      return {
        status: 'completion_unknown', snapshotId: null, consistency: 'unknown', capture: null, exclusions: [],
        completedAt: row.completed_at ?? 0, failureClass: 'interrupted',
      };
  }
}

function toPoint(row: PointRow): RecoveryPoint {
  const scope: RecoveryPointScope = row.kind === 'path'
    ? { kind: 'path', pathScope: row.path_scope ?? '' }
    : { kind: 'root', pathScope: null };
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    storageId: row.storage_id,
    storageGeneration: row.storage_generation,
    repositoryId: row.repository_id,
    trigger: row.trigger_kind,
    actor: row.actor,
    sourceOperationId: row.source_operation_id,
    sourceNodeKey: row.source_node_key,
    engineId: row.engine_id,
    capabilityVersion: row.capability_version,
    startedAt: row.started_at,
    ...scope,
    ...outcomeOf(row),
  };
}

/** A path scope is relative to the storage root and cannot leave it. */
export function canonicalizePathScope(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\0')) throw new RecoveryError('invalid_request');
  if (path.posix.isAbsolute(raw) || raw.split('/').includes('..')) throw new RecoveryError('invalid_request');
  const normalized = path.posix.normalize(raw).replace(/\/+$/, '');
  if (normalized === '' || normalized === '.') throw new RecoveryError('invalid_request');
  return normalized;
}

export type BeginPointInput = {
  storageId: string;
  /**
   * The generation token the caller observed just before starting. A storage
   * recreated since then has a different token, and the point is refused
   * rather than labelled with a generation whose bytes are gone.
   */
  expectedGenerationToken: string;
  repositoryId: string;
  trigger: RecoveryPointTrigger;
  actor: string;
  sourceOperationId: string;
  sourceNodeKey: string;
  engineId: string;
} & (
  | { kind: 'root'; pathScope?: undefined }
  | { kind: 'path'; pathScope: string }
);

export type PointFinalization =
  | { status: 'succeeded' | 'partial'; evidence: PointCaptureEvidence }
  | { status: 'failed'; errorClass: RecoveryErrorClass }
  | { status: 'completion_unknown' };

const EXCLUSION_REASONS: ReadonlySet<ExclusionReason> = new Set<ExclusionReason>([
  'policy_excluded', 'permission_denied', 'unreadable', 'vanished', 'unsupported_type',
]);

const CONSISTENCY_CLASSES: ReadonlySet<ConsistencyClass> = new Set<ConsistencyClass>([
  'crash_consistent_live', 'crash_consistent_stopped', 'unknown',
]);

/** Engine snapshot ids are short hashes; anything longer is not one. */
const MAX_SNAPSHOT_ID_LENGTH = 128;

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/**
 * Validate engine evidence and rebuild it from the known fields only, so
 * nothing an engine adds reaches the database. The snapshot id and consistency
 * are checked for credential-shaped text; exclusion paths are the operator's
 * own file names, which may look like anything, so they are shape-checked
 * (relative, inside the root) instead. Throws on any defect.
 */
function sanitizeEvidence(evidence: PointCaptureEvidence): PointCaptureEvidence {
  if (typeof evidence?.snapshotId !== 'string' || evidence.snapshotId.trim() === '') throw new Error('snapshot id missing');
  if (evidence.snapshotId.length > MAX_SNAPSHOT_ID_LENGTH) throw new Error('snapshot id too long');
  if (!CONSISTENCY_CLASSES.has(evidence.consistency)) throw new Error('consistency class invalid');
  const c = evidence.capture;
  if (!c || !isCount(c.fileCount) || !isCount(c.byteCount) || !isCount(c.skippedCount)) throw new Error('capture counts invalid');
  if (!Array.isArray(evidence.exclusions)) throw new Error('exclusions invalid');
  const exclusions = evidence.exclusions.map((e): PointExclusion => {
    if (!e || !EXCLUSION_REASONS.has(e.reason)) throw new Error('exclusion reason invalid');
    return { path: canonicalizePathScope(e.path), reason: e.reason };
  });
  assertMetadataOnly({ snapshotId: evidence.snapshotId, consistency: evidence.consistency }, 'recovery point evidence');
  return {
    snapshotId: evidence.snapshotId,
    consistency: evidence.consistency,
    capture: { fileCount: c.fileCount, byteCount: c.byteCount, skippedCount: c.skippedCount },
    exclusions,
  };
}

/** The reported snapshot id for a log line, when it is safe to print. */
function loggableSnapshot(outcome: PointFinalization): string {
  if (outcome.status !== 'succeeded' && outcome.status !== 'partial') return '';
  const id: unknown = outcome.evidence?.snapshotId;
  if (typeof id !== 'string' || id.length > MAX_SNAPSHOT_ID_LENGTH || redactRecoveryLogText(id) !== id) return '';
  return ` (snapshot ${sanitizeForLog(id)})`;
}

/**
 * Only data the operator chose to leave out keeps a point complete. Anything
 * the engine could not read makes it `partial`, whatever the engine claimed.
 */
function demotedStatus(evidence: PointCaptureEvidence, claimed: 'succeeded' | 'partial'): 'succeeded' | 'partial' {
  if (claimed === 'partial') return 'partial';
  const skipped = evidence.capture.skippedCount > 0
    || evidence.exclusions.some((e) => e.reason !== 'policy_excluded');
  return skipped ? 'partial' : 'succeeded';
}

export class RecoveryPointStore {
  private static instance: RecoveryPointStore;

  static getInstance(): RecoveryPointStore {
    if (!RecoveryPointStore.instance) RecoveryPointStore.instance = new RecoveryPointStore();
    return RecoveryPointStore.instance;
  }

  /** Record a point as `pending` against the generation the caller observed. */
  begin(input: BeginPointInput, now = Date.now()): RecoveryPoint {
    const db = recoveryDb();
    const storage = db.prepare(
      'SELECT generation, generation_token, state FROM recovery_storage_identities WHERE id = ?',
    ).get(input.storageId) as { generation: number; generation_token: string; state: string } | undefined;
    if (!storage) throw new RecoveryError('identity_unknown');
    // A point of a superseded or since-recreated generation would describe bytes that no longer exist.
    if (storage.state !== 'current' || storage.generation_token !== input.expectedGenerationToken) {
      throw new RecoveryError('identity_unknown');
    }
    // Checked here as well as by the foreign key, so the caller gets a recovery error class.
    if (!db.prepare('SELECT 1 FROM recovery_repositories WHERE id = ?').get(input.repositoryId)) {
      throw new RecoveryError('repository_unavailable');
    }
    if (input.kind === 'root' && input.pathScope !== undefined) throw new RecoveryError('invalid_request');
    const pathScope = input.kind === 'path' ? canonicalizePathScope(input.pathScope) : null;

    const id = randomUUID();
    db.prepare(`
      INSERT INTO recovery_points
        (id, schema_version, storage_id, storage_generation, kind, path_scope, repository_id,
         status, consistency, trigger_kind, actor, source_operation_id, source_node_key,
         engine_id, capability_version, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'unknown', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, RECOVERY_POINT_SCHEMA_VERSION, input.storageId, storage.generation, input.kind, pathScope,
      input.repositoryId, input.trigger, input.actor, input.sourceOperationId, input.sourceNodeKey,
      input.engineId, VOLUME_PROTECTION_CAPABILITY_VERSION, now,
    );
    return this.require(id);
  }

  /**
   * Write the point's only terminal state. A late or duplicated completion
   * (after a restart settled the point, say) is refused as `invalid_request`
   * and logged, never applied. Evidence that fails validation ends the point
   * `failed` rather than leaving it pending until the next boot. A `failed`
   * outcome without a known error class is refused as `invalid_request` and the
   * point stays pending until its operation, or the next boot, settles it.
   */
  finalize(pointId: string, outcome: PointFinalization, now = Date.now()): RecoveryPoint {
    const db = recoveryDb();
    const current = this.require(pointId);
    if (current.status !== 'pending') {
      // The snapshot an engine reports late may exist in the repository with no
      // record pointing at it; its id goes in the log, when it is safe to print,
      // so it can be found.
      console.warn(
        '[Recovery] Ignored a late %s completion for point %s, already %s%s',
        outcome.status, pointId, current.status, loggableSnapshot(outcome),
      );
      throw new RecoveryError('invalid_request');
    }
    if (outcome.status === 'succeeded' || outcome.status === 'partial') {
      let evidence: PointCaptureEvidence;
      try {
        evidence = sanitizeEvidence(outcome.evidence);
      } catch (err) {
        console.error('[Recovery] Point %s evidence refused%s:', pointId, loggableSnapshot(outcome), errorMessageForLog(err));
        db.prepare(`
          UPDATE recovery_points SET status = 'failed', failure_class = 'internal', completed_at = ? WHERE id = ?
        `).run(now, pointId);
        throw new RecoveryError('internal');
      }
      const status = demotedStatus(evidence, outcome.status);
      db.prepare(`
        UPDATE recovery_points
        SET status = ?, snapshot_id = ?, consistency = ?, capture_json = ?, exclusions_json = ?, completed_at = ?
        WHERE id = ?
      `).run(
        status, evidence.snapshotId, evidence.consistency, JSON.stringify(evidence.capture),
        JSON.stringify(evidence.exclusions), now, pointId,
      );
    } else {
      if (outcome.status === 'failed' && !isRecoveryErrorClass(outcome.errorClass)) {
        throw new RecoveryError('invalid_request');
      }
      db.prepare(`
        UPDATE recovery_points SET status = ?, failure_class = ?, completed_at = ? WHERE id = ?
      `).run(
        outcome.status,
        outcome.status === 'failed' ? outcome.errorClass : 'interrupted',
        now, pointId,
      );
    }
    return this.require(pointId);
  }

  get(id: string): RecoveryPoint | null {
    const row = recoveryDb().prepare('SELECT * FROM recovery_points WHERE id = ?').get(id) as PointRow | undefined;
    return row ? toPoint(row) : null;
  }

  listForStorage(storageId: string): RecoveryPoint[] {
    const rows = recoveryDb().prepare(
      'SELECT * FROM recovery_points WHERE storage_id = ? ORDER BY started_at DESC, id',
    ).all(storageId) as PointRow[];
    return rows.map(toPoint);
  }

  /** Append a verification. Only a finished point with a snapshot can be verified. */
  recordVerification(
    pointId: string,
    method: IntegrityMethod,
    result: IntegrityResult,
    operationId: string | null,
    now = Date.now(),
  ): IntegrityVerification {
    const point = this.require(pointId);
    if (point.status === 'pending' || !point.snapshotId) throw new RecoveryError('invalid_request');
    const id = randomUUID();
    recoveryDb().prepare(`
      INSERT INTO recovery_point_verifications (id, point_id, method, result, verified_at, operation_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, pointId, method, result, now, operationId);
    return { id, pointId, method, result, verifiedAt: now, operationId };
  }

  listVerifications(pointId: string): IntegrityVerification[] {
    const rows = recoveryDb().prepare(`
      SELECT id, point_id, method, result, verified_at, operation_id
      FROM recovery_point_verifications WHERE point_id = ? ORDER BY verified_at, id
    `).all(pointId) as Array<{
      id: string; point_id: string; method: IntegrityMethod; result: IntegrityResult;
      verified_at: number; operation_id: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id, pointId: r.point_id, method: r.method, result: r.result,
      verifiedAt: r.verified_at, operationId: r.operation_id,
    }));
  }

  addHold(hold: Omit<RecoveryPointHold, 'createdAt'>, now = Date.now()): void {
    this.require(hold.pointId);
    recoveryDb().prepare(`
      INSERT INTO recovery_point_holds (point_id, holder_kind, holder_ref, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (point_id, holder_kind, holder_ref) DO NOTHING
    `).run(hold.pointId, hold.holderKind, hold.holderRef, now);
  }

  removeHold(hold: Omit<RecoveryPointHold, 'createdAt'>): void {
    recoveryDb().prepare(
      'DELETE FROM recovery_point_holds WHERE point_id = ? AND holder_kind = ? AND holder_ref = ?',
    ).run(hold.pointId, hold.holderKind, hold.holderRef);
  }

  listHolds(pointId: string): RecoveryPointHold[] {
    const rows = recoveryDb().prepare(
      'SELECT point_id, holder_kind, holder_ref, created_at FROM recovery_point_holds WHERE point_id = ?',
    ).all(pointId) as Array<{ point_id: string; holder_kind: PointHolderKind; holder_ref: string; created_at: number }>;
    return rows.map((r) => ({ pointId: r.point_id, holderKind: r.holder_kind, holderRef: r.holder_ref, createdAt: r.created_at }));
  }

  private require(id: string): RecoveryPoint {
    const point = this.get(id);
    if (!point) throw new RecoveryError('invalid_request');
    return point;
  }
}
