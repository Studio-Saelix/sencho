import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireAdmin, requireBody } from '../middleware/tierGates';
import { getErrorMessage } from '../utils/errors';
import { isDebugEnabled } from '../utils/debug';
import { MAX_ASSIGNMENTS } from '../helpers/constants';
import { runLocalLabelStop, type LabelLocalStopResponse } from '../helpers/fleetLabelStop';
import { runLocalLabelAssign, validateLabelTemplate, type LabelLocalAssignResponse } from '../helpers/fleetLabelAssign';

// Per-node fleet-action endpoints. Mounted under `/api/fleet-actions/`, which
// is NOT in `PROXY_EXEMPT_PREFIXES`, so when `x-node-id` targets a remote node
// the gateway proxies the call and the remote Sencho instance runs its own
// local handler. Multi-node orchestration endpoints live in `routes/fleet.ts`
// because their path must sit behind the `/api/fleet/` proxy-exempt prefix.
export const fleetActionsRouter = Router();

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
    const { labelName, dryRun, stackNames } = req.body as { labelName?: unknown; dryRun?: unknown; stackNames?: unknown };
    if (typeof labelName !== 'string' || labelName.trim().length === 0) {
      res.status(400).json({ error: 'labelName is required' });
      return;
    }
    // Optional allowlist binding the stop to the stacks the control confirmed in
    // its preview, so a stack labelled on this node after the preview is not
    // stopped. Absent (e.g. a dry run) stops every currently label-matched stack.
    let allowedStacks: Set<string> | undefined;
    if (stackNames !== undefined) {
      if (!Array.isArray(stackNames) || !stackNames.every(s => typeof s === 'string')) {
        res.status(400).json({ error: 'stackNames must be an array of strings' });
        return;
      }
      allowedStacks = new Set(stackNames as string[]);
    }
    const nodeId = req.nodeId ?? 0;
    const trimmedLabel = labelName.trim();
    try {
      const outcome = await runLocalLabelStop(nodeId, trimmedLabel, dryRun === true, allowedStacks);
      if (isDebugEnabled()) console.debug('[FleetActions:debug] local-stop:', { nodeId, dryRun: dryRun === true, matched: outcome.matched, stacks: outcome.stackResults.length });
      const body: LabelLocalStopResponse = { matched: outcome.matched, results: outcome.stackResults };
      res.json(body);
    } catch (err) {
      console.error('[FleetActions] local-stop error:', { nodeId, labelName: trimmedLabel }, err);
      res.status(500).json({ error: getErrorMessage(err, 'Failed to run local label stop') });
    }
  },
);

// Per-node label assign. A control instance calls this on each target node
// during a fleet-wide bulk label assign so the label is resolved or created
// under the node's own database, by name, and assigned to the given stacks while
// preserving their existing labels (add semantics). Admin-only and available on
// every license, matching the rest of the Fleet Actions surface. Labels are
// node-local, so the control never reuses a local label id on a remote: the
// receiver owns label resolution for its own node.
fleetActionsRouter.post(
  '/labels/local-assign',
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmin(req, res)) return;
    if (!requireBody(req, res)) return;
    const { label, stackNames } = req.body as { label?: unknown; stackNames?: unknown };
    const validated = validateLabelTemplate(label);
    if (!validated.ok) {
      res.status(400).json({ error: validated.error });
      return;
    }
    if (!Array.isArray(stackNames) || !stackNames.every(s => typeof s === 'string')) {
      res.status(400).json({ error: 'stackNames must be an array of strings' });
      return;
    }
    if (stackNames.length > MAX_ASSIGNMENTS) {
      res.status(400).json({ error: `stackNames may not exceed ${MAX_ASSIGNMENTS} entries` });
      return;
    }
    const nodeId = req.nodeId ?? 0;
    try {
      const outcome = await runLocalLabelAssign(nodeId, validated.template, stackNames as string[]);
      if (isDebugEnabled()) console.debug('[FleetActions:debug] local-assign:', { nodeId, label: validated.template.name, created: outcome.created, stacks: outcome.stackResults.length });
      const body: LabelLocalAssignResponse = { created: outcome.created, results: outcome.stackResults };
      res.json(body);
    } catch (err) {
      console.error('[FleetActions] local-assign error:', { nodeId, label: validated.template.name }, err);
      res.status(500).json({ error: getErrorMessage(err, 'Failed to run local label assign') });
    }
  },
);
