import type { GitOpsTargetCurrentRow } from './types';

/** The columns any recovery-claim decision is allowed to read. */
type RecoveryClaimRow = Pick<
  GitOpsTargetCurrentRow,
  'recovery_phase' | 'recovery_failure_class' | 'recovery_failure_at'
>;

/**
 * Whether a restore is still moving on this row.
 *
 * An in-flight restore owns the row's recovery slot. Nothing retires it and no
 * hold on automated work is released while it runs. Rollbacks are serialized
 * per target (`rollbackInProgress` refuses one that is already moving), so this
 * is what stops a second restore from taking the slot over mid-write.
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
 * The claim has its own column because `failure_class` is shared with deploy and
 * withdraw failures: a failure that arrives afterwards records itself in that
 * shared slot, and reading it here would make a moved claim look like a refusal
 * that moved nothing. Every writer that records a recovery failure sets this
 * alongside the phase.
 */
export function recoveryFailureClaimClass(target: RecoveryClaimRow): string | null {
  return target.recovery_failure_class;
}

/** When the claimed recovery failure happened, or null when it claims none. */
export function recoveryFailureClaimAt(target: RecoveryClaimRow): number | null {
  return target.recovery_failure_at;
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
