import { Router, type Request, type Response } from 'express';
import { CronExpressionParser } from 'cron-parser';
import { DatabaseService, type ScheduledTask } from '../services/DatabaseService';
import {
  VALID_TARGET_TYPES,
  VALID_ACTIONS,
  INVALID_ACTION_MESSAGE,
  validateActionTarget,
  getScheduledActionDefinition,
  resolveTaskPermissionScope,
  type TargetType,
  type BackendScheduledAction,
} from '../services/scheduledActionRegistry';
import { SchedulerService } from '../services/SchedulerService';
import { NotificationService } from '../services/NotificationService';
import { checkPermission, requirePermission } from '../middleware/permissions';
import { escapeCsvField } from '../utils/csv';
import { getErrorMessage } from '../utils/errors';
import { parseIntParam } from '../utils/parseIntParam';
import { sanitizeForLog } from '../utils/safeLog';
import { isValidStackName, isValidContainerName } from '../utils/validation';

// Frontend listeners filter on scope === 'scheduled-tasks'. Wrapped so a
// broken subscriber socket cannot turn a successful mutation into a 500.
function broadcastScheduledTasksChanged(): void {
  try {
    NotificationService.getInstance().broadcastEvent({
      type: 'state-invalidate',
      scope: 'scheduled-tasks',
      ts: Date.now(),
    });
  } catch (err) {
    console.error('[ScheduledTasks] broadcast failed:', getErrorMessage(err, String(err)));
  }
}

const VALID_PRUNE_TARGETS = ['containers', 'images', 'networks', 'volumes'] as const;
const ERR_FLEET_NODE_REQUIRED = 'Fleet update requires node_id.';
const STACK_LABEL_SELECTOR = 'stack-label';
const LABEL_NAME_RE = /^[a-zA-Z0-9 -]+$/;

function isStackLabelSelector(selectorType: unknown): boolean {
  return selectorType === STACK_LABEL_SELECTOR;
}

/** True when this update+fleet task uses a stack-label selector (node_id may be null). */
function usesStackLabelSelector(action: BackendScheduledAction, targetType: TargetType, selectorType: unknown): boolean {
  return action === 'update' && targetType === 'fleet' && isStackLabelSelector(selectorType);
}

function parsePositiveNodeId(nodeId: unknown): number | null {
  if (typeof nodeId !== 'number' && typeof nodeId !== 'string') return null;
  if (typeof nodeId === 'string' && nodeId.trim().length === 0) return null;
  const parsedNodeId = Number(nodeId);
  return Number.isInteger(parsedNodeId) && parsedNodeId > 0 ? parsedNodeId : null;
}

function actionRequiresNode(action: BackendScheduledAction): boolean {
  return getScheduledActionDefinition(action)?.requiresNode === true;
}

function nodeRequirementLabel(action: BackendScheduledAction, targetType: TargetType): string {
  if (action === 'scan') return 'Scan';
  if (action === 'prune') return 'Prune';
  if (action === 'update' && targetType === 'fleet') return 'Fleet update';
  return action;
}

function localNodeRequirementLabel(action: BackendScheduledAction): string {
  if (action === 'scan') return 'Scheduled vulnerability scans';
  if (action === 'prune') return 'Scheduled prunes';
  return `${action} tasks`;
}

function validateStackTarget(targetType: TargetType, targetId: unknown, nodeId: unknown): string | null {
  if (targetType !== 'stack') return null;

  if (typeof targetId !== 'string' || !targetId.trim() || nodeId === null || nodeId === undefined) {
    return 'Stack operations require target_id and node_id.';
  }

  if (targetId !== targetId.trim() || !isValidStackName(targetId)) {
    return 'Stack target_id must be a valid stack name.';
  }

  if (parsePositiveNodeId(nodeId) === null) {
    return 'Stack operations require a valid node_id.';
  }

  return null;
}

function validateContainerTarget(targetType: TargetType, targetId: unknown, nodeId: unknown): string | null {
  if (targetType !== 'container') return null;

  if (typeof targetId !== 'string' || !targetId.trim() || nodeId === null || nodeId === undefined) {
    return 'Container operations require target_id and node_id.';
  }

  if (targetId !== targetId.trim() || !isValidContainerName(targetId)) {
    return 'Container target_id must be a valid container name.';
  }

  if (parsePositiveNodeId(nodeId) === null) {
    return 'Container operations require a valid node_id.';
  }

  return null;
}

/**
 * Shared guard for non-stack actions that require a node. Stack actions use
 * validateStackTarget because they also require target_id. Label-targeted
 * fleet updates may omit node_id (entire fleet); pass selectorType so that
 * path is allowed.
 */
function validateActionNode(
  action: BackendScheduledAction,
  targetType: TargetType,
  nodeId: unknown,
  selectorType?: unknown,
): string | null {
  if (targetType === 'stack' || targetType === 'container') return null;
  const def = getScheduledActionDefinition(action);
  if (!def?.requiresNode) return null;

  const labelSingular = nodeRequirementLabel(action, targetType);
  const labelPlural = localNodeRequirementLabel(action);
  const labelFleetUpdate = usesStackLabelSelector(action, targetType, selectorType);

  if (nodeId == null) {
    if (labelFleetUpdate) return null;
    return action === 'update' && targetType === 'fleet'
      ? ERR_FLEET_NODE_REQUIRED
      : `${labelSingular} action requires node_id.`;
  }

  const parsedNodeId = parsePositiveNodeId(nodeId);
  if (parsedNodeId === null) return `${labelSingular} action requires a valid node_id.`;
  if (def.nodeScope !== 'local') return null;

  const node = DatabaseService.getInstance().getNode(parsedNodeId);
  if (!node) return `${labelPlural} require an existing local node.`;
  if (node.type === 'remote') return `${labelPlural} currently require a local node.`;
  return null;
}

/** Shared validation for prune_targets, target_services, prune_label_filter, selector_*. Returns an error string or null. */
function validateOptionalFields(
  action: BackendScheduledAction,
  targetType: TargetType,
  prune_targets: unknown,
  target_services: unknown,
  prune_label_filter: unknown,
  selector_type?: unknown,
  selector_value?: unknown,
): string | null {
  if (prune_targets !== undefined && prune_targets !== null) {
    if (!Array.isArray(prune_targets) || prune_targets.length === 0
      || !prune_targets.every((t: string) => (VALID_PRUNE_TARGETS as readonly string[]).includes(t))) {
      return 'prune_targets must be a non-empty array of: containers, images, networks, volumes';
    }
  }
  if (target_services !== undefined && target_services !== null) {
    if (!Array.isArray(target_services) || target_services.length === 0
      || !target_services.every((s: unknown) => typeof s === 'string' && s.length > 0)) {
      return 'target_services must be a non-empty array of service name strings';
    }
    if (action !== 'restart' || targetType !== 'stack') {
      return 'target_services can only be used with restart action on stack target';
    }
  }
  if (prune_label_filter !== undefined && prune_label_filter !== null) {
    if (typeof prune_label_filter !== 'string' || prune_label_filter.trim().length === 0) {
      return 'prune_label_filter must be a non-empty string';
    }
    if (action !== 'prune') {
      return 'prune_label_filter can only be used with prune action';
    }
  }

  const selectorPresent = (selector_type !== undefined && selector_type !== null)
    || (selector_value !== undefined && selector_value !== null);
  if (selectorPresent) {
    if (action !== 'update' || targetType !== 'fleet') {
      return 'selector fields can only be used with update action on fleet target';
    }
    if (selector_type !== STACK_LABEL_SELECTOR) {
      return 'selector_type must be "stack-label"';
    }
    if (typeof selector_value !== 'string' || selector_value.trim().length === 0 || selector_value.trim().length > 30) {
      return 'selector_value is required and must be 1-30 characters';
    }
    if (!LABEL_NAME_RE.test(selector_value.trim())) {
      return 'selector_value may only contain letters, numbers, spaces, and hyphens';
    }
  }
  return null;
}

function normalizeSelectorFields(
  action: BackendScheduledAction,
  targetType: TargetType,
  selector_type: unknown,
  selector_value: unknown,
): { selector_type: string | null; selector_value: string | null } {
  if (action === 'update' && targetType === 'fleet' && isStackLabelSelector(selector_type)
    && typeof selector_value === 'string' && selector_value.trim()) {
    return { selector_type: STACK_LABEL_SELECTOR, selector_value: selector_value.trim() };
  }
  return { selector_type: null, selector_value: null };
}

/**
 * Validate a cron expression for Scheduled Operations. The scheduler ticks once
 * per minute, so an expression with a leading seconds field (6 or more fields)
 * is rejected: its sub-minute precision could never be honored. Cron nicknames
 * such as `@daily` (a single token) are left untouched. Returns an error message
 * or null.
 */
function validateCronExpression(cron: unknown): string | null {
  if (typeof cron !== 'string' || !cron.trim()) {
    return 'Cron expression is required.';
  }
  if (cron.trim().split(/\s+/).length >= 6) {
    return 'Cron expression must use 5 fields (minute hour day month weekday). The seconds field is not supported.';
  }
  try {
    CronExpressionParser.parse(cron);
  } catch (e) {
    console.warn('[Scheduler] Invalid cron expression rejected:', sanitizeForLog(cron), sanitizeForLog(getErrorMessage(e, 'unknown')));
    return 'Invalid cron expression.';
  }
  return null;
}

/**
 * Validate the optional explicit fire time. When present it must be a future
 * epoch-ms integer; absent (undefined/null) leaves the cron-derived next run in
 * place. By convention only a one-time ('once') schedule populates run_at (the
 * frontend's getOnceRunAt), because a 5-field cron has no year field and the
 * cron alone would fire on the next annual occurrence rather than the exact date
 * the admin chose; this validator itself only checks shape and futureness.
 */
function validateRunAt(runAt: unknown): string | null {
  if (runAt === undefined || runAt === null) return null;
  if (typeof runAt !== 'number' || !Number.isInteger(runAt)) {
    return 'run_at must be an epoch-millisecond timestamp.';
  }
  if (runAt <= Date.now()) {
    return 'run_at must be in the future.';
  }
  return null;
}

/**
 * Check whether the authenticated user can manage (create, edit, run, delete)
 * the given task. Consumes the centralized permission scope resolver so the
 * registry remains the single source of truth for action→permission mapping.
 */
function checkTaskPermission(
  req: Request,
  task: Pick<ScheduledTask, 'action' | 'target_type' | 'target_id' | 'node_id' | 'selector_type'>,
): boolean {
  const scope = resolveTaskPermissionScope(
    task.action as BackendScheduledAction,
    task.target_type as TargetType,
    task.target_id,
    task.node_id,
    task.selector_type,
  );
  return checkPermission(req, scope.action, scope.resourceType, scope.resourceId, scope.resourceNodeId);
}

/**
 * Require permission for a task. Sends 403 if denied; callers must `return;` on false.
 */
function requireTaskPermission(
  req: Request,
  res: Response,
  task: Pick<ScheduledTask, 'action' | 'target_type' | 'target_id' | 'node_id' | 'selector_type'>,
): boolean {
  const scope = resolveTaskPermissionScope(
    task.action as BackendScheduledAction,
    task.target_type as TargetType,
    task.target_id,
    task.node_id,
    task.selector_type,
  );
  return requirePermission(req, res, scope.action, scope.resourceType, scope.resourceId, scope.resourceNodeId);
}

/**
 * Require permission to access an existing task. Returns 404 (not 403) when
 * denied, so an unauthorized caller cannot distinguish "task does not exist"
 * from "task exists but you are not authorized." Used on by-ID endpoints
 * where the task's existence has already been confirmed.
 */
function requireTaskExistsPermission(
  req: Request,
  res: Response,
  task: Pick<ScheduledTask, 'action' | 'target_type' | 'target_id' | 'node_id' | 'selector_type'>,
): boolean {
  if (checkTaskPermission(req, task)) return true;
  res.status(404).json({ error: 'Scheduled task not found' });
  return false;
}

export const scheduledTasksRouter = Router();

scheduledTasksRouter.get('/', (req: Request, res: Response): void => {
  try {
    let tasks = DatabaseService.getInstance().getScheduledTasks();

    // Permission-filter the full list so a scoped deployer sees only tasks
    // targeting their authorized resources. Admin sees every task (checkTaskPermission
    // always returns true for admin via checkPermission's admin bypass).
    tasks = tasks.filter(t => checkTaskPermission(req, t));

    // `action` / `exclude_action` exist for the read-only consumers that
    // want a slice: the Auto-Update readiness card and the sidebar next-run
    // indicator both request `?action=update`.
    const actionFilter = typeof req.query.action === 'string' ? req.query.action : undefined;
    const excludeAction = typeof req.query.exclude_action === 'string' ? req.query.exclude_action : undefined;
    if (actionFilter) {
      tasks = tasks.filter(t => t.action === actionFilter);
    } else if (excludeAction) {
      tasks = tasks.filter(t => t.action !== excludeAction);
    }

    // Timeline view wants every firing inside a rolling window, not just the next run.
    const scheduler = SchedulerService.getInstance();
    const windowHours = Math.min(Math.max(Number(req.query.window_hours) || 24, 1), 168);
    const from = Date.now();
    const to = from + windowHours * 60 * 60 * 1000;
    const enriched = tasks.map(t => ({
      ...t,
      next_runs: t.enabled === 1 ? scheduler.calculateRunsWithin(t.cron_expression, from, to) : [],
    }));

    res.json(enriched);
  } catch (error) {
    console.error('[ScheduledTasks] List error:', error);
    res.status(500).json({ error: 'Failed to fetch scheduled tasks' });
  }
});

scheduledTasksRouter.post('/', (req: Request, res: Response): void => {
  try {
    const {
      name, target_type, target_id, node_id, action, cron_expression, enabled,
      prune_targets, target_services, prune_label_filter, selector_type, selector_value,
      delete_after_run, run_at,
    } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'Name is required' }); return;
    }
    if (!(VALID_TARGET_TYPES as readonly string[]).includes(target_type)) {
      res.status(400).json({ error: 'Invalid target_type. Must be stack, fleet, system, or container.' }); return;
    }
    if (!(VALID_ACTIONS as readonly string[]).includes(action)) {
      res.status(400).json({ error: INVALID_ACTION_MESSAGE }); return;
    }

    const targetErr = validateActionTarget(action, target_type);
    if (targetErr) { res.status(400).json({ error: targetErr }); return; }

    const nodeErr = validateActionNode(action, target_type, node_id, selector_type);
    if (nodeErr) { res.status(400).json({ error: nodeErr }); return; }
    const stackTargetErr = validateStackTarget(target_type, target_id, node_id);
    if (stackTargetErr) { res.status(400).json({ error: stackTargetErr }); return; }
    const containerTargetErr = validateContainerTarget(target_type, target_id, node_id);
    if (containerTargetErr) { res.status(400).json({ error: containerTargetErr }); return; }

    const optionalErr = validateOptionalFields(
      action, target_type, prune_targets, target_services, prune_label_filter, selector_type, selector_value,
    );
    if (optionalErr) { res.status(400).json({ error: optionalErr }); return; }

    const cronErr = validateCronExpression(cron_expression);
    if (cronErr) { res.status(400).json({ error: cronErr }); return; }

    const runAtErr = validateRunAt(run_at);
    if (runAtErr) { res.status(400).json({ error: runAtErr }); return; }

    const labelSelector = usesStackLabelSelector(action, target_type, selector_type);
    const normalizedNodeId = labelSelector
      ? (node_id == null || node_id === '' ? null : parsePositiveNodeId(node_id))
      : (actionRequiresNode(action) ? parsePositiveNodeId(node_id) : null);
    if (labelSelector && node_id != null && node_id !== '' && normalizedNodeId === null) {
      res.status(400).json({ error: 'Fleet update action requires a valid node_id.' }); return;
    }
    const normalizedTargetId =
      target_type === 'stack' || target_type === 'container' ? target_id : null;

    // Permission check on the resolved action+target scope.
    if (!requireTaskPermission(req, res, {
      action,
      target_type,
      target_id: normalizedTargetId,
      node_id: normalizedNodeId,
      selector_type: labelSelector ? STACK_LABEL_SELECTOR : null,
    })) return;

    const scheduler = SchedulerService.getInstance();
    const now = Date.now();
    const pinnedRunAt = typeof run_at === 'number' ? run_at : null;
    const nextRun = (enabled === false)
      ? null
      : (pinnedRunAt ?? scheduler.calculateNextRun(cron_expression));
    const selectors = normalizeSelectorFields(action, target_type, selector_type, selector_value);

    const id = DatabaseService.getInstance().createScheduledTask({
      name: name.trim(),
      target_type,
      target_id: normalizedTargetId,
      node_id: normalizedNodeId,
      action,
      cron_expression,
      enabled: enabled !== false ? 1 : 0,
      created_by: req.user?.username || 'admin',
      creator_user_id: req.user?.userId ?? null,
      created_at: now,
      updated_at: now,
      last_run_at: null,
      next_run_at: nextRun,
      last_status: null,
      last_error: null,
      prune_targets: action === 'prune' && prune_targets ? JSON.stringify(prune_targets) : null,
      target_services: action === 'restart' && target_type === 'stack' && target_services ? JSON.stringify(target_services) : null,
      prune_label_filter: action === 'prune' && prune_label_filter ? prune_label_filter.trim() : null,
      selector_type: selectors.selector_type,
      selector_value: selectors.selector_value,
      delete_after_run: delete_after_run ? 1 : 0,
      run_at: pinnedRunAt,
    });

    console.log(`[ScheduledTasks] Created task id=${id} action=${sanitizeForLog(action)} target=${sanitizeForLog(target_id || 'none')}`);
    const task = DatabaseService.getInstance().getScheduledTask(id);
    broadcastScheduledTasksChanged();
    res.status(201).json(task);
  } catch (error) {
    console.error('[ScheduledTasks] Create error:', error);
    res.status(500).json({ error: 'Failed to create scheduled task' });
  }
});

scheduledTasksRouter.get('/:id', (req: Request, res: Response): void => {
  try {
    const id = parseIntParam(req, res, 'id', 'task ID');
    if (id === null) return;
    const task = DatabaseService.getInstance().getScheduledTask(id);
    if (!task) { res.status(404).json({ error: 'Scheduled task not found' }); return; }
    if (!requireTaskExistsPermission(req, res, task)) return;
    res.json(task);
  } catch (error) {
    console.error('[ScheduledTasks] Get error:', error);
    res.status(500).json({ error: 'Failed to fetch scheduled task' });
  }
});

scheduledTasksRouter.put('/:id', (req: Request, res: Response): void => {
  try {
    const id = parseIntParam(req, res, 'id', 'task ID');
    if (id === null) return;

    const db = DatabaseService.getInstance();
    const existing = db.getScheduledTask(id);
    if (!existing) { res.status(404).json({ error: 'Scheduled task not found' }); return; }

    // Two-phase check: (1) the caller must be authorized for the existing task
    // (prevents task take-over; returns 404 so task ID existence is not
    // disclosed), and (2) the merged target must also be authorized (prevents
    // retargeting escalation, like flipping restart→prune; returns 403 since
    // this is a permission denial on the requested change, not an ownership
    // check).
    if (!requireTaskExistsPermission(req, res, existing)) return;

    const {
      name, target_type, target_id, node_id, action, cron_expression, enabled,
      prune_targets, target_services, prune_label_filter, selector_type, selector_value,
      delete_after_run, run_at,
    } = req.body;

    if (target_type !== undefined && !(VALID_TARGET_TYPES as readonly string[]).includes(target_type)) {
      res.status(400).json({ error: 'Invalid target_type' }); return;
    }
    if (action !== undefined && !(VALID_ACTIONS as readonly string[]).includes(action)) {
      res.status(400).json({ error: 'Invalid action' }); return;
    }

    const finalAction = (action ?? existing.action) as BackendScheduledAction;
    const finalTargetType = (target_type ?? existing.target_type) as TargetType;
    const finalTargetId = finalTargetType === 'stack' || finalTargetType === 'container'
      ? (target_id !== undefined ? target_id : existing.target_id)
      : null;
    const finalSelectorType = selector_type !== undefined ? selector_type : existing.selector_type;
    const finalSelectorValue = selector_value !== undefined ? selector_value : existing.selector_value;
    const labelSelector = usesStackLabelSelector(finalAction, finalTargetType, finalSelectorType);
    const finalNodeId = labelSelector
      ? (node_id !== undefined ? node_id : existing.node_id)
      : (actionRequiresNode(finalAction)
        ? (node_id !== undefined ? node_id : existing.node_id)
        : null);
    const targetErr = validateActionTarget(finalAction, finalTargetType);
    if (targetErr) { res.status(400).json({ error: targetErr }); return; }

    const nodeErr = validateActionNode(finalAction, finalTargetType, finalNodeId, finalSelectorType);
    if (nodeErr) { res.status(400).json({ error: nodeErr }); return; }

    const stackTargetErr = validateStackTarget(finalTargetType, finalTargetId, finalNodeId);
    if (stackTargetErr) { res.status(400).json({ error: stackTargetErr }); return; }

    const containerTargetErr = validateContainerTarget(finalTargetType, finalTargetId, finalNodeId);
    if (containerTargetErr) { res.status(400).json({ error: containerTargetErr }); return; }

    const optionalErr = validateOptionalFields(
      finalAction, finalTargetType, prune_targets, target_services, prune_label_filter,
      selector_type !== undefined ? selector_type : finalSelectorType,
      selector_value !== undefined ? selector_value : finalSelectorValue,
    );
    if (optionalErr) { res.status(400).json({ error: optionalErr }); return; }

    if (cron_expression !== undefined) {
      const cronErr = validateCronExpression(cron_expression);
      if (cronErr) { res.status(400).json({ error: cronErr }); return; }
    }

    const runAtErr = validateRunAt(run_at);
    if (runAtErr) { res.status(400).json({ error: runAtErr }); return; }

    const updates: Partial<Omit<ScheduledTask, 'id'>> = { updated_at: Date.now() };
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ error: 'Name is required' }); return;
      }
      updates.name = name.trim();
    }
    if (target_type !== undefined) updates.target_type = finalTargetType;
    if (target_id !== undefined || (finalTargetType !== 'stack' && finalTargetType !== 'container')) {
      updates.target_id = finalTargetId || null;
    }
    // Label-targeted fleet updates keep node_id when provided (or existing);
    // clear only when the caller explicitly sends null/empty for fleet-wide, or
    // when the action no longer requires a node and is not a label selector.
    if (labelSelector) {
      if (node_id !== undefined) {
        updates.node_id = node_id == null || node_id === '' ? null : parsePositiveNodeId(node_id);
        if (node_id != null && node_id !== '' && updates.node_id === null) {
          res.status(400).json({ error: 'Fleet update action requires a valid node_id.' }); return;
        }
      }
    } else if (node_id !== undefined || !actionRequiresNode(finalAction)) {
      updates.node_id = finalNodeId != null ? parsePositiveNodeId(finalNodeId) : null;
    }
    if (action !== undefined) updates.action = finalAction;
    if (cron_expression !== undefined && typeof cron_expression === 'string') updates.cron_expression = cron_expression;
    if (enabled !== undefined) updates.enabled = enabled ? 1 : 0;
    if (prune_targets !== undefined) {
      updates.prune_targets = finalAction === 'prune' && prune_targets ? JSON.stringify(prune_targets) : null;
    } else if (finalAction !== 'prune') {
      updates.prune_targets = null;
    }
    if (target_services !== undefined) {
      updates.target_services = finalAction === 'restart' && finalTargetType === 'stack' && target_services
        ? JSON.stringify(target_services)
        : null;
    } else if (finalAction !== 'restart' || finalTargetType !== 'stack') {
      updates.target_services = null;
    }
    if (prune_label_filter !== undefined) {
      updates.prune_label_filter = finalAction === 'prune' && prune_label_filter ? prune_label_filter.trim() : null;
    } else if (finalAction !== 'prune') {
      updates.prune_label_filter = null;
    }
    if (selector_type !== undefined || selector_value !== undefined
      || finalAction !== 'update' || finalTargetType !== 'fleet') {
      const selectors = normalizeSelectorFields(finalAction, finalTargetType, finalSelectorType, finalSelectorValue);
      updates.selector_type = selectors.selector_type;
      updates.selector_value = selectors.selector_value;
    }
    if (delete_after_run !== undefined) updates.delete_after_run = delete_after_run ? 1 : 0;

    // Persist a re-supplied run_at to its column (a number pins a one-shot; null
    // clears it when an edit switches the schedule to a recurring shape). When
    // run_at is omitted, the existing pinned value carries forward.
    const runAtProvided = run_at !== undefined;
    if (runAtProvided) updates.run_at = typeof run_at === 'number' ? run_at : null;
    const effectiveRunAt = (runAtProvided ? updates.run_at : existing.run_at) ?? null;

    const finalCron = cron_expression || existing.cron_expression;
    const finalEnabled = enabled !== undefined ? enabled : existing.enabled;
    if (finalEnabled) {
      // The pinned one-shot instant wins; otherwise recompute from the (possibly
      // updated) cron.
      updates.next_run_at = effectiveRunAt ?? SchedulerService.getInstance().calculateNextRun(finalCron);
    } else {
      updates.next_run_at = null;
    }

    // Second phase: the caller must have permission for the merged scope.
    if (!requireTaskPermission(req, res, {
      action: finalAction,
      target_type: finalTargetType,
      target_id: finalTargetId,
      node_id: finalNodeId != null ? parsePositiveNodeId(finalNodeId) : null,
      selector_type: finalSelectorType,
    })) return;

    db.updateScheduledTask(id, updates);
    console.log(`[ScheduledTasks] Updated task id=${id}`);
    const task = db.getScheduledTask(id);
    broadcastScheduledTasksChanged();
    res.json(task);
  } catch (error) {
    console.error('[ScheduledTasks] Update error:', error);
    res.status(500).json({ error: 'Failed to update scheduled task' });
  }
});

scheduledTasksRouter.delete('/:id', (req: Request, res: Response): void => {
  try {
    const id = parseIntParam(req, res, 'id', 'task ID');
    if (id === null) return;

    const db = DatabaseService.getInstance();
    const existing = db.getScheduledTask(id);
    if (!existing) { res.status(404).json({ error: 'Scheduled task not found' }); return; }
    if (!requireTaskExistsPermission(req, res, existing)) return;

    db.deleteScheduledTask(id);
    console.log(`[ScheduledTasks] Deleted task id=${id}`);
    broadcastScheduledTasksChanged();
    res.json({ success: true });
  } catch (error) {
    console.error('[ScheduledTasks] Delete error:', error);
    res.status(500).json({ error: 'Failed to delete scheduled task' });
  }
});

scheduledTasksRouter.patch('/:id/toggle', (req: Request, res: Response): void => {
  try {
    const id = parseIntParam(req, res, 'id', 'task ID');
    if (id === null) return;

    const db = DatabaseService.getInstance();
    const existing = db.getScheduledTask(id);
    if (!existing) { res.status(404).json({ error: 'Scheduled task not found' }); return; }
    if (!requireTaskExistsPermission(req, res, existing)) return;

    const newEnabled = existing.enabled ? 0 : 1;
    // On enable, a one-shot's persisted run_at restores the exact pinned instant
    // (its yearless cron cannot reconstruct the chosen year); a recurring task
    // recomputes from the cron. Disabling clears next_run_at for both; the
    // run_at column is untouched, so re-enabling later still restores the instant.
    const nextRun: number | null = newEnabled
      ? (existing.run_at ?? SchedulerService.getInstance().calculateNextRun(existing.cron_expression))
      : null;

    db.updateScheduledTask(id, {
      enabled: newEnabled,
      next_run_at: nextRun,
      updated_at: Date.now(),
    });

    console.log(`[ScheduledTasks] Toggled task id=${id} enabled=${newEnabled}`);
    const task = db.getScheduledTask(id);
    broadcastScheduledTasksChanged();
    res.json(task);
  } catch (error) {
    console.error('[ScheduledTasks] Toggle error:', error);
    res.status(500).json({ error: 'Failed to toggle scheduled task' });
  }
});

scheduledTasksRouter.post('/:id/run', (req: Request, res: Response): void => {
  try {
    const id = parseIntParam(req, res, 'id', 'task ID');
    if (id === null) return;

    const db = DatabaseService.getInstance();
    const existing = db.getScheduledTask(id);
    if (!existing) { res.status(404).json({ error: 'Scheduled task not found' }); return; }
    if (!requireTaskExistsPermission(req, res, existing)) return;

    const scheduler = SchedulerService.getInstance();
    if (scheduler.isTaskRunning(id)) {
      res.status(409).json({ error: 'Task is already running' }); return;
    }

    console.log(`[ScheduledTasks] Manual run requested for task id=${id}`);
    scheduler.triggerTask(id).catch((err: unknown) => {
      const msg = getErrorMessage(err, String(err));
      console.error(`[ScheduledTasks] Background run error for task ${id}:`, msg);
    });

    res.status(202).json({ message: 'Task triggered', task_id: id });
  } catch (error) {
    const msg = getErrorMessage(error, 'Failed to run task');
    console.error('[ScheduledTasks] Run error:', msg);
    res.status(500).json({ error: msg });
  }
});

scheduledTasksRouter.get('/:id/runs/export', (req: Request, res: Response): void => {
  try {
    const id = parseIntParam(req, res, 'id', 'task ID');
    if (id === null) return;

    const db = DatabaseService.getInstance();
    const task = db.getScheduledTask(id);
    if (!task) { res.status(404).json({ error: 'Scheduled task not found' }); return; }
    if (!requireTaskExistsPermission(req, res, task)) return;

    const runs = db.getAllScheduledTaskRuns(id);

    const lines = ['Timestamp,Source,Status,Duration (s),Details'];
    for (const run of runs) {
      const timestamp = new Date(run.started_at).toISOString();
      const source = run.triggered_by === 'manual' ? 'Manual' : 'Scheduled';
      const status = run.status.charAt(0).toUpperCase() + run.status.slice(1);
      const duration = run.completed_at && run.started_at
        ? ((run.completed_at - run.started_at) / 1000).toFixed(1)
        : '';
      const details = run.error || run.output || '';
      lines.push([timestamp, source, status, duration, details].map(escapeCsvField).join(','));
    }

    const safeName = task.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="task-${safeName}-history.csv"`);
    res.send(lines.join('\n'));
  } catch (error) {
    console.error('[ScheduledTasks] Export error:', error);
    res.status(500).json({ error: 'Failed to export task runs' });
  }
});

scheduledTasksRouter.get('/:id/runs', (req: Request, res: Response): void => {
  try {
    const id = parseIntParam(req, res, 'id', 'task ID');
    if (id === null) return;

    const db = DatabaseService.getInstance();
    const existing = db.getScheduledTask(id);
    if (!existing) { res.status(404).json({ error: 'Scheduled task not found' }); return; }
    if (!requireTaskExistsPermission(req, res, existing)) return;

    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);
    const result = db.getScheduledTaskRuns(id, limit, offset);
    res.json(result);
  } catch (error) {
    console.error('[ScheduledTasks] Runs error:', error);
    res.status(500).json({ error: 'Failed to fetch task runs' });
  }
});
