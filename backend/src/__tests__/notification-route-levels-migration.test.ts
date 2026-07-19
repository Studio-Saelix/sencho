/**
 * Additive `levels` column on notification_routes.
 * Exercises production DatabaseService startup against a pre-levels schema.
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

describe('notification route levels column migration', () => {
  let scratchDir: string | null = null;

  afterEach(() => {
    resetDatabaseSingleton();
    if (scratchDir) {
      try {
        fs.rmSync(scratchDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      scratchDir = null;
    }
  });

  it('adds levels via DatabaseService startup; legacy rows load as null; reopen is idempotent', { timeout: 60_000 }, () => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-route-levels-mig-'));
    const dbPath = path.join(scratchDir, 'sencho.db');
    const seed = new Database(dbPath);
    try {
      seed.exec(`
        CREATE TABLE notification_routes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          channel_type TEXT NOT NULL,
          channel_url TEXT NOT NULL,
          stack_patterns TEXT NOT NULL DEFAULT '[]',
          priority INTEGER NOT NULL DEFAULT 0,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO notification_routes
          (name, channel_type, channel_url, stack_patterns, priority, enabled, created_at, updated_at)
          VALUES ('Legacy', 'slack', 'https://hooks.slack.com/services/legacy', '[]', 0, 1, 1, 1);
      `);
    } finally {
      seed.close();
    }

    process.env.DATA_DIR = scratchDir;
    resetDatabaseSingleton();
    const db = DatabaseService.getInstance();

    const routeCols = db.getDb().prepare('PRAGMA table_info(notification_routes)').all() as Array<{ name: string }>;
    expect(routeCols.filter((c) => c.name === 'levels')).toHaveLength(1);

    const route = db.getNotificationRoutes().find((r) => r.name === 'Legacy');
    expect(route).toBeDefined();
    expect(route!.levels).toBeNull();

    resetDatabaseSingleton();
    process.env.DATA_DIR = scratchDir;
    const db2 = DatabaseService.getInstance();
    const routeCols2 = db2.getDb().prepare('PRAGMA table_info(notification_routes)').all() as Array<{ name: string }>;
    expect(routeCols2.filter((c) => c.name === 'levels')).toHaveLength(1);
    expect(db2.getNotificationRoutes().find((r) => r.name === 'Legacy')!.levels).toBeNull();
  });
});
