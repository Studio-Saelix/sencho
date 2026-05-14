import { Router, type Request, type Response } from 'express';
import { CronExpressionParser } from 'cron-parser';
import { DatabaseService, type ScheduledTask } from '../services/DatabaseService';
import { LicenseService } from '../services/LicenseService';
import { SchedulerService } from '../services/SchedulerService';
import { requirePaid, requireAdmin, requireScheduledTaskTier, SKIPPER_SCHEDULED_ACTIONS } from '../middleware/tierGates';
import { escapeCsvField } from '../utils/csv';
import { getErrorMessage } from '../utils/errors';
import { parseIntParam } from '../utils/parseIntParam';
import { sanitizeForLog } from '../utils/safeLog';

const VALID_TARGET_TYPES = ['stack', 'fleet', 'system'] as const;
const VALID_ACTIONS = ['restart', 'snapshot', 'prune', 'update', 'scan', 'auto_backup', 'auto_stop', 'auto_down', 'auto_start'] as const;
const VALID_PRUNE_TARGETS = ['containers', 'images', 'networks', 'volumes'] as const;
const ERR_FLEET_NODE_REQUIRED = 'Fleet update requires node_id.';

type TargetType = typeof VALID_TARGET_TYPES[number];
type ScheduledAction = typeof VALID_ACTIONS[number];

const STACK_ONLY_ACTIONS = new Set<ScheduledAction>(['auto_backup', 'auto_stop', 'auto_down', 'auto_start']);

/**
 * Validate that the target_type is compatible with the action. Each action
 * has exactly one allowed target_type; the helper returns an error message
 * on mismatch and null otherwise.
 */
function validateActionTarget(action: ScheduledAction, targetType: TargetType): string | null {
  if (action === 'restart' && targetType !== 'stack') return 'Restart action requires target_type "stack".';
  if (action === 'update' && targetType !== 'stack' && targetType !== 'fleet') return 'Update action requires target_type "stack" or "fleet".';
  if (action === 'snapshot' && targetType !== 'fleet') return 'Snapshot action requires target_type "fleet".';
  if (action === 'prune' && targetType !== 'system') return 'Prune action requires target_type "system".';
  if (action === 'scan' && targetType !== 'system') return 'Scan action requires target_type "system".';
  if (STACK_ONLY_ACTIONS.has(action) && targetType !== 'stack') {
    return `${action} action requires target_type "stack".`;
  }
  return null;
}

function validateScanNode(nodeId: unknown): string | null {
  if (nodeId == null) return 'Scan action requires node_id.';
  const parsedNodeId = Number(nodeId);
  if (!Number.isFinite(parsedNodeId)) return 'Scan action requires a valid node_id.';
  const node = DatabaseService.getInstance().getNode(parsedNodeId);
  if (!node) return 'Scheduled vulnerability scans require an existing local node.';
  if (node?.type === 'remote') {
    return 'Scheduled vulnerability scans currently require a local node.';
  }
  return null;
}

/** Shared validation for prune_targets, target_services, prune_label_filter. Returns an error string or null. */
function validateOptionalFields(
  action: ScheduledAction,
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

export const scheduledTasksRouter = Router();

scheduledTasksRouter.get('/', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  try {
    let tasks = DatabaseService.getInstance().getScheduledTasks();
    // Skipper users see v1 fleet-maintenance tasks; Admiral sees all.
    const ls = LicenseService.getInstance();
    if (ls.getVariant() !== 'admiral') {
      tasks = tasks.filter(t => SKIPPER_SCHEDULED_ACTIONS.has(t.action));
    }
    // Split Auto-Update and Scheduled Operations into distinct views.
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
      res.status(400).json({ error: 'Invalid action. Must be restart, snapshot, prune, update, scan, auto_backup, auto_stop, auto_down, or auto_start.' }); return;
    }
    if (!requireScheduledTaskTier(action, req, res)) return;

    const targetErr = validateActionTarget(action, target_type);
    if (targetErr) { res.status(400).json({ error: targetErr }); return; }

    if (action === 'scan' && !node_id) {
      res.status(400).json({ error: 'Scan action requires node_id.' }); return;
    }
    if (action === 'scan') {
      const nodeErr = validateScanNode(node_id);
      if (nodeErr) { res.status(400).json({ error: nodeErr }); return; }
    }
    if (action === 'update' && target_type === 'fleet' && !node_id) {
      res.status(400).json({ error: ERR_FLEET_NODE_REQUIRED }); return;
    }
    if (target_type === 'stack' && (!target_id || !node_id)) {
      res.status(400).json({ error: 'Stack operations require target_id and node_id.' }); return;
    }

    const optionalErr = validateOptionalFields(action, target_type, prune_targets, target_services, prune_label_filter);
    if (optionalErr) { res.status(400).json({ error: optionalErr }); return; }

    try { CronExpressionParser.parse(cron_expression); } catch (e) {
      console.warn('[Scheduler] Invalid cron expression rejected:', sanitizeForLog(cron_expression), sanitizeForLog(getErrorMessage(e, 'unknown')));
      res.status(400).json({ error: 'Invalid cron expression.' }); return;
    }

    const scheduler = SchedulerService.getInstance();
    const now = Date.now();
    const nextRun = (enabled !== false) ? scheduler.calculateNextRun(cron_expression) : null;

    const id = DatabaseService.getInstance().createScheduledTask({
      name: name.trim(),
      target_type,
      target_id: target_id || null,
      node_id: node_id != null ? Number(node_id) : null,
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
      prune_targets: prune_targets ? JSON.stringify(prune_targets) : null,
      target_services: target_services ? JSON.stringify(target_services) : null,
      prune_label_filter: prune_label_filter ? prune_label_filter.trim() : null,
      delete_after_run: delete_after_run ? 1 : 0,
    });

    console.log(`[ScheduledTasks] Created task id=${id} action=${sanitizeForLog(action)} target=${sanitizeForLog(target_id || 'none')}`);
    const task = DatabaseService.getInstance().getScheduledTask(id);
    res.status(201).json(task);
  } catch (error) {
    console.error('[ScheduledTasks] Create error:', error);
    res.status(500).json({ error: 'Failed to create scheduled task' });
  }
});

scheduledTasksRouter.get('/:id', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'task ID');
    if (id === null) return;
    const task = DatabaseService.getInstance().getScheduledTask(id);
    if (!task) { res.status(404).json({ error: 'Scheduled task not found' }); return; }
    if (!requireScheduledTaskTier(task.action, req, res)) return;
    res.json(task);
  } catch (error) {
    console.error('[ScheduledTasks] Get error:', error);
    res.status(500).json({ error: 'Failed to fetch scheduled task' });
  }
});

scheduledTasksRouter.put('/:id', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'task ID');
    if (id === null) return;

    const db = DatabaseService.getInstance();
    const existing = db.getScheduledTask(id);
    if (!existing) { res.status(404).json({ error: 'Scheduled task not found' }); return; }
    if (!requireScheduledTaskTier(existing.action, req, res)) return;

    const { name, target_type, target_id, node_id, action, cron_expression, enabled, prune_targets, target_services, prune_label_filter, delete_after_run } = req.body;

    if (target_type && !(VALID_TARGET_TYPES as readonly string[]).includes(target_type)) {
      res.status(400).json({ error: 'Invalid target_type' }); return;
    }
    if (action && !(VALID_ACTIONS as readonly string[]).includes(action)) {
      res.status(400).json({ error: 'Invalid action' }); return;
    }

    const finalAction = (action || existing.action) as ScheduledAction;
    const finalTargetType = (target_type || existing.target_type) as TargetType;
    const targetErr = validateActionTarget(finalAction, finalTargetType);
    if (targetErr) { res.status(400).json({ error: targetErr }); return; }

    if (finalAction === 'scan') {
      const finalNodeId = node_id !== undefined ? node_id : existing.node_id;
      const nodeErr = validateScanNode(finalNodeId);
      if (nodeErr) { res.status(400).json({ error: nodeErr }); return; }
    }
    if (finalAction === 'update' && finalTargetType === 'fleet') {
      const finalNodeId = node_id !== undefined ? node_id : existing.node_id;
      if (!finalNodeId) {
        res.status(400).json({ error: ERR_FLEET_NODE_REQUIRED }); return;
      }
    }

    const optionalErr = validateOptionalFields(finalAction, finalTargetType, prune_targets, target_services, prune_label_filter);
    if (optionalErr) { res.status(400).json({ error: optionalErr }); return; }

    if (cron_expression) {
      try { CronExpressionParser.parse(cron_expression); } catch (e) {
        console.warn('[Scheduler] Invalid cron expression rejected:', sanitizeForLog(cron_expression), sanitizeForLog(getErrorMessage(e, 'unknown')));
        res.status(400).json({ error: 'Invalid cron expression.' }); return;
      }
    }

    const updates: Record<string, unknown> = { updated_at: Date.now() };
    if (name !== undefined) updates.name = typeof name === 'string' ? name.trim() : name;
    if (target_type !== undefined) updates.target_type = target_type;
    if (target_id !== undefined) updates.target_id = target_id || null;
    if (node_id !== undefined) updates.node_id = node_id != null ? Number(node_id) : null;
    if (action !== undefined) updates.action = action;
    if (cron_expression !== undefined) updates.cron_expression = cron_expression;
    if (enabled !== undefined) updates.enabled = enabled ? 1 : 0;
    if (prune_targets !== undefined) updates.prune_targets = prune_targets ? JSON.stringify(prune_targets) : null;
    if (target_services !== undefined) updates.target_services = target_services ? JSON.stringify(target_services) : null;
    if (prune_label_filter !== undefined) updates.prune_label_filter = prune_label_filter ? prune_label_filter.trim() : null;
    if (delete_after_run !== undefined) updates.delete_after_run = delete_after_run ? 1 : 0;

    const finalCron = cron_expression || existing.cron_expression;
    const finalEnabled = enabled !== undefined ? enabled : existing.enabled;
    if (finalEnabled) {
      updates.next_run_at = SchedulerService.getInstance().calculateNextRun(finalCron);
    } else {
      updates.next_run_at = null;
    }

    db.updateScheduledTask(id, updates as Partial<Omit<ScheduledTask, 'id'>>);
    console.log(`[ScheduledTasks] Updated task id=${id}`);
    const task = db.getScheduledTask(id);
    res.json(task);
  } catch (error) {
    console.error('[ScheduledTasks] Update error:', error);
    res.status(500).json({ error: 'Failed to update scheduled task' });
  }
});

scheduledTasksRouter.delete('/:id', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'task ID');
    if (id === null) return;

    const db = DatabaseService.getInstance();
    const existing = db.getScheduledTask(id);
    if (!existing) { res.status(404).json({ error: 'Scheduled task not found' }); return; }
    if (!requireScheduledTaskTier(existing.action, req, res)) return;

    db.deleteScheduledTask(id);
    console.log(`[ScheduledTasks] Deleted task id=${id}`);
    res.json({ success: true });
  } catch (error) {
    console.error('[ScheduledTasks] Delete error:', error);
    res.status(500).json({ error: 'Failed to delete scheduled task' });
  }
});

scheduledTasksRouter.patch('/:id/toggle', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'task ID');
    if (id === null) return;

    const db = DatabaseService.getInstance();
    const existing = db.getScheduledTask(id);
    if (!existing) { res.status(404).json({ error: 'Scheduled task not found' }); return; }
    if (!requireScheduledTaskTier(existing.action, req, res)) return;

    const newEnabled = existing.enabled ? 0 : 1;
    const nextRun = newEnabled ? SchedulerService.getInstance().calculateNextRun(existing.cron_expression) : null;

    db.updateScheduledTask(id, {
      enabled: newEnabled,
      next_run_at: nextRun,
      updated_at: Date.now(),
    });

    console.log(`[ScheduledTasks] Toggled task id=${id} enabled=${newEnabled}`);
    const task = db.getScheduledTask(id);
    res.json(task);
  } catch (error) {
    console.error('[ScheduledTasks] Toggle error:', error);
    res.status(500).json({ error: 'Failed to toggle scheduled task' });
  }
});

scheduledTasksRouter.post('/:id/run', (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  if (!requirePaid(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'task ID');
    if (id === null) return;

    const db = DatabaseService.getInstance();
    const existing = db.getScheduledTask(id);
    if (!existing) { res.status(404).json({ error: 'Scheduled task not found' }); return; }
    if (!requireScheduledTaskTier(existing.action, req, res)) return;

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
  if (!requirePaid(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'task ID');
    if (id === null) return;

    const db = DatabaseService.getInstance();
    const task = db.getScheduledTask(id);
    if (!task) { res.status(404).json({ error: 'Scheduled task not found' }); return; }
    if (!requireScheduledTaskTier(task.action, req, res)) return;

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
  if (!requirePaid(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'task ID');
    if (id === null) return;

    const db = DatabaseService.getInstance();
    const existing = db.getScheduledTask(id);
    if (!existing) { res.status(404).json({ error: 'Scheduled task not found' }); return; }
    if (!requireScheduledTaskTier(existing.action, req, res)) return;

    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);
    const result = db.getScheduledTaskRuns(id, limit, offset);
    res.json(result);
  } catch (error) {
    console.error('[ScheduledTasks] Runs error:', error);
    res.status(500).json({ error: 'Failed to fetch task runs' });
  }
});
