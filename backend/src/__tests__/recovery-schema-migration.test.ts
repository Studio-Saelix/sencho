/**
 * Recovery schema migration: applies on a fresh or pre-recovery database,
 * re-runs as a no-op, leaves a newer build's records alone, keeps the
 * configuration-recovery tables (Fleet Snapshots, rollback generations)
 * untouched, and enforces the point invariants in the database itself.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import {
  applyRecoverySchema,
  RECOVERY_AUTHORITY_STATE_KEY,
  RECOVERY_SCHEMA_STATE_KEY,
  RECOVERY_SCHEMA_VERSION,
} from '../services/recovery/schema';

const RECOVERY_TABLES = [
  'recovery_locks', 'recovery_operations', 'recovery_point_verifications', 'recovery_point_holds',
  'recovery_points', 'recovery_repositories', 'recovery_storage_dependents', 'recovery_storage_identities',
  'recovery_restore_intents', 'recovery_repository_checks',
];

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
});

afterAll(() => cleanupTestDb(tmpDir));

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return db;
}

function state(db: Database.Database, key: string): string | undefined {
  return (db.prepare('SELECT value FROM system_state WHERE key = ?').get(key) as { value: string } | undefined)?.value;
}

function tables(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'recovery_%'").all() as Array<{ name: string }>)
    .map((r) => r.name).sort();
}

describe('applyRecoverySchema', () => {
  it('creates every table, records the version and mints one authority id', () => {
    const db = freshDb();
    expect(applyRecoverySchema(db)).toEqual({ kind: 'current', version: RECOVERY_SCHEMA_VERSION });
    expect(tables(db)).toEqual([...RECOVERY_TABLES].sort());
    expect(state(db, RECOVERY_SCHEMA_STATE_KEY)).toBe(String(RECOVERY_SCHEMA_VERSION));
    expect(state(db, RECOVERY_AUTHORITY_STATE_KEY)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is a no-op on a second boot and never rotates the authority id', () => {
    const db = freshDb();
    applyRecoverySchema(db);
    const authority = state(db, RECOVERY_AUTHORITY_STATE_KEY);
    db.prepare(`INSERT INTO recovery_storage_identities
      (id, authority_id, owner_node_key, kind, locator, storage_key, generation, generation_token, state, first_seen_at, last_seen_at)
      VALUES ('s1', ?, 'docker-engine:a', 'named_volume', 'data', 'k', 1, 't', 'current', 1, 1)`).run(authority);
    expect(applyRecoverySchema(db)).toEqual({ kind: 'current', version: RECOVERY_SCHEMA_VERSION });
    expect(state(db, RECOVERY_AUTHORITY_STATE_KEY)).toBe(authority);
    expect(db.prepare('SELECT COUNT(*) AS n FROM recovery_storage_identities').get()).toEqual({ n: 1 });
  });

  it('leaves records written by a newer build untouched', () => {
    const db = freshDb();
    db.prepare('INSERT INTO system_state (key, value) VALUES (?, ?)').run(RECOVERY_SCHEMA_STATE_KEY, String(RECOVERY_SCHEMA_VERSION + 1));
    expect(applyRecoverySchema(db)).toEqual({ kind: 'newer', storedVersion: RECOVERY_SCHEMA_VERSION + 1 });
    expect(tables(db)).toEqual([]);
    expect(state(db, RECOVERY_SCHEMA_STATE_KEY)).toBe(String(RECOVERY_SCHEMA_VERSION + 1));
  });

  it('refuses an unreadable stored version instead of guessing', () => {
    const db = freshDb();
    db.prepare('INSERT INTO system_state (key, value) VALUES (?, ?)').run(RECOVERY_SCHEMA_STATE_KEY, 'garbage');
    expect(() => applyRecoverySchema(db)).toThrow();
    expect(tables(db)).toEqual([]);
  });

  it('upgrades a database from before recovery existed without touching configuration recovery', () => {
    const file = path.join(tmpDir, 'pre-recovery.db');
    fs.copyFileSync(path.join(tmpDir, 'sencho.db'), file);
    const db = new Database(file);
    for (const t of RECOVERY_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
    db.prepare('DELETE FROM system_state WHERE key IN (?, ?)').run(RECOVERY_SCHEMA_STATE_KEY, RECOVERY_AUTHORITY_STATE_KEY);
    db.prepare(`INSERT INTO fleet_snapshots (description, created_by, node_count, stack_count, skipped_nodes, skipped_stacks, documentation, created_at)
      VALUES ('before upgrade', 'admin', 1, 1, '[]', '[]', '', 1)`).run();
    const configTables = ['fleet_snapshots', 'fleet_snapshot_files', 'stack_update_recovery_generations'];
    const before = Object.fromEntries(configTables.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()]));

    expect(applyRecoverySchema(db).kind).toBe('current');

    expect(tables(db)).toEqual([...RECOVERY_TABLES].sort());
    for (const t of configTables) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual(before[t]);
    expect(db.prepare("SELECT description FROM fleet_snapshots WHERE description = 'before upgrade'").get()).toBeTruthy();
    db.close();
  });

  it('upgrades a v1 database in place: adds the request digest and the new tables', () => {
    const db = freshDb();
    applyRecoverySchema(db);
    // Recreate the schema as v1 left it: no digest column, no v2 tables.
    db.exec('DROP TABLE recovery_restore_intents');
    db.exec('DROP TABLE recovery_repository_checks');
    db.exec('ALTER TABLE recovery_operations DROP COLUMN request_digest');
    db.prepare('INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)').run(RECOVERY_SCHEMA_STATE_KEY, '1');
    db.prepare(`INSERT INTO recovery_operations
      (id, idempotency_key, kind, actor, transport, state, process_epoch, created_at, updated_at)
      VALUES ('op-old', 'key-old', 'create_point', 'admin', 'local', 'succeeded', 'epoch', 1, 1)`).run();

    expect(applyRecoverySchema(db)).toEqual({ kind: 'current', version: RECOVERY_SCHEMA_VERSION });
    const columns = (db.prepare('PRAGMA table_info(recovery_operations)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain('request_digest');
    // The row written by the earlier build survives the migration.
    expect(db.prepare("SELECT id, request_digest FROM recovery_operations WHERE id = 'op-old'").get())
      .toEqual({ id: 'op-old', request_digest: null });
    // And the migration is repeatable.
    expect(applyRecoverySchema(db).kind).toBe('current');
  });

  it('is applied by DatabaseService at boot', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    expect(DatabaseService.getInstance().getRecoverySchemaOutcome()).toEqual({ kind: 'current', version: RECOVERY_SCHEMA_VERSION });
  });
});

describe('database-enforced point invariants', () => {
  function seeded(): Database.Database {
    const db = freshDb();
    applyRecoverySchema(db);
    db.exec(`
      INSERT INTO recovery_storage_identities
        (id, authority_id, owner_node_key, kind, locator, storage_key, generation, generation_token, state, first_seen_at, last_seen_at)
        VALUES ('s1', 'a', 'docker-engine:a', 'named_volume', 'data', 'k', 1, 't', 'current', 1, 1);
      INSERT INTO recovery_repositories (id, authority_id, owner_node_key, kind, locator, failure_domain, created_at)
        VALUES ('r1', 'a', 'docker-engine:a', 'local_volume', 'repo', 'same_failure_domain', 1);
    `);
    return db;
  }

  const insertPoint = (db: Database.Database, overrides: Record<string, unknown> = {}): void => {
    const row = {
      id: 'p1', kind: 'root', path_scope: null, status: 'pending', snapshot_id: null, capture_json: null, completed_at: null,
      ...overrides,
    };
    db.prepare(`INSERT INTO recovery_points
      (id, schema_version, storage_id, storage_generation, kind, path_scope, repository_id, snapshot_id, status,
       consistency, capture_json, trigger_kind, actor, source_operation_id, source_node_key, engine_id,
       capability_version, started_at, completed_at)
      VALUES (@id, 1, 's1', 1, @kind, @path_scope, 'r1', @snapshot_id, @status, 'unknown', @capture_json,
       'manual', 'admin', 'op', 'docker-engine:a', 'test', 1, 1, @completed_at)`).run(row);
  };

  it('refuses any update to a finished point', () => {
    const db = seeded();
    insertPoint(db);
    db.prepare("UPDATE recovery_points SET status = 'failed', failure_class = 'internal', completed_at = 2 WHERE id = 'p1'").run();
    expect(() => db.prepare("UPDATE recovery_points SET status = 'succeeded' WHERE id = 'p1'").run()).toThrow(/immutable/);
    expect(() => db.prepare("UPDATE recovery_points SET actor = 'someone' WHERE id = 'p1'").run()).toThrow(/immutable/);
  });

  it('refuses a succeeded point without a snapshot and its capture', () => {
    const db = seeded();
    expect(() => insertPoint(db, { status: 'succeeded' })).toThrow(/CHECK/);
  });

  it('refuses a finished capture without evidence, a failure without a class, or a final status without a time', () => {
    const db = seeded();
    expect(() => insertPoint(db, { status: 'partial', completed_at: 2 })).toThrow(/CHECK/);
    expect(() => insertPoint(db, { id: 'p2', status: 'failed', completed_at: 2 })).toThrow(/CHECK/);
    expect(() => insertPoint(db, { id: 'p3', status: 'completion_unknown', completed_at: 2 })).toThrow(/CHECK/);
    expect(() => insertPoint(db, { id: 'p4', status: 'succeeded', snapshot_id: 's', capture_json: '{}' })).toThrow(/CHECK/);
    expect(() => insertPoint(db, { id: 'p5', status: 'pending', completed_at: 2 })).toThrow(/CHECK/);
  });

  it('keeps root and path scopes apart', () => {
    const db = seeded();
    expect(() => insertPoint(db, { kind: 'root', path_scope: 'a/b' })).toThrow(/CHECK/);
    expect(() => insertPoint(db, { id: 'p2', kind: 'path', path_scope: null })).toThrow(/CHECK/);
    expect(() => insertPoint(db, { id: 'p3', kind: 'path', path_scope: '' })).toThrow(/CHECK/);
  });

  it('refuses to delete a held point and allows it once released', () => {
    const db = seeded();
    insertPoint(db);
    db.prepare("INSERT INTO recovery_point_holds (point_id, holder_kind, holder_ref, created_at) VALUES ('p1', 'deploy_checkpoint', 'gen-1', 1)").run();
    expect(() => db.prepare("DELETE FROM recovery_points WHERE id = 'p1'").run()).toThrow(/held/);
    db.prepare("DELETE FROM recovery_point_holds WHERE point_id = 'p1'").run();
    expect(db.prepare("DELETE FROM recovery_points WHERE id = 'p1'").run().changes).toBe(1);
  });

  it('keeps verifications append-only', () => {
    const db = seeded();
    insertPoint(db);
    db.prepare("INSERT INTO recovery_point_verifications (id, point_id, method, result, verified_at) VALUES ('v1', 'p1', 'engine_check_metadata', 'verified', 1)").run();
    expect(() => db.prepare("UPDATE recovery_point_verifications SET result = 'mismatch'").run()).toThrow(/append-only/);
  });

  it('serializes restores into one target volume at a time', () => {
    const db = seeded();
    db.prepare(`INSERT INTO recovery_operations (id, idempotency_key, kind, actor, transport, state, process_epoch, created_at, updated_at)
      VALUES ('op1', 'k1', 'restore', 'admin', 'local', 'running', 'e', 1, 1)`).run();
    db.prepare(`INSERT INTO recovery_operations (id, idempotency_key, kind, actor, transport, state, process_epoch, created_at, updated_at)
      VALUES ('op2', 'k2', 'restore', 'admin', 'local', 'running', 'e', 1, 1)`).run();
    insertPoint(db, { id: 'p1', status: 'succeeded', snapshot_id: 's', capture_json: '{}', completed_at: 2 });
    insertPoint(db, { id: 'p2', status: 'succeeded', snapshot_id: 's', capture_json: '{}', completed_at: 2 });
    const insertIntent = (id: string, operationId: string, pointId: string, phase: string) =>
      db.prepare(`INSERT INTO recovery_restore_intents
        (id, operation_id, point_id, target_mode, target_volume, phase, actor, process_epoch, created_at, updated_at)
        VALUES (?, ?, ?, 'new_volume', 'target', ?, 'admin', 'e', 1, 1)`).run(id, operationId, pointId, phase);

    insertIntent('i1', 'op1', 'p1', 'staging');
    expect(() => insertIntent('i2', 'op2', 'p2', 'recorded')).toThrow(/UNIQUE/);
    // Once the first is settled, the name is free again.
    db.prepare("UPDATE recovery_restore_intents SET phase = 'rolled_back' WHERE id = 'i1'").run();
    expect(() => insertIntent('i2', 'op2', 'p2', 'recorded')).not.toThrow();
  });

  it('refuses an unknown restore phase or mode', () => {
    const db = seeded();
    db.prepare(`INSERT INTO recovery_operations (id, idempotency_key, kind, actor, transport, state, process_epoch, created_at, updated_at)
      VALUES ('op1', 'k1', 'restore', 'admin', 'local', 'running', 'e', 1, 1)`).run();
    insertPoint(db, { id: 'p1', status: 'succeeded', snapshot_id: 's', capture_json: '{}', completed_at: 2 });
    expect(() => db.prepare(`INSERT INTO recovery_restore_intents
      (id, operation_id, point_id, target_mode, target_volume, phase, actor, process_epoch, created_at, updated_at)
      VALUES ('i1', 'op1', 'p1', 'new_volume', 'target', 'invented', 'admin', 'e', 1, 1)`).run()).toThrow(/CHECK/);
    expect(() => db.prepare(`INSERT INTO recovery_restore_intents
      (id, operation_id, point_id, target_mode, target_volume, phase, actor, process_epoch, created_at, updated_at)
      VALUES ('i2', 'op1', 'p1', 'new_path', NULL, 'recorded', 'admin', 'e', 1, 1)`).run()).not.toThrow();
  });

  it('refuses a repository secret that is not encrypted', () => {
    const db = seeded();
    expect(() => db.prepare("UPDATE recovery_repositories SET encrypted_secret = 'hunter2' WHERE id = 'r1'").run()).toThrow(/CHECK/);
  });
});
