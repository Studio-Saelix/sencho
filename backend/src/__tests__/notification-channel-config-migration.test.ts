/**
 * Additive `config` columns on agents and notification_routes.
 * Exercises production DatabaseService startup against a pre-config schema.
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

describe('notification channel config column migration', () => {
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

  it('adds config columns via DatabaseService startup and preserves legacy row values', () => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-apprise-mig-'));
    const dbPath = path.join(scratchDir, 'sencho.db');
    const seed = new Database(dbPath);
    try {
      seed.exec(`
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
    } finally {
      seed.close();
    }

    process.env.DATA_DIR = scratchDir;
    resetDatabaseSingleton();
    const db = DatabaseService.getInstance();

    const agentCols = db.getDb().prepare('PRAGMA table_info(agents)').all() as Array<{ name: string }>;
    const routeCols = db.getDb().prepare('PRAGMA table_info(notification_routes)').all() as Array<{ name: string }>;
    expect(agentCols.filter(c => c.name === 'config')).toHaveLength(1);
    expect(routeCols.filter(c => c.name === 'config')).toHaveLength(1);

    const agent = db.getDb().prepare('SELECT type, url, config FROM agents WHERE type = ?').get('discord') as {
      type: string; url: string; config: string | null;
    };
    expect(agent.url).toBe('https://discord.example/webhook/legacy');
    expect(agent.config).toBeNull();

    const route = db.getDb().prepare('SELECT name, channel_url, config FROM notification_routes WHERE name = ?').get('Legacy') as {
      name: string; channel_url: string; config: string | null;
    };
    expect(route.channel_url).toBe('https://hooks.slack.com/services/legacy');
    expect(route.config).toBeNull();

    // Idempotent reopen: columns stay singular and values stay intact.
    resetDatabaseSingleton();
    process.env.DATA_DIR = scratchDir;
    const db2 = DatabaseService.getInstance();
    const agentCols2 = db2.getDb().prepare('PRAGMA table_info(agents)').all() as Array<{ name: string }>;
    expect(agentCols2.filter(c => c.name === 'config')).toHaveLength(1);
    const agent2 = db2.getDb().prepare('SELECT url, config FROM agents WHERE type = ?').get('discord') as {
      url: string; config: string | null;
    };
    expect(agent2.url).toBe('https://discord.example/webhook/legacy');
    expect(agent2.config).toBeNull();
  });

  it('adds the payload_template column to an existing config-era agents schema', () => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-tpl-mig-'));
    const dbPath = path.join(scratchDir, 'sencho.db');
    const seed = new Database(dbPath);
    try {
      seed.exec(`
        CREATE TABLE agents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          node_id INTEGER NOT NULL DEFAULT 0,
          type TEXT NOT NULL,
          url TEXT NOT NULL,
          enabled INTEGER DEFAULT 0,
          config TEXT NULL
        );
        INSERT INTO agents (node_id, type, url, enabled, config)
          VALUES (1, 'discord', 'https://discord.example/webhook/legacy', 1, NULL);
      `);
    } finally {
      seed.close();
    }

    process.env.DATA_DIR = scratchDir;
    resetDatabaseSingleton();
    const db = DatabaseService.getInstance();

    const agentCols = db.getDb().prepare('PRAGMA table_info(agents)').all() as Array<{ name: string }>;
    expect(agentCols.filter(c => c.name === 'payload_template')).toHaveLength(1);

    const legacy = db.getAgents(1).find(a => a.type === 'discord')!;
    expect(legacy.url).toBe('https://discord.example/webhook/legacy');
    expect(legacy.payload_template).toBeNull();

    db.upsertAgent(1, {
      type: 'discord',
      url: 'https://discord.example/webhook/legacy',
      enabled: true,
      payload_template: '{"title": "{{level}}"}',
    });
    expect(db.getAgents(1).find(a => a.type === 'discord')!.payload_template).toBe('{"title": "{{level}}"}');
  });
});
