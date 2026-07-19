/**
 * Restart-safe rebuild of health_gate_runs when widening the trigger CHECK and
 * adding target/failure columns.
 */
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

describe('migrateHealthGateTargetSchema', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb(tmpDir);
  });

  it('recovers from a stale health_gate_runs_new and preserves existing rows', async () => {
    const dbPath = path.join(tmpDir, 'sencho.db');
    const raw = new Database(dbPath);
    raw.exec(`
      DROP TABLE IF EXISTS health_gate_runs;
      DROP TABLE IF EXISTS health_gate_runs_new;
      CREATE TABLE health_gate_runs (
        id TEXT PRIMARY KEY,
        node_id INTEGER NOT NULL,
        stack_name TEXT NOT NULL,
        trigger_action TEXT NOT NULL CHECK (trigger_action IN ('update','deploy')),
        status TEXT NOT NULL CHECK (status IN ('observing','passed','failed','unknown')),
        reason TEXT,
        window_seconds INTEGER NOT NULL,
        containers_json TEXT NOT NULL DEFAULT '[]',
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        created_by TEXT
      );
      CREATE TABLE health_gate_runs_new (id TEXT PRIMARY KEY);
      INSERT INTO health_gate_runs (
        id, node_id, stack_name, trigger_action, status, reason, window_seconds, containers_json, started_at, ended_at, created_by
      ) VALUES ('gate-1', 1, 'web', 'update', 'passed', null, 90, '[]', 1, 2, 'tester');
    `);
    raw.close();

    const { DatabaseService } = await import('../services/DatabaseService');
    (DatabaseService as unknown as { instance?: typeof DatabaseService }).instance = undefined;
    const db = DatabaseService.getInstance();
    const row = db.getDb().prepare('SELECT * FROM health_gate_runs WHERE id = ?').get('gate-1') as {
      target_scope: string;
      service_name: string | null;
      failure_source: string | null;
      trigger_action: string;
    };
    expect(row.trigger_action).toBe('update');
    expect(row.target_scope).toBe('stack');
    expect(row.service_name).toBeNull();
    expect(row.failure_source).toBeNull();

    const stale = db.getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'health_gate_runs_new'",
    ).get();
    expect(stale).toBeUndefined();
  });
});
