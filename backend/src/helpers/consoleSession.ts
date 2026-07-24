import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { DatabaseService } from '../services/DatabaseService';

/**
 * Console session token lifetime. Short on purpose: these tokens bridge an
 * already-authenticated hub request into a remote WebSocket upgrade. Each
 * token is path-scoped and consumed on first interactive WebSocket upgrade
 * acceptance (before PTY spawn).
 */
const CONSOLE_SESSION_TTL_SECONDS = 60;
const CONSOLE_SESSION_SCOPE = 'console_session';

/** Interactive surfaces that may mint or accept a console_session JWT. */
export type ConsoleSessionPath = 'host-console' | 'container-exec';

export interface MintConsoleSessionOptions {
  path: ConsoleSessionPath;
  /** Hub operator identity for remote audit (option B). Never used as the session principal. */
  actingAs?: string;
}

export interface ConsoleSessionClaims {
  scope: typeof CONSOLE_SESSION_SCOPE;
  path: ConsoleSessionPath;
  acting_as?: string;
}

const ACTING_AS_MAX = 64;
const ACTING_AS_RE = /^[A-Za-z0-9._@+-]+$/;

/** Sanitize an optional hub operator name for the acting_as claim. */
export function sanitizeActingAs(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > ACTING_AS_MAX) return undefined;
  if (!ACTING_AS_RE.test(trimmed)) return undefined;
  return trimmed;
}

export function isConsoleSessionPath(value: unknown): value is ConsoleSessionPath {
  return value === 'host-console' || value === 'container-exec';
}

/**
 * Map a WebSocket pathname to the console_session path claim it requires.
 * Returns null for surfaces that must not accept console_session tokens.
 */
export function consoleSessionPathForPathname(pathname: string): ConsoleSessionPath | null {
  if (pathname.startsWith('/api/system/host-console')) return 'host-console';
  if (pathname === '/ws') return 'container-exec';
  return null;
}

/**
 * Mint a short-lived JWT that grants interactive console access on the remote
 * instance without leaking the long-lived node api_token onto a
 * machine-to-machine WebSocket. Throws if the JWT secret is not configured.
 */
export function mintConsoleSession(opts: MintConsoleSessionOptions): string {
  if (!isConsoleSessionPath(opts.path)) {
    throw new Error('Invalid console session path');
  }
  const jwtSecret = DatabaseService.getInstance().getGlobalSettings().auth_jwt_secret;
  if (!jwtSecret) throw new Error('No JWT secret configured');
  const payload: ConsoleSessionClaims = { scope: CONSOLE_SESSION_SCOPE, path: opts.path };
  const actingAs = sanitizeActingAs(opts.actingAs);
  if (actingAs) payload.acting_as = actingAs;
  return jwt.sign(payload, jwtSecret, {
    expiresIn: CONSOLE_SESSION_TTL_SECONDS,
    jwtid: randomUUID(),
  });
}

/** True when `decoded.scope` is the console_session scope. */
export function isConsoleSessionScope(scope: unknown): boolean {
  return scope === CONSOLE_SESSION_SCOPE;
}

/**
 * Mark a console_session jti as used. Returns false when the jti is missing,
 * already consumed, or cannot be recorded (replay / malformed token).
 */
export function consumeConsoleSessionJti(jti: unknown, expiresAtMs: number): boolean {
  if (typeof jti !== 'string' || !jti) return false;
  if (!Number.isFinite(expiresAtMs)) return false;
  return DatabaseService.getInstance().consumeConsoleSessionJti(jti, expiresAtMs);
}

export { CONSOLE_SESSION_SCOPE, CONSOLE_SESSION_TTL_SECONDS };
