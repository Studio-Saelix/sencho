/**
 * A gitops_target_current table created before the recovery-claim columns
 * existed must upgrade cleanly: initSchema adds recovery_failure_class and
 * recovery_failure_at, and the target upsert that writes every column still
 * round-trips a row.
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

function targetColumnNames(db: { pragma: (sql: string) => unknown }): string[] {
  return (db.pragma('table_info(gitops_target_current)') as Array<{ name: string }>)
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-gitops-claim-col-'));
  process.env.DATA_DIR = tmpDir;
  const composeDir = path.join(tmpDir, 'compose');
  fs.mkdirSync(composeDir, { recursive: true });
  process.env.COMPOSE_DIR = composeDir;
  fs.copyFileSync(BASELINE_DB_PATH, path.join(tmpDir, 'sencho.db'));

  const Database = (await import('better-sqlite3')).default;
  const raw = new Database(path.join(tmpDir, 'sencho.db'));
  raw.exec(`
    ALTER TABLE gitops_target_current DROP COLUMN recovery_failure_class;
    ALTER TABLE gitops_target_current DROP COLUMN recovery_failure_at;
  `);
  raw.close();
});

afterAll(() => {
  resetDatabaseSingleton();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  restoreEnv('DATA_DIR', originalDataDir);
  restoreEnv('COMPOSE_DIR', originalComposeDir);
});

describe('gitops recovery claim column migration', () => {
  it('starts on a table missing the claim columns and restores them', async () => {
    const { DatabaseService: Fresh } = await import('../services/DatabaseService');
    resetDatabaseSingleton();
    const errorSpy = vi.spyOn(console, 'error');
    const db = Fresh.getInstance().getDb();
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to add column'),
      expect.anything(),
    );
    errorSpy.mockRestore();
    expect(targetColumnNames(db)).toEqual(
      expect.arrayContaining(['recovery_failure_class', 'recovery_failure_at']),
    );
  });

  it('round-trips a target claim through the upsert after the upgrade', async () => {
    const { DatabaseService: Fresh } = await import('../services/DatabaseService');
    const { emptyTargetRow, GitOpsStore } = await import('../services/gitops/store');
    resetDatabaseSingleton();
    const db = Fresh.getInstance().getDb();
    const now = Date.now();
    db.prepare(`
      INSERT INTO gitops_applications (id, lifecycle_key, lifecycle_status, target_mode, stack_name, created_at, updated_at)
      VALUES ('app-claim-migration', 'direct:claim-migration', 'active', 'direct', 'claim-migration', ?, ?)
    `).run(now, now);
    const store = GitOpsStore.getInstance();
    store.upsertTarget({
      ...emptyTargetRow('app-claim-migration', 1, now),
      recovery_phase: 'failed',
      recovery_failure_class: 'partial',
      recovery_failure_at: 1234,
    });

    const row = store.getTarget('app-claim-migration', 1)!;
    expect(row.recovery_phase).toBe('failed');
    expect(row.recovery_failure_class).toBe('partial');
    expect(row.recovery_failure_at).toBe(1234);
  });
});
