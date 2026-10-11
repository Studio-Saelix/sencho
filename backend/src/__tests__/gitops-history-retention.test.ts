/**
 * GitOps history retention: the monitor's cleanup pass is the only bound on the
 * insert-only history and outbox tables.
 *
 * The reconcile tick appends to `gitops_history` continuously, and an
 * unresolved artifact expectation retries on its own interval, so without the
 * window both tables grow for the life of the installation. These tests pin the
 * window's behavior on real rows rather than on a mocked delete.
 *
 * One invariant is load-bearing and easy to break: the newest row of each
 * application survives the prune, because the portfolio's "last activity"
 * fact reads `MAX(created_at)` over history. Every test here that prunes a row
 * therefore writes a newer row for the same application first, so it is testing
 * the prune rather than accidentally testing that exemption.
 */
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import { DatabaseService, GITOPS_PRUNE_CHUNK_ROWS } from '../services/DatabaseService';
import { insertHistory, latestTransitionByApplication } from '../services/gitops/history';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';

let tmpDir: string;

const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  GitOpsStore.resetForTests();
  GitOpsTransitions.resetForTests();
});

afterAll(() => cleanupTestDb(tmpDir));

/**
 * Write one history row. `applicationId` is what several rows share when a test
 * needs one application's timeline rather than several applications'; the
 * unique index is (application_id, operation_id, stage, dedupe_target), so
 * distinct rows need a distinct operation id or dedupe target.
 *
 * The application row itself is inserted because the prune exempts the newest
 * row of a *live* application, and that liveness is read from
 * `gitops_applications`: a history row with no application behind it is orphaned
 * history the prune is free to take in full. Production always has the row, so
 * the test fixtures do too.
 */
function writeRow(
  operationId: string,
  at: number,
  opts: { applicationId?: string; stage?: 'source_reconcile_settled' | 'source_reconcile_started' } = {},
): string {
  const applicationId = opts.applicationId ?? `app-${operationId}`;
  const application = directApplicationFixture(applicationId, `stack-${applicationId}`);
  const store = GitOpsStore.getInstance();
  // Several rows on one application insert the application once.
  const existing = DatabaseService.getInstance().getDb()
    .prepare('SELECT 1 FROM gitops_applications WHERE id = ?')
    .get(applicationId);
  if (!existing) store.insertApplication(application);
  const id = insertHistory(DatabaseService.getInstance().getDb(), {
    application,
    nodeId: 3,
    dedupeTarget: 'app',
    operationId,
    stage: opts.stage ?? 'source_reconcile_settled',
    outcome: 'committed',
    trigger: 'poll',
    actor: 'system:source-controller',
    before: {},
    after: { outcome: 'pending_review', reason: 'ok', nextAction: 'none' },
    commitSha: null,
    at,
  });
  if (!id) throw new Error('expected history insert');
  return id;
}

/** Mark the outbox row drained, which is what the fanout does on the normal path. */
function markOutboxDrained(historyId: string): void {
  DatabaseService.getInstance().getDb()
    .prepare('UPDATE gitops_settled_outbox SET drained_at = ? WHERE settled_history_id = ?')
    .run(Date.now(), historyId);
}

/** History rows still standing for one application, newest first. */
function remainingIdsFor(db: import('better-sqlite3').Database, applicationId: string): string[] {
  return (
    db.prepare('SELECT id FROM gitops_history WHERE application_id = ? ORDER BY created_at DESC, id DESC')
      .all(applicationId) as { id: string }[]
  ).map((row) => row.id);
}

/**
 * One started or settled row with a caller-chosen id, so a test can force the
 * UUID order independently of insertion order. The application row is created
 * the same way `writeRow` does. Call started first when the settlement must
 * have the higher rowid.
 */
function insertStageRow(
  id: string,
  operationId: string,
  at: number,
  applicationId: string,
  stage: 'source_reconcile_started' | 'source_reconcile_settled',
): void {
  const application = directApplicationFixture(applicationId, `stack-${applicationId}`);
  const database = DatabaseService.getInstance().getDb();
  const existing = database.prepare('SELECT 1 FROM gitops_applications WHERE id = ?').get(applicationId);
  if (!existing) GitOpsStore.getInstance().insertApplication(application);
  database.prepare(
    `INSERT INTO gitops_history (id, created_at, application_id, target_mode, lifecycle_key,
     node_id, dedupe_target, operation_id, stage, outcome, trigger, before_json, after_json)
     VALUES (?, ?, ?, 'direct', ?, 3, 'app', ?, ?, 'committed', 'poll', '{}', '{}')`,
  ).run(id, at, applicationId, application.lifecycle_key, operationId, stage);
}

/** Run the prune until a pass deletes nothing, so a later test's counts are its own rows. */
function sweepUntilQuiet(): void {
  const db = DatabaseService.getInstance();
  for (let pass = 0; pass < 20; pass++) {
    const result = db.cleanupOldGitOpsHistory(30);
    if (result.history === 0 && result.outbox === 0) return;
  }
  throw new Error('retention prune did not finish');
}

/** Remaining counts are computed only while developer mode is on. */
function pruneWithCounts(days: number): ReturnType<DatabaseService['cleanupOldGitOpsHistory']> {
  const db = DatabaseService.getInstance();
  db.updateGlobalSetting('developer_mode', '1');
  try {
    return db.cleanupOldGitOpsHistory(days);
  } finally {
    db.updateGlobalSetting('developer_mode', '0');
  }
}

describe('GitOps history retention', () => {
  it('seeds a 30-day default and clamps an out-of-range stored value', () => {
    const db = DatabaseService.getInstance();
    expect(db.getGlobalSettings().gitops_history_retention_days).toBe('30');
    expect(db.getGitOpsHistoryRetentionDays()).toBe(30);

    db.updateGlobalSetting('gitops_history_retention_days', '9999');
    expect(db.getGitOpsHistoryRetentionDays()).toBe(365);
    db.updateGlobalSetting('gitops_history_retention_days', '30');
  });

  it('reads a stored window and falls back to 30 for garbage, zero, negative, a missing row, and a failed read', () => {
    const db = DatabaseService.getInstance();
    db.updateGlobalSetting('gitops_history_retention_days', '45');
    expect(db.getGitOpsHistoryRetentionDays()).toBe(45);

    for (const stored of ['banana', '0', '-3']) {
      db.updateGlobalSetting('gitops_history_retention_days', stored);
      expect(db.getGitOpsHistoryRetentionDays(), stored).toBe(30);
    }

    const developerMode = db.getGlobalSettings().developer_mode;
    db.getDb().prepare('DELETE FROM global_settings WHERE key = ?').run('gitops_history_retention_days');
    db.updateGlobalSetting('developer_mode', developerMode);
    expect(db.getGitOpsHistoryRetentionDays()).toBe(30);
    db.updateGlobalSetting('gitops_history_retention_days', '30');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = vi.spyOn(db, 'getGlobalSettings').mockImplementation(() => {
      throw new Error('settings unavailable');
    });
    try {
      expect(db.getGitOpsHistoryRetentionDays()).toBe(30);
      expect(warn.mock.calls.some((call) => String(call[0]).includes('gitops_history_retention_days read failed'))).toBe(true);
    } finally {
      read.mockRestore();
      warn.mockRestore();
    }
  });

  it('prunes history and drained outbox rows older than the window and keeps the newest', () => {
    const db = DatabaseService.getInstance().getDb();
    const now = Date.now();
    const app = 'app-retention-classic';
    const oldId = writeRow('op-retention-classic-old', now - 40 * DAY_MS, { applicationId: app });
    const freshId = writeRow('op-retention-classic-fresh', now - 1 * DAY_MS, { applicationId: app });
    markOutboxDrained(oldId);
    markOutboxDrained(freshId);

    const result = DatabaseService.getInstance().cleanupOldGitOpsHistory(30);

    expect(result.history).toBe(1);
    expect(result.outbox).toBe(1);
    expect(remainingIdsFor(db, app)).toEqual([freshId]);
  });

  it('keeps an application\'s newest history row even when every row is older than the window', () => {
    const db = DatabaseService.getInstance().getDb();
    // A quiet application whose only history is older than the window. Its row
    // must survive, and the "last activity" the portfolio and the application
    // sheet read must still resolve.
    const app = 'app-retention-quiet';
    const onlyRow = writeRow('op-retention-quiet-only', Date.now() - 400 * DAY_MS, { applicationId: app });

    const result = DatabaseService.getInstance().cleanupOldGitOpsHistory(30);

    expect(result.history).toBe(0);
    expect(remainingIdsFor(db, app)).toEqual([onlyRow]);
    expect(latestTransitionByApplication(db, [app]).get(app)).toBeGreaterThan(0);
  });

  it('prunes the older rows of a quiet application but not its newest one', () => {
    const db = DatabaseService.getInstance().getDb();
    const now = Date.now();
    // A quiet application with several rows, all older than the window. Only the
    // newest survives, so history is still bounded and the activity fact still
    // resolves.
    const app = 'app-retention-quiet-many';
    const ids = [45, 44, 43, 42].map((days) =>
      writeRow(`op-retention-quiet-many-${days}`, now - days * DAY_MS, { applicationId: app }));
    const newest = ids[ids.length - 1];

    const result = DatabaseService.getInstance().cleanupOldGitOpsHistory(30);

    expect(result.history).toBe(3);
    expect(remainingIdsFor(db, app)).toEqual([newest]);
    expect(latestTransitionByApplication(db, [app]).get(app)).toBeGreaterThan(0);
  });

  it('still returns an unsettled attempt from inside the window after a prune', () => {
    const store = GitOpsStore.getInstance();
    // The recovery claim: a reservation with no settlement inside the window is
    // still recoverable after a prune. A newer row is written first so the
    // reservation is not also the application's newest row: the newest-row
    // exemption would keep it even if the window filter were wrong.
    const inside = 'app-retention-recovery';
    writeRow('op-retention-recovery-inside-newer', Date.now() - 1 * DAY_MS, { applicationId: inside });
    writeRow('op-retention-recovery-inside', Date.now() - 20 * DAY_MS, {
      applicationId: inside,
      stage: 'source_reconcile_started',
    });

    DatabaseService.getInstance().cleanupOldGitOpsHistory(30);

    const returned = store.listUnsettledReconcileAttempts();
    expect(returned.some((row) => row.application_id === inside)).toBe(true);
  });

  it('keeps the newest row of a quiet application recoverable even outside the window', () => {
    const store = GitOpsStore.getInstance();
    // A process that crashed and was not restarted for longer than the window:
    // its reservation is the application's newest row, so the exemption keeps it
    // and startup recovery can still settle it rather than leaving it open.
    const app = 'app-retention-recovery-old';
    writeRow('op-retention-recovery-old-reserved', Date.now() - 60 * DAY_MS, {
      applicationId: app,
      stage: 'source_reconcile_started',
    });

    const result = DatabaseService.getInstance().cleanupOldGitOpsHistory(30);

    expect(result.history).toBe(0);
    expect(store.listUnsettledReconcileAttempts().some((row) => row.application_id === app)).toBe(true);
  });

  it('drops an unsettled attempt older than the window once a newer row exists', () => {
    const store = GitOpsStore.getInstance();
    // An unsettled reservation older than the window, then later history for the
    // same live application. The reservation is no longer the newest row, so the
    // window takes it and the next startup has nothing to recover.
    const app = 'app-retention-unsettled-superseded';
    writeRow('op-retention-unsettled-superseded-newer', Date.now() - 1 * DAY_MS, { applicationId: app });
    writeRow('op-retention-unsettled-superseded-started', Date.now() - 60 * DAY_MS, {
      applicationId: app,
      stage: 'source_reconcile_started',
    });

    const result = DatabaseService.getInstance().cleanupOldGitOpsHistory(30);

    expect(result.history).toBe(1);
    expect(store.listUnsettledReconcileAttempts().some((row) => row.application_id === app)).toBe(false);
  });

  it('keeps an undrained outbox row through the grace period, and prunes it once drained', () => {
    const db = DatabaseService.getInstance().getDb();
    const app = 'app-retention-undrained';
    // A newer row is what makes the 32-day-old row a prune candidate at all.
    writeRow('op-retention-undrained-newer', Date.now() - 1 * DAY_MS, { applicationId: app });
    const historyId = writeRow('op-retention-undrained-old', Date.now() - 32 * DAY_MS, { applicationId: app });

    // The history row is pruned by age. The notification the fanout has not
    // written yet is kept through the grace. The repair that could still drain
    // it runs at startup, so the grace only helps an instance that restarts.
    const first = DatabaseService.getInstance().cleanupOldGitOpsHistory(30);
    expect(first.history).toBe(1);
    expect(
      db.prepare('SELECT drained_at FROM gitops_settled_outbox WHERE settled_history_id = ?').get(historyId),
    ).toEqual({ drained_at: null });

    markOutboxDrained(historyId);
    const second = DatabaseService.getInstance().cleanupOldGitOpsHistory(30);
    expect(second.outbox).toBe(1);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM gitops_settled_outbox WHERE settled_history_id = ?').get(historyId),
    ).toEqual({ n: 0 });
  });

  it('drops an undrained row past the grace period and says so', () => {
    const db = DatabaseService.getInstance().getDb();
    const app = 'app-retention-poison';
    writeRow('op-retention-poison-newer', Date.now() - 1 * DAY_MS, { applicationId: app });
    const historyId = writeRow('op-retention-poison-old', Date.now() - 40 * DAY_MS, { applicationId: app });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = DatabaseService.getInstance().cleanupOldGitOpsHistory(30);
      expect(result.outbox).toBe(1);
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM gitops_settled_outbox WHERE settled_history_id = ?').get(historyId),
      ).toEqual({ n: 0 });
      // A silent backlog is the failure mode the log exists to prevent.
      expect(warn.mock.calls.some((call) => String(call[0]).includes('undrained GitOps outbox'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('falls back to the default window for a non-positive value', () => {
    const db = DatabaseService.getInstance().getDb();
    const now = Date.now();
    const app = 'app-retention-fallback';
    writeRow('op-retention-fallback-old', now - 40 * DAY_MS, { applicationId: app });
    const freshId = writeRow('op-retention-fallback-fresh', now - 1 * DAY_MS, { applicationId: app });

    // 0 is not an off switch: retention off would leave the tables unbounded,
    // which is the accumulation the setting exists to stop.
    const result = DatabaseService.getInstance().cleanupOldGitOpsHistory(0);

    expect(result.history).toBe(1);
    expect(remainingIdsFor(db, app)).toEqual([freshId]);
  });

  it('bounds each pass to a chunk of rows, so a backlog cannot hold the writer', () => {
    const db = DatabaseService.getInstance().getDb();
    sweepUntilQuiet();
    // The unchunked alternative deletes the whole backlog in one transaction,
    // holding SQLite's single writer and blocking every other write on the
    // instance for its duration. Rows are written directly rather than through
    // insertHistory: the outbox and publication side effects are not what this
    // asserts, and thousands of them would slow the suite without testing more.
    const app = 'app-retention-chunk';
    const backlogAt = Date.now() - 400 * DAY_MS;
    const backlogRows = GITOPS_PRUNE_CHUNK_ROWS * 2 + 1000;
    const windowCutoff = Date.now() - 30 * DAY_MS;
    const insert = db.prepare(
      `INSERT INTO gitops_history (id, created_at, application_id, target_mode, lifecycle_key,
       node_id, dedupe_target, operation_id, stage, outcome, trigger, before_json, after_json)
       VALUES (?, ?, ?, 'direct', ?, 3, ?, ?, 'runtime_artifact_observed', 'committed', 'poll', '{}', '{}')`,
    );
    db.transaction(() => {
      for (let i = 0; i < backlogRows; i++) {
        insert.run(randomUUID(), backlogAt, app, `direct:${app}`, `target-${i}`, `op-chunk-${i}`);
      }
    })();
    const backlogStanding = () =>
      (
        db.prepare('SELECT COUNT(*) AS n FROM gitops_history WHERE application_id = ? AND created_at < ?')
          .get(app, windowCutoff) as { n: number }
      ).n;
    // A newer row keeps every backlog row a prune candidate: without it the
    // newest of them would be exempt and the counts would be off by one.
    writeRow('op-retention-chunk-newest', Date.now() - 1 * DAY_MS, { applicationId: app });
    expect(backlogStanding()).toBe(backlogRows);

    // Developer mode is off, so this pass still deletes one chunk and reports
    // no remainder, even though rows are left. The exact remainder is what the
    // next pass reports once the diagnostic counts are on.
    const blind = DatabaseService.getInstance().cleanupOldGitOpsHistory(30);
    expect(blind.history).toBe(GITOPS_PRUNE_CHUNK_ROWS);
    expect(blind.historyRemaining).toBe(0);
    expect(blind.outboxRemaining).toBe(0);
    expect(backlogStanding()).toBe(backlogRows - GITOPS_PRUNE_CHUNK_ROWS);

    const first = pruneWithCounts(30);
    // One pass deletes exactly one chunk. An unbounded delete, or a cap raised
    // past the backlog, deletes a different number.
    expect(first.history).toBe(GITOPS_PRUNE_CHUNK_ROWS);
    expect(first.historyRemaining).toBe(backlogRows - 2 * GITOPS_PRUNE_CHUNK_ROWS);
    expect(backlogStanding()).toBe(first.historyRemaining);
    expect(first.outboxRemaining).toBe(0);

    // Later passes finish the backlog, and a pass with nothing to do is a no-op.
    while (DatabaseService.getInstance().cleanupOldGitOpsHistory(30).history > 0) {
      // Clear the backlog one bounded pass at a time, as the monitor pass does.
    }
    expect(backlogStanding()).toBe(0);
    const empty = pruneWithCounts(30);
    expect(empty.history).toBe(0);
    expect(empty.historyRemaining).toBe(0);
    expect(remainingIdsFor(db, app)).toHaveLength(1);
  });

  it('prunes a tombstoned application\'s whole history, including its newest row', () => {
    const db = DatabaseService.getInstance().getDb();
    // A retired stack must not leave a row behind for ever: the tombstone in
    // gitops_applications already keeps the application's frozen record, so the
    // exemption has nothing to preserve here.
    const app = 'app-retention-tombstoned';
    writeRow('op-retention-tombstoned-only', Date.now() - 60 * DAY_MS, { applicationId: app });
    db.prepare("UPDATE gitops_applications SET lifecycle_status = 'deleted' WHERE id = ?").run(app);

    const result = pruneWithCounts(30);

    expect(result.history).toBe(1);
    expect(result.historyRemaining).toBe(0);
    expect(remainingIdsFor(db, app)).toEqual([]);
    expect(latestTransitionByApplication(db, [app]).has(app)).toBe(false);
  });

  it('keeps the newest row of a creating application when every row is older than the window', () => {
    const db = DatabaseService.getInstance().getDb();
    // Rows are written before activation. Dropping them would leave an
    // application that goes live with no recorded activity.
    const app = 'app-retention-creating';
    writeRow('op-retention-creating-older', Date.now() - 60 * DAY_MS, { applicationId: app });
    const newest = writeRow('op-retention-creating-newest', Date.now() - 40 * DAY_MS, { applicationId: app });
    db.prepare("UPDATE gitops_applications SET lifecycle_status = 'creating' WHERE id = ?").run(app);

    const result = DatabaseService.getInstance().cleanupOldGitOpsHistory(30);

    expect(result.history).toBe(1);
    expect(remainingIdsFor(db, app)).toEqual([newest]);
  });

  it('prunes a detached application\'s whole history, including its newest row', () => {
    const db = DatabaseService.getInstance().getDb();
    const app = 'app-retention-detached';
    writeRow('op-retention-detached-only', Date.now() - 60 * DAY_MS, { applicationId: app });
    db.prepare("UPDATE gitops_applications SET lifecycle_status = 'detached' WHERE id = ?").run(app);

    const result = DatabaseService.getInstance().cleanupOldGitOpsHistory(30);

    expect(result.history).toBe(1);
    expect(remainingIdsFor(db, app)).toEqual([]);
  });

  it('keeps the settled row when it ties the started row and the started id sorts later', () => {
    const db = DatabaseService.getInstance().getDb();
    const store = GitOpsStore.getInstance();
    // Both rows of one attempt share envelope.at. The started id sorts after
    // the settled id, which is the UUID order that used to treat started as
    // newer. Started is inserted first, so its rowid is lower.
    const app = 'app-retention-tie';
    const operationId = 'op-retention-tie';
    const at = Date.now() - 60 * DAY_MS;
    insertStageRow('z-tie-started', operationId, at, app, 'source_reconcile_started');
    insertStageRow('a-tie-settled', operationId, at, app, 'source_reconcile_settled');

    DatabaseService.getInstance().cleanupOldGitOpsHistory(30);

    expect(
      db.prepare('SELECT id FROM gitops_history WHERE id = ?').get('a-tie-settled'),
    ).toEqual({ id: 'a-tie-settled' });
    expect(store.listUnsettledReconcileAttempts().some((row) => row.operation_id === operationId)).toBe(false);
  });

  it('does not drop a settled row when a chunk boundary falls inside its attempt', () => {
    const db = DatabaseService.getInstance().getDb();
    const store = GitOpsStore.getInstance();
    sweepUntilQuiet();
    // 4999 older rows, then a tied pair. Ordered by created_at then rowid, the
    // chunk of 5000 takes the older rows and the started row (inserted first)
    // and leaves the settlement. Ordered by id, the settled id sorts first and
    // would be the row the chunk deletes.
    const app = 'app-retention-chunk-tie';
    const operationId = 'op-retention-chunk-tie';
    const now = Date.now();
    writeRow('op-retention-chunk-tie-newest', now - 1 * DAY_MS, { applicationId: app });
    const fillerAt = now - 400 * DAY_MS;
    const pairAt = now - 60 * DAY_MS;
    const insert = db.prepare(
      `INSERT INTO gitops_history (id, created_at, application_id, target_mode, lifecycle_key,
       node_id, dedupe_target, operation_id, stage, outcome, trigger, before_json, after_json)
       VALUES (?, ?, ?, 'direct', ?, 3, ?, ?, 'runtime_artifact_observed', 'committed', 'poll', '{}', '{}')`,
    );
    const fillers = GITOPS_PRUNE_CHUNK_ROWS - 1;
    db.transaction(() => {
      for (let i = 0; i < fillers; i++) {
        insert.run(randomUUID(), fillerAt, app, `direct:stack-${app}`, `filler-${i}`, `op-chunk-tie-filler-${i}`);
      }
    })();
    insertStageRow('z-chunk-tie-started', operationId, pairAt, app, 'source_reconcile_started');
    insertStageRow('a-chunk-tie-settled', operationId, pairAt, app, 'source_reconcile_settled');

    const first = DatabaseService.getInstance().cleanupOldGitOpsHistory(30);

    expect(first.history).toBe(GITOPS_PRUNE_CHUNK_ROWS);
    expect(
      db.prepare('SELECT id FROM gitops_history WHERE id = ?').get('a-chunk-tie-settled'),
    ).toEqual({ id: 'a-chunk-tie-settled' });
    expect(store.listUnsettledReconcileAttempts().some((row) => row.operation_id === operationId)).toBe(false);
    sweepUntilQuiet();
  });

  it('bounds an outbox pass to one chunk', () => {
    const db = DatabaseService.getInstance().getDb();
    sweepUntilQuiet();
    const backlogAt = Date.now() - 400 * DAY_MS;
    const backlogRows = GITOPS_PRUNE_CHUNK_ROWS + 1000;
    const insert = db.prepare(
      `INSERT INTO gitops_settled_outbox
       (settled_history_id, payload_json, payload_version, created_at, updated_at, drained_at)
       VALUES (?, '{}', 1, ?, ?, ?)`,
    );
    db.transaction(() => {
      for (let i = 0; i < backlogRows; i++) {
        insert.run(`outbox-chunk-${i}`, backlogAt, backlogAt, backlogAt);
      }
    })();

    const first = pruneWithCounts(30);

    expect(first.outbox).toBe(GITOPS_PRUNE_CHUNK_ROWS);
    expect(first.outboxRemaining).toBe(backlogRows - GITOPS_PRUNE_CHUNK_ROWS);
    sweepUntilQuiet();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM gitops_settled_outbox WHERE settled_history_id LIKE 'outbox-chunk-%'").get(),
    ).toEqual({ n: 0 });
  });

  it('counts an undrained row past the grace that one pass did not delete', () => {
    const db = DatabaseService.getInstance().getDb();
    sweepUntilQuiet();
    // Past the window plus the grace, so the undrained branch is the only one
    // that can see these rows. One more than a chunk is inserted, so one row
    // is left after the pass. A remaining count that only sees drained rows
    // reports 0.
    const backlogAt = Date.now() - 40 * DAY_MS;
    const backlogRows = GITOPS_PRUNE_CHUNK_ROWS + 1;
    const insert = db.prepare(
      `INSERT INTO gitops_settled_outbox
       (settled_history_id, payload_json, payload_version, created_at, updated_at, drained_at)
       VALUES (?, '{}', 1, ?, ?, NULL)`,
    );
    db.transaction(() => {
      for (let i = 0; i < backlogRows; i++) {
        insert.run(`outbox-undrained-${i}`, backlogAt, backlogAt);
      }
    })();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const first = pruneWithCounts(30);
      expect(first.outbox).toBe(GITOPS_PRUNE_CHUNK_ROWS);
      expect(first.outboxRemaining).toBe(1);
      expect(warn.mock.calls.some((call) => String(call[0]).includes(`dropping ${GITOPS_PRUNE_CHUNK_ROWS} undrained`))).toBe(true);
    } finally {
      warn.mockRestore();
    }
    sweepUntilQuiet();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM gitops_settled_outbox WHERE settled_history_id LIKE 'outbox-undrained-%'").get(),
    ).toEqual({ n: 0 });
  });
});
