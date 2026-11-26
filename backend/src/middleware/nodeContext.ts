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
 * `req.nodeId` is 0, which is not a node id; the audit log records it as no
 * node. The sealed-secret handlers do not read it: key reads the sealing key
 * and the database, list and describe read the database, and a write or
 * removal that needs the storage daemon answers 503
 * SECRET_STORE_UNAVAILABLE.
 */
export const nodeContextMiddleware: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  if (isSealedSecretPath(req.path)) {
    // A sealed secret request belongs to this instance's own local node, never
    // to a node it names or to the default node. An instance with no local
    // node row (zero-local recovery) records 0: falling back to the default
    // would decrypt a remote node's credential, and the store answers 503
    // SECRET_STORE_UNAVAILABLE for that state itself.
    req.nodeId = NodeRegistry.getInstance().getLocalNodeId() ?? 0;
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
