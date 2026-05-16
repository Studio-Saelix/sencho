import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { DatabaseService } from '../services/DatabaseService';
import { authMiddleware } from '../middleware/auth';
import { requirePaid, requireAdmin } from '../middleware/tierGates';
import { getErrorMessage } from '../utils/errors';
import { parseIntParam } from '../utils/parseIntParam';

const AutoHealPolicyCreateSchema = z.object({
  stack_name: z.string().min(1).max(255),
  service_name: z.string().min(1).max(255).nullable().optional(),
  unhealthy_duration_mins: z.coerce.number().int().min(1).max(1440),
  cooldown_mins: z.coerce.number().int().min(1).max(1440).default(5),
  max_restarts_per_hour: z.coerce.number().int().min(1).max(60).default(3),
  auto_disable_after_failures: z.coerce.number().int().min(1).max(100).default(5),
});
const AutoHealPolicyUpdateSchema = AutoHealPolicyCreateSchema
  .partial()
  .omit({ stack_name: true })
  .extend({
    enabled: z.coerce.number().int().min(0).max(1).optional(),
  });

export const autoHealRouter = Router();

const PROXY_ENTITLEMENT_LEASE_MS = 5 * 60_000;

function proxyEntitlementUntil(req: Request): number {
  return req.proxyTier === 'paid' ? Date.now() + PROXY_ENTITLEMENT_LEASE_MS : 0;
}

autoHealRouter.get('/policies', authMiddleware, (req: Request, res: Response): void => {
  if (!requirePaid(req, res)) return;
  const stackName = typeof req.query.stackName === 'string' ? req.query.stackName : undefined;
  try {
    const db = DatabaseService.getInstance();
    const policies = db.getAutoHealPolicies(stackName, req.nodeId);
    const leaseUntil = proxyEntitlementUntil(req);
    if (leaseUntil > 0) {
      for (const policy of policies) {
        if (policy.id !== undefined) db.updateAutoHealPolicy(policy.id, { proxy_entitled_until: leaseUntil });
      }
      res.json(db.getAutoHealPolicies(stackName, req.nodeId));
      return;
    }
    res.json(policies);
  } catch (err) {
    console.error('[AutoHeal] Failed to list policies:', getErrorMessage(err, 'unknown'));
    res.status(500).json({ error: 'Internal server error' });
  }
});

autoHealRouter.post('/policies', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  const parsed = AutoHealPolicyCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }
  const { stack_name, service_name, unhealthy_duration_mins, cooldown_mins, max_restarts_per_hour, auto_disable_after_failures } = parsed.data;
  const now = Date.now();
  try {
    const policy = DatabaseService.getInstance().addAutoHealPolicy({
      node_id: req.nodeId,
      proxy_entitled_until: proxyEntitlementUntil(req),
      stack_name,
      service_name: service_name ?? null,
      unhealthy_duration_mins,
      cooldown_mins,
      max_restarts_per_hour,
      auto_disable_after_failures,
      enabled: 1,
      consecutive_failures: 0,
      last_fired_at: 0,
      created_at: now,
      updated_at: now,
    });
    res.status(201).json(policy);
  } catch (err) {
    console.error('[AutoHeal] Failed to create policy:', getErrorMessage(err, 'unknown'));
    res.status(500).json({ error: 'Internal server error' });
  }
});

autoHealRouter.patch('/policies/:id', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  const id = parseIntParam(req, res, 'id');
  if (id === null) return;
  const parsed = AutoHealPolicyUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }
  try {
    const db = DatabaseService.getInstance();
    const policy = db.getAutoHealPolicy(id);
    if (!policy || policy.node_id !== req.nodeId) { res.status(404).json({ error: 'Policy not found' }); return; }
    db.updateAutoHealPolicy(id, { ...parsed.data, proxy_entitled_until: Math.max(policy.proxy_entitled_until, proxyEntitlementUntil(req)) });
    res.json(db.getAutoHealPolicy(id));
  } catch (err) {
    console.error('[AutoHeal] Failed to update policy:', getErrorMessage(err, 'unknown'));
    res.status(500).json({ error: 'Internal server error' });
  }
});

autoHealRouter.delete('/policies/:id', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  const id = parseIntParam(req, res, 'id');
  if (id === null) return;
  try {
    const db = DatabaseService.getInstance();
    const policy = db.getAutoHealPolicy(id);
    if (!policy || policy.node_id !== req.nodeId) { res.status(404).json({ error: 'Policy not found' }); return; }
    db.deleteAutoHealPolicy(id);
    res.json({ success: true });
  } catch (err) {
    console.error('[AutoHeal] Failed to delete policy:', getErrorMessage(err, 'unknown'));
    res.status(500).json({ error: 'Internal server error' });
  }
});

autoHealRouter.get('/policies/:id/history', authMiddleware, (req: Request, res: Response): void => {
  if (!requirePaid(req, res)) return;
  const id = parseIntParam(req, res, 'id');
  if (id === null) return;
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 100);
  try {
    const db = DatabaseService.getInstance();
    const policy = db.getAutoHealPolicy(id);
    if (!policy || policy.node_id !== req.nodeId) { res.status(404).json({ error: 'Policy not found' }); return; }
    res.json(db.getAutoHealHistory(id, limit));
  } catch (err) {
    console.error('[AutoHeal] Failed to fetch history:', getErrorMessage(err, 'unknown'));
    res.status(500).json({ error: 'Internal server error' });
  }
});
