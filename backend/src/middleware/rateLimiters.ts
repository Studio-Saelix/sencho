import type { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { COOKIE_NAME } from '../helpers/constants';
import { WEBHOOK_TRIGGER_RE } from '../helpers/routePatterns';
import { looksLikeApiToken } from '../utils/apiTokenFormat';
import { validateApiToken } from '../utils/apiTokenAuth';
import { DatabaseService } from '../services/DatabaseService';

// ── Rate Limiting ─────────────────────────────────────────────────────────────
//
// Tiered rate limiting to prevent UX lockouts while maintaining security:
//   Tier 0/1 (Polling):  High-frequency GET endpoints exempt from global limit,
//                         with a 300/min safety net to prevent resource exhaustion.
//   Tier W   (Webhooks): CI/CD webhook triggers at 500/min (shared datacenter IPs).
//   Tier 2   (Standard): All other endpoints at 200/min.
//   Tier 3   (Auth):     Strict brute-force protection (5-10 attempts / 15min).
//
// Enterprise adaptations:
//   - Internal node-to-node traffic (node_proxy JWTs) bypasses all rate limiters.
//   - Authenticated requests are keyed by user ID (not IP) to prevent shared
//     NAT/VPN environments from pooling rate limit budgets.

/** Read-only GET endpoints polled at high frequency by the dashboard/fleet UI. */
const POLLING_EXEMPT_PATHS = new Set([
  '/meta', '/health', '/stats', '/system/stats',
  '/stacks/statuses', '/metrics/historical',
  '/auth/status', '/auth/sso/providers', '/license',
]);

type CachedProxyFlagReq = Request & { _isNodeProxy?: boolean };

/**
 * True when the request bears a node_proxy Bearer token. Uses `jwt.decode()`
 * (no signature verification) to keep the hot path cheap; `authMiddleware`
 * verifies signatures downstream. Worst case for a forged token: it bypasses
 * the rate limiter but is still rejected at auth. Result is memoized on the
 * request object so sequential limiters don't repeat the work.
 */
function isNodeProxyRequest(req: Request): boolean {
  const cached = (req as CachedProxyFlagReq);
  if (cached._isNodeProxy !== undefined) return cached._isNodeProxy;
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    cached._isNodeProxy = false;
    return false;
  }
  const bearer = auth.slice(7);
  // Opaque API tokens are never node_proxy credentials, and they are not
  // JWTs — short-circuit so `jwt.decode` is never invoked on them.
  if (looksLikeApiToken(bearer)) {
    cached._isNodeProxy = false;
    return false;
  }
  try {
    const decoded = jwt.decode(bearer) as { scope?: string } | null;
    const result = decoded?.scope === 'node_proxy';
    cached._isNodeProxy = result;
    return result;
  } catch {
    cached._isNodeProxy = false;
    return false;
  }
}

/**
 * Verify a session/bearer JWT against the cached signing secret and return its
 * payload, or null when the secret is unset, the signature or expiry is invalid,
 * or the settings read itself fails. `getGlobalSettings()` is a frozen in-memory
 * cache (no per-call DB hit) and `jwt.verify` costs microseconds, so this is safe
 * on the rate-limiter hot path. Verifying here is what stops one source from
 * fragmenting the limiter by rotating a forged JWT with a varying username: a
 * credential that does not verify yields no per-user key. Fails closed: any error
 * returns null, so the caller degrades to per-IP keying rather than throwing out
 * of the key generator.
 */
function verifiedJwtPayload(token: string): { username?: string; sub?: string } | null {
  try {
    const secret = DatabaseService.getInstance().getGlobalSettings().auth_jwt_secret;
    if (!secret) return null;
    return jwt.verify(token, secret) as { username?: string; sub?: string };
  } catch {
    return null;
  }
}

/**
 * Hybrid rate limit key: per-token / per-user for authenticated requests, IP
 * otherwise. Mirrors authMiddleware's bearer-over-cookie precedence (auth.ts
 * uses `bearerToken || cookieToken`) so the limiter keys off the same credential
 * auth will use, and a JWT is trusted only once its signature verifies. When a
 * Bearer header is present the cookie is never consulted (auth ignores it too),
 * so a forged or expired Bearer cannot be rescued into a valid cookie's bucket.
 * Anything that does not resolve to a live token or a verified username falls
 * back to per-IP keying.
 */
export function rateLimitKeyGenerator(req: Request): string {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const bearer = auth.slice(7);
    // Opaque API tokens get a per-token rate-limit budget, but ONLY when the
    // bearer resolves to a real, active token. This runs before authMiddleware,
    // so keying any token-shaped string by its own hash would let one source
    // mint a fresh budget per forged value and fragment the limiter; anything
    // that is not a live token therefore falls through to per-IP keying. The
    // validated row is memoized on the request so authMiddleware reuses it
    // without a second lookup (and a request crossing two limiters reuses it
    // here too). Like the verified-JWT branches below, a validation failure
    // degrades to per-IP keying rather than throwing out of the key generator.
    if (looksLikeApiToken(bearer)) {
      if (req._apiToken) return `user:sk:${req._apiToken.token_hash.slice(0, 16)}`;
      try {
        const validation = validateApiToken(bearer);
        if (validation.ok) {
          // Only ever memoize the row matching this request's bearer;
          // authMiddleware trusts req._apiToken without re-checking the hash.
          req._apiToken = validation.token;
          return `user:sk:${validation.token.token_hash.slice(0, 16)}`;
        }
      } catch { /* fall through to IP */ }
      return ipKeyGenerator(req.ip || 'unknown');
    }
    // Non-API Bearer JWT: key by the VERIFIED username (sub is a legacy
    // fallback, now signature-gated, kept only for back-compat). A Bearer header
    // present means auth ignores the cookie, so an unverified Bearer returns
    // per-IP here rather than falling through to the cookie branch below.
    const payload = verifiedJwtPayload(bearer);
    if (payload?.username) return `user:${payload.username}`;
    if (payload?.sub) return `user:${payload.sub}`;
    return ipKeyGenerator(req.ip || 'unknown');
  }
  const cookie = req.cookies?.[COOKIE_NAME];
  if (cookie) {
    const payload = verifiedJwtPayload(cookie);
    if (payload?.username) return `user:${payload.username}`;
  }
  return ipKeyGenerator(req.ip || 'unknown');
}

/** Shared config for all per-minute limiters (1-minute window, standard headers). */
const rateLimitBase = {
  windowMs: 60 * 1000,
  standardHeaders: true,
  legacyHeaders: false,
} as const;

// Tier 2: Global API rate limiter. Skips polling endpoints (Tier 0/1), webhook
// triggers (Tier W), and internal node-to-node traffic (node_proxy).
export const globalApiLimiter = rateLimit({
  ...rateLimitBase,
  max: process.env.NODE_ENV === 'production'
    ? parseInt(process.env.API_RATE_LIMIT || '200', 10)
    : 1000,
  keyGenerator: rateLimitKeyGenerator,
  message: { error: 'Too many requests. Please try again shortly.' },
  skip: (req: Request) => {
    if (req.method === 'GET' && POLLING_EXEMPT_PATHS.has(req.path)) return true;
    if (req.method === 'POST' && WEBHOOK_TRIGGER_RE.test(req.path)) return true;
    if (isNodeProxyRequest(req)) return true;
    return false;
  },
});

// Tier 0/1: Polling safety net. Applies only to polling-exempt endpoints to
// prevent resource exhaustion from runaway or malicious polling.
export const pollingLimiter = rateLimit({
  ...rateLimitBase,
  max: process.env.NODE_ENV === 'production'
    ? parseInt(process.env.API_POLLING_RATE_LIMIT || '300', 10)
    : 3000,
  keyGenerator: rateLimitKeyGenerator,
  message: { error: 'Too many polling requests. Please try again shortly.' },
  skip: (req: Request) => {
    if (isNodeProxyRequest(req)) return true;
    return !(req.method === 'GET' && POLLING_EXEMPT_PATHS.has(req.path));
  },
});

// Tier W: Webhook trigger limiter. Applied inline on the trigger route handler.
// CI/CD platforms often share datacenter IPs, so a higher ceiling prevents
// dropped deployments during burst activity.
export const webhookTriggerLimiter = rateLimit({
  ...rateLimitBase,
  max: process.env.NODE_ENV === 'production' ? 500 : 5000,
  message: { error: 'Too many webhook triggers. Please try again shortly.' },
});

// Tier 3: Auth endpoint limiter. 15-minute window to blunt brute-force attacks.
// Prod: 5 attempts/15min/IP. Dev: 1000 attempts so the full E2E suite, which logs
// in per test and has outgrown a 100-attempt window, plus local tooling, are not blocked.
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 5 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in 15 minutes.' },
});

// Tier 3: SSO flow limiter. Slightly more generous than authRateLimiter because
// OIDC callbacks can chain multiple round trips per user attempt.
export const ssoRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 10 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many SSO attempts. Please try again later.' },
});

// Pilot enrollment limiter. Enrollment mints a JWT and writes a
// pilot_enrollments row, so it deserves a stricter ceiling than the global
// API limiter (200/min). Applied on the regenerate route directly and on
// `POST /api/nodes` only when the body resolves to pilot_agent mode (the
// limiter's `skip` function reads the parsed body).
export const enrollmentLimiter = rateLimit({
  ...rateLimitBase,
  max: process.env.NODE_ENV === 'production' ? 10 : 100,
  keyGenerator: rateLimitKeyGenerator,
  message: { error: 'Too many enrollment requests. Please try again shortly.' },
  skip: (req: Request) => {
    // Only gate `POST /api/nodes` calls that actually create a pilot agent;
    // proxy-mode node creation falls back to the global limiter. The
    // dedicated `/pilot/enroll` route applies this limiter unconditionally,
    // so the body check is bypassed there by skipping the skip when the
    // path already targets enrollment.
    if (req.path.endsWith('/pilot/enroll')) return false;
    // Express.json() runs globally before route handlers in app.ts, so
    // req.body is parsed by the time this fires. If a future refactor moves
    // body parsing per-route the worst case is "limiter applies even to
    // proxy-mode" rather than "limiter is bypassed entirely".
    if (!req.body) return false;
    const body = req.body as { mode?: string; type?: string };
    return !(body.type === 'remote' && body.mode === 'pilot_agent');
  },
});

// Trivy install/update limiter. Install + update are expensive (binary download,
// sha256 verification) so a 10-minute window prevents accidental thrashing.
export const trivyInstallLimiter = rateLimit({
  ...rateLimitBase,
  windowMs: 10 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 5 : 50,
  keyGenerator: rateLimitKeyGenerator,
  message: { error: 'Too many install requests. Try again later.' },
});
