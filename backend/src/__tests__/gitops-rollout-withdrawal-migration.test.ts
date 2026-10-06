/**
 * The rollout withdrawal marker migration.
 *
 * `withdrawn_at` separates an operator's Supersede or Rollback from a system
 * supersede, and it is written onto rows that already exist. The backfill must
 * run exactly once, mark only superseded authorizations, and never touch a
 * supersede that lands after it, so each of those properties is pinned here.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BASELINE_DB_PATH } from './helpers/testConstants';
import { DatabaseService } from '../services/DatabaseService';

/**
 * `vi.resetModules()` makes the dynamic import a different module object from
 * the top-level one, so the reset has to go through whichever class actually
 * holds the live connection.
 */
let DbClass: typeof DatabaseService;

function resetDatabaseSingleton(): void {
  const holder = DbClass as unknown as { instance?: DatabaseService };
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

let tmpDir: string;
const BACKFILL_FLAG = 'gitops_rollout_withdrawal_backfilled';

function insertAuthorization(
  db: import('better-sqlite3').Database,
  id: string,
  supersededAt: number | null,
): void {
  db.prepare(
    `INSERT INTO gitops_rollout_generations (
       id, application_id, intent_revision_id, rollout_candidate_id, required_targets_json,
       rollout_strategy_json, provenance, operation_id, trigger, created_at, superseded_at
     ) VALUES (?, 'app-wd', 'intent-wd', 'cand-wd', '{"nodeIds":[1]}', '{}', 'rollout_authorization', 'op-wd', 'manual', 1000, ?)`,
  ).run(id, supersededAt);
}

beforeAll(async () => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-gitops-withdrawal-mig-'));
  process.env.DATA_DIR = tmpDir;
  const composeDir = path.join(tmpDir, 'compose');
  fs.mkdirSync(composeDir, { recursive: true });
  process.env.COMPOSE_DIR = composeDir;
  fs.copyFileSync(BASELINE_DB_PATH, path.join(tmpDir, 'sencho.db'));

  // The state an install that predates this work is in: no marker column and no
  // backfill flag, with one superseded authorization and one live one.
  const Database = (await import('better-sqlite3')).default;
  const raw = new Database(path.join(tmpDir, 'sencho.db'));
  try {
    raw.exec('ALTER TABLE gitops_rollout_generations DROP COLUMN withdrawn_at');
  } catch {
    // The baseline already lacks the column.
  }
  raw.prepare('DELETE FROM global_settings WHERE key = ?').run(BACKFILL_FLAG);
  insertAuthorization(raw, 'rgen-superseded', 500);
  insertAuthorization(raw, 'rgen-live', null);
  raw.close();

  const { DatabaseService: Reopened } = await import('../services/DatabaseService');
  DbClass = Reopened;
  resetDatabaseSingleton();
  Reopened.getInstance();
});

afterAll(() => {
  resetDatabaseSingleton();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('the rollout withdrawal marker backfill', () => {
  it('marks a superseded authorization as withdrawn and leaves a live one alone', () => {
    const db = DbClass.getInstance().getDb();
    const rows = db.prepare(
      'SELECT id, withdrawn_at FROM gitops_rollout_generations WHERE id IN (?, ?) ORDER BY id',
    ).all('rgen-live', 'rgen-superseded') as Array<{ id: string; withdrawn_at: number | null }>;
    expect(rows).toEqual([
      { id: 'rgen-live', withdrawn_at: null },
      { id: 'rgen-superseded', withdrawn_at: 500 },
    ]);
  });

  it('sets the one-time flag', () => {
    const db = DbClass.getInstance().getDb();
    const row = db.prepare('SELECT value FROM global_settings WHERE key = ?').get(BACKFILL_FLAG) as
      | { value: string }
      | undefined;
    expect(row?.value).toBe('1');
  });

  it('leaves a system supersede that lands after the backfill untouched on the next boot', () => {
    const db = DbClass.getInstance().getDb();
    insertAuthorization(db, 'rgen-later-system', 900);
    resetDatabaseSingleton();
    const reopened = DbClass.getInstance().getDb();
    const row = reopened.prepare(
      'SELECT withdrawn_at FROM gitops_rollout_generations WHERE id = ?',
    ).get('rgen-later-system') as { withdrawn_at: number | null } | undefined;
    expect(row?.withdrawn_at).toBeNull();
  });
});
