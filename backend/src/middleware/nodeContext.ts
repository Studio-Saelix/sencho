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
 *
 * A sealed-secret path is exempt too: this instance serves it itself, so it
 * takes this instance's local node id and skips the default-node resolution
 * and the deleted-node check. With no local node row (zero-local recovery)
 * `req.nodeId` is deliberately left unset; sealed-secret handlers and the
 * audit log already read it defensively, and the store answers unavailable.
 */
export const nodeContextMiddleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  if (isSealedSecretPath(req.path)) {
    // A sealed secret request belongs to this instance's own local node, never
    // to a node it names or to the default node. An instance with no local
    // node row (zero-local recovery) leaves req.nodeId unset: falling back to
    // the default would decrypt a remote node's credential, and the store
    // answers 503 SECRET_STORE_UNAVAILABLE for that state itself.
    const localNodeId = NodeRegistry.getInstance().getLocalNodeId();
    if (localNodeId !== null) req.nodeId = localNodeId;
    next();
    return;
  }

  req.nodeId = resolveNodeId(req, { warnOnMalformed: true });

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
