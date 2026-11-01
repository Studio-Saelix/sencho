import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { isDebugEnabled } from '../utils/debug';
import { sanitizeForLog } from '../utils/safeLog';
import type { ApiTokenScope } from '../services/DatabaseService';

/**
 * 403 the request if it is authenticated via an API token. Many admin and
 * account-scoped endpoints reject API tokens outright; this helper
 * centralises the message and `code: 'SCOPE_DENIED'` envelope. Returns true
 * and writes the response when rejected, false otherwise; callers should
 * early-return on true.
 */
export function rejectApiTokenScope(req: Request, res: Response, message: string): boolean {
  if (req.apiTokenScope) {
    res.status(403).json({ error: message, code: 'SCOPE_DENIED' });
    return true;
  }
  return false;
}

/**
 * Refuse an Observe Only token.
 *
 * The auth and MFA routers are mounted ahead of `enforceApiTokenScope`, so their
 * handlers never meet the scope gate. An observer token is refused here
 * explicitly rather than being left to inherit a route's own auth check, because
 * the two routes that call this answer with the token creator's account state.
 */
export function rejectObserveOnlyTokenScope(req: Request, res: Response): boolean {
  if (req.apiTokenScope === 'observe-only') {
    res.status(403).json({
      error: 'API token scope "observe-only" cannot read account state.',
      code: 'SCOPE_DENIED',
    });
    return true;
  }
  return false;
}

// Scope enforcement for API tokens: restricts which endpoints a token can reach.
const DEPLOY_ALLOWED_PATTERNS: RegExp[] = [
  /^\/api\/stacks\/[^/]+\/deploy$/,
  /^\/api\/stacks\/[^/]+\/down$/,
  /^\/api\/stacks\/[^/]+\/restart$/,
  /^\/api\/stacks\/[^/]+\/stop$/,
  /^\/api\/stacks\/[^/]+\/start$/,
  /^\/api\/stacks\/[^/]+\/update$/,
  /^\/api\/stacks\/[^/]+\/services\/[^/]+\/update$/,
  /^\/api\/stacks\/[^/]+\/services\/[^/]+\/restore$/,
];

/**
 * The stack segment alphabet, matching `isValidStackName`. Kept as a literal
 * rather than imported so the allowlist below cannot widen when the name rules
 * do: a name this gate would reject is a name the observation routes cannot
 * address either.
 */
const STACK_SEGMENT = '[A-Za-z0-9_-]+';

/**
 * The complete reach of an Observe Only token: five GETs, each anchored and
 * case-sensitive, tested against `/api${req.path}`.
 *
 * A token that can reach nothing else can be handed to an AI client, which is
 * the whole point of the scope. Every pattern is a fixed path template, so no
 * caller-supplied URL, method or suffix can turn one into a broader read.
 */
export const OBSERVE_ALLOWED_PATTERNS: readonly RegExp[] = [
  /^\/api\/fleet\/observation\/nodes$/,
  /^\/api\/fleet\/observation\/health$/,
  new RegExp(`^/api/stacks/platform/observation$`),
  new RegExp(`^/api/stacks/${STACK_SEGMENT}/observation/status$`),
  new RegExp(`^/api/stacks/${STACK_SEGMENT}/observation/readiness$`),
];

const deny = (res: Response, req: Request, error: string, scope: ApiTokenScope | 'unknown'): void => {
  if (isDebugEnabled()) console.log('[ApiTokenScope:diag] Denied:', sanitizeForLog(req.method), sanitizeForLog(req.path), 'scope:', scope);
  res.status(403).json({ error, code: 'SCOPE_DENIED' });
};

export const enforceApiTokenScope: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
  const scope = req.apiTokenScope;
  if (!scope) { next(); return; } // Not an API token request
  if (isDebugEnabled()) console.log('[ApiTokenScope:diag]', sanitizeForLog(req.method), sanitizeForLog(req.path), 'scope:', scope);
  const fullPath = `/api${req.path}`;

  // A switch rather than a chain so every scope is decided in one place and the
  // `never` arm refuses a value the type does not know. The JWT payload is not
  // typed, so that arm is reachable at runtime: an unknown scope must deny, not
  // fall through to `next()`.
  switch (scope) {
    case 'full-admin':
      next();
      return;

    case 'read-only':
      if (req.method === 'GET') { next(); return; }
      deny(res, req, 'API token scope "read-only" only allows GET requests.', scope);
      return;

    case 'deploy-only':
      if (req.method === 'GET') { next(); return; }
      if (req.method === 'POST' && DEPLOY_ALLOWED_PATTERNS.some(p => p.test(fullPath))) {
        next();
        return;
      }
      deny(res, req, 'API token scope "deploy-only" does not allow this action.', scope);
      return;

    case 'observe-only':
      if (req.method === 'GET' && OBSERVE_ALLOWED_PATTERNS.some(p => p.test(fullPath))) {
        next();
        return;
      }
      deny(res, req, 'API token scope "observe-only" only allows the observation endpoints.', scope);
      return;

    default: {
      const unknownScope: never = scope;
      void unknownScope;
      deny(res, req, 'Unknown API token scope.', 'unknown');
      return;
    }
  }
};
