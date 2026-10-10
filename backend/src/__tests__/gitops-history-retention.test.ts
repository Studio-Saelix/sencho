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
import { DatabaseService } from '../services/DatabaseService';
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

describe('GitOps history retention', () => {
  it('seeds a 30-day default and clamps an out-of-range stored value', () => {
    const db = DatabaseService.getInstance();
    expect(db.getGlobalSettings().gitops_history_retention_days).toBe('30');
    expect(db.getGitOpsHistoryRetentionDays()).toBe(30);

    db.updateGlobalSetting('gitops_history_retention_days', '9999');
    expect(db.getGitOpsHistoryRetentionDays()).toBe(365);
    db.updateGlobalSetting('gitops_history_retention_days', '30');
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
    // The scenario the audit named: a quiet application whose only history is
    // older than the window. Its row must survive, and the "last activity" the
    // portfolio and the application sheet read must still resolve.
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
    // The recovery claim in the PR body: a reservation with no settlement inside
    // the window is still recoverable after a prune.
    const inside = 'app-retention-recovery';
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

  it('keeps an undrained outbox row through the grace period, and prunes it once drained', () => {
    const db = DatabaseService.getInstance().getDb();
    const app = 'app-retention-undrained';
    // A newer row is what makes the 32-day-old row a prune candidate at all.
    writeRow('op-retention-undrained-newer', Date.now() - 1 * DAY_MS, { applicationId: app });
    const historyId = writeRow('op-retention-undrained-old', Date.now() - 32 * DAY_MS, { applicationId: app });

    // The history row is pruned by age; the notification the fanout has not
    // written yet is not, because the boot repair can still drain it from the
    // payload alone.
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
    // The unchunked alternative deletes the whole backlog in one transaction,
    // holding SQLite's single writer and blocking every other write on the
    // instance for its duration. Rows are written directly rather than through
    // insertHistory: the outbox and publication side effects are not what this
    // asserts, and thousands of them would slow the suite without testing more.
    const app = 'app-retention-chunk';
    const backlogAt = Date.now() - 400 * DAY_MS;
    const backlogRows = 6000;
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

    const first = DatabaseService.getInstance().cleanupOldGitOpsHistory(30);
    // One pass, one bounded chunk: the whole backlog is not deleted in a single
    // transaction, and what is left is reported so the janitor's log can say
    // whether it is still catching up.
    expect(first.history).toBeGreaterThan(0);
    expect(first.historyRemaining).toBe(backlogRows - first.history);
    expect(backlogStanding()).toBe(first.historyRemaining);
    expect(first.outboxRemaining).toBe(0);

    // Later passes finish the backlog, and a pass with nothing to do is a no-op.
    while (DatabaseService.getInstance().cleanupOldGitOpsHistory(30).history > 0) {
      // Clear the backlog one bounded pass at a time, as the janitor does.
    }
    expect(backlogStanding()).toBe(0);
    expect(DatabaseService.getInstance().cleanupOldGitOpsHistory(30).history).toBe(0);
    expect(DatabaseService.getInstance().cleanupOldGitOpsHistory(30).historyRemaining).toBe(0);
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

    const result = DatabaseService.getInstance().cleanupOldGitOpsHistory(30);

    expect(result.history).toBe(1);
    expect(result.historyRemaining).toBe(0);
    expect(remainingIdsFor(db, app)).toEqual([]);
    expect(latestTransitionByApplication(db, [app]).has(app)).toBe(false);
  });
});
