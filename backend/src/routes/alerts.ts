import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { DatabaseService } from '../services/DatabaseService';
import { authMiddleware } from '../middleware/auth';
import { requirePermission } from '../middleware/permissions';
import { isValidServiceName } from '../utils/validation';
import {
  getActiveCapabilities,
  SERVICE_SCOPED_STACK_ALERT_CAPABILITY,
} from '../services/CapabilityRegistry';

const AlertCreateSchema = z.object({
  stack_name: z.string().min(1).max(255),
  service_name: z.preprocess(
    (val) => (val === '' ? null : val),
    z.string().max(255).nullable().optional().refine(
      (val) => val == null || isValidServiceName(val),
      { message: 'Invalid service name' },
    ),
  ),
  metric: z.enum(['cpu_percent', 'memory_percent', 'memory_mb', 'net_rx', 'net_tx', 'restart_count']),
  operator: z.enum(['>', '>=', '<', '<=', '==']),
  threshold: z.number().min(0),
  duration_mins: z.coerce.number().int().min(0).max(1440),
  cooldown_mins: z.coerce.number().int().min(0).max(10080),
});

export const alertsRouter = Router();

alertsRouter.get('/', authMiddleware, async (req: Request, res: Response) => {
  let stackName = req.query.stackName as string | undefined;
  if (Array.isArray(stackName)) stackName = stackName[0] as string;

  if (stackName) {
    if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;
  } else {
    if (!requirePermission(req, res, 'stack:read')) return;
  }

  try {
    const alerts = DatabaseService.getInstance().getStackAlerts(stackName);
    res.json(alerts);
  } catch (error) {
    console.error('Failed to fetch alerts:', error);
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

alertsRouter.post('/', authMiddleware, async (req: Request, res: Response) => {
  const parsed = AlertCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid alert data', details: parsed.error.flatten().fieldErrors });
    return;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', parsed.data.stack_name)) return;
  const { service_name, ...alertFields } = parsed.data;
  const serviceName = service_name ?? null;
  if (
    serviceName != null
    && !getActiveCapabilities().includes(SERVICE_SCOPED_STACK_ALERT_CAPABILITY)
  ) {
    res.status(400).json({
      error: 'This node does not support service-scoped alert rules',
      code: 'capability_unavailable',
    });
    return;
  }
  try {
    const created = DatabaseService.getInstance().addStackAlert({
      ...alertFields,
      service_name: serviceName,
    });
    res.status(201).json(created);
  } catch (error) {
    console.error('Failed to add alert:', error);
    res.status(500).json({ error: 'Failed to add alert' });
  }
});

alertsRouter.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
  // Reject leading-junk / fractional ids (parseInt("1abc") === 1, parseInt("2.5") === 2).
  const rawId = String(req.params.id ?? '');
  const id = /^\d+$/.test(rawId) ? Number.parseInt(rawId, 10) : NaN;
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid alert id' });
    return;
  }
  const db = DatabaseService.getInstance();
  const alert = db.getStackAlert(id);
  if (!alert) {
    res.status(404).json({ error: 'Alert not found' });
    return;
  }
  if (!requirePermission(req, res, 'stack:edit', 'stack', alert.stack_name)) return;
  try {
    db.deleteStackAlert(id);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete alert:', error);
    res.status(500).json({ error: 'Failed to delete alert' });
  }
});
