/**
 * SourceController: the background driver for unattended reconciliation.
 * GitOpsStore's due-queries and GitSourceService.reconcile() are mocked so
 * these tests exercise only the timer/coalescing behavior, not real fetch
 * or apply mechanics (already covered by git-source-service.test.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import { DatabaseService } from '../services/DatabaseService';
import { GitOpsStore } from '../services/gitops/store';
import { GitSourceService } from '../services/GitSourceService';
import { SourceController } from '../services/gitops/SourceController';
import type { GitOpsApplicationRow } from '../services/gitops/types';
import type { ReconcileResult } from '../services/gitops/outcomes';

const TICK_MS = 60_000;
const okResult: ReconcileResult = { outcome: 'no_source_change', reason: 'ok', nextAction: 'none' };

/**
 * The controller only drives non-manual sources through the unattended
 * cadence, so the rows these timer tests feed it are automatic; the manual
 * guard's own behavior is covered by source-controller-polling.test.ts.
 */
function autoFixture(id: string, stackName: string): GitOpsApplicationRow {
    return { ...directApplicationFixture(id, stackName), source_policy: 'automatic' };
}

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
        mockDue([autoFixture('app-poll', 'poll-web')]);
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
        const app = { ...autoFixture('app-retry', 'retry-web'), retry_at: Date.now() - 1_000 };
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
        const app = { ...autoFixture('app-both', 'both-web'), retry_at: Date.now() - 1_000 };
        mockDue([app], [app]);
        const reconcile = spyOnReconcile().mockResolvedValue(okResult);

        controller.start();
        await advanceOneTick();

        expect(reconcile).toHaveBeenCalledTimes(1);
    });

    it('does not re-evaluate an application still in flight from a previous tick', async () => {
        mockDue([autoFixture('app-slow', 'slow-web')]);
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
        mockDue([autoFixture('app-recovers', 'recovers-web')]);
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
        mockDue([autoFixture('app-rejects', 'rejects-web')]);
        const reconcile = spyOnReconcile().mockRejectedValue(new Error('boom'));

        controller.start();
        await advanceOneTick();
        await advanceOneTick();

        expect(reconcile).toHaveBeenCalledTimes(2);
    });

    it('does not evaluate anything after stop', async () => {
        mockDue([autoFixture('app-stopped', 'stopped-web')]);
        const reconcile = spyOnReconcile().mockResolvedValue(okResult);

        controller.start();
        controller.stop();
        await advanceOneTick();
        await advanceOneTick();

        expect(reconcile).not.toHaveBeenCalled();
    });

    it('does not double-arm when start() is called reentrantly from within an in-flight evaluation', async () => {
        mockDue([autoFixture('app-reentrant-start', 'reentrant-start-web')]);
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
        mockDue([autoFixture('app-double-start', 'double-start-web')]);
        const reconcile = spyOnReconcile().mockResolvedValue(okResult);

        controller.start();
        controller.start();
        await advanceOneTick();

        expect(reconcile).toHaveBeenCalledTimes(1);
    });

    describe('evaluateNow (resume re-evaluation)', () => {
        /** Insert a live automatic application row for a stack name. */
        function seedLive(stackName: string): GitOpsApplicationRow {
            const app = autoFixture(`app-${stackName}`, stackName);
            GitOpsStore.getInstance().insertApplication(app);
            return app;
        }

        it('fetches a live automatic source immediately, tagged with the resume trigger', async () => {
            seedLive('now-web');
            const reconcile = spyOnReconcile().mockResolvedValue(okResult);

            await controller.evaluateNow('now-web');

            expect(reconcile).toHaveBeenCalledTimes(1);
            expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
                intent: 'fetch',
                applicationId: 'app-now-web',
                stackName: 'now-web',
                trigger: 'resume',
            }));
            // No timer was running: nothing here waited for a tick.
            expect(vi.getTimerCount()).toBe(0);
        });

        it('skips a manual-policy source without reconciling it', async () => {
            const app: GitOpsApplicationRow = { ...autoFixture('app-now-manual', 'now-manual-web'), source_policy: 'manual' };
            GitOpsStore.getInstance().insertApplication(app);
            const reconcile = spyOnReconcile();

            await controller.evaluateNow('now-manual-web');

            expect(reconcile).not.toHaveBeenCalled();
        });

        it('skips a suspended source, so a resume race never wakes it early', async () => {
            const app = { ...autoFixture('app-now-susp', 'now-susp-web'), suspended_at: Date.now() };
            GitOpsStore.getInstance().insertApplication(app);
            const reconcile = spyOnReconcile();

            await controller.evaluateNow('now-susp-web');

            expect(reconcile).not.toHaveBeenCalled();
        });

        it('is a silent no-op for a stack with no live application', async () => {
            const reconcile = spyOnReconcile();

            await controller.evaluateNow('now-missing');

            expect(reconcile).not.toHaveBeenCalled();
        });

        it('parks a resume wake while a tick owns the application and runs it once when the tick settles', async () => {
            const app = seedLive('now-busy');
            // The scan's due list is mocked to the same row, so the tick's
            // evaluation and the resume path address one identical id.
            mockDue([app]);
            let settleFirstCall!: (result: ReconcileResult) => void;
            const firstCall = new Promise<ReconcileResult>((resolve) => { settleFirstCall = resolve; });
            const reconcile = spyOnReconcile().mockReturnValueOnce(firstCall).mockResolvedValue(okResult);

            controller.start();
            await advanceOneTick();
            expect(reconcile).toHaveBeenCalledTimes(1);

            // Two resumes arrive while the tick's evaluation is still
            // pending: neither starts work beside it, and together they
            // coalesce into the single wake they asked for.
            await controller.evaluateNow('now-busy');
            await controller.evaluateNow('now-busy');
            expect(reconcile).toHaveBeenCalledTimes(1);

            settleFirstCall(okResult);
            // Flush the tick's continuation chain (evaluate's post-reconcile
            // steps plus the scan's inFlight release, which drains the
            // parked wake into a fresh resume evaluation).
            await vi.advanceTimersByTimeAsync(0);

            // The wake was honored without any second manual call: the
            // park-then-drain is what the operator's resume bought. The
            // two parked resumes produced exactly one fresh evaluation,
            // tagged as a resume, and the drain's own release leaves no
            // further wake parked (a third call would have landed).
            expect(reconcile).toHaveBeenCalledTimes(2);
            expect(reconcile.mock.calls[1]![0]).toMatchObject({ trigger: 'resume' });
            // "At most one" pinned: the drain's settle releases the slot
            // with nothing left parked, so no third evaluation ever fires.
            await vi.advanceTimersByTimeAsync(0);
            expect(reconcile).toHaveBeenCalledTimes(2);
        });

        it('drops a parked wake whose source went stale, without evaluating it', async () => {
            const app = seedLive('now-stale');
            mockDue([app]);
            let settleFirstCall!: (result: ReconcileResult) => void;
            const firstCall = new Promise<ReconcileResult>((resolve) => { settleFirstCall = resolve; });
            const reconcile = spyOnReconcile().mockReturnValueOnce(firstCall).mockResolvedValue(okResult);

            controller.start();
            await advanceOneTick();
            expect(reconcile).toHaveBeenCalledTimes(1);

            await controller.evaluateNow('now-stale');
            expect(reconcile).toHaveBeenCalledTimes(1);
            // The drain re-reads eligibility, so the stale wake is dropped
            // exactly as a fresh call would drop it: no evaluation of a
            // suspended source.
            DatabaseService.getInstance().getDb()
                .prepare('UPDATE gitops_applications SET suspended_at = ? WHERE id = ?')
                .run(Date.now(), app.id);
            settleFirstCall(okResult);
            await vi.advanceTimersByTimeAsync(0);

            expect(reconcile).toHaveBeenCalledTimes(1);
        });

        it('drains the parked wake even when the owning evaluation crashes past the reconcile', async () => {
            const app = seedLive('now-owner-crash');
            mockDue([app]);
            let settleFirstCall!: (result: ReconcileResult) => void;
            const firstCall = new Promise<ReconcileResult>((resolve) => { settleFirstCall = resolve; });
            const reconcile = spyOnReconcile().mockReturnValueOnce(firstCall).mockResolvedValue(okResult);
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            // The crash lands in evaluate()'s post-reconcile tail (the row
            // re-read), not in reconcile itself: the owner's chain rejects,
            // the scan's load-bearing catch logs it, and the release's
            // finally must still drain the wake. The mock is once-only, so
            // the drained evaluation's own re-read falls through to the
            // real store.
            vi.spyOn(GitOpsStore.getInstance(), 'getApplication')
                .mockImplementationOnce(() => { throw new Error('simulated crash after reconcile'); });

            controller.start();
            await advanceOneTick();
            expect(reconcile).toHaveBeenCalledTimes(1);

            await controller.evaluateNow('now-owner-crash');
            settleFirstCall(okResult);
            await vi.advanceTimersByTimeAsync(0);

            expect(reconcile).toHaveBeenCalledTimes(2);
            expect(reconcile.mock.calls[1]![0]).toMatchObject({ trigger: 'resume' });
            const logged = errorSpy.mock.calls.map((args) => args.map(String).join('\n')).join('\n');
            expect(logged).toContain('evaluation crashed');
            errorSpy.mockRestore();
        });

        it('logs a parked-wake drain whose prologue throws instead of rejecting unhandled', async () => {
            const app = seedLive('now-drain-throws');
            mockDue([app]);
            let settleFirstCall!: (result: ReconcileResult) => void;
            const firstCall = new Promise<ReconcileResult>((resolve) => { settleFirstCall = resolve; });
            const reconcile = spyOnReconcile().mockReturnValueOnce(firstCall).mockResolvedValue(okResult);
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

            controller.start();
            await advanceOneTick();
            await controller.evaluateNow('now-drain-throws');
            expect(reconcile).toHaveBeenCalledTimes(1);

            // evaluateNow's eligibility read runs before its own catch, so
            // a store failure at that point rejects the call. The drain is
            // a detached fire-and-forget (nothing above it in the release
            // chain can catch), so it must carry its own guard: the
            // rejection becomes a logged line, never an unhandled rejection
            // (which would take the process down).
            vi.spyOn(GitOpsStore.getInstance(), 'getLiveDirectApplication')
                .mockImplementationOnce(() => { throw new Error('database is locked'); });
            settleFirstCall(okResult);
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(0);

            // No resume evaluation ran (the prologue died before it), but
            // the failure was logged rather than silently escaping.
            expect(reconcile).toHaveBeenCalledTimes(1);
            const logged = errorSpy.mock.calls.map((args) => args.map(String).join('\n')).join('\n');
            expect(logged).toContain('parked-wake drain could not start');
            errorSpy.mockRestore();
        });

        it('survives a reconcile rejection without throwing at the route', async () => {
            seedLive('now-throws');
            spyOnReconcile().mockRejectedValue(new Error('boom'));
            // evaluate() logs the reconcile failure itself and returns;
            // evaluateNow must not turn it into a rejection for the caller.
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            await expect(controller.evaluateNow('now-throws')).resolves.toBeUndefined();

            expect(errorSpy).toHaveBeenCalledTimes(1);
            errorSpy.mockRestore();
        });
    });
});
