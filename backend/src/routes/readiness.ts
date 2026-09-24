import { Router, type Request, type Response } from 'express';
import { requirePermission } from '../middleware/permissions';
import { buildNodeReadinessEvidence } from '../services/readiness/readinessEvidence';
import { errorMessageForLog } from '../utils/safeLog';

export const readinessRouter = Router();

/**
 * This node's readiness evidence, read by the hub during its fan-out.
 *
 * Guarded by `stack:read`: the payload names stacks and their container states,
 * which is what `GET /api/stacks/statuses` already exposes under that action, and
 * it is at least as strict as the auth-only guard on the posture page it
 * summarizes. Every shipped role holds the action, so this declares the
 * discipline rather than separating roles: there is no reader to turn away
 * today, and the guard is what keeps a later widening visible.
 *
 * The assembly lives in `services/readiness/readinessEvidence.ts`, which the
 * hub's local fast path calls directly: this route and that path have to return
 * the same payload, so they run the same function. That module documents what
 * each domain does when its inputs fail and where the payload's timestamp is
 * taken.
 */
readinessRouter.get('/evidence', async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'stack:read')) return;
  try {
    const payload = await buildNodeReadinessEvidence(req.nodeId);
    res.json(payload);
  } catch (error) {
    // The hub reads a failure here as a failed probe, which is the answer it
    // should get: this node could not produce its own evidence. The error still
    // belongs in the log, because "the hub says the node is unreachable" is a
    // symptom whose cause is only visible on the node.
    console.error('Readiness evidence: assembly failed:', errorMessageForLog(error));
    res.status(500).json({ error: 'Could not assemble readiness evidence' });
  }
});
