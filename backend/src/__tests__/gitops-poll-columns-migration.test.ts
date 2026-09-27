/**
 * A gitops_applications table created before the poll columns existed must
 * upgrade cleanly: initSchema adds poll_interval_secs and next_poll_at before
 * building the due-scan index that references next_poll_at.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BASELINE_DB_PATH } from './helpers/testConstants';
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

function applicationColumnNames(db: { pragma: (sql: string) => unknown }): string[] {
  return (db.pragma('table_info(gitops_applications)') as Array<{ name: string }>)
    .map((column) => column.name);
}

let tmpDir: string;
const originalDataDir = process.env.DATA_DIR;
const originalComposeDir = process.env.COMPOSE_DIR;

function restoreEnv(key: 'DATA_DIR' | 'COMPOSE_DIR', value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeAll(async () => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-gitops-poll-col-'));
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
    ALTER TABLE gitops_applications DROP COLUMN next_poll_at;
    ALTER TABLE gitops_applications DROP COLUMN poll_interval_secs;
  `);
  raw.close();
});

afterAll(() => {
  resetDatabaseSingleton();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  restoreEnv('DATA_DIR', originalDataDir);
  restoreEnv('COMPOSE_DIR', originalComposeDir);
});

describe('gitops poll column migration', () => {
  it('starts on a table missing the poll columns and restores them with the due indexes', async () => {
    const { DatabaseService: Fresh } = await import('../services/DatabaseService');
    resetDatabaseSingleton();
    const errorSpy = vi.spyOn(console, 'error');
    const db = Fresh.getInstance().getDb();
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to add column'),
      expect.anything(),
    );
    errorSpy.mockRestore();
    expect(applicationColumnNames(db)).toEqual(
      expect.arrayContaining(['poll_interval_secs', 'next_poll_at']),
    );
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_gitops_app_poll_due','idx_gitops_app_retry_due')",
    ).all();
    expect(indexes).toHaveLength(2);
  });
});
