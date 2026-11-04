import { randomUUID } from 'crypto';
import type Docker from 'dockerode';
import { errorMessageForLog, sanitizeForLog } from '../../utils/safeLog';
import { recoveryDb } from './recoveryDb';
import { RecoveryError } from './redaction';
import { HELPER_LABEL_RESTORE_INTENT } from './restic/helperRunner';
import type { IntegrityMethod, RecoveryErrorClass, RestoreIntentPhase } from './types';

/**
 * Durable restore intents.
 *
 * The row is written before anything else happens, so a restart can tell a
 * restore that never started from one that half-wrote a volume. It is the
 * authority on what Sencho created and what it may therefore remove: a target is
 * only ever deleted when it still carries this intent's label and no container
 * uses it.
 *
 * `new_volume` creates a target. `staged_overwrite` keeps the same row and adds
 * a fence: the row names every container the restore stopped, the point it took
 * before touching data, and how far the journaled swap got. Reconciliation is
 * per mode, because a half-written new volume is deleted while a half-swapped
 * live volume is rolled back or rolled forward.
 */

/** Every target Sencho creates for a restore carries this prefix and its intent label. */
export const RECOVERY_RESERVED_TARGET_PREFIX = 'sencho-recovery-';
/** The staging volume a staged overwrite restores into before the live target. */
export const RECOVERY_STAGING_TARGET_PREFIX = 'sencho-recovery-stage-';
/** The hidden work directory a staged overwrite swaps through, inside the target. */
export const RECOVERY_WORK_DIR_PREFIX = '.sencho-restore-';
/** The journal file the swap helper writes inside that directory. */
export const RECOVERY_SWAP_PLAN_FILE = 'plan.json';

export type { RestoreIntentPhase };

export type RestoreIntentTargetMode = 'new_volume' | 'new_path' | 'staged_overwrite';

/** How far the durable fence around the target's workloads got. */
export type RestoreFenceState = 'none' | 'held' | 'released' | 'release_failed';

/** Every target Sencho creates for a restore carries this prefix and its intent label. */
export const RESTORE_OVERWRITE_PHASES: readonly RestoreIntentPhase[] = [
  'fenced', 'protecting', 'materializing', 'swapping', 'swapped',
];

/** Phases from which another phase may be reached. A phase absent here is terminal. */
const ALLOWED_TRANSITIONS: Readonly<Record<RestoreIntentPhase, readonly RestoreIntentPhase[]>> = {
  recorded: ['staging', 'rolled_back', 'completion_unknown'],
  staging: ['staged_verified', 'rolled_back', 'completion_unknown'],
  // A new-volume restore commits from here; an overwrite fences first.
  staged_verified: ['fenced', 'committed', 'rolled_back', 'completion_unknown'],
  fenced: ['protecting', 'rolled_back', 'completion_unknown'],
  protecting: ['materializing', 'rolled_back', 'completion_unknown'],
  materializing: ['swapping', 'rolled_back', 'completion_unknown'],
  swapping: ['swapped', 'rolled_back', 'completion_unknown'],
  swapped: ['committed', 'rolled_back', 'completion_unknown'],
  committed: [],
  rolled_back: [],
  // Unknown is not a dead end: an operator's `retry` or `release_fence` may
  // settle it once the blocker is gone. It only ever settles, never resumes: the
  // data is already in whatever state the crash left, so nothing goes back to an
  // active phase.
  completion_unknown: ['committed', 'rolled_back'],
};

/** Phases only a staged overwrite can enter. */
const OVERWRITE_ONLY_PHASES: ReadonlySet<RestoreIntentPhase> = new Set(RESTORE_OVERWRITE_PHASES);

export interface RestoreIntentRecord {
  id: string;
  operationId: string;
  pointId: string;
  targetMode: RestoreIntentTargetMode;
  targetVolume: string | null;
  pathScope: string | null;
  phase: RestoreIntentPhase;
  /** The volume the point is proven in before the live target is touched. */
  stagingVolume: string | null;
  /** The generation the operator confirmed; a recreated volume is refused. */
  expectedGenerationToken: string | null;
  /** Stacks whose models declare the target volume, with or without containers. */
  dependentStacks: string[];
  /** The root point taken with the workloads stopped, before any live entry moves. */
  preRestorePointId: string | null;
  fenceState: RestoreFenceState;
  /** Sanitized failure class for the phase the intent settled in, or null. */
  outcomeClass: RecoveryErrorClass | null;
  filesRestored: number | null;
  bytesRestored: number | null;
  verified: boolean | null;
  xattrWarnings: number | null;
  actor: string;
  processEpoch: string;
  createdAt: number;
  updatedAt: number;
}

interface IntentRow {
  id: string;
  operation_id: string;
  point_id: string;
  target_mode: RestoreIntentTargetMode;
  target_volume: string | null;
  path_scope: string | null;
  phase: RestoreIntentPhase;
  staging_volume: string | null;
  expected_generation_token: string | null;
  dependent_stacks_json: string | null;
  pre_restore_point_id: string | null;
  fence_state: RestoreFenceState;
  outcome_class: RecoveryErrorClass | null;
  files_restored: number | null;
  bytes_restored: number | null;
  verified: number | null;
  xattr_warnings: number | null;
  actor: string;
  process_epoch: string;
  created_at: number;
  updated_at: number;
}

function toRecord(row: IntentRow): RestoreIntentRecord {
  return {
    id: row.id,
    operationId: row.operation_id,
    pointId: row.point_id,
    targetMode: row.target_mode,
    targetVolume: row.target_volume,
    pathScope: row.path_scope,
    phase: row.phase,
    stagingVolume: row.staging_volume,
    expectedGenerationToken: row.expected_generation_token,
    dependentStacks: parseStackList(row.dependent_stacks_json),
    preRestorePointId: row.pre_restore_point_id,
    fenceState: row.fence_state,
    outcomeClass: row.outcome_class,
    filesRestored: row.files_restored,
    bytesRestored: row.bytes_restored,
    verified: row.verified === null ? null : row.verified === 1,
    xattrWarnings: row.xattr_warnings,
    actor: row.actor,
    processEpoch: row.process_epoch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface RestoreIntentInput {
  operationId: string;
  pointId: string;
  targetVolume: string;
  actor: string;
  processEpoch: string;
  /**
   * The id the caller pre-generated. A staged overwrite names its staging
   * volume from it before the row exists, so both agree.
   */
  id?: string;
}

/** The stacks an overwrite fences, read back from the row. */
function parseStackList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export interface OverwriteIntentInput extends RestoreIntentInput {
  /**
   * The id the caller pre-generated. The staging volume name is derived from it,
   * and the volume is named before the row exists so both agree.
   */
  id?: string;
  /** The staging volume the point is proven in. */
  stagingVolume: string;
  /** The generation the operator saw in the preview. */
  expectedGenerationToken: string;
  /** Every stack whose model declares the target volume. */
  dependentStacks?: string[];
}

export interface IntentAdvanceFields {
  filesRestored?: number;
  bytesRestored?: number;
  verified?: boolean;
  xattrWarnings?: number;
  stagingVolume?: string;
  expectedGenerationToken?: string;
  preRestorePointId?: string;
  outcomeClass?: RecoveryErrorClass | null;
}

export class RestoreIntentStore {
  private static instance: RestoreIntentStore;

  static getInstance(): RestoreIntentStore {
    if (!RestoreIntentStore.instance) RestoreIntentStore.instance = new RestoreIntentStore();
    return RestoreIntentStore.instance;
  }

  /**
   * Record a new-volume restore before anything else happens. The partial unique
   * index means a second live intent for the same target volume cannot exist, so
   * two requests that both think they created the volume can never both proceed.
   */
  record(input: RestoreIntentInput, now = Date.now()): RestoreIntentRecord {
    return this.insert('new_volume', input, {}, now);
  }

  /**
   * Record a staged overwrite before anything else happens. Its target is the
   * point's own volume, so the same live-target index is what refuses a second
   * overwrite of that volume while the first is unsettled.
   */
  recordOverwrite(input: OverwriteIntentInput, now = Date.now()): RestoreIntentRecord {
    return this.insert('staged_overwrite', input, {
      stagingVolume: input.stagingVolume,
      expectedGenerationToken: input.expectedGenerationToken,
      dependentStacks: input.dependentStacks,
    }, now);
  }

  private insert(
    targetMode: RestoreIntentTargetMode,
    input: RestoreIntentInput,
    extra: { stagingVolume?: string; expectedGenerationToken?: string; dependentStacks?: string[] },
    now: number,
  ): RestoreIntentRecord {
    if (!input.targetVolume) throw new RecoveryError('invalid_request');
    const db = recoveryDb();
    const id = input.id ?? randomUUID();
    try {
      db.prepare(`
        INSERT INTO recovery_restore_intents
          (id, operation_id, point_id, target_mode, target_volume, path_scope, phase,
           staging_volume, expected_generation_token, dependent_stacks_json,
           actor, process_epoch, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, 'recorded', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.operationId,
        input.pointId,
        targetMode,
        input.targetVolume,
        extra.stagingVolume ?? null,
        extra.expectedGenerationToken ?? null,
        extra.dependentStacks && extra.dependentStacks.length > 0
          ? JSON.stringify([...new Set(extra.dependentStacks)].sort())
          : null,
        input.actor,
        input.processEpoch,
        now,
        now,
      );
    } catch (err) {
      const message = (err as Error).message ?? '';
      if (/UNIQUE constraint failed/i.test(message)) {
        console.warn('[Recovery] Refused a second live restore into %s', sanitizeForLog(input.targetVolume));
        throw new RecoveryError('lock_held');
      }
      throw err;
    }
    return this.require(id);
  }

  /**
   * Move an intent forward. An illegal transition is refused, never coerced. A
   * new-volume restore cannot enter an overwrite phase, and an overwrite cannot
   * skip the fence.
   */
  advance(id: string, phase: RestoreIntentPhase, extra: IntentAdvanceFields = {}, now = Date.now()): RestoreIntentRecord {
    const db = recoveryDb();
    return db.transaction((): RestoreIntentRecord => {
      const current = this.require(id);
      if (!ALLOWED_TRANSITIONS[current.phase].includes(phase)) {
        console.warn('[Recovery] Refused restore intent %s transition %s -> %s', id, current.phase, phase);
        throw new RecoveryError('invalid_request');
      }
      if (current.targetMode !== 'staged_overwrite' && OVERWRITE_ONLY_PHASES.has(phase)) {
        throw new RecoveryError('invalid_request');
      }
      db.prepare(`
        UPDATE recovery_restore_intents
        SET phase = ?, updated_at = ?,
            files_restored = COALESCE(?, files_restored),
            bytes_restored = COALESCE(?, bytes_restored),
            verified = COALESCE(?, verified),
            xattr_warnings = COALESCE(?, xattr_warnings),
            staging_volume = COALESCE(?, staging_volume),
            expected_generation_token = COALESCE(?, expected_generation_token),
            pre_restore_point_id = COALESCE(?, pre_restore_point_id),
            outcome_class = CASE WHEN ? = 1 THEN ? ELSE outcome_class END
        WHERE id = ?
      `).run(
        phase,
        now,
        extra.filesRestored ?? null,
        extra.bytesRestored ?? null,
        extra.verified === undefined ? null : (extra.verified ? 1 : 0),
        extra.xattrWarnings ?? null,
        extra.stagingVolume ?? null,
        extra.expectedGenerationToken ?? null,
        extra.preRestorePointId ?? null,
        extra.outcomeClass === undefined ? 0 : 1,
        extra.outcomeClass ?? null,
        id,
      );
      return this.require(id);
    }).immediate();
  }

  /** Record the fence state. The fence members themselves are written first. */
  setFenceState(id: string, state: RestoreFenceState, now = Date.now()): RestoreIntentRecord {
    recoveryDb().prepare('UPDATE recovery_restore_intents SET fence_state = ?, updated_at = ? WHERE id = ?')
      .run(state, now, id);
    return this.require(id);
  }

  /**
   * Record evidence or an outcome without moving the phase.
   *
   * Several steps update the same phase they are in: the pre-restore point id is
   * recorded while `protecting`, the restored counts while `materializing`, and a
   * cleanup failure while `swapped`. Going through `advance` would ask the
   * transition table for a phase change that is not happening, and the table
   * rightly refuses that.
   */
  update(id: string, extra: IntentAdvanceFields, now = Date.now()): RestoreIntentRecord {
    recoveryDb().prepare(`
      UPDATE recovery_restore_intents
      SET updated_at = ?,
          files_restored = COALESCE(?, files_restored),
          bytes_restored = COALESCE(?, bytes_restored),
          verified = COALESCE(?, verified),
          xattr_warnings = COALESCE(?, xattr_warnings),
          staging_volume = COALESCE(?, staging_volume),
          expected_generation_token = COALESCE(?, expected_generation_token),
          pre_restore_point_id = COALESCE(?, pre_restore_point_id),
          outcome_class = CASE WHEN ? = 1 THEN ? ELSE outcome_class END
      WHERE id = ?
    `).run(
      now,
      extra.filesRestored ?? null,
      extra.bytesRestored ?? null,
      extra.verified === undefined ? null : (extra.verified ? 1 : 0),
      extra.xattrWarnings ?? null,
      extra.stagingVolume ?? null,
      extra.expectedGenerationToken ?? null,
      extra.preRestorePointId ?? null,
      extra.outcomeClass === undefined ? 0 : 1,
      extra.outcomeClass ?? null,
      id,
    );
    return this.require(id);
  }

  get(id: string): RestoreIntentRecord | null {
    const row = recoveryDb().prepare('SELECT * FROM recovery_restore_intents WHERE id = ?').get(id) as IntentRow | undefined;
    return row ? toRecord(row) : null;
  }

  getByOperation(operationId: string): RestoreIntentRecord | null {
    const row = recoveryDb().prepare(
      'SELECT * FROM recovery_restore_intents WHERE operation_id = ?',
    ).get(operationId) as IntentRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** Intents whose durable fence is still held, whatever phase they reached. */
  listWithLiveFence(targetMode?: RestoreIntentTargetMode): RestoreIntentRecord[] {
    const rows = (targetMode
      ? recoveryDb().prepare(`
          SELECT * FROM recovery_restore_intents
          WHERE fence_state IN ('held','release_failed') AND target_mode = ?
          ORDER BY created_at, id
        `).all(targetMode)
      : recoveryDb().prepare(`
          SELECT * FROM recovery_restore_intents
          WHERE fence_state IN ('held','release_failed')
          ORDER BY created_at, id
        `).all()) as IntentRow[];
    return rows.map(toRecord);
  }

  /**
   * Intents of one mode whose operation reads `completion_unknown` with the class
   * `interrupted`, which is how boot parks an operation and how the live pipeline
   * ends one it could not prove. The operation says nothing about how the restore
   * ended until the intent's own reconciliation has run, so these are the ones to
   * compare.
   */
  listWithInterruptedOperation(targetMode: RestoreIntentTargetMode): RestoreIntentRecord[] {
    const rows = recoveryDb().prepare(`
      SELECT i.* FROM recovery_restore_intents i
      JOIN recovery_operations o ON o.id = i.operation_id
      WHERE i.target_mode = ? AND o.state = 'completion_unknown' AND o.error_class = 'interrupted'
      ORDER BY i.created_at, i.id
    `).all(targetMode) as IntentRow[];
    return rows.map(toRecord);
  }

  /** Intents of one mode that have not reached a terminal phase. */
  listUnsettled(targetMode?: RestoreIntentTargetMode): RestoreIntentRecord[] {
    const rows = targetMode
      ? recoveryDb().prepare(`
          SELECT * FROM recovery_restore_intents
          WHERE phase NOT IN ('committed','rolled_back','completion_unknown') AND target_mode = ?
          ORDER BY created_at, id
        `).all(targetMode) as IntentRow[]
      : recoveryDb().prepare(`
          SELECT * FROM recovery_restore_intents
          WHERE phase NOT IN ('committed','rolled_back','completion_unknown')
          ORDER BY created_at, id
        `).all() as IntentRow[];
    return rows.map(toRecord);
  }

  private require(id: string): RestoreIntentRecord {
    const record = this.get(id);
    if (!record) throw new RecoveryError('invalid_request');
    return record;
  }
}

export interface IntentReconciliation {
  rolledBack: number;
  unknown: number;
}

interface ListedContainer {
  Mounts?: Array<{ Type?: string; Name?: string }>;
}

/** True when any container, running or not, mounts the volume. */
async function volumeInUse(docker: Pick<Docker, 'listContainers'>, volumeName: string): Promise<boolean> {
  const containers = await docker.listContainers({ all: true }) as ListedContainer[];
  return containers.some((c) => (c.Mounts ?? []).some((m) => m.Type === 'volume' && m.Name === volumeName));
}

/**
 * Settle every new-volume intent a previous process left open, at boot, before
 * any new restore can start.
 *
 * Three cases, and no fourth:
 *   - the target is gone: nothing was written that survives, so `rolled_back`;
 *   - the target is ours, labelled, and unused: remove it, then `rolled_back`;
 *   - the target is ours but a container uses it: `completion_unknown`, because
 *     Sencho will not remove a volume a workload is running on.
 * A target that exists without this intent's label is not Sencho's to touch; it
 * is reported `completion_unknown` and left exactly as it is.
 *
 * Staged overwrites are settled by `reconcileOverwriteIntentsAtStartup`, which
 * owns the fence and the swap journal.
 */
export async function reconcileRestoreIntentsAtStartup(
  docker: Pick<Docker, 'listContainers' | 'getVolume' | 'getContainer'>,
  now = Date.now(),
): Promise<IntentReconciliation> {
  const store = RestoreIntentStore.getInstance();
  let rolledBack = 0;
  let unknown = 0;
  for (const intent of store.listUnsettled()) {
    if (intent.targetMode === 'staged_overwrite') continue;
    if (!intent.targetVolume) {
      store.advance(intent.id, 'completion_unknown', {}, now);
      unknown += 1;
      continue;
    }
    let labels: Record<string, string> | null = null;
    try {
      const inspected = await docker.getVolume(intent.targetVolume).inspect() as { Labels?: Record<string, string> | null };
      labels = inspected.Labels ?? null;
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 404) {
        console.warn('[Recovery] Could not inspect restore target %s:', sanitizeForLog(intent.targetVolume), errorMessageForLog(err));
        store.advance(intent.id, 'completion_unknown', {}, now);
        unknown += 1;
        continue;
      }
    }
    if (labels === null) {
      // The volume is already gone: nothing survived the interruption.
      store.advance(intent.id, 'rolled_back', {}, now);
      rolledBack += 1;
      continue;
    }
    if (labels[HELPER_LABEL_RESTORE_INTENT] !== intent.id || await volumeInUse(docker, intent.targetVolume)) {
      store.advance(intent.id, 'completion_unknown', {}, now);
      unknown += 1;
      continue;
    }
    try {
      await docker.getVolume(intent.targetVolume).remove({ force: false });
      store.advance(intent.id, 'rolled_back', {}, now);
      rolledBack += 1;
    } catch (err) {
      console.warn('[Recovery] Could not remove the interrupted restore target %s:', sanitizeForLog(intent.targetVolume), errorMessageForLog(err));
      store.advance(intent.id, 'completion_unknown', {}, now);
      unknown += 1;
    }
  }
  return { rolledBack, unknown };
}

/** The integrity method a restore-verification row records. */
export const RESTORE_VERIFICATION_METHOD: IntegrityMethod = 'engine_check_metadata';
