import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireAdmin } from '../middleware/tierGates';
import { rejectApiTokenScope } from '../middleware/apiTokenScope';
import {
  isConsoleSessionPath,
  mintConsoleSession,
  sanitizeActingAs,
} from '../helpers/consoleSession';

/**
 * Mint a short-lived `console_session` JWT. Used by the gateway when it
 * needs to proxy an interactive terminal (host console or container exec)
 * to a remote node: the long-lived `api_token` would be rejected by the
 * remote's upgrade handler on interactive paths, so the gateway authenticates
 * with the long-lived token, asks for this short-lived one, then forwards
 * the WS upgrade using it.
 *
 * Body:
 * - `path` (required): `host-console` | `container-exec`
 * - `acting_as` (optional): hub operator for remote audit. On node_proxy mints
 *   the body value is used (sanitized). On browser admin mints the signed-in
 *   username is stamped so a Bearer console_session cannot erase attribution.
 */
export const consoleRouter = Router();

consoleRouter.post('/console-token', authMiddleware, (req: Request, res: Response): void => {
  if (rejectApiTokenScope(req, res, 'API tokens cannot generate console tokens.')) return;
  if (!requireAdmin(req, res)) return;
  try {
    const path = req.body?.path;
    if (!isConsoleSessionPath(path)) {
      res.status(400).json({ error: 'Invalid or missing console path' });
      return;
    }
    const actingAs = req.machineAuthScope === 'node_proxy'
      ? sanitizeActingAs(req.body?.acting_as)
      : sanitizeActingAs(req.user?.username);
    res.json({ token: mintConsoleSession({ path, actingAs }) });
  } catch (error) {
    console.error('Failed to issue console token:', error);
    res.status(500).json({ error: 'Failed to issue console token' });
  }
});
