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
import { GitOpsStore } from '../services/gitops/store';
import { insertHistory } from '../services/gitops/history';
import {
  enqueueHistoryPublication,
  resetGitOpsPublicationsForTests,
  setGitOpsEventSink,
  type GitOpsInvalidateEvent,
} from '../services/gitops/publish';
import {
  drainGitOpsOutboxRow,
  gitOpsEventNotificationDedupeKey,
  repairGitOpsOutbox,
  settledNotificationDedupeKey,
} from '../services/gitops/outbox';
import {
  GITOPS_EVENT_PAYLOAD_VERSION,
  decodeGitOpsEventPayload,
  decodeSettledAttemptPayload,
  encodeSettledAttemptPayload,
} from '../services/gitops/attemptPayload';
import {
  GITOPS_NOTIFICATION_META,
  gitOpsNotificationReason,
} from '../services/gitops/notifications';
import type { GitOpsApplicationRow } from '../services/gitops/types';

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
    repairGitOpsOutbox();
    const first = db().prepare(
      'SELECT COUNT(*) AS n FROM notification_history WHERE dedupe_key = ?',
    ).get(`gitops:settled:${historyId}`) as { n: number };
    expect(first.n).toBe(1);
    const drained = db().prepare(
      'SELECT drained_at FROM gitops_settled_outbox WHERE settled_history_id = ?',
    ).get(historyId) as { drained_at: number | null };
    expect(drained.drained_at).not.toBeNull();
    repairGitOpsOutbox();
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
    drainGitOpsOutboxRow(db(), historyId);
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
    drainGitOpsOutboxRow(db(), historyId);
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
    drainGitOpsOutboxRow(db(), historyId);
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

  /** A live Blueprint application backed by a real Blueprint row. */
  const seedBlueprintApplication = (name: string): { application: GitOpsApplicationRow; blueprintName: string } => {
    const blueprint = DatabaseService.getInstance().createBlueprint({
      name,
      description: null,
      compose_content: 'services:\n  app:\n    image: nginx:1.27\n',
      selector: { type: 'nodes', ids: [] },
      drift_mode: 'suggest',
      classification: 'stateless',
      classification_reasons: [],
      enabled: true,
      created_by: 'tester',
    });
    const applicationId = `app-${blueprint.id}`;
    const application = directApplicationFixture(applicationId, `src-${applicationId}`);
    application.target_mode = 'blueprint';
    application.lifecycle_key = `blueprint:${blueprint.id}`;
    application.blueprint_id = blueprint.id;
    application.stack_name = null;
    GitOpsStore.getInstance().insertApplication(application);
    return { application, blueprintName: blueprint.name };
  };

  it('writes a v2 outbox row for a notifiable lifecycle stage and none for an ordinary one', () => {
    const pausedId = write('op-event-pause', 'rollout_paused', 'committed', {
      after: { pauseAt: 4242, pauseReason: 'maintenance window' },
    });
    expect(pausedId).not.toBeNull();
    const paused = db().prepare(
      'SELECT payload_version, drained_at FROM gitops_settled_outbox WHERE settled_history_id = ?',
    ).get(pausedId) as { payload_version: number; drained_at: number | null };
    expect(paused.payload_version).toBe(GITOPS_EVENT_PAYLOAD_VERSION);
    expect(paused.drained_at).toBeNull();

    const appliedId = write('op-event-applied', 'applied');
    expect(db().prepare(
      'SELECT COUNT(*) AS n FROM gitops_settled_outbox WHERE settled_history_id = ?',
    ).get(appliedId)).toEqual({ n: 0 });
  });

  it('notifies a Blueprint source acceptance but not a Direct one', () => {
    // A Direct acceptance is the source controller's automatic bookkeeping,
    // and the settled attempt already notifies the operator of the change.
    const directId = write('op-accept-direct', 'source_accepted');
    expect(db().prepare(
      'SELECT COUNT(*) AS n FROM gitops_settled_outbox WHERE settled_history_id = ?',
    ).get(directId)).toEqual({ n: 0 });

    const { application } = seedBlueprintApplication('bp-notify-accept');
    const historyId = insertHistory(db(), {
      application,
      nodeId: null,
      dedupeTarget: 'app',
      operationId: `op-accept-bp-${application.id}`,
      stage: 'source_accepted',
      outcome: 'committed',
      trigger: 'manual',
      actor: 'operator-1',
      before: {},
      after: {},
      at: 4242,
    });
    if (!historyId) throw new Error('expected event history insert');
    const row = db().prepare(
      'SELECT payload_version FROM gitops_settled_outbox WHERE settled_history_id = ?',
    ).get(historyId) as { payload_version: number };
    expect(row.payload_version).toBe(GITOPS_EVENT_PAYLOAD_VERSION);
  });

  it('drains a lifecycle event once, on the node it names, with its mapped category and level', () => {
    const historyId = write('op-event-drain', 'rollback_partial_failed', 'failed', {
      actor: 'operator-2',
      after: { failureClass: 'partial' },
      dedupeTarget: 'node:7',
      nodeId: 7,
    });
    if (!historyId) throw new Error('expected event history insert');
    resetGitOpsPublicationsForTests();
    repairGitOpsOutbox();

    const meta = GITOPS_NOTIFICATION_META.rollback_partial_failed;
    const note = db().prepare(
      'SELECT node_id, category, level, message, actor_username, gitops_operation_id FROM notification_history WHERE dedupe_key = ?',
    ).get(gitOpsEventNotificationDedupeKey(historyId)) as {
      node_id: number;
      category: string;
      level: string;
      message: string;
      actor_username: string;
      gitops_operation_id: string;
    };
    expect(note).toEqual({
      node_id: 7,
      category: meta.category,
      level: meta.level,
      message: expect.stringContaining('rollback partially failed'),
      actor_username: 'operator-2',
      gitops_operation_id: 'op-event-drain',
    });
    const drained = db().prepare(
      'SELECT drained_at FROM gitops_settled_outbox WHERE settled_history_id = ?',
    ).get(historyId) as { drained_at: number | null };
    expect(drained.drained_at).not.toBeNull();

    repairGitOpsOutbox();
    const count = db().prepare(
      'SELECT COUNT(*) AS n FROM notification_history WHERE dedupe_key = ?',
    ).get(gitOpsEventNotificationDedupeKey(historyId)) as { n: number };
    expect(count.n).toBe(1);
  });

  it('drains a v2 row through the live publisher, not only the startup repair', async () => {
    listen();
    const historyId = write('op-event-live', 'rollout_authorized');
    if (!historyId) throw new Error('expected event history insert');
    await settle();

    const note = db().prepare(
      'SELECT category FROM notification_history WHERE dedupe_key = ?',
    ).get(gitOpsEventNotificationDedupeKey(historyId)) as { category: string } | undefined;
    expect(note?.category).toBe('gitops_rollout_authorized');
    const drained = db().prepare(
      'SELECT drained_at FROM gitops_settled_outbox WHERE settled_history_id = ?',
    ).get(historyId) as { drained_at: number | null };
    expect(drained.drained_at).not.toBeNull();
  });

  it('rolls the v2 outbox row back with its history row and queues one row per replay', async () => {
    expect(() => db().transaction(() => {
      write('op-event-rollback', 'rollout_paused', 'committed', { after: { pauseReason: 'x' } });
      throw new Error('transition rejected');
    })()).toThrow('transition rejected');
    await settle();
    const rolledBack = db().prepare(
      "SELECT COUNT(*) AS n FROM gitops_settled_outbox WHERE settled_history_id IN (SELECT id FROM gitops_history WHERE operation_id = 'op-event-rollback')",
    ).get() as { n: number };
    expect(rolledBack.n).toBe(0);

    const first = write('op-event-replay', 'rollout_paused', 'committed', { after: { pauseReason: 'x' } });
    expect(first).not.toBeNull();
    // Same application, operation, stage and dedupe target: no row, no queue.
    expect(write('op-event-replay', 'rollout_paused', 'committed', { after: { pauseReason: 'x' } })).toBeNull();
    await settle();
    const replayRows = db().prepare(
      "SELECT COUNT(*) AS n FROM gitops_settled_outbox WHERE settled_history_id IN (SELECT id FROM gitops_history WHERE operation_id = 'op-event-replay')",
    ).get() as { n: number };
    expect(replayRows.n).toBe(1);
  });

  it('names the Blueprint when a Git-managed application has no stack name', () => {
    const { application, blueprintName } = seedBlueprintApplication('bp-notify-label');
    const historyId = insertHistory(db(), {
      application,
      nodeId: null,
      dedupeTarget: 'app',
      operationId: `op-bp-label-${application.id}`,
      stage: 'rollout_paused',
      outcome: 'committed',
      trigger: 'manual',
      actor: 'operator-1',
      before: {},
      after: { pauseReason: 'window' },
      at: 4242,
    });
    if (!historyId) throw new Error('expected event history insert');
    resetGitOpsPublicationsForTests();
    repairGitOpsOutbox();

    const note = db().prepare(
      'SELECT message FROM notification_history WHERE dedupe_key = ?',
    ).get(gitOpsEventNotificationDedupeKey(historyId)) as { message: string };
    expect(note.message).toContain(`Blueprint "${blueprintName}"`);
    expect(note.message).not.toContain(application.id);
  });

  it('echoes a reason the transition recorded', () => {
    const historyId = write('op-event-pause-reason', 'rollout_paused', 'committed', {
      after: { pauseAt: 4242, pauseReason: 'maintenance window' },
    });
    if (!historyId) throw new Error('expected event history insert');
    resetGitOpsPublicationsForTests();
    repairGitOpsOutbox();
    const note = db().prepare(
      'SELECT message FROM notification_history WHERE dedupe_key = ?',
    ).get(gitOpsEventNotificationDedupeKey(historyId)) as { message: string };
    expect(note.message).toContain('rollout paused');
    expect(note.message).toContain('maintenance window');
  });

  it('leaves a v2 payload naming a non-notifiable stage undrained', () => {
    const historyId = write('op-event-tamper', 'rollout_paused', 'committed', {
      after: { pauseAt: 4242, pauseReason: 'window' },
    });
    if (!historyId) throw new Error('expected event history insert');
    resetGitOpsPublicationsForTests();
    // `applied` is a real history stage and not a notifiable one, so the
    // decoder must refuse it rather than map it to another stage's event.
    db().prepare(
      'UPDATE gitops_settled_outbox SET payload_json = ? WHERE settled_history_id = ?',
    ).run(JSON.stringify({
      version: 2,
      historyId,
      applicationId: 'app-op-event-tamper',
      operationId: 'op-event-tamper',
      stage: 'applied',
      stackName: null,
      nodeId: 3,
      actor: null,
      reason: null,
      at: 4242,
    }), historyId);
    drainGitOpsOutboxRow(db(), historyId);
    expect(decodeGitOpsEventPayload(JSON.stringify({
      version: 2,
      historyId: 'h',
      applicationId: 'a',
      operationId: 'o',
      stage: 'applied',
      stackName: null,
      nodeId: null,
      actor: null,
      reason: null,
      at: 1,
    }), 2)).toEqual({ ok: false, limitation: 'gitops_event_payload_invalid' });
    const count = db().prepare(
      'SELECT COUNT(*) AS n FROM notification_history WHERE gitops_operation_id = ?',
    ).get('op-event-tamper') as { n: number };
    expect(count.n).toBe(0);
    const undrained = db().prepare(
      'SELECT drained_at FROM gitops_settled_outbox WHERE settled_history_id = ?',
    ).get(historyId) as { drained_at: number | null };
    expect(undrained.drained_at).toBeNull();
  });
});

describe('GitOps notification mapping', () => {
  it('maps every notifiable stage to its exact category, level, and phrase', () => {
    expect(GITOPS_NOTIFICATION_META).toEqual({
      source_accepted: { category: 'gitops_source_accepted', level: 'info', phrase: 'source accepted' },
      placement_approved: { category: 'gitops_placement_approved', level: 'info', phrase: 'placement approved' },
      rollout_authorized: { category: 'gitops_rollout_authorized', level: 'info', phrase: 'rollout authorized' },
      rollout_paused: { category: 'gitops_rollout_paused', level: 'warning', phrase: 'rollout paused' },
      rollout_unpaused: { category: 'gitops_rollout_resumed', level: 'info', phrase: 'rollout resumed' },
      rollout_generation_superseded: { category: 'gitops_rollout_superseded', level: 'warning', phrase: 'rollout superseded' },
      rollback_in_progress: { category: 'gitops_rollback_started', level: 'warning', phrase: 'rollback started' },
      rollback_completed: { category: 'gitops_rollback_completed', level: 'info', phrase: 'rollback completed' },
      rollback_partial_failed: { category: 'gitops_rollback_partial_failed', level: 'error', phrase: 'rollback partially failed' },
      blueprint_state_review: { category: 'gitops_stateful_confirmation', level: 'warning', phrase: 'stateful deploy awaiting confirmation' },
    });
  });

  it('fails the v2 decoder closed on an unsupported version, bad JSON, or a missing field', () => {
    expect(decodeGitOpsEventPayload('{"version":3}', 3)).toEqual({
      ok: false,
      limitation: expect.stringContaining('version_unsupported'),
    });
    expect(decodeGitOpsEventPayload('not json', 2)).toEqual({
      ok: false,
      limitation: 'gitops_event_payload_unparseable',
    });
    expect(decodeGitOpsEventPayload(JSON.stringify({
      version: 2,
      applicationId: 'a',
      operationId: 'o',
      stage: 'rollout_paused',
      stackName: null,
      nodeId: null,
      actor: null,
      reason: null,
      at: 1,
    }), 2)).toEqual({ ok: false, limitation: 'gitops_event_payload_invalid' });
  });

  it('reads the reason a transition recorded, preferring the generic key', () => {
    expect(gitOpsNotificationReason({})).toBeNull();
    expect(gitOpsNotificationReason({ reason: 'fetch failed' })).toBe('fetch failed');
    expect(gitOpsNotificationReason({ pauseReason: 'window' })).toBe('window');
    expect(gitOpsNotificationReason({ reason: '', pauseReason: 'window' })).toBe('window');
    expect(gitOpsNotificationReason({ reason: 'first', pauseReason: 'second' })).toBe('first');
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

  it('keeps the snapshot keys to the bounded stage, outcome, and count', () => {
    const metrics = GitOpsMetricsService.getInstance();
    metrics.record('rollout_paused', 'committed');

    const [entry] = metrics.snapshot();
    expect(Object.keys(entry).sort()).toEqual(['count', 'outcome', 'stage']);
  });
});
