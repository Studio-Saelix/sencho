import { Router, type Request, type Response } from 'express';
import { DatabaseService } from '../services/DatabaseService';
import { requirePermission } from '../middleware/permissions';
import { isValidStackName } from '../utils/validation';
import { isDebugEnabled } from '../utils/debug';
import { StackActivityMetricsService } from '../services/StackActivityMetricsService';

export const stackActivityRouter = Router();

function dlog(message: string, details: Record<string, unknown>): void {
  if (isDebugEnabled()) console.log(`[StackActivity:diag] ${message}`, details);
}

function parseStrictPositiveInt(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (s === '' || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

stackActivityRouter.get('/:stackName/activity', (req: Request, res: Response): void => {
  const t0 = Date.now();
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return;

  const parsedLimit = parseStrictPositiveInt(req.query.limit ?? '50');
  if (parsedLimit === null) {
    res.status(400).json({ error: 'Invalid limit parameter' });
    return;
  }
  const limit = Math.min(parsedLimit, 200);

  const hasBefore = req.query.before !== undefined;
  const hasBeforeId = req.query.beforeId !== undefined;
  // beforeId without before would silently fall back to "page 1" in the DB
  // layer; reject so a paginating client cannot loop on the same page.
  if (hasBeforeId && !hasBefore) {
    res.status(400).json({ error: 'beforeId requires before' });
    return;
  }

  let before: number | undefined;
  if (hasBefore) {
    const parsed = parseStrictPositiveInt(req.query.before);
    if (parsed === null) {
      res.status(400).json({ error: 'Invalid before parameter' });
      return;
    }
    before = parsed;
  }

  let beforeId: number | undefined;
  if (hasBeforeId) {
    const parsed = parseStrictPositiveInt(req.query.beforeId);
    if (parsed === null) {
      res.status(400).json({ error: 'Invalid beforeId parameter' });
      return;
    }
    beforeId = parsed;
  }

  let ok = false;
  try {
    const events = DatabaseService.getInstance().getStackActivity(req.nodeId, stackName, { limit, before, beforeId });
    ok = true;
    res.json({ events });
    dlog('read', { stackName, nodeId: req.nodeId, limit, before, beforeId, returned: events.length, elapsedMs: Date.now() - t0 });
  } finally {
    StackActivityMetricsService.getInstance().record(req.nodeId, 'read', Date.now() - t0, ok);
  }
});
