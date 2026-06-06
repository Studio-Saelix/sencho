import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { DatabaseService } from '../services/DatabaseService';
import { buildLocalGraph } from '../services/DependencyGraphService';

export const dependencyMapRouter = Router();

/**
 * Per-node dependency graph. Auth-only (never tier-gated) so the hub's
 * fleet-wide fan-out can reach this route on every node, including Community
 * remotes. Served against the local Docker of whichever node handles it.
 */
dependencyMapRouter.get('/node-graph', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const nodeId = req.nodeId;
    const name = DatabaseService.getInstance().getNodes().find((n) => n.id === nodeId)?.name ?? 'This node';
    const graph = await buildLocalGraph(nodeId, name);
    res.json(graph);
  } catch (error) {
    console.error('[DependencyMap] node-graph error:', error);
    res.status(500).json({ error: 'Failed to build dependency graph' });
  }
});
