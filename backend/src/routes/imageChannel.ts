import { Router, type Request, type Response } from 'express';
import { rejectApiTokenScope } from '../middleware/apiTokenScope';
import { requireAdmin, requirePaid, requireUserSession } from '../middleware/tierGates';
import { classifyImageChannel } from '../helpers/imageChannel';
import SelfUpdateService from '../services/SelfUpdateService';
import { ImageOperationService } from '../services/ImageOperationService';

const SESSION_MESSAGE = 'API tokens cannot manage image channels.';

export const imageChannelRouter = Router();

imageChannelRouter.get('/status', async (req: Request, res: Response): Promise<void> => {
  if (!requireUserSession(req, res)) return;
  try {
    const selfUpdate = SelfUpdateService.getInstance();
    const pin = await selfUpdate.getPinInfo({ fresh: true });
    const operation = await ImageOperationService.getInstance().getCurrentOperation();
    const isAdmin = req.user?.role === 'admin';
    const channel = pin ? classifyImageChannel(pin.composeImageRef) : 'unknown';
    res.json({
      channel,
      ...(pin && (isAdmin || channel !== 'hardened') ? { composeImageRef: pin.composeImageRef } : {}),
      ...(isAdmin && pin ? { pinKind: pin.pinKind } : {}),
      ...(isAdmin ? { operation } : {}),
    });
  } catch (error) {
    console.error('[ImageChannel] Status failed:', error);
    res.status(500).json({ error: 'Unable to read image channel status' });
  }
});

imageChannelRouter.post('/preflight', async (req: Request, res: Response): Promise<void> => {
  if (rejectApiTokenScope(req, res, SESSION_MESSAGE)) return;
  if (!requireUserSession(req, res) || !requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  const result = await ImageOperationService.getInstance().preflightSwitch();
  if (!result.ok) {
    res.status(403).json({ error: 'Hardened image access is unavailable', code: result.code });
    return;
  }
  res.json(result);
});

imageChannelRouter.post('/switch', async (req: Request, res: Response): Promise<void> => {
  if (rejectApiTokenScope(req, res, SESSION_MESSAGE)) return;
  if (!requireUserSession(req, res) || !requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  const fingerprint = req.body?.preflightFingerprint;
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    res.status(400).json({ error: 'A valid preflight fingerprint is required' });
    return;
  }
  const result = await ImageOperationService.getInstance().switchToHardened(fingerprint);
  if (!result.ok) {
    const status = result.code === 'IMAGE_OPERATION_IN_FLIGHT' || result.code === 'preflight_mismatch' ? 409 : 403;
    res.status(status).json({ error: 'Image channel switch could not start', code: result.code });
    return;
  }
  res.status(202).json({ message: 'Image channel switch initiated.' });
});

imageChannelRouter.get('/operations/:operationId', async (req: Request, res: Response): Promise<void> => {
  if (!requireUserSession(req, res) || !requireAdmin(req, res)) return;
  const operationId = Array.isArray(req.params.operationId) ? req.params.operationId[0] : req.params.operationId;
  if (!ImageOperationService.isOperationId(operationId)) {
    res.status(400).json({ error: 'Invalid operation id' });
    return;
  }
  const operation = await ImageOperationService.getInstance().getOperation(operationId);
  if (!operation) {
    res.status(404).json({ error: 'Image operation not found' });
    return;
  }
  res.json(operation);
});

imageChannelRouter.post('/operations/:operationId/acknowledge', async (req: Request, res: Response): Promise<void> => {
  if (rejectApiTokenScope(req, res, SESSION_MESSAGE)) return;
  if (!requireUserSession(req, res) || !requireAdmin(req, res)) return;
  const operationId = Array.isArray(req.params.operationId) ? req.params.operationId[0] : req.params.operationId;
  if (!ImageOperationService.isOperationId(operationId)) {
    res.status(400).json({ error: 'Invalid operation id' });
    return;
  }
  if (!await ImageOperationService.getInstance().acknowledge(operationId)) {
    res.status(409).json({ error: 'Only failed image operations can be acknowledged' });
    return;
  }
  res.status(204).end();
});

