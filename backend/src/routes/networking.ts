import { Router, type Request, type Response } from 'express';
import { requirePermission } from '../middleware/permissions';
import { computeNodeNetworkingSummary } from '../services/network/networkingSummary';
import {
  buildNodeNetworkingAggregate,
  loadNetworkingSnapshot,
} from '../services/network/networkingAggregate';
import DockerController from '../services/DockerController';
import { findSnapshotNetwork, sanitizeNetworkInspect } from '../services/network/sanitizeNetworkInspect';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';
import { isValidDockerResourceId } from '../utils/validation';
import { okEnvelope, runtimeUnavailableEnvelope } from '../services/network/networkingEnvelope';

export const networkingRouter = Router();

// Node-local networking summary for the Fleet view filter. Auth-only and
// read-only (Community). The fleet aggregate computes the hub's summary by
// calling the underlying service in-process and reaches each remote through
// this route, so a remote is summarized on the node that owns its stacks.
networkingRouter.get('/summary', async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'node:read')) return;
  try {
    res.json(await computeNodeNetworkingSummary(req.nodeId));
  } catch (error) {
    console.error('[Networking] Failed to build node summary:', sanitizeForLog(getErrorMessage(error, 'unknown')));
    res.status(500).json({ error: 'Failed to build networking summary' });
  }
});

networkingRouter.get('/overview', async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'node:read')) return;
  try {
    const aggregate = await buildNodeNetworkingAggregate(req.nodeId, {});
    res.json(okEnvelope(aggregate.runtimeAvailable, {
      overview: aggregate.overview,
      networks: aggregate.networks,
      findings: aggregate.findings,
      recentActivity: aggregate.recentActivity,
    }));
  } catch (error) {
    console.error('[Networking] Failed to build overview:', sanitizeForLog(getErrorMessage(error, 'unknown')));
    res.status(500).json({ error: 'Failed to build networking overview' });
  }
});

networkingRouter.get('/networks', async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'node:read')) return;
  try {
    const aggregate = await buildNodeNetworkingAggregate(req.nodeId, {});
    res.json(okEnvelope(aggregate.runtimeAvailable, { networks: aggregate.networks }));
  } catch (error) {
    console.error('[Networking] Failed to list networks:', sanitizeForLog(getErrorMessage(error, 'unknown')));
    res.status(500).json({ error: 'Failed to list networks' });
  }
});

networkingRouter.get('/networks/:id', async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'node:read')) return;
  const id = req.params.id as string;
  if (!id || (!isValidDockerResourceId(id) && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id))) {
    res.status(400).json({ error: 'Invalid network ID format' });
    return;
  }
  try {
    const { snapshot } = await loadNetworkingSnapshot(req.nodeId);
    if (!snapshot) {
      res.status(503).json(runtimeUnavailableEnvelope());
      return;
    }
    const snapNet = findSnapshotNetwork(snapshot, id);
    const raw = await DockerController.getInstance(req.nodeId).inspectNetwork(snapNet?.id ?? id);
    res.json(okEnvelope(true, { network: sanitizeNetworkInspect(raw, snapNet, snapshot) }));
  } catch (error: unknown) {
    console.error('[Networking] Failed to inspect network:', sanitizeForLog(getErrorMessage(error, 'unknown')));
    const statusCode = (error as { statusCode?: number }).statusCode;
    const is404 = statusCode === 404
      || (error instanceof Error && error.message.includes('404'));
    res.status(is404 ? 404 : 500).json({
      error: is404 ? 'Network not found' : 'Failed to inspect network',
    });
  }
});

networkingRouter.get('/topology', async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'node:read')) return;
  const includeSystem = req.query.includeSystem === 'true';
  try {
    const aggregate = await buildNodeNetworkingAggregate(req.nodeId, {
      includeTopology: true,
      includeSystem,
    });
    res.json(okEnvelope(aggregate.runtimeAvailable, {
      networks: aggregate.topology?.networks ?? [],
      includeSystem,
    }));
  } catch (error) {
    console.error('[Networking] Failed to build topology:', sanitizeForLog(getErrorMessage(error, 'unknown')));
    res.status(500).json({ error: 'Failed to build networking topology' });
  }
});

networkingRouter.get('/findings', async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'node:read')) return;
  try {
    const aggregate = await buildNodeNetworkingAggregate(req.nodeId, {});
    res.json(okEnvelope(aggregate.runtimeAvailable, { findings: aggregate.findings }));
  } catch (error) {
    console.error('[Networking] Failed to list findings:', sanitizeForLog(getErrorMessage(error, 'unknown')));
    res.status(500).json({ error: 'Failed to list networking findings' });
  }
});

networkingRouter.get('/findings/:id', async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'node:read')) return;
  const findingId = req.params.id as string;
  if (!findingId) {
    res.status(400).json({ error: 'Finding ID is required' });
    return;
  }
  try {
    const aggregate = await buildNodeNetworkingAggregate(req.nodeId, {});
    const match = aggregate.findings.find(f => f.id === findingId);
    if (!match) {
      res.status(404).json({ error: 'Finding not found' });
      return;
    }
    res.json(okEnvelope(aggregate.runtimeAvailable, { finding: match }));
  } catch (error) {
    console.error('[Networking] Failed to load finding:', sanitizeForLog(getErrorMessage(error, 'unknown')));
    res.status(500).json({ error: 'Failed to load networking finding' });
  }
});
