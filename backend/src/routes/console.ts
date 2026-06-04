import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireAdmin, requirePaid } from '../middleware/tierGates';
import { rejectApiTokenScope } from '../middleware/apiTokenScope';
import { mintConsoleSession } from '../helpers/consoleSession';

/**
 * Mint a short-lived `console_session` JWT. Used by the gateway when it
 * needs to proxy an interactive terminal (host console or container exec)
 * to a remote node: the long-lived `api_token` would be rejected by the
 * remote's upgrade handler on interactive paths, so the gateway authenticates
 * with the long-lived token, asks for this short-lived one, then forwards
 * the WS upgrade using it.
 */
export const consoleRouter = Router();

consoleRouter.post('/console-token', authMiddleware, (req: Request, res: Response): void => {
  if (rejectApiTokenScope(req, res, 'API tokens cannot generate console tokens.')) return;
  if (!requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  try {
    res.json({ token: mintConsoleSession() });
  } catch (error) {
    console.error('Failed to issue console token:', error);
    res.status(500).json({ error: 'Failed to issue console token' });
  }
});
