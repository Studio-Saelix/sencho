import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAdmin, requireUserSession } from '../middleware/tierGates';
import { bootstrapLimiter, bootstrapOperationLimiter } from '../middleware/rateLimiters';
import { auditActorUsername } from '../helpers/auditActor';
import { resolvePrimaryUrl } from '../helpers/primaryUrl';
import { sanitizeForLog } from '../utils/safeLog';
import { getErrorMessage } from '../utils/errors';
import { BootstrapError, NodeBootstrapService, validateInstallPaths } from '../services/nodeBootstrap/NodeBootstrapService';
import { DEFAULT_AGENT_DIR, DEFAULT_COMPOSE_DIR } from '../services/nodeBootstrap/pathPolicy';
import { SshTransportError } from '../services/nodeBootstrap/sshProbeClient';
import { NodeBootstrapOperationService } from '../services/nodeBootstrap/NodeBootstrapOperationService';
import { TargetValidationError, validateTarget } from '../services/nodeBootstrap/targetPolicy';

/**
 * Node bootstrap routes: the read-only preflight, and the operations that run
 * an approved plan.
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

const preflightFields = {
  host: z.string(),
  port: portSchema.optional(),
  username: z.string(),
  privateKey: z.string().min(1),
  passphrase: z.string().nullable().optional(),
  expectedFingerprint: z.string().nullable().optional(),
  replacePinnedFingerprint: z.string().nullable().optional(),
  reviewedPinnedFingerprint: z.string().nullable().optional(),
  targetName: z.string(),
  composeDir: z.string().optional(),
  agentDir: z.string().optional(),
};

const preflightSchema = z.object({
  ...preflightFields,
  /** Set when the preflight prepares a retry of this operation. */
  operationId: z.string().uuid().optional(),
}).refine(
  (body) => Boolean(body.replacePinnedFingerprint?.trim()) === Boolean(body.reviewedPinnedFingerprint?.trim()),
  { message: 'A host key replacement names both the new key and the pin it replaces.', path: ['reviewedPinnedFingerprint'] },
);

/**
 * Executing a plan repeats the preflight inputs (the key is never stored, so
 * it is sent again) and names the reviewed plan by digest. A host key
 * replacement is a preflight decision, so it is refused here.
 */
const executeSchema = z.object({
  ...preflightFields,
  planDigest: z.string().regex(/^[0-9a-f]{64}$/, 'planDigest must be a SHA-256 hex digest.'),
}).refine(
  (body) => !body.replacePinnedFingerprint?.trim() && !body.reviewedPinnedFingerprint?.trim(),
  { message: 'A host key replacement is confirmed in the preflight, not when the plan runs.', path: ['replacePinnedFingerprint'] },
);

const operationIdSchema = z.string().uuid();

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

function sendError(res: Response, error: unknown, action: 'preflight' | 'operation' = 'preflight'): void {
  if (error instanceof TargetValidationError) {
    res.status(400).json({ error: error.message, code: error.code, field: error.field });
    return;
  }
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
  if (action === 'operation') {
    console.error('[Bootstrap] Operation request failed:', getErrorMessage(error, 'unknown'));
    res.status(500).json({ error: 'The bootstrap request failed unexpectedly. Check the hub logs.', code: 'OPERATION_FAILED' });
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
      hubUrl: resolvePrimaryUrl(req),
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
    const operations = NodeBootstrapOperationService.getInstance();
    const { operationId, ...input } = parsed.data;
    const target = validateTarget({ host: input.host, port: input.port, username: input.username, targetName: input.targetName });
    operations.assertTargetIdle(target.host, target.port);
    const ownership = operationId ? operations.retryOwnership(operationId, target.host, target.port) : null;
    const audit = auditContext(req);
    const result = await NodeBootstrapService.getInstance().preflight(input, {
      hubUrl: resolvePrimaryUrl(req),
      audit,
      signal: abortOnDisconnect(res),
      ownership,
    });
    operations.rememberPlan(result, audit.username, operationId ?? null);
    console.log(
      `[Bootstrap] Preflight for ${sanitizeForLog(parsed.data.host)} complete: blocked=${result.blocked} blockers=${result.inspection.blockers} warnings=${result.inspection.warnings}`,
    );
    res.json(result);
  } catch (error: unknown) {
    sendError(res, error);
  }
});

/**
 * Approve and run a reviewed plan. The response returns as soon as the
 * operation is recorded; the run continues on the hub whether or not the
 * browser stays open.
 */
nodeBootstrapRouter.post('/operations', bootstrapOperationLimiter, (req: Request, res: Response) => {
  if (!guard(req, res)) return;
  const parsed = executeSchema.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res, parsed);
    return;
  }
  try {
    const operation = NodeBootstrapOperationService.getInstance().start(parsed.data, {
      hubUrl: resolvePrimaryUrl(req),
      audit: auditContext(req),
    });
    console.log(`[Bootstrap] Operation ${operation.id} started for ${sanitizeForLog(operation.host)}:${operation.port}`);
    res.status(202).json(operation);
  } catch (error: unknown) {
    sendError(res, error, 'operation');
  }
});

/** A page of runs that still hold a server; `cursor` is what the previous page returned. */
const listQuerySchema = z.object({ cursor: z.string().min(1).max(200).optional() });

nodeBootstrapRouter.get('/operations', (req: Request, res: Response) => {
  if (!guard(req, res)) return;
  const query = listQuerySchema.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: 'That page of bootstrap runs is not valid. Reload the list.', code: 'INVALID_CURSOR' });
    return;
  }
  try {
    res.json(NodeBootstrapOperationService.getInstance().list(query.data.cursor ?? null));
  } catch (error: unknown) {
    sendError(res, error, 'operation');
  }
});

function operationId(req: Request, res: Response): string | null {
  const parsed = operationIdSchema.safeParse(req.params.id);
  if (!parsed.success) {
    res.status(404).json({ error: 'Bootstrap operation not found.', code: 'OPERATION_NOT_FOUND' });
    return null;
  }
  return parsed.data;
}

nodeBootstrapRouter.get('/operations/:id', (req: Request, res: Response) => {
  if (!guard(req, res)) return;
  const id = operationId(req, res);
  if (!id) return;
  try {
    res.json(NodeBootstrapOperationService.getInstance().get(id));
  } catch (error: unknown) {
    sendError(res, error, 'operation');
  }
});

nodeBootstrapRouter.post('/operations/:id/retry', bootstrapOperationLimiter, (req: Request, res: Response) => {
  if (!guard(req, res)) return;
  const id = operationId(req, res);
  if (!id) return;
  const parsed = executeSchema.safeParse(req.body);
  if (!parsed.success) {
    invalidBody(res, parsed);
    return;
  }
  try {
    const operation = NodeBootstrapOperationService.getInstance().retry(id, parsed.data, {
      hubUrl: resolvePrimaryUrl(req),
      audit: auditContext(req),
    });
    res.status(202).json(operation);
  } catch (error: unknown) {
    sendError(res, error, 'operation');
  }
});

nodeBootstrapRouter.post('/operations/:id/cancel', (req: Request, res: Response) => {
  if (!guard(req, res)) return;
  const id = operationId(req, res);
  if (!id) return;
  try {
    res.json(NodeBootstrapOperationService.getInstance().cancel(id, auditContext(req)));
  } catch (error: unknown) {
    sendError(res, error, 'operation');
  }
});

nodeBootstrapRouter.post('/operations/:id/release', (req: Request, res: Response) => {
  if (!guard(req, res)) return;
  const id = operationId(req, res);
  if (!id) return;
  try {
    res.json(NodeBootstrapOperationService.getInstance().release(id, auditContext(req)));
  } catch (error: unknown) {
    sendError(res, error, 'operation');
  }
});
