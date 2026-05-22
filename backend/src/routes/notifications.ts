import { Router, type Request, type Response } from 'express';
import { DatabaseService } from '../services/DatabaseService';
import { NotificationService, ALL_NOTIFICATION_CATEGORIES } from '../services/NotificationService';
import type { NotificationCategory } from '../services/NotificationService';
import { NodeRegistry } from '../services/NodeRegistry';
import { authMiddleware } from '../middleware/auth';
import { requireAdmin, requirePaid } from '../middleware/tierGates';
import {
  NOTIFICATION_CHANNEL_TYPES,
  validateHttpsUrl,
  cleanStackPatterns,
} from '../helpers/notificationChannels';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';
import { parseIntParam } from '../utils/parseIntParam';

const VALID_CATEGORIES: ReadonlySet<NotificationCategory> = new Set(ALL_NOTIFICATION_CATEGORIES);

function validateNodeId(nodeId: unknown, res: Response): number | null | false {
  if (nodeId === undefined || nodeId === null) return null;
  if (typeof nodeId !== 'number' || !Number.isInteger(nodeId)) {
    res.status(400).json({ error: 'node_id must be an integer or null' });
    return false;
  }
  const localNodeId = NodeRegistry.getInstance().getDefaultNodeId();
  if (nodeId !== localNodeId) {
    res.status(400).json({ error: 'node_id must match the local node or be null' });
    return false;
  }
  return nodeId;
}

function validateLabelIds(label_ids: unknown, res: Response): boolean {
  if (label_ids === undefined || label_ids === null) return true;
  if (!Array.isArray(label_ids) || label_ids.some((id: unknown) => typeof id !== 'number' || !Number.isInteger(id))) {
    res.status(400).json({ error: 'label_ids must be an array of integers or null' });
    return false;
  }
  return true;
}

function validateCategories(categories: unknown, res: Response): boolean {
  if (categories === undefined || categories === null) return true;
  if (!Array.isArray(categories) || categories.some((c: unknown) => typeof c !== 'string' || !VALID_CATEGORIES.has(c as NotificationCategory))) {
    res.status(400).json({ error: 'categories must be an array of valid category names' });
    return false;
  }
  return true;
}

export const notificationsRouter = Router();

notificationsRouter.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const nodeId = req.nodeId ?? 0;
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const history = DatabaseService.getInstance().getNotificationHistory(nodeId, 50, category);
    res.json(history);
  } catch {
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

notificationsRouter.post('/read', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const nodeId = req.nodeId ?? 0;
    DatabaseService.getInstance().markAllNotificationsRead(nodeId);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to mark notifications read' });
  }
});

notificationsRouter.delete('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const id = parseIntParam(req, res, 'id', 'notification ID');
    if (id === null) return;
    const nodeId = req.nodeId ?? 0;
    DatabaseService.getInstance().deleteNotification(nodeId, id);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

notificationsRouter.delete('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const nodeId = req.nodeId ?? 0;
    DatabaseService.getInstance().deleteAllNotifications(nodeId);
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to clear notifications' });
  }
});

notificationsRouter.post('/test', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const { type, url } = req.body;
    if (!type || !(NOTIFICATION_CHANNEL_TYPES as readonly string[]).includes(type)) {
      res.status(400).json({ error: `type must be ${NOTIFICATION_CHANNEL_TYPES.join(', ')}` });
      return;
    }
    const urlErr = validateHttpsUrl(url);
    if (urlErr) { res.status(400).json({ error: `url ${urlErr}` }); return; }
    await NotificationService.getInstance().testDispatch(type, url);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Test failed', details: getErrorMessage(error, String(error)) });
  }
});

export const notificationRoutesRouter = Router();

notificationRoutesRouter.get('/', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  try {
    const routes = DatabaseService.getInstance().getNotificationRoutes();
    res.json(routes);
  } catch (error) {
    console.error('Failed to fetch notification routes:', error);
    res.status(500).json({ error: 'Failed to fetch notification routes' });
  }
});

notificationRoutesRouter.post('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  try {
    const { name, node_id: rawNodeId, stack_patterns, label_ids, categories, channel_type, channel_url, priority, enabled } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }
    if (name.trim().length > 100) {
      res.status(400).json({ error: 'Name must be 100 characters or fewer' });
      return;
    }
    const nodeIdResult = validateNodeId(rawNodeId, res);
    if (nodeIdResult === false) return;
    const cleanedPatterns = Array.isArray(stack_patterns) ? cleanStackPatterns(stack_patterns) : [];
    if (Array.isArray(stack_patterns) && stack_patterns.some((p: unknown) => typeof p !== 'string')) {
      res.status(400).json({ error: 'stack_patterns must be an array of strings' });
      return;
    }
    if (!validateLabelIds(label_ids, res)) return;
    if (!validateCategories(categories, res)) return;
    if (!(NOTIFICATION_CHANNEL_TYPES as readonly string[]).includes(channel_type)) {
      res.status(400).json({ error: `channel_type must be ${NOTIFICATION_CHANNEL_TYPES.join(', ')}` });
      return;
    }
    const channelUrlErr = validateHttpsUrl(channel_url);
    if (channelUrlErr) { res.status(400).json({ error: `channel_url ${channelUrlErr}` }); return; }
    if (priority !== undefined && (typeof priority !== 'number' || !Number.isFinite(priority))) {
      res.status(400).json({ error: 'priority must be a finite number' });
      return;
    }

    const now = Date.now();
    const route = DatabaseService.getInstance().createNotificationRoute({
      name: name.trim(),
      node_id: nodeIdResult,
      stack_patterns: cleanedPatterns,
      label_ids: Array.isArray(label_ids) && label_ids.length > 0 ? label_ids : null,
      categories: Array.isArray(categories) && categories.length > 0 ? (categories as NotificationCategory[]) : null,
      channel_type,
      channel_url: channel_url.trim(),
      priority: typeof priority === 'number' ? priority : 0,
      enabled: enabled !== false,
      created_at: now,
      updated_at: now,
    });
    console.log(`[Routes] Route "${route.name}" created (id=${route.id})`);
    if (isDebugEnabled()) console.log(`[Routes:diag] Route "${route.name}" created with patterns=[${cleanedPatterns}], channel=${channel_type}`);
    res.status(201).json(route);
  } catch (error) {
    console.error('Failed to create notification route:', error);
    res.status(500).json({ error: 'Failed to create notification route' });
  }
});

notificationRoutesRouter.put('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'route ID');
    if (id === null) return;

    const existing = DatabaseService.getInstance().getNotificationRoute(id);
    if (!existing) { res.status(404).json({ error: 'Route not found' }); return; }

    const { name, node_id: rawNodeId, stack_patterns, label_ids, categories, channel_type, channel_url, priority, enabled } = req.body;

    if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
      res.status(400).json({ error: 'Name must be a non-empty string' });
      return;
    }
    if (name !== undefined && name.trim().length > 100) {
      res.status(400).json({ error: 'Name must be 100 characters or fewer' });
      return;
    }
    let validatedNodeId: number | null | undefined;
    if ('node_id' in req.body) {
      const result = validateNodeId(rawNodeId, res);
      if (result === false) return;
      validatedNodeId = result;
    }
    let cleanedPatterns: string[] | undefined;
    if (stack_patterns !== undefined) {
      if (!Array.isArray(stack_patterns) || stack_patterns.some((p: unknown) => typeof p !== 'string')) {
        res.status(400).json({ error: 'stack_patterns must be an array of strings' });
        return;
      }
      cleanedPatterns = cleanStackPatterns(stack_patterns);
    }
    if (!validateLabelIds(label_ids, res)) return;
    if (!validateCategories(categories, res)) return;
    if (channel_type !== undefined && !(NOTIFICATION_CHANNEL_TYPES as readonly string[]).includes(channel_type)) {
      res.status(400).json({ error: `channel_type must be ${NOTIFICATION_CHANNEL_TYPES.join(', ')}` });
      return;
    }
    if (channel_url !== undefined) {
      const urlErr = validateHttpsUrl(channel_url);
      if (urlErr) { res.status(400).json({ error: `channel_url ${urlErr}` }); return; }
    }
    if (priority !== undefined && (typeof priority !== 'number' || !Number.isFinite(priority))) {
      res.status(400).json({ error: 'priority must be a finite number' });
      return;
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }

    const updates: Record<string, unknown> = { updated_at: Date.now() };
    if (name !== undefined) updates.name = name.trim();
    if (validatedNodeId !== undefined) updates.node_id = validatedNodeId;
    if (cleanedPatterns !== undefined) updates.stack_patterns = cleanedPatterns;
    if ('label_ids' in req.body) updates.label_ids = Array.isArray(label_ids) && label_ids.length > 0 ? label_ids : null;
    if ('categories' in req.body) updates.categories = Array.isArray(categories) && categories.length > 0 ? categories : null;
    if (channel_type !== undefined) updates.channel_type = channel_type;
    if (channel_url !== undefined) updates.channel_url = channel_url.trim();
    if (priority !== undefined) updates.priority = priority;
    if (enabled !== undefined) updates.enabled = enabled;

    const db = DatabaseService.getInstance();
    db.updateNotificationRoute(id, updates);
    const updated = db.getNotificationRoute(id);
    console.log(`[Routes] Route ${id} updated`);
    if (isDebugEnabled()) console.log(`[Routes:diag] Route ${id} update fields: ${Object.keys(updates).filter(k => k !== 'updated_at')}`);
    res.json(updated);
  } catch (error) {
    console.error('Failed to update notification route:', error);
    res.status(500).json({ error: 'Failed to update notification route' });
  }
});

notificationRoutesRouter.delete('/:id', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'route ID');
    if (id === null) return;

    const changes = DatabaseService.getInstance().deleteNotificationRoute(id);
    if (changes === 0) { res.status(404).json({ error: 'Route not found' }); return; }
    console.log(`[Routes] Route ${id} deleted`);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete notification route:', error);
    res.status(500).json({ error: 'Failed to delete notification route' });
  }
});

notificationRoutesRouter.post('/:id/test', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'route ID');
    if (id === null) return;

    const route = DatabaseService.getInstance().getNotificationRoute(id);
    if (!route) { res.status(404).json({ error: 'Route not found' }); return; }

    if (isDebugEnabled()) console.log(`[Routes:diag] Test dispatch for route ${id} (${route.channel_type} -> ${route.channel_url})`);
    await NotificationService.getInstance().testDispatch(route.channel_type, route.channel_url);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Test failed', details: getErrorMessage(error, String(error)) });
  }
});

