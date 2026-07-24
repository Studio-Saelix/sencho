/**
 * Helpers for clean one-shot completion and Compose restart-intent normalization.
 * Used by Health Gate and Drift service-presence only; does not change bulk
 * status, Auto-Heal, or atomic-deploy helpers.
 */

/**
 * True only for an explicit Compose `restart: "no"` (after normalization).
 * Absent / null / empty do not qualify: Docker reports HostConfig restart
 * "no" for both intentional one-shots and bare long-running services that
 * omit `restart:`, so consumers must pass declared Compose intent, not inspect.
 */
export function isNoRestartPolicy(policy: string | null | undefined): boolean {
  return policy === 'no';
}

/**
 * Normalize Compose restart intent for Drift / declared-model consumers.
 *
 * Compose precedence: when `deploy.restart_policy` is set, its `condition`
 * wins; otherwise the service-level `restart` field is used. Conditions map to
 * Docker-like policy names so {@link isNoRestartPolicy} stays the single gate:
 * `none` → `no`, `any` → `always`, `on-failure` → `on-failure`. Missing
 * condition defaults to `any` (Compose default). Unknown shapes fail closed.
 * Absent service restart (no deploy policy) stays null and is not one-shot eligible.
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
  /**
   * Declared Compose restart intent after normalization (`"no"` for explicit
   * one-shots / `deploy.restart_policy.condition: none`). Do not pass Docker
   * inspect HostConfig values here.
   */
  restartPolicy: string | null | undefined;
}

/**
 * True only for an exited container with exit code exactly 0 and explicit
 * declared restart `"no"`. Null/absent restart, null exit codes, and restarting
 * policies never qualify.
 */
export function isCleanOneShotCompletion(input: OneShotCompletionInput): boolean {
  return input.state === 'exited'
    && input.exitCode === 0
    && isNoRestartPolicy(input.restartPolicy);
}
