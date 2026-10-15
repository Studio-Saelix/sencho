/**
 * The reviewed placement and rollout consequence a consequential source action
 * carries.
 *
 * Pull source and Accept source can record a commit and start a rollout from
 * it. A confirmation that names a destination only binds the request that sends
 * it: a body with nothing in it is answered by whatever the placement and the
 * policy happen to say when execution reads them, which is how a dialog naming
 * one node's approval ends up deploying to another.
 *
 * So both bodies echo the two facts the dialogs read, and every consequential
 * boundary recomputes them from the live row:
 *
 *   - `placementApprovalRef` is the identity of the placement approval, the
 *     same pointer `store.authorizationIngredients` resolves the rollout scope
 *     from, so the request and the authorization model name one thing.
 *   - `rolloutMayStart` is the promise itself rather than the policy value
 *     behind it. The dialogs say "this can start a rollout" or "this stays
 *     waiting for you", and that sentence is the contract.
 *
 * The check runs at every consequential boundary an operator action reaches,
 * rather than only at the route, because each is preceded by asynchronous work:
 * a fetch and a preparation both take time another session can spend approving a
 * placement or arming a rollout policy. A check at entry alone would pass a
 * request whose destination moved while it was waiting. The acceptance stores
 * the whole claim, and unattended authorization reads that record, so a restart
 * or a later re-drive still has it. A poll that carries no confirmation stores
 * none, and the configured policy governs that acceptance.
 *
 * A refusal after the acceptance has committed is held rather than answered.
 * See `driftHoldReason`.
 */
import { isRecord } from './json';
import type { GitOpsApplicationRow } from './types';

/** The code a stale confirmation is refused with. */
export const CONFIRMATION_STALE = 'CONFIRMATION_STALE';

/** The reviewed authority state one source action was confirmed against. */
export interface SourceConfirmation {
    /** The placement approval the confirmation named; null when it named none. */
    placementApprovalRef: string | null;
    /** Whether the confirmation told the operator a rollout could start from it. */
    rolloutMayStart: boolean;
}

/** Which of the two reviewed facts no longer holds. */
export type ConfirmationDrift = 'placement_changed' | 'rollout_authorization_widened';

function isApprovalRef(value: unknown): value is string | null {
    return value === null || (typeof value === 'string' && value.length > 0);
}

/**
 * Read the confirmation out of a request body.
 *
 * Strict about shape and closed about the claim: a value this build cannot read
 * is refused rather than defaulted, because a defaulted claim would be compared
 * against live state as though the operator had promised it.
 */
export function parseSourceConfirmation(raw: unknown): { ok: true; confirmation: SourceConfirmation } | { ok: false; error: string } {
    if (!isRecord(raw)) return { ok: false, error: 'confirmation is required' };
    if (typeof raw.rolloutMayStart !== 'boolean') return { ok: false, error: 'confirmation.rolloutMayStart must be a boolean' };
    if (!isApprovalRef(raw.placementApprovalRef)) return { ok: false, error: 'confirmation.placementApprovalRef must be an approval id' };
    return {
        ok: true,
        confirmation: { placementApprovalRef: raw.placementApprovalRef, rolloutMayStart: raw.rolloutMayStart },
    };
}

/**
 * Which reviewed fact no longer matches the live row, or null when both still do.
 *
 * The destination is compared exactly. The dialog named specific nodes, so a
 * different approval is a different destination whether it is a superset, a
 * subset, or nothing at all, and the operator has to look again.
 *
 * The rollout consequence is compared one way. A confirmation that promised a
 * rollout may start and finds the policy waiting for an operator does strictly
 * less than it said, and the dispatch gate reports that in its own words. The
 * reverse starts something the operator was told would wait, which is refused.
 */
export function sourceConfirmationDrift(
    app: GitOpsApplicationRow,
    confirmation: SourceConfirmation,
): ConfirmationDrift | null {
    if (app.placement_approval_ref !== confirmation.placementApprovalRef) return 'placement_changed';
    if (!confirmation.rolloutMayStart && app.rollout_authorization_policy === 'automatic') {
        return 'rollout_authorization_widened';
    }
    return null;
}

/**
 * What the operator is told when the refusal lands before anything committed.
 * The acceptance is still available, so the remedy is to look again and confirm.
 */
export function driftSentence(drift: ConfirmationDrift): string {
    return drift === 'placement_changed'
        ? 'The approved placement changed since you reviewed it; review the current approval and confirm again.'
        : 'Rollout authorization now authorizes without an operator, so this could start a rollout; review it and confirm again.';
}

/**
 * The reason recorded when the refusal lands after the acceptance committed.
 *
 * There is nothing left to confirm: the commit stands, and the rollout has to
 * wait for a person. It is a hold reason rather than a note because the
 * refusal has to outlast this request. The re-drive reads the stored claim, so
 * it will not mint, but without this pause the rollout stays queued with no
 * reason on the row.
 */
export function driftHoldReason(drift: ConfirmationDrift): string {
    return drift === 'placement_changed'
        ? 'The approved placement changed after this was confirmed; review the current placement, then resume the rollout'
        : 'Rollout authorization started authorizing without an operator after this was confirmed; review it, then resume the rollout';
}

/** A stored confirmation that cannot be read. Unattended authorization holds rather than guessing. */
export const UNREADABLE_SOURCE_CONFIRMATION =
    'The confirmation recorded with this commit could not be read; review it, then resume the rollout';

/** What a source-acceptance row recorded about the operator's confirmation. */
export type StoredSourceConfirmation =
    | { status: 'absent' }
    | { status: 'present'; confirmation: SourceConfirmation }
    | { status: 'unreadable' };

/** Persist a confirmation. A null placement stays inside the object, distinct from a missing one. */
export function encodeSourceConfirmation(confirmation: SourceConfirmation): string {
    return JSON.stringify({
        placementApprovalRef: confirmation.placementApprovalRef,
        rolloutMayStart: confirmation.rolloutMayStart,
    });
}

/**
 * Read a stored confirmation.
 *
 * Null and empty are absence: the acceptance was not confirmed. A present
 * object may still name a null placement. Anything else is unreadable, which
 * the caller holds rather than treating as permission to roll out.
 */
export function decodeSourceConfirmation(raw: string | null | undefined): StoredSourceConfirmation {
    if (raw == null || raw === '') return { status: 'absent' };
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { status: 'unreadable' };
    }
    if (!isRecord(parsed) || typeof parsed.rolloutMayStart !== 'boolean' || !isApprovalRef(parsed.placementApprovalRef)) {
        return { status: 'unreadable' };
    }
    return {
        status: 'present',
        confirmation: {
            placementApprovalRef: parsed.placementApprovalRef,
            rolloutMayStart: parsed.rolloutMayStart,
        },
    };
}
