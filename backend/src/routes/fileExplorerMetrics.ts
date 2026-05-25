import { Router, type Request, type Response } from 'express';
import { requireAdmin } from '../middleware/tierGates';
import { FileExplorerMetricsService } from '../services/FileExplorerMetricsService';

export const fileExplorerMetricsRouter = Router();

/**
 * Admin-only snapshot of in-process stack file explorer metrics. No external
 * export: this endpoint exists so an operator debugging "why is the file
 * editor slow on this node?" can pull per-(nodeId, op) counts and latencies
 * without scrolling logs.
 *
 * Mounted at /api/file-explorer-metrics after the global authGate, so it
 * inherits the standard session/Bearer auth surface like every other authed
 * route.
 */
fileExplorerMetricsRouter.get('/', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  res.json(FileExplorerMetricsService.getInstance().snapshot());
});
