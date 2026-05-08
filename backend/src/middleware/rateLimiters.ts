import type { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { COOKIE_NAME } from '../helpers/constants';
import { WEBHOOK_TRIGGER_RE } from '../helpers/routePatterns';

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
  try {
    const decoded = jwt.decode(auth.slice(7)) as { scope?: string } | null;
    const result = decoded?.scope === 'node_proxy';
    cached._isNodeProxy = result;
    return result;
  } catch {
    cached._isNodeProxy = false;
    return false;
  }
}

/**
 * Hybrid rate limit key: JWT username/sub for authenticated requests
 * (per-user budgets), IP otherwise. `jwt.decode()` avoids double-verification;
 * `authMiddleware` handles signature checks downstream.
 */
function rateLimitKeyGenerator(req: Request): string {
  const cookie = req.cookies?.[COOKIE_NAME];
  if (cookie) {
    try {
      const decoded = jwt.decode(cookie) as { username?: string } | null;
      if (decoded?.username) return `user:${decoded.username}`;
    } catch { /* fall through to IP */ }
  }
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    try {
      const decoded = jwt.decode(auth.slice(7)) as { username?: string; sub?: string } | null;
      if (decoded?.username) return `user:${decoded.username}`;
      if (decoded?.sub) return `user:${decoded.sub}`;
    } catch { /* fall through to IP */ }
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
// Prod: 5 attempts/15min/IP. Dev: 100 attempts so E2E tests and local tooling are not blocked.
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 5 : 100,
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
