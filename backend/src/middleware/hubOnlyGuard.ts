import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { NodeRegistry } from '../services/NodeRegistry';
import { isHubOnlyPath } from '../helpers/proxyExemptPaths';

/**
 * Reject hub-only API requests whose `req.nodeId` resolves to a remote node.
 *
 * The hub-level views in the frontend (Schedules, Audit, Notification
 * Routing config, etc.) are hidden from the nav strip when the active node
 * is remote, so a normal user never reaches these endpoints with a remote
 * nodeId. A scripted client could still craft `x-node-id: <remote>` against
 * one of these paths; without this guard, the request would be forwarded
 * by `remoteNodeProxy` and processed on the remote as if it were local,
 * silently crossing a node-authority boundary that the UI promised would
 * not happen.
 *
 * Mounted at `/api` between `nodeContextMiddleware` (which sets req.nodeId)
 * and `createRemoteProxyMiddleware` (which would otherwise forward the
 * request). Rejects with 403 — the endpoint exists but the request cannot
 * be served as routed.
 *
 * Returns 403 only for hub-only paths; non-hub paths fall through.
 */
export const hubOnlyGuard: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  if (!isHubOnlyPath(`/api${req.path}`)) {
    next();
    return;
  }
  const node = NodeRegistry.getInstance().getNode(req.nodeId);
  if (node?.type === 'remote') {
    res.status(403).json({
      error: 'This endpoint is hub-only and cannot be proxied to a remote node. Switch the active node back to your local hub.',
      code: 'HUB_ONLY_ENDPOINT',
    });
    return;
  }
  next();
};
