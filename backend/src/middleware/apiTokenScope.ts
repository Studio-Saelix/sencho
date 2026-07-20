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

const deny = (res: Response, req: Request, error: string, scope: ApiTokenScope | 'unknown'): void => {
  if (isDebugEnabled()) console.log('[ApiTokenScope:diag] Denied:', sanitizeForLog(req.method), sanitizeForLog(req.path), 'scope:', scope);
  res.status(403).json({ error, code: 'SCOPE_DENIED' });
};

export const enforceApiTokenScope: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
  const scope = req.apiTokenScope;
  if (!scope) { next(); return; } // Not an API token request
  if (isDebugEnabled()) console.log('[ApiTokenScope:diag]', sanitizeForLog(req.method), sanitizeForLog(req.path), 'scope:', scope);
  if (scope === 'full-admin') { next(); return; }

  if (scope === 'read-only') {
    if (req.method === 'GET') { next(); return; }
    deny(res, req, 'API token scope "read-only" only allows GET requests.', scope);
    return;
  }

  if (scope === 'deploy-only') {
    if (req.method === 'GET') { next(); return; }
    const fullPath = `/api${req.path}`;
    if (req.method === 'POST' && DEPLOY_ALLOWED_PATTERNS.some(p => p.test(fullPath))) {
      next();
      return;
    }
    deny(res, req, 'API token scope "deploy-only" does not allow this action.', scope);
    return;
  }

  deny(res, req, 'Unknown API token scope.', 'unknown');
};
