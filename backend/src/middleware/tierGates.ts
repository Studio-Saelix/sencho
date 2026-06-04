import type { Request, Response } from 'express';
import { LicenseService } from '../services/LicenseService';
import type { LicenseTier } from '../services/license-types';

// Tier-based route guards. Each returns true when the request may proceed and
// false after sending the appropriate 403 response. Callers MUST check the
// return value and `return;` on false.
//
// Guards trust req.proxyTier (set by authMiddleware for node_proxy tokens)
// ahead of the local entitlement provider so a primary Sencho instance can
// assert license state for its remote fleet nodes.

const PAID_MESSAGE = 'This feature requires a Sencho Admiral license.';

/** Effective license tier for this request (proxy header if trusted, else local). */
export const effectiveTier = (req: Request): LicenseTier =>
  req.proxyTier ?? LicenseService.getInstance().getTier();

const deny = (res: Response, code: string, error: string): false => {
  res.status(403).json({ error, code });
  return false;
};

/** Paid feature guard: requires a paid (Admiral) license. */
export const requirePaid = (req: Request, res: Response): boolean => {
  if (effectiveTier(req) !== 'paid') return deny(res, 'PAID_REQUIRED', PAID_MESSAGE);
  return true;
};

/** Admin role guard: the request must be authenticated as an `admin` user. */
export const requireAdmin = (req: Request, res: Response): boolean => {
  if (req.user?.role !== 'admin') return deny(res, 'ADMIN_REQUIRED', 'Admin access required.');
  return true;
};

/**
 * Require a genuine signed-in user session. Rejects opaque API tokens
 * (`req.apiTokenScope`) and node_proxy / pilot_tunnel machine credentials,
 * which authMiddleware maps to role 'admin' with userId 0. Endpoints that
 * expose decrypted secrets use this so a long-lived machine credential cannot
 * reach them; the admin role itself is still enforced separately by requireAdmin.
 */
export const requireUserSession = (req: Request, res: Response): boolean => {
  if (req.apiTokenScope || !req.user || req.user.userId === 0) {
    return deny(res, 'SESSION_REQUIRED', 'This action requires a signed-in user session.');
  }
  return true;
};

/**
 * Accept only calls from a sibling Sencho using its node_proxy Bearer token.
 * Browser sessions, API tokens, and console tokens are all rejected.
 */
export const requireNodeProxy = (req: Request, res: Response): boolean => {
  if (req.user?.username !== 'node-proxy') return deny(res, 'NODE_PROXY_REQUIRED', 'Node proxy authentication required.');
  return true;
};

/**
 * Tier gate for SSO providers. Custom OIDC and the one-click presets
 * (Google / GitHub / Okta) are free so self-hosters can wire any OIDC IdP;
 * only LDAP / Active Directory requires the paid tier.
 */
export const requireTierForSsoProvider = (provider: string, req: Request, res: Response): boolean => {
  if (provider === 'ldap') return requirePaid(req, res);
  return true;
};

/** 400s when the request has no object body. Used by endpoints that always expect JSON input. */
export const requireBody = (req: Request, res: Response): boolean => {
  if (!req.body || typeof req.body !== 'object') {
    res.status(400).json({ error: 'Request body is required' });
    return false;
  }
  return true;
};
