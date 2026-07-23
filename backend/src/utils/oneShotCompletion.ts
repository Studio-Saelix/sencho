/**
 * Shared predicate for Compose one-shot / init / migration services that are
 * expected to finish and stay down. Used by Health Gate and Drift service-presence
 * only; does not change bulk status, Auto-Heal, or atomic-deploy helpers.
 */

export function isNoRestartPolicy(policy: string | null | undefined): boolean {
  return policy == null || policy === '' || policy === 'no';
}

export interface OneShotCompletionInput {
  state: string;
  /** Exact Docker exit code; null means unknown (fail closed). */
  exitCode: number | null;
  /** Restart policy name (inspect HostConfig or effective Compose restart). */
  restartPolicy: string | null | undefined;
}

/**
 * True only for an exited container with exit code exactly 0 and restart policy
 * no/absent. Null exit codes and restarting policies never qualify.
 */
export function isCleanOneShotCompletion(input: OneShotCompletionInput): boolean {
  return input.state === 'exited'
    && input.exitCode === 0
    && isNoRestartPolicy(input.restartPolicy);
}
