/**
 * The rollout withdrawal marker migration.
 *
 * `withdrawn_at` separates an operator's Supersede or Rollback from a system
 * supersede, and it is written onto rows that already exist. The backfill must
 * run exactly once, mark only superseded authorizations, and never touch a
 * supersede that lands after it. The states are pinned one boot each, because
 * the flag logic exists precisely for the state where the column is already
 * present: reverting it to a column-presence check must fail a test here.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
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

const BACKFILL_FLAG = 'gitops_rollout_withdrawal_backfilled';
const tmpDirs: string[] = [];

interface SeedRow {
  id: string;
  supersededAt: number | null;
}

interface Scenario {
  /** Drop the marker column, the way an install that predates this work looks. */
  dropColumn: boolean;
  /** Remove the one-time flag, the way a database from an earlier head looks. */
  clearFlag: boolean;
  rows: SeedRow[];
}

function insertAuthorization(
  db: import('better-sqlite3').Database,
  row: SeedRow,
): void {
  db.prepare(
    `INSERT INTO gitops_rollout_generations (
       id, application_id, intent_revision_id, rollout_candidate_id, required_targets_json,
       rollout_strategy_json, provenance, operation_id, trigger, created_at, superseded_at
     ) VALUES (?, 'app-wd', 'intent-wd', 'cand-wd', '{"nodeIds":[1]}', '{}', 'rollout_authorization', 'op-wd', 'manual', 1000, ?)`,
  ).run(row.id, row.supersededAt);
}

/** Build one database state and boot the service so the migration runs on it. */
function bootScenario(scenario: Scenario): DatabaseService {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-gitops-withdrawal-mig-'));
  tmpDirs.push(dir);
  process.env.DATA_DIR = dir;
  const composeDir = path.join(dir, 'compose');
  fs.mkdirSync(composeDir, { recursive: true });
  process.env.COMPOSE_DIR = composeDir;
  fs.copyFileSync(BASELINE_DB_PATH, path.join(dir, 'sencho.db'));

  const raw = new Database(path.join(dir, 'sencho.db'));
  if (scenario.dropColumn) {
    try {
      raw.exec('ALTER TABLE gitops_rollout_generations DROP COLUMN withdrawn_at');
    } catch {
      // The baseline already lacks the column.
    }
  }
  if (scenario.clearFlag) {
    raw.prepare('DELETE FROM global_settings WHERE key = ?').run(BACKFILL_FLAG);
  }
  for (const row of scenario.rows) insertAuthorization(raw, row);
  raw.close();

  resetDatabaseSingleton();
  return DbClass.getInstance();
}

beforeAll(async () => {
  vi.resetModules();
  const { DatabaseService: Reopened } = await import('../services/DatabaseService');
  DbClass = Reopened;
});

afterAll(() => {
  resetDatabaseSingleton();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function withdrawnAt(db: import('better-sqlite3').Database, id: string): number | null {
  const row = db.prepare('SELECT withdrawn_at FROM gitops_rollout_generations WHERE id = ?').get(id) as
    | { withdrawn_at: number | null }
    | undefined;
  if (!row) throw new Error(`seeded row ${id} is missing`);
  return row.withdrawn_at;
}

function flag(db: import('better-sqlite3').Database): string | undefined {
  return (db.prepare('SELECT value FROM global_settings WHERE key = ?').get(BACKFILL_FLAG) as
    | { value: string }
    | undefined)?.value;
}

describe('the rollout withdrawal marker backfill', () => {
  it('backfills a superseded authorization when the column is dropped and no flag exists', () => {
    const service = bootScenario({
      dropColumn: true,
      clearFlag: true,
      rows: [{ id: 'rgen-superseded', supersededAt: 500 }, { id: 'rgen-live', supersededAt: null }],
    });
    const db = service.getDb();
    expect(withdrawnAt(db, 'rgen-superseded')).toBe(500);
    expect(withdrawnAt(db, 'rgen-live')).toBeNull();
    expect(flag(db)).toBe('1');
  });

  it('backfills when the column is present without the flag, the earlier-head and crash-between-statements state', () => {
    const service = bootScenario({
      dropColumn: false,
      clearFlag: true,
      rows: [{ id: 'rgen-present-superseded', supersededAt: 500 }, { id: 'rgen-present-live', supersededAt: null }],
    });
    const db = service.getDb();
    // The column exists, so a presence-based gate would skip the backfill; the
    // flag is what makes this state recoverable.
    expect(withdrawnAt(db, 'rgen-present-superseded')).toBe(500);
    expect(withdrawnAt(db, 'rgen-present-live')).toBeNull();
    expect(flag(db)).toBe('1');
  });

  it('sets the flag on a fresh boot with no rows to backfill', () => {
    const service = bootScenario({ dropColumn: false, clearFlag: true, rows: [] });
    const db = service.getDb();
    expect(flag(db)).toBe('1');
    const columns = db.prepare('PRAGMA table_info(gitops_rollout_generations)').all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === 'withdrawn_at')).toBe(true);
  });

  it('leaves a system supersede that lands after the backfill untouched on the next boot', () => {
    const service = bootScenario({
      dropColumn: true,
      clearFlag: true,
      rows: [{ id: 'rgen-first-boot', supersededAt: 500 }],
    });
    const db = service.getDb();
    insertAuthorization(db, { id: 'rgen-later-system', supersededAt: 900 });
    resetDatabaseSingleton();
    const reopened = DbClass.getInstance().getDb();
    expect(withdrawnAt(reopened, 'rgen-later-system')).toBeNull();
    expect(withdrawnAt(reopened, 'rgen-first-boot')).toBe(500);
  });
});
