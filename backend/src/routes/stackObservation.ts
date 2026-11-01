import { Router, type Request, type Response } from 'express';
import { DatabaseService } from '../services/DatabaseService';
import { requirePermission } from '../middleware/permissions';
import { isValidStackName } from '../utils/validation';
import { errorMessageForLog, sanitizeForLog } from '../utils/safeLog';
import { buildStackStatusesEvidence } from '../services/stackStatusesEvidence';
import { readStackHealthFacts } from '../services/health/stackHealthFacts';
import {
  computeStackReadinessEvidence,
  PASS_DEADLINE_MS,
  toStackReadinessRow,
} from '../services/readiness/stackReadinessSummary';
import {
  observationEnvelope,
  projectStackList,
  projectStackReadiness,
  projectStackStatus,
  projectUnavailableStackStatus,
  STACK_PAGE_DEFAULT,
  STACK_PAGE_MAX,
  type StackStatusEntry,
} from '../services/observation/projections';
import { requireStackExists } from './stacks';

/**
 * The read-only projection surface an AI client may reach with an Observe Only
 * token: the node's stack list and one stack's container facts and readiness.
 *
 * Every response is built by `services/observation/projections.ts`, which is the
 * only place the field allowlists live. The routes select evidence and bound it;
 * they never render Compose, read an env file, or compute a verdict.
 *
 * Mounted ahead of `stacksRouter` so the two observation paths never meet that
 * router's generic `/:stackName` handlers, and registered in
 * `helpers/stackRouteAuth.ts` under `stack:read` so the hub pre-check and the
 * node-side classifier agree on who may ask.
 */
export const stackObservationRouter = Router();

type Parsed<T> = { ok: true; value: T } | { ok: false };

function parseLimit(raw: unknown): Parsed<number> {
  if (raw === undefined) return { ok: true, value: STACK_PAGE_DEFAULT };
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) return { ok: false };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > STACK_PAGE_MAX) return { ok: false };
  return { ok: true, value };
}

function parseCursor(raw: unknown): Parsed<string | null> {
  if (raw === undefined || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string' || !isValidStackName(raw)) return { ok: false };
  return { ok: true, value: raw };
}

/** Exact stack permission first, then the name shape, matching the rest of `/stacks`. */
function requireNamedStackAccess(req: Request, res: Response): string | null {
  const stackName = req.params.stackName as string;
  if (!requirePermission(req, res, 'stack:read', 'stack', stackName)) return null;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return null;
  }
  return stackName;
}

stackObservationRouter.get('/platform/observation', async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'stack:read')) return;

  const limit = parseLimit(req.query.limit);
  if (!limit.ok) {
    res.status(400).json({
      error: `limit must be an integer between 1 and ${STACK_PAGE_MAX}`,
      code: 'INVALID_LIMIT',
    });
    return;
  }
  const cursor = parseCursor(req.query.cursor);
  if (!cursor.ok) {
    res.status(400).json({
      error: 'cursor must be the name of the last stack returned by the previous page',
      code: 'INVALID_CURSOR',
    });
    return;
  }

  try {
    const { evidence } = await buildStackStatusesEvidence(req.nodeId);
    const entries: StackStatusEntry[] = Object.entries(evidence.data)
      .map(([file, info]) => ({
        name: file.replace(/\.(yml|yaml)$/, ''),
        info,
        source: info.source,
        isSelf: info.isSelf,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(observationEnvelope(
      evidence.generatedAt,
      projectStackList(entries, cursor.value, limit.value, evidence.degraded),
    ));
  } catch (error) {
    console.error('[StackObservation] Failed to read stack statuses:', errorMessageForLog(error));
    res.status(500).json({ error: 'Failed to read stack statuses' });
  }
});

stackObservationRouter.get('/:stackName/observation/status', async (req: Request, res: Response): Promise<void> => {
  const stackName = requireNamedStackAccess(req, res);
  if (stackName === null) return;
  if (!(await requireStackExists(req.nodeId, stackName, res, 'STACK_NOT_FOUND'))) return;

  try {
    const facts = await readStackHealthFacts({ nodeId: req.nodeId, stackName });
    if (facts.kind !== 'ok') {
      // The node answered about itself and the answer may change in a moment:
      // a 200 carrying `unavailable` is the truthful shape, not a 5xx.
      console.warn(
        '[StackObservation] Container facts unavailable for %s on node %d:',
        sanitizeForLog(stackName), req.nodeId,
        facts.kind === 'unavailable' ? sanitizeForLog(facts.detail) : facts.kind,
      );
      res.json(observationEnvelope(Date.now(), projectUnavailableStackStatus(stackName)));
      return;
    }
    res.json(observationEnvelope(Date.now(), projectStackStatus(stackName, facts.containers)));
  } catch (error) {
    console.error(
      '[StackObservation] Failed to read container facts for %s:',
      sanitizeForLog(stackName),
      errorMessageForLog(error),
    );
    res.status(500).json({ error: 'Failed to read stack container facts' });
  }
});

stackObservationRouter.get('/:stackName/observation/readiness', async (req: Request, res: Response): Promise<void> => {
  const stackName = requireNamedStackAccess(req, res);
  if (stackName === null) return;
  if (!(await requireStackExists(req.nodeId, stackName, res, 'STACK_NOT_FOUND'))) return;

  try {
    // A fresh deadline per request, not the summary's cached pass: the caller
    // asked about one stack, so the 25-stack cap does not apply to the answer.
    const evidence = await computeStackReadinessEvidence(
      req.nodeId,
      stackName,
      Date.now() + PASS_DEADLINE_MS,
      // The same optional Compose-version phase the summary pass runs, so this
      // answer is the verdict the fleet matrix shows for the same stack.
      { includeComposeVersion: true },
    );
    const hasUpdate = DatabaseService.getInstance()
      .getStackUpdateDetail(req.nodeId)[stackName]?.hasUpdate === true;
    res.json(observationEnvelope(
      Date.now(),
      projectStackReadiness(toStackReadinessRow(evidence, hasUpdate)),
    ));
  } catch (error) {
    console.error(
      '[StackObservation] Failed to compute readiness for %s:',
      sanitizeForLog(stackName),
      errorMessageForLog(error),
    );
    res.status(500).json({ error: 'Failed to compute stack readiness' });
  }
});
