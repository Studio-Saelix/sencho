import type { GitOpsTargetCurrentRow } from './types';

/**
 * Whether a target row still claims a recovery failure.
 *
 * The standing claim is `failure_stage === 'recovery'`. A `failed` phase with
 * no stage is treated the same way: every writer sets both, except a
 * withdrawal, which clears the stage and leaves the phase as tombstone
 * residue. A revived placement clears that residue when the target is placed
 * again, so the combination is read as a claim only until then, failing
 * closed rather than releasing a recovery nobody has explained.
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
