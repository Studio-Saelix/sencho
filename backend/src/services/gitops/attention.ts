/**
 * Attention classification for the GitOps portfolio workplace.
 *
 * This is the one place raw canonical facets become "this application needs an
 * operator". The mapping is server-owned on purpose: a page that re-derived
 * attention from facets would grow its own status engine and could disagree
 * with the projection by the time an operator acts on it. Consumers render the
 * returned codes; they never classify.
 *
 * Unknown facet statuses productively cannot happen here. `unknown` on a status
 * type means "the producer could not prove a state", which one of the codes
 * below already covers (`completion_unknown`, unreachable targets, unknown
 * health); a status this build has never seen, which can only arrive when a
 * newer node answered an older hub, is unknown *to this classifier* and is
 * reported by the caller as unknown evidence, not as attention.
 */

import type { GitOpsRevisionProjection } from './types';

/**
 * Every reason an application may need an operator, as a closed union.
 *
 * Each code answers "what is waiting", not "what is broken", so the workplace
 * can route it to the surface that owns the decision (source review, placement
 * approval, rollout authorization, recovery). Order of declaration is not
 * semantics; the tone table below is.
 */
export type GitOpsAttentionReason =
  | 'source_failed'
  | 'source_unknown_outcome'
  | 'source_review_pending'
  | 'source_conflict_blocker'
  | 'source_reconcile_required'
  | 'source_retry_scheduled'
  | 'source_suspended'
  | 'deploy_failed'
  | 'placement_review_pending'
  | 'stateful_confirmation_required'
  | 'rollout_authorization_pending'
  | 'rollout_authorization_stale'
  | 'preflight_blocked'
  | 'rollout_paused'
  | 'rollout_partial'
  | 'rollout_completion_unknown'
  | 'rollback_failed'
  | 'target_stale'
  | 'target_unreachable'
  | 'recovery_required'
  | 'recovery_failed'
  | 'health_failed'
  | 'artifact_unqualified'
  | 'artifact_stale'
  | 'artifact_identity_changed'
  | 'drift';

/**
 * How loudly a reason should present.
 *
 * `failure` maps to the destructive/rose lane; `pending` to the warning lane.
 * A failure is evidence that attempted work went wrong. A pending reason is a
 * decision or retry that has not happened yet, which is exactly what an
 * attention queue exists to surface, but it does not read as damage.
 */
export const ATTENTION_TONE: Readonly<Record<GitOpsAttentionReason, 'failure' | 'pending'>> = {
  source_failed: 'failure',
  source_unknown_outcome: 'failure',
  source_review_pending: 'pending',
  source_conflict_blocker: 'pending',
  source_reconcile_required: 'pending',
  source_retry_scheduled: 'pending',
  source_suspended: 'pending',
  deploy_failed: 'failure',
  placement_review_pending: 'pending',
  stateful_confirmation_required: 'pending',
  rollout_authorization_pending: 'pending',
  rollout_authorization_stale: 'pending',
  preflight_blocked: 'pending',
  rollout_paused: 'pending',
  rollout_partial: 'failure',
  rollout_completion_unknown: 'failure',
  rollback_failed: 'failure',
  target_stale: 'pending',
  target_unreachable: 'failure',
  recovery_required: 'pending',
  recovery_failed: 'failure',
  health_failed: 'failure',
  artifact_unqualified: 'pending',
  artifact_stale: 'pending',
  artifact_identity_changed: 'pending',
  drift: 'pending',
};

/**
 * The attention reasons a projection currently implies.
 *
 * Reads `projectApplication` output, including the per-target runtime and
 * health facets. Deduplication is inherent (reasons are a set of codes; two
 * unreachable targets still read as one "a target is unreachable" with the
 * detail living on the row's target evidence).
 */
export function attentionReasons(projection: GitOpsRevisionProjection): GitOpsAttentionReason[] {
  if (projection.targetMode === 'not_applicable') return [];
  const reasons = new Set<GitOpsAttentionReason>();
  const { source, placement, rollout } = projection.facets;

  switch (source.status) {
    case 'source_failed':
      reasons.add('source_failed');
      break;
    case 'source_unknown':
      reasons.add('source_unknown_outcome');
      break;
    case 'source_review_pending':
      reasons.add('source_review_pending');
      break;
    case 'source_conflict_blocker':
      reasons.add('source_conflict_blocker');
      break;
    case 'source_reconcile_required':
      reasons.add('source_reconcile_required');
      break;
    case 'source_retry_scheduled':
      reasons.add('source_retry_scheduled');
      break;
    case 'source_suspended':
      reasons.add('source_suspended');
      break;
    case 'recovery_required':
      reasons.add('recovery_required');
      break;
    case 'recovery_failed':
      reasons.add('recovery_failed');
      break;
    default:
      break;
  }

  switch (placement.status) {
    case 'placement_review_pending':
      reasons.add('placement_review_pending');
      break;
    case 'stateful_confirmation_required':
      reasons.add('stateful_confirmation_required');
      break;
    case 'rollout_authorization_pending':
      reasons.add('rollout_authorization_pending');
      break;
    case 'rollout_authorization_stale':
      reasons.add('rollout_authorization_stale');
      break;
    case 'preflight_blocked':
      reasons.add('preflight_blocked');
      break;
    default:
      break;
  }

  switch (rollout.status) {
    case 'rollout_paused':
      reasons.add('rollout_paused');
      break;
    case 'partially_rolled_out':
      reasons.add('rollout_partial');
      break;
    case 'completion_unknown':
      reasons.add('rollout_completion_unknown');
      break;
    case 'rollback_partial_failed':
      reasons.add('rollback_failed');
      break;
    case 'target_stale':
      reasons.add('target_stale');
      break;
    case 'target_unreachable':
      reasons.add('target_unreachable');
      break;
    case 'recovery_required':
      reasons.add('recovery_required');
      break;
    default:
      break;
  }

  const artifact = projection.facets.artifact;
  switch (artifact.status) {
    case 'artifact_unresolved':
    case 'artifact_unavailable':
    case 'artifact_local_build_unverified':
      reasons.add('artifact_unqualified');
      break;
    case 'artifact_stale':
      reasons.add('artifact_stale');
      break;
    case 'artifact_identity_changed':
      reasons.add('artifact_identity_changed');
      break;
    default:
      break;
  }

  for (const target of projection.targets) {
    if (target.connectivity === 'unreachable') reasons.add('target_unreachable');
    if (target.connectivity === 'stale') reasons.add('target_stale');
    switch (target.runtime.status) {
      case 'failed_after_mutation':
      case 'failed_previous_workload_intact':
        reasons.add('deploy_failed');
        break;
      case 'completion_unknown':
      case 'acknowledged_completion_unknown':
        reasons.add('rollout_completion_unknown');
        break;
      case 'retry_scheduled':
        reasons.add('source_retry_scheduled');
        break;
      case 'pending_state_review':
        reasons.add('stateful_confirmation_required');
        break;
      case 'recovery_required':
        reasons.add('recovery_required');
        break;
      case 'recovery_failed':
        reasons.add('recovery_failed');
        break;
      default:
        break;
    }
    if (target.health.status === 'failed') reasons.add('health_failed');
  }

  // Confirmed drift is itself a reason. The classes (source, runtime, placement,
  // and so on) ride on the row's drift summary; a bare `drift` here is the
  // triage signal and the classes answer "drifted where".
  if (projection.drift.length > 0) reasons.add('drift');

  return [...reasons];
}

/** Whether any reason carries failure tone. */
export function hasFailureReason(reasons: readonly GitOpsAttentionReason[]): boolean {
  return reasons.some(reason => ATTENTION_TONE[reason] === 'failure');
}
