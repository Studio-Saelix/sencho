import type { GitOpsTargetCurrentRow } from './types';

/** The columns any recovery-claim decision is allowed to read. */
type RecoveryClaimRow = Pick<
  GitOpsTargetCurrentRow,
  'recovery_phase' | 'recovery_failure_class' | 'failure_stage' | 'failure_class'
>;

/**
 * Whether a restore is still moving on this row.
 *
 * An in-flight restore owns the row's recovery slot. It is not a claim about the
 * target's consistency, so nothing retires it, and no hold on automated work is
 * released while it runs: a retry opens `restoring` over the row a refusal left
 * behind, and a deploy or acknowledgement that lands in that window must not read
 * the older claim as the whole story.
 */
export function targetRestoreInFlight(target: Pick<GitOpsTargetCurrentRow, 'recovery_phase'>): boolean {
  return target.recovery_phase === 'capturing'
    || target.recovery_phase === 'restoring'
    || target.recovery_phase === 'compensating';
}

/**
 * The class of the recovery failure this row still claims, or null when it
 * claims none.
 *
 * Read from the claim's own column, because a failure that arrived afterwards
 * takes the shared `failure_class` slot and would otherwise make a moved claim
 * read as a refusal that moved nothing. Rows written before the column existed
 * are resolved from the shared slot, which is still the claim's own class while
 * the failure stage is `recovery`.
 */
export function recoveryFailureClaimClass(target: RecoveryClaimRow): string | null {
  if (target.recovery_failure_class !== null) return target.recovery_failure_class;
  if (target.recovery_phase === 'failed') {
    // A row written before the claim had its own column kept the class in the
    // shared slot while its stage was still `recovery`. Any other failed phase
    // with no class is unprovable, and an unprovable claim is read as one that
    // may have moved the target rather than released, so an upgraded install
    // never drops a hold it cannot rule out.
    return target.failure_stage === 'recovery' && target.failure_class !== null
      ? target.failure_class
      : 'unknown';
  }
  return null;
}

/**
 * Whether the row claims a recovery failure that may have moved the target.
 *
 * The strongest claim a row can carry, so this is the one that holds the
 * application and blocks an automatic repair. In flight counts: work that is
 * still moving has not proven anything yet, and the target's files are not
 * known to be the ones the applied generation describes.
 */
export function targetRecoveryFailureMoved(target: RecoveryClaimRow): boolean {
  if (targetRestoreInFlight(target)) return true;
  const failureClass = recoveryFailureClaimClass(target);
  return failureClass !== null && failureClass !== 'pre_mutation';
}

/**
 * Whether the row already carries a recorded claim that may have moved it.
 *
 * Class-based, unlike `targetRecoveryFailureMoved`: an in-flight restore is not
 * an earlier claim to defer to. This is the check a refusal makes before it
 * decides whether it is allowed to write its own class over the row.
 */
export function recoveryClaimMoved(target: RecoveryClaimRow): boolean {
  const failureClass = recoveryFailureClaimClass(target);
  return failureClass !== null && failureClass !== 'pre_mutation';
}

/**
 * Whether the claim is one a newer outcome may retire.
 *
 * Only a claim that moved nothing qualifies. Retiring a moved claim needs
 * evidence the target is consistent again, and a failure is not that evidence;
 * an acknowledgement or a bind is. In flight is never retirable.
 */
export function recoveryClaimRetirable(target: RecoveryClaimRow): boolean {
  if (targetRestoreInFlight(target)) return false;
  return recoveryFailureClaimClass(target) === 'pre_mutation';
}
