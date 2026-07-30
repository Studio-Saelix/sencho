import { Router, type Request, type Response } from 'express';
import { LicenseService } from '../services/LicenseService';
import SelfUpdateService from '../services/SelfUpdateService';
import { requireUserSession } from '../middleware/tierGates';
import { requirePermission } from '../middleware/permissions';
import { rejectApiTokenScope } from '../middleware/apiTokenScope';
import { parseRequestedTargetVersion } from '../utils/targetVersion';
import type { SelfUpdatePreflight } from '../services/SelfUpdateService';
import { classifyImageChannel } from '../helpers/imageChannel';
import { ImageOperationService } from '../services/ImageOperationService';
import { imageChannelRouter } from './imageChannel';

const LICENSE_SCOPE_MESSAGE = 'API tokens cannot manage licenses.';

export const licenseRouter = Router();
licenseRouter.use('/image-channel', imageChannelRouter);

licenseRouter.get('/', (_req: Request, res: Response): void => {
  try {
    const info = LicenseService.getInstance().getLicenseInfo();
    res.json(info);
  } catch (error) {
    console.error('[License] Error getting license info:', error);
    res.status(500).json({ error: 'Failed to retrieve license information' });
  }
});

licenseRouter.post('/activate', async (req: Request, res: Response): Promise<void> => {
  if (rejectApiTokenScope(req, res, LICENSE_SCOPE_MESSAGE)) return;
  if (!requirePermission(req, res, 'system:license')) return;
  try {
    const { license_key } = req.body;
    if (!license_key || typeof license_key !== 'string') {
      res.status(400).json({ error: 'A valid license key is required' });
      return;
    }
    const result = await LicenseService.getInstance().activate(license_key.trim());
    if (result.success) {
      res.json({ success: true, license: LicenseService.getInstance().getLicenseInfo() });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    console.error('[License] Activation error:', error);
    res.status(500).json({ error: 'License activation failed' });
  }
});

licenseRouter.post('/deactivate', async (req: Request, res: Response): Promise<void> => {
  if (rejectApiTokenScope(req, res, LICENSE_SCOPE_MESSAGE)) return;
  if (!requirePermission(req, res, 'system:license')) return;
  try {
    const result = await LicenseService.getInstance().deactivate();
    if (result.success) {
      res.json({ success: true, license: LicenseService.getInstance().getLicenseInfo() });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    console.error('[License] Deactivation error:', error);
    res.status(500).json({ error: 'License deactivation failed' });
  }
});

licenseRouter.post('/validate', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await LicenseService.getInstance().validate();
    res.json({ ...result, license: LicenseService.getInstance().getLicenseInfo() });
  } catch (error) {
    console.error('[License] Validation error:', error);
    res.status(500).json({ error: 'License validation failed' });
  }
});

licenseRouter.get('/billing-portal', async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await LicenseService.getInstance().getBillingPortalUrl();
    if ('error' in result) {
      res.status(404).json({ error: result.error });
      return;
    }
    res.json({ url: result.url });
  } catch (error) {
    console.error('[License] Billing portal error:', error);
    res.status(500).json({ error: 'Failed to retrieve billing portal URL' });
  }
});

/**
 * Respond 202, then trigger the "last breath" self-update after flush.
 * Exported because the fleet "update this node" route reuses the same
 * response shape + post-flush trigger for local-node self-updates.
 *
 * `targetVersion` (the Fleet compare target) drives the pinned-image repin;
 * when omitted, triggerUpdate keeps the legacy behavior of pulling the running
 * image and recreating from the on-disk compose.
 */
/** Send 409 when preflight fails; returns false so the route can early-return. */
export function respondSelfUpdatePreflight(
  res: Response,
  preflight: SelfUpdatePreflight,
): preflight is { ok: true } {
  if (preflight.ok) return true;
  res.status(409).json({ error: preflight.reason, code: 'update_blocked' });
  return false;
}

export function scheduleLocalUpdate(res: Response, message: string, targetVersion?: string): void {
  res.status(202).json({ message });
  res.on('finish', () => {
    setTimeout(() => {
      // Defense in depth: triggerUpdate records its own errors into
      // lastUpdateError; guard against an unexpected throw becoming an
      // unhandled rejection.
      SelfUpdateService.getInstance().triggerUpdate({ targetVersion }).catch((err) => {
        console.error('[SelfUpdate] Unexpected error during triggerUpdate:', err);
      });
    }, 500);
  });
}

export const systemUpdateRouter = Router();

systemUpdateRouter.post('/update', async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'system:license')) return;
  const selfUpdate = SelfUpdateService.getInstance();
  if (!selfUpdate.isAvailable()) {
    res.status(503).json({ error: 'Self-update unavailable. Sencho must be deployed via Docker Compose.' });
    return;
  }
  const targetVersion = parseRequestedTargetVersion(req, res);
  if (targetVersion === null) return; // invalid supplied value; 400 already sent
  const pin = await selfUpdate.getPinInfo({ fresh: true });
  const channel = pin ? classifyImageChannel(pin.composeImageRef) : 'unknown';
  const machineCredential = req.user?.userId === 0 || !!req.apiTokenScope;
  if (channel === 'hardened') {
    if (machineCredential) {
      res.status(403).json({
        error: 'Hardened images can only be updated from an admin session.',
        code: 'HARDENED_REMOTE_UPDATE_UNSUPPORTED',
      });
      return;
    }
    if (!requireUserSession(req, res)) return;
    const preflight = await ImageOperationService.getInstance().preflightSwitch();
    if (!preflight.ok) {
      res.status(403).json({ error: 'Hardened image access is unavailable', code: preflight.code });
      return;
    }
    const result = await ImageOperationService.getInstance().switchToHardened(
      preflight.preflightFingerprint,
      'update',
    );
    if (!result.ok) {
      res.status(result.code === 'IMAGE_OPERATION_IN_FLIGHT' ? 409 : 500)
        .json({ error: 'Hardened update could not start', code: result.code });
      return;
    }
    res.status(202).json({ message: 'Update initiated. The server will restart shortly.' });
    return;
  }
  // Fail fast on a pin we cannot repin (digest/unknown) so the caller gets a
  // 409 instead of a 202 that would later fail after the reconnect overlay.
  if (!respondSelfUpdatePreflight(res, await selfUpdate.canSelfUpdateTarget(targetVersion))) return;
  const claim = await ImageOperationService.getInstance().claimCommunityUpdate({ targetVersion });
  if (!claim.ok) {
    res.status(409).json({ error: 'An image operation is already in progress.', code: claim.failureCode });
    return;
  }
  res.status(202).json({ message: 'Update initiated. The server will restart shortly.' });
  // Schedule unconditionally: client abort can fire only `close` without `finish`,
  // which would otherwise leave the claimed operation stuck in pending_pull.
  setTimeout(() => {
    ImageOperationService.getInstance().executeClaimedCommunityUpdate({ targetVersion }).catch(error => {
      console.error('[ImageOperation] Unexpected community update failure:', error);
    });
  }, 500);
});

systemUpdateRouter.post('/reapply-compose', async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'system:license')) return;
  const selfUpdate = SelfUpdateService.getInstance();
  if (!selfUpdate.isAvailable()) {
    res.status(503).json({ error: 'Compose reapply unavailable. Sencho must be deployed via Docker Compose.' });
    return;
  }
  const claim = await ImageOperationService.getInstance().claimComposeReapply();
  if (!claim.ok) {
    res.status(409).json({ error: 'An image operation is already in progress.', code: claim.failureCode });
    return;
  }
  res.status(202).json({ message: 'Compose reapply initiated. The server will restart shortly.' });
  setTimeout(() => {
    ImageOperationService.getInstance().executeClaimedComposeReapply().catch(error => {
      console.error('[ImageOperation] Unexpected compose reapply failure:', error);
    });
  }, 500);
});
