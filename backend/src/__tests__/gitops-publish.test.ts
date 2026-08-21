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

  it('counts even when no sink is installed', async () => {
    events = [];
    setGitOpsEventSink(null);
    write('op-nosink', 'deploy_started');
    await settle();

    expect(events).toEqual([]);
    expect(GitOpsMetricsService.getInstance().snapshot()).toEqual([
      { stage: 'deploy_started', outcome: 'committed', count: 1 },
    ]);
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
