/**
 * Additive kind + source_updated_at on notification_suppression_rule_tombstones.
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

describe('notification suppression tombstone migration', () => {
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

  it('adds kind and source_updated_at; legacy rows stay permanent', { timeout: 60_000 }, () => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-supp-tomb-mig-'));
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
        CREATE TABLE notification_suppression_rule_tombstones (
          id INTEGER PRIMARY KEY,
          deleted_at INTEGER NOT NULL
        );
        INSERT INTO notification_suppression_rule_tombstones (id, deleted_at)
          VALUES (42, 1700000000000);
      `);
    } finally {
      seed.close();
    }

    prevDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = scratchDir;
    resetDatabaseSingleton();
    const db = DatabaseService.getInstance();

    const cols = db.getDb().prepare('PRAGMA table_info(notification_suppression_rule_tombstones)').all() as Array<{
      name: string;
    }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('kind');
    expect(names).toContain('source_updated_at');

    const tomb = db.getNotificationSuppressionRuleTombstone(42);
    expect(tomb?.kind).toBe('permanent');
    expect(tomb?.source_updated_at).toBe(1700000000000);

    // Legacy permanent cannot be cleared by a newer hub POST.
    db.upsertNotificationSuppressionRuleReplica({
      id: 42,
      name: 'should-stay-gone',
      applies_to: 'both',
      stack_patterns: [],
      node_id: null,
      label_ids: null,
      categories: null,
      levels: null,
      enabled: true,
      expires_at: null,
      schedule: null,
      scheduleInvalid: false,
      created_at: 1,
      updated_at: 9_999_999_999_999,
    });
    expect(db.getNotificationSuppressionRule(42)).toBeUndefined();
    expect(db.getNotificationSuppressionRuleTombstone(42)?.kind).toBe('permanent');
  });
});
