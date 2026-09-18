import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requirePermission } from '../middleware/permissions';
import { buildPolicyGateOptions } from '../helpers/policyGate';
import { REGISTRY_DELIVERY_BODY_FIELD } from '../helpers/registryDeliveryBodyLimits';
import { invalidateFleetUpdateCache } from '../helpers/fleetUpdateCache';
import { isValidStackName } from '../utils/validation';
import { ImageUpdateFactsService, ImageUpdateFactsError } from '../services/ImageUpdateFactsService';
import { ImageUpdateObservationService, ImageUpdateObservationError } from '../services/ImageUpdateObservationService';
import { hashImageUpdateFacts, IMAGE_UPDATE_FACTS_IMAGE_LIMIT } from '../services/imageUpdateFacts';
import { applyAutomaticStackUpdate } from '../services/automaticStackUpdate';
import { skippedVerification } from '../services/hubPostUpdateVerification';

interface CheckedUpdateRequest {
  contractVersion: 1;
  stack: string;
  digestUpdateImages: string[];
  observationToken: string;
}

function parseCheckedRequest(body: unknown): CheckedUpdateRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(key => !['contractVersion', 'stack', 'digestUpdateImages', 'observationToken', REGISTRY_DELIVERY_BODY_FIELD].includes(key))) return null;
  if (value.contractVersion !== 1 || typeof value.stack !== 'string' || !isValidStackName(value.stack)
    || typeof value.observationToken !== 'string' || !value.observationToken || value.observationToken.length > 4096
    || !Array.isArray(value.digestUpdateImages) || value.digestUpdateImages.length === 0
    || value.digestUpdateImages.length > IMAGE_UPDATE_FACTS_IMAGE_LIMIT
    || !value.digestUpdateImages.every((ref): ref is string => typeof ref === 'string' && ref.length > 0 && ref.length <= 2048)
    || new Set(value.digestUpdateImages).size !== value.digestUpdateImages.length) return null;
  return { contractVersion: 1, stack: value.stack, observationToken: value.observationToken, digestUpdateImages: value.digestUpdateImages };
}

export const checkedAutoUpdateRouter = Router();

checkedAutoUpdateRouter.post('/execute-checked', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (req.machineAuthScope !== 'node_proxy' && req.machineAuthScope !== 'pilot_tunnel') {
    res.status(403).json({ error: 'Machine authentication required' });
    return;
  }
  const input = parseCheckedRequest(req.body);
  if (!input) {
    res.status(400).json({ error: 'Invalid checked automatic update request' });
    return;
  }
  if (!requirePermission(req, res, 'stack:deploy', 'stack', input.stack, req.nodeId)) return;
  const envelope = { contractVersion: 1, stack: input.stack, applied: false, healthGateId: null, verification: skippedVerification() };
  try {
    const factsService = ImageUpdateFactsService.getInstance();
    const observations = ImageUpdateObservationService.getInstance();
    const verifyFacts = async (): Promise<string> => {
      const binding = observations.verifyCurrent(input.observationToken, { stack: input.stack });
      const facts = await factsService.readLocal(req.nodeId, input.stack);
      const hash = hashImageUpdateFacts(facts);
      if (!facts.model.renderable || binding.factsHash !== hash
        || input.digestUpdateImages.some(ref => !facts.images.some(image => image.ref === ref) || ref.includes('@'))) {
        throw new ImageUpdateObservationError('IMAGE_UPDATE_OBSERVATION_STALE', 409);
      }
      return hash;
    };
    const result = await applyAutomaticStackUpdate({
      nodeId: req.nodeId, stackName: input.stack, updatedImages: input.digestUpdateImages,
      policyOptions: buildPolicyGateOptions(req, { bypass: false, actor: `auto-update:${req.user?.username ?? 'scheduler'}` }),
      verificationOwner: 'hub_authority',
      observation: {
        verify: async () => { await verifyFacts(); },
        consume: async () => {
          const factsHash = await verifyFacts();
          observations.consumeCurrent(input.observationToken, { stack: input.stack, factsHash });
        },
      },
    });
    if (result.applied) invalidateFleetUpdateCache();
    res.json({ ...envelope, result: result.result, applied: result.applied, healthGateId: result.healthGateId });
  } catch (error) {
    if (error instanceof ImageUpdateObservationError) {
      res.status(error.status).json({ ...envelope, result: error.code === 'IMAGE_UPDATE_OBSERVATION_STALE' ? 'stale_observation' : 'rejected', code: error.code });
      return;
    }
    if (error instanceof ImageUpdateFactsError) {
      res.status(error.status).json({ ...envelope, result: 'rejected', code: error.code });
      return;
    }
    console.error('[AutoUpdate] Checked automatic update failed:', error);
    res.status(500).json({ ...envelope, result: 'rejected', error: 'Checked automatic update failed' });
  }
});
