import { isLikelySecretKey } from './secretClassification';

export const REDACTED_SENTINEL = '[redacted]';

/** True when a Docker/Compose label key likely carries a sensitive value. */
export function isLikelySecretLabelKey(rawKey: string): boolean {
  return isLikelySecretKey(rawKey);
}

export function redactLabelValue(key: string, value: string, revealSecrets: boolean): { value: string; redacted?: boolean } {
  if (revealSecrets || !isLikelySecretLabelKey(key)) {
    return { value };
  }
  return { value: REDACTED_SENTINEL, redacted: true };
}
