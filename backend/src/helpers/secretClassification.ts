/**
 * Deterministic "is this env key likely a secret" classification by key NAME only.
 *
 * Used to decide whether an env-inventory row is redacted (presence shown, value
 * never read or rendered). The heuristic is segment-aware: a key is split on
 * non-alphanumeric boundaries and each segment is matched against a known set, so
 * `API_KEY` / `DB_PASSWORD` / `CLIENT_SECRET` match while a key that merely
 * contains a secret word as part of a larger token (e.g. `KEYCLOAK_URL`, where the
 * segment is `KEYCLOAK`, not `KEY`) does not. Over-flagging is safe: classification
 * only hides a value the inventory already never reads.
 */

/** Whole-segment matches. Split on `_`/non-alnum, so `KEYCLOAK` never matches `KEY`. */
const SECRET_SEGMENTS = new Set([
  'PASSWORD', 'PASSWD', 'PASS', 'PASSPHRASE',
  'SECRET', 'SECRETS',
  'TOKEN', 'KEY', 'APIKEY',
  'CREDENTIAL', 'CREDENTIALS', 'AUTH',
]);

/** Connection strings whose value is sensitive but whose segments are innocuous. */
const SECRET_FULL_KEYS = new Set([
  'DATABASE_URL', 'DATABASE_DSN', 'REDIS_URL', 'MONGO_URI', 'MONGODB_URI', 'AMQP_URL', 'DSN',
]);

/** True when the key name suggests its value is a secret. Names only, never values. */
export function isLikelySecretKey(rawKey: string): boolean {
  const key = rawKey.trim().toUpperCase();
  if (!key) return false;
  if (SECRET_FULL_KEYS.has(key)) return true;
  const segments = key.split(/[^A-Z0-9]+/).filter(Boolean);
  return segments.some(seg => SECRET_SEGMENTS.has(seg));
}
