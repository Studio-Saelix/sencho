import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { NodeRegistry } from '../services/NodeRegistry';
import { DatabaseService } from '../services/DatabaseService';
import { isProxyExemptPath } from '../helpers/proxyExemptPaths';
import { sanitizeForLog } from '../utils/safeLog';

/**
 * Resolve `req.nodeId` from the `x-node-id` header, `?nodeId=` query param,
 * or the default node. Returns 404 for requests targeting a deleted node so
 * downstream handlers don't fail with obscure errors.
 *
 * `/api/nodes` is intentionally exempt so the frontend can re-sync after a
 * node is deleted (otherwise a stale `x-node-id` in localStorage triggers an
 * unrecoverable 404 loop).
 */
export const nodeContextMiddleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const nodeIdHeader = req.headers['x-node-id'] as string;
  const nodeIdQuery = req.query.nodeId as string;
  // A malformed id (parseInt → NaN, or a non-positive value) must fall back to
  // the default node rather than resolve to NaN and trip the obscure 404 below.
  // A well-formed id for a node that does not exist still 404s further down;
  // only malformed input falls through to the default.
  const parseNodeId = (raw: string | undefined): number | null => {
    if (!raw) return null;
    const n = parseInt(raw, 10);
    if (Number.isInteger(n) && n > 0) return n;
    // Present but malformed is a client bug: warn so the fall-back to the
    // default node is observable instead of a request silently landing on the
    // wrong node during debugging.
    console.warn(`[NodeContext] Ignoring malformed node id "${sanitizeForLog(raw)}"; using the default node.`);
    return null;
  };
  req.nodeId =
    parseNodeId(nodeIdHeader) ??
    parseNodeId(nodeIdQuery) ??
    NodeRegistry.getInstance().getDefaultNodeId();

  if (req.path.startsWith('/api/') && !isProxyExemptPath(req.path)) {
    const node = DatabaseService.getInstance().getNode(req.nodeId);
    if (!node) {
      res.status(404).json({ error: `Node with id ${req.nodeId} not found or was deleted.` });
      return;
    }
  }

  next();
};
