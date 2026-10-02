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

import type { GitOpsDriftItem, GitOpsRevisionProjection } from './types';

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
  | 'stateful_withdrawal_blocked'
  | 'rollout_authorization_pending'
  | 'rollout_authorization_stale'
  | 'preflight_blocked'
  | 'rollout_paused'
  | 'rollout_partial'
  | 'rollout_completion_unknown'
  | 'rollout_stale_acknowledgement'
  | 'rollback_failed'
  | 'target_stale'
  | 'target_unreachable'
  | 'recovery_required'
  | 'recovery_failed'
  | 'health_failed'
  | 'artifact_unqualified'
  | 'artifact_stale'
  | 'artifact_identity_changed'
  | 'drift'
  | 'repair_held';

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
  stateful_withdrawal_blocked: 'pending',
  rollout_authorization_pending: 'pending',
  rollout_authorization_stale: 'pending',
  preflight_blocked: 'pending',
  rollout_paused: 'pending',
  rollout_partial: 'failure',
  rollout_completion_unknown: 'failure',
  rollout_stale_acknowledgement: 'pending',
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
  repair_held: 'pending',
};

export function currentDrift(projection: GitOpsRevisionProjection): GitOpsDriftItem[] {
  if (projection.targetMode === 'not_applicable') return [];
  const currentNodeIds = new Set(
    projection.targets.filter(target => !target.tombstoned).map(target => target.nodeId),
  );
  return projection.drift.filter(item => (
    item.affectedTargets.length === 0
    || item.affectedTargets.some(target => target.nodeId === null || currentNodeIds.has(target.nodeId))
  ));
}

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
  const currentTargets = projection.targets.filter(target => !target.tombstoned);
  const { source, placement, rollout } = projection.facets;

  switch (source.status) {
    case 'source_failed':
      reasons.add('source_failed');
      break;
    case 'source_unknown':
      reasons.add('source_unknown_outcome');
      break;
    case 'source_review_pending':
      // One reason, not both: when an automatic acceptance refused for safety
      // the specific block is the actionable fact, and the queue must not spend
      // two codes on one waiting decision.
      reasons.add(
        source.reviewBlockReason === 'stateful_withdrawal'
          ? 'stateful_withdrawal_blocked'
          : 'source_review_pending',
      );
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

  for (const target of currentTargets) {
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
      // A node that acknowledged something the application has since left.
      // Its own reason rather than `rollout_completion_unknown`, because the
      // operator action is the opposite: not "find out what happened", but
      // "roll the newer intent out here". Pending tone, since the newer rollout
      // resolves it and nothing has gone wrong.
      case 'stale_acknowledgement':
        reasons.add('rollout_stale_acknowledgement');
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
      // A held repair is drift Sencho has declined to fix. It is its own reason
      // because the operator action differs from every other drift: a rollout or
      // an explicit deployment has to resolve it. A tick keeps re-checking, so
      // most holds clear on their own once the cause does, but a hold whose
      // cause is a superseded rollout will not, because superseding is one-way.
      case 'repair_held':
        reasons.add('repair_held');
        break;
      default:
        break;
    }
    // Work already under way on the generation this failure is about is
    // producing the verdict that will replace it, so the target reads as work in
    // progress rather than as a failure waiting on an operator. The facet still
    // reports `failed`, which stays true: the last verdict really did fail, and
    // its promotion really was withdrawn. Nothing is added in place of the
    // reason, because any reason at all would read as `attention` rather than
    // `in_progress`, and progress is the honest answer while a redeploy runs.
    //
    // Read as `=== true`, never as a bare negation: a target that reached this
    // hub from an older remote instance does not carry the flag at all, and the
    // failure on that target has to keep being reported. The remote boundary
    // accepts only `undefined` or a boolean, so the two reads agree there, and
    // the strict form is what makes that the rule rather than a coincidence.
    if (target.health.status === 'failed' && target.healthFailureSuperseded !== true) {
      reasons.add('health_failed');
    }
  }

  // Confirmed drift is itself a reason. The classes (source, runtime, placement,
  // and so on) ride on the row's drift summary; a bare `drift` here is the
  // triage signal and the classes answer "drifted where".
  if (currentDrift(projection).length > 0) reasons.add('drift');

  return [...reasons];
}

/** Whether any reason carries failure tone. */
export function hasFailureReason(reasons: readonly GitOpsAttentionReason[]): boolean {
  return reasons.some(reason => ATTENTION_TONE[reason] === 'failure');
}
