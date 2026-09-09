import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { GitOpsStore } from './store';
import { GitOpsTransitions } from './transitions';
import { GitSourceService } from '../GitSourceService';
import { DatabaseService } from '../DatabaseService';
import type { GitOpsApplicationRow, GitOpsGenerationRow } from './types';
import { classifyFailure, nextRetryAt, isGitSourceErrorCode } from './backoff';
import { evaluateCandidatePolicy } from '../PolicyEnforcement';
import { buildSystemPolicyGateOptions } from '../../helpers/policyGate';
import { stackManagedRoot, newGitOpsId } from './directApplication';
import { NodeRegistry } from '../NodeRegistry';
import { gitSourceLocalComposeFiles } from '../../utils/gitComposeFiles';
import { extractImagesFromCompose, loadDotEnv } from '../ImageUpdateService';
import type { ReconcileOutcome } from './outcomes';
import { sanitizeForLog } from '../../utils/safeLog';

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
 * (authority 'configured_policy') and dispatches the apply through
 * reconcile({intent:'apply'}), the same fused fetch+apply path a manual
 * apply runs. Review-policy sources stage candidates for a human; manual
 * sources never join the unattended cadence.
 *
 * Remaining gap against the source policy design: a retry always re-issues
 * a fetch rather than resuming at the stage that failed (fetch vs. apply
 * dispatch). Stage-aware retry is follow-on work once failures can carry
 * enough durable context to resume mid-application.
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

    /**
     * Recompute the poll cursor for every active direct application after a
     * configuration change (the global interval was edited). Automatic and
     * review sources get a fresh cursor; manual sources never join the
     * unattended schedule, a source still inside a retry backoff window
     * keeps its retry cursor as the next wake, and turning polling off
     * leaves existing cursors alone: they fire, the fetch consumes them,
     * and the controller declines to re-arm, so the source drops out of the
     * due set.
     */
    rescheduleAll(actor: string): void {
        const now = Date.now();
        const store = GitOpsStore.getInstance();
        for (const app of store.listActiveDirectApplications()) {
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
     * into a tight loop against the remote.
     */
    private effectiveIntervalSecs(app: GitOpsApplicationRow): number {
        const perSource = app.poll_interval_secs;
        if (perSource !== null && perSource !== undefined) {
            return perSource > 0 ? Math.max(perSource, 60) : 0;
        }
        const global = DatabaseService.getInstance().getGitOpsPollIntervalMins() * 60;
        return global > 0 ? Math.max(global, 60) : 0;
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
                .finally(() => this.inFlight.delete(app.id));
        }
    }

    private async evaluate(app: GitOpsApplicationRow): Promise<void> {
        if (!app.stack_name) {
            console.warn(`[SourceController] Skipping ${sanitizeForLog(app.id)}: direct-mode application has no stack_name.`);
            return;
        }
        if (app.source_policy === 'manual') {
            // Manual sources never join the unattended cadence; the row is
            // skipped before reconcile and its cursor is left to the
            // reschedule path (a config change re-arms or leaves it; it is
            // never fetched here).
            return;
        }
        const stackName = app.stack_name;
        const isRetry = app.retry_at !== null && app.retry_at <= Date.now();
        let result;
        try {
            result = await GitSourceService.getInstance().reconcile({
                intent: 'fetch',
                applicationId: app.id,
                stackName,
                trigger: isRetry ? 'retry' : 'poll',
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
        }
        await this.maybeAcceptAutomaticCandidate(fresh, stackName, isRetry ? 'retry' : 'poll');
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
        trigger: 'poll' | 'retry',
    ): Promise<void> {
        if (app.source_policy !== 'automatic') return;
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
        try {
            GitOpsTransitions.getInstance().sourceAccepted({
                applicationId: app.id,
                generationId: generation.id,
                artifactSetId: newGitOpsId(),
                sourceAcceptanceId: newGitOpsId(),
                authority: 'configured_policy',
                envelope: { operationId: randomUUID(), actor: 'system:source-controller', trigger, at: Date.now() },
            });
        } catch (e) {
            this.warnSkipped(app.id, 'automatic acceptance failed', e);
            return;
        }
        // The acceptance cleared the candidate pointer; dispatch the
        // generation the way the webhook auto-apply path does, through the
        // same reconcile() apply intent a manual apply runs.
        try {
            await GitSourceService.getInstance().reconcile({
                intent: 'apply',
                applicationId: app.id,
                stackName,
                trigger,
                actor: 'system:source-controller',
                commitSha: generation.commit_sha,
                planFingerprint: generation.change_plan_fingerprint ?? '',
                deploy: DatabaseService.getInstance().getGitSource(stackName)?.auto_deploy_on_apply ?? false,
            });
        } catch (e) {
            console.error(
                `[SourceController] apply dispatch failed for ${sanitizeForLog(app.id)}:`,
                e instanceof Error ? e.message : String(e),
            );
        }
    }

    /**
     * Read the candidate's image refs off disk for policy evaluation: the
     * candidate's compose files (paths come from the application row, mapped
     * the same way staging laid them out) with its staged .env merged under
     * process.env, exactly as the update scanner resolves them. Returns null
     * when the evidence cannot be read (missing staging directory, unreadable
     * compose file, a .env that exists but cannot be read; an absent .env is
     * normal and interpolates compose-only): the caller then holds the
     * candidate rather than evaluating against an empty ref set.
     */
    private candidateImageRefs(
        stackName: string,
        app: GitOpsApplicationRow,
        generation: GitOpsGenerationRow,
    ): string[] | null {
        try {
            const candidateDir = path.join(stackManagedRoot(stackName), generation.candidate_dir);
            const composePaths: string[] = app.compose_paths_json ? JSON.parse(app.compose_paths_json) : [];
            if (composePaths.length === 0) return null;
            const contents: string[] = [];
            for (const local of gitSourceLocalComposeFiles(composePaths)) {
                contents.push(fs.readFileSync(path.join(candidateDir, local), 'utf8'));
            }
            let envVars: Record<string, string> = {};
            try {
                envVars = loadDotEnv(fs.readFileSync(path.join(candidateDir, '.env'), 'utf8'));
            } catch (e) {
                // A missing .env is normal (the staging step only writes one
                // when sync_env produced it), but a present-yet-unreadable one
                // would silently narrow the interpolation inputs the policy
                // sees, so surface it and hold rather than evaluate on
                // incomplete evidence.
                const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
                if (!missing) {
                    console.warn(
                        `[SourceController] staged .env unreadable for ${sanitizeForLog(stackName)} (generation ${sanitizeForLog(generation.id)}); holding candidate:`,
                        e instanceof Error ? e.message : String(e),
                    );
                    return null;
                }
            }
            const merged: Record<string, string> = { ...envVars };
            for (const [k, v] of Object.entries(process.env)) {
                if (v !== undefined) merged[k] = v;
            }
            const refs = new Set<string>();
            for (const content of contents) {
                for (const img of extractImagesFromCompose(content, merged)) refs.add(img);
            }
            return [...refs];
        } catch (e) {
            console.warn(
                `[SourceController] candidate evidence unreadable for ${sanitizeForLog(stackName)} (generation ${sanitizeForLog(generation.id)}):`,
                e instanceof Error ? e.message : String(e),
            );
            return null;
        }
    }

    private warnSkipped(appId: string, what: string, e: unknown): void {
        console.warn(
            `[SourceController] ${what} for ${sanitizeForLog(appId)}:`,
            e instanceof Error ? e.message : String(e),
        );
    }
}
