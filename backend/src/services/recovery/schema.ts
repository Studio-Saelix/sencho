import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';

/**
 * Recovery tables and their versioned migration.
 *
 * The version lives in `system_state.recovery_schema_version`. A database
 * written by a newer build (a downgrade) is left untouched and reported as
 * `newer`, so recovery fails closed on this build instead of writing rows a
 * newer schema would misread. Sencho itself still boots.
 *
 * Two invariants are enforced by the database rather than by callers:
 *   - a recovery point is immutable once its status leaves `pending`;
 *   - a point with a hold (deploy checkpoint, policy, mobility, drain, last
 *     known good, operator) cannot be deleted.
 */
export const RECOVERY_SCHEMA_VERSION = 1;
export const RECOVERY_SCHEMA_STATE_KEY = 'recovery_schema_version';
/** Stable authority id for every storage and repository record this instance owns. */
export const RECOVERY_AUTHORITY_STATE_KEY = 'recovery_authority_id';

export const RECOVERY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS recovery_storage_identities (
  id TEXT PRIMARY KEY,
  authority_id TEXT NOT NULL,
  owner_node_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('named_volume','bind_root')),
  locator TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  generation_token TEXT NOT NULL,
  lineage_parent_id TEXT NULL REFERENCES recovery_storage_identities(id),
  state TEXT NOT NULL CHECK (state IN ('current','superseded')),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE (storage_key, generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_storage_current
  ON recovery_storage_identities(storage_key) WHERE state = 'current';

CREATE TABLE IF NOT EXISTS recovery_storage_dependents (
  storage_key TEXT NOT NULL,
  stack_name TEXT NOT NULL,
  service_name TEXT NOT NULL DEFAULT '',
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (storage_key, stack_name, service_name)
);
CREATE INDEX IF NOT EXISTS idx_recovery_dependents_stack
  ON recovery_storage_dependents(stack_name);

CREATE TABLE IF NOT EXISTS recovery_repositories (
  id TEXT PRIMARY KEY,
  authority_id TEXT NOT NULL,
  owner_node_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('local_volume')),
  locator TEXT NOT NULL,
  repository_fingerprint TEXT NULL,
  failure_domain TEXT NOT NULL CHECK (failure_domain IN ('same_failure_domain','separate','unknown')),
  encrypted_secret TEXT NULL CHECK (encrypted_secret IS NULL OR encrypted_secret LIKE 'enc:%'),
  created_at INTEGER NOT NULL,
  UNIQUE (authority_id, owner_node_key, kind, locator)
);

CREATE TABLE IF NOT EXISTS recovery_points (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  storage_id TEXT NOT NULL REFERENCES recovery_storage_identities(id),
  storage_generation INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('root','path')),
  path_scope TEXT NULL,
  repository_id TEXT NOT NULL REFERENCES recovery_repositories(id),
  snapshot_id TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','succeeded','partial','failed','completion_unknown')),
  consistency TEXT NOT NULL CHECK (consistency IN ('crash_consistent_live','crash_consistent_stopped','unknown')),
  capture_json TEXT NULL,
  exclusions_json TEXT NOT NULL DEFAULT '[]',
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual','policy','pre_change','pre_restore')),
  actor TEXT NOT NULL,
  source_operation_id TEXT NOT NULL,
  source_node_key TEXT NOT NULL,
  engine_id TEXT NOT NULL,
  capability_version INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER NULL,
  failure_class TEXT NULL,
  CHECK ((kind = 'root' AND path_scope IS NULL) OR (kind = 'path' AND path_scope IS NOT NULL AND path_scope <> '')),
  CHECK (status <> 'succeeded' OR (snapshot_id IS NOT NULL AND capture_json IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_recovery_points_storage
  ON recovery_points(storage_id, kind, status);

CREATE TRIGGER IF NOT EXISTS recovery_points_immutable
  BEFORE UPDATE ON recovery_points
  WHEN OLD.status <> 'pending'
  BEGIN SELECT RAISE(ABORT, 'recovery point is immutable'); END;

CREATE TABLE IF NOT EXISTS recovery_point_holds (
  point_id TEXT NOT NULL REFERENCES recovery_points(id),
  holder_kind TEXT NOT NULL CHECK (holder_kind IN (
    'deploy_checkpoint','recovery_policy','mobility','drain','last_known_good','operator'
  )),
  holder_ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (point_id, holder_kind, holder_ref)
);

CREATE TRIGGER IF NOT EXISTS recovery_points_held
  BEFORE DELETE ON recovery_points
  WHEN EXISTS (SELECT 1 FROM recovery_point_holds WHERE point_id = OLD.id)
  BEGIN SELECT RAISE(ABORT, 'recovery point is held'); END;

CREATE TABLE IF NOT EXISTS recovery_point_verifications (
  id TEXT PRIMARY KEY,
  point_id TEXT NOT NULL REFERENCES recovery_points(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('engine_check_metadata','engine_check_read_data')),
  result TEXT NOT NULL CHECK (result IN ('verified','mismatch','error')),
  verified_at INTEGER NOT NULL,
  operation_id TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_recovery_verifications_point
  ON recovery_point_verifications(point_id, verified_at);

CREATE TRIGGER IF NOT EXISTS recovery_point_verifications_append_only
  BEFORE UPDATE ON recovery_point_verifications
  BEGIN SELECT RAISE(ABORT, 'verification records are append-only'); END;

CREATE TABLE IF NOT EXISTS recovery_operations (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('create_point','verify_point','restore','repository_init')),
  storage_id TEXT NULL,
  point_id TEXT NULL,
  actor TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('local','node_proxy','pilot_tunnel')),
  state TEXT NOT NULL CHECK (state IN (
    'queued','running','succeeded','partial','failed','cancelled','completion_unknown'
  )),
  error_class TEXT NULL,
  process_epoch TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER NULL
);
CREATE INDEX IF NOT EXISTS idx_recovery_operations_state
  ON recovery_operations(state);

CREATE TABLE IF NOT EXISTS recovery_locks (
  scope TEXT NOT NULL CHECK (scope IN ('storage','repository')),
  resource_key TEXT NOT NULL,
  owner_operation_id TEXT NOT NULL REFERENCES recovery_operations(id),
  process_epoch TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  stale_since INTEGER NULL,
  PRIMARY KEY (scope, resource_key)
);
`;

export type RecoverySchemaOutcome =
  | { kind: 'current'; version: number }
  | { kind: 'newer'; storedVersion: number }
  /** The migration threw; recovery stays unavailable and Sencho still boots. */
  | { kind: 'failed' };

/**
 * Apply the recovery schema to `db`. Idempotent: safe on every boot, on a
 * fresh database, and on one an earlier build already migrated.
 */
export function applyRecoverySchema(db: Database.Database): RecoverySchemaOutcome {
  const row = db.prepare('SELECT value FROM system_state WHERE key = ?')
    .get(RECOVERY_SCHEMA_STATE_KEY) as { value: string } | undefined;
  const stored = row ? Number.parseInt(row.value, 10) : 0;
  if (!Number.isInteger(stored) || stored < 0) {
    throw new Error(`Unreadable ${RECOVERY_SCHEMA_STATE_KEY}`);
  }
  if (stored > RECOVERY_SCHEMA_VERSION) return { kind: 'newer', storedVersion: stored };

  db.transaction(() => {
    db.exec(RECOVERY_SCHEMA_SQL);
    db.prepare('INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)')
      .run(RECOVERY_SCHEMA_STATE_KEY, String(RECOVERY_SCHEMA_VERSION));
    // Created once and never rotated: every storage and repository record this
    // instance owns is keyed by it, so changing it would orphan them all.
    db.prepare('INSERT OR IGNORE INTO system_state (key, value) VALUES (?, ?)')
      .run(RECOVERY_AUTHORITY_STATE_KEY, randomUUID());
  })();
  return { kind: 'current', version: RECOVERY_SCHEMA_VERSION };
}
