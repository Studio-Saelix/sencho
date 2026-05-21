import { Router, type Request, type Response } from 'express';
import { DatabaseService } from '../services/DatabaseService';
import { FileSystemService } from '../services/FileSystemService';
import { ComposeService } from '../services/ComposeService';
import DockerController from '../services/DockerController';
import { enforcePolicyPreDeploy } from '../services/PolicyEnforcement';
import { authMiddleware } from '../middleware/auth';
import { requirePermission } from '../middleware/permissions';
import { requirePaid, requireAdmin, requireBody } from '../middleware/tierGates';
import { buildPolicyGateOptions } from '../helpers/policyGate';
import { invalidateNodeCaches } from '../helpers/cacheInvalidation';
import { VALID_LABEL_COLORS, MAX_LABELS_PER_NODE } from '../helpers/constants';
import { isValidStackName } from '../utils/validation';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage, isSqliteUniqueViolation } from '../utils/errors';
import { parseIntParam } from '../utils/parseIntParam';
import { sanitizeForLog } from '../utils/safeLog';

// Module-scope lock shared by `POST /api/labels/:id/action` and the fleet-wide
// bulk endpoints in `routes/fleet.ts`. Keyed by `${nodeId}` so concurrent bulk
// actions targeting the same node serialize and a fleet-stop cannot race a
// per-label action on the same containers.
export const activeBulkActions = new Set<string>();

export const labelsRouter = Router();

labelsRouter.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const nodeId = req.nodeId ?? 0;
    const labels = DatabaseService.getInstance().getLabels(nodeId);
    if (isDebugEnabled()) console.debug('[Labels:debug] List labels: nodeId=', nodeId, 'count=', labels.length);
    res.json(labels);
  } catch (error) {
    console.error('[Labels] List error:', error);
    res.status(500).json({ error: 'Failed to list labels' });
  }
});

labelsRouter.post('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'stack:edit')) return;
  if (!requireBody(req, res)) return;
  try {
    const nodeId = req.nodeId ?? 0;
    const { name, color } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 30) {
      res.status(400).json({ error: 'name is required and must be 1-30 characters' });
      return;
    }
    if (!/^[a-zA-Z0-9 -]+$/.test(name)) {
      res.status(400).json({ error: 'name may only contain letters, numbers, spaces, and hyphens' });
      return;
    }
    if (!color || !(VALID_LABEL_COLORS as readonly string[]).includes(color)) {
      res.status(400).json({ error: `color must be one of: ${VALID_LABEL_COLORS.join(', ')}` });
      return;
    }

    const db = DatabaseService.getInstance();
    if (db.getLabelCount(nodeId) >= MAX_LABELS_PER_NODE) {
      res.status(409).json({ error: `Maximum of ${MAX_LABELS_PER_NODE} labels per node reached` });
      return;
    }

    if (isDebugEnabled()) console.debug('[Labels:debug] Create label:', { nodeId, name: name.trim(), color });
    const label = db.createLabel(nodeId, name.trim(), color);
    if (isDebugEnabled()) console.debug('[Labels:debug] Created label:', label.id);
    res.status(201).json(label);
  } catch (error: unknown) {
    if (isSqliteUniqueViolation(error)) {
      res.status(409).json({ error: 'A label with that name already exists' });
      return;
    }
    console.error('[Labels] Create error:', error);
    res.status(500).json({ error: 'Failed to create label' });
  }
});

labelsRouter.get('/assignments', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const nodeId = req.nodeId ?? 0;
    const db = DatabaseService.getInstance();
    const assignments = db.getLabelsForStacks(nodeId);

    // Opportunistic cleanup: only scan the filesystem when there are
    // assignments to validate.
    const assignedStacks = Object.keys(assignments);
    if (assignedStacks.length > 0) {
      const fsStacks = await FileSystemService.getInstance(nodeId).getStacks();
      const fsSet = new Set(fsStacks);
      const staleNames = assignedStacks.filter(name => !fsSet.has(name));
      if (staleNames.length > 0) {
        db.cleanupStaleAssignments(nodeId, fsStacks);
        for (const name of staleNames) {
          delete assignments[name];
        }
        if (isDebugEnabled()) console.debug('[Labels:debug] Cleaned up stale assignments:', staleNames);
      }
    }

    if (isDebugEnabled()) console.debug('[Labels:debug] Assignments: nodeId=', nodeId, 'stacks=', Object.keys(assignments).length);
    res.json(assignments);
  } catch (error) {
    console.error('[Labels] Assignments error:', error);
    res.status(500).json({ error: 'Failed to fetch label assignments' });
  }
});

labelsRouter.put('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'stack:edit')) return;
  if (!requireBody(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'label ID');
    if (id === null) return;
    const nodeId = req.nodeId ?? 0;
    const { name, color } = req.body;

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0 || name.length > 30) {
        res.status(400).json({ error: 'name must be 1-30 characters' });
        return;
      }
      if (!/^[a-zA-Z0-9 -]+$/.test(name)) {
        res.status(400).json({ error: 'name may only contain letters, numbers, spaces, and hyphens' });
        return;
      }
    }
    if (color !== undefined && !(VALID_LABEL_COLORS as readonly string[]).includes(color)) {
      res.status(400).json({ error: `color must be one of: ${VALID_LABEL_COLORS.join(', ')}` });
      return;
    }

    if (isDebugEnabled()) console.debug('[Labels:debug] Update label:', { id, nodeId, name: name?.trim(), color });
    const updated = DatabaseService.getInstance().updateLabel(id, nodeId, {
      name: name?.trim(),
      color,
    });
    if (!updated) {
      res.status(404).json({ error: 'Label not found' });
      return;
    }
    res.json(updated);
  } catch (error: unknown) {
    if (isSqliteUniqueViolation(error)) {
      res.status(409).json({ error: 'A label with that name already exists' });
      return;
    }
    console.error('[Labels] Update error:', error);
    res.status(500).json({ error: 'Failed to update label' });
  }
});

labelsRouter.delete('/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'stack:edit')) return;
  try {
    const id = parseIntParam(req, res, 'id', 'label ID');
    if (id === null) return;
    const nodeId = req.nodeId ?? 0;
    if (isDebugEnabled()) console.debug('[Labels:debug] Delete label:', { id, nodeId });
    DatabaseService.getInstance().deleteLabel(id, nodeId);
    res.json({ success: true });
  } catch (error) {
    console.error('[Labels] Delete error:', error);
    res.status(500).json({ error: 'Failed to delete label' });
  }
});

labelsRouter.post('/:id/action', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requirePaid(req, res)) return;
  if (!requireAdmin(req, res)) return;
  if (!requireBody(req, res)) return;
  try {
    const id = parseIntParam(req, res, 'id', 'label ID');
    if (id === null) return;
    const { action, dryRun } = req.body;
    const validActions = ['deploy', 'stop', 'restart'];
    if (!action || !validActions.includes(action)) {
      res.status(400).json({ error: `action must be one of: ${validActions.join(', ')}` });
      return;
    }
    const isDryRun = dryRun === true;

    const nodeId = req.nodeId ?? 0;

    const label = DatabaseService.getInstance().getLabel(id, nodeId);
    if (!label) {
      res.status(404).json({ error: 'Label not found' });
      return;
    }

    const lockKey = `bulk:${nodeId}`;
    if (activeBulkActions.has(lockKey)) {
      res.status(429).json({ error: 'A bulk action is already running for this node. Please wait.' });
      return;
    }
    activeBulkActions.add(lockKey);

    try {
      const stackNames = DatabaseService.getInstance().getStacksForLabel(id, nodeId);
      const fsStacks = await FileSystemService.getInstance(nodeId).getStacks();
      const fsStackNames = new Set(fsStacks);
      const validStacks = stackNames.filter(name => fsStackNames.has(name));

      if (isDebugEnabled()) console.debug('[Labels:debug] Bulk action start:', { id, action, nodeId, totalLabeled: stackNames.length, validStacks: validStacks.length, dryRun: isDryRun });

      const results: { stackName: string; success: boolean; error?: string; dryRun?: boolean }[] = [];

      for (const stackName of validStacks) {
        if (isDryRun) {
          // Rehearse the action under the same lock + label resolution + fs
          // intersection. Skip the destructive leaf call.
          results.push({ stackName, success: true, dryRun: true });
          continue;
        }
        try {
          if (action === 'deploy') {
            const gate = await enforcePolicyPreDeploy(
              stackName,
              req.nodeId,
              buildPolicyGateOptions(req),
            );
            if (!gate.ok) {
              const blockedMsg = `Policy "${gate.policy?.name}" blocked deploy: ${gate.violations.length} image(s) exceed ${gate.policy?.max_severity}`;
              results.push({ stackName, success: false, error: blockedMsg });
              continue;
            }
            await ComposeService.getInstance(req.nodeId).deployStack(stackName, undefined, false);
          } else {
            const dockerController = DockerController.getInstance(req.nodeId);
            const containers = await dockerController.getContainersByStack(stackName);
            if (action === 'stop') {
              await Promise.all(containers.map(c => dockerController.stopContainer(c.Id)));
            } else {
              await Promise.all(containers.map(c => dockerController.restartContainer(c.Id)));
            }
          }
          results.push({ stackName, success: true });
        } catch (err: unknown) {
          results.push({ stackName, success: false, error: getErrorMessage(err, 'Unknown error') });
        }
      }

      const succeeded = results.filter(r => r.success).length;
      const failed = results.length - succeeded;
      console.log(`[Labels] Bulk ${sanitizeForLog(action)}${isDryRun ? ' (dry run)' : ''} on label ${id}: ${validStacks.length} stacks (${succeeded} succeeded, ${failed} failed)`);
      if (isDebugEnabled()) console.debug('[Labels:debug] Bulk action complete:', { id, action, total: results.length, succeeded, failed, dryRun: isDryRun });

      if (succeeded > 0 && !isDryRun) {
        invalidateNodeCaches(req.nodeId);
      }
      res.json({ results });
    } finally {
      activeBulkActions.delete(lockKey);
    }
  } catch (error) {
    console.error('[Labels] Bulk action error:', error);
    res.status(500).json({ error: 'Failed to execute bulk action' });
  }
});

// Mounted at `/api/stacks` so `/:stackName/labels` handles
// PUT /api/stacks/:stackName/labels. Kept alongside the other label handlers
// rather than bundled with the stack router because the underlying data
// model is "labels that reference stacks" - a label concern with a stack
// addressable path.
export const stackLabelsRouter = Router();

stackLabelsRouter.put('/:stackName/labels', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const stackName = req.params.stackName as string;
    if (!isValidStackName(stackName)) {
      res.status(400).json({ error: 'Invalid stack name' });
      return;
    }
    if (!requirePermission(req, res, 'stack:edit', 'stack', stackName)) return;
    if (!requireBody(req, res)) return;
    const nodeId = req.nodeId ?? 0;
    const { labelIds } = req.body;

    if (!Array.isArray(labelIds) || !labelIds.every((id: unknown) => typeof id === 'number')) {
      res.status(400).json({ error: 'labelIds must be an array of numbers' });
      return;
    }

    if (isDebugEnabled()) console.debug('[Labels:debug] Set stack labels:', { stackName, nodeId, labelIds });
    DatabaseService.getInstance().setStackLabels(stackName, nodeId, labelIds);
    res.json({ success: true });
  } catch (error) {
    console.error('[Labels] Set stack labels error:', error);
    res.status(500).json({ error: 'Failed to set stack labels' });
  }
});
