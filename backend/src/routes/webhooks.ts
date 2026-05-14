import { Router, type Request, type Response } from 'express';
import { DatabaseService } from '../services/DatabaseService';
import { WebhookService } from '../services/WebhookService';
import { LicenseService } from '../services/LicenseService';
import { authMiddleware } from '../middleware/auth';
import { requirePaid, requireAdmin } from '../middleware/tierGates';
import { webhookTriggerLimiter } from '../middleware/rateLimiters';

const VALID_WEBHOOK_ACTIONS = ['deploy', 'restart', 'stop', 'start', 'pull', 'git-pull'];

export const webhooksRouter = Router();

webhooksRouter.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requirePaid(req, res)) return;
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
  if (!requirePaid(req, res)) return;
  try {
    const { name, stack_name, action, enabled, node_id } = req.body;
    if (!name || !stack_name || !action) {
      res.status(400).json({ error: 'name, stack_name, and action are required' });
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
  if (!requirePaid(req, res)) return;
  try {
    const id = parseInt(req.params.id as string, 10);
    const webhook = DatabaseService.getInstance().getWebhook(id);
    if (!webhook) { res.status(404).json({ error: 'Webhook not found' }); return; }

    const { name, stack_name, action, enabled, node_id } = req.body;
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
  if (!requirePaid(req, res)) return;
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
  if (!requirePaid(req, res)) return;
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
webhooksRouter.post('/:id/trigger', webhookTriggerLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const db = DatabaseService.getInstance();
    const webhook = db.getWebhook(id);

    if (!webhook || !webhook.enabled) {
      res.status(404).json({ error: 'Webhook not found or disabled' });
      return;
    }

    // Trigger only works with an active Skipper or Admiral license.
    if (LicenseService.getInstance().getTier() !== 'paid') {
      res.status(403).json({ error: 'This feature requires a Skipper or Admiral license.', code: 'PAID_REQUIRED' });
      return;
    }

    const signature = req.headers['x-webhook-signature'] as string;
    if (!signature) {
      res.status(401).json({ error: 'Missing X-Webhook-Signature header' });
      return;
    }

    const rawBody = req.rawBody?.toString('utf-8') ?? JSON.stringify(req.body ?? {});
    const svc = WebhookService.getInstance();
    if (!svc.validateSignature(rawBody, webhook.secret, signature)) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    // Use action from body if provided, otherwise use webhook default.
    const action = req.body?.action || webhook.action;
    const triggerSource = req.headers['user-agent'] || req.ip || null;

    // Execute asynchronously; return 202 immediately.
    res.status(202).json({ message: 'Webhook accepted', action });

    const atomic = LicenseService.getInstance().getTier() === 'paid';
    svc.execute(id, action, triggerSource, atomic).catch(err => {
      console.error(`[Webhooks] Execution error for webhook ${id}:`, err);
    });
  } catch (error) {
    console.error('[Webhooks] Trigger error:', error);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});
