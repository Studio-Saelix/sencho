import { Router, type Request, type Response } from 'express';
import { requirePermission } from '../middleware/permissions';
import {
  loadSocketInventory,
  SocketInventoryUnavailableError,
} from '../services/socket/SocketInventoryService';
import { withTimeout, TimeoutError } from '../utils/withTimeout';
import { errorMessageForLog } from '../utils/safeLog';

/** Bound on one node's discovery read so a hung Docker socket cannot pin a request. */
export const SOCKET_INVENTORY_TIMEOUT_MS = 15_000;

export const socketRouter = Router();

/**
 * Read-only Docker socket access inventory for the request's node.
 *
 * The response is produced by the node that owns the Docker daemon, so the
 * ordinary remote proxy serves a remote node without the hub relabelling it.
 * A Docker read failure answers 503 and a timeout answers 504; an empty 200 is
 * only ever "discovery completed", never "no Docker access".
 */
socketRouter.get('/inventory', async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'node:read')) return;
  try {
    const inventory = await withTimeout(
      loadSocketInventory(req.nodeId),
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
