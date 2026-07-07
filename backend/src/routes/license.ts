import { Router, type Request, type Response } from 'express';
import { LicenseService } from '../services/LicenseService';
import SelfUpdateService from '../services/SelfUpdateService';
import { requireAdmin } from '../middleware/tierGates';
import { rejectApiTokenScope } from '../middleware/apiTokenScope';
import { parseRequestedTargetVersion } from '../utils/targetVersion';
import type { SelfUpdatePreflight } from '../services/SelfUpdateService';

const LICENSE_SCOPE_MESSAGE = 'API tokens cannot manage licenses.';

export const licenseRouter = Router();

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
  if (!requireAdmin(req, res)) return;
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
  if (!requireAdmin(req, res)) return;
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
  if (!requireAdmin(req, res)) return;
  const selfUpdate = SelfUpdateService.getInstance();
  if (!selfUpdate.isAvailable()) {
    res.status(503).json({ error: 'Self-update unavailable. Sencho must be deployed via Docker Compose.' });
    return;
  }
  const targetVersion = parseRequestedTargetVersion(req, res);
  if (targetVersion === null) return; // invalid supplied value; 400 already sent
  // Fail fast on a pin we cannot repin (digest/unknown) so the caller gets a
  // 409 instead of a 202 that would later fail after the reconnect overlay.
  if (!respondSelfUpdatePreflight(res, await selfUpdate.canSelfUpdateTarget(targetVersion))) return;
  scheduleLocalUpdate(res, 'Update initiated. The server will restart shortly.', targetVersion);
});
