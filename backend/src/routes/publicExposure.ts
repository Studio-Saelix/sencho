import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAdmin, requireUserSession } from '../middleware/tierGates';
import { requirePermission } from '../middleware/permissions';
import { auditActorUsername } from '../helpers/auditActor';
import { errorMessageForLog } from '../utils/safeLog';
import { PublicExposureAccountService } from '../services/publicExposure/PublicExposureAccountService';
import type { PublicExposureAuditContext } from '../services/publicExposure/audit';
import { PublicExposureError } from '../services/publicExposure/types';

/**
 * Public exposure account routes: the hub's one Cloudflare account, its
 * zones, and the permission checks. Hub-only, so a request naming a remote
 * node is refused instead of proxied. Every account route and every zone
 * write is Admin and signed-in-session only, because the account holds a
 * provider credential; only the enabled-zone list is a global `node:read` read.
 *
 * A refused connect (Cloudflare's 401 or 403 among them) is 422, a finished
 * recheck is 200 with its outcome in the body, and an unfinished DNS check is
 * 202. Transport failures are 502 or 503. None is ever 401: a local 401 signs
 * the browser out.
 */

const CLOUDFLARE_ID = /^[0-9a-f]{32}$/;

const connectSchema = z.object({
  token: z.string()
    .transform((value) => value.trim())
    .pipe(z.string()
      .min(20, 'This is too short to be a Cloudflare API token. Paste the whole token.')
      .max(256, 'This is too long to be a Cloudflare API token.')
      .regex(/^[\x21-\x7e]+$/, 'The token must be printable characters with no spaces.')),
  accountId: z.string().trim().toLowerCase().regex(CLOUDFLARE_ID, 'The account id is 32 hexadecimal characters.'),
});

const dnsCheckSchema = z.object({
  zoneRef: z.string().regex(CLOUDFLARE_ID, 'The zone id is 32 hexadecimal characters.'),
});

const zoneSchema = z.object({
  enabled: z.boolean(),
  allowedSuffixes: z.array(z.string().max(253)).max(100),
});

function guard(req: Request, res: Response): boolean {
  if (!requireUserSession(req, res)) return false;
  return requireAdmin(req, res);
}

function auditContext(req: Request): PublicExposureAuditContext {
  return {
    username: auditActorUsername(req),
    ip: req.ip || 'unknown',
    method: req.method,
    path: req.originalUrl,
  };
}

function invalidInput(res: Response, error: z.ZodError): void {
  res.status(400).json({ error: error.issues[0]?.message ?? 'Invalid request.', code: 'INVALID_INPUT' });
}

function sendError(res: Response, error: unknown, action: string): void {
  if (error instanceof PublicExposureError) {
    res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    });
    return;
  }
  console.error(`[PublicExposure] ${action} failed:`, errorMessageForLog(error));
  res.status(500).json({ error: `Could not ${action}.` });
}

export const publicExposureRouter = Router();

publicExposureRouter.get('/account', (req: Request, res: Response): void => {
  if (!guard(req, res)) return;
  try {
    res.json(PublicExposureAccountService.getInstance().getView());
  } catch (error: unknown) {
    sendError(res, error, 'read the Cloudflare connection');
  }
});

publicExposureRouter.put('/account', async (req: Request, res: Response): Promise<void> => {
  if (!guard(req, res)) return;
  const parsed = connectSchema.safeParse(req.body);
  if (!parsed.success) return invalidInput(res, parsed.error);
  try {
    res.json(await PublicExposureAccountService.getInstance().connect(parsed.data.token, parsed.data.accountId, auditContext(req)));
  } catch (error: unknown) {
    sendError(res, error, 'connect the Cloudflare account');
  }
});

publicExposureRouter.post('/account/verify', async (req: Request, res: Response): Promise<void> => {
  if (!guard(req, res)) return;
  try {
    res.json(await PublicExposureAccountService.getInstance().recheck(auditContext(req)));
  } catch (error: unknown) {
    sendError(res, error, 'recheck the Cloudflare account');
  }
});

publicExposureRouter.post('/account/dns-check', async (req: Request, res: Response): Promise<void> => {
  if (!guard(req, res)) return;
  const parsed = dnsCheckSchema.safeParse(req.body);
  if (!parsed.success) return invalidInput(res, parsed.error);
  try {
    const { view, complete } = await PublicExposureAccountService.getInstance().dnsCheck(parsed.data.zoneRef, auditContext(req));
    // 202: the check did not finish and a check record may be left; the view names it.
    res.status(complete ? 200 : 202).json(view);
  } catch (error: unknown) {
    sendError(res, error, 'check DNS write');
  }
});

publicExposureRouter.delete('/account', async (req: Request, res: Response): Promise<void> => {
  if (!guard(req, res)) return;
  try {
    const { leftInCloudflare } = await PublicExposureAccountService.getInstance().disconnect(auditContext(req));
    // Names any permission-check record the disconnect had to leave in Cloudflare; empty when none.
    res.json({ connected: false, leftInCloudflare });
  } catch (error: unknown) {
    sendError(res, error, 'disconnect the Cloudflare account');
  }
});

publicExposureRouter.put('/zones/:zoneRef', async (req: Request, res: Response): Promise<void> => {
  if (!guard(req, res)) return;
  const zoneRef = String(req.params.zoneRef);
  if (!CLOUDFLARE_ID.test(zoneRef)) {
    res.status(400).json({ error: 'The zone id is 32 hexadecimal characters.', code: 'INVALID_INPUT' });
    return;
  }
  const parsed = zoneSchema.safeParse(req.body);
  if (!parsed.success) return invalidInput(res, parsed.error);
  try {
    res.json(await PublicExposureAccountService.getInstance().setZone(zoneRef, parsed.data.enabled, parsed.data.allowedSuffixes, auditContext(req)));
  } catch (error: unknown) {
    sendError(res, error, 'update the zone');
  }
});

publicExposureRouter.get('/zones', (req: Request, res: Response): void => {
  if (!requirePermission(req, res, 'node:read')) return;
  try {
    res.json(PublicExposureAccountService.getInstance().listEnabledZones());
  } catch (error: unknown) {
    sendError(res, error, 'list the enabled zones');
  }
});
