/**
 * Additive `config` columns on agents and notification_routes.
 * Mirrors DatabaseService.tryAddColumn: ALTER only when missing, leave rows intact.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

function tryAddColumn(db: Database.Database, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  }
}

describe('notification channel config column migration', () => {
  it('adds config columns to a pre-config schema and keeps legacy row values', () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-apprise-mig-'));
    const dbPath = path.join(scratchDir, 'legacy.db');
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE agents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          node_id INTEGER NOT NULL DEFAULT 0,
          type TEXT NOT NULL,
          url TEXT NOT NULL,
          enabled INTEGER DEFAULT 0
        );
        INSERT INTO agents (node_id, type, url, enabled)
          VALUES (1, 'discord', 'https://discord.example/webhook/legacy', 1);

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

      tryAddColumn(db, 'agents', 'config', 'TEXT NULL');
      tryAddColumn(db, 'notification_routes', 'config', 'TEXT NULL');
      tryAddColumn(db, 'agents', 'config', 'TEXT NULL');
      tryAddColumn(db, 'notification_routes', 'config', 'TEXT NULL');

      const agentCols = db.prepare('PRAGMA table_info(agents)').all() as Array<{ name: string }>;
      const routeCols = db.prepare('PRAGMA table_info(notification_routes)').all() as Array<{ name: string }>;
      expect(agentCols.filter(c => c.name === 'config')).toHaveLength(1);
      expect(routeCols.filter(c => c.name === 'config')).toHaveLength(1);

      const agent = db.prepare('SELECT type, url, config FROM agents WHERE type = ?').get('discord') as {
        type: string; url: string; config: string | null;
      };
      expect(agent.url).toBe('https://discord.example/webhook/legacy');
      expect(agent.config).toBeNull();

      const route = db.prepare('SELECT name, channel_url, config FROM notification_routes WHERE name = ?').get('Legacy') as {
        name: string; channel_url: string; config: string | null;
      };
      expect(route.channel_url).toBe('https://hooks.slack.com/services/legacy');
      expect(route.config).toBeNull();
    } finally {
      db.close();
      try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
