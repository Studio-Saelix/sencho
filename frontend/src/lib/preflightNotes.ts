/**
 * Informational Compose Doctor notes (excluded from All Clear, severity
 * summary, and dismiss fingerprint). Keep in sync with backend PREFLIGHT_NOTE_RULE_IDS.
 */
const PREFLIGHT_NOTE_RULE_IDS = new Set([
  'healthcheck-inherited',
  'docker-socket-proxy-client',
]);

export function isPreflightNoteFinding(ruleId: string | undefined): boolean {
  return !!ruleId && PREFLIGHT_NOTE_RULE_IDS.has(ruleId);
}
