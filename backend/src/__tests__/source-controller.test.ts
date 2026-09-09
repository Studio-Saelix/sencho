/**
 * SourceController: the background driver for unattended reconciliation.
 * GitOpsStore's due-queries and GitSourceService.reconcile() are mocked so
 * these tests exercise only the timer/coalescing behavior, not real fetch
 * or apply mechanics (already covered by git-source-service.test.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import { GitOpsStore } from '../services/gitops/store';
import { GitSourceService } from '../services/GitSourceService';
import { SourceController } from '../services/gitops/SourceController';
import type { GitOpsApplicationRow } from '../services/gitops/types';
import type { ReconcileResult } from '../services/gitops/outcomes';

const TICK_MS = 60_000;
const okResult: ReconcileResult = { outcome: 'no_source_change', reason: 'ok', nextAction: 'none' };

let tmpDir: string;
let controller: SourceController;

/** Point both due-queries at fixed rows; the scan reads nothing else. */
function mockDue(duePoll: GitOpsApplicationRow[], dueRetry: GitOpsApplicationRow[] = []): void {
    vi.spyOn(GitOpsStore.getInstance(), 'listSourcesDueForPoll').mockReturnValue(duePoll);
    vi.spyOn(GitOpsStore.getInstance(), 'listApplicationsDueForRetry').mockReturnValue(dueRetry);
}

function spyOnReconcile() {
    return vi.spyOn(GitSourceService.getInstance(), 'reconcile');
}

/** Run the next scheduled tick and let the evaluations it fires settle. */
async function advanceOneTick(): Promise<void> {
    await vi.advanceTimersByTimeAsync(TICK_MS);
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    vi.useFakeTimers();
    SourceController.resetForTests();
    controller = SourceController.getInstance();
});

afterEach(() => {
    controller.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('SourceController', () => {
    it('evaluates a source whose poll interval is due', async () => {
        mockDue([directApplicationFixture('app-poll', 'poll-web')]);
        const reconcile = spyOnReconcile().mockResolvedValue(okResult);

        controller.start();
        await advanceOneTick();

        expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
            intent: 'fetch',
            applicationId: 'app-poll',
            stackName: 'poll-web',
            trigger: 'poll',
        }));
    });

    it('evaluates an application whose retry_at has arrived, tagged as a retry trigger', async () => {
        const app = { ...directApplicationFixture('app-retry', 'retry-web'), retry_at: Date.now() - 1_000 };
        mockDue([], [app]);
        const reconcile = spyOnReconcile().mockResolvedValue(okResult);

        controller.start();
        await advanceOneTick();

        expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
            applicationId: 'app-retry',
            trigger: 'retry',
        }));
    });

    it('evaluates an application due for both poll and retry exactly once', async () => {
        const app = { ...directApplicationFixture('app-both', 'both-web'), retry_at: Date.now() - 1_000 };
        mockDue([app], [app]);
        const reconcile = spyOnReconcile().mockResolvedValue(okResult);

        controller.start();
        await advanceOneTick();

        expect(reconcile).toHaveBeenCalledTimes(1);
    });

    it('does not re-evaluate an application still in flight from a previous tick', async () => {
        mockDue([directApplicationFixture('app-slow', 'slow-web')]);
        let settleFirstCall!: (result: ReconcileResult) => void;
        const firstCall = new Promise<ReconcileResult>((resolve) => { settleFirstCall = resolve; });
        const reconcile = spyOnReconcile().mockReturnValue(firstCall);

        controller.start();
        await advanceOneTick();
        expect(reconcile).toHaveBeenCalledTimes(1);

        // A second tick fires while the first evaluation is still pending.
        await advanceOneTick();
        expect(reconcile).toHaveBeenCalledTimes(1);

        settleFirstCall(okResult);
        await Promise.resolve();
        await Promise.resolve();

        // Now that the first evaluation has settled, a later tick may pick it up again.
        await advanceOneTick();
        expect(reconcile).toHaveBeenCalledTimes(2);
    });

    it('recovers on the next tick after a store query throws, rather than dying permanently', async () => {
        mockDue([directApplicationFixture('app-recovers', 'recovers-web')]);
        vi.spyOn(GitOpsStore.getInstance(), 'listSourcesDueForPoll').mockImplementationOnce(() => {
            throw new Error('database is locked');
        });
        const reconcile = spyOnReconcile().mockResolvedValue(okResult);
        vi.spyOn(console, 'error').mockImplementation(() => {});

        controller.start();
        await advanceOneTick();
        expect(reconcile).not.toHaveBeenCalled();

        await advanceOneTick();
        expect(reconcile).toHaveBeenCalledTimes(1);
    });

    it('releases the in-flight slot for an application whose reconcile rejects', async () => {
        mockDue([directApplicationFixture('app-rejects', 'rejects-web')]);
        const reconcile = spyOnReconcile().mockRejectedValue(new Error('boom'));

        controller.start();
        await advanceOneTick();
        await advanceOneTick();

        expect(reconcile).toHaveBeenCalledTimes(2);
    });

    it('does not evaluate anything after stop', async () => {
        mockDue([directApplicationFixture('app-stopped', 'stopped-web')]);
        const reconcile = spyOnReconcile().mockResolvedValue(okResult);

        controller.start();
        controller.stop();
        await advanceOneTick();
        await advanceOneTick();

        expect(reconcile).not.toHaveBeenCalled();
    });

    it('does not double-arm when start() is called reentrantly from within an in-flight evaluation', async () => {
        mockDue([directApplicationFixture('app-reentrant-start', 'reentrant-start-web')]);
        // tick() nulls `timer` before scanning, so a start() call landing
        // synchronously during that scan must not see a false "not running"
        // reading and arm a second timer.
        spyOnReconcile().mockImplementation(() => {
            controller.start();
            return Promise.resolve(okResult);
        });

        controller.start();
        await advanceOneTick();

        expect(vi.getTimerCount()).toBe(1);
    });

    it('logs rather than silently skipping an application with no stack_name', async () => {
        mockDue([{ ...directApplicationFixture('app-no-stack', 'no-stack-web'), stack_name: null }]);
        const reconcile = spyOnReconcile().mockResolvedValue(okResult);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        controller.start();
        await advanceOneTick();

        expect(reconcile).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('app-no-stack'));
    });

    it('restartPolling never leaves two timers running', () => {
        controller.start();
        controller.restartPolling();
        controller.restartPolling();

        expect(vi.getTimerCount()).toBe(1);
    });

    it('start is a no-op when already running', async () => {
        mockDue([directApplicationFixture('app-double-start', 'double-start-web')]);
        const reconcile = spyOnReconcile().mockResolvedValue(okResult);

        controller.start();
        controller.start();
        await advanceOneTick();

        expect(reconcile).toHaveBeenCalledTimes(1);
    });
});
