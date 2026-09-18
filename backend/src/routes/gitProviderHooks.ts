import { Router, type Request, type Response } from 'express';
import { NodeRegistry } from '../services/NodeRegistry';
import { ProviderWebhookService } from '../services/gitops/providerWebhooks/ProviderWebhookService';
import { PROVIDER_WEBHOOK_BODY_LIMIT } from '../services/gitops/providerWebhooks/types';
import { gitProviderHookIngestLimiter } from '../middleware/rateLimiters';

export const gitProviderHooksRouter = Router();

function respondIngest(res: Response, outcome: Awaited<ReturnType<ProviderWebhookService['ingestLocal']>>): void {
  if (outcome.httpStatus === 404) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (outcome.httpStatus === 413) {
    res.status(413).json({ error: outcome.message ?? 'Payload too large' });
    return;
  }
  if (outcome.httpStatus === 429) {
    res.status(429).json({ error: outcome.message ?? 'Rate limited' });
    return;
  }
  res.status(outcome.httpStatus).json({
    state: outcome.state,
    message: outcome.message,
  });
}

gitProviderHooksRouter.post(
  '/hooks/:nodeId/:endpointId',
  gitProviderHookIngestLimiter,
  async (req: Request, res: Response): Promise<void> => {
    try {
      if (req.rawBody && req.rawBody.length > PROVIDER_WEBHOOK_BODY_LIMIT) {
        res.status(413).json({ error: 'Payload too large' });
        return;
      }
      const nodeId = parseInt(req.params.nodeId as string, 10);
      const endpointId = req.params.endpointId as string;
      if (!Number.isInteger(nodeId) || nodeId <= 0 || !NodeRegistry.getInstance().getNode(nodeId)) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const node = NodeRegistry.getInstance().getNode(nodeId)!;
      const svc = ProviderWebhookService.getInstance();
      const rawBody = req.rawBody ?? Buffer.alloc(0);
      const outcome = node.type === 'remote'
        ? await svc.forwardToRemoteNode({ nodeId, endpointId, rawBody, headers: req.headers })
        : await svc.ingestLocal({ endpointId, rawBody, headers: req.headers });
      respondIngest(res, outcome);
    } catch (error) {
      console.error('[GitProviderHooks] Public ingest error:', error);
      res.status(500).json({ error: 'Failed to process provider hook' });
    }
  },
);

gitProviderHooksRouter.post('/internal/hooks/:endpointId', async (req: Request, res: Response): Promise<void> => {
  if (req.machineAuthScope !== 'node_proxy' && req.machineAuthScope !== 'pilot_tunnel') {
    res.status(403).json({ error: 'Machine authentication required' });
    return;
  }
  try {
    if (req.rawBody && req.rawBody.length > PROVIDER_WEBHOOK_BODY_LIMIT) {
      res.status(413).json({ error: 'Payload too large' });
      return;
    }
    const outcome = await ProviderWebhookService.getInstance().ingestLocal({
      endpointId: req.params.endpointId as string,
      rawBody: req.rawBody ?? Buffer.alloc(0),
      headers: req.headers,
    });
    respondIngest(res, outcome);
  } catch (error) {
    console.error('[GitProviderHooks] Internal ingest error:', error);
    res.status(500).json({ error: 'Failed to process provider hook' });
  }
});
