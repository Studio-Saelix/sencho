import { randomUUID } from 'crypto';
import { GitOpsStore } from './store';
import { GitOpsTransitions } from './transitions';
import { GitSourceService } from '../GitSourceService';
import { buildAcceptedGeneration } from './handoff';
import { checkStatefulWithdrawal, holdForStatefulReview, readStagedGeneration } from './statefulGuard';
import { DatabaseService } from '../DatabaseService';
import type { GitOpsApplicationRow, GitOpsGenerationRow } from './types';
import { classifyFailure, nextRetryAt, isGitSourceErrorCode, effectivePollIntervalSecs } from './backoff';
import { evaluateCandidatePolicy } from '../PolicyEnforcement';
import { buildSystemPolicyGateOptions } from '../../helpers/policyGate';
import { newGitOpsId } from './directApplication';
import { NodeRegistry } from '../NodeRegistry';
import { extractImagesFromCompose } from '../ImageUpdateService';
import type { ReconcileOutcome } from './outcomes';
import type { ReconcileTrigger } from './triggers';
import { redactSensitiveText, sanitizeForLog } from '../../utils/safeLog';

/** Outcomes that mean the tick accomplished its work and the source may sleep again. */
const SUCCESS_SHAPED_OUTCOMES: ReadonlySet<ReconcileOutcome> = new Set<ReconcileOutcome>([
    'no_source_change',
    'candidate_already_fetched',
    'pending_review',
    'superseded',
]);

/**
 * Background driver for unattended GitOps reconciliation: polls sources on
 * their configured interval and re-evaluates applications whose retry_at
 * has arrived, driving each through GitSourceService.reconcile().
 *
 * A tick issues a fetch-intent reconcile (the same "detect and stage a
 * candidate" step a manual pull performs), re-arms the poll cursor on a
 * success-shaped outcome, and schedules transient fetch failures for retry
 * with backoff (see backoff.ts). For an automatic-policy source holding a
 * validated candidate, the tick also evaluates the candidate against the
 * security policy and, when it is allowed, accepts it on the policy's behalf
 * (authority 'configured_policy') and hands the accepted generation to the
 * shared dispatch boundary (GitSourceService.dispatchAcceptedGeneration),
 * which revalidates the live target under the stack lock before promoting.
 * Review-policy sources stage candidates for a human; manual
 * sources never join the unattended cadence.
 *
 * Stage-aware retry lives in GitSourceService.retry(): an operator retry
 * at a source-stage failure re-issues a fetch, an accepted generation
 * still awaiting its promotion is retried against the shared dispatch
 * boundary, and a generation already applied whose deploy failed (or
 * whose stack health gate last recorded a failed verdict for it) resumes
 * at the deploy alone; a source-stage failure outranks dispatch evidence,
 * and a suspended, in-flight, or under-recovery source defers before any
 * arm runs. Neither retry arm ever refetches or re-accepts.
 * This controller's own automated retry scheduling stays at the fetch
 * stage, where every transient failure it classifies can occur.
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
    // no internal await point, so nothing can currently call either one
    // mid-tick; this is a second, currently-redundant line of defense against a
    // stale timer firing, kept cheap on purpose (an integer compare checked at
    // tick entry and before re-arming). Stage-aware retry landed in
    // GitSourceService.retry() instead of evaluate(), so no yield point was
    // introduced here after all.
    private scheduleGeneration = 0;
    private readonly inFlight = new Set<string>();
    /**
     * Resume wakes that arrived while their application was already being
     * evaluated. Keyed by application id (so repeated wakes coalesce into
     * the one evaluation they asked for) holding the stack name the drain
     * re-reads eligibility from. Lives only until the in-flight owner
     * releases the slot: a marker exists only while some evaluation owns
     * the slot, and that owner's release consumes it.
     */
    private readonly pendingWakes = new Map<string, string>();

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

    /**
     * Recompute the poll cursor for every live Direct or converted Blueprint
     * source after a configuration change (the global interval was edited).
     * Automatic and review sources get a fresh cursor; manual sources never
     * join the unattended schedule, a source with an unconsumed retry cursor
     * (inside its backoff window or already past due) keeps that cursor as
     * the next wake, and turning polling off leaves existing cursors alone:
     * they fire, the fetch consumes them, and the controller declines to
     * re-arm, so the source drops out of the due set.
     */
    rescheduleAll(actor: string): void {
        const now = Date.now();
        const store = GitOpsStore.getInstance();
        for (const app of store.listActiveSourceApplications()) {
            if (app.source_policy === 'manual') continue;
            // A source with an unconsumed retry cursor keeps that cursor as
            // its next wake: the poll scan defers to any retry cursor, so a
            // poll cursor armed here would sit inert until the retry's fetch
            // discards it, while misreporting the next wake in the polling
            // projection and minting a spurious poll-scheduled audit line.
            if (app.retry_at !== null) continue;
            const secs = this.effectiveIntervalSecs(app);
            if (secs <= 0) continue;
            const envelope = { operationId: randomUUID(), actor, trigger: 'config_change', at: now };
            try {
                GitOpsTransitions.getInstance().sourcePollScheduled(app.id, now + secs * 1000, envelope);
            } catch (e) {
                // One application that cannot be rescheduled (suspended since
                // the read, an operation that just started) must not stop the
                // rest of the fleet from picking up the new interval.
                this.warnSkipped(app.id, 'reschedule skipped', e);
            }
        }
    }

    /**
     * The poll cadence this application runs on, in seconds: the per-source
     * override when set, else the global minutes. 0 means off; positive
     * values are floored at 60 so a mistyped 5-second interval cannot turn
     * into a tight loop against the remote. The rule lives in backoff.ts so
     * the Git source upsert path reads it identically when arming an initial
     * cursor.
     */
    private effectiveIntervalSecs(app: GitOpsApplicationRow): number {
        return effectivePollIntervalSecs(app.poll_interval_secs, DatabaseService.getInstance().getGitOpsPollIntervalMins());
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
            // The catch is load-bearing, not defensive: evaluate() only
            // covers the reconcile call itself, and everything after it
            // (the row re-read, scheduling, automatic acceptance) runs on
            // the promise chain. An unhandled rejection here would take
            // the whole process down.
            this.evaluate(app)
                .catch((e) => console.error(
                    `[SourceController] evaluation crashed for ${sanitizeForLog(app.id)}:`,
                    e instanceof Error ? e.message : String(e),
                ))
                .finally(() => this.releaseAndDrainWake(app.id));
        }
    }

    /**
     * Release an application's evaluation slot and honor any resume wake
     * parked against it. The wake's evaluateNow runs synchronously before
     * this returns, so no timer tick can claim the freed slot in between:
     * a parked operator resume wins the slot against the cadence, which
     * is the point of a wake. evaluateNow re-reads the row and re-decides
     * eligibility, so a wake that went stale while parked (re-suspended,
     * switched to manual, deleted) is dropped exactly as a fresh call
     * would drop it. evaluateNow's own catch only covers its evaluation
     * arm: its synchronous prologue (the row read and eligibility guard)
     * can reject before that catch exists, and this drain runs inside a
     * release finally with nothing above it to catch, so the detached
     * wake carries the same defensive log the resume route applies to its
     * fire-and-forget wake.
     */
    private releaseAndDrainWake(applicationId: string): void {
        this.inFlight.delete(applicationId);
        const wakeStackName = this.pendingWakes.get(applicationId);
        if (wakeStackName !== undefined) {
            this.pendingWakes.delete(applicationId);
            this.evaluateNow(wakeStackName).catch((e) => console.error(
                `[SourceController] parked-wake drain could not start for ${sanitizeForLog(applicationId)}:`,
                e instanceof Error ? e.message : String(e),
            ));
        }
    }

    /**
     * Run one unattended evaluation for a stack right now, without waiting
     * for the timer. The resume route calls this after clearing
     * suspension so the woken source is re-evaluated immediately (source
     * state and, through the automatic arm, target binding and dispatch)
     * instead of idling until the next poll or retry cursor lands.
     * Eligibility is re-decided here rather than inherited from the
     * due-scan, because this path bypasses the scan: only a live (active or
     * creating), unsuspended, non-manual source with a Direct stack name or
     * a converted Blueprint source identity is evaluated. A row that is due
     * for neither poll nor retry is still evaluated: the operator's resume
     * is the wake. Nothing is thrown at the caller when the row simply is
     * not eligible; whether the source runs on a cursor or on demand is the
     * scheduling code's business, and an ineligible row is not an error.
     *
     * An application already being evaluated is never queued behind itself:
     * the wake is parked instead of discarded, and the in-flight owner's
     * release runs at most one fresh resume evaluation for it (see
     * releaseAndDrainWake). Repeated wakes coalesce into the one evaluation
     * they asked for; eligibility is re-read at drain time, so a wake that
     * went stale while parked is dropped exactly as a fresh call would drop
     * it.
     *
     * Fetches fired here coalesce with any concurrent tick through the
     * reconcile submission's per-application joining, so an immediate
     * evaluation landing seconds before a timer tick cannot double-fetch.
     */
    public async evaluateNow(stackName: string): Promise<void> {
        const app = GitOpsStore.getInstance().getLiveSourceApplication(stackName);
        if (!app) return;
        if (app.source_policy === 'manual' || app.suspended_at) return;
        if (this.inFlight.has(app.id)) {
            // Park rather than discard: the resume is a request to
            // re-evaluate after whatever is running now settles, and an
            // evaluation about to finish would otherwise silently swallow
            // the operator's wake (the next timer tick can be a full poll
            // interval away).
            this.pendingWakes.set(app.id, stackName);
            return;
        }
        this.inFlight.add(app.id);
        try {
            await this.evaluate(app, 'resume');
        } catch (e) {
            // Same load-bearing catch the tick path wraps evaluations in:
            // everything past the reconcile call (the row re-read,
            // scheduling, automatic acceptance) runs on this promise chain,
            // and a rejection escaping here would be an unhandled one for
            // the route that fired it. The durable row is authoritative;
            // the next tick remains the safety net.
            console.error(
                `[SourceController] immediate evaluation crashed for ${sanitizeForLog(app.id)}:`,
                e instanceof Error ? e.message : String(e),
            );
        } finally {
            this.releaseAndDrainWake(app.id);
        }
    }

    private async evaluate(app: GitOpsApplicationRow, triggerOverride?: ReconcileTrigger): Promise<void> {
        const stackName = app.stack_name ?? app.configured_source_stack_name;
        if (!stackName) {
            console.warn(`[SourceController] Skipping ${sanitizeForLog(app.id)}: source application has no stack identity.`);
            return;
        }
        if (app.source_policy === 'manual') {
            // Manual sources never join the unattended cadence; the row is
            // skipped before reconcile and its cursor is left to the
            // reschedule path (a config change re-arms or leaves it; it is
            // never fetched here).
            return;
        }
        const isRetry = app.retry_at !== null && app.retry_at <= Date.now();
        // An out-of-band caller (the resume path) names its own trigger; a
        // timer tick derives it from the row's cursors as before.
        const trigger: ReconcileTrigger = triggerOverride ?? (isRetry ? 'retry' : 'poll');
        let result;
        try {
            result = await GitSourceService.getInstance().reconcile({
                intent: 'fetch',
                applicationId: app.id,
                stackName,
                trigger,
                actor: 'system:source-controller',
            });
        } catch (e) {
            console.error(
                `[SourceController] evaluation failed for ${sanitizeForLog(app.id)}:`,
                e instanceof Error ? e.message : String(e),
            );
            // The row keeps its past-due cursor, so the source stays due and
            // the next tick picks it up again; the backoff machinery only
            // applies to classified failures the row records as evidence.
            return;
        }
        // Re-read the row: reconcile mutated it through its own transitions,
        // and the scheduling/acceptance decisions below must act on what is
        // durable now, not on the pre-tick snapshot.
        const fresh = GitOpsStore.getInstance().getApplication(app.id);
        if (!fresh) return;
        if (result.outcome === 'failed_previous_intact' || result.outcome === 'retry_scheduled') {
            this.maybeScheduleRetry(fresh);
        } else if (SUCCESS_SHAPED_OUTCOMES.has(result.outcome)) {
            this.maybeScheduleNextPoll(fresh);
            // Automatic acceptance only runs for a success-shaped outcome. A
            // conflict-blocked candidate settles into 'blocked', so it never
            // reaches acceptance from here; the boundary itself additionally
            // refuses a durable blocked candidate below
            // (requireAcceptableCandidate guards against an outcome that
            // misreports the row's state).
            await this.maybeAcceptAutomaticCandidate(fresh, stackName, trigger);
        }
    }

    /**
     * Arm the retry cursor after a failed evaluation. Only a classifiable
     * transient failure code below its ceiling schedules; a legacy or
     * unclassifiable failure_class is treated as permanent. Permanent,
     * operator-action, and ceiling-exhausted outcomes stay visible as a
     * failure the operator must resolve.
     */
    private maybeScheduleRetry(app: GitOpsApplicationRow): void {
        const code = app.failure_class;
        if (!code || app.failure_stage !== 'fetch') return;
        if (!isGitSourceErrorCode(code)) return;
        const disposition = classifyFailure({ kind: 'git_source_error', code });
        if (disposition.class !== 'transient' || app.retry_count >= disposition.retryCeiling) return;
        try {
            GitOpsTransitions.getInstance().sourceRetryScheduled(
                app.id,
                nextRetryAt(Date.now(), app.retry_count),
                app.retry_count + 1,
                { operationId: randomUUID(), actor: 'system:source-controller', trigger: 'retry', at: Date.now() },
            );
        } catch (e) {
            this.warnSkipped(app.id, 'retry not scheduled', e);
        }
    }

    /**
     * Re-arm the poll cursor after a successful evaluation, so the source
     * sleeps on its configured cadence instead of being re-polled every tick.
     * Manual sources and polling-disabled configurations never re-arm, so
     * after the fetch consumed the old cursor the row drops out of the due
     * set until a config change (or a manual pull) arms it again.
     */
    private maybeScheduleNextPoll(app: GitOpsApplicationRow): void {
        if (app.source_policy === 'manual') return;
        const secs = this.effectiveIntervalSecs(app);
        if (secs <= 0) return;
        try {
            GitOpsTransitions.getInstance().sourcePollScheduled(
                app.id,
                Date.now() + secs * 1000,
                { operationId: randomUUID(), actor: 'system:source-controller', trigger: 'poll', at: Date.now() },
            );
        } catch (e) {
            this.warnSkipped(app.id, 'next poll not scheduled', e);
        }
    }

    /**
     * For an automatic-policy source holding a validated candidate, evaluate
     * the candidate against the security policy and, when it is allowed,
     * accept it on the policy's behalf and drive the apply. A blocked or
     * unprovable candidate holds for a human. On the evidence side, a
     * present-but-unreadable `.env` or an unreadable compose file holds
     * (compose-only interpolation happens only when `.env` is absent).
     */
    private async maybeAcceptAutomaticCandidate(
        app: GitOpsApplicationRow,
        stackName: string,
        trigger: ReconcileTrigger,
    ): Promise<void> {
        if (app.source_policy !== 'automatic') return;
        // A source that already fell back to review under a safety refusal
        // waits for the operator: re-evaluating every tick would repeat the
        // refusal without changing anything. The reason field, not the plain
        // review flag, is the marker: a review-policy candidate later switched
        // to automatic has no refusal to honor and must evaluate normally.
        if (app.review_block_reason !== null) return;
        if (!app.candidate_generation_id || app.accepted_generation_id === app.candidate_generation_id) return;
        const generation = GitOpsStore.getInstance().getGeneration(app.candidate_generation_id);
        if (!generation) return;
        const imageRefs = this.candidateImageRefs(stackName, app, generation);
        if (imageRefs === null) return;
        let evaluation;
        try {
            evaluation = await evaluateCandidatePolicy(
                stackName,
                NodeRegistry.getInstance().getDefaultNodeId(),
                imageRefs,
                buildSystemPolicyGateOptions('system:source-controller'),
            );
        } catch (e) {
            console.error(
                `[SourceController] policy evaluation failed for ${sanitizeForLog(app.id)}:`,
                e instanceof Error ? e.message : String(e),
            );
            return;
        }
        if (evaluation.status !== 'allowed') {
            // Fail closed with the reason visible: the row keeps its
            // candidate_ready facet, which on its own reads as progress, so
            // the hold is only attributable when it is logged. The evaluator
            // records the policy verdict itself in the audit trail; this log
            // ties it to the source being held.
            console.warn(
                `[SourceController] automatic candidate held for ${sanitizeForLog(app.id)}: policy verdict ${evaluation.status}`,
            );
            return;
        }
        let acceptGeneration: GitOpsGenerationRow;
        try {
            const revalidated = await GitSourceService.getInstance().revalidateSourceCandidateBeforeAccept({
                stackName,
                generation,
                evaluation,
                trigger,
                actor: 'system:source-controller',
            });
            if (revalidated.status === 'refuse') {
                console.warn(
                    `[SourceController] automatic candidate held for ${sanitizeForLog(app.id)}: ${sanitizeForLog(revalidated.reason)}`,
                );
                return;
            }
            acceptGeneration = revalidated.generation;
        } catch (e) {
            this.warnSkipped(app.id, 'source revalidation failed', e);
            return;
        }
        // Stateful safety: this acceptance route has no human in the loop, so
        // it must prove the candidate does not withdraw or rename a stateful
        // workload relative to the generation in force. Unprovable evidence is
        // a hold, never an acceptance.
        const withdrawal = checkStatefulWithdrawal(stackName, app, acceptGeneration);
        if (withdrawal.status !== 'clear') {
            const recorded = holdForStatefulReview(app, acceptGeneration, {
                operationId: randomUUID(),
                actor: 'system:source-controller',
                trigger,
                at: Date.now(),
            });
            const detail = withdrawal.status === 'withdrawn'
                ? `the candidate withdraws or renames stateful services (${withdrawal.services.map((name) => sanitizeForLog(name)).join(', ')})`
                : `a stateful withdrawal cannot be ruled out (${withdrawal.reason})`;
            const unrecorded = recorded ? '' : ' (the block could not be recorded; see server logs)';
            console.warn(
                `[SourceController] automatic candidate held for ${sanitizeForLog(app.id)}: ${detail}; an operator must accept explicitly${unrecorded}`,
            );
            return;
        }
        try {
            GitOpsTransitions.getInstance().sourceAccepted({
                applicationId: app.id,
                generationId: acceptGeneration.id,
                artifactSetId: newGitOpsId(),
                sourceAcceptanceId: newGitOpsId(),
                authority: 'configured_policy',
                envelope: { operationId: randomUUID(), actor: 'system:source-controller', trigger, at: Date.now() },
            });
        } catch (e) {
            this.warnSkipped(app.id, 'automatic acceptance failed', e);
            return;
        }
        // The acceptance cleared the candidate pointer; hand the accepted
        // generation to the shared dispatch boundary, which revalidates the
        // live target under the stack lock and promotes the generation's own
        // staged candidate (the deploy choice is read from the source row
        // there, under the lock). A reserved dispatch never throws: refusals
        // come back as blocked outcomes. The try/catch stays for the
        // pre-reservation entry guards (store reads on a failing database).
        try {
            const dispatch = await GitSourceService.getInstance().dispatchAcceptedGeneration(
                buildAcceptedGeneration(acceptGeneration),
                GitSourceService.dispatchContextFor(app),
                { trigger, actor: 'system:source-controller' },
            );
            if (dispatch.status === 'blocked') {
                // The acceptance stands while the apply is refused, so the
                // row alone cannot explain why nothing moved: log the reason.
                console.warn(
                    `[SourceController] automatic dispatch blocked for ${sanitizeForLog(app.id)}: ${sanitizeForLog(dispatch.reason)}`,
                );
            }
        } catch (e) {
            // Reaching here means nothing was reserved, so no durable row
            // exists and the next tick will not retry (the acceptance cleared
            // the candidate pointer). The log is the only evidence: say what
            // stands and what the operator must do. Scrub the whole stack:
            // dispatch throws can carry credential-shaped transport text, and
            // nothing downstream redacts what lands in the server log.
            console.error(
                `[SourceController] automatic dispatch failed for ${sanitizeForLog(app.id)} before reserving an attempt. The generation remains accepted and will not auto-apply; dispatch it manually:`,
                redactSensitiveText(e instanceof Error ? e.stack ?? e.message : String(e)),
            );
        }
    }

    /**
     * Read the candidate's image refs off disk for policy evaluation. Null
     * means the evidence could not be read, so the caller holds the candidate
     * rather than evaluating against an empty ref set.
     */
    private candidateImageRefs(
        stackName: string,
        app: GitOpsApplicationRow,
        generation: GitOpsGenerationRow,
    ): string[] | null {
        const staged = readStagedGeneration(stackName, app, generation);
        if (!staged) return null;
        const refs = new Set<string>();
        for (const content of staged.contents) {
            for (const img of extractImagesFromCompose(content, staged.mergedEnv)) refs.add(img);
        }
        return [...refs];
    }

    private warnSkipped(appId: string, what: string, e: unknown): void {
        console.warn(
            `[SourceController] ${what} for ${sanitizeForLog(appId)}:`,
            e instanceof Error ? e.message : String(e),
        );
    }
}
