import { isLikelySecretKey } from './secretClassification';

export const REDACTED_SENTINEL = '[redacted]';

/**
 * Compound single-token segments specific to Docker/Compose labels that the generic
 * env classifier does not split (e.g. Traefik `basicauth`/`digestauth` middleware keys,
 * whose value carries inline `user:passwordhash` credentials).
 */
const SECRET_LABEL_SEGMENTS = new Set(['BASICAUTH', 'DIGESTAUTH']);

/** True when a Docker/Compose label key likely carries a sensitive value. */
export function isLikelySecretLabelKey(rawKey: string): boolean {
  if (isLikelySecretKey(rawKey)) return true;
  const segments = rawKey.trim().toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  return segments.some(seg => SECRET_LABEL_SEGMENTS.has(seg));
}

export function redactLabelValue(key: string, value: string, revealSecrets: boolean): { value: string; redacted?: boolean } {
  if (revealSecrets || !isLikelySecretLabelKey(key)) {
    return { value };
  }
  return { value: REDACTED_SENTINEL, redacted: true };
}
