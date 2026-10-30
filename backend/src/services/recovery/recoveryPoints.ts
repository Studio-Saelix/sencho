import { randomUUID } from 'crypto';
import path from 'path';
import { recoveryDb } from './recoveryDb';
import { assertMetadataOnly, RecoveryError } from './redaction';
import { RECOVERY_POINT_SCHEMA_VERSION, VOLUME_PROTECTION_CAPABILITY_VERSION } from './types';
import type {
  CaptureSummary,
  ConsistencyClass,
  IntegrityMethod,
  IntegrityResult,
  IntegrityVerification,
  PointCaptureEvidence,
  PointExclusion,
  RecoveryErrorClass,
  RecoveryPoint,
  RecoveryPointHold,
  RecoveryPointKind,
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

function toPoint(row: PointRow): RecoveryPoint {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    storageId: row.storage_id,
    storageGeneration: row.storage_generation,
    kind: row.kind,
    pathScope: row.path_scope,
    repositoryId: row.repository_id,
    snapshotId: row.snapshot_id,
    status: row.status,
    consistency: row.consistency,
    capture: row.capture_json ? JSON.parse(row.capture_json) as CaptureSummary : null,
    exclusions: JSON.parse(row.exclusions_json) as PointExclusion[],
    trigger: row.trigger_kind,
    actor: row.actor,
    sourceOperationId: row.source_operation_id,
    sourceNodeKey: row.source_node_key,
    engineId: row.engine_id,
    capabilityVersion: row.capability_version,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failureClass: row.failure_class,
    immutable: true,
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

export interface BeginPointInput {
  storageId: string;
  repositoryId: string;
  kind: RecoveryPointKind;
  pathScope?: string;
  trigger: RecoveryPointTrigger;
  actor: string;
  sourceOperationId: string;
  sourceNodeKey: string;
  engineId: string;
}

export type PointFinalization =
  | { status: 'succeeded' | 'partial'; evidence: PointCaptureEvidence }
  | { status: 'failed'; errorClass: RecoveryErrorClass }
  | { status: 'completion_unknown' };

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

  /** Record a point as `pending` against the storage's current generation. */
  begin(input: BeginPointInput, now = Date.now()): RecoveryPoint {
    const db = recoveryDb();
    const storage = db.prepare(
      'SELECT generation, state FROM recovery_storage_identities WHERE id = ?',
    ).get(input.storageId) as { generation: number; state: string } | undefined;
    if (!storage) throw new RecoveryError('identity_unknown');
    // A point of a superseded generation would describe bytes that no longer exist.
    if (storage.state !== 'current') throw new RecoveryError('identity_unknown');
    // Checked here as well as by the foreign key, so the caller gets a recovery error class.
    if (!db.prepare('SELECT 1 FROM recovery_repositories WHERE id = ?').get(input.repositoryId)) {
      throw new RecoveryError('repository_unavailable');
    }
    if (input.kind === 'root' && input.pathScope !== undefined) throw new RecoveryError('invalid_request');
    const pathScope = input.kind === 'path' ? canonicalizePathScope(input.pathScope ?? '') : null;

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

  /** Write the point's only terminal state. A second call fails at the database. */
  finalize(pointId: string, outcome: PointFinalization, now = Date.now()): RecoveryPoint {
    const db = recoveryDb();
    if (outcome.status === 'succeeded' || outcome.status === 'partial') {
      const { evidence } = outcome;
      assertMetadataOnly(evidence, 'recovery point evidence');
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
      INSERT OR IGNORE INTO recovery_point_holds (point_id, holder_kind, holder_ref, created_at)
      VALUES (?, ?, ?, ?)
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
    ).all(pointId) as Array<{ point_id: string; holder_kind: RecoveryPointHold['holderKind']; holder_ref: string; created_at: number }>;
    return rows.map((r) => ({ pointId: r.point_id, holderKind: r.holder_kind, holderRef: r.holder_ref, createdAt: r.created_at }));
  }

  private require(id: string): RecoveryPoint {
    const point = this.get(id);
    if (!point) throw new RecoveryError('invalid_request');
    return point;
  }
}
