import { Router, type Request, type Response } from 'express';
import { requireAdmin } from '../middleware/tierGates';
import { StackActivityMetricsService } from '../services/StackActivityMetricsService';

export const stackActivityMetricsRouter = Router();

/**
 * Admin-only snapshot of in-process stack activity metrics. No external
 * export: this endpoint exists so an operator debugging "why is the
 * activity tab slow?" or "are we logging unexpected error rates on the
 * dispatch path?" can pull per-(nodeId, op) counts and latencies without
 * scrolling logs.
 *
 * Mounted at /api/stack-activity-metrics after the global authGate.
 */
stackActivityMetricsRouter.get('/', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  res.json(StackActivityMetricsService.getInstance().snapshot());
});
