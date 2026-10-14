import { randomUUID } from 'crypto';
import { GitOpsStore } from './store';
import { GitOpsTransitions } from './transitions';
import { GitSourceService } from '../GitSourceService';
import { buildAcceptedGeneration } from './handoff';
import { dispatchPreparedGitManagedGeneration, GIT_MANAGED_ARTIFACT_UNRESOLVED_REASON } from './gitManagedHandoff';
import { checkStatefulWithdrawal, holdForStatefulReview, readStagedGeneration } from './statefulGuard';
import { prepareAcceptedGitManagedGeneration } from './gitManagedMaterialization';
import { DatabaseService } from '../DatabaseService';
import type { GitOpsApplicationRow, GitOpsGenerationRow } from './types';
import { classifyFailure, nextRetryAt, isGitSourceErrorCode, effectivePollIntervalSecs } from './backoff';
import { evaluateCandidatePolicy } from '../PolicyEnforcement';
import { buildSystemPolicyGateOptions } from '../../helpers/policyGate';
import { newGitOpsId } from './directApplication';
import { NodeRegistry } from '../NodeRegistry';
import { extractImagesFromCompose } from '../ImageUpdateService';
import type { ReconcileOutcome, ReconcileResult } from './outcomes';
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
 * Whether the row is waiting on a recovery: a restore in flight, or a hold
 * that success evidence retires.
 *
 * Both clear without an operator touching the source, so the poll cadence has
 * to outlive them. A settled `complete` receipt has nothing outstanding, and
 * an interrupted fetch or apply (`source_unknown`) waits on the operator
 * rather than on recovery, so neither is a recovery wait.
 */
function recoveryWaitHolds(app: GitOpsApplicationRow): boolean {
    return app.recovery_phase === 'restoring'
        || app.recovery_phase === 'compensating'
        || app.recovery_phase === 'failed'
        || app.failure_stage === 'recovery';
}

export type OperatorFetchRefusalCode =
    | 'not_git_managed'
    | 'no_source_identity'
    | 'suspended'
    | 'applying'
    | 'fetch_in_flight'
    | 'recovery';

/**
 * What settlement did after a fetch, so a caller can tell a staged commit
 * from an acceptance, a started rollout, or a hold. `started` means the
 * rollout was handed off, not that it finished.
 */
export type FetchAuthorityReport =
    | { status: 'not_applicable' }
    | { status: 'fetched_only' }
    | { status: 'held'; note: string }
    | { status: 'accepted'; rollout: 'started' | 'held' | 'not_started'; note: string | null };

export type OperatorFetchResult =
    | { status: 'refused'; code: OperatorFetchRefusalCode; error: string }
    | {
        status: 'settled';
        result: ReconcileResult;
        candidateGenerationId: string | null;
        authority: FetchAuthorityReport;
    };

const NO_AUTHORITY: FetchAuthorityReport = { status: 'not_applicable' };

/**
 * How long an operator pull waits after acceptance before answering.
 * The accept route uses the same bound: a registry lookup or a sequential
 * rollout must not hold an already-committed acceptance open.
 */
const POST_ACCEPT_RESPONSE_MS = 15_000;

const PREPARATION_CONTINUING_NOTE =
    'preparation is still running; the rollout becomes authorizable when it completes';

const ROLLOUT_STARTING_NOTE =
    'the rollout is starting; watch the application for progress';

/** Set when an operator pull still has preparation or dispatch running after it answers. */
interface PostAcceptFollow {
    pending: Promise<void> | null;
}

/**
 * Answer with `fallback` when `work` is still running at the response
 * deadline. The underlying promise is left running either way.
 */
function responseWithin<T>(
    work: Promise<T>,
    fallback: T,
    onError: (err: unknown) => void,
): Promise<{ value: T; completed: boolean }> {
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve({ value: fallback, completed: false });
        }, POST_ACCEPT_RESPONSE_MS);
        work.then(
            (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ value, completed: true });
            },
            (err: unknown) => {
                onError(err);
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ value: fallback, completed: true });
            },
        );
    });
}

function refuseFetch(code: OperatorFetchRefusalCode, error: string): OperatorFetchResult {
    return { status: 'refused', code, error };
}

/**
 * Join note fragments the route will capitalize as one response.
 * A single fragment stays as written. Later fragments become their own sentences.
 */
function joinAuthorityNotes(parts: Array<string | null>): string | null {
    const present = parts
        .map((part) => part?.trim() ?? '')
        .filter((part) => part.length > 0);
    if (present.length === 0) return null;
    if (present.length === 1) return present[0];
    return present.map((part, index) => {
        const bare = part.replace(/[.!?]$/, '');
        if (index === 0) return bare;
        return `${bare.charAt(0).toUpperCase()}${bare.slice(1)}`;
    }).join('. ');
}

/**
 * A skipped handoff that only repeats an unresolved artifact adds nothing
 * once preparation already named why. Any other handoff reason stays.
 */
function skippedAuthorityNote(
    prepared: { artifact: string; note: string | null },
    reason: string | null,
): string | null {
    const explained = prepared.artifact !== 'resolved'
        && prepared.note !== null
        && reason === GIT_MANAGED_ARTIFACT_UNRESOLVED_REASON;
    return joinAuthorityNotes([prepared.note, explained ? null : reason]);
}

/** Prefer a sentence already written for an operator. Internal phrases stay in the log. */
function operatorHoldNote(reason: string): string {
    return reason.startsWith('The ') ? reason : 'The candidate was not accepted.';
}

/**
 * Row-level reasons an operator pull must not start. A missing application,
 * a non-Blueprint row, and a Blueprint that is not active or creating all
 * refuse the same way: this entry point does not fetch Direct sources,
 * which keep their own pull route.
 */
function operatorFetchBlock(
    app: GitOpsApplicationRow | undefined,
    inFlight: boolean,
): OperatorFetchResult | { app: GitOpsApplicationRow; stackName: string } {
    if (!app || app.target_mode !== 'blueprint' || (app.lifecycle_status !== 'active' && app.lifecycle_status !== 'creating')) {
        return refuseFetch('not_git_managed', 'Pull source applies to a Git-managed Blueprint.');
    }
    const stackName = app.configured_source_stack_name ?? app.stack_name;
    if (!stackName) {
        return refuseFetch('no_source_identity', 'This Blueprint has no Git source to pull.');
    }
    if (app.suspended_at) {
        return refuseFetch('suspended', 'This source is suspended. Resume it before pulling.');
    }
    if (app.active_operation_stage === 'apply_started') {
        return refuseFetch('applying', 'A fetch cannot start while a candidate is being applied.');
    }
    // A fetch may replace the candidate. Apply recovery is eligible only while
    // the interrupted generation is still that candidate, so the pull waits.
    // An interrupted fetch stays pullable: the next fetch clears it.
    if (
        app.interruption_stage === 'apply_started'
        && app.interruption_generation_id !== null
        && app.interruption_generation_id === app.candidate_generation_id
    ) {
        return refuseFetch('applying', 'A fetch cannot start while an interrupted apply is still unresolved.');
    }
    if (inFlight || app.active_operation_stage === 'fetch_started') {
        return refuseFetch('fetch_in_flight', 'A fetch is already running for this source.');
    }
    if (recoveryWaitHolds(app)) {
        return refuseFetch('recovery', 'A fetch cannot start while this source is recovering.');
    }
    return { app, stackName };
}

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
 * sources never join the unattended cadence. An operator pull of a
 * Git-managed Blueprint goes through requestFetch, which uses this same
 * settle path and still leaves a manual source off the cadence.
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

    /**
     * Operator pull for a Git-managed Blueprint. Stages a candidate through
     * the same reconcile fetch a poll uses, then settles with the same
     * post-fetch rules. Manual sources stay off the cadence and are not
     * accepted here. Automatic sources are accepted by the stored policy,
     * the same as a poll. A fetch already in this process, a row already
     * in fetch_started, or an interrupted apply that still names the
     * current candidate is refused before reconcile runs. An interrupted
     * fetch stays eligible: the next fetch clears that interruption.
     *
     * After acceptance commits, preparation and dispatch are answered within
     * a short deadline. Work still running is reported as continuing, not as
     * a failed pull, and this application stays in flight until it finishes.
     */
    public async requestFetch(applicationId: string, actor: string): Promise<OperatorFetchResult> {
        const store = GitOpsStore.getInstance();
        const blocked = operatorFetchBlock(store.getApplication(applicationId), this.inFlight.has(applicationId));
        if ('status' in blocked) return blocked;
        const { app, stackName } = blocked;
        this.inFlight.add(app.id);
        const follow: PostAcceptFollow = { pending: null };
        try {
            const result = await GitSourceService.getInstance().reconcile({
                intent: 'fetch',
                applicationId: app.id,
                stackName,
                trigger: 'manual',
                actor,
            });
            const fresh = store.getApplication(app.id);
            const authority = fresh
                ? await this.settleAfterReconcile(fresh, stackName, result, 'manual', follow)
                : NO_AUTHORITY;
            return {
                status: 'settled',
                result,
                candidateGenerationId: store.getApplication(app.id)?.candidate_generation_id ?? null,
                authority,
            };
        } finally {
            if (follow.pending) {
                void follow.pending.finally(() => this.releaseAndDrainWake(app.id));
            } else {
                this.releaseAndDrainWake(app.id);
            }
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
        const fresh = GitOpsStore.getInstance().getApplication(app.id);
        if (!fresh) return;
        await this.settleAfterReconcile(fresh, stackName, result, trigger);
    }

    /**
     * What a finished fetch does to the cadence and to an automatic policy.
     * Shared by the poll and by an operator pull so the two cannot disagree
     * about which outcome re-arms, retries, or accepts. Manual sources are
     * declined inside the cursor helpers: a pull must not enroll them.
     *
     * `follow` is set only by an operator pull. The poll omits it and waits
     * for preparation and dispatch, because no request is held open.
     */
    private async settleAfterReconcile(
        fresh: GitOpsApplicationRow,
        stackName: string,
        result: ReconcileResult,
        trigger: ReconcileTrigger,
        follow?: PostAcceptFollow,
    ): Promise<FetchAuthorityReport> {
        if (result.outcome === 'failed_previous_intact' || result.outcome === 'retry_scheduled') {
            this.maybeScheduleRetry(fresh);
            return NO_AUTHORITY;
        }
        if (SUCCESS_SHAPED_OUTCOMES.has(result.outcome)) {
            this.maybeScheduleNextPoll(fresh);
            // Automatic acceptance only runs for a success-shaped outcome. A
            // conflict-blocked candidate settles into 'blocked', so it never
            // reaches acceptance from here; the boundary itself additionally
            // refuses a durable blocked candidate
            // (requireAcceptableCandidate guards against an outcome that
            // misreports the row's state).
            return this.maybeAcceptAutomaticCandidate(fresh, stackName, trigger, follow);
        }
        if (result.outcome === 'recovery_required' && recoveryWaitHolds(fresh)) {
            // A recovery wait is not terminal: the hold clears through success
            // evidence (an acknowledgement or a bind) that never touches the
            // source. The fetch that just ran consumed the poll cursor, so
            // without re-arming here the source would drop out of the cadence
            // and stay idle after the recovery settles. Automatic acceptance
            // stays gated on success-shaped outcomes, so the hold still
            // withholds progression.
            this.maybeScheduleNextPoll(fresh);
        }
        return NO_AUTHORITY;
    }

    /**
     * Arm the retry cursor after a failed evaluation. Only a classifiable
     * transient failure code below its ceiling schedules; a legacy or
     * unclassifiable failure_class is treated as permanent. Permanent,
     * operator-action, and ceiling-exhausted outcomes stay visible as a
     * failure the operator must resolve.
     */
    private maybeScheduleRetry(app: GitOpsApplicationRow): void {
        if (app.source_policy === 'manual') return;
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
     * Re-arm the poll cursor after an evaluation that leaves the source
     * eligible, so the source sleeps on its configured cadence instead of
     * being re-polled every tick. Manual sources and polling-disabled
     * configurations never re-arm, so after the fetch consumed the old cursor
     * the row drops out of the due set until a config change (or a manual
     * pull) arms it again.
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
        follow?: PostAcceptFollow,
    ): Promise<FetchAuthorityReport> {
        if (app.source_policy !== 'automatic') return NO_AUTHORITY;
        if (!app.candidate_generation_id || app.accepted_generation_id === app.candidate_generation_id) {
            return { status: 'fetched_only' };
        }
        // A source that already fell back to review under a safety refusal
        // waits for the operator: re-evaluating every tick would repeat the
        // refusal without changing anything. The reason field, not the plain
        // review flag, is the marker: a review-policy candidate later switched
        // to automatic has no refusal to honor and must evaluate normally.
        if (app.review_block_reason !== null) {
            return { status: 'held', note: 'A previous safety check is still waiting for an operator.' };
        }
        const generation = GitOpsStore.getInstance().getGeneration(app.candidate_generation_id);
        if (!generation) return { status: 'held', note: 'The candidate generation is not available.' };
        const imageRefs = this.candidateImageRefs(stackName, app, generation);
        if (imageRefs === null) {
            return { status: 'held', note: 'The candidate could not be read, so it was not accepted.' };
        }
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
            return { status: 'held', note: 'The security policy could not be evaluated, so the candidate was not accepted.' };
        }
        if (evaluation.status !== 'allowed') {
            // Fail closed and log the policy verdict: the retained `candidate_ready`
            // facet reads as progress. The evaluator records policy audit rows
            // only for bypasses and suppression-driven passes, not blocked or
            // unavailable verdicts.
            console.warn(
                `[SourceController] automatic candidate held for ${sanitizeForLog(app.id)}: policy verdict ${evaluation.status}`,
            );
            return { status: 'held', note: 'The security policy did not allow this candidate, so it was not accepted.' };
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
                return { status: 'held', note: operatorHoldNote(revalidated.reason) };
            }
            acceptGeneration = revalidated.generation;
        } catch (e) {
            this.warnSkipped(app.id, 'source revalidation failed', e);
            return { status: 'held', note: 'The candidate could not be checked again, so it was not accepted.' };
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
            return {
                status: 'held',
                note: withdrawal.status === 'withdrawn'
                    ? 'The candidate changes stateful services, so an operator must accept it.'
                    : 'A stateful change could not be ruled out, so an operator must accept it.',
            };
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
            return { status: 'held', note: 'The candidate was not accepted.' };
        }
        // A Git-managed Blueprint needs its accepted generation materialized and
        // its artifact set resolved before the dispatch boundary can authorize
        // the rollout: the dispatch reads the applied materialization and the
        // preflight refuses an unresolved artifact set. Both steps are
        // idempotent and the reconciler retries them, so a failure here is
        // reported and the dispatch below still runs (and refuses truthfully).
        if (app.target_mode === 'blueprint' && follow) {
            return this.boundBlueprintPostAccept(app, acceptGeneration.id, trigger, follow);
        }
        if (app.target_mode === 'blueprint') {
            const prepared = await prepareAcceptedGitManagedGeneration({
                applicationId: app.id,
                generationId: acceptGeneration.id,
                actor: 'system:source-controller',
                trigger,
            });
            if (prepared.note) {
                console.warn(
                    `[SourceController] Git-managed preparation incomplete for ${sanitizeForLog(app.id)}: ${sanitizeForLog(prepared.note)}`,
                );
            }
        }
        if (app.target_mode === 'blueprint') {
            // The one handoff applies the same policy, enabled, pause, and
            // suspension gates every other path uses. A durable refusal is held
            // by the handoff and logged there; a skipped gate is a deliberate
            // withholding and needs no log here.
            const handoff = await dispatchPreparedGitManagedGeneration({
                applicationId: app.id,
                generationId: acceptGeneration.id,
                actor: 'system:source-controller',
                trigger,
            });
            if (handoff.status === 'dispatched') {
                return { status: 'accepted', rollout: 'started', note: null };
            }
            if (handoff.status === 'blocked') {
                // The acceptance stands while the apply is refused, so the row
                // alone cannot explain why nothing moved: log the reason.
                console.warn(
                    `[SourceController] automatic dispatch blocked for ${sanitizeForLog(app.id)}: ${sanitizeForLog(handoff.reason ?? 'unknown')}`,
                );
                return { status: 'accepted', rollout: 'held', note: handoff.reason ?? 'The rollout did not start.' };
            }
            return { status: 'accepted', rollout: 'not_started', note: handoff.reason };
        }
        // Direct: the shared dispatch boundary promotes the generation through
        // completeGitApply, under the stack lock. A reserved dispatch never
        // throws: refusals come back as blocked outcomes. The try/catch stays
        // for the pre-reservation entry guards (store reads on a failing
        // database).
        try {
            const dispatch = await GitSourceService.getInstance().dispatchAcceptedGeneration(
                buildAcceptedGeneration(acceptGeneration),
                GitSourceService.dispatchContextFor(app),
                { trigger, actor: 'system:source-controller' },
            );
            if (dispatch.status === 'blocked') {
                // The acceptance stands while the apply is refused, so the row
                // alone cannot explain why nothing moved: log the reason.
                console.warn(
                    `[SourceController] automatic dispatch blocked for ${sanitizeForLog(app.id)}: ${sanitizeForLog(dispatch.reason)}`,
                );
                return { status: 'accepted', rollout: 'held', note: dispatch.reason };
            }
            return { status: 'accepted', rollout: 'started', note: null };
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
            return { status: 'accepted', rollout: 'held', note: 'The rollout did not start.' };
        }
    }

    /**
     * Answer an automatic Blueprint pull without waiting out preparation or
     * a sequential rollout. Acceptance has already committed. Each step still
     * runs once; the in-flight slot stays held until both have settled.
     */
    private async boundBlueprintPostAccept(
        app: GitOpsApplicationRow,
        generationId: string,
        trigger: ReconcileTrigger,
        follow: PostAcceptFollow,
    ): Promise<FetchAuthorityReport> {
        const prepareWork = prepareAcceptedGitManagedGeneration({
            applicationId: app.id,
            generationId,
            actor: 'system:source-controller',
            trigger,
        });
        const prepared = await responseWithin(prepareWork, {
            materialized: false,
            artifact: 'none',
            note: PREPARATION_CONTINUING_NOTE,
        }, (err) => this.warnPostAccept(app.id, 'preparation', err));
        if (prepared.completed && prepared.value.note) {
            console.warn(
                `[SourceController] Git-managed preparation incomplete for ${sanitizeForLog(app.id)}: ${sanitizeForLog(prepared.value.note)}`,
            );
        }
        const dispatchWork = dispatchPreparedGitManagedGeneration({
            applicationId: app.id,
            generationId,
            actor: 'system:source-controller',
            trigger,
        });
        const handoff = await responseWithin(dispatchWork, {
            status: 'skipped',
            reason: ROLLOUT_STARTING_NOTE,
        }, (err) => this.warnPostAccept(app.id, 'dispatch', err));
        const report = this.boundedBlueprintAuthority(app.id, prepared, handoff);
        follow.pending = prepared.completed && handoff.completed
            ? null
            : Promise.allSettled([prepareWork, dispatchWork]).then((results) => {
                const dispatched = results[1];
                if (
                    !handoff.completed
                    && dispatched.status === 'fulfilled'
                    && dispatched.value.status === 'blocked'
                ) {
                    this.warnBlockedDispatch(app.id, dispatched.value.reason);
                }
            });
        return report;
    }

    /** The authority report for a Blueprint pull whose post-accept work may still be running. */
    private boundedBlueprintAuthority(
        appId: string,
        prepared: { completed: boolean; value: { artifact: string; note: string | null } },
        handoff: { completed: boolean; value: { status: 'dispatched' | 'blocked' | 'skipped'; reason: string | null } },
    ): FetchAuthorityReport {
        if (handoff.completed && handoff.value.status === 'dispatched') {
            return { status: 'accepted', rollout: 'started', note: null };
        }
        if (handoff.completed && handoff.value.status === 'blocked') {
            this.warnBlockedDispatch(appId, handoff.value.reason);
            const held = handoff.value.reason ?? 'The rollout did not start.';
            const note = prepared.completed ? joinAuthorityNotes([prepared.value.note, held]) : held;
            return { status: 'accepted', rollout: 'held', note };
        }
        if (!prepared.completed) {
            return { status: 'accepted', rollout: 'not_started', note: PREPARATION_CONTINUING_NOTE };
        }
        if (!handoff.completed) {
            return {
                status: 'accepted',
                rollout: 'not_started',
                note: joinAuthorityNotes([prepared.value.note, ROLLOUT_STARTING_NOTE]),
            };
        }
        return {
            status: 'accepted',
            rollout: 'not_started',
            note: skippedAuthorityNote(prepared.value, handoff.value.reason),
        };
    }

    private warnBlockedDispatch(appId: string, reason: string | null): void {
        console.warn(
            `[SourceController] automatic dispatch blocked for ${sanitizeForLog(appId)}: ${sanitizeForLog(reason ?? 'unknown')}`,
        );
    }

    private warnPostAccept(appId: string, step: 'preparation' | 'dispatch', err: unknown): void {
        console.error(
            `[SourceController] Git-managed ${step} failed for ${sanitizeForLog(appId)}:`,
            redactSensitiveText(err instanceof Error ? err.message : String(err)),
        );
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
