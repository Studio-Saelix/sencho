import { Router, type Request, type Response } from 'express';
import { DatabaseService, type WebhookAction } from '../services/DatabaseService';
import { WebhookService } from '../services/WebhookService';
import { authMiddleware } from '../middleware/auth';
import { requireAdmin } from '../middleware/tierGates';
import { webhookTriggerLimiter } from '../middleware/rateLimiters';

const VALID_WEBHOOK_ACTIONS: readonly WebhookAction[] = ['deploy', 'restart', 'stop', 'start', 'pull', 'git-pull'];
const MAX_WEBHOOK_NAME_LENGTH = 100;

function isWebhookAction(value: unknown): value is WebhookAction {
  return typeof value === 'string' && (VALID_WEBHOOK_ACTIONS as readonly string[]).includes(value);
}

export const webhooksRouter = Router();

webhooksRouter.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const webhooks = DatabaseService.getInstance().getWebhooks();
    const svc = WebhookService.getInstance();
    res.json(webhooks.map(w => ({ ...w, secret: svc.maskSecret(w.secret) })));
  } catch (error) {
    console.error('[Webhooks] List error:', error);
    res.status(500).json({ error: 'Failed to list webhooks' });
  }
});

webhooksRouter.post('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const { name, stack_name, action, enabled, node_id } = req.body;
    if (!name || !stack_name || !action) {
      res.status(400).json({ error: 'name, stack_name, and action are required' });
      return;
    }
    if (typeof name !== 'string' || name.length > MAX_WEBHOOK_NAME_LENGTH) {
      res.status(400).json({ error: `name must be a string of ${MAX_WEBHOOK_NAME_LENGTH} characters or fewer` });
      return;
    }
    if (!VALID_WEBHOOK_ACTIONS.includes(action)) {
      res.status(400).json({ error: `action must be one of: ${VALID_WEBHOOK_ACTIONS.join(', ')}` });
      return;
    }
    if (node_id !== undefined && !Number.isInteger(node_id)) {
      res.status(400).json({ error: 'node_id must be an integer' });
      return;
    }
    const targetNodeId = node_id ?? req.nodeId ?? DatabaseService.getInstance().getDefaultNode()?.id;
    if (!targetNodeId || !DatabaseService.getInstance().getNode(targetNodeId)) {
      res.status(400).json({ error: 'node_id must reference an existing node' });
      return;
    }
    if (action === 'git-pull' && !(await WebhookService.getInstance().gitSourceExists(stack_name, targetNodeId))) {
      res.status(400).json({ error: 'Configure a Git source for this stack before creating a git-pull webhook' });
      return;
    }

    const svc = WebhookService.getInstance();
    const secret = svc.generateSecret();
    const id = DatabaseService.getInstance().addWebhook({
      node_id: targetNodeId,
      name, stack_name, action, secret, enabled: enabled !== false,
    });

    // Return the full secret only on creation.
    res.status(201).json({ id, secret });
  } catch (error) {
    console.error('[Webhooks] Create error:', error);
    res.status(500).json({ error: 'Failed to create webhook' });
  }
});

webhooksRouter.put('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = parseInt(req.params.id as string, 10);
    const webhook = DatabaseService.getInstance().getWebhook(id);
    if (!webhook) { res.status(404).json({ error: 'Webhook not found' }); return; }

    const { name, stack_name, action, enabled, node_id } = req.body;
    if (name !== undefined && (typeof name !== 'string' || name.length > MAX_WEBHOOK_NAME_LENGTH)) {
      res.status(400).json({ error: `name must be a string of ${MAX_WEBHOOK_NAME_LENGTH} characters or fewer` });
      return;
    }
    if (node_id !== undefined && !Number.isInteger(node_id)) {
      res.status(400).json({ error: 'node_id must be an integer' });
      return;
    }
    const targetNodeId = node_id ?? webhook.node_id;
    if (node_id !== undefined && !DatabaseService.getInstance().getNode(targetNodeId)) {
      res.status(400).json({ error: 'node_id must reference an existing node' });
      return;
    }
    if (action && !VALID_WEBHOOK_ACTIONS.includes(action)) {
      res.status(400).json({ error: `action must be one of: ${VALID_WEBHOOK_ACTIONS.join(', ')}` });
      return;
    }
    const effectiveAction = action ?? webhook.action;
    const effectiveStackName = stack_name ?? webhook.stack_name;
    if (effectiveAction === 'git-pull') {
      const targetStack = effectiveStackName;
      if (!(await WebhookService.getInstance().gitSourceExists(targetStack, targetNodeId))) {
        res.status(400).json({ error: 'Configure a Git source for this stack before enabling a git-pull webhook' });
        return;
      }
    }

    DatabaseService.getInstance().updateWebhook(id, { node_id, name, stack_name, action, enabled });
    res.json({ success: true });
  } catch (error) {
    console.error('[Webhooks] Update error:', error);
    res.status(500).json({ error: 'Failed to update webhook' });
  }
});

webhooksRouter.delete('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = parseInt(req.params.id as string, 10);
    DatabaseService.getInstance().deleteWebhook(id);
    res.json({ success: true });
  } catch (error) {
    console.error('[Webhooks] Delete error:', error);
    res.status(500).json({ error: 'Failed to delete webhook' });
  }
});

webhooksRouter.get('/:id/history', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const executions = DatabaseService.getInstance().getWebhookExecutions(id);
    res.json(executions);
  } catch (error) {
    console.error('[Webhooks] History error:', error);
    res.status(500).json({ error: 'Failed to fetch webhook history' });
  }
});

// Public: authenticated via HMAC signature, not session cookie.
//
// Every unauthenticated rejection returns the same 404 with the same body so
// callers cannot enumerate webhook ids from the response surface. Successful
// authentication still returns 202.
//
// The handler also runs the HMAC computation on every path (using a decoy
// secret and an empty buffer when the real ones are missing) so the wall-
// clock cost of a reject path matches the wall-clock cost of a real-shape
// wrong-secret path. Without this, repeated near-rate-limit probes with a
// large attacker-controlled body could distinguish a valid-and-enabled
// webhook id from the other reject cases via response latency. Timing now
// depends only on the size of the request body, which the attacker already
// controls and which reveals nothing webhook-specific.
webhooksRouter.post('/:id/trigger', webhookTriggerLimiter, async (req: Request, res: Response): Promise<void> => {
  const unauthenticated = (): void => {
    res.status(404).json({ error: 'Webhook not found or signature invalid' });
  };
  try {
    const id = parseInt(req.params.id as string, 10);
    const db = DatabaseService.getInstance();
    const webhook = db.getWebhook(id);

    const signature = req.headers['x-webhook-signature'] as string | undefined;

    // Unconditional HMAC. The decoy secret keeps the work non-skippable when
    // the webhook does not exist; an empty buffer keeps it non-skippable
    // when express.json()'s verify callback did not capture a body. The
    // empty-string signature still flows through validateSignature, which
    // is constant-time over every shape and will return false against the
    // all-zero sentinel. Reject conditions are checked after the HMAC has
    // already run so the timing of every reject path matches the timing of
    // a real-shape wrong-secret request.
    const svc = WebhookService.getInstance();
    const payload = (req.rawBody ?? Buffer.alloc(0)).toString('utf-8');
    const secretForHmac = webhook?.secret ?? WebhookService.getDecoySecret();
    const sigOk = svc.validateSignature(payload, secretForHmac, signature ?? '');

    if (!webhook || !webhook.enabled) return unauthenticated();
    if (!signature) return unauthenticated();
    if (!req.rawBody) return unauthenticated();
    if (!sigOk) return unauthenticated();

    // Use action from body if provided, otherwise use webhook default.
    // Validate against the action allowlist before queueing execution so an
    // attacker-supplied string never reaches recordExecution as a stored
    // failure label.
    const overrideAction = (req.body as { action?: unknown } | undefined)?.action;
    let action: WebhookAction = webhook.action;
    if (overrideAction !== undefined) {
      if (!isWebhookAction(overrideAction)) {
        res.status(400).json({ error: `action must be one of: ${VALID_WEBHOOK_ACTIONS.join(', ')}` });
        return;
      }
      action = overrideAction;
    }
    const triggerSource = req.headers['user-agent'] || req.ip || null;

    // Execute asynchronously; return 202 immediately.
    res.status(202).json({ message: 'Webhook accepted', action });

    // Pass the already-loaded webhook through so execute() never re-fetches
    // by id. If an admin deletes the row between this line and the async
    // dispatch the action still completes and recordExecution swallows the
    // FK error from the CASCADE. atomic is unconditionally true, so the
    // deploy/pull paths always run in atomic mode here.
    svc.execute(webhook, action, triggerSource, true).catch(err => {
      console.error(`[Webhooks] Execution error for webhook ${id}:`, err);
    });
  } catch (error) {
    console.error('[Webhooks] Trigger error:', error);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});
