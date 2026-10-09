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
import {
  isNetworkingSeverity,
  networkingDismissPolicy,
  parseNetworkingKey,
  type ParsedNetworkingKey,
} from '../services/network/networkingDismissals';
import {
  isPostureSeverity,
  parseSecurityKey,
  postureDismissPolicy,
  postureKeySeverity,
  type ParsedSecurityKey,
} from '../services/securityPostureDismissals';
import { authMiddleware } from '../middleware/auth';
import { requireAdmin, requireUserSession } from '../middleware/tierGates';
import { requirePermission } from '../middleware/permissions';
import { auditActorUsername } from '../helpers/auditActor';
import { errorMessageForLog } from '../utils/safeLog';

export const findingDismissalsRouter = Router();

const MAX_DAYS = 365;
const DAY_MS = 86_400_000;
const MAX_FINGERPRINT_LENGTH = 64;
const MAX_TARGET_COUNT = 100_000;

type DismissalBody = Record<string, unknown>;

interface ParsedDismissalRequest {
  mode: DismissalMode;
  expiresAt: number | null;
}

/** The mode and expiry a request asks for, or null after answering 400. */
function readDismissalMode(record: DismissalBody, res: Response): ParsedDismissalRequest | null {
  const mode = record.mode;
  if (typeof mode !== 'string' || !(DISMISSAL_MODES as readonly string[]).includes(mode)) {
    res.status(400).json({ error: `mode must be one of: ${DISMISSAL_MODES.join(', ')}` });
    return null;
  }
  if (mode !== 'days') return { mode: mode as DismissalMode, expiresAt: null };
  const days = record.days ?? 7;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    res.status(400).json({ error: `days must be a whole number from 1 to ${MAX_DAYS}` });
    return null;
  }
  return { mode: 'days', expiresAt: Date.now() + days * DAY_MS };
}

/** Authorizes the scope a networking finding key names, from the key alone. */
function authorizeNetworkingKey(req: Request, res: Response, key: ParsedNetworkingKey): boolean {
  if (key.stack !== '') {
    return requirePermission(req, res, 'stack:deploy', 'stack', key.stack, key.nodeId);
  }
  return requirePermission(req, res, 'node:manage', 'node', String(key.nodeId));
}

/** Authorizes the scope a security reason key names: the reason is about the whole node. */
function authorizeSecurityKey(req: Request, res: Response, key: ParsedSecurityKey): boolean {
  return requirePermission(req, res, 'node:manage', 'node', String(key.nodeId));
}

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
 * Whether the caller may restore a row, from its stored key. Null when the key
 * cannot be read for its surface (nothing was answered); false when a 403 was sent.
 */
function authorizeRestore(req: Request, res: Response, surface: string, findingKey: string): boolean | null {
  if (surface === 'readiness') {
    const key = parseReadinessKey(findingKey);
    return key === null ? null : authorizeReadinessKey(req, res, key);
  }
  if (surface === 'networking') {
    const key = parseNetworkingKey(findingKey);
    return key === null ? null : authorizeNetworkingKey(req, res, key);
  }
  if (surface === 'security') {
    const key = parseSecurityKey(findingKey);
    return key === null ? null : authorizeSecurityKey(req, res, key);
  }
  return null;
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
  const requested = readDismissalMode(record, res);
  if (requested === null) return;
  const { mode, expiresAt } = requested;
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
      { mode, expiresAt, createdBy: auditActorUsername(req), now: Date.now() },
    );
    res.status(result.kept ? 200 : 201).json({ dismissal: toFindingDismissal(result.row), kept: result.kept });
  } catch (error) {
    console.error('[Fleet] Readiness dismissal error:', errorMessageForLog(error));
    res.status(500).json({ error: 'Failed to dismiss the finding' });
  } finally {
    res.off('close', onClose);
  }
});

/**
 * The team's networking dismissals for one node. Rows whose time is up are
 * removed here; whether a row still covers its finding is decided by the
 * client against the finding it is looking at, because the hub does not hold
 * a remote node's networking evidence.
 */
findingDismissalsRouter.get('/networking', authMiddleware, (req: Request, res: Response): void => {
  const nodeId = Number(req.query.nodeId);
  if (!Number.isInteger(nodeId) || nodeId < 1) {
    res.status(400).json({ error: 'nodeId must be a node id' });
    return;
  }
  if (!requirePermission(req, res, 'node:read', 'node', String(nodeId))) return;
  try {
    const store = FindingDismissalStore.getInstance();
    const now = Date.now();
    const rows = store.list('networking').filter((row) => row.node_id === nodeId);
    const isLapsed = (row: (typeof rows)[number]): boolean => row.mode === 'days' && row.expires_at !== null && row.expires_at <= now;
    const lapsed = rows.filter(isLapsed);
    if (lapsed.length > 0) store.deleteMany(lapsed.map((row) => row.id));
    res.json({ dismissals: rows.filter((row) => !isLapsed(row)).map(toFindingDismissal) });
  } catch (error) {
    console.error('[Fleet] Networking dismissals read error:', errorMessageForLog(error));
    res.status(500).json({ error: 'Failed to read dismissed findings' });
  }
});

/**
 * Dismiss one networking finding for the team.
 *
 * The key alone names the scope (node, stack, finding kind) and what the kind
 * allows; none of that is read from the request body. The hub does not hold a
 * remote node's networking evidence, so the fingerprint, severity, and count
 * are the state the operator saw, checked for shape. They only decide when the
 * dismissal lifts for the finding it is stored against, so a wrong value
 * affects nothing beyond what the caller was already allowed to set aside.
 */
findingDismissalsRouter.post('/networking', authMiddleware, (req: Request, res: Response): void => {
  if (!requireUserSession(req, res)) return;
  const body: unknown = req.body;
  const record: DismissalBody = typeof body === 'object' && body !== null ? body as DismissalBody : {};
  const findingId = typeof record.findingId === 'string' ? record.findingId : '';
  const key = parseNetworkingKey(findingId);
  if (key === null) {
    res.status(400).json({ error: 'findingId is not a networking finding id' });
    return;
  }
  const { fingerprint, count, severity } = record;
  if (typeof fingerprint !== 'string' || fingerprint === '' || fingerprint.length > MAX_FINGERPRINT_LENGTH
    || typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_TARGET_COUNT
    || !isNetworkingSeverity(severity)) {
    res.status(400).json({ error: 'fingerprint, count, and severity must say which state of the finding was seen' });
    return;
  }
  const requested = readDismissalMode(record, res);
  if (requested === null) return;
  const policy = networkingDismissPolicy(key.kind);
  if (policy === 'none') {
    res.status(400).json({ error: 'This finding is acknowledged in Compose Doctor and cannot be dismissed here.' });
    return;
  }
  if (policy === 'timed' && requested.mode !== 'days') {
    res.status(400).json({ error: 'A finding about evidence that could not be read can only be dismissed for a set number of days.' });
    return;
  }
  if (!authorizeNetworkingKey(req, res, key)) return;
  if (!DatabaseService.getInstance().getNodes().some((node) => node.id === key.nodeId)) {
    res.status(404).json({ error: 'Node not found' });
    return;
  }
  try {
    const result = FindingDismissalStore.getInstance().dismiss(
      {
        nodeId: key.nodeId,
        surface: 'networking',
        findingKey: findingId,
        stackName: key.stack === '' ? null : key.stack,
        fingerprint,
        severity,
        count,
      },
      { mode: requested.mode, expiresAt: requested.expiresAt, createdBy: auditActorUsername(req), now: Date.now() },
    );
    res.status(result.kept ? 200 : 201).json({ dismissal: toFindingDismissal(result.row), kept: result.kept });
  } catch (error) {
    console.error('[Fleet] Networking dismissal error:', errorMessageForLog(error));
    res.status(500).json({ error: 'Failed to dismiss the finding' });
  }
});

/**
 * The team's security dismissals for one node. Lapsed timed rows are removed
 * here; whether a row still covers its reason is decided by the client against
 * the reason it is looking at, because the hub does not hold a remote node's
 * posture evidence.
 */
findingDismissalsRouter.get('/security', authMiddleware, (req: Request, res: Response): void => {
  const nodeId = Number(req.query.nodeId);
  if (!Number.isInteger(nodeId) || nodeId < 1) {
    res.status(400).json({ error: 'nodeId must be a node id' });
    return;
  }
  if (!requirePermission(req, res, 'node:read', 'node', String(nodeId))) return;
  try {
    const store = FindingDismissalStore.getInstance();
    const now = Date.now();
    const rows = store.list('security').filter((row) => row.node_id === nodeId);
    const isLapsed = (row: (typeof rows)[number]): boolean => row.mode === 'days' && row.expires_at !== null && row.expires_at <= now;
    const lapsed = rows.filter(isLapsed);
    if (lapsed.length > 0) store.deleteMany(lapsed.map((row) => row.id));
    res.json({ dismissals: rows.filter((row) => !isLapsed(row)).map(toFindingDismissal) });
  } catch (error) {
    console.error('[Fleet] Security dismissals read error:', errorMessageForLog(error));
    res.status(500).json({ error: 'Failed to read dismissed findings' });
  }
});

/**
 * Dismiss one security posture reason for the team.
 *
 * The key alone names the scope (node, reason kind and variant) and what the
 * reason allows; none of that is read from the request body. Blockers are never
 * dismissed here: a red masthead always lists them. The hub does not hold a
 * remote node's posture evidence, so the fingerprint, severity, and count are
 * the state the operator saw, checked for shape and for consistency with the
 * severity the key carries. They only decide when the dismissal lifts for the
 * reason it is stored against.
 */
findingDismissalsRouter.post('/security', authMiddleware, (req: Request, res: Response): void => {
  if (!requireUserSession(req, res)) return;
  const body: unknown = req.body;
  const record: DismissalBody = typeof body === 'object' && body !== null ? body as DismissalBody : {};
  const findingId = typeof record.findingId === 'string' ? record.findingId : '';
  const key = parseSecurityKey(findingId);
  if (key === null) {
    res.status(400).json({ error: 'findingId is not a security finding id' });
    return;
  }
  const { fingerprint, count, severity } = record;
  if (typeof fingerprint !== 'string' || fingerprint === '' || fingerprint.length > MAX_FINGERPRINT_LENGTH
    || typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_TARGET_COUNT
    || !isPostureSeverity(severity) || severity !== postureKeySeverity(key.reasonKey)) {
    res.status(400).json({ error: 'fingerprint, count, and severity must say which state of the finding was seen' });
    return;
  }
  const requested = readDismissalMode(record, res);
  if (requested === null) return;
  const policy = postureDismissPolicy(key.reasonKey);
  if (policy === 'none') {
    res.status(400).json({ error: 'This finding keeps the posture at Action needed and is resolved from its own action, so it cannot be dismissed.' });
    return;
  }
  if (policy === 'timed' && requested.mode !== 'days') {
    res.status(400).json({ error: 'A finding about evidence that is missing or out of date can only be dismissed for a set number of days.' });
    return;
  }
  if (!authorizeSecurityKey(req, res, key)) return;
  if (!DatabaseService.getInstance().getNodes().some((node) => node.id === key.nodeId)) {
    res.status(404).json({ error: 'Node not found' });
    return;
  }
  try {
    const result = FindingDismissalStore.getInstance().dismiss(
      {
        nodeId: key.nodeId,
        surface: 'security',
        findingKey: findingId,
        stackName: null,
        fingerprint,
        severity,
        count,
      },
      { mode: requested.mode, expiresAt: requested.expiresAt, createdBy: auditActorUsername(req), now: Date.now() },
    );
    res.status(result.kept ? 200 : 201).json({ dismissal: toFindingDismissal(result.row), kept: result.kept });
  } catch (error) {
    console.error('[Fleet] Security dismissal error:', errorMessageForLog(error));
    res.status(500).json({ error: 'Failed to dismiss the finding' });
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
    const authorized = authorizeRestore(req, res, row.surface, row.finding_key);
    if (authorized === null) {
      console.error('[Fleet] Dismissal has an unreadable scope:', row.id, row.surface);
      res.status(400).json({ error: 'Dismissal has an unreadable scope' });
      return;
    }
    if (!authorized) return;
    store.delete(id);
    res.status(204).end();
  } catch (error) {
    console.error('[Fleet] Readiness dismissal restore error:', errorMessageForLog(error));
    res.status(500).json({ error: 'Failed to restore the finding' });
  }
});
