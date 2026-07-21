/**
 * Additive schedule column on notification_suppression_rules.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { DatabaseService } from '../services/DatabaseService';

function resetDatabaseSingleton(): void {
  const holder = DatabaseService as unknown as { instance?: DatabaseService };
  const existing = holder.instance;
  if (existing) {
    try {
      existing.getDb().close();
    } catch {
      // already closed
    }
    holder.instance = undefined;
  }
}

describe('notification suppression schedule column migration', () => {
  let scratchDir: string | null = null;
  let prevDataDir: string | undefined;

  afterEach(() => {
    resetDatabaseSingleton();
    if (prevDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = prevDataDir;
    }
    if (scratchDir) {
      try {
        fs.rmSync(scratchDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      scratchDir = null;
    }
  });

  it('adds schedule via DatabaseService startup; legacy rows load as null', { timeout: 60_000 }, () => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-supp-sched-mig-'));
    const dbPath = path.join(scratchDir, 'sencho.db');
    const seed = new Database(dbPath);
    try {
      seed.exec(`
        CREATE TABLE notification_suppression_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          node_id INTEGER NULL,
          stack_patterns TEXT NOT NULL,
          label_ids TEXT NULL,
          categories TEXT NULL,
          levels TEXT NULL,
          applies_to TEXT NOT NULL,
          enabled INTEGER DEFAULT 1,
          expires_at INTEGER NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO notification_suppression_rules
          (name, node_id, stack_patterns, label_ids, categories, levels, applies_to, enabled, expires_at, created_at, updated_at)
          VALUES ('Legacy mute', NULL, '[]', NULL, NULL, NULL, 'both', 1, NULL, 1, 1);
      `);
    } finally {
      seed.close();
    }

    prevDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = scratchDir;
    resetDatabaseSingleton();
    const db = DatabaseService.getInstance();

    const cols = db.getDb().prepare('PRAGMA table_info(notification_suppression_rules)').all() as Array<{ name: string }>;
    expect(cols.filter((c) => c.name === 'schedule')).toHaveLength(1);

    const rule = db.getNotificationSuppressionRules().find((r) => r.name === 'Legacy mute');
    expect(rule).toBeDefined();
    expect(rule!.schedule).toBeNull();
    expect(rule!.scheduleInvalid).toBe(false);

    resetDatabaseSingleton();
    process.env.DATA_DIR = scratchDir;
    const db2 = DatabaseService.getInstance();
    const cols2 = db2.getDb().prepare('PRAGMA table_info(notification_suppression_rules)').all() as Array<{ name: string }>;
    expect(cols2.filter((c) => c.name === 'schedule')).toHaveLength(1);
  });
});
