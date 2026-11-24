import { Router, type NextFunction, type Request, type Response } from 'express';

import { getOrCreateSealingKey } from '../helpers/registryEnvelopeSeal';
import { openSecret } from '../helpers/sealedSecretSeal';
import { requireHubBackgroundCall } from '../middleware/hubBackgroundCall';
import { DatabaseService } from '../services/DatabaseService';
import { recordSealedSecretAudit } from '../services/sealedSecrets/audit';
import { isSealedSecretError, SealedSecretError } from '../services/sealedSecrets/errors';
import { isSealedSecretPurpose, isValidSlot, type SealedSecretPurposeId } from '../services/sealedSecrets/purposes';
import { SealedSecretStore } from '../services/sealedSecrets/SealedSecretStore';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';

/**
 * Node side of sealed secret delivery. Every route answers only the hub's own
 * background call (a machine bearer with no forwarded role header); the hub
 * also refuses to forward a user request to this prefix. No route returns a
 * secret value.
 */
export const sealedSecretsRouter = Router();

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR_MAX = 200;

sealedSecretsRouter.use((req: Request, res: Response, next) => {
  if (requireHubBackgroundCall(req, res)) next();
});

function deliverySourceId(): string {
  const id = DatabaseService.getInstance().getGlobalSettings().delivery_source_id;
  if (!id) throw new SealedSecretError('SECRET_STORE_UNAVAILABLE', 503, 'This node has no delivery source id yet.');
  return id;
}

function sendError(res: Response, error: unknown, context: string): void {
  if (isSealedSecretError(error)) {
    res.status(error.status).json({ error: error.message, code: error.code, ...error.details });
    return;
  }
  console.error(`[SealedSecrets] ${context} failed:`, sanitizeForLog(getErrorMessage(error, 'unknown')));
  res.status(500).json({ error: 'The node could not complete the sealed secret request.' });
}

function parsePurpose(value: unknown): SealedSecretPurposeId {
  if (!isSealedSecretPurpose(value)) {
    throw new SealedSecretError('SEALED_SECRET_PURPOSE_UNKNOWN', 400, 'This node does not know that sealed secret purpose.');
  }
  return value;
}

function parseSlot(purpose: SealedSecretPurposeId, value: unknown): string {
  if (!isValidSlot(purpose, value)) {
    throw new SealedSecretError('SEALED_SECRET_SLOT_INVALID', 400, 'The secret id is not valid for this purpose.');
  }
  return value;
}

function invalid(message: string): SealedSecretError {
  return new SealedSecretError('SEALED_SECRET_REQUEST_INVALID', 400, message);
}

function parseGeneration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw invalid('generation must be a positive integer.');
  return value;
}

function parseOperationId(value: unknown): string {
  if (typeof value !== 'string' || !OPERATION_ID.test(value)) throw invalid('operationId must be a UUID.');
  return value;
}

function parseActor(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > ACTOR_MAX) throw invalid('actor is required.');
  return value.trim();
}

function bodyOf(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null ? req.body as Record<string, unknown> : {};
}

sealedSecretsRouter.get('/key', (_req: Request, res: Response) => {
  try {
    const key = getOrCreateSealingKey();
    res.set('Cache-Control', 'no-store');
    res.json({ publicKey: key.publicKeyBase64, fingerprint: key.fingerprint, deliverySourceId: deliverySourceId() });
  } catch (error: unknown) {
    sendError(res, error, 'Key read');
  }
});

sealedSecretsRouter.get('/', (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-store');
  res.json({ items: SealedSecretStore.getInstance().list() });
});

sealedSecretsRouter.get('/:purpose/:slot', (req: Request, res: Response) => {
  try {
    const purpose = parsePurpose(req.params.purpose);
    const slot = parseSlot(purpose, req.params.slot);
    res.set('Cache-Control', 'no-store');
    res.json(SealedSecretStore.getInstance().describe(purpose, slot));
  } catch (error: unknown) {
    sendError(res, error, 'Describe');
  }
});

const BODY_LIMIT_BYTES = 16 * 1024;

/** A sealed body is small; refuse anything larger than the prefix allows. */
function smallJson(req: Request, res: Response, next: NextFunction): void {
  if ((req.rawBody?.length ?? 0) > BODY_LIMIT_BYTES) {
    res.status(413).json({ error: 'Sealed secret request body is too large.', code: 'SEALED_SECRET_REQUEST_INVALID' });
    return;
  }
  next();
}

sealedSecretsRouter.post('/:purpose', smallJson, async (req: Request, res: Response) => {
  const body = bodyOf(req);
  try {
    const purpose = parsePurpose(req.params.purpose);
    const slot = parseSlot(purpose, body.slot);
    const generation = parseGeneration(body.generation);
    const operationId = parseOperationId(body.operationId);
    const actor = parseActor(body.actor);
    let secret: string;
    try {
      secret = openSecret(body.sealed, { purpose, deliverySourceId: deliverySourceId(), slot, generation, operationId });
    } catch (error: unknown) {
      if (isSealedSecretError(error)) throw error;
      recordSealedSecretAudit('sealed_secret.refused', { purpose, slot, generation, actor, reason: 'open_failed' }, {
        username: actor, path: req.originalUrl, method: req.method, statusCode: 422,
      });
      throw new SealedSecretError('SEALED_SECRET_OPEN_FAILED', 422, 'This node could not open the sealed secret. Its sealing key may have changed.');
    }
    const result = await SealedSecretStore.getInstance().accept(purpose, slot, generation, secret, {
      actor, path: req.originalUrl, method: req.method,
    });
    res.json(result);
  } catch (error: unknown) {
    sendError(res, error, 'Accept');
  }
});

sealedSecretsRouter.delete('/:purpose/:slot', smallJson, async (req: Request, res: Response) => {
  const body = bodyOf(req);
  try {
    const purpose = parsePurpose(req.params.purpose);
    const slot = parseSlot(purpose, req.params.slot);
    const generation = parseGeneration(body.generation);
    parseOperationId(body.operationId);
    const actor = parseActor(body.actor);
    const result = await SealedSecretStore.getInstance().remove(purpose, slot, generation, {
      actor, path: req.originalUrl, method: req.method,
    });
    res.json(result);
  } catch (error: unknown) {
    sendError(res, error, 'Remove');
  }
});

sealedSecretsRouter.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});
