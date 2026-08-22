import { Router, type Request, type Response } from 'express';
import { requireAdmin } from '../middleware/tierGates';
import { GitOpsMetricsService } from '../services/GitOpsMetricsService';

export const gitopsMetricsRouter = Router();

/**
 * Admin-only snapshot of in-process GitOps transition counters.
 *
 * Instance-local rather than hub-only, so selecting a node answers with that
 * node's counters: the transitions being counted happen wherever the stack
 * lives, and a hub-only reading would report the hub's own activity under
 * every node's name.
 *
 * Mounted at /api/gitops-metrics after the global auth gate, alongside
 * /api/stack-metrics, which this mirrors. Admin rather than an operational
 * permission for the same reason that one is: these are process diagnostics
 * about the instance, not a record of any one stack's work, so there is no
 * stack or node to scope a grant against.
 */
gitopsMetricsRouter.get('/', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  res.json({ entries: GitOpsMetricsService.getInstance().snapshot() });
});
