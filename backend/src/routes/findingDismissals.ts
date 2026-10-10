import { Router, type Request, type Response } from 'express';
import { DatabaseService } from '../services/DatabaseService';
import { FindingDismissalStore } from '../services/findingDismissals/FindingDismissalStore';
import {
  DISMISSAL_MODES,
  toFindingDismissal,
  type DismissalMode,
} from '../services/findingDismissals/types';
import { buildFleetReadiness } from '../services/readiness/readinessAggregator';
import { parseReadinessKey } from '../services/readiness/readinessDismissals';
import { authMiddleware } from '../middleware/auth';
import { requireAdmin, requireUserSession } from '../middleware/tierGates';
import { requirePermission } from '../middleware/permissions';
import { auditActorUsername } from '../helpers/auditActor';
import { errorMessageForLog } from '../utils/safeLog';

export const findingDismissalsRouter = Router();

const MAX_DAYS = 365;
const DAY_MS = 86_400_000;

/** Authorizes the scope a readiness finding id names, from the id alone. */
function authorizeReadinessKey(req: Request, res: Response, key: NonNullable<ReturnType<typeof parseReadinessKey>>): boolean {
  // Control findings are withheld from non-admins, so they cannot be named by one.
  if (key.domain === 'control') return requireAdmin(req, res);
  if (key.stack !== null) {
    return requirePermission(req, res, 'stack:deploy', 'stack', key.stack, key.nodeId);
  }
  return requirePermission(req, res, 'node:manage', 'node', String(key.nodeId));
}

/**
 * Dismiss one readiness finding for the team.
 *
 * The id alone names the scope: node, stack, and domain are parsed from it and
 * authorized from there. Fingerprint, severity, and count come from a fresh read
 * of that one node and domain, never from the request, so a forged value cannot
 * widen what the caller may hide. The fingerprint and count the caller saw are
 * checked against that read and refused when they differ, so a finding that got
 * worse after the click is never hidden unseen. A finding that is no longer
 * present is refused, because there is nothing left to dismiss.
 */
findingDismissalsRouter.post('/readiness', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireUserSession(req, res)) return;
  const body: unknown = req.body;
  const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  const findingId = typeof record.findingId === 'string' ? record.findingId : '';
  const key = parseReadinessKey(findingId);
  if (key === null) {
    res.status(400).json({ error: 'findingId is not a readiness finding id' });
    return;
  }
  const seenFingerprint = record.fingerprint;
  const seenCount = record.count;
  if (typeof seenFingerprint !== 'string' || typeof seenCount !== 'number') {
    res.status(400).json({ error: 'fingerprint and count must say which state of the finding was seen' });
    return;
  }
  const mode = record.mode;
  if (typeof mode !== 'string' || !(DISMISSAL_MODES as readonly string[]).includes(mode)) {
    res.status(400).json({ error: `mode must be one of: ${DISMISSAL_MODES.join(', ')}` });
    return;
  }
  let expiresAt: number | null = null;
  if (mode === 'days') {
    const days = record.days ?? 7;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
      res.status(400).json({ error: `days must be a whole number from 1 to ${MAX_DAYS}` });
      return;
    }
    expiresAt = Date.now() + days * DAY_MS;
  }
  if (!authorizeReadinessKey(req, res, key)) return;
  if (!DatabaseService.getInstance().getNodes().some((node) => node.id === key.nodeId)) {
    res.status(404).json({ error: 'Node not found' });
    return;
  }

  const controller = new AbortController();
  const onClose = (): void => controller.abort();
  res.on('close', onClose);
  try {
    const current = await buildFleetReadiness({
      domains: [key.domain],
      nodeIds: [key.nodeId],
      includeControl: req.user?.role === 'admin',
      signal: controller.signal,
      withDismissals: false,
    });
    const finding = current.findings.find((candidate) => candidate.id === findingId);
    if (!finding) {
      res.status(409).json({ error: 'That finding is no longer present.', code: 'FINDING_GONE' });
      return;
    }
    // Used only as a guard, never stored: a finding that changed between the click
    // and this request is not what the operator chose to set aside.
    if (finding.fingerprint !== seenFingerprint || finding.count !== seenCount) {
      res.status(409).json({ error: 'That finding changed. Review it again.', code: 'FINDING_CHANGED' });
      return;
    }
    if (finding.dismissPolicy === 'none') {
      res.status(400).json({ error: 'This finding is resolved on another page and cannot be dismissed here.' });
      return;
    }
    if (mode !== 'days' && finding.dismissPolicy !== 'any') {
      res.status(400).json({ error: 'A finding about evidence that could not be read can only be dismissed for a set number of days.' });
      return;
    }
    const result = FindingDismissalStore.getInstance().dismiss(
      {
        nodeId: key.nodeId,
        surface: 'readiness',
        findingKey: finding.id,
        stackName: key.stack,
        fingerprint: finding.fingerprint,
        severity: finding.severity,
        count: finding.count,
      },
      { mode: mode as DismissalMode, expiresAt, createdBy: auditActorUsername(req), now: Date.now() },
    );
    res.status(result.kept ? 200 : 201).json({ dismissal: toFindingDismissal(result.row), kept: result.kept });
  } catch (error) {
    console.error('[Fleet] Readiness dismissal error:', errorMessageForLog(error));
    res.status(500).json({ error: 'Failed to dismiss the finding' });
  } finally {
    res.off('close', onClose);
  }
});

/** Restore a dismissed finding. The caller needs the same permission that dismissing it took. */
findingDismissalsRouter.delete('/:id', authMiddleware, (req: Request, res: Response): void => {
  if (!requireUserSession(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: 'Invalid dismissal id' });
    return;
  }
  const store = FindingDismissalStore.getInstance();
  try {
    const row = store.get(id);
    if (!row) {
      res.status(404).json({ error: 'Dismissal not found' });
      return;
    }
    const key = row.surface === 'readiness' ? parseReadinessKey(row.finding_key) : null;
    if (key === null) {
      res.status(400).json({ error: 'Dismissal has an unreadable scope' });
      return;
    }
    if (!authorizeReadinessKey(req, res, key)) return;
    store.delete(id);
    res.status(204).end();
  } catch (error) {
    console.error('[Fleet] Readiness dismissal restore error:', errorMessageForLog(error));
    res.status(500).json({ error: 'Failed to restore the finding' });
  }
});
