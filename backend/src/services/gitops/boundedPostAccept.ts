/**
 * One bounded follow-up after a Git-managed acceptance has committed.
 *
 * Accept source and an operator pull both prepare the accepted generation,
 * then hand it off once that answer arrives, including when preparation is
 * still running. Each step has its own 15 second bound. `pending` is the work
 * still running after the answer. The operator pull holds it until it settles,
 * so a deadline does not release the in-flight slot. Accept source does not
 * hold a slot.
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

interface PreparedStep {
    materialized: boolean;
    artifact: GitManagedFreezeStatus;
    note: string | null;
}

interface Timed<T> {
    value: T;
    completed: boolean;
}

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
 * A skipped handoff that only repeats an unresolved artifact adds nothing
 * once preparation already named why. Any other handoff reason stays.
 */
function skippedAuthorityNote(prepared: PreparedStep, reason: string | null): string | null {
    const alreadyNamed = prepared.note !== null && repeatsUnresolvedArtifact(prepared.artifact, reason);
    return joinAuthorityNotes([prepared.note, alreadyNamed ? null : reason]);
}

/** A started rollout has no extra sentence. The generic unresolved-artifact skip is left off the accept note. */
function handoffReasonForAccept(prepared: PreparedStep, handoff: GitManagedDispatchOutcome): string | null {
    if (handoff.status === 'dispatched') return null;
    if (repeatsUnresolvedArtifact(prepared.artifact, handoff.reason)) return null;
    return handoff.reason;
}

/**
 * Answer with `fallback` if `work` is still running at the deadline.
 * The deadline does not cancel that work. A rejection before the deadline
 * counts as finished, so the slot does not wait on it. A rejection after
 * the deadline is still logged.
 */
function responseWithin<T>(
    work: Promise<T>,
    fallback: T,
    onError: (err: unknown) => void,
): Promise<Timed<T>> {
    return new Promise((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout>;
        function finish(value: T, completed: boolean): void {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ value, completed });
        }
        timer = setTimeout(() => finish(fallback, false), RESPONSE_MS);
        work.then(
            (value) => finish(value, true),
            (err: unknown) => {
                onError(err);
                finish(fallback, true);
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
 * Authority note order is the result: dispatched, then blocked, then preparation
 * still running, then dispatch still running. Anything else keeps the skipped note.
 */
function projectPostAccept(
    prepared: Timed<PreparedStep>,
    handoff: Timed<GitManagedDispatchOutcome>,
): Omit<BoundedPostAccept, 'pending'> {
    let rollout: BoundedRollout = 'not_started';
    let authorityNote: string | null = skippedAuthorityNote(prepared.value, handoff.value.reason);
    if (handoff.completed && handoff.value.status === 'dispatched') {
        rollout = 'started';
        authorityNote = null;
    } else if (handoff.completed && handoff.value.status === 'blocked') {
        rollout = 'held';
        const held = handoff.value.reason ?? ROLLOUT_HELD_NOTE;
        authorityNote = prepared.completed ? joinAuthorityNotes([prepared.value.note, held]) : held;
    } else if (!prepared.completed) {
        authorityNote = PREPARATION_CONTINUING_NOTE;
    } else if (!handoff.completed) {
        authorityNote = joinAuthorityNotes([prepared.value.note, ROLLOUT_STARTING_NOTE]);
    }
    return {
        rollout,
        authorityNote,
        materialized: prepared.value.materialized,
        artifactResolved: prepared.value.artifact === 'resolved',
        dispatched: handoff.value.status === 'dispatched',
        acceptNote: formatOperatorSentences([
            prepared.value.note,
            handoffReasonForAccept(prepared.value, handoff.value),
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
    if (prepared.completed && prepared.value.note) {
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
    if (handoff.completed && handoff.value.status === 'blocked') {
        logBlocked(applicationId, handoff.value.reason);
    }
    const pending = prepared.completed && handoff.completed
        ? null
        : unfinishedFollow(applicationId, prepareWork, dispatchWork, handoff.completed);
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
