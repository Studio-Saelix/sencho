/**
 * A `gitops_target_current` table created before the observed-invocation column
 * existed must upgrade cleanly.
 *
 * `GITOPS_SCHEMA_SQL` is a `CREATE TABLE IF NOT EXISTS` blob, so it is a no-op
 * on a table that already exists and cannot install a new column. The column
 * therefore has to be added by the additive `maybeAddCol` pass in initSchema,
 * and this test is what proves that pass reaches it: it starts from a baseline
 * with the column dropped and asserts it comes back.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BASELINE_DB_PATH } from './helpers/testConstants';
import { DatabaseService } from '../services/DatabaseService';
import { GitOpsStore, emptyTargetRow } from '../services/gitops/store';
import { decodeObservedInvocation, encodeObservedInvocation } from '../services/gitops/json';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-gitops-invocation-col-'));
  process.env.DATA_DIR = tmpDir;
  const composeDir = path.join(tmpDir, 'compose');
  fs.mkdirSync(composeDir, { recursive: true });
  process.env.COMPOSE_DIR = composeDir;
  fs.copyFileSync(BASELINE_DB_PATH, path.join(tmpDir, 'sencho.db'));

  const Database = (await import('better-sqlite3')).default;
  const raw = new Database(path.join(tmpDir, 'sencho.db'));
  raw.exec('ALTER TABLE gitops_target_current DROP COLUMN observed_invocation_json');
  // Read before closing: this is the starting condition the migration has to
  // recover from, and a closed connection cannot report it.
  expect(targetColumnNames(raw)).not.toContain('observed_invocation_json');
  raw.close();
});

afterAll(() => {
  resetDatabaseSingleton();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  restoreEnv('DATA_DIR', originalDataDir);
  restoreEnv('COMPOSE_DIR', originalComposeDir);
});

describe('observed invocation column migration', () => {
  it('restores the column on a table that predates it, without logging a failure', async () => {
    const { DatabaseService: Fresh } = await import('../services/DatabaseService');
    resetDatabaseSingleton();
    const errorSpy = vi.spyOn(console, 'error');
    const db = Fresh.getInstance().getDb();
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to add column'),
      expect.anything(),
    );
    errorSpy.mockRestore();
    expect(targetColumnNames(db)).toContain('observed_invocation_json');
  });

  it('leaves a migrated target unobserved rather than inventing a value', () => {
    // The column is nullable and there is no backfill: an apply that already
    // happened recorded nothing, and the only honest value for that is null.
    // The drift class reads null as "Sencho has not looked" and says so.
    GitOpsStore.resetForTests();
    const store = GitOpsStore.getInstance();
    store.upsertTarget({ ...emptyTargetRow('app-migrated', 1, 1) });
    expect(store.getTarget('app-migrated', 1)?.observed_invocation_json).toBeNull();
  });

  it('round-trips an observation through the restored column', () => {
    GitOpsStore.resetForTests();
    const store = GitOpsStore.getInstance();
    const observation = {
      composeFileOrder: ['compose.yaml'],
      projectName: 'migrated',
      projectDirectory: '.',
      envFileOrder: [],
      observedAt: 99,
    };
    store.upsertTarget({
      ...emptyTargetRow('app-migrated-write', 1, 1),
      observed_invocation_json: encodeObservedInvocation(observation),
    });
    expect(decodeObservedInvocation(
      store.getTarget('app-migrated-write', 1)?.observed_invocation_json ?? null,
    )).toEqual(observation);
  });
});
