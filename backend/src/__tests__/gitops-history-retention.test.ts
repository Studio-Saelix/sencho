/**
 * GitOps history retention: the monitor's cleanup pass is the only bound on the
 * insert-only history and outbox tables.
 *
 * The reconcile tick appends to `gitops_history` continuously, and an
 * unresolved artifact expectation retries on its own interval, so without the
 * window both tables grow for the life of the installation. These tests pin the
 * window's behavior on real rows rather than on a mocked delete.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import { DatabaseService } from '../services/DatabaseService';
import { insertHistory } from '../services/gitops/history';
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

function writeSettled(operationId: string, at: number): string {
  const id = insertHistory(DatabaseService.getInstance().getDb(), {
    application: directApplicationFixture(`app-${operationId}`, `stack-${operationId}`),
    nodeId: 3,
    dedupeTarget: 'app',
    operationId,
    stage: 'source_reconcile_settled',
    outcome: 'committed',
    trigger: 'poll',
    actor: 'system:source-controller',
    before: {},
    after: { outcome: 'pending_review', reason: 'ok', nextAction: 'none' },
    commitSha: null,
    at,
  });
  if (!id) throw new Error('expected settled history insert');
  return id;
}

/** Mark the outbox row drained, which is what the fanout does on the normal path. */
function markOutboxDrained(historyId: string): void {
  DatabaseService.getInstance().getDb()
    .prepare('UPDATE gitops_settled_outbox SET drained_at = ? WHERE settled_history_id = ?')
    .run(Date.now(), historyId);
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
    const oldId = writeSettled('op-retention-old', now - 40 * DAY_MS);
    const freshId = writeSettled('op-retention-fresh', now - 1 * DAY_MS);
    markOutboxDrained(oldId);
    markOutboxDrained(freshId);

    const result = DatabaseService.getInstance().cleanupOldGitOpsHistory(30);

    expect(result.history).toBeGreaterThanOrEqual(1);
    expect(result.outbox).toBeGreaterThanOrEqual(1);
    const remainingHistory = db
      .prepare('SELECT id FROM gitops_history WHERE id IN (?, ?)')
      .all(oldId, freshId) as { id: string }[];
    expect(remainingHistory.map((row) => row.id)).toEqual([freshId]);
    const remainingOutbox = db
      .prepare('SELECT settled_history_id FROM gitops_settled_outbox WHERE settled_history_id IN (?, ?)')
      .all(oldId, freshId) as { settled_history_id: string }[];
    expect(remainingOutbox.map((row) => row.settled_history_id)).toEqual([freshId]);
  });

  it('keeps an undrained outbox row through the grace period, and prunes it once drained', () => {
    const db = DatabaseService.getInstance().getDb();
    // Older than the 30-day window but inside the 7-day undrained grace.
    const historyId = writeSettled('op-retention-undrained', Date.now() - 32 * DAY_MS);

    // The history row is pruned by age; the notification the fanout has not
    // written yet is not, because the boot repair can still drain it from the
    // payload alone.
    const first = DatabaseService.getInstance().cleanupOldGitOpsHistory(30);
    expect(first.history).toBeGreaterThanOrEqual(1);
    expect(
      db.prepare('SELECT drained_at FROM gitops_settled_outbox WHERE settled_history_id = ?').get(historyId),
    ).toEqual({ drained_at: null });

    markOutboxDrained(historyId);
    const second = DatabaseService.getInstance().cleanupOldGitOpsHistory(30);
    expect(second.outbox).toBeGreaterThanOrEqual(1);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM gitops_settled_outbox WHERE settled_history_id = ?').get(historyId),
    ).toEqual({ n: 0 });
  });

  it('drops an undrained row past the grace period and says so', () => {
    const db = DatabaseService.getInstance().getDb();
    const historyId = writeSettled('op-retention-poison', Date.now() - 40 * DAY_MS);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = DatabaseService.getInstance().cleanupOldGitOpsHistory(30);
      expect(result.outbox).toBeGreaterThanOrEqual(1);
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
    const oldId = writeSettled('op-retention-fallback-old', now - 40 * DAY_MS);
    const freshId = writeSettled('op-retention-fallback-fresh', now - 1 * DAY_MS);

    // 0 is not an off switch: retention off would leave the tables unbounded,
    // which is the accumulation the setting exists to stop.
    const result = DatabaseService.getInstance().cleanupOldGitOpsHistory(0);

    expect(result.history).toBeGreaterThanOrEqual(1);
    const remaining = db
      .prepare('SELECT id FROM gitops_history WHERE id IN (?, ?)')
      .all(oldId, freshId) as { id: string }[];
    expect(remaining.map((row) => row.id)).toEqual([freshId]);
  });
});
