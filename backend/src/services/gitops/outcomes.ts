import type { SourceFacet } from './types';

/**
 * Normalized reconcile outcomes. Silence is not an acceptable GitOps
 * result: every attempt settles into exactly one of these, never a bare
 * success/failure boolean.
 *
 * `converged` is deliberately never produced by outcomeFromSourceFacet: it
 * requires target and health evidence this source-only projection does not
 * have, and "no source change" is not proof of full convergence. A later
 * composition over source + target + health facets is what may report it.
 */
export type ReconcileOutcome =
  | 'converged'
  | 'no_source_change'
  | 'candidate_already_fetched'
  | 'pending_review'
  | 'suspended'
  | 'retry_scheduled'
  | 'blocked'
  | 'superseded'
  | 'failed_previous_intact'
  | 'recovery_required'
  | 'unknown';

export type NextAction =
  | 'none'
  | 'review'
  | 'resume'
  | 'retry'
  | 'resolve_conflict'
  | 'configure_credentials'
  | 'view_target_results';

export type ReconcileResult = {
  outcome: ReconcileOutcome;
  reason: string;
  nextAction: NextAction;
  retryAt?: number;
  commitSha?: string;
};

/** Every ReconcileOutcome member, for runtime validation of a value read back from storage. */
const RECONCILE_OUTCOMES: ReadonlySet<string> = new Set<ReconcileOutcome>([
  'converged',
  'no_source_change',
  'candidate_already_fetched',
  'pending_review',
  'suspended',
  'retry_scheduled',
  'blocked',
  'superseded',
  'failed_previous_intact',
  'recovery_required',
  'unknown',
]);

/** Every NextAction member, for runtime validation of a value read back from storage. */
const NEXT_ACTIONS: ReadonlySet<string> = new Set<NextAction>([
  'none',
  'review',
  'resume',
  'retry',
  'resolve_conflict',
  'configure_credentials',
  'view_target_results',
]);

export function isReconcileOutcome(value: unknown): value is ReconcileOutcome {
  return typeof value === 'string' && RECONCILE_OUTCOMES.has(value);
}

export function isNextAction(value: unknown): value is NextAction {
  return typeof value === 'string' && NEXT_ACTIONS.has(value);
}

function commitShaOf(facet: Extract<SourceFacet, { desiredCommitSha: unknown }>): string | undefined {
  return facet.desiredCommitSha ?? facet.fetchedCommitSha ?? undefined;
}

/**
 * Derive the normalized outcome of a settled source reconcile attempt from
 * the existing source-facet projection, rather than re-deriving status from
 * raw application-row fields. Keeps the outcome vocabulary and the
 * projection's own status vocabulary from silently drifting apart.
 */
export function outcomeFromSourceFacet(facet: SourceFacet): ReconcileResult {
  switch (facet.status) {
    case 'not_applicable':
      return { outcome: 'unknown', reason: 'No GitOps application exists for this stack.', nextAction: 'none' };

    case 'never_reconciled':
      return { outcome: 'unknown', reason: 'The source has never been reconciled.', nextAction: 'none' };

    case 'checking_fetching':
    case 'applying':
      return {
        outcome: 'unknown',
        reason: 'A reconcile operation is currently in flight; no settled result yet.',
        nextAction: 'none',
        commitSha: commitShaOf(facet),
      };

    case 'source_reconcile_required':
      return {
        outcome: 'unknown',
        reason: 'The source has advanced but reconciliation has not evaluated it yet.',
        nextAction: 'none',
        commitSha: commitShaOf(facet),
      };

    case 'application_generation_accepted':
      return {
        outcome: 'no_source_change',
        reason: 'The configured ref still resolves to the accepted generation. This is not proof of full convergence.',
        nextAction: 'none',
        commitSha: commitShaOf(facet),
      };

    case 'candidate_ready':
      return {
        outcome: 'candidate_already_fetched',
        reason: 'A candidate generation is already staged and awaiting acceptance.',
        nextAction: 'none',
        commitSha: commitShaOf(facet),
      };

    case 'source_review_pending':
      return {
        outcome: 'pending_review',
        reason: 'A candidate is staged and requires explicit review before acceptance.',
        nextAction: 'review',
        commitSha: commitShaOf(facet),
      };

    case 'source_conflict_blocker':
      return {
        outcome: 'blocked',
        reason: 'A local conflict is blocking the candidate from being accepted.',
        nextAction: 'resolve_conflict',
        commitSha: commitShaOf(facet),
      };

    case 'source_superseded':
      return {
        outcome: 'superseded',
        reason: 'A newer revision superseded this candidate before it was accepted.',
        nextAction: 'none',
        commitSha: commitShaOf(facet),
      };

    case 'source_retry_scheduled':
      return {
        outcome: 'retry_scheduled',
        reason: `A previous attempt failed transiently; retry ${facet.retryCount + 1} is scheduled.`,
        nextAction: 'none',
        retryAt: facet.retryAt,
        commitSha: commitShaOf(facet),
      };

    case 'source_suspended':
      return {
        outcome: 'suspended',
        reason: facet.suspendedReason
          ? `Reconciliation is suspended: ${facet.suspendedReason}`
          : 'Reconciliation is suspended.',
        nextAction: 'resume',
        commitSha: commitShaOf(facet),
      };

    case 'source_failed':
      return {
        outcome: 'failed_previous_intact',
        reason: `The ${facet.failureStage} stage failed (${facet.failureClass}). The previously accepted generation is unchanged.`,
        nextAction: facet.retryAt !== null ? 'retry' : 'configure_credentials',
        retryAt: facet.retryAt ?? undefined,
        commitSha: commitShaOf(facet),
      };

    case 'source_unknown':
      return {
        outcome: 'recovery_required',
        reason: `An operation was interrupted at ${facet.interruptedStage} and its outcome is unproven.`,
        nextAction: 'view_target_results',
        commitSha: commitShaOf(facet),
      };

    case 'recovery_required':
      return {
        outcome: 'recovery_required',
        reason: 'Recovery from an earlier failed mutation is still outstanding.',
        nextAction: 'view_target_results',
        commitSha: commitShaOf(facet),
      };

    case 'recovery_failed':
      return {
        outcome: 'recovery_required',
        reason: `Recovery itself failed (${facet.failureClass}); this needs operator attention.`,
        nextAction: 'view_target_results',
        commitSha: commitShaOf(facet),
      };

    case 'not_live':
      return {
        outcome: 'unknown',
        reason: `The application is ${facet.lifecycleStatus}, not live; there is nothing to reconcile.`,
        nextAction: 'none',
      };
  }
}
