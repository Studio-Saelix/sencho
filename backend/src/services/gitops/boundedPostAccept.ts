/**
 * One bounded follow-up after a Git-managed acceptance has committed.
 *
 * Accept source and an operator pull both prepare the accepted generation,
 * then hand it off once that answer arrives, including when preparation is
 * still running. Each step has its own 15 second bound. `pending` is the work
 * still running after the answer. The operator pull holds it until it settles,
 * so a deadline does not release the in-flight slot. Accept source does not
 * hold a slot. A step that rejects instead of answering has finished and
 * failed, which is reported as a hold and never as work still running.
 * The handoff reads the confirmation the acceptance stored. Preparation is
 * the window in which the placement or the rollout policy can move, and
 * Authorize or Resume may already have replaced that stored claim.
 */
import {
    dispatchPreparedGitManagedGeneration,
    GIT_MANAGED_ARTIFACT_UNRESOLVED_REASON,
    type GitManagedDispatchOutcome,
} from './gitManagedHandoff';
import {
    prepareAcceptedGitManagedGeneration,
    type GitManagedFreezeStatus,
} from './gitManagedMaterialization';
import type { ReconcileTrigger } from './triggers';
import { redactSensitiveText, sanitizeForLog } from '../../utils/safeLog';

const RESPONSE_MS = 15_000;

const PREPARATION_CONTINUING_NOTE =
    'preparation is still running; the rollout becomes authorizable when it completes';

const ROLLOUT_STARTING_NOTE =
    'the rollout is starting; watch the application for progress';

const ROLLOUT_HELD_NOTE = 'The rollout did not start.';

// A rejection is not a step still running. The acceptance has committed, but
// the work behind it failed before it began, so saying it is starting would
// send the operator to wait on something that will never report.
const PREPARATION_FAILED_NOTE = 'preparation failed; the next reconcile retries it';

const ROLLOUT_FAILED_NOTE = 'the rollout could not be started';

interface PreparedStep {
    materialized: boolean;
    artifact: GitManagedFreezeStatus;
    note: string | null;
}

/**
 * One step, bounded by the response deadline.
 *
 * `timeout` is the only state that means work is still running. A `rejected`
 * step is finished and failed, which is a different fact from progress and has
 * its own note.
 */
type Timed<T> =
    | { state: 'fulfilled' | 'timeout'; value: T }
    | { state: 'rejected' };

const PREPARE_CONTINUING: PreparedStep = {
    materialized: false,
    artifact: 'none',
    note: PREPARATION_CONTINUING_NOTE,
};

const DISPATCH_CONTINUING: GitManagedDispatchOutcome = {
    status: 'skipped',
    reason: ROLLOUT_STARTING_NOTE,
};

export type BoundedRollout = 'started' | 'held' | 'not_started';

/** The pull reads rollout, authorityNote, and pending. Accept source reads the other fields. */
export interface BoundedPostAccept {
    rollout: BoundedRollout;
    authorityNote: string | null;
    materialized: boolean;
    artifactResolved: boolean;
    dispatched: boolean;
    acceptNote: string | null;
    /** Null when both steps finished inside the deadline. */
    pending: Promise<void> | null;
}

/** Capitalize each fragment. A final period, exclamation mark, or question mark stays. Anything else gains a period. */
export function formatOperatorSentences(parts: Array<string | null>): string | null {
    const sentences = parts
        .filter((part): part is string => part !== null && part.trim().length > 0)
        .map((part) => {
            const trimmed = part.trim();
            const capitalized = `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
            return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
        });
    return sentences.length > 0 ? sentences.join(' ') : null;
}

/**
 * Controller report. The first fragment keeps its wording and capital.
 * A trailing period, exclamation mark, or question mark is removed so the join can supply the period.
 */
function joinAuthorityNotes(parts: Array<string | null>): string | null {
    const present = parts
        .map((part) => part?.trim() ?? '')
        .filter((part) => part.length > 0);
    if (present.length === 0) return null;
    if (present.length === 1) return present[0];
    const [first, ...rest] = present;
    const sentences = [
        first.replace(/[.!?]$/, ''),
        ...rest.map((part) => {
            const bare = part.replace(/[.!?]$/, '');
            return `${bare.charAt(0).toUpperCase()}${bare.slice(1)}`;
        }),
    ];
    return sentences.join('. ');
}

function repeatsUnresolvedArtifact(artifact: GitManagedFreezeStatus, reason: string | null): boolean {
    return artifact !== 'resolved' && reason === GIT_MANAGED_ARTIFACT_UNRESOLVED_REASON;
}

/**
 * Answer with `fallback` if `work` is still running at the deadline.
 * The deadline does not cancel that work. A rejection before the deadline
 * settles as a failure of its own, so the slot does not wait on it and the
 * operator is not told the step is still running. A rejection after
 * the deadline is still logged.
 */
function responseWithin<T>(
    work: Promise<T>,
    fallback: T,
    onError: (err: unknown) => void,
): Promise<Timed<T>> {
    return new Promise((resolve) => {
        let settled = false;
        function finish(value: Timed<T>): void {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        }
        const timer = setTimeout(() => finish({ state: 'timeout', value: fallback }), RESPONSE_MS);
        work.then(
            (value) => finish({ state: 'fulfilled', value }),
            (err: unknown) => {
                onError(err);
                finish({ state: 'rejected' });
            },
        );
    });
}

function logStepFailure(applicationId: string, step: 'preparation' | 'dispatch', err: unknown): void {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(
        `[GitOps] ${step} failed for ${sanitizeForLog(applicationId)}:`,
        redactSensitiveText(detail),
    );
}

function logBlocked(applicationId: string, reason: string | null): void {
    console.warn(
        `[GitOps] dispatch blocked for ${sanitizeForLog(applicationId)}: ${sanitizeForLog(reason ?? 'unknown')}`,
    );
}

/**
 * Preparation's note. A step that is still running says so, and a step that
 * failed says that, so neither is ever reported as the other.
 *
 * A preparation that timed out is still running, so this says so even when the
 * dispatch then failed. Both are true at once: preparation carries on
 * preparing, and the rollout did not start. Nothing here cancels the other.
 */
function preparedNote(prepared: Timed<PreparedStep>): string | null {
    if (prepared.state === 'fulfilled') return prepared.value.note;
    if (prepared.state === 'timeout') return PREPARATION_CONTINUING_NOTE;
    return PREPARATION_FAILED_NOTE;
}

/**
 * The dispatch's note, for the accept note. A started rollout adds nothing, and
 * a skip that only repeats an unresolved artifact adds nothing once preparation
 * has named why. Every other outcome names itself, including a rejection: it
 * finished and failed, which is a different fact from progress.
 */
function handoffNote(prepared: Timed<PreparedStep>, handoff: Timed<GitManagedDispatchOutcome>): string | null {
    if (handoff.state === 'rejected') return ROLLOUT_FAILED_NOTE;
    if (handoff.state === 'timeout') return ROLLOUT_STARTING_NOTE;
    if (handoff.value.status === 'dispatched') return null;
    // Preparation that has not answered has not resolved the artifact either,
    // so the generic skip adds nothing beside its continuing or failed note.
    const artifact = prepared.state === 'fulfilled' ? prepared.value.artifact : ('none' as const);
    if (repeatsUnresolvedArtifact(artifact, handoff.value.reason)) return null;
    return handoff.value.reason;
}

/**
 * Authority note order is the result: dispatched, then a dispatch that failed
 * or was blocked, then preparation that failed, then work still running.
 * Anything else keeps the skipped reason.
 *
 * The accept note is built from the same two fragments as the authority note, so
 * the pull and the acceptance can never disagree about what happened. Where a
 * branch deliberately drops one of them, both drop it.
 */
function projectPostAccept(
    prepared: Timed<PreparedStep>,
    handoff: Timed<GitManagedDispatchOutcome>,
): Omit<BoundedPostAccept, 'pending'> {
    let rollout: BoundedRollout = 'not_started';
    let authorityNote: string | null;
    if (handoff.state === 'fulfilled' && handoff.value.status === 'dispatched') {
        rollout = 'started';
        authorityNote = null;
    } else if (handoff.state === 'rejected') {
        // Nothing is queued and nothing is running, so this is a hold on an
        // acceptance that did commit, not progress towards one. Preparation's
        // note joins when it has one of its own to report, which is what keeps
        // two failures from reading as one.
        rollout = 'held';
        authorityNote = joinAuthorityNotes([preparedNote(prepared), ROLLOUT_FAILED_NOTE]);
    } else if (handoff.state === 'fulfilled' && handoff.value.status === 'blocked') {
        // A blocked dispatch is never running, so its own reason is always the
        // note. Preparation's note joins it when preparation answered with one,
        // and is left out when preparation is still running or has failed,
        // because neither of those says anything about why this one was blocked.
        rollout = 'held';
        const blocked = handoff.value.reason ?? ROLLOUT_HELD_NOTE;
        authorityNote = prepared.state === 'fulfilled' && prepared.value.note !== null
            ? joinAuthorityNotes([prepared.value.note, blocked])
            : blocked;
    } else if (prepared.state === 'rejected') {
        authorityNote = PREPARATION_FAILED_NOTE;
    } else if (prepared.state === 'timeout') {
        authorityNote = PREPARATION_CONTINUING_NOTE;
    } else {
        // Only a skipped handoff remains here, and it keeps preparation's note
        // beside it unless it would just repeat the same unresolved artifact.
        const repeated = repeatsUnresolvedArtifact(prepared.value.artifact, handoff.value.reason)
            ? null
            : handoff.value.reason;
        authorityNote = joinAuthorityNotes([prepared.value.note, repeated]);
    }
    return {
        rollout,
        authorityNote,
        materialized: prepared.state === 'fulfilled' && prepared.value.materialized,
        artifactResolved: prepared.state === 'fulfilled' && prepared.value.artifact === 'resolved',
        dispatched: handoff.state === 'fulfilled' && handoff.value.status === 'dispatched',
        acceptNote: formatOperatorSentences([
            preparedNote(prepared),
            handoffNote(prepared, handoff),
        ]),
    };
}

/** Prepare, then hand off once that answer arrives, including when preparation is still running. */
export async function runBoundedGitManagedPostAccept(args: {
    applicationId: string;
    generationId: string;
    actor: string | null;
    trigger: ReconcileTrigger;
}): Promise<BoundedPostAccept> {
    const { applicationId, generationId, actor, trigger } = args;
    const prepareWork = prepareAcceptedGitManagedGeneration({
        applicationId,
        generationId,
        actor,
        trigger,
    });
    const prepared = await responseWithin(prepareWork, PREPARE_CONTINUING, (err) => {
        logStepFailure(applicationId, 'preparation', err);
    });
    if (prepared.state === 'fulfilled' && prepared.value.note) {
        console.warn(
            `[GitOps] preparation incomplete for ${sanitizeForLog(applicationId)}: ${sanitizeForLog(prepared.value.note)}`,
        );
    }
    const dispatchWork = dispatchPreparedGitManagedGeneration({
        applicationId,
        generationId,
        actor: actor ?? 'operator',
        trigger,
    });
    const handoff = await responseWithin(dispatchWork, DISPATCH_CONTINUING, (err) => {
        logStepFailure(applicationId, 'dispatch', err);
    });
    if (handoff.state === 'fulfilled' && handoff.value.status === 'blocked') {
        logBlocked(applicationId, handoff.value.reason);
    }
    const pending = prepared.state === 'timeout' || handoff.state === 'timeout'
        ? unfinishedFollow(applicationId, prepareWork, dispatchWork, handoff.state !== 'timeout')
        : null;
    return { ...projectPostAccept(prepared, handoff), pending };
}

/** The work that outlasted the deadline. A blocked dispatch that lands later is logged once. */
function unfinishedFollow(
    applicationId: string,
    prepareWork: Promise<PreparedStep>,
    dispatchWork: Promise<GitManagedDispatchOutcome>,
    handoffCompleted: boolean,
): Promise<void> {
    return Promise.allSettled([prepareWork, dispatchWork]).then((results) => {
        const dispatched = results[1];
        if (
            !handoffCompleted
            && dispatched.status === 'fulfilled'
            && dispatched.value.status === 'blocked'
        ) {
            logBlocked(applicationId, dispatched.value.reason);
        }
    });
}
