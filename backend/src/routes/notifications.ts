import { Router, type Request, type Response } from 'express';
import { DatabaseService, type NotificationSuppressionAppliesTo, type NotificationSuppressionRule } from '../services/DatabaseService';
import { NotificationService, ALL_NOTIFICATION_CATEGORIES, ALL_SUPPRESSIBLE_CATEGORIES } from '../services/NotificationService';
import type { NotificationCategory } from '../services/NotificationService';
import { NodeRegistry } from '../services/NodeRegistry';
import { authMiddleware } from '../middleware/auth';
import { requireAdmin, requireNodeProxy } from '../middleware/tierGates';
import {
  NOTIFICATION_CHANNEL_TYPES,
  validateHttpsUrl,
  cleanStackPatterns,
  maskWebhookUrl,
} from '../helpers/notificationChannels';
import {
  deleteSuppressionRuleFromFleet,
  syncSuppressionRuleToFleet,
} from '../helpers/notificationSuppressionSync';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';
import { parseIntParam } from '../utils/parseIntParam';

const VALID_CATEGORIES: ReadonlySet<NotificationCategory> = new Set(ALL_NOTIFICATION_CATEGORIES);
const VALID_SUPPRESSION_CATEGORIES: ReadonlySet<NotificationCategory> = new Set(ALL_SUPPRESSIBLE_CATEGORIES);
const VALID_LEVELS = new Set(['info', 'warning', 'error']);
const VALID_APPLIES_TO = new Set<NotificationSuppressionAppliesTo>(['bell', 'external', 'both']);

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

function validateCategories(
  categories: unknown,
  res: Response,
  allowed: ReadonlySet<NotificationCategory> = VALID_CATEGORIES,
): boolean {
  if (categories === undefined || categories === null) return true;
  if (!Array.isArray(categories) || categories.some((c: unknown) => typeof c !== 'string' || !allowed.has(c as NotificationCategory))) {
    res.status(400).json({ error: 'categories must be an array of valid category names' });
    return false;
  }
  return true;
}

function validateSuppressionNodeId(nodeId: unknown, res: Response): number | null | false {
  if (nodeId === undefined || nodeId === null) return null;
  if (typeof nodeId !== 'number' || !Number.isInteger(nodeId)) {
    res.status(400).json({ error: 'node_id must be an integer or null' });
    return false;
  }
  const node = DatabaseService.getInstance().getNode(nodeId);
  if (!node) {
    res.status(400).json({ error: 'node_id must reference a registered node or be null' });
    return false;
  }
  return nodeId;
}

function validateLevels(levels: unknown, res: Response): boolean {
  if (levels === undefined || levels === null) return true;
  if (!Array.isArray(levels) || levels.some((l: unknown) => typeof l !== 'string' || !VALID_LEVELS.has(l))) {
    res.status(400).json({ error: 'levels must be an array of info, warning, or error' });
    return false;
  }
  return true;
}

function validateAppliesTo(applies_to: unknown, res: Response): NotificationSuppressionAppliesTo | false {
  if (typeof applies_to !== 'string' || !VALID_APPLIES_TO.has(applies_to as NotificationSuppressionAppliesTo)) {
    res.status(400).json({ error: 'applies_to must be bell, external, or both' });
    return false;
  }
  return applies_to as NotificationSuppressionAppliesTo;
}

function validateExpiresAt(expires_at: unknown, res: Response): number | null | false | undefined {
  if (expires_at === undefined) return undefined;
  if (expires_at === null) return null;
  if (typeof expires_at !== 'number' || !Number.isFinite(expires_at)) {
    res.status(400).json({ error: 'expires_at must be a finite timestamp or null' });
    return false;
  }
  return expires_at;
}

function parseSuppressionRuleBody(
  req: Request,
  res: Response,
  isCreate: boolean,
): Omit<NotificationSuppressionRule, 'id' | 'created_at' | 'updated_at'> | null {
  const {
    name,
    node_id: rawNodeId,
    stack_patterns,
    label_ids,
    categories,
    levels,
    applies_to,
    enabled,
    expires_at,
  } = req.body;

  if (isCreate && (!name || typeof name !== 'string' || !name.trim())) {
    res.status(400).json({ error: 'Name is required' });
    return null;
  }
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    res.status(400).json({ error: 'Name must be a non-empty string' });
    return null;
  }
  if (name !== undefined && name.trim().length > 100) {
    res.status(400).json({ error: 'Name must be 100 characters or fewer' });
    return null;
  }

  const nodeIdResult = isCreate || 'node_id' in req.body
    ? validateSuppressionNodeId(rawNodeId, res)
    : undefined;
  if (nodeIdResult === false) return null;

  let cleanedPatterns: string[] | undefined;
  if (stack_patterns !== undefined) {
    if (!Array.isArray(stack_patterns) || stack_patterns.some((p: unknown) => typeof p !== 'string')) {
      res.status(400).json({ error: 'stack_patterns must be an array of strings' });
      return null;
    }
    cleanedPatterns = cleanStackPatterns(stack_patterns);
  } else if (isCreate) {
    cleanedPatterns = [];
  }

  if (!validateLabelIds(label_ids, res)) return null;
  if (!validateCategories(categories, res, VALID_SUPPRESSION_CATEGORIES)) return null;
  if (!validateLevels(levels, res)) return null;

  const appliesToResult = isCreate
    ? validateAppliesTo(applies_to, res)
    : applies_to !== undefined
      ? validateAppliesTo(applies_to, res)
      : undefined;
  if (appliesToResult === false) return null;

  const expiresAtResult = validateExpiresAt(expires_at, res);
  if (expiresAtResult === false) return null;

  if (enabled !== undefined && typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean' });
    return null;
  }

  return {
    name: (name as string).trim(),
    node_id: nodeIdResult ?? null,
    stack_patterns: cleanedPatterns ?? [],
    label_ids: Array.isArray(label_ids) && label_ids.length > 0 ? label_ids : null,
    categories: Array.isArray(categories) && categories.length > 0 ? categories : null,
    levels: Array.isArray(levels) && levels.length > 0 ? levels : null,
    applies_to: (appliesToResult ?? 'both') as NotificationSuppressionAppliesTo,
    enabled: enabled !== false,
    expires_at: expiresAtResult ?? null,
  };
}

export const notificationsRouter = Router();

notificationsRouter.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const nodeId = req.nodeId ?? 0;
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const history = DatabaseService.getInstance().getNotificationHistory(nodeId, 50, category);
    res.json(history);
  } catch (error) {
    console.error('Failed to fetch notifications:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

notificationsRouter.post('/read', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const nodeId = req.nodeId ?? 0;
    DatabaseService.getInstance().markAllNotificationsRead(nodeId);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to mark notifications read:', error);
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
  } catch (error) {
    console.error('Failed to delete notification:', error);
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

notificationsRouter.delete('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const nodeId = req.nodeId ?? 0;
    DatabaseService.getInstance().deleteAllNotifications(nodeId);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to clear notifications:', error);
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
    console.log(`[Routes] Route "${sanitizeForLog(route.name)}" created (id=${route.id})`);
    if (isDebugEnabled()) console.log(`[Routes:diag] Route "${sanitizeForLog(route.name)}" created with patterns=[${sanitizeForLog(cleanedPatterns.join(', '))}], channel=${channel_type}`);
    res.status(201).json(route);
  } catch (error) {
    console.error('Failed to create notification route:', error);
    res.status(500).json({ error: 'Failed to create notification route' });
  }
});

notificationRoutesRouter.put('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
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
  try {
    const id = parseIntParam(req, res, 'id', 'route ID');
    if (id === null) return;

    const route = DatabaseService.getInstance().getNotificationRoute(id);
    if (!route) { res.status(404).json({ error: 'Route not found' }); return; }

    if (isDebugEnabled()) console.log(`[Routes:diag] Test dispatch for route ${id} (${route.channel_type} -> ${maskWebhookUrl(route.channel_url)})`);
    await NotificationService.getInstance().testDispatch(route.channel_type, route.channel_url);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Test failed', details: getErrorMessage(error, String(error)) });
  }
});

export const notificationSuppressionRouter = Router();

notificationSuppressionRouter.post('/replica', authMiddleware, (req: Request, res: Response): void => {
  if (!requireNodeProxy(req, res)) return;
  try {
    const rule = req.body?.rule as NotificationSuppressionRule | undefined;
    if (!rule || typeof rule.id !== 'number' || typeof rule.name !== 'string') {
      res.status(400).json({ error: 'rule object with id and name is required' });
      return;
    }
    if (!VALID_APPLIES_TO.has(rule.applies_to)) {
      res.status(400).json({ error: 'Invalid applies_to on rule' });
      return;
    }
    DatabaseService.getInstance().upsertNotificationSuppressionRuleReplica(rule);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to apply suppression rule replica:', error);
    res.status(500).json({ error: 'Failed to apply suppression rule replica' });
  }
});

notificationSuppressionRouter.delete('/replica/:id', authMiddleware, (req: Request, res: Response): void => {
  if (!requireNodeProxy(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'suppression rule ID');
    if (id === null) return;
    DatabaseService.getInstance().deleteNotificationSuppressionRule(id);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete suppression rule replica:', error);
    res.status(500).json({ error: 'Failed to delete suppression rule replica' });
  }
});

notificationSuppressionRouter.get('/', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  try {
    const rules = DatabaseService.getInstance().getNotificationSuppressionRules();
    res.json(rules);
  } catch (error) {
    console.error('Failed to fetch notification suppression rules:', error);
    res.status(500).json({ error: 'Failed to fetch notification suppression rules' });
  }
});

notificationSuppressionRouter.post('/', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  try {
    const parsed = parseSuppressionRuleBody(req, res, true);
    if (!parsed) return;

    const now = Date.now();
    const rule = DatabaseService.getInstance().createNotificationSuppressionRule({
      ...parsed,
      created_at: now,
      updated_at: now,
    });
    syncSuppressionRuleToFleet(rule);
    console.log(`[Suppression] Rule "${sanitizeForLog(rule.name)}" created (id=${rule.id})`);
    res.status(201).json(rule);
  } catch (error) {
    console.error('Failed to create notification suppression rule:', error);
    res.status(500).json({ error: 'Failed to create notification suppression rule' });
  }
});

notificationSuppressionRouter.put('/:id', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'suppression rule ID');
    if (id === null) return;

    const existing = DatabaseService.getInstance().getNotificationSuppressionRule(id);
    if (!existing) { res.status(404).json({ error: 'Suppression rule not found' }); return; }

    const {
      name,
      node_id: rawNodeId,
      stack_patterns,
      label_ids,
      categories,
      levels,
      applies_to,
      enabled,
      expires_at,
    } = req.body;

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
      const result = validateSuppressionNodeId(rawNodeId, res);
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
    if (!validateCategories(categories, res, VALID_SUPPRESSION_CATEGORIES)) return;
    if (!validateLevels(levels, res)) return;

    let validatedAppliesTo: NotificationSuppressionAppliesTo | undefined;
    if (applies_to !== undefined) {
      const result = validateAppliesTo(applies_to, res);
      if (result === false) return;
      validatedAppliesTo = result;
    }

    let validatedExpiresAt: number | null | undefined;
    if ('expires_at' in req.body) {
      const result = validateExpiresAt(expires_at, res);
      if (result === false) return;
      validatedExpiresAt = result;
    }

    if (enabled !== undefined && typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }

    const updates: Partial<Omit<NotificationSuppressionRule, 'id' | 'created_at'>> = { updated_at: Date.now() };
    if (name !== undefined) updates.name = name.trim();
    if (validatedNodeId !== undefined) updates.node_id = validatedNodeId;
    if (cleanedPatterns !== undefined) updates.stack_patterns = cleanedPatterns;
    if ('label_ids' in req.body) updates.label_ids = Array.isArray(label_ids) && label_ids.length > 0 ? label_ids : null;
    if ('categories' in req.body) updates.categories = Array.isArray(categories) && categories.length > 0 ? categories : null;
    if ('levels' in req.body) updates.levels = Array.isArray(levels) && levels.length > 0 ? levels : null;
    if (validatedAppliesTo !== undefined) updates.applies_to = validatedAppliesTo;
    if (enabled !== undefined) updates.enabled = enabled;
    if (validatedExpiresAt !== undefined) updates.expires_at = validatedExpiresAt;

    const db = DatabaseService.getInstance();
    db.updateNotificationSuppressionRule(id, updates);
    const updated = db.getNotificationSuppressionRule(id)!;
    syncSuppressionRuleToFleet(updated);
    console.log(`[Suppression] Rule ${id} updated`);
    res.json(updated);
  } catch (error) {
    console.error('Failed to update notification suppression rule:', error);
    res.status(500).json({ error: 'Failed to update notification suppression rule' });
  }
});

notificationSuppressionRouter.delete('/:id', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'suppression rule ID');
    if (id === null) return;

    const existing = DatabaseService.getInstance().getNotificationSuppressionRule(id);
    if (!existing) { res.status(404).json({ error: 'Suppression rule not found' }); return; }

    DatabaseService.getInstance().deleteNotificationSuppressionRule(id);
    deleteSuppressionRuleFromFleet(existing);
    console.log(`[Suppression] Rule ${id} deleted`);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete notification suppression rule:', error);
    res.status(500).json({ error: 'Failed to delete notification suppression rule' });
  }
});

