import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAdmin, requireUserSession } from '../middleware/tierGates';
import { bootstrapLimiter } from '../middleware/rateLimiters';
import { auditActorUsername } from '../helpers/auditActor';
import { resolvePrimaryUrl } from '../helpers/primaryUrl';
import { sanitizeForLog } from '../utils/safeLog';
import { getErrorMessage } from '../utils/errors';
import { BootstrapError, NodeBootstrapService, validateInstallPaths } from '../services/nodeBootstrap/NodeBootstrapService';
import { DEFAULT_AGENT_DIR, DEFAULT_COMPOSE_DIR } from '../services/nodeBootstrap/pathPolicy';
import { SshTransportError } from '../services/nodeBootstrap/sshProbeClient';

/**
 * Read-only node bootstrap routes.
 *
 * Admin and signed-in-session only: bootstrap reaches a host over SSH, which is
 * deliberately narrower than ordinary node management, and an API token or a
 * node-proxy machine credential must not be able to start it. The router is
 * hub-only, so a request naming a remote node is refused instead of being
 * proxied.
 */

const portSchema = z.number().int().min(1).max(65535);

const hostKeySchema = z.object({
  host: z.string(),
  port: portSchema.optional(),
});

const preflightSchema = z.object({
  host: z.string(),
  port: portSchema.optional(),
  username: z.string(),
  privateKey: z.string().min(1),
  passphrase: z.string().nullable().optional(),
  expectedFingerprint: z.string().nullable().optional(),
  replacePinnedFingerprint: z.string().nullable().optional(),
  targetName: z.string(),
  composeDir: z.string().optional(),
  agentDir: z.string().optional(),
});

function guard(req: Request, res: Response): boolean {
  if (!requireUserSession(req, res)) return false;
  return requireAdmin(req, res);
}

function auditContext(req: Request) {
  return {
    username: auditActorUsername(req),
    ip: req.ip || 'unknown',
    method: req.method,
    path: req.originalUrl,
  };
}

/**
 * Aborts when the client goes away before the reply is written (the wizard
 * cancels a superseded request), so the SSH session and the target lock are
 * released instead of running out the full budget.
 */
function abortOnDisconnect(res: Response): AbortSignal {
  const controller = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof BootstrapError) {
    res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...(error.field ? { field: error.field } : {}),
      ...error.details,
    });
    return;
  }
  if (error instanceof SshTransportError) {
    if (res.destroyed) return;
    console.warn(`[Bootstrap] Transport failure (${error.code}):`, sanitizeForLog(error.message));
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  console.error('[Bootstrap] Preflight failed:', getErrorMessage(error, 'unknown'));
  res.status(500).json({ error: 'The preflight failed unexpectedly. Check the hub logs.', code: 'PREFLIGHT_FAILED' });
}

function invalidBody(res: Response, parsed: z.ZodSafeParseError<unknown>): void {
  const issue = parsed.error.issues[0];
  const field = issue?.path?.[0];
  res.status(400).json({
    error: issue?.message ?? 'The request body is not valid.',
    code: 'INVALID_TARGET',
    ...(typeof field === 'string' ? { field } : {}),
  });
}

export const nodeBootstrapRouter = Router();

nodeBootstrapRouter.get('/capabilities', (req: Request, res: Response) => {
  if (!guard(req, res)) return;
  res.json(NodeBootstrapService.getInstance().getCapabilities());
});

nodeBootstrapRouter.post('/host-key', bootstrapLimiter, async (req: Request, res: Response) => {
  if (!guard(req, res)) return;
  const parsed = hostKeySchema.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res, parsed);
    return;
  }
  try {
    const result = await NodeBootstrapService.getInstance().captureHostKey(parsed.data, {
      signal: abortOnDisconnect(res),
    });
    console.log(`[Bootstrap] Host key checked for ${sanitizeForLog(result.host)}:${result.port} (${result.trust})`);
    res.json(result);
  } catch (error: unknown) {
    sendError(res, error);
  }
});

nodeBootstrapRouter.post('/preflight', bootstrapLimiter, async (req: Request, res: Response) => {
  if (!guard(req, res)) return;
  const parsed = preflightSchema.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res, parsed);
    return;
  }
  try {
    // Validate both paths before any SSH work: a hand-crafted request must not
    // open a connection only to be rejected by the service afterwards.
    validateInstallPaths(
      parsed.data.composeDir ?? DEFAULT_COMPOSE_DIR,
      parsed.data.agentDir ?? DEFAULT_AGENT_DIR,
    );
    const result = await NodeBootstrapService.getInstance().preflight(parsed.data, {
      hubUrl: resolvePrimaryUrl(req),
      audit: auditContext(req),
      signal: abortOnDisconnect(res),
    });
    console.log(
      `[Bootstrap] Preflight for ${sanitizeForLog(parsed.data.host)} complete: blocked=${result.blocked} blockers=${result.inspection.blockers} warnings=${result.inspection.warnings}`,
    );
    res.json(result);
  } catch (error: unknown) {
    sendError(res, error);
  }
});
