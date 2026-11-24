import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { DatabaseService } from '../services/DatabaseService';
import { isProxyExemptPath, isSealedSecretPath } from '../helpers/proxyExemptPaths';
import { NodeRegistry } from '../services/NodeRegistry';
import { resolveNodeId } from '../helpers/resolveNodeId';

/**
 * Resolve `req.nodeId` from the `x-node-id` header, `?nodeId=` query param,
 * or the default node (see `helpers/resolveNodeId.ts`). Returns 404 for
 * requests targeting a deleted node so downstream handlers don't fail with
 * obscure errors.
 *
 * `/api/nodes` is intentionally exempt so the frontend can re-sync after a
 * node is deleted (otherwise a stale `x-node-id` in localStorage triggers an
 * unrecoverable 404 loop).
 */
export const nodeContextMiddleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const localNodeId = isSealedSecretPath(req.path) ? NodeRegistry.getInstance().getLocalNodeId() : null;
  req.nodeId = localNodeId ?? resolveNodeId(req, { warnOnMalformed: true });

  if (req.path.startsWith('/api/') && !isProxyExemptPath(req.path)) {
    const node = DatabaseService.getInstance().getNode(req.nodeId);
    if (!node) {
      res.status(404).json({
        error: `Node with id ${req.nodeId} not found or was deleted.`,
        code: 'NODE_NOT_FOUND',
      });
      return;
    }
  }

  next();
};
