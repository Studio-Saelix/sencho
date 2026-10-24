/**
 * The authority policy migration.
 *
 * The rollout authorization backfill is the one piece of this work where a
 * mistake is silent, so it is pinned from both sides: an install that already
 * authorized its own rollouts keeps that behavior, and an operator who turns it
 * off keeps it off across every later boot. These additions run on every start,
 * so an ungated backfill would re-apply on every restart and quietly re-grant
 * authority nobody asked for.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BASELINE_DB_PATH } from './helpers/testConstants';
import { DatabaseService } from '../services/DatabaseService';

/**
 * `vi.resetModules()` in beforeAll makes the dynamic import a different module
 * object from the top-level one, so the reset has to go through whichever class
 * actually holds the live connection. Getting this wrong looks like a
 * "connection is not open" failure long after the migration under test passed.
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
let now: number;

/** A row of the shape the backfill must distinguish between. */
type Seed = {
  id: string;
  blueprintId: number;
  targetMode: 'direct' | 'inline_blueprint' | 'blueprint';
  lifecycleStatus: 'active' | 'creating' | 'detached' | 'deleted';
};

function seedRows(db: import('better-sqlite3').Database, rows: Seed[]): void {
  const insert = db.prepare(`
    INSERT INTO gitops_applications (
      id, lifecycle_key, lifecycle_status, target_mode, stack_name, blueprint_id,
      configured_repo_url, candidate_plan_blocked, review_required, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `);
  for (const row of rows) {
    // The CHECKs and the UNIQUE blueprint_id on the table are part of what is
    // under test, so each row is built to satisfy its own target_mode
    // constraint rather than bending it.
    const stackName = row.targetMode === 'direct' ? `stack-${row.id}` : null;
    // Only a Git-managed Blueprint carries a repo. The table's own CHECKs
    // require Direct to have a stack and no blueprint, Inline to have a
    // blueprint and no repo, and Blueprint to have both a blueprint and a repo.
    const repoUrl = row.targetMode === 'blueprint' ? `https://example.invalid/${row.id}.git` : null;
    insert.run(
      row.id,
      `key-${row.id}`,
      row.lifecycleStatus,
      row.targetMode,
      stackName,
      row.targetMode === 'direct' ? null : row.blueprintId,
      repoUrl,
      now,
      now,
    );
  }
}

function readPolicies(db: import('better-sqlite3').Database, ids: string[]): Record<string, string> {
  const read = db.prepare(
    'SELECT id, placement_policy, rollout_authorization_policy FROM gitops_applications WHERE id = ?',
  );
  const out: Record<string, string> = {};
  for (const id of ids) {
    const row = read.get(id) as { placement_policy: string; rollout_authorization_policy: string } | undefined;
    if (!row) throw new Error(`seeded row ${id} is missing`);
    out[id] = `${row.placement_policy}/${row.rollout_authorization_policy}`;
  }
  return out;
}

const ALL_ROWS: Seed[] = [
  { id: 'bp-active', blueprintId: 1001, targetMode: 'blueprint', lifecycleStatus: 'active' },
  { id: 'bp-creating', blueprintId: 1002, targetMode: 'blueprint', lifecycleStatus: 'creating' },
  { id: 'bp-detached', blueprintId: 1003, targetMode: 'blueprint', lifecycleStatus: 'detached' },
  { id: 'bp-deleted', blueprintId: 1004, targetMode: 'blueprint', lifecycleStatus: 'deleted' },
  { id: 'inline-active', blueprintId: 1005, targetMode: 'inline_blueprint', lifecycleStatus: 'active' },
  { id: 'direct-active', blueprintId: 0, targetMode: 'direct', lifecycleStatus: 'active' },
];
const ALL_IDS = ALL_ROWS.map((row) => row.id);

beforeAll(async () => {
  vi.resetModules();
  now = Date.now();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-gitops-policy-mig-'));
  process.env.DATA_DIR = tmpDir;
  const composeDir = path.join(tmpDir, 'compose');
  fs.mkdirSync(composeDir, { recursive: true });
  process.env.COMPOSE_DIR = composeDir;
  fs.copyFileSync(BASELINE_DB_PATH, path.join(tmpDir, 'sencho.db'));

  // Rebuild the database the way an install that predates this work looks: the
  // two policy columns absent, the frozen snapshot column absent, and rows of
  // every shape already present.
  const Database = (await import('better-sqlite3')).default;
  const raw = new Database(path.join(tmpDir, 'sencho.db'));
  raw.exec('ALTER TABLE gitops_applications DROP COLUMN rollout_authorization_policy');
  raw.exec('ALTER TABLE gitops_applications DROP COLUMN placement_policy');
  raw.exec('ALTER TABLE gitops_rollout_generations DROP COLUMN policy_snapshot_json');
  // The completion marker is part of the migration state, and an install that
  // predates this work has never written it. Leaving it behind would make the
  // backfill believe it had already run, which is the exact situation a real
  // legacy database is in.
  raw.exec("DELETE FROM system_state WHERE key = 'gitops_rollout_auth_policy_backfilled'");
  seedRows(raw, ALL_ROWS);
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

describe('the policy columns on a fresh install', () => {
  it('defaults a new application to operator placement and manual rollout authorization', async () => {
    const db = DbClass.getInstance().getDb();
    const row = db
      .prepare(
        'SELECT placement_policy, rollout_authorization_policy FROM gitops_applications WHERE id = ?',
      )
      .get('direct-active') as { placement_policy: string; rollout_authorization_policy: string };

    // A fresh install waits for an operator in both domains that move things.
    expect(row.placement_policy).toBe('operator');
    expect(row.rollout_authorization_policy).toBe('manual');
  });

  it('leaves a generation that predates the snapshot column as NULL, not an empty object', async () => {
    const db = DbClass.getInstance().getDb();
    const row = db
      .prepare('SELECT policy_snapshot_json FROM gitops_rollout_generations LIMIT 1')
      .get() as { policy_snapshot_json: string | null } | undefined;

    // NULL is what makes absence readable. An empty-object default would make it
    // impossible, and every existing generation would fail to decode.
    if (row) expect(row.policy_snapshot_json).toBeNull();
    const columns = db.prepare('PRAGMA table_info(gitops_rollout_generations)').all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const snapshot = columns.find((c) => c.name === 'policy_snapshot_json');
    expect(snapshot).toBeDefined();
    expect(snapshot?.notnull).toBe(0);
    expect(snapshot?.dflt_value).toBeNull();
  });
});

describe('the one-time rollout authorization backfill', () => {
  it('restores automatic authorization for a live Blueprint application', async () => {
    const db = DbClass.getInstance().getDb();
    const policies = readPolicies(db, ALL_IDS);

    // This application already authorized its own rollouts on the acceptance
    // handoff. Leaving it on the manual default would strip that behavior from
    // an install that never asked for the change.
    expect(policies['bp-active']).toBe('operator/automatic');
  });

  it('leaves every shape that never auto-authorized on the safe default', async () => {
    const db = DbClass.getInstance().getDb();
    const policies = readPolicies(db, ALL_IDS);

    // A creating Blueprint has no accepted generation to have authorized yet, and
    // Direct and Inline applications never take the Blueprint handoff at all.
    expect(policies['bp-creating']).toBe('operator/manual');
    // A detached or deleted application has no rollout to authorize.
    expect(policies['bp-detached']).toBe('operator/manual');
    expect(policies['bp-deleted']).toBe('operator/manual');
    expect(policies['inline-active']).toBe('operator/manual');
    expect(policies['direct-active']).toBe('operator/manual');
  });

  it('never grants automatic placement, because none ever existed', async () => {
    const db = DbClass.getInstance().getDb();
    const rows = db
      .prepare('SELECT DISTINCT placement_policy FROM gitops_applications')
      .all() as { placement_policy: string }[];
    for (const row of rows) {
      expect(row.placement_policy).toBe('operator');
    }
  });
});

describe('a process that died between the column and the backfill', () => {
  it('backfills on a later boot even though the column already exists', () => {
    // The gap the completion marker closes. Gating only on "this boot created
    // the column" would strand these rows for ever, because every later boot
    // sees a duplicate column and skips: existing installs would silently lose
    // the automatic rollout authorization the backfill exists to preserve, with
    // no repair path.
    const { DatabaseService: Reopened } = { DatabaseService: DbClass };
    const db = Reopened.getInstance().getDb();

    // Recreate the crash: the column is present, the marker is not, and a live
    // Blueprint row is still on the fresh-install default.
    db.exec('DELETE FROM system_state WHERE key = \'gitops_rollout_auth_policy_backfilled\'');
    db.prepare("UPDATE gitops_applications SET rollout_authorization_policy = 'manual' WHERE id = 'bp-active'").run();
    expect(readPolicies(db, ['bp-active'])['bp-active']).toBe('operator/manual');

    db.close();
    resetDatabaseSingleton();
    const relaunched = DbClass.getInstance().getDb();

    expect(readPolicies(relaunched, ['bp-active'])['bp-active']).toBe('operator/automatic');
  });
});

describe('a second boot after an operator chose manual', () => {
  it('does not re-grant automatic authorization', async () => {
    const db = DbClass.getInstance().getDb();

    // The operator turns it off the way any install can.
    db.prepare(
      "UPDATE gitops_applications SET rollout_authorization_policy = 'manual' WHERE id = 'bp-active'",
    ).run();
    expect(readPolicies(db, ['bp-active'])['bp-active']).toBe('operator/manual');

    // Every additive column runs on every boot, and the backfill is now offered
    // on every boot too, so only the completion marker stands between this and a
    // silent privilege escalation on every process restart.
    db.close();
    resetDatabaseSingleton();
    const reopened = DbClass.getInstance().getDb();

    expect(readPolicies(reopened, ['bp-active'])['bp-active']).toBe('operator/manual');
  });
});
