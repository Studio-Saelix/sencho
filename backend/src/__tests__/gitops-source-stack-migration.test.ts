/**
 * Existing gitops_applications tables regain configured_source_stack_name
 * through initSchema's maybeAddCol before the due-scan indexes are rebuilt.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BASELINE_DB_PATH } from './helpers/testConstants';
import { DatabaseService } from '../services/DatabaseService';
import { SOURCE_APPLICATION_MODE_SQL } from '../services/gitops/store';

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

function applicationColumnNames(db: { pragma: (sql: string) => unknown }): string[] {
  return (db.pragma('table_info(gitops_applications)') as Array<{ name: string }>)
    .map((column) => column.name);
}

let tmpDir: string;

beforeAll(async () => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-gitops-source-col-'));
  process.env.DATA_DIR = tmpDir;
  const composeDir = path.join(tmpDir, 'compose');
  fs.mkdirSync(composeDir, { recursive: true });
  process.env.COMPOSE_DIR = composeDir;
  fs.copyFileSync(BASELINE_DB_PATH, path.join(tmpDir, 'sencho.db'));

  const Database = (await import('better-sqlite3')).default;
  const raw = new Database(path.join(tmpDir, 'sencho.db'));
  raw.exec(`
    DROP INDEX IF EXISTS idx_gitops_app_poll_due;
    DROP INDEX IF EXISTS idx_gitops_app_retry_due;
  `);
  if (applicationColumnNames(raw).includes('configured_source_stack_name')) {
    raw.exec('ALTER TABLE gitops_applications DROP COLUMN configured_source_stack_name');
  }
  raw.exec(`
    CREATE INDEX idx_gitops_app_poll_due
      ON gitops_applications(next_poll_at)
      WHERE target_mode = 'direct'
        AND lifecycle_status = 'active'
        AND suspended_at IS NULL
        AND active_operation_stage IS NULL
        AND next_poll_at IS NOT NULL
        AND retry_at IS NULL;
    CREATE INDEX idx_gitops_app_retry_due
      ON gitops_applications(retry_at)
      WHERE target_mode = 'direct'
        AND lifecycle_status = 'active'
        AND suspended_at IS NULL
        AND active_operation_stage IS NULL
        AND retry_at IS NOT NULL;
  `);
  raw.close();

  const { DatabaseService: Fresh } = await import('../services/DatabaseService');
  resetDatabaseSingleton();
  Fresh.getInstance();
});

afterAll(() => {
  resetDatabaseSingleton();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('configured_source_stack_name schema migration', () => {
  it('re-adds the retained source column and rebuilds due indexes', async () => {
    const { DatabaseService: Fresh } = await import('../services/DatabaseService');
    const db = Fresh.getInstance().getDb();
    expect(applicationColumnNames(db)).toContain('configured_source_stack_name');
    const indexes = db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN ('idx_gitops_app_poll_due','idx_gitops_app_retry_due')",
    ).all() as Array<{ name: string; sql: string }>;
    expect(indexes).toHaveLength(2);
    for (const index of indexes) {
      expect(index.sql).toContain(SOURCE_APPLICATION_MODE_SQL);
    }
  });
});
