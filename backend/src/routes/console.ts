import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireAdmin } from '../middleware/tierGates';
import { rejectApiTokenScope } from '../middleware/apiTokenScope';
import { mintConsoleSession } from '../helpers/consoleSession';

/**
 * Mint a short-lived `console_session` JWT. Used by the gateway when it
 * needs to proxy an interactive terminal (host console or container exec)
 * to a remote node: the long-lived `api_token` would be rejected by the
 * remote's upgrade handler on interactive paths, so the gateway authenticates
 * with the long-lived token, asks for this short-lived one, then forwards
 * the WS upgrade using it.
 *
 * Accepts browser admin sessions and node_proxy machine credentials (the
 * remote bridge). Opaque API tokens are rejected. Available on every license
 * tier. Mint is admin/node_proxy gated; interactive Host Console WS enforces
 * system:console (or a pre-gated console_session).
 */
export const consoleRouter = Router();

consoleRouter.post('/console-token', authMiddleware, (req: Request, res: Response): void => {
  if (rejectApiTokenScope(req, res, 'API tokens cannot generate console tokens.')) return;
  if (!requireAdmin(req, res)) return;
  try {
    res.json({ token: mintConsoleSession() });
  } catch (error) {
    console.error('Failed to issue console token:', error);
    res.status(500).json({ error: 'Failed to issue console token' });
  }
});
