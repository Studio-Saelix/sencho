import type { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import {
  DatabaseService,
  API_TOKEN_SCOPE_TO_ROLE,
  type UserRole,
  type ApiTokenScope,
} from '../services/DatabaseService';
import { getErrorMessage } from '../utils/errors';
import { PROXY_TIER_HEADER, PROXY_VARIANT_HEADER } from '../services/license-headers';
import {
  isLicenseTier,
  isLicenseVariant,
  normalizeTier,
  normalizeVariant,
} from '../services/license-normalize';
import { isDebugEnabled } from '../utils/debug';
import {
  COOKIE_NAME,
  MFA_PENDING_COOKIE_NAME,
  MFA_PENDING_SCOPE,
  MFA_PENDING_TTL_MS,
} from '../helpers/constants';
import { getCookieOptions } from '../helpers/cookies';
import { looksLikeApiToken, verifyApiTokenChecksum } from '../utils/apiTokenFormat';

/**
 * Authenticate a request via cookie session or Bearer token.
 *
 * Handles five auth modes: opaque sen_sk_ API tokens (routed before any JWT
 * work) plus the JWT-backed user-session, mfa_pending, node_proxy, and
 * pilot_tunnel scopes. Bearer token is preferred over cookie so node-to-node
 * proxy calls aren't shadowed by a stale cross-instance cookie.
 */
export const authMiddleware: RequestHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const cookieToken = req.cookies[COOKIE_NAME];
  const bearerToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  const token = bearerToken || cookieToken;

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    // Opaque sen_sk_ API tokens: scope-based programmatic access. Routed
    // before jwt.verify so the JWT path stays focused on session, mfa_pending,
    // node_proxy, and pilot_tunnel. Steps 1-3 (prefix, length, checksum)
    // reject malformed/typoed keys without touching SQLite.
    if (looksLikeApiToken(token)) {
      // Uniform 401 message across malformed-checksum, unknown-hash, and
      // expired/revoked paths so the response body is not a token-existence
      // oracle. Debug logs still capture the specific reason.
      if (!verifyApiTokenChecksum(token)) {
        if (isDebugEnabled()) console.log('[Auth:diag] API token rejected: checksum');
        res.status(401).json({ error: 'Invalid or expired token' });
        return;
      }
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const apiToken = DatabaseService.getInstance().getApiTokenByHash(tokenHash);
      if (!apiToken || apiToken.revoked_at) {
        if (isDebugEnabled()) console.log('[Auth:diag] API token rejected: not found or revoked');
        res.status(401).json({ error: 'Invalid or expired token' });
        return;
      }
      if (apiToken.expires_at && apiToken.expires_at < Date.now()) {
        if (isDebugEnabled()) console.log('[Auth:diag] API token rejected: expired');
        res.status(401).json({ error: 'Invalid or expired token' });
        return;
      }
      DatabaseService.getInstance().updateApiTokenLastUsed(apiToken.id);
      const creator = DatabaseService.getInstance().getUserById(apiToken.user_id);
      req.user = {
        username: creator?.username || `api-token:${apiToken.name}`,
        role: API_TOKEN_SCOPE_TO_ROLE[apiToken.scope] ?? 'viewer',
        userId: apiToken.user_id,
      };
      req.apiTokenScope = apiToken.scope as ApiTokenScope;
      if (isDebugEnabled()) console.log('[Auth:diag] API token authenticated:', { scope: apiToken.scope, user: creator?.username, tokenName: apiToken.name });
      next();
      return;
    }

    const settings = DatabaseService.getInstance().getGlobalSettings();
    const jwtSecret = settings.auth_jwt_secret;
    if (!jwtSecret) throw new Error('No JWT secret');
    const decoded = jwt.verify(token, jwtSecret) as { username?: string; role?: string; scope?: string; tv?: number; user_id?: number; sso?: boolean };

    if (isDebugEnabled()) console.log('[Auth:diag] Token type:', bearerToken ? 'bearer' : 'cookie', 'scope:', decoded.scope || 'user-session');

    // Partial-auth session: a password/SSO credential has verified, but the
    // TOTP second factor is still required. Such a token can only be used to
    // complete the MFA challenge or to abort the flow by logging out. Every
    // other route must reject it so no privileged action is reachable before
    // the second factor clears.
    if (decoded.scope === MFA_PENDING_SCOPE) {
      const allowedPath = req.path === '/api/auth/login/mfa' || req.path === '/api/auth/logout';
      if (!allowedPath) {
        res.status(403).json({ error: 'Two-factor authentication required', code: 'MFA_PENDING' });
        return;
      }
      req.mfaPendingUserId = typeof decoded.user_id === 'number' ? decoded.user_id : undefined;
      req.mfaPendingSso = decoded.sso === true;
      next();
      return;
    }

    // Node proxy tokens: Sencho-to-Sencho communication, not user sessions.
    // Handle before user resolution since proxy tokens have no username.
    // pilot_tunnel scope is the equivalent credential for pilot-agent-mode
    // nodes; it arrives on requests the primary forwarded through a tunnel
    // after the primary itself re-signed/trusted them. Same tier-header trust
    // rules apply.
    if (decoded.scope === 'node_proxy' || decoded.scope === 'pilot_tunnel') {
      req.user = { username: 'node-proxy', role: 'admin', userId: 0 };

      // Distributed License Enforcement: trust tier headers only from authenticated node proxy requests.
      // Browser sessions and API tokens cannot set these; only a valid node_proxy JWT (signed with
      // this instance's JWT secret) unlocks the trusted path.
      const tierHeader = req.headers[PROXY_TIER_HEADER] as string | undefined;
      const variantHeader = req.headers[PROXY_VARIANT_HEADER] as string | undefined;
      if (isLicenseTier(tierHeader)) {
        req.proxyTier = normalizeTier(tierHeader);
      }
      if (isLicenseVariant(variantHeader)) {
        req.proxyVariant = normalizeVariant(variantHeader);
      } else if (variantHeader === '') {
        req.proxyVariant = null;
      }
      next();
      return;
    }

    // User session tokens: resolve against the database for up-to-date role and existence checks.
    const dbUser = decoded.username ? DatabaseService.getInstance().getUserByUsername(decoded.username) : undefined;

    // User must exist in the database (rejects deleted users immediately)
    if (!dbUser) {
      res.status(401).json({ error: 'User account no longer exists' });
      return;
    }

    // Token version check: rejects sessions after password change, role change, or admin reset.
    // Pre-migration tokens (no tv claim) are accepted for backward compat and expire within 24h.
    if (decoded.tv !== undefined && dbUser.token_version !== decoded.tv) {
      if (isDebugEnabled()) console.log('[Auth:diag] Token version mismatch for:', decoded.username, 'jwt:', decoded.tv, 'db:', dbUser.token_version);
      console.log('[Auth] Session rejected: token version mismatch for:', decoded.username);
      res.status(401).json({ error: 'Session invalidated. Please log in again.' });
      return;
    }

    if (isDebugEnabled()) console.log('[Auth:diag] User resolved:', dbUser.username, 'role:', dbUser.role, 'tv:', dbUser.token_version);

    // Use the DB role (not the JWT role) so role changes take effect immediately
    req.user = { username: dbUser.username, role: dbUser.role as UserRole, userId: dbUser.id };

    next();
  } catch (err) {
    console.error('[Auth] Token validation failed:', getErrorMessage(err, 'unknown'));
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
};

/** Sign a session JWT and set it as an httpOnly cookie. */
export function issueSessionCookie(
  res: Response,
  req: Request,
  user: { username: string; role: string; token_version: number },
  jwtSecret: string,
): void {
  const token = jwt.sign(
    { username: user.username, role: user.role, tv: user.token_version },
    jwtSecret,
    { expiresIn: '24h' },
  );
  res.cookie(COOKIE_NAME, token, getCookieOptions(req));
}

/**
 * Sign a short-lived `mfa_pending` JWT and set it as an httpOnly cookie. This
 * represents the partial-auth session that exists between password (or SSO)
 * success and TOTP verification. The scope is enforced in `authMiddleware`, so
 * this cookie cannot be used to reach any route other than
 * `/api/auth/login/mfa` or `/api/auth/logout`.
 */
export function issueMfaPendingCookie(
  res: Response,
  req: Request,
  user: { id: number; username: string },
  jwtSecret: string,
  opts: { sso?: boolean } = {},
): void {
  const token = jwt.sign(
    { scope: MFA_PENDING_SCOPE, user_id: user.id, username: user.username, sso: opts.sso === true },
    jwtSecret,
    { expiresIn: Math.floor(MFA_PENDING_TTL_MS / 1000) },
  );
  res.cookie(MFA_PENDING_COOKIE_NAME, token, {
    ...getCookieOptions(req),
    maxAge: MFA_PENDING_TTL_MS,
  });
}

/** Clear the partial-auth cookie. Called on successful MFA verification and on logout. */
export function clearMfaPendingCookie(res: Response, req: Request): void {
  res.clearCookie(MFA_PENDING_COOKIE_NAME, getCookieOptions(req));
}

/**
 * Re-issue the session cookie after bumping `token_version`. Routes that
 * call `bumpTokenVersion` (password change, MFA enrol, MFA disable) use this
 * so the caller stays signed in after their previous cookie is invalidated.
 * No-ops silently when the JWT secret is missing or the user has been
 * deleted mid-request.
 */
export function reissueSessionAfterTokenBump(req: Request, res: Response, userId: number): void {
  const db = DatabaseService.getInstance();
  const refreshed = db.getUserById(userId);
  const settings = db.getGlobalSettings();
  if (refreshed && settings.auth_jwt_secret) {
    issueSessionCookie(res, req, refreshed, settings.auth_jwt_secret);
  }
}
