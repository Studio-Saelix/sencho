import crypto from 'crypto';
import { DatabaseService, type ApiToken } from '../services/DatabaseService';
import { looksLikeApiToken, verifyApiTokenChecksum } from './apiTokenFormat';

/**
 * Result of validating an opaque `sen_sk_` API token. The failure `reason` is
 * for diagnostic logging only; callers MUST surface a single uniform 401 so the
 * response body never becomes a token-existence oracle.
 */
export type ApiTokenValidation =
  | { ok: true; token: ApiToken }
  | { ok: false; reason: 'not-api-token' | 'checksum' | 'not-found' | 'revoked' | 'expired' };

/**
 * Validate an API token with no side effects: format, checksum (timing-safe),
 * hash lookup, revocation, and expiry. The format and checksum checks
 * short-circuit before the SQLite lookup so malformed or bad-checksum keys never
 * touch the database. Shared by the HTTP auth middleware, the WebSocket upgrade
 * handler, and the rate limiter's key generator so all three agree on what
 * counts as a live token.
 */
export function validateApiToken(token: string): ApiTokenValidation {
  if (!looksLikeApiToken(token)) return { ok: false, reason: 'not-api-token' };
  if (!verifyApiTokenChecksum(token)) return { ok: false, reason: 'checksum' };
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const apiToken = DatabaseService.getInstance().getApiTokenByHash(tokenHash);
  if (!apiToken) return { ok: false, reason: 'not-found' };
  if (apiToken.revoked_at) return { ok: false, reason: 'revoked' };
  if (apiToken.expires_at && apiToken.expires_at < Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true, token: apiToken };
}

/** Minimum interval between `last_used_at` writes for a single token. */
const LAST_USED_THROTTLE_MS = 60_000;

/**
 * Record that a token was used, skipping the write when last_used_at is still
 * within the throttle window. Authenticated API requests fire on every
 * CI/script call, so an unconditional bump was a synchronous SQLite write per
 * request; the throttle keeps "last used" accurate to the minute while removing
 * that write amplification from the hot path. Best-effort: the check reads the
 * row fetched at request start, so concurrent requests for one token may each
 * write once.
 */
export function touchApiTokenLastUsed(token: ApiToken): void {
  if (token.last_used_at && Date.now() - token.last_used_at < LAST_USED_THROTTLE_MS) return;
  DatabaseService.getInstance().updateApiTokenLastUsed(token.id);
}
