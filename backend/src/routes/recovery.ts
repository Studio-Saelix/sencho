import { Router, type Request, type Response } from 'express';
import { requirePermission } from '../middleware/permissions';
import { buildLocalRecoveryNodeDescriptor } from '../services/recovery/capability';
import { operationIdFromRequest } from '../services/recovery/dispatcher';
import { errorMessageForLog } from '../utils/safeLog';

export const recoveryRouter = Router();

/**
 * This node's recovery descriptor: the contract version it speaks and whether
 * it can protect volumes. The hub reads it over the node proxy or the Pilot
 * tunnel to resolve version skew; a node that predates the route answers 404,
 * which the hub reads as "update required".
 *
 * Guarded by `stack:read`, like the other node-local slices the hub fans out
 * to: the payload is metadata about this node's capability and names no stack,
 * path, repository or key. The operation id a dispatch sent is echoed back so
 * the hub can tell this answer belongs to its request.
 */
recoveryRouter.get('/node', (req: Request, res: Response): void => {
  if (!requirePermission(req, res, 'stack:read')) return;
  try {
    res.json({ ...buildLocalRecoveryNodeDescriptor(), operationId: operationIdFromRequest(req) });
  } catch (error) {
    console.error('Recovery: node descriptor failed:', errorMessageForLog(error));
    res.status(500).json({ error: 'Could not read this node\'s recovery status' });
  }
});
