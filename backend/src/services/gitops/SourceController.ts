import { GitOpsStore } from './store';
import { GitSourceService } from '../GitSourceService';
import type { GitOpsApplicationRow } from './types';
import { sanitizeForLog } from '../../utils/safeLog';

/**
 * Background driver for unattended GitOps reconciliation: polls sources on
 * their configured interval and re-evaluates applications whose retry_at
 * has arrived, driving each through GitSourceService.reconcile().
 *
 * Scope for this delivery: a tick only issues a fetch-intent reconcile, the
 * same "detect and stage a candidate" step a manual pull performs. It does
 * not evaluate source policy or drive automatic acceptance/dispatch for a
 * newly staged candidate, and it does not yet resume a failure at the
 * specific stage it failed at (fetch vs. dispatch); every retry re-issues
 * a fetch. Both are real gaps against the source policy design, not silent
 * omissions: automatic-policy acceptance and stage-aware retry are follow-on
 * work once dispatchAcceptedGeneration() has a caller that decides when a
 * staged candidate should be accepted.
 *
 * One self-rescheduling timer drives the scan, matching ImageUpdateService.
 * The re-arm always runs, even when a scan throws, so one bad tick (a
 * locked database, a transient store error) never permanently stops the
 * driver. The per-application in-flight set, not the timer, is what keeps
 * one busy application from blocking another: the tick never awaits any
 * evaluation before rescheduling, so a slow application only pauses itself.
 */
export class SourceController {
    private static instance: SourceController;

    private static readonly TICK_INTERVAL_MS = 60_000;

    private timer: NodeJS.Timeout | null = null;
    private polling = false;
    // Bumped by cancelPending(), so by stop() and restartPolling(). tick() has
    // no internal await point today, so nothing can currently call either one
    // mid-tick; this is a second, currently-redundant line of defense against a
    // stale timer firing, kept cheap on purpose for when stage-aware retry (see
    // above) gives evaluate() a real yield point.
    private scheduleGeneration = 0;
    private readonly inFlight = new Set<string>();

    private constructor() { }

    static getInstance(): SourceController {
        if (!SourceController.instance) {
            SourceController.instance = new SourceController();
        }
        return SourceController.instance;
    }

    /** Test-only: replace the singleton so timer/in-flight state never leaks between tests. */
    static resetForTests(): void {
        SourceController.instance = new SourceController();
    }

    start(): void {
        // Guards on `polling`, not `timer`: tick() nulls `timer` before it
        // scans (so a stale timer reference can never block a restart), which
        // would otherwise let a start() call landing during that scan see a
        // false "not running" reading and arm a second timer.
        if (this.polling) return;
        this.polling = true;
        this.armNext();
    }

    stop(): void {
        this.cancelPending();
        this.polling = false;
    }

    /**
     * Reschedule the next tick without restarting: always clears any pending
     * timer first, so calling this any number of times in a row never leaves
     * more than one timer armed.
     */
    restartPolling(): void {
        this.cancelPending();
        if (this.polling) {
            this.armNext();
        }
    }

    isPolling(): boolean {
        return this.polling;
    }

    /** Clear any armed timer and invalidate the tick it would have run. */
    private cancelPending(): void {
        this.scheduleGeneration++;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private armNext(): void {
        const gen = this.scheduleGeneration;
        this.timer = setTimeout(() => { void this.tick(gen); }, SourceController.TICK_INTERVAL_MS);
        this.timer.unref();
    }

    private async tick(gen: number): Promise<void> {
        if (!this.polling || gen !== this.scheduleGeneration) return;
        this.timer = null;
        try {
            this.scan();
        } catch (e) {
            console.error('[SourceController] scan failed:', e instanceof Error ? e.message : String(e));
        } finally {
            if (this.polling && gen === this.scheduleGeneration) {
                this.armNext();
            }
        }
    }

    /**
     * Fire an evaluation for every due application without waiting for any
     * of them. An application already in the in-flight set is left for a
     * later tick instead of being queued behind its own still-running
     * evaluation. A row due for both poll and retry is evaluated once.
     */
    private scan(): void {
        const now = Date.now();
        const store = GitOpsStore.getInstance();
        const due = new Map<string, GitOpsApplicationRow>();
        for (const app of store.listSourcesDueForPoll(now)) due.set(app.id, app);
        for (const app of store.listApplicationsDueForRetry(now)) due.set(app.id, app);

        for (const app of due.values()) {
            if (this.inFlight.has(app.id)) continue;
            this.inFlight.add(app.id);
            this.evaluate(app).finally(() => this.inFlight.delete(app.id));
        }
    }

    private async evaluate(app: GitOpsApplicationRow): Promise<void> {
        if (!app.stack_name) {
            console.warn(`[SourceController] Skipping ${sanitizeForLog(app.id)}: direct-mode application has no stack_name.`);
            return;
        }
        const isRetry = app.retry_at !== null && app.retry_at <= Date.now();
        try {
            await GitSourceService.getInstance().reconcile({
                intent: 'fetch',
                applicationId: app.id,
                stackName: app.stack_name,
                trigger: isRetry ? 'retry' : 'poll',
                actor: 'system:source-controller',
            });
        } catch (e) {
            console.error(
                `[SourceController] evaluation failed for ${sanitizeForLog(app.id)}:`,
                e instanceof Error ? e.message : String(e),
            );
        }
    }
}
