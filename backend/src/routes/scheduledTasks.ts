import { Router, type Request, type Response } from 'express';
import { CronExpressionParser } from 'cron-parser';
import { DatabaseService, type ScheduledTask } from '../services/DatabaseService';
import {
  VALID_TARGET_TYPES,
  VALID_ACTIONS,
  INVALID_ACTION_MESSAGE,
  validateActionTarget,
  getScheduledActionDefinition,
  type TargetType,
  type BackendScheduledAction,
} from '../services/scheduledActionRegistry';
import { SchedulerService } from '../services/SchedulerService';
import { NotificationService } from '../services/NotificationService';
import { requireAdmin } from '../middleware/tierGates';
import { escapeCsvField } from '../utils/csv';
import { getErrorMessage } from '../utils/errors';
import { parseIntParam } from '../utils/parseIntParam';
import { sanitizeForLog } from '../utils/safeLog';
import { isValidStackName } from '../utils/validation';

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

/**
 * Shared guard for non-stack actions that require a node. Stack actions use
 * validateStackTarget because they also require target_id.
 */
function validateActionNode(action: BackendScheduledAction, targetType: TargetType, nodeId: unknown): string | null {
  if (targetType === 'stack') return null;
  const def = getScheduledActionDefinition(action);
  if (!def?.requiresNode) return null;

  const labelSingular = nodeRequirementLabel(action, targetType);
  const labelPlural = localNodeRequirementLabel(action);

  if (nodeId == null) {
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

/** Shared validation for prune_targets, target_services, prune_label_filter. Returns an error string or null. */
function validateOptionalFields(
  action: BackendScheduledAction,
  targetType: TargetType,
  prune_targets: unknown,
  target_services: unknown,
  prune_label_filter: unknown,
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
  return null;
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

export const scheduledTasksRouter = Router();

scheduledTasksRouter.get('/', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  try {
    let tasks = DatabaseService.getInstance().getScheduledTasks();
    // The Scheduled Operations view manages every task type, so it lists all of
    // them. `action` / `exclude_action` exist for the read-only consumers that
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
  if (!requireAdmin(req, res)) return;
  try {
    const { name, target_type, target_id, node_id, action, cron_expression, enabled, prune_targets, target_services, prune_label_filter, delete_after_run } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'Name is required' }); return;
    }
    if (!(VALID_TARGET_TYPES as readonly string[]).includes(target_type)) {
      res.status(400).json({ error: 'Invalid target_type. Must be stack, fleet, or system.' }); return;
    }
    if (!(VALID_ACTIONS as readonly string[]).includes(action)) {
      res.status(400).json({ error: INVALID_ACTION_MESSAGE }); return;
    }

    const targetErr = validateActionTarget(action, target_type);
    if (targetErr) { res.status(400).json({ error: targetErr }); return; }

    const nodeErr = validateActionNode(action, target_type, node_id);
    if (nodeErr) { res.status(400).json({ error: nodeErr }); return; }
    const stackTargetErr = validateStackTarget(target_type, target_id, node_id);
    if (stackTargetErr) { res.status(400).json({ error: stackTargetErr }); return; }

    const optionalErr = validateOptionalFields(action, target_type, prune_targets, target_services, prune_label_filter);
    if (optionalErr) { res.status(400).json({ error: optionalErr }); return; }

    const cronErr = validateCronExpression(cron_expression);
    if (cronErr) { res.status(400).json({ error: cronErr }); return; }

    const scheduler = SchedulerService.getInstance();
    const now = Date.now();
    const nextRun = (enabled !== false) ? scheduler.calculateNextRun(cron_expression) : null;
    const normalizedTargetId = target_type === 'stack' ? target_id : null;
    const normalizedNodeId = actionRequiresNode(action) ? parsePositiveNodeId(node_id) : null;

    const id = DatabaseService.getInstance().createScheduledTask({
      name: name.trim(),
      target_type,
      target_id: normalizedTargetId,
      node_id: normalizedNodeId,
      action,
      cron_expression,
      enabled: enabled !== false ? 1 : 0,
      created_by: req.user?.username || 'admin',
      created_at: now,
      updated_at: now,
      last_run_at: null,
      next_run_at: nextRun,
      last_status: null,
      last_error: null,
      prune_targets: action === 'prune' && prune_targets ? JSON.stringify(prune_targets) : null,
      target_services: action === 'restart' && target_type === 'stack' && target_services ? JSON.stringify(target_services) : null,
      prune_label_filter: action === 'prune' && prune_label_filter ? prune_label_filter.trim() : null,
      delete_after_run: delete_after_run ? 1 : 0,
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
  if (!requireAdmin(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'task ID');
    if (id === null) return;
    const task = DatabaseService.getInstance().getScheduledTask(id);
    if (!task) { res.status(404).json({ error: 'Scheduled task not found' }); return; }
    res.json(task);
  } catch (error) {
    console.error('[ScheduledTasks] Get error:', error);
    res.status(500).json({ error: 'Failed to fetch scheduled task' });
  }
});

scheduledTasksRouter.put('/:id', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'task ID');
    if (id === null) return;

    const db = DatabaseService.getInstance();
    const existing = db.getScheduledTask(id);
    if (!existing) { res.status(404).json({ error: 'Scheduled task not found' }); return; }

    const { name, target_type, target_id, node_id, action, cron_expression, enabled, prune_targets, target_services, prune_label_filter, delete_after_run } = req.body;

    if (target_type !== undefined && !(VALID_TARGET_TYPES as readonly string[]).includes(target_type)) {
      res.status(400).json({ error: 'Invalid target_type' }); return;
    }
    if (action !== undefined && !(VALID_ACTIONS as readonly string[]).includes(action)) {
      res.status(400).json({ error: 'Invalid action' }); return;
    }

    const finalAction = (action ?? existing.action) as BackendScheduledAction;
    const finalTargetType = (target_type ?? existing.target_type) as TargetType;
    const finalTargetId = finalTargetType === 'stack'
      ? (target_id !== undefined ? target_id : existing.target_id)
      : null;
    const finalNodeId = actionRequiresNode(finalAction)
      ? (node_id !== undefined ? node_id : existing.node_id)
      : null;
    const targetErr = validateActionTarget(finalAction, finalTargetType);
    if (targetErr) { res.status(400).json({ error: targetErr }); return; }

    const nodeErr = validateActionNode(finalAction, finalTargetType, finalNodeId);
    if (nodeErr) { res.status(400).json({ error: nodeErr }); return; }

    const stackTargetErr = validateStackTarget(finalTargetType, finalTargetId, finalNodeId);
    if (stackTargetErr) { res.status(400).json({ error: stackTargetErr }); return; }

    const optionalErr = validateOptionalFields(finalAction, finalTargetType, prune_targets, target_services, prune_label_filter);
    if (optionalErr) { res.status(400).json({ error: optionalErr }); return; }

    if (cron_expression !== undefined) {
      const cronErr = validateCronExpression(cron_expression);
      if (cronErr) { res.status(400).json({ error: cronErr }); return; }
    }

    const updates: Partial<Omit<ScheduledTask, 'id'>> = { updated_at: Date.now() };
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ error: 'Name is required' }); return;
      }
      updates.name = name.trim();
    }
    if (target_type !== undefined) updates.target_type = finalTargetType;
    if (target_id !== undefined || finalTargetType !== 'stack') updates.target_id = finalTargetId || null;
    if (node_id !== undefined || !actionRequiresNode(finalAction)) {
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
    if (delete_after_run !== undefined) updates.delete_after_run = delete_after_run ? 1 : 0;

    const finalCron = cron_expression || existing.cron_expression;
    const finalEnabled = enabled !== undefined ? enabled : existing.enabled;
    if (finalEnabled) {
      updates.next_run_at = SchedulerService.getInstance().calculateNextRun(finalCron);
    } else {
      updates.next_run_at = null;
    }

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
  if (!requireAdmin(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'task ID');
    if (id === null) return;

    const db = DatabaseService.getInstance();
    const existing = db.getScheduledTask(id);
    if (!existing) { res.status(404).json({ error: 'Scheduled task not found' }); return; }

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
  if (!requireAdmin(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'task ID');
    if (id === null) return;

    const db = DatabaseService.getInstance();
    const existing = db.getScheduledTask(id);
    if (!existing) { res.status(404).json({ error: 'Scheduled task not found' }); return; }

    const newEnabled = existing.enabled ? 0 : 1;
    const nextRun = newEnabled ? SchedulerService.getInstance().calculateNextRun(existing.cron_expression) : null;

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
  if (!requireAdmin(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'task ID');
    if (id === null) return;

    const db = DatabaseService.getInstance();
    const existing = db.getScheduledTask(id);
    if (!existing) { res.status(404).json({ error: 'Scheduled task not found' }); return; }

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
  if (!requireAdmin(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'task ID');
    if (id === null) return;

    const db = DatabaseService.getInstance();
    const task = db.getScheduledTask(id);
    if (!task) { res.status(404).json({ error: 'Scheduled task not found' }); return; }

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
  if (!requireAdmin(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'task ID');
    if (id === null) return;

    const db = DatabaseService.getInstance();
    const existing = db.getScheduledTask(id);
    if (!existing) { res.status(404).json({ error: 'Scheduled task not found' }); return; }

    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);
    const result = db.getScheduledTaskRuns(id, limit, offset);
    res.json(result);
  } catch (error) {
    console.error('[ScheduledTasks] Runs error:', error);
    res.status(500).json({ error: 'Failed to fetch task runs' });
  }
});
