import type { GitOpsTargetCurrentRow } from './types';

/**
 * Whether a target row still claims a recovery failure.
 *
 * The standing claim is `failure_stage === 'recovery'`. A `failed` phase with
 * no stage is treated the same way: every writer sets both, so the combination
 * only exists on rows written before a later failure stage took over, and
 * reading it as a claim fails closed.
 */
export function targetClaimsRecoveryFailure(
  target: Pick<GitOpsTargetCurrentRow, 'recovery_phase' | 'failure_stage'>,
): boolean {
  return target.failure_stage === 'recovery'
    || (target.failure_stage === null && target.recovery_phase === 'failed');
}

/**
 * Whether the claimed recovery failure may have moved the target.
 *
 * `failure_class` is shared with deploy and withdraw failures, so it is only
 * read on a row that still claims a recovery failure. A `pre_mutation` claim
 * is a refusal that moved nothing: it stays visible on the target but owns no
 * hold, and it does not block a repair.
 */
export function targetRecoveryFailureMoved(
  target: Pick<GitOpsTargetCurrentRow, 'recovery_phase' | 'failure_stage' | 'failure_class'>,
): boolean {
  return targetClaimsRecoveryFailure(target) && target.failure_class !== 'pre_mutation';
}
