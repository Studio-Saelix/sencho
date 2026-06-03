import { Router, type Request, type Response } from 'express';
import { DatabaseService } from '../services/DatabaseService';
import { authMiddleware } from '../middleware/auth';
import { requireAdmin, requireBody } from '../middleware/tierGates';
import { isValidStackName } from '../utils/validation';
import { getErrorMessage } from '../utils/errors';
import { isDebugEnabled } from '../utils/debug';
import { runLocalLabelStop, type LabelLocalStopResponse } from '../helpers/fleetLabelStop';

// Per-node fleet-action endpoints. Mounted under `/api/fleet-actions/`, which
// is NOT in `PROXY_EXEMPT_PREFIXES`, so when `x-node-id` targets a remote node
// the gateway proxies the call and the remote Sencho instance runs its own
// local handler. Multi-node orchestration endpoints live in `routes/fleet.ts`
// because their path must sit behind the `/api/fleet/` proxy-exempt prefix.
export const fleetActionsRouter = Router();

// Hard cap to bound a single bulk-assign request. A node typically has tens of
// stacks, not thousands; the cap protects against accidental or malicious
// payloads that would force thousands of DB writes in one handler.
const MAX_ASSIGNMENTS = 1000;

// Bulk label assignment for many stacks on a single node. The single-stack
// endpoint at `PUT /api/stacks/:stackName/labels` covers one stack at a time;
// this wrapper applies the same operation to many stacks atomically per HTTP
// request. Tier: requireAdmin (admin-only fleet plumbing). The per-stack
// endpoint is Community-tier organization metadata; this multi-stack wrapper
// matches the surrounding Fleet Actions surface, which is admin-only but
// available on every license.
fleetActionsRouter.post(
  '/labels/bulk-assign',
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmin(req, res)) return;
    if (!requireBody(req, res)) return;
    const { assignments } = req.body as { assignments?: unknown };
    if (!Array.isArray(assignments)) {
      res.status(400).json({ error: 'assignments must be an array' });
      return;
    }
    if (assignments.length > MAX_ASSIGNMENTS) {
      res.status(400).json({ error: `assignments may not exceed ${MAX_ASSIGNMENTS} entries` });
      return;
    }
    const nodeId = req.nodeId ?? 0;
    const db = DatabaseService.getInstance();
    const results: { stackName: string; success: boolean; error?: string }[] = [];
    for (const entry of assignments as unknown[]) {
      if (!entry || typeof entry !== 'object') {
        results.push({ stackName: '', success: false, error: 'Invalid assignment entry' });
        continue;
      }
      const { stackName, labelIds } = entry as { stackName?: unknown; labelIds?: unknown };
      if (typeof stackName !== 'string' || !isValidStackName(stackName)) {
        results.push({ stackName: typeof stackName === 'string' ? stackName : '', success: false, error: 'Invalid stack name' });
        continue;
      }
      if (!Array.isArray(labelIds) || !labelIds.every(id => typeof id === 'number')) {
        results.push({ stackName, success: false, error: 'labelIds must be an array of numbers' });
        continue;
      }
      try {
        db.setStackLabels(stackName, nodeId, labelIds);
        results.push({ stackName, success: true });
      } catch (err) {
        results.push({ stackName, success: false, error: getErrorMessage(err, 'Failed to set stack labels') });
      }
    }
    res.json({ results });
  },
);

// Per-node label-matched stop. A control instance calls this on each remote
// node during a fleet-wide stop-by-label so the destructive work runs under the
// remote's own admin auth and per-node bulk lock. Admin-only and available on
// every license, matching the rest of the Fleet Actions surface. The paid
// label-driven action lives at `POST /api/labels/:id/action`; this receiver is
// the fleet-plumbing equivalent the control fans out to, so a fleet-stop on a
// Community fleet stops remote stacks instead of 403'ing on the remote leg.
fleetActionsRouter.post(
  '/labels/local-stop',
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmin(req, res)) return;
    if (!requireBody(req, res)) return;
    const { labelName, dryRun } = req.body as { labelName?: unknown; dryRun?: unknown };
    if (typeof labelName !== 'string' || labelName.trim().length === 0) {
      res.status(400).json({ error: 'labelName is required' });
      return;
    }
    const nodeId = req.nodeId ?? 0;
    const trimmedLabel = labelName.trim();
    try {
      const outcome = await runLocalLabelStop(nodeId, trimmedLabel, dryRun === true);
      if (isDebugEnabled()) console.debug('[FleetActions:debug] local-stop:', { nodeId, dryRun: dryRun === true, matched: outcome.matched, stacks: outcome.stackResults.length });
      const body: LabelLocalStopResponse = { matched: outcome.matched, results: outcome.stackResults };
      res.json(body);
    } catch (err) {
      console.error('[FleetActions] local-stop error:', { nodeId, labelName: trimmedLabel }, err);
      res.status(500).json({ error: getErrorMessage(err, 'Failed to run local label stop') });
    }
  },
);
