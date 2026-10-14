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
 * request whose destination moved while it was waiting. A cadence carries no
 * claim to check, so the poll and the reconciler's re-drive are not boundaries
 * here, and the hold below is what keeps them from undoing a refusal.
 *
 * A refusal after the acceptance has committed is held rather than answered,
 * because the reconciler re-drives any accepted generation with nothing to
 * check it against. See `driftHoldReason`.
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
 * wait for a person. It is a hold reason rather than a note because the refusal
 * has to outlast this request. The reconciler re-drives any accepted generation
 * with no confirmation to check, so a refusal that wrote no durable row would be
 * undone by the next tick and the operator would be told to review a change that
 * then deployed on its own.
 */
export function driftHoldReason(drift: ConfirmationDrift): string {
    return drift === 'placement_changed'
        ? 'The approved placement changed after this was confirmed; review the current placement, then resume the rollout'
        : 'Rollout authorization started authorizing without an operator after this was confirmed; review it, then resume the rollout';
}
