/**
 * SourceController poll/retry scheduling: what happens to the poll cursor and
 * the retry cursor after an evaluation settles.
 *
 * The due-queries and reconcile() are mocked (see source-controller.test.ts
 * for the harness rationale), but rows are seeded and cursor transitions run
 * for real against the GitOps schema: the tests primarily assert on the row
 * state the controller leaves behind (the manual-source test asserts the
 * absence of a reconcile call). One exception: the backoff-deferral test,
 * where eligibility itself is the behavior under test, drives the real due
 * queries instead of mockDue.
 *
 * Seeding rule learned the hard way: the controller re-reads the durable row
 * after reconcile, so a hand-edited copy passed to mockDue only decides what
 * the scan triggers; every policy and cursor decision reads the store. Rows
 * are therefore seeded with their intended policy via activateDirect, and
 * cursors are armed through the real sourcePollScheduled/sourceRetryScheduled
 * transitions, with mockDue returning the store's own rows.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import { GitSourceService } from '../services/GitSourceService';
import { SourceController } from '../services/gitops/SourceController';
import { DatabaseService } from '../services/DatabaseService';
import type { GitOpsApplicationRow } from '../services/gitops/types';
import type { ReconcileResult } from '../services/gitops/outcomes';

const TICK_MS = 60_000;
const okResult: ReconcileResult = { outcome: 'no_source_change', reason: 'ok', nextAction: 'none' };
const failedResult: ReconcileResult = { outcome: 'failed_previous_intact', reason: 'previous fetch failed', nextAction: 'retry' };

let tmpDir: string;
let controller: SourceController;

function mockDue(duePoll: GitOpsApplicationRow[], dueRetry: GitOpsApplicationRow[] = []): void {
    vi.spyOn(GitOpsStore.getInstance(), 'listSourcesDueForPoll').mockReturnValue(duePoll);
    vi.spyOn(GitOpsStore.getInstance(), 'listApplicationsDueForRetry').mockReturnValue(dueRetry);
}

function spyOnReconcile() {
    return vi.spyOn(GitSourceService.getInstance(), 'reconcile');
}

async function advanceOneTick(): Promise<void> {
    await vi.advanceTimersByTimeAsync(TICK_MS);
}

function getApp(id: string): GitOpsApplicationRow {
    const app = GitOpsStore.getInstance().getApplication(id);
    if (!app) throw new Error(`application ${id} not found`);
    return app;
}

/** Seed a real application row via the real transition, with the requested policy. */
function seedApplication(
    id: string,
    stackName: string,
    policy: 'manual' | 'review' | 'automatic' = 'manual',
    pollIntervalSecs: number | null = null,
): void {
    GitOpsTransitions.getInstance().activateDirect({
        application: { ...directApplicationFixture(id, stackName), source_policy: policy, poll_interval_secs: pollIntervalSecs },
        nodeId: 1,
        envelope: { operationId: `seed-${id}`, actor: 'test', trigger: 'config_change', at: Date.now() },
    });
}

/** Arm the poll cursor in the past through the real transition, making the row poll-due. */
function armPastPoll(id: string, opId: string): void {
    GitOpsTransitions.getInstance().sourcePollScheduled(
        id,
        Date.now() - 1_000,
        { operationId: opId, actor: 'test', trigger: 'poll', at: Date.now() },
    );
}

/**
 * Record a transient fetch failure through the real transition path, exactly
 * as GitSourceService does when a pull fails: fetch opens (clearing any retry
 * schedule), then fails with the classified code. Leaves retry_count untouched
 * and failure_class at the code's canonical value, which is what the
 * controller's retry scheduling reads.
 */
function recordFetchFailure(id: string, code: 'NETWORK_TIMEOUT' | 'GIT_ERROR' | 'AUTH_FAILED', opId: string): void {
    GitOpsTransitions.getInstance().fetchStarted(
        id,
        { operationId: opId, actor: 'test', trigger: 'poll', at: Date.now() },
    );
    GitOpsTransitions.getInstance().fetchFailed(
        id,
        { operationId: opId, actor: 'test', trigger: 'poll', at: Date.now() },
        code,
    );
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    vi.useFakeTimers();
    SourceController.resetForTests();
    controller = SourceController.getInstance();
    DatabaseService.getInstance().updateGlobalSetting('gitops_poll_interval_mins', '5');
});

afterEach(() => {
    controller.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('SourceController poll scheduling', () => {
    it('schedules the next poll after a successful poll on an automatic source', async () => {
        seedApplication('app-auto', 'auto-web', 'automatic');
        armPastPoll('app-auto', 'arm-auto');
        mockDue([getApp('app-auto')]);
        const reconcile = spyOnReconcile().mockResolvedValue(okResult);

        controller.start();
        await advanceOneTick();

        expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ intent: 'fetch', trigger: 'poll' }));
        // No jitter on the poll cursor: exact arithmetic. The tick consumes
        // 60s before the cursor is armed, so capture time after it runs.
        expect(getApp('app-auto').next_poll_at).toBe(Date.now() + 5 * 60 * 1_000);
    });

    it('never schedules a manual source', async () => {
        seedApplication('app-manual', 'manual-web', 'manual');
        armPastPoll('app-manual', 'arm-manual');
        const armedAt = getApp('app-manual').next_poll_at;
        mockDue([getApp('app-manual')]);
        const reconcile = spyOnReconcile().mockResolvedValue(okResult);

        controller.start();
        await advanceOneTick();

        // The manual guard skips the row before reconcile, so the source is
        // never fetched unattended, and the stale cursor from before the
        // policy flip is left alone rather than re-armed.
        expect(reconcile).not.toHaveBeenCalled();
        expect(getApp('app-manual').next_poll_at).toBe(armedAt);
    });

    it('interval 0 disables scheduling', async () => {
        seedApplication('app-off', 'off-web', 'automatic');
        DatabaseService.getInstance().updateGlobalSetting('gitops_poll_interval_mins', '0');
        armPastPoll('app-off', 'arm-off');
        mockDue([getApp('app-off')]);
        const reconcile = spyOnReconcile().mockImplementation(async () => {
            // The fetch runs (the source was due), and fetchStarted consumes
            // the cursor; polling is off, so nothing re-arms it.
            GitOpsTransitions.getInstance().fetchStarted('app-off', { operationId: 'fetch-off-op', actor: 'system:source-controller', trigger: 'poll', at: Date.now() });
            GitOpsTransitions.getInstance().fetched('app-off', 'd'.repeat(40), { operationId: 'fetch-off-op', actor: 'system:source-controller', trigger: 'poll', at: Date.now() });
            return okResult;
        });

        controller.start();
        await advanceOneTick();

        // The fetch ran, the cursor was consumed, and polling-off means the
        // row drops out of the due set instead of re-firing every tick.
        expect(reconcile).toHaveBeenCalled();
        expect(getApp('app-off').next_poll_at).toBeNull();
    });

    it('per-source poll_interval_secs overrides the global setting', async () => {
        seedApplication('app-per-source', 'per-source-web', 'automatic', 120);
        armPastPoll('app-per-source', 'arm-per-source');
        mockDue([getApp('app-per-source')]);
        spyOnReconcile().mockResolvedValue(okResult);

        controller.start();
        await advanceOneTick();

        expect(getApp('app-per-source').next_poll_at).toBe(Date.now() + 120 * 1_000);
    });

    it('reschedules after a superseded outcome, another success shape', async () => {
        seedApplication('app-superseded', 'superseded-web', 'automatic');
        armPastPoll('app-superseded', 'arm-superseded');
        mockDue([getApp('app-superseded')]);
        spyOnReconcile().mockResolvedValue({ ...okResult, outcome: 'superseded' });

        controller.start();
        await advanceOneTick();

        expect(getApp('app-superseded').next_poll_at).toBe(Date.now() + 5 * 60 * 1_000);
    });

    it('does not schedule after a failure-shaped outcome', async () => {
        seedApplication('app-failed', 'failed-web', 'automatic');
        armPastPoll('app-failed', 'arm-failed');
        mockDue([getApp('app-failed')]);
        spyOnReconcile().mockImplementation(async () => {
            // Drive the failure through the real transitions, exactly as
            // GitSourceService does when a pull fails: fetchStarted consumes
            // both cursors, fetchFailed records the classified evidence.
            GitOpsTransitions.getInstance().fetchStarted('app-failed', { operationId: 'fetch-failed-op', actor: 'system:source-controller', trigger: 'poll', at: Date.now() });
            GitOpsTransitions.getInstance().fetchFailed('app-failed', { operationId: 'fetch-failed-op', actor: 'system:source-controller', trigger: 'poll', at: Date.now() }, 'AUTH_FAILED');
            return failedResult;
        });

        controller.start();
        await advanceOneTick();

        // A permanent failure leaves no cursor at all: the fetch consumed
        // the poll cursor, no retry cursor is armed, and the row drops out
        // of both due queries instead of re-firing every tick. AUTH_FAILED
        // needs an operator to fix the credentials.
        const row = getApp('app-failed');
        expect(row.next_poll_at).toBeNull();
        expect(row.retry_at).toBeNull();
        expect(row.failure_class).toBe('AUTH_FAILED');
    });

    it('never schedules a retry for a permanent failure class', async () => {
        seedApplication('app-permanent', 'permanent-web', 'automatic');
        recordFetchFailure('app-permanent', 'AUTH_FAILED', 'fetch-app-permanent');
        mockDue([], [getApp('app-permanent')]);
        spyOnReconcile().mockResolvedValue(failedResult);

        controller.start();
        await advanceOneTick();

        // AUTH_FAILED cannot succeed by retrying: no cursor is armed, and
        // the failure stays visible for the operator to fix.
        const row = getApp('app-permanent');
        expect(row.retry_at).toBeNull();
        expect(row.retry_count).toBe(0);
        expect(row.failure_class).toBe('AUTH_FAILED');
    });

    it('never schedules a retry for an unclassifiable legacy failure class', async () => {
        seedApplication('app-legacy', 'legacy-web', 'automatic');
        const app = getApp('app-legacy');
        // Write the legacy unclassified fallback directly: fetchFailed only
        // produces it for a non-GitSourceError, which the mocked reconcile
        // cannot surface. The UPDATE itself leaves no cursor to consume.
        const { DatabaseService } = await import('../services/DatabaseService');
        DatabaseService.getInstance().getDb().prepare(
            "UPDATE gitops_applications SET failure_stage = 'fetch', failure_class = 'fetch' WHERE id = ?",
        ).run(app.id);
        mockDue([], [getApp('app-legacy')]);
        spyOnReconcile().mockResolvedValue(failedResult);

        controller.start();
        await advanceOneTick();

        // 'fetch' is not a GitSourceErrorCode; classifying it would crash,
        // so the controller must decline without arming anything.
        const row = getApp('app-legacy');
        expect(row.retry_at).toBeNull();
        expect(row.retry_count).toBe(0);
    });

    it('re-arms the poll cursor for a review-policy source after a successful poll', async () => {
        seedApplication('app-review-poll', 'review-poll-web', 'review');
        armPastPoll('app-review-poll', 'arm-review-poll');
        mockDue([getApp('app-review-poll')]);
        spyOnReconcile().mockResolvedValue({ ...okResult, outcome: 'pending_review' });

        controller.start();
        await advanceOneTick();

        // Review sources fetch unattended (a human only approves the
        // candidate), so they ride the same cadence as automatic sources.
        expect(getApp('app-review-poll').next_poll_at).toBe(Date.now() + 5 * 60 * 1_000);
    });

    it('does not fetch a source whose retry cursor is still in the future even though its poll cursor is due', async () => {
        seedApplication('app-backoff', 'backoff-web', 'automatic', 60);
        // The row is poll-due (next_poll_at armed in the past) but is also
        // inside a network backoff window that has not fired yet.
        recordFetchFailure('app-backoff', 'NETWORK_TIMEOUT', 'fetch-app-backoff');
        GitOpsTransitions.getInstance().sourcePollScheduled(
            'app-backoff',
            Date.now() - 1_000,
            { operationId: 'arm-backoff-poll', actor: 'test', trigger: 'poll', at: Date.now() },
        );
        GitOpsTransitions.getInstance().sourceRetryScheduled(
            'app-backoff',
            Date.now() + 10 * 60_000,
            1,
            { operationId: 'arm-backoff-retry', actor: 'test', trigger: 'retry', at: Date.now() },
        );
        const pollCursorAt = getApp('app-backoff').next_poll_at;
        const retryCursorAt = getApp('app-backoff').retry_at;
        // Eligibility is the behavior under test here, so the real due
        // queries run against the seeded row (every other test in this file
        // mocks them; see the header). The store SQL must be the thing that
        // defers to the retry cursor; a JS reimplementation of the predicate
        // would pass even if the SQL regressed.
        const reconcile = spyOnReconcile().mockResolvedValue(okResult);

        controller.start();
        await advanceOneTick();

        // The retry cursor is the next wake: no fetch, no poll re-arm, no
        // backoff overwrite while the window lasts.
        expect(reconcile).not.toHaveBeenCalled();
        expect(getApp('app-backoff').next_poll_at).toBe(pollCursorAt);
        expect(getApp('app-backoff').retry_at).toBe(retryCursorAt);
    });

    it('rescheduling after a config change does not arm a poll cursor over a future retry cursor', async () => {
        seedApplication('app-resched', 'resched-web', 'automatic');
        recordFetchFailure('app-resched', 'NETWORK_TIMEOUT', 'fetch-app-resched');
        GitOpsTransitions.getInstance().sourceRetryScheduled(
            'app-resched',
            Date.now() + 5 * 60_000,
            1,
            { operationId: 'arm-resched-retry', actor: 'test', trigger: 'retry', at: Date.now() },
        );

        controller.rescheduleAll('test');

        // The backoff window stays the next wake; rescheduleAll only manages
        // sources that are not already waiting on a retry.
        expect(getApp('app-resched').next_poll_at).toBeNull();
        expect(getApp('app-resched').retry_at).toBe(Date.now() + 5 * 60_000);
    });

    it('floors a per-source interval below 60s at 60s', async () => {
        seedApplication('app-floor', 'floor-web', 'automatic', 5);
        armPastPoll('app-floor', 'arm-floor');
        mockDue([getApp('app-floor')]);
        spyOnReconcile().mockResolvedValue(okResult);

        controller.start();
        await advanceOneTick();

        // A mistyped 5-second interval must not become a tight loop against
        // the remote; the floor applies before the cursor is armed.
        expect(getApp('app-floor').next_poll_at).toBe(Date.now() + 60 * 1_000);
    });
});

describe('SourceController retry scheduling', () => {
    it('schedules a retry after a transient fetch failure within the ceiling', async () => {
        seedApplication('app-retry', 'retry-web', 'automatic');
        recordFetchFailure('app-retry', 'NETWORK_TIMEOUT', 'fetch-app-retry');
        GitOpsTransitions.getInstance().sourceRetryScheduled(
            'app-retry',
            Date.now() - 1_000,
            0,
            { operationId: 'arm-retry', actor: 'test', trigger: 'retry', at: Date.now() },
        );
        mockDue([], [getApp('app-retry')]);
        spyOnReconcile().mockResolvedValue(failedResult);

        controller.start();
        await advanceOneTick();

        const row = getApp('app-retry');
        // Retry backoff is jittered (+/-10% of 60s), and the tick consumed
        // 60s before the cursor was armed: assert a window from post-tick now.
        expect(row.retry_at).not.toBeNull();
        expect(row.retry_at!).toBeGreaterThanOrEqual(Date.now() + 54_000);
        expect(row.retry_at!).toBeLessThanOrEqual(Date.now() + 66_000);
        expect(row.retry_count).toBe(1);
    });

    it('stops scheduling retries past the transient ceiling', async () => {
        seedApplication('app-ceiling', 'ceiling-web', 'automatic');
        recordFetchFailure('app-ceiling', 'GIT_ERROR', 'fetch-app-ceiling');
        GitOpsTransitions.getInstance().sourceRetryScheduled(
            'app-ceiling',
            Date.now() - 1_000,
            3,
            { operationId: 'arm-ceiling', actor: 'test', trigger: 'retry', at: Date.now() },
        );
        mockDue([], [getApp('app-ceiling')]);
        spyOnReconcile().mockImplementation(async () => {
            // The retry runs and fails again; fetchStarted consumes the
            // stale retry cursor, and fetchFailed records the evidence the
            // ceiling check reads.
            GitOpsTransitions.getInstance().fetchStarted('app-ceiling', { operationId: 'fetch-ceiling-op', actor: 'system:source-controller', trigger: 'retry', at: Date.now() });
            GitOpsTransitions.getInstance().fetchFailed('app-ceiling', { operationId: 'fetch-ceiling-op', actor: 'system:source-controller', trigger: 'retry', at: Date.now() }, 'GIT_ERROR');
            return failedResult;
        });

        controller.start();
        await advanceOneTick();

        const row = getApp('app-ceiling');
        // GIT_ERROR's ceiling is 3; a 4th attempt would exceed it, so the
        // failure stays visible with no cursor in either direction: the row
        // is out of the due set until an operator intervenes.
        expect(row.retry_count).toBe(3);
        expect(row.retry_at).toBeNull();
        expect(row.next_poll_at).toBeNull();
        expect(row.failure_class).toBe('GIT_ERROR');
    });

    it('a successful fetch clears the retry cursor', async () => {
        seedApplication('app-recovers', 'recovers-web', 'automatic');
        recordFetchFailure('app-recovers', 'NETWORK_TIMEOUT', 'fetch-app-recovers');
        GitOpsTransitions.getInstance().sourceRetryScheduled(
            'app-recovers',
            Date.now() - 1_000,
            1,
            { operationId: 'arm-recovers', actor: 'test', trigger: 'retry', at: Date.now() },
        );
        mockDue([], [getApp('app-recovers')]);
        // Drive the success through the real transitions a settled fetch
        // performs: fetch_started clears the retry cursor, fetched resets the
        // count and clears the failure evidence. Mocking only the result
        // would leave the row still saying "failed", which is not recovery.
        spyOnReconcile().mockImplementation(async () => {
            const env = { operationId: 'fetch-recovery', actor: 'system:source-controller', trigger: 'retry', at: Date.now() };
            GitOpsTransitions.getInstance().fetchStarted('app-recovers', env);
            GitOpsTransitions.getInstance().fetched('app-recovers', 'c'.repeat(40), env);
            return okResult;
        });

        controller.start();
        await advanceOneTick();

        const row = getApp('app-recovers');
        expect(row.retry_at).toBeNull();
        expect(row.retry_count).toBe(0);
        expect(row.failure_class).toBeNull();
        // And the poll cadence resumes.
        expect(row.next_poll_at).not.toBeNull();
    });
});
