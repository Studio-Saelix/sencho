import { Router, type Request, type Response } from 'express';
import {
  DatabaseService,
  type NotificationSuppressionAppliesTo,
  type NotificationSuppressionRetraction,
  type NotificationSuppressionRule,
} from '../services/DatabaseService';
import { NotificationService, ALL_NOTIFICATION_CATEGORIES, ALL_SUPPRESSIBLE_CATEGORIES } from '../services/NotificationService';
import type { NotificationCategory } from '../services/NotificationService';
import { NodeRegistry } from '../services/NodeRegistry';
import { authMiddleware } from '../middleware/auth';
import { requireAdmin, requireNodeProxy } from '../middleware/tierGates';
import {
  NOTIFICATION_CHANNEL_TYPES,
  serializePublicNotificationRoute,
  validateNotificationChannel,
  maskWebhookUrl,
  normalizeAppriseStoredJson,
  parseStoredAppriseConfig,
  redactedChannelWriteError,
  resolvePreservedAppriseConfig,
  storedAppriseToWriteConfig,
} from '../helpers/notificationChannels';
import { parseStackPatternsInput } from '../helpers/stackPattern';
import {
  parseNotificationSchedule,
  type NotificationSchedule,
} from '../helpers/notificationSchedule';
import { resolvePayloadTemplate } from '../helpers/notificationPayloadTemplate';
import {
  deleteSuppressionRuleFromFleet,
  syncSuppressionRuleToFleet,
  syncSuppressionRuleUpdateToFleet,
} from '../helpers/notificationSuppressionSync';
import { isDebugEnabled } from '../utils/debug';
import { logDebugTiming } from '../utils/requestTiming';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';
import { parseIntParam } from '../utils/parseIntParam';

const VALID_CATEGORIES: ReadonlySet<NotificationCategory> = new Set(ALL_NOTIFICATION_CATEGORIES);
const VALID_SUPPRESSION_CATEGORIES: ReadonlySet<NotificationCategory> = new Set(ALL_SUPPRESSIBLE_CATEGORIES);
const VALID_LEVELS = new Set(['info', 'warning', 'error']);
const VALID_APPLIES_TO = new Set<NotificationSuppressionAppliesTo>(['bell', 'external', 'both']);

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Omitted / empty body (old hub) -> permanent watermark 0.
 * Present body with any keys must be a complete valid retraction or 400.
 */
function parseReplicaRetractionBody(
  body: unknown,
  res: Response,
): NotificationSuppressionRetraction | false {
  if (
    body == null ||
    (typeof body === 'object' && !Array.isArray(body) && Object.keys(body as object).length === 0)
  ) {
    return { kind: 'permanent', source_updated_at: 0 };
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ error: 'retraction body must be an object' });
    return false;
  }
  const raw = body as Record<string, unknown>;
  const kind = raw.kind;
  const source = raw.source_updated_at;
  if (kind !== 'permanent' && kind !== 'recoverable') {
    res.status(400).json({ error: 'kind must be permanent or recoverable' });
    return false;
  }
  if (!isNonNegativeSafeInteger(source)) {
    res.status(400).json({ error: 'source_updated_at must be a non-negative safe integer' });
    return false;
  }
  return { kind, source_updated_at: source };
}

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

/**
 * Resolve schedule with presence semantics.
 * Create/replica omit → null; PUT omit → undefined (preserve); null clears; object validates.
 */
function resolveScheduleField(
  schedule: unknown,
  opts: { present: boolean; isCreate: boolean },
  res: Response,
): NotificationSchedule | null | undefined | false {
  if (!opts.present) {
    return opts.isCreate ? null : undefined;
  }
  if (schedule === null) return null;
  const parsed = parseNotificationSchedule(schedule);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return false;
  }
  return parsed.schedule;
}

function normalizeStoredLevels(levels: unknown): ('info' | 'warning' | 'error')[] | null {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  return levels as ('info' | 'warning' | 'error')[];
}

/** Resolve stack_patterns with presence semantics. Returns false after sending 400. */
function resolveStackPatternsField(
  stack_patterns: unknown,
  opts: { isCreate: boolean },
  res: Response,
): string[] | undefined | false {
  if (stack_patterns === undefined) {
    return opts.isCreate ? [] : undefined;
  }
  const parsed = parseStackPatternsInput(stack_patterns);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return false;
  }
  return parsed.patterns;
}

function parseSuppressionRuleBody(
  req: Request,
  res: Response,
  isCreate: boolean,
): Omit<NotificationSuppressionRule, 'id' | 'created_at' | 'updated_at' | 'scheduleInvalid'> | null {
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
    schedule,
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

  const cleanedPatterns = resolveStackPatternsField(stack_patterns, { isCreate }, res);
  if (cleanedPatterns === false) return null;

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

  const scheduleResult = resolveScheduleField(schedule, {
    present: 'schedule' in req.body,
    isCreate,
  }, res);
  if (scheduleResult === false) return null;

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
    levels: normalizeStoredLevels(levels),
    applies_to: (appliesToResult ?? 'both') as NotificationSuppressionAppliesTo,
    enabled: enabled !== false,
    expires_at: expiresAtResult ?? null,
    schedule: scheduleResult ?? null,
  };
}

export const notificationsRouter = Router();

notificationsRouter.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const startedAt = Date.now();
  let outcome: 'ok' | 'error' = 'ok';
  let count = 0;
  try {
    const nodeId = req.nodeId ?? 0;
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const history = DatabaseService.getInstance().getNotificationHistory(nodeId, 50, category);
    count = history.length;
    res.json(history);
  } catch (error) {
    outcome = 'error';
    console.error('Failed to fetch notifications:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  } finally {
    logDebugTiming('[Notifications:debug]', {
      route: 'GET /',
      nodeId: req.nodeId,
      count,
      elapsedMs: Date.now() - startedAt,
      outcome,
    });
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
    const { type, url, config, payload_template } = req.body;
    if (!type || !(NOTIFICATION_CHANNEL_TYPES as readonly string[]).includes(type)) {
      res.status(400).json({ error: `type must be ${NOTIFICATION_CHANNEL_TYPES.join(', ')}` });
      return;
    }
    const channelErr = validateNotificationChannel(type, url, config);
    if (channelErr) { res.status(400).json({ error: `url ${channelErr}` }); return; }
    const resolvedTemplate = resolvePayloadTemplate(payload_template, null, type);
    if (!resolvedTemplate.ok) {
      res.status(400).json({ error: `payload_template ${resolvedTemplate.error}` });
      return;
    }
    await NotificationService.getInstance().testDispatch(type, url, config, resolvedTemplate.value);
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
    res.json(routes.map(serializePublicNotificationRoute));
  } catch (error) {
    console.error('Failed to fetch notification routes:', error);
    res.status(500).json({ error: 'Failed to fetch notification routes' });
  }
});

notificationRoutesRouter.post('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const { name, node_id: rawNodeId, stack_patterns, label_ids, categories, levels, channel_type, channel_url, config, priority, enabled } = req.body;

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
    const cleanedPatterns = resolveStackPatternsField(stack_patterns, { isCreate: true }, res);
    if (cleanedPatterns === false) return;
    if (!validateLabelIds(label_ids, res)) return;
    if (!validateCategories(categories, res)) return;
    if (!validateLevels(levels, res)) return;
    if (!(NOTIFICATION_CHANNEL_TYPES as readonly string[]).includes(channel_type)) {
      res.status(400).json({ error: `channel_type must be ${NOTIFICATION_CHANNEL_TYPES.join(', ')}` });
      return;
    }
    const channelUrlErr = validateNotificationChannel(channel_type, channel_url, config);
    if (channelUrlErr) { res.status(400).json({ error: `channel_url ${channelUrlErr}` }); return; }
    if (priority !== undefined && (typeof priority !== 'number' || !Number.isFinite(priority))) {
      res.status(400).json({ error: 'priority must be a finite number' });
      return;
    }

    const now = Date.now();
    const route = DatabaseService.getInstance().createNotificationRoute({
      name: name.trim(),
      node_id: nodeIdResult,
      stack_patterns: cleanedPatterns ?? [],
      label_ids: Array.isArray(label_ids) && label_ids.length > 0 ? label_ids : null,
      categories: Array.isArray(categories) && categories.length > 0 ? (categories as NotificationCategory[]) : null,
      levels: normalizeStoredLevels(levels),
      channel_type,
      channel_url: channel_url.trim(),
      config: channel_type === 'apprise' ? normalizeAppriseStoredJson(channel_url.trim(), config) : null,
      priority: typeof priority === 'number' ? priority : 0,
      enabled: enabled !== false,
      created_at: now,
      updated_at: now,
    });
    console.log(`[Routes] Route "${sanitizeForLog(route.name)}" created (id=${route.id})`);
    if (isDebugEnabled()) console.log(`[Routes:diag] Route "${sanitizeForLog(route.name)}" created with patterns=[${sanitizeForLog((cleanedPatterns ?? []).join(', '))}], channel=${channel_type}`);
    res.status(201).json(serializePublicNotificationRoute(route));
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

    const { name, node_id: rawNodeId, stack_patterns, label_ids, categories, levels, channel_type, channel_url, config, priority, enabled } = req.body;

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
    const cleanedPatterns = resolveStackPatternsField(stack_patterns, { isCreate: false }, res);
    if (cleanedPatterns === false) return;
    if (!validateLabelIds(label_ids, res)) return;
    if (!validateCategories(categories, res)) return;
    if ('levels' in req.body && !validateLevels(levels, res)) return;
    if (channel_type !== undefined && !(NOTIFICATION_CHANNEL_TYPES as readonly string[]).includes(channel_type)) {
      res.status(400).json({ error: `channel_type must be ${NOTIFICATION_CHANNEL_TYPES.join(', ')}` });
      return;
    }
    const typeChanged = channel_type !== undefined && channel_type !== existing.channel_type;
    // Type changes replace credentials; never reuse a prior channel's URL/config (ciphertext or plaintext).
    if (typeChanged && (typeof channel_url !== 'string' || !channel_url.trim())) {
      res.status(400).json({ error: 'channel_url is required when changing channel_type' });
      return;
    }
    const effectiveType = channel_type ?? existing.channel_type;
    const effectiveUrl = channel_url !== undefined ? String(channel_url).trim() : existing.channel_url;
    let effectiveConfig: unknown = config ?? null;
    if (effectiveType === 'apprise' && config === undefined) {
      if (typeChanged) {
        // Fresh Apprise credentials: empty keyed (or stateless urls required via validate).
        effectiveConfig = null;
      } else {
        const resolved = resolvePreservedAppriseConfig(effectiveUrl, existing.config);
        if (!resolved.ok) { res.status(400).json({ error: resolved.error }); return; }
        effectiveConfig = resolved.config;
      }
    }
    const redactedErr = redactedChannelWriteError(effectiveType, effectiveUrl, effectiveConfig, config);
    if (redactedErr) { res.status(400).json({ error: redactedErr }); return; }
    const urlErr = validateNotificationChannel(effectiveType, effectiveUrl, effectiveConfig);
    if (urlErr) { res.status(400).json({ error: `channel_url ${urlErr}` }); return; }
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
    if ('levels' in req.body) updates.levels = normalizeStoredLevels(levels);
    if (channel_type !== undefined) updates.channel_type = channel_type;
    if (channel_url !== undefined || typeChanged) updates.channel_url = effectiveUrl;
    if (effectiveType === 'apprise') updates.config = normalizeAppriseStoredJson(effectiveUrl, effectiveConfig);
    else if (typeChanged || channel_type !== undefined) updates.config = null;
    if (priority !== undefined) updates.priority = priority;
    if (enabled !== undefined) updates.enabled = enabled;

    const db = DatabaseService.getInstance();
    db.updateNotificationRoute(id, updates);
    const updated = db.getNotificationRoute(id);
    console.log(`[Routes] Route ${id} updated`);
    if (isDebugEnabled()) console.log(`[Routes:diag] Route ${id} update fields: ${Object.keys(updates).filter(k => k !== 'updated_at')}`);
    res.json(serializePublicNotificationRoute(updated!));
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
    let testConfig: unknown;
    if (route.channel_type === 'apprise') {
      const stored = parseStoredAppriseConfig(route.channel_url, route.config);
      if (!stored.ok) {
        res.status(400).json({ error: stored.reason });
        return;
      }
      testConfig = storedAppriseToWriteConfig(stored);
    } else {
      testConfig = route.config ? JSON.parse(route.config) : undefined;
    }
    await NotificationService.getInstance().testDispatch(route.channel_type, route.channel_url, testConfig);
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
    if (!('stack_patterns' in rule)) {
      res.status(400).json({ error: 'stack_patterns is required on replica rule' });
      return;
    }
    const patterns = parseStackPatternsInput(rule.stack_patterns);
    if (!patterns.ok) {
      res.status(400).json({ error: patterns.error });
      return;
    }
    if (!validateLabelIds(rule.label_ids, res)) return;
    if (!validateCategories(rule.categories, res, VALID_SUPPRESSION_CATEGORIES)) return;
    if (!validateLevels(rule.levels, res)) return;
    const scheduleResult = resolveScheduleField(rule.schedule, {
      present: 'schedule' in rule,
      isCreate: true,
    }, res);
    if (scheduleResult === false) return;
    if (!isNonNegativeSafeInteger(rule.created_at)) {
      res.status(400).json({ error: 'created_at must be a non-negative safe integer' });
      return;
    }
    if (!isNonNegativeSafeInteger(rule.updated_at)) {
      res.status(400).json({ error: 'updated_at must be a non-negative safe integer' });
      return;
    }

    const outcome = DatabaseService.getInstance().upsertNotificationSuppressionRuleReplica({
      ...rule,
      stack_patterns: patterns.patterns,
      label_ids: Array.isArray(rule.label_ids) && rule.label_ids.length > 0 ? rule.label_ids : null,
      categories: Array.isArray(rule.categories) && rule.categories.length > 0 ? rule.categories : null,
      levels: normalizeStoredLevels(rule.levels),
      schedule: scheduleResult ?? null,
      scheduleInvalid: false,
      enabled: rule.enabled !== false,
      expires_at: rule.expires_at ?? null,
      created_at: rule.created_at,
      updated_at: rule.updated_at,
      // Replicas are always node-agnostic on the receiving node: the hub's node_id
      // is a hub-local scoping concept and never trustworthy as a foreign key here.
      node_id: null,
    });
    res.json({ success: true, outcome });
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
    const retraction = parseReplicaRetractionBody(req.body, res);
    if (retraction === false) return;
    const { outcome } = DatabaseService.getInstance().deleteNotificationSuppressionRule(id, retraction);
    res.json({ success: true, outcome });
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
      schedule,
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
      const resolved = resolveStackPatternsField(stack_patterns, { isCreate: false }, res);
      if (resolved === false) return;
      cleanedPatterns = resolved;
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

    let validatedSchedule: NotificationSchedule | null | undefined;
    if ('schedule' in req.body) {
      const result = resolveScheduleField(schedule, { present: true, isCreate: false }, res);
      if (result === false) return;
      validatedSchedule = result;
    }

    if (enabled !== undefined && typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }

    const updates: Partial<Omit<NotificationSuppressionRule, 'id' | 'created_at' | 'scheduleInvalid'>> = {
      updated_at: Date.now(),
    };
    if (name !== undefined) updates.name = name.trim();
    if (validatedNodeId !== undefined) updates.node_id = validatedNodeId;
    if (cleanedPatterns !== undefined) updates.stack_patterns = cleanedPatterns;
    if ('label_ids' in req.body) updates.label_ids = Array.isArray(label_ids) && label_ids.length > 0 ? label_ids : null;
    if ('categories' in req.body) updates.categories = Array.isArray(categories) && categories.length > 0 ? categories : null;
    if ('levels' in req.body) updates.levels = Array.isArray(levels) && levels.length > 0 ? levels : null;
    if (validatedAppliesTo !== undefined) updates.applies_to = validatedAppliesTo;
    if (enabled !== undefined) updates.enabled = enabled;
    if (validatedExpiresAt !== undefined) updates.expires_at = validatedExpiresAt;
    if (validatedSchedule !== undefined) updates.schedule = validatedSchedule;

    const db = DatabaseService.getInstance();
    db.updateNotificationSuppressionRule(id, updates);
    const updated = db.getNotificationSuppressionRule(id)!;
    syncSuppressionRuleUpdateToFleet(existing, updated);
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

    DatabaseService.getInstance().deleteNotificationSuppressionRule(id, {
      kind: 'permanent',
      source_updated_at: existing.updated_at,
    });
    deleteSuppressionRuleFromFleet(existing);
    console.log(`[Suppression] Rule ${id} deleted`);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to delete notification suppression rule:', error);
    res.status(500).json({ error: 'Failed to delete notification suppression rule' });
  }
});

