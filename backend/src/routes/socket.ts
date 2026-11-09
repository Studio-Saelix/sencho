import { Router, type Request, type Response } from 'express';
import { requirePermission } from '../middleware/permissions';
import {
  loadSocketInventory,
  parseSocketNodeIdentity,
  SocketInventoryUnavailableError,
  type SocketNodeIdentity,
} from '../services/socket/SocketInventoryService';
import { PROXY_NODE_IDENTITY_HEADER } from '../services/license-headers';
import { withTimeout, TimeoutError } from '../utils/withTimeout';
import { errorMessageForLog } from '../utils/safeLog';

/**
 * The target node identity a hub attached to this proxied read, or null.
 *
 * A remote numbers its own nodes from one, so it cannot know the hub's id and
 * name for the node that was selected. Only a node-to-node hop may state it;
 * a browser or API client cannot, and a malformed value is ignored rather than
 * partly applied.
 */
function proxiedNodeIdentity(req: Request): SocketNodeIdentity | null {
  if (!req.machineAuthScope) return null;
  const raw = req.headers[PROXY_NODE_IDENTITY_HEADER];
  if (typeof raw !== 'string') return null;
  const identity = parseSocketNodeIdentity(raw);
  if (!identity) {
    // Falling back to the local identity is safe but wrong-scoped; say so
    // rather than letting a hub bug read as a correct answer. Only the length
    // is logged, since the value is untrusted.
    console.warn(
      '[Socket] Ignoring a malformed node identity header on a machine hop (length %d).',
      raw.length,
    );
  }
  return identity;
}

/** Bound on one node's discovery read so a hung Docker socket cannot pin a request. */
export const SOCKET_INVENTORY_TIMEOUT_MS = 15_000;

export const socketRouter = Router();

/**
 * Read-only Docker socket access inventory for the request's node.
 *
 * The response is produced by the node that owns the Docker daemon. That node
 * numbers its own nodes from one, so a proxied read reports the target identity
 * the hub attached to the hop while `instanceIdentity` stays the producing
 * instance's own. A Docker read failure answers 503 and a timeout answers 504;
 * an empty 200 is only ever "discovery completed", never "no Docker access".
 */
socketRouter.get('/inventory', async (req: Request, res: Response): Promise<void> => {
  // Authorize the exact target node: a global Deployer with a Node Admin
  // assignment on this node holds node:read through that grant, and the shared
  // engine only sees scoped assignments when the resource is supplied.
  if (!requirePermission(req, res, 'node:read', 'node', String(req.nodeId))) return;
  try {
    const inventory = await withTimeout(
      loadSocketInventory(req.nodeId, undefined, proxiedNodeIdentity(req)),
      SOCKET_INVENTORY_TIMEOUT_MS,
      'socket inventory',
    );
    res.json(inventory);
  } catch (error) {
    if (error instanceof TimeoutError) {
      console.warn('[Socket] Inventory timed out on node %d', req.nodeId);
      res.status(504).json({
        error: 'Reading the Docker socket inventory on this node timed out.',
        code: 'SOCKET_INVENTORY_TIMEOUT',
      });
      return;
    }
    if (error instanceof SocketInventoryUnavailableError) {
      console.error(
        '[Socket] Inventory unavailable on node %d: %s',
        req.nodeId,
        errorMessageForLog(error),
      );
      res.status(503).json({
        error: 'Docker is unavailable on this node, so its socket inventory could not be read.',
        code: 'DOCKER_UNAVAILABLE',
      });
      return;
    }
    console.error(
      '[Socket] Inventory failed on node %d: %s',
      req.nodeId,
      errorMessageForLog(error),
    );
    res.status(500).json({ error: 'Failed to read the Docker socket inventory.' });
  }
});
