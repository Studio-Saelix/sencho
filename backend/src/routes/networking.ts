import { Router, type Request, type Response } from 'express';
import { computeNodeNetworkingSummary } from '../services/network/networkingSummary';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';

export const networkingRouter = Router();

// Node-local networking summary for the Fleet view filter. Auth-only and
// read-only (Community). The fleet aggregate computes the hub's summary by
// calling the underlying service in-process and reaches each remote through
// this route, so a remote is summarized on the node that owns its stacks.
networkingRouter.get('/summary', async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await computeNodeNetworkingSummary(req.nodeId));
  } catch (error) {
    console.error('[Networking] Failed to build node summary:', sanitizeForLog(getErrorMessage(error, 'unknown')));
    res.status(500).json({ error: 'Failed to build networking summary' });
  }
});
