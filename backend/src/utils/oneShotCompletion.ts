/**
 * Helpers for clean one-shot completion and Compose restart-intent normalization.
 * Used by Health Gate and Drift service-presence only; does not change bulk
 * status, Auto-Heal, or atomic-deploy helpers.
 */

export function isNoRestartPolicy(policy: string | null | undefined): boolean {
  return policy == null || policy === '' || policy === 'no';
}

/**
 * Normalize Compose restart intent for Drift / declared-model consumers.
 *
 * Compose precedence: when `deploy.restart_policy` is set, its `condition`
 * wins; otherwise the service-level `restart` field is used. Conditions map to
 * Docker-like policy names so {@link isNoRestartPolicy} stays the single gate:
 * `none` → `no`, `any` → `always`, `on-failure` → `on-failure`. Missing
 * condition defaults to `any` (Compose default). Unknown shapes fail closed.
 */
export function normalizeComposeRestartIntent(
  serviceRestart: string | null | undefined,
  deploy?: Record<string, unknown> | null,
): string | null {
  if (deploy && Object.prototype.hasOwnProperty.call(deploy, 'restart_policy')) {
    const policy = deploy['restart_policy'];
    if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
      return 'always';
    }
    const condition = (policy as Record<string, unknown>).condition;
    // Missing, empty, or non-string → Compose default `any` → always.
    if (typeof condition !== 'string' || condition === '') {
      return 'always';
    }
    switch (condition.toLowerCase()) {
      case 'none':
        return 'no';
      case 'on-failure':
        return 'on-failure';
      case 'any':
        return 'always';
      default:
        return 'always';
    }
  }
  if (serviceRestart == null || serviceRestart === '') return null;
  return serviceRestart;
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
