/**
 * Structural healthcheck presence classification for Compose YAML objects and
 * Docker inspect `Config.Healthcheck.Test` arrays. Returns enums/booleans only;
 * never retains or returns Test command text (commands can carry secrets).
 */

export type ComposeHealthcheckClass = 'active' | 'disabled' | 'absent';

/**
 * Classify a Compose `healthcheck:` value from the rendered effective model.
 * `disable: true` and `test: NONE` / `["NONE"]` are explicit disablement, not
 * an active healthcheck.
 */
export function classifyComposeHealthcheck(healthcheck: unknown): ComposeHealthcheckClass {
  if (healthcheck == null) return 'absent';
  if (typeof healthcheck !== 'object' || Array.isArray(healthcheck)) return 'absent';
  const hc = healthcheck as Record<string, unknown>;
  if (hc.disable === true) return 'disabled';
  if (isNoneTest(hc.test)) return 'disabled';
  return 'active';
}

/** True when the Compose healthcheck is an active (non-disabled) declaration. */
export function isComposeHealthcheckActive(healthcheck: unknown): boolean {
  return classifyComposeHealthcheck(healthcheck) === 'active';
}

/**
 * True when Docker's effective healthcheck Test is present and active.
 * Empty / missing / `NONE` / `["NONE"]` are inactive.
 */
export function isDockerHealthcheckActive(test: unknown): boolean {
  if (test == null) return false;
  if (typeof test === 'string') return !isNoneToken(test);
  if (!Array.isArray(test) || test.length === 0) return false;
  return !isNoneTest(test);
}

function isNoneTest(test: unknown): boolean {
  if (typeof test === 'string') return isNoneToken(test);
  if (!Array.isArray(test) || test.length === 0) return false;
  return test.length === 1 && typeof test[0] === 'string' && isNoneToken(test[0]);
}

function isNoneToken(value: string): boolean {
  return value.trim().toUpperCase() === 'NONE';
}
