import type { Request, Response, NextFunction, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import {
  DatabaseService,
  API_TOKEN_SCOPE_TO_ROLE,
  isUserRole,
  type UserRole,
  type ApiTokenScope,
} from '../services/DatabaseService';
import { getErrorMessage } from '../utils/errors';
import {
  PROXY_TIER_HEADER,
  PROXY_ROLE_HEADER,
  PROXY_DEPLOY_SOURCE_HEADER,
  PROXY_DEPLOY_ACTOR_HEADER,
  PROXY_SCOPED_STACK_NAME_HEADER,
  PROXY_SCOPED_STACK_ACTIONS_HEADER,
  isDeploySourceHeader,
} from '../services/license-headers';
import type { DeployInvocationContext } from '../services/network/missingExternalNetworksError';
import { isLicenseTier, normalizeTier } from '../services/license-normalize';
import { isDebugEnabled } from '../utils/debug';
import { parseScopedStackActionsHeader } from '../helpers/stackRouteAuth';
import { isValidStackName } from '../utils/validation';
import {
  COOKIE_NAME,
  MFA_PENDING_COOKIE_NAME,
  MFA_PENDING_SCOPE,
  MFA_PENDING_TTL_MS,
  SESSION_COOKIE_MAX_AGE_MS,
  REMEMBER_SESSION_MAX_AGE_MS,
  SESSION_REFRESH_THRESHOLD_MS,
} from '../helpers/constants';
import { getCookieOptions } from '../helpers/cookies';
import { looksLikeApiToken } from '../utils/apiTokenFormat';
import { validateApiToken, touchApiTokenLastUsed, type ApiTokenValidation } from '../utils/apiTokenAuth';

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
    // node_proxy, and pilot_tunnel. validateApiToken rejects malformed/typoed
    // keys (prefix, length, checksum) without touching SQLite.
    if (looksLikeApiToken(token)) {
      // The rate limiter's key generator runs before this middleware and, for
      // this same bearer, memoizes the validated row on req._apiToken. Reuse it
      // when present so the token costs one DB lookup per request, not two;
      // otherwise validate now (e.g. a path the limiter skipped).
      const validation: ApiTokenValidation = req._apiToken
        ? { ok: true, token: req._apiToken }
        : validateApiToken(token);
      if (!validation.ok) {
        // Uniform 401 across checksum/unknown/expired/revoked so the response
        // body is not a token-existence oracle; the debug log keeps the reason.
        if (isDebugEnabled()) console.log('[Auth:diag] API token rejected:', validation.reason);
        res.status(401).json({ error: 'Invalid or expired token' });
        return;
      }
      const apiToken = validation.token;
      touchApiTokenLastUsed(apiToken);
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
    const decoded = jwt.verify(token, jwtSecret) as { username?: string; role?: string; scope?: string; tv?: number; user_id?: number; sso?: boolean; remember?: boolean; exp?: number };

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
      // Preserve the originating user's RBAC across the proxy. The forwarding
      // primary asserts the signed-in user's role on PROXY_ROLE_HEADER, trusted
      // under the same rule as the tier header (only a valid node_proxy /
      // pilot_tunnel bearer reaches this branch). Honor that role so a non-admin
      // proxied here is bound to their own permissions instead of inheriting
      // blanket admin. An absent header is a direct instance-to-instance or
      // background service call (fleet orchestration, sync, monitor) that
      // legitimately runs as admin; a present-but-unrecognized role fails closed
      // to read-only rather than admin.
      const forwardedRole = req.headers[PROXY_ROLE_HEADER] as string | undefined;
      let role: UserRole = 'admin';
      if (forwardedRole !== undefined) {
        role = isUserRole(forwardedRole) ? forwardedRole : 'viewer';
      }
      req.user = { username: 'node-proxy', role, userId: 0 };
      req.machineAuthScope = decoded.scope;

      // Distributed License Enforcement: trust tier headers only from authenticated node proxy requests.
      // Browser sessions and API tokens cannot set these; only a valid node_proxy JWT (signed with
      // this instance's JWT secret) unlocks the trusted path.
      const tierHeader = req.headers[PROXY_TIER_HEADER] as string | undefined;
      if (isLicenseTier(tierHeader)) {
        req.proxyTier = normalizeTier(tierHeader);
      }

      // Deploy provenance: only trust headers on this machine-auth path. The
      // gateway strips client values and overwrites interactive deploys with
      // manual + username; background callers set their own mapping.
      const sourceHeader = req.headers[PROXY_DEPLOY_SOURCE_HEADER];
      const actorHeader = req.headers[PROXY_DEPLOY_ACTOR_HEADER];
      if (isDeploySourceHeader(sourceHeader)) {
        const ctx: DeployInvocationContext = {
          source: sourceHeader,
          actor: typeof actorHeader === 'string' && actorHeader.trim()
            ? actorHeader.trim()
            : null,
        };
        req.deployContext = ctx;
      }

      // Scoped stack auth evidence: only trust on this machine-auth path.
      // Malformed or incomplete pairs are treated as absent (never as auth).
      const scopedNameRaw = req.headers[PROXY_SCOPED_STACK_NAME_HEADER];
      const scopedActionsRaw = req.headers[PROXY_SCOPED_STACK_ACTIONS_HEADER];
      const scopedName = typeof scopedNameRaw === 'string' ? scopedNameRaw.trim() : '';
      const scopedActionsStr = typeof scopedActionsRaw === 'string' ? scopedActionsRaw : '';
      if (scopedName && isValidStackName(scopedName) && scopedActionsStr) {
        const actions = parseScopedStackActionsHeader(scopedActionsStr);
        if (actions && actions.length > 0) {
          req.scopedStackEvidence = { stackName: scopedName, actions: new Set(actions) };
        }
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
    // A token without a tv claim is a pre-migration legacy token minted when
    // token_version was 1. Default to 1 on decode so the token is rejected only
    // when a security event (password change, MFA reset, role change, admin
    // invalidation) has actually bumped the version since it was issued.
    if (dbUser.token_version !== (decoded.tv ?? 1)) {
      if (isDebugEnabled()) console.log('[Auth:diag] Token version mismatch for:', decoded.username, 'jwt:', decoded.tv, 'db:', dbUser.token_version);
      console.log('[Auth] Session rejected: token version mismatch for:', decoded.username);
      res.status(401).json({ error: 'Session invalidated. Please log in again.' });
      return;
    }

    if (isDebugEnabled()) console.log('[Auth:diag] User resolved:', dbUser.username, 'role:', dbUser.role, 'tv:', dbUser.token_version);

    // Use the DB role (not the JWT role) so role changes take effect immediately
    req.user = { username: dbUser.username, role: dbUser.role as UserRole, userId: dbUser.id };
    const remember = decoded.remember === true;
    req.sessionRemember = remember;

    // Sliding refresh: a session nearing its expiry gets silently reissued with
    // a fresh full TTL (matching whichever TTL, 24h or "stay signed in" 30d, the
    // original login chose), so an actively-used tab never runs into the hard
    // cutoff. Disabled via the session_sliding_refresh setting (default on) for
    // admins who want a strict absolute session ceiling. This is a best-effort
    // optimization on an already-authenticated request, so its own try/catch
    // keeps a reissue failure from being reported as an invalid token.
    if (settings.session_sliding_refresh !== '0' && typeof decoded.exp === 'number') {
      const remainingMs = decoded.exp * 1000 - Date.now();
      const shouldRefresh = remainingMs < SESSION_REFRESH_THRESHOLD_MS;
      if (isDebugEnabled()) console.log('[Auth:diag] Sliding refresh check:', decoded.username, 'remainingMs:', remainingMs, 'refreshed:', shouldRefresh);
      if (shouldRefresh) {
        try {
          issueSessionCookie(res, req, dbUser, jwtSecret, remember);
        } catch (refreshErr) {
          console.error('[Auth] Sliding session refresh failed for', dbUser.username, getErrorMessage(refreshErr, 'unknown'));
        }
      }
    }

    next();
  } catch (err) {
    console.error('[Auth] Token validation failed:', getErrorMessage(err, 'unknown'));
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
};

/**
 * Drop any already-queued `Set-Cookie` entry for `name` on this response
 * before a caller appends a new one. `res.cookie()` appends rather than
 * replaces, so a request path that issues the same cookie twice (the
 * sliding refresh in `authMiddleware` followed by a token-bump reissue in
 * the same response, e.g. a password change inside the refresh window)
 * would otherwise send two `Set-Cookie` headers for one name: the first
 * carrying an already-superseded `token_version`. Browsers apply the last
 * one, but any other client taking the first would treat itself as
 * signed out on its very next request. Deduping keeps exactly one, correct
 * cookie in the response regardless of call order.
 */
function dropQueuedCookie(res: Response, name: string): void {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) return;
  const entries = Array.isArray(existing) ? existing : [String(existing)];
  const filtered = entries.filter((entry) => !entry.startsWith(`${name}=`));
  if (filtered.length !== entries.length) res.setHeader('Set-Cookie', filtered);
}

/**
 * Sign a session JWT and set it as an httpOnly cookie. `remember` extends the
 * session to `REMEMBER_SESSION_MAX_AGE_MS` (30 days, "stay signed in") instead
 * of the default `SESSION_COOKIE_MAX_AGE_MS` (24h); the choice is carried in
 * the token's `remember` claim so a later sliding refresh (authMiddleware) or
 * post-token-bump reissue (reissueSessionAfterTokenBump) reapplies the same TTL.
 */
export function issueSessionCookie(
  res: Response,
  req: Request,
  user: { username: string; role: string; token_version: number },
  jwtSecret: string,
  remember = false,
): void {
  const maxAgeMs = remember ? REMEMBER_SESSION_MAX_AGE_MS : SESSION_COOKIE_MAX_AGE_MS;
  const token = jwt.sign(
    { username: user.username, role: user.role, tv: user.token_version, remember },
    jwtSecret,
    { expiresIn: Math.floor(maxAgeMs / 1000) },
  );
  dropQueuedCookie(res, COOKIE_NAME);
  res.cookie(COOKIE_NAME, token, { ...getCookieOptions(req), maxAge: maxAgeMs });
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
  opts: { sso?: boolean; remember?: boolean } = {},
): void {
  const token = jwt.sign(
    { scope: MFA_PENDING_SCOPE, user_id: user.id, username: user.username, sso: opts.sso === true, remember: opts.remember === true },
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
    issueSessionCookie(res, req, refreshed, settings.auth_jwt_secret, req.sessionRemember === true);
  }
}
