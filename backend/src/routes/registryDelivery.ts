import { Router, type Request, type Response } from 'express';
import { RegistryDeliveryService } from '../services/RegistryDeliveryService';
import { PreparedSourceStore } from '../services/preparedSourceStore';
import { listRegistryDeliveryEvidencePage } from '../helpers/registryDeliveryEvidence';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';

export const registryDeliveryRouter = Router();

registryDeliveryRouter.post('/discover', async (req: Request, res: Response) => {
  try {
  if (req.machineAuthScope !== 'node_proxy' && req.machineAuthScope !== 'pilot_tunnel') {
    res.status(403).json({ error: 'Machine authentication required' });
    return;
  }

    const service = RegistryDeliveryService.getInstance();
    const result = await service.discoverOnTarget(req.body);
    res.json(result);
  } catch (error) {
    console.error('[registry-delivery] discover failed:', sanitizeForLog(getErrorMessage(error, 'unknown')));
    res.status(500).json({ error: 'Registry delivery discovery failed' });
  }
});

registryDeliveryRouter.get('/evidence', (req: Request, res: Response) => {
  if (req.machineAuthScope !== 'node_proxy' && req.machineAuthScope !== 'pilot_tunnel') {
    res.status(403).json({ error: 'Machine authentication required' });
    return;
  }

  const service = RegistryDeliveryService.getInstance();
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 500);
  const cursor = Math.max(parseInt(String(req.query.cursor ?? '0'), 10) || 0, 0);
  const deliverySourceId = service.getDeliverySourceId();

  res.json(listRegistryDeliveryEvidencePage(deliverySourceId, cursor, limit));
});

registryDeliveryRouter.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Configure prepared-source store at module load when delivery source id exists.
try {
  const deliverySourceId = RegistryDeliveryService.getInstance().getDeliverySourceId();
  PreparedSourceStore.getInstance().configure(deliverySourceId);
} catch {
  /* configured on first use */
}
