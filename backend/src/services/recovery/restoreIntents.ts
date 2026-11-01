import { randomUUID } from 'crypto';
import type Docker from 'dockerode';
import { errorMessageForLog, sanitizeForLog } from '../../utils/safeLog';
import { recoveryDb } from './recoveryDb';
import { RecoveryError } from './redaction';
import { HELPER_LABEL_RESTORE_INTENT } from './restic/helperRunner';
import type { IntegrityMethod } from './types';

/**
 * Durable restore intents.
 *
 * The row is written before anything else happens, so a restart can tell a
 * restore that never started from one that half-wrote a volume. It is the
 * authority on what Sencho created and what it may therefore remove: a target is
 * only ever deleted when it still carries this intent's label and no container
 * uses it.
 *
 * Only `new_volume` is implemented in this slice. `new_path` and
 * `staged_overwrite` are refused by the route, and the CHECK keeps all three
 * names so a later slice can add them without a table rewrite.
 */

/** Every target Sencho creates for a restore carries this prefix and its intent label. */
export const RECOVERY_RESERVED_TARGET_PREFIX = 'sencho-recovery-';

export type RestoreIntentPhase =
  | 'recorded'
  | 'staging'
  | 'staged_verified'
  | 'swapping'
  | 'committed'
  | 'rolled_back'
  | 'completion_unknown';

/** Phases from which another phase may be reached. */
const ALLOWED_TRANSITIONS: Readonly<Record<RestoreIntentPhase, readonly RestoreIntentPhase[]>> = {
  recorded: ['staging', 'rolled_back', 'completion_unknown'],
  staging: ['staged_verified', 'rolled_back', 'completion_unknown'],
  staged_verified: ['committed', 'rolled_back', 'completion_unknown'],
  swapping: ['committed', 'rolled_back', 'completion_unknown'],
  committed: [],
  rolled_back: [],
  completion_unknown: [],
};

export interface RestoreIntentRecord {
  id: string;
  operationId: string;
  pointId: string;
  targetMode: 'new_volume' | 'new_path' | 'staged_overwrite';
  targetVolume: string | null;
  pathScope: string | null;
  phase: RestoreIntentPhase;
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
  target_mode: 'new_volume' | 'new_path' | 'staged_overwrite';
  target_volume: string | null;
  path_scope: string | null;
  phase: RestoreIntentPhase;
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
}

export class RestoreIntentStore {
  private static instance: RestoreIntentStore;

  static getInstance(): RestoreIntentStore {
    if (!RestoreIntentStore.instance) RestoreIntentStore.instance = new RestoreIntentStore();
    return RestoreIntentStore.instance;
  }

  /**
   * Record a restore before anything else happens. The partial unique index means
   * a second live intent for the same target volume cannot exist, so two requests
   * that both think they created the volume can never both proceed.
   */
  record(input: RestoreIntentInput, now = Date.now()): RestoreIntentRecord {
    if (!input.targetVolume) throw new RecoveryError('invalid_request');
    const db = recoveryDb();
    const id = randomUUID();
    try {
      db.prepare(`
        INSERT INTO recovery_restore_intents
          (id, operation_id, point_id, target_mode, target_volume, path_scope, phase, actor, process_epoch, created_at, updated_at)
        VALUES (?, ?, ?, 'new_volume', ?, NULL, 'recorded', ?, ?, ?, ?)
      `).run(id, input.operationId, input.pointId, input.targetVolume, input.actor, input.processEpoch, now, now);
    } catch (err) {
      const message = (err as Error).message ?? '';
      if (/UNIQUE|constraint/i.test(message)) {
        console.warn('[Recovery] Refused a second live restore into %s', sanitizeForLog(input.targetVolume));
        throw new RecoveryError('invalid_request');
      }
      throw err;
    }
    return this.require(id);
  }

  /** Move an intent forward. An illegal transition is refused, never coerced. */
  advance(
    id: string,
    phase: RestoreIntentPhase,
    extra: { filesRestored?: number; bytesRestored?: number; verified?: boolean; xattrWarnings?: number } = {},
    now = Date.now(),
  ): RestoreIntentRecord {
    const db = recoveryDb();
    return db.transaction((): RestoreIntentRecord => {
      const current = this.require(id);
      if (!ALLOWED_TRANSITIONS[current.phase].includes(phase)) {
        console.warn('[Recovery] Refused restore intent %s transition %s -> %s', id, current.phase, phase);
        throw new RecoveryError('invalid_request');
      }
      db.prepare(`
        UPDATE recovery_restore_intents
        SET phase = ?, updated_at = ?,
            files_restored = COALESCE(?, files_restored),
            bytes_restored = COALESCE(?, bytes_restored),
            verified = COALESCE(?, verified),
            xattr_warnings = COALESCE(?, xattr_warnings)
        WHERE id = ?
      `).run(
        phase,
        now,
        extra.filesRestored ?? null,
        extra.bytesRestored ?? null,
        extra.verified === undefined ? null : (extra.verified ? 1 : 0),
        extra.xattrWarnings ?? null,
        id,
      );
      return this.require(id);
    }).immediate();
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

  /** Intents that have not reached a terminal phase. */
  listUnsettled(): RestoreIntentRecord[] {
    const rows = recoveryDb().prepare(`
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
 * Settle every intent a previous process left open, at boot, before any new
 * restore can start.
 *
 * Three cases, and no fourth:
 *   - the target is gone: nothing was written that survives, so `rolled_back`;
 *   - the target is ours, labelled, and unused: remove it, then `rolled_back`;
 *   - the target is ours but a container uses it: `completion_unknown`, because
 *     Sencho will not remove a volume a workload is running on.
 * A target that exists without this intent's label is not Sencho's to touch; it
 * is reported `completion_unknown` and left exactly as it is.
 */
export async function reconcileRestoreIntentsAtStartup(
  docker: Pick<Docker, 'listContainers' | 'getVolume' | 'getContainer'>,
  now = Date.now(),
): Promise<IntentReconciliation> {
  const store = RestoreIntentStore.getInstance();
  let rolledBack = 0;
  let unknown = 0;
  for (const intent of store.listUnsettled()) {
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
        console.warn('[Recovery] Could not inspect restore target %s:', intent.targetVolume, errorMessageForLog(err));
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
      console.warn('[Recovery] Could not remove the interrupted restore target %s:', intent.targetVolume, errorMessageForLog(err));
      store.advance(intent.id, 'completion_unknown', {}, now);
      unknown += 1;
    }
  }
  return { rolledBack, unknown };
}

/** The integrity method a restore-verification row records. */
export const RESTORE_VERIFICATION_METHOD: IntegrityMethod = 'engine_check_metadata';
