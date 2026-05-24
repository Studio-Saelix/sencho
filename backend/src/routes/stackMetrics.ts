import { Router, type Request, type Response } from 'express';
import { requireAdmin } from '../middleware/tierGates';
import { StackOpMetricsService } from '../services/StackOpMetricsService';

export const stackMetricsRouter = Router();

/**
 * Admin-only snapshot of in-process stack lifecycle metrics. No external
 * export: this endpoint exists so an operator debugging "why is this remote
 * node slow today?" can pull per-(nodeId, action) counts and latencies
 * without scrolling logs.
 *
 * Mounted at /api/stack-metrics after the global authGate, so it inherits
 * the standard session/Bearer auth surface like every other authed route.
 */
stackMetricsRouter.get('/', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  res.json({ entries: StackOpMetricsService.getInstance().snapshot() });
});
