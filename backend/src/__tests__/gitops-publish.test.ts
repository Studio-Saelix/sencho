/**
 * Announcement of committed transitions: the metric increment and the
 * `state-invalidate` event that each newly inserted history row produces.
 *
 * The drain is deliberately exercised through the real `setImmediate` rather
 * than a test-only flush. The whole reason the publisher waits for a macrotask
 * is that better-sqlite3 transactions are synchronous, so a test that drained
 * by hand would prove the drain works and prove nothing about when it runs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import { DatabaseService } from '../services/DatabaseService';
import { GitOpsMetricsService } from '../services/GitOpsMetricsService';
import { insertHistory } from '../services/gitops/history';
import {
  enqueueHistoryPublication,
  resetGitOpsPublicationsForTests,
  setGitOpsEventSink,
  type GitOpsInvalidateEvent,
} from '../services/gitops/publish';
import { drainSettledOutboxRow, repairGitOpsSettledOutbox, settledNotificationDedupeKey } from '../services/gitops/outbox';
import { decodeSettledAttemptPayload, encodeSettledAttemptPayload } from '../services/gitops/attemptPayload';

/**
 * The real module, with the enqueue entry point wrapped in a spy.
 *
 * Needed because a replay is suppressed twice over: the insert declines to
 * enqueue it, and the drain would drop it anyway since the id it carries was
 * never committed. An outcome assertion therefore passes with the first
 * mechanism deleted, which is exactly the false green this suite exists to
 * avoid, so the call itself has to be observable.
 */
vi.mock('../services/gitops/publish', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/gitops/publish')>();
  return { ...actual, enqueueHistoryPublication: vi.fn(actual.enqueueHistoryPublication) };
});

/** Let the publisher's own scheduling run. */
const settle = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

describe('gitops transition announcements', () => {
  let tmpDir: string;
  let events: GitOpsInvalidateEvent[];

  beforeAll(async () => {
    tmpDir = await setupTestDb();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  afterEach(() => {
    resetGitOpsPublicationsForTests();
    GitOpsMetricsService.resetForTests();
    vi.mocked(enqueueHistoryPublication).mockClear();
  });

  const listen = (): void => {
    events = [];
    setGitOpsEventSink((event) => { events.push(event); });
  };

  const db = () => DatabaseService.getInstance().getDb();

  const write = (
    operationId: string,
    stage: Parameters<typeof insertHistory>[1]['stage'],
    outcome: Parameters<typeof insertHistory>[1]['outcome'] = 'committed',
    overrides: Partial<Parameters<typeof insertHistory>[1]> = {},
  ): string | null => insertHistory(db(), {
    application: directApplicationFixture(`app-${operationId}`, `stack-${operationId}`),
    nodeId: 3,
    dedupeTarget: 'app',
    operationId,
    stage,
    outcome,
    trigger: 'manual',
    actor: 'operator-1',
    before: {},
    after: {},
    at: 4242,
    ...overrides,
  });

  it('announces one event and one count per inserted row', async () => {
    listen();
    write('op-1', 'fetch_started');
    await settle();

    expect(events).toEqual([{
      type: 'state-invalidate',
      scope: 'gitops',
      action: 'fetch_started',
      applicationId: 'app-op-1',
      targetMode: 'direct',
      stackName: 'stack-op-1',
      blueprintId: null,
      nodeId: 3,
      ts: 4242,
    }]);
    expect(GitOpsMetricsService.getInstance().snapshot()).toEqual([
      { stage: 'fetch_started', outcome: 'committed', count: 1 },
    ]);
  });

  it('announces rows in the order they were inserted', async () => {
    listen();
    write('op-order', 'fetch_started');
    write('op-order', 'fetched', 'committed', { dedupeTarget: 'node:3' });
    write('op-order', 'apply_failed', 'failed', { dedupeTarget: 'node:9' });
    await settle();

    expect(events.map((e) => e.action)).toEqual(['fetch_started', 'fetched', 'apply_failed']);
  });

  it('says nothing for a transaction that rolled back', async () => {
    listen();
    // The row is inserted and then discarded, which is what a transition
    // throwing after its history write looks like. Announcing it would tell
    // every client about a state change that never happened.
    expect(() => db().transaction(() => {
      write('op-rollback', 'applied');
      throw new Error('transition rejected');
    })()).toThrow('transition rejected');
    await settle();

    expect(events).toEqual([]);
    expect(GitOpsMetricsService.getInstance().snapshot()).toEqual([]);
  });

  it('does not even queue a replay of the same transition', async () => {
    listen();
    expect(write('op-replay', 'applied')).not.toBeNull();
    await settle();
    expect(events).toHaveLength(1);
    expect(vi.mocked(enqueueHistoryPublication)).toHaveBeenCalledTimes(1);

    // Same application, operation, stage and dedupe target: the dedupe index
    // rejects it, so no row is inserted and nothing is queued.
    expect(write('op-replay', 'applied')).toBeNull();
    await settle();

    expect(vi.mocked(enqueueHistoryPublication)).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(GitOpsMetricsService.getInstance().snapshot()).toEqual([
      { stage: 'applied', outcome: 'committed', count: 1 },
    ]);
  });

  it('counts even when no sink is installed, and says so once', async () => {
    events = [];
    setGitOpsEventSink(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      write('op-nosink', 'deploy_started');
      write('op-nosink', 'deploy_bound', 'committed', { dedupeTarget: 'node:4' });
      await settle();

      expect(events).toEqual([]);
      expect(GitOpsMetricsService.getInstance().snapshot()).toEqual([
        { stage: 'deploy_bound', outcome: 'committed', count: 1 },
        { stage: 'deploy_started', outcome: 'committed', count: 1 },
      ]);
      // Once for the batch, not once per row: an unwired sink is one fact, and
      // a boot migration would otherwise fill the log with it.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('no event sink installed');
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps announcing the batch when one broadcast throws', async () => {
    const seen: string[] = [];
    setGitOpsEventSink((event) => {
      if (event.action === 'fetched') throw new Error('socket gone');
      seen.push(event.action);
    });
    write('op-throw', 'fetch_started');
    write('op-throw', 'fetched', 'committed', { dedupeTarget: 'node:1' });
    write('op-throw', 'applied', 'committed', { dedupeTarget: 'node:2' });
    await settle();

    expect(seen).toEqual(['fetch_started', 'applied']);
    // The failed broadcast still happened as far as the model is concerned:
    // the transition committed, and the count describes the transition.
    expect(GitOpsMetricsService.getInstance().snapshot().map((e) => e.stage))
      .toEqual(['applied', 'fetch_started', 'fetched']);
  });

  const writeSettled = (operationId: string): string => {
    const id = insertHistory(db(), {
      application: directApplicationFixture(`app-${operationId}`, `stack-${operationId}`),
      nodeId: 3,
      dedupeTarget: 'app',
      operationId,
      stage: 'source_reconcile_settled',
      outcome: 'committed',
      trigger: 'poll',
      actor: 'system:source-controller',
      before: {},
      after: { outcome: 'no_source_change', reason: 'ok', nextAction: 'none' },
      at: 4242,
    });
    if (!id) throw new Error('expected settled history insert');
    return id;
  };

  it('inserts an outbox row in the same transaction as a settled history commit', () => {
    const historyId = writeSettled('op-outbox');
    const outbox = db().prepare(
      'SELECT settled_history_id, payload_version, drained_at FROM gitops_settled_outbox WHERE settled_history_id = ?',
    ).get(historyId) as { settled_history_id: string; payload_version: number; drained_at: number | null };
    expect(outbox.settled_history_id).toBe(historyId);
    expect(outbox.payload_version).toBe(1);
    expect(outbox.drained_at).toBeNull();
  });

  it('rolls the outbox row back with the settled history row', async () => {
    expect(() => db().transaction(() => {
      writeSettled('op-outbox-rollback');
      throw new Error('transition rejected');
    })()).toThrow('transition rejected');
    await settle();
    const count = db().prepare(
      "SELECT COUNT(*) AS n FROM gitops_settled_outbox WHERE settled_history_id IN (SELECT id FROM gitops_history WHERE operation_id = 'op-outbox-rollback')",
    ).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('drains a settled row once and a second repair is a no-op', async () => {
    const historyId = writeSettled('op-outbox-repair');
    resetGitOpsPublicationsForTests();
    repairGitOpsSettledOutbox();
    const first = db().prepare(
      'SELECT COUNT(*) AS n FROM notification_history WHERE dedupe_key = ?',
    ).get(`gitops:settled:${historyId}`) as { n: number };
    expect(first.n).toBe(1);
    const drained = db().prepare(
      'SELECT drained_at FROM gitops_settled_outbox WHERE settled_history_id = ?',
    ).get(historyId) as { drained_at: number | null };
    expect(drained.drained_at).not.toBeNull();
    repairGitOpsSettledOutbox();
    const second = db().prepare(
      'SELECT COUNT(*) AS n FROM notification_history WHERE dedupe_key = ?',
    ).get(`gitops:settled:${historyId}`) as { n: number };
    expect(second.n).toBe(1);
  });

  it('does not insert a second notification when the unique key collides', () => {
    const historyId = writeSettled('op-outbox-dedupe');
    resetGitOpsPublicationsForTests();
    DatabaseService.getInstance().addNotificationHistory(3, {
      level: 'info',
      category: 'git_pull_ready',
      message: 'pre-existing',
      timestamp: 1,
      gitops_operation_id: 'op-outbox-dedupe',
      dedupe_key: settledNotificationDedupeKey(historyId),
    });
    drainSettledOutboxRow(db(), historyId);
    const count = db().prepare(
      'SELECT COUNT(*) AS n FROM notification_history WHERE dedupe_key = ?',
    ).get(settledNotificationDedupeKey(historyId)) as { n: number };
    expect(count.n).toBe(1);
    const note = db().prepare(
      'SELECT message FROM notification_history WHERE dedupe_key = ?',
    ).get(settledNotificationDedupeKey(historyId)) as { message: string };
    expect(note.message).toBe('pre-existing');
    const drained = db().prepare(
      'SELECT drained_at FROM gitops_settled_outbox WHERE settled_history_id = ?',
    ).get(historyId) as { drained_at: number | null };
    expect(drained.drained_at).not.toBeNull();
  });

  it('fans out from the decoded payload rather than the history row', () => {
    const historyId = writeSettled('op-outbox-payload');
    resetGitOpsPublicationsForTests();
    db().prepare(
      'UPDATE gitops_settled_outbox SET payload_json = ? WHERE settled_history_id = ?',
    ).run(encodeSettledAttemptPayload({
      version: 1,
      settledHistoryId: historyId,
      applicationId: 'app-op-outbox-payload',
      operationId: 'op-outbox-payload',
      stackName: 'stack-op-outbox-payload',
      nodeId: 3,
      outcome: 'blocked',
      nextAction: 'none',
      reason: 'decoded-reason',
      trigger: 'poll',
      actor: 'system:source-controller',
      at: 4242,
    }), historyId);
    drainSettledOutboxRow(db(), historyId);
    const note = db().prepare(
      'SELECT message, category FROM notification_history WHERE dedupe_key = ?',
    ).get(settledNotificationDedupeKey(historyId)) as { message: string; category: string };
    expect(note.category).toBe('git_plan_blocked');
    expect(note.message).toContain('decoded-reason');
  });

  it('fails closed on an unknown payload version instead of inventing evidence', () => {
    const historyId = writeSettled('op-outbox-version');
    resetGitOpsPublicationsForTests();
    db().prepare(
      'UPDATE gitops_settled_outbox SET payload_version = 99, drained_at = NULL WHERE settled_history_id = ?',
    ).run(historyId);
    db().prepare('DELETE FROM notification_history WHERE gitops_operation_id = ?').run('op-outbox-version');
    drainSettledOutboxRow(db(), historyId);
    expect(decodeSettledAttemptPayload('{"version":99}', 99)).toEqual({
      ok: false,
      limitation: expect.stringContaining('version_unsupported'),
    });
    const note = db().prepare(
      'SELECT COUNT(*) AS n FROM notification_history WHERE gitops_operation_id = ?',
    ).get('op-outbox-version') as { n: number };
    expect(note.n).toBe(0);
    const undrained = db().prepare(
      'SELECT drained_at FROM gitops_settled_outbox WHERE settled_history_id = ?',
    ).get(historyId) as { drained_at: number | null };
    expect(undrained.drained_at).toBeNull();
  });
});

describe('GitOpsMetricsService', () => {
  afterEach(() => {
    GitOpsMetricsService.resetForTests();
  });

  it('keeps one count per stage and outcome pair', () => {
    const metrics = GitOpsMetricsService.getInstance();
    metrics.record('fetched', 'committed');
    metrics.record('fetched', 'committed');
    metrics.record('fetched', 'failed');
    metrics.record('applied', 'committed');

    expect(metrics.snapshot()).toEqual([
      { stage: 'applied', outcome: 'committed', count: 1 },
      { stage: 'fetched', outcome: 'committed', count: 2 },
      { stage: 'fetched', outcome: 'failed', count: 1 },
    ]);
  });

  it('reports nothing before anything has been recorded', () => {
    expect(GitOpsMetricsService.getInstance().snapshot()).toEqual([]);
  });

  it('hands out copies, so a caller cannot edit the counters', () => {
    const metrics = GitOpsMetricsService.getInstance();
    metrics.record('applied', 'committed');
    const first = metrics.snapshot();
    first[0].count = 99;

    expect(metrics.snapshot()).toEqual([{ stage: 'applied', outcome: 'committed', count: 1 }]);
  });
});
