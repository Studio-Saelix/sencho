/**
 * Hub-owned GitOps portfolio read routes.
 *
 *   GET /api/gitops/applications      filtered, sorted, paginated portfolio + summary
 *   GET /api/gitops/applications/:id  one application's row + canonical projection
 *
 * Both are hub-owned control-plane reads: the mounted prefix is listed in
 * HUB_ONLY_PREFIXES so a request carrying a remote node id is refused by
 * hubOnlyGuard rather than answered with a remote view of the control plane.
 * The portfolio is aggregated on the hub (see services/gitops/portfolioAggregator.ts);
 * the browser never fans out per node.
 *
 * Rows not returned are never a security verdict: per-row read authorization
 * drops rows (the same convention as GET /api/git-sources), while an
 * unreachable node is reported through `coverage` so its absent applications
 * read as partial evidence, not as health.
 */
import { Router, type Request, type Response } from 'express';
import { DatabaseService, type Blueprint } from '../services/DatabaseService';
import { NodeRegistry } from '../services/NodeRegistry';
import { checkPermission, requirePermission } from '../middleware/permissions';
import { projectApplication } from '../services/gitops/derive';
import { latestTransitionByApplication } from '../services/gitops/history';
import { classifySourceRow, satisfiesGitOpsRead } from '../services/gitops/readAuth';
import { healthGateDisabled, NOT_APPLICABLE_REVISION, stackResourceSet } from '../helpers/gitopsResponse';
import { buildBlueprintPreview, type BlueprintPreviewResult } from '../services/blueprintPreviewProjection';
import {
  confirmableActionsEqual,
  deriveBlastFromConfirmableActions,
  parseConfirmableActionsBody,
} from '../services/blueprintApproval';
import { isGitManagedBlueprint } from '../services/gitops/binding';
import {
  canonicalizeNodeIds,
  decodeGitOpsRequiredTargetsJson,
  encodeGitOpsApprovedTargetEffectJson,
} from '../services/gitops/json';
import { placementEffectCompatible } from '../services/gitops/store';
import { GitOpsTransitions, GitOpsTransitionError } from '../services/gitops/transitions';
import { newGitOpsId } from '../services/gitops/directApplication';
import {
  buildAcceptedGeneration,
  ensureRolloutAuthorization,
} from '../services/gitops/handoff';
import { GitSourceService } from '../services/GitSourceService';
import { sanitizeForLog } from '../utils/safeLog';
import {
  aggregateGitOpsPortfolio,
  fetchRemoteSourceRows,
  freshestFacetTimestamp,
  isUsableRevision,
  rowFromProjection,
} from '../services/gitops/portfolioAggregator';
import { filterRemoteIdentityPayload, rewriteIdentityPayload } from '../proxy/gitopsIdentityProxy';
import { GitOpsStore } from '../services/gitops/store';
import { isRecord } from '../services/gitops/json';
import type {
  GitOpsPortfolioDetailResponse,
  GitOpsPortfolioFilters,
  GitOpsPortfolioResponse,
  GitOpsPortfolioRow,
} from '../services/gitops/portfolioTypes';
import type { GitOpsApplicationRow, GitOpsDriftItem } from '../services/gitops/types';

export const gitopsApplicationsRouter = Router();

const DEFAULT_LIMIT = 50;
/** Page ceiling for this surface, independent of the history feed's own clamp. */
const MAX_LIMIT = 100;

const SORTS = new Set<GitOpsPortfolioFilters['sort']>(['attention', 'name', 'activity']);
const TARGET_MODES = new Set(['direct', 'blueprint']);
const EVIDENCE_FILTERS = new Set(['stale', 'unreachable', 'unknown']);
const DRIFT_CLASSES = new Set<GitOpsDriftItem['class']>([
  'source', 'managed_project', 'invocation', 'placement', 'rollout', 'runtime', 'health',
]);

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseLimitParam(value: unknown): number {
  const raw = stringParam(value);
  if (raw === undefined) return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

type Cursor = { o: number };

/**
 * Opaque offset cursor.
 *
 * Deliberately not bound to the filter/sort set: clients reset pagination when
 * the question changes (the workplace drops its cursor stack on every filter
 * edit), so a cursor is only ever replayed against the same set. A crafted
 * request that pairs a stored cursor with different filters gets a window of
 * the new set rather than an error, which leaks nothing beyond the authorized
 * rows it already returns.
 */
function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { v, o } = parsed as { v?: unknown; o?: unknown };
    if (v !== 1 || typeof o !== 'number' || !Number.isSafeInteger(o) || o < 0) return null;
    return { o };
  } catch {
    return null;
  }
}

type ParseResult = { ok: true; filters: GitOpsPortfolioFilters } | { ok: false; message: string };

/**
 * Read the caller's filters. A recognized filter with an unusable value is a
 * 400 rather than a silently broader answer (the `gitopsHistoryPage` parse
 * convention), because on a triage surface a superset reads as the answer.
 */
function parseFilters(query: Request['query']): ParseResult {
  const targetModeRaw = stringParam(query.mode);
  if (targetModeRaw !== undefined && !TARGET_MODES.has(targetModeRaw)) {
    return { ok: false, message: "mode must be 'direct' or 'blueprint'" };
  }
  const evidenceRaw = stringParam(query.evidence);
  if (evidenceRaw !== undefined && !EVIDENCE_FILTERS.has(evidenceRaw)) {
    return { ok: false, message: "evidence must be one of: stale, unreachable, unknown" };
  }
  const sortRaw = stringParam(query.sort);
  if (sortRaw !== undefined && !SORTS.has(sortRaw as GitOpsPortfolioFilters['sort'])) {
    return { ok: false, message: `sort must be one of: ${[...SORTS].join(', ')}` };
  }
  const dirRaw = stringParam(query.dir);
  if (dirRaw !== undefined && dirRaw !== 'asc' && dirRaw !== 'desc') {
    return { ok: false, message: "dir must be 'asc' or 'desc'" };
  }
  const intParam = (key: string): number | null | 'invalid' => {
    const raw = stringParam(query[key]);
    if (raw === undefined) return null;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? parsed : 'invalid';
  };
  const nodeId = intParam('nodeId');
  if (nodeId === 'invalid') return { ok: false, message: 'nodeId must be an integer' };
  const blueprintId = intParam('blueprintId');
  if (blueprintId === 'invalid') return { ok: false, message: 'blueprintId must be an integer' };
  // Drift classes are a closed set defined by this build, so an unrecognized
  // one is rejected. Source/rollout/health take facet status strings and are
  // deliberately passed through: a node may run a newer Sencho whose status
  // vocabulary this build does not know, and filtering on that status is a
  // legitimate question even when its label is unknown here.
  const driftRaw = stringParam(query.drift);
  if (driftRaw !== undefined && !DRIFT_CLASSES.has(driftRaw as GitOpsDriftItem['class'])) {
    return { ok: false, message: `drift must be one of: ${[...DRIFT_CLASSES].join(', ')}` };
  }

  return {
    ok: true,
    filters: {
      q: stringParam(query.q),
      attentionOnly: stringParam(query.attention) === '1',
      targetMode: targetModeRaw as GitOpsPortfolioFilters['targetMode'],
      nodeId: nodeId ?? undefined,
      blueprintId: blueprintId ?? undefined,
      sourceStatus: stringParam(query.source),
      rolloutStatus: stringParam(query.rollout),
      healthStatus: stringParam(query.health),
      driftClass: driftRaw as GitOpsPortfolioFilters['driftClass'],
      evidence: evidenceRaw as GitOpsPortfolioFilters['evidence'],
      sort: (sortRaw as GitOpsPortfolioFilters['sort']) ?? 'attention',
      dir: dirRaw ?? 'asc',
    },
  };
}

function matchesFilters(row: GitOpsPortfolioRow, filters: GitOpsPortfolioFilters): boolean {
  if (filters.attentionOnly && row.attention.length === 0) return false;
  if (filters.targetMode === 'direct' && row.targetMode !== 'direct') return false;
  if (filters.targetMode === 'blueprint' && row.targetMode !== 'blueprint' && row.targetMode !== 'inline_blueprint') return false;
  // Node involvement: a Direct application belongs to its owning node; a
  // Blueprint application belongs to every node its targets name, so filtering
  // by node never shrinks the fleet picture into per-node truth.
  if (filters.nodeId !== undefined) {
    const involved = row.nodeId === filters.nodeId || row.targets.some(target => target.nodeId === filters.nodeId);
    if (!involved) return false;
  }
  if (filters.blueprintId !== undefined && row.blueprintId !== filters.blueprintId) return false;
  if (filters.sourceStatus !== undefined && row.sourceStatus !== filters.sourceStatus) return false;
  if (filters.rolloutStatus !== undefined && row.rolloutStatus !== filters.rolloutStatus) return false;
  if (filters.healthStatus !== undefined && row.healthStatus !== filters.healthStatus) return false;
  if (filters.driftClass !== undefined && !row.drift.classes.includes(filters.driftClass)) return false;
  if (filters.evidence === 'unknown' && !row.evidence.unknown) return false;
  if (filters.evidence === 'stale'
    && !row.targets.some(target => target.evidence === 'stale')
    && !row.attention.includes('target_stale')) return false;
  if (filters.evidence === 'unreachable'
    && row.evidence.unreachableNodes.length === 0
    && !row.targets.some(target => target.connectivity === 'unreachable')) return false;
  if (filters.q !== undefined) {
    const needle = filters.q.toLowerCase();
    const haystack = [
      row.name,
      row.repository?.configuredRepoUrl ?? '',
      row.repository?.host ?? '',
      row.repository?.pathname ?? '',
      row.repository?.configuredRef ?? '',
    ].join(' ').toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

const POSTURE_RANK: Record<GitOpsPortfolioRow['posture'], number> = {
  failed: 0,
  attention: 1,
  in_progress: 2,
  unknown: 3,
  converged_qualified: 4,
  converged: 5,
};

function sortRows(rows: GitOpsPortfolioRow[], filters: GitOpsPortfolioFilters): GitOpsPortfolioRow[] {
  const sign = filters.dir === 'desc' ? -1 : 1;
  const byName = (a: GitOpsPortfolioRow, b: GitOpsPortfolioRow) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const sorted = [...rows];
  if (filters.sort === 'name') {
    sorted.sort((a, b) => sign * byName(a, b));
  } else if (filters.sort === 'activity') {
    sorted.sort((a, b) => sign * ((a.lastActivityAt ?? -1) - (b.lastActivityAt ?? -1)) || byName(a, b));
  } else {
    sorted.sort((a, b) => sign * (POSTURE_RANK[a.posture] - POSTURE_RANK[b.posture])
      || sign * (b.attention.length - a.attention.length)
      || byName(a, b));
  }
  return sorted;
}

/**
 * Portfolio summary over the authorized set.
 *
 * `failed` is a subset of `attentionRequired` by design (a failure is an
 * attention reason): the masthead renders both, and `attentionRequired` is the
 * one total triage count. `attention`-posture rows are counted only through
 * `attentionRequired`; the remaining postures partition the rest.
 */
function summarize(rows: GitOpsPortfolioRow[]): GitOpsPortfolioResponse['summary'] {
  const byReason: GitOpsPortfolioResponse['summary']['byReason'] = {};
  let attentionRequired = 0;
  let failed = 0;
  let inProgress = 0;
  let converged = 0;
  let convergedQualified = 0;
  let unknown = 0;
  let drifted = 0;
  for (const row of rows) {
    if (row.attention.length > 0) attentionRequired += 1;
    if (row.posture === 'failed') failed += 1;
    else if (row.posture === 'in_progress') inProgress += 1;
    else if (row.posture === 'converged') converged += 1;
    else if (row.posture === 'converged_qualified') convergedQualified += 1;
    else if (row.posture === 'unknown') unknown += 1;
    if (row.drift.count > 0) drifted += 1;
    for (const reason of row.attention) byReason[reason] = (byReason[reason] ?? 0) + 1;
  }
  return {
    applications: rows.length,
    attentionRequired,
    failed,
    inProgress,
    converged,
    convergedQualified,
    unknown,
    drifted,
    byReason,
  };
}

/** Bound on the returned attention queue; the summary still counts every reason. */
const ATTENTION_QUEUE_CAP = 100;

gitopsApplicationsRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const parsed = parseFilters(req.query);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.message });
      return;
    }
    const cursorRaw = stringParam(req.query.cursor);
    const cursor = cursorRaw === undefined ? null : decodeCursor(cursorRaw);
    if (cursorRaw !== undefined && cursor === null) {
      res.status(400).json({ error: 'Invalid page cursor. Restart from the first page.' });
      return;
    }

    const { rows, coverage, truncated } = await aggregateGitOpsPortfolio(req);
    const summary = summarize(rows);
    // The queue is built from the unfiltered authorized set so a search or a
    // later page cannot hide an exception the masthead still counts. It is
    // bounded on its own; the overflow is reported rather than dropped.
    const sortedAttention = sortRows(rows.filter(row => row.attention.length > 0), {
      ...parsed.filters,
      sort: 'attention',
      dir: 'asc',
    });
    const attentionQueue = sortedAttention.slice(0, ATTENTION_QUEUE_CAP);
    const attentionQueueTruncated = sortedAttention.length > ATTENTION_QUEUE_CAP;
    const page = sortRows(rows.filter(row => matchesFilters(row, parsed.filters)), parsed.filters);
    const limit = parseLimitParam(req.query.limit);
    const offset = cursor?.o ?? 0;
    const items = page.slice(offset, offset + limit);
    const nextCursor = offset + items.length < page.length ? encodeCursor({ o: offset + items.length }) : null;

    const response: GitOpsPortfolioResponse = {
      schemaVersion: 1,
      generatedAt: Date.now(),
      summary,
      coverage,
      attentionQueue,
      attentionQueueTruncated,
      applications: items,
      nextCursor,
      truncated,
    };
    res.json(response);
  } catch (error) {
    console.error('[GitOps portfolio] List error:', error);
    res.status(500).json({ error: 'Failed to list GitOps applications' });
  }
});

type ParsedId =
  | { kind: 'blueprint'; blueprintId: number }
  | { kind: 'direct'; nodeId: number; applicationId: string }
  | { kind: 'invalid' };

function parsePortfolioId(raw: string): ParsedId {
  const blueprint = /^bp:(\d+)$/.exec(raw);
  if (blueprint) {
    return { kind: 'blueprint', blueprintId: Number(blueprint[1]) };
  }
  const direct = /^(\d+):(.+)$/.exec(raw);
  if (direct) return { kind: 'direct', nodeId: Number(direct[1]), applicationId: direct[2] };
  return { kind: 'invalid' };
}

function nodeNameMap(db: DatabaseService, maySeeNodeNames: boolean): Map<number, string | null> {
  return new Map(db.getNodes().map(node => [node.id, maySeeNodeNames ? node.name ?? null : null]));
}

type AuthorityTarget = { application: GitOpsApplicationRow; blueprint: Blueprint };

const NOT_GIT_MANAGED = {
  error: 'Decomposed authority actions apply to Git-managed Blueprint applications',
  code: 'NOT_GIT_MANAGED',
} as const;

/**
 * Resolve a portfolio id to the local Git-managed Blueprint application a
 * decomposed authority action may write to.
 *
 * Decomposed actions cover the Git-managed path only: an Inline Blueprint's
 * combined approval is written by Apply, and a Direct application has no
 * placement or rollout authority to record. Anything else is answered here
 * rather than refused later by a transition, so the reason names the surface
 * contract instead of an internal precondition.
 */
function resolveAuthorityTarget(req: Request, res: Response): AuthorityTarget | null {
  const rawParam: unknown = req.params.id;
  const id = typeof rawParam === 'string' ? rawParam : Array.isArray(rawParam) ? rawParam.join('/') : '';
  const parsedId = parsePortfolioId(id);
  if (parsedId.kind === 'invalid') {
    res.status(400).json({ error: 'Application id is not a portfolio id' });
    return null;
  }
  if (parsedId.kind !== 'blueprint') {
    res.status(409).json(NOT_GIT_MANAGED);
    return null;
  }
  const application = GitOpsStore.getInstance().getLiveBlueprintApplication(parsedId.blueprintId);
  const blueprint = application?.blueprint_id !== null && application?.blueprint_id !== undefined
    ? DatabaseService.getInstance().getBlueprint(application.blueprint_id)
    : undefined;
  if (!application || !blueprint) {
    res.status(404).json({ error: 'Application not found' });
    return null;
  }
  if (application.target_mode !== 'blueprint' || !isGitManagedBlueprint(blueprint)) {
    res.status(409).json(NOT_GIT_MANAGED);
    return null;
  }
  return { application, blueprint };
}

/** The actor recorded on a decomposed authority action's transition. */
function actorFromRequest(req: Request): string | null {
  return req.user?.username ?? null;
}

gitopsApplicationsRouter.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const rawParam: unknown = req.params.id;
    const id = typeof rawParam === 'string' ? rawParam : Array.isArray(rawParam) ? rawParam.join('/') : '';
    const parsedId = parsePortfolioId(id);
    if (parsedId.kind === 'invalid') {
      res.status(400).json({ error: 'Application id is not a portfolio id' });
      return;
    }
    const db = DatabaseService.getInstance();
    const store = GitOpsStore.getInstance();
    const maySeeNodeNames = checkPermission(req, 'node:read');
    const nodeNames = nodeNameMap(db, maySeeNodeNames);

    if (parsedId.kind === 'blueprint') {
      // Blueprint detail is read like the catalog: the fleet-wide read grant.
      if (!checkPermission(req, 'node:read')) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }
      const application = store.getLiveBlueprintApplication(parsedId.blueprintId);
      if (!application || application.blueprint_id === null) {
        res.status(404).json({ error: 'Application not found' });
        return;
      }
      const projection = projectApplication(application.id, healthGateDisabled());
      const blueprint = db.getBlueprint(application.blueprint_id);
      const lastActivityAt = latestTransitionByApplication(db.getDb(), [application.id]).get(application.id) ?? null;
      const response: GitOpsPortfolioDetailResponse = {
        schemaVersion: 1,
        generatedAt: Date.now(),
        application: rowFromProjection({
          id,
          projection,
          name: blueprint?.name ?? `blueprint #${application.blueprint_id}`,
          stackName: null,
          blueprintId: application.blueprint_id,
          nodeId: null,
          nodeName: null,
          lastActivityAt,
          partialNodes: [],
          nodeNames,
        }),
        projection,
      };
      res.json(response);
      return;
    }

    const localNodeId = NodeRegistry.getInstance().getDefaultNodeId();
    if (parsedId.nodeId === localNodeId) {
      const application = store.getApplication(parsedId.applicationId);
      const stackName = application?.stack_name ?? null;
      // Same partition the list serves: live Direct applications. Blueprint
      // applications have their own `bp:` identity, and a `creating` row is a
      // create still in flight, not yet something the portfolio lists.
      const live = application !== undefined
        && application.target_mode === 'direct'
        && application.lifecycle_status === 'active'
        && stackName !== null;
      if (!live || !application || stackName === null) {
        res.status(404).json({ error: 'Application not found' });
        return;
      }
      const projection = projectApplication(application.id, healthGateDisabled());
      const requirement = classifySourceRow({
        stackName,
        gitopsRevision: projection,
        stackResourcePresent: (await stackResourceSet(req.nodeId)).has(stackName),
      });
      if (!satisfiesGitOpsRead(req, requirement)) {
        // Not-readable applications answer 404, not 403: a granted-existence
        // check would make id enumeration cheap enough to map the portfolio an
        // unauthorized reader cannot list.
        res.status(404).json({ error: 'Application not found' });
        return;
      }
      const lastActivityAt = latestTransitionByApplication(db.getDb(), [application.id]).get(application.id) ?? null;
      const response: GitOpsPortfolioDetailResponse = {
        schemaVersion: 1,
        generatedAt: Date.now(),
        application: rowFromProjection({
          id,
          projection,
          name: stackName,
          stackName,
          blueprintId: null,
          nodeId: localNodeId,
          nodeName: nodeNames.get(localNodeId) ?? null,
          lastActivityAt,
          partialNodes: [],
          nodeNames,
        }),
        projection,
      };
      res.json(response);
      return;
    }

    // Remote Direct application: one bounded probe of that node,
    // identity-rewritten, re-authorized for this caller, same response shape.
    const rows = await fetchRemoteSourceRows(parsedId.nodeId);
    if (rows === null) {
      res.status(503).json({ error: 'Owning node is unreachable', code: 'node_unreachable' });
      return;
    }
    if (rows === 'unsupported') {
      res.status(502).json({ error: 'Owning node cannot answer GitOps portfolio reads', code: 'node_unsupported' });
      return;
    }
    rewriteIdentityPayload(rows, parsedId.nodeId);
    const filtered = filterRemoteIdentityPayload(
      '/git-sources',
      rows,
      (requirement) => satisfiesGitOpsRead(req, requirement),
      parsedId.nodeId,
    );
    const candidates = Array.isArray(filtered) ? filtered.filter(isRecord) : [];
    const nodeName = nodeNames.get(parsedId.nodeId) ?? null;

    // A legacy id (`<nodeId>:legacy:<stackName>`) resolves by stack name; the
    // row predates the revision model, so it reports the not-applicable
    // projection rather than pretending to a state nobody derived.
    if (parsedId.applicationId.startsWith('legacy:')) {
      const legacyStack = parsedId.applicationId.slice('legacy:'.length);
      const match = candidates.find(row => row.stack_name === legacyStack);
      if (!match) {
        res.status(404).json({ error: 'Application not found' });
        return;
      }
      const response: GitOpsPortfolioDetailResponse = {
        schemaVersion: 1,
        generatedAt: Date.now(),
        application: rowFromProjection({
          id,
          projection: NOT_APPLICABLE_REVISION,
          name: legacyStack,
          stackName: legacyStack,
          blueprintId: null,
          nodeId: parsedId.nodeId,
          nodeName,
          lastActivityAt: typeof match.updated_at === 'number' ? match.updated_at : null,
          partialNodes: [],
          nodeNames,
        }),
        projection: NOT_APPLICABLE_REVISION,
      };
      res.json(response);
      return;
    }

    const match = candidates.find(
      row => isUsableRevision(row.gitopsRevision) && row.gitopsRevision.applicationId === parsedId.applicationId,
    );
    if (!match || !isUsableRevision(match.gitopsRevision)) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }
    const projection = match.gitopsRevision;
    const stackName = typeof match.stack_name === 'string' ? match.stack_name : null;
    const response: GitOpsPortfolioDetailResponse = {
      schemaVersion: 1,
      generatedAt: Date.now(),
      application: rowFromProjection({
        id,
        projection,
        name: projection.stackName ?? stackName ?? `application ${projection.applicationId}`,
        stackName: projection.stackName ?? stackName,
        blueprintId: projection.blueprintId,
        nodeId: parsedId.nodeId,
        nodeName,
        // Same freshness derivation the list uses, so one application never
        // reports different activity depending on which endpoint was asked.
        lastActivityAt: freshestFacetTimestamp(projection),
        partialNodes: [],
        nodeNames,
      }),
      projection,
    };
    res.json(response);
  } catch (error) {
    console.error('[GitOps portfolio] Detail error:', error);
    res.status(500).json({ error: 'Failed to fetch GitOps application' });
  }
});

/**
 * Record an operator source acceptance for the waiting candidate generation.
 *
 * The operator path for a manual source policy: the controller never accepts
 * on a policy's behalf when the policy says a human must look. The body echoes
 * the generation the caller reviewed; the transition refuses anything that is
 * no longer the current candidate, so a stale review cannot accept different
 * content than it named.
 */
gitopsApplicationsRouter.post('/:id/source/accept', (req: Request, res: Response): void => {
  if (!requirePermission(req, res, 'stack:create')) return;
  const target = resolveAuthorityTarget(req, res);
  if (!target) return;
  const generationId = typeof req.body?.generationId === 'string' ? req.body.generationId : '';
  if (generationId.length === 0) {
    res.status(400).json({ error: 'generationId is required', code: 'CONFIRM_REQUIRED' });
    return;
  }
  const actor = actorFromRequest(req);
  try {
    GitOpsTransitions.getInstance().sourceAccepted({
      applicationId: target.application.id,
      generationId,
      artifactSetId: newGitOpsId(),
      sourceAcceptanceId: newGitOpsId(),
      authority: 'operator',
      envelope: { operationId: newGitOpsId(), actor, trigger: 'manual', at: Date.now() },
    });
  } catch (error) {
    if (error instanceof GitOpsTransitionError) {
      res.status(409).json({ error: error.message, code: 'SOURCE_ACCEPTANCE_REFUSED' });
      return;
    }
    console.error('[GitOps authority] Source acceptance failed:', error);
    res.status(500).json({ error: 'Failed to accept the source revision' });
    return;
  }
  res.json({ ok: true });
});

/**
 * Record an operator placement approval for the current intent and candidate.
 *
 * The reviewed placement is the Blueprint's own plan, so the preview and its
 * fingerprint are the confirmation contract: the request echoes the plan it
 * reviewed, and the route recomputes it and refuses with a fresh preview when
 * anything moved. The frozen candidate set is validated against the reviewed
 * blast before the approval is written, so an approval that could never
 * resolve later is refused here instead.
 */
gitopsApplicationsRouter.post('/:id/placement/approve', async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'stack:create')) return;
  if (!requirePermission(req, res, 'stack:deploy')) return;
  const target = resolveAuthorityTarget(req, res);
  if (!target) return;

  const body = (req.body ?? {}) as { planFingerprint?: unknown; actions?: unknown };
  if (typeof body.planFingerprint !== 'string' || body.planFingerprint.length === 0) {
    res.status(400).json({ error: 'planFingerprint is required', code: 'CONFIRM_REQUIRED' });
    return;
  }
  const parsedActions = parseConfirmableActionsBody(body.actions);
  if (!parsedActions.ok) {
    res.status(400).json({ error: `Invalid actions: ${parsedActions.reason}`, code: 'CONFIRM_REQUIRED' });
    return;
  }

  if (!target.blueprint.enabled) {
    res.status(409).json({
      error: 'The Blueprint is disabled. Enable it before approving placement.',
      code: 'BLUEPRINT_DISABLED',
    });
    return;
  }

  const app = target.application;
  const store = GitOpsStore.getInstance();
  const intent = app.intent_revision_id ? store.getIntentRevision(app.intent_revision_id) : undefined;
  const candidate = app.rollout_candidate_id ? store.getRolloutCandidate(app.rollout_candidate_id) : undefined;
  if (!intent || !candidate) {
    res.status(409).json({
      error: 'This application has no current placement question to approve',
      code: 'PLACEMENT_REFUSED',
    });
    return;
  }

  let preview: BlueprintPreviewResult | null;
  try {
    preview = await buildBlueprintPreview(target.blueprint.id);
  } catch (error) {
    console.error('[GitOps authority] Placement preview failed:', error);
    res.status(500).json({ error: 'Failed to preview the placement' });
    return;
  }
  if (!preview) {
    res.status(404).json({ error: 'Application not found' });
    return;
  }
  if (preview.summary.blocker > 0) {
    res.status(409).json({ error: 'Plan has blockers', code: 'PLAN_BLOCKED', preview });
    return;
  }
  if (
    body.planFingerprint !== preview.planFingerprint
    || !confirmableActionsEqual(parsedActions.actions, preview.confirmableActions)
  ) {
    res.status(409).json({ error: 'Preview is stale; refresh and confirm again', code: 'PREVIEW_STALE', preview });
    return;
  }

  const blast = deriveBlastFromConfirmableActions(preview.confirmableActions);
  let frozenNodeIds: number[];
  try {
    frozenNodeIds = decodeGitOpsRequiredTargetsJson(candidate.required_targets_json).nodeIds;
  } catch (error) {
    console.error('[GitOps authority] Candidate frozen set is unreadable:', error);
    res.status(409).json({
      error: 'The frozen placement set could not be read; refresh the application and try again',
      code: 'PLACEMENT_REFUSED',
    });
    return;
  }
  if (!placementEffectCompatible(blast, frozenNodeIds)) {
    res.status(409).json({
      error: 'The reviewed plan no longer matches the frozen placement set; refresh and try again',
      code: 'PLACEMENT_REFUSED',
    });
    return;
  }

  const actor = actorFromRequest(req);
  try {
    GitOpsTransitions.getInstance().placementApproved({
      applicationId: app.id,
      approvalId: newGitOpsId(),
      intentRevisionId: intent.id,
      blastJson: encodeGitOpsApprovedTargetEffectJson(blast),
      requiredNodeIds: canonicalizeNodeIds(
        blast.filter(entry => entry.outcome === 'place').map(entry => entry.nodeId),
      ),
      fingerprint: preview.planFingerprint,
      actor,
      envelope: { operationId: newGitOpsId(), actor, trigger: 'manual', at: Date.now() },
      rolloutGenerationId: newGitOpsId(),
      candidateId: candidate.id,
      strategyJson: intent.rollout_strategy_json,
      provenance: 'placement_approval',
    });
  } catch (error) {
    if (error instanceof GitOpsTransitionError) {
      res.status(409).json({ error: error.message, code: 'PLACEMENT_REFUSED' });
      return;
    }
    console.error('[GitOps authority] Placement approval failed:', error);
    res.status(500).json({ error: 'Failed to record the placement approval' });
    return;
  }
  res.json({ ok: true });
});

/**
 * Authorize the current rollout and start the sequential rollout.
 *
 * The authorization evaluates registry preflight, records the operator
 * authority, and then dispatches the accepted generation through the shared
 * dispatch boundary, which is the one executor this model has today. A
 * dispatch refusal leaves the authorization standing and is reported as a
 * note, not as a failed request: the decision was recorded, the execution was
 * not.
 */
gitopsApplicationsRouter.post('/:id/rollout/authorize', async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'stack:deploy')) return;
  const target = resolveAuthorityTarget(req, res);
  if (!target) return;

  if (!target.blueprint.enabled) {
    res.status(409).json({
      error: 'The Blueprint is disabled. Enable it before authorizing the rollout.',
      code: 'BLUEPRINT_DISABLED',
    });
    return;
  }

  const app = target.application;
  const actor = actorFromRequest(req);
  let auth;
  try {
    auth = await ensureRolloutAuthorization(app.id, actor, 'manual', undefined, 'operator');
  } catch (error) {
    console.error('[GitOps authority] Rollout authorization failed:', error);
    res.status(500).json({ error: 'Failed to evaluate and record the rollout authorization' });
    return;
  }
  if (!auth.ok) {
    res.status(409).json({ error: auth.reason, code: 'ROLLOUT_AUTHORIZATION_REFUSED' });
    return;
  }

  const genRow = GitOpsStore.getInstance().getGeneration(auth.binding.acceptedGenerationId);
  if (!genRow) {
    res.status(409).json({
      error: 'The authorized generation could not be read; refresh the application and try again',
      code: 'ROLLOUT_AUTHORIZATION_REFUSED',
    });
    return;
  }

  let dispatched = false;
  let note: string | null = null;
  try {
    const result = await GitSourceService.getInstance().dispatchAcceptedGeneration(
      buildAcceptedGeneration(genRow),
      GitSourceService.dispatchContextFor(app),
      { trigger: 'manual', actor: actor ?? 'operator' },
    );
    dispatched = result.status === 'dispatched';
    if (result.status === 'blocked') note = result.reason;
  } catch (error) {
    console.error(
      '[GitOps authority] Rollout dispatch failed after authorization:',
      sanitizeForLog(error instanceof Error ? error.message : String(error)),
    );
    note = 'The rollout was authorized but could not start. Retry it from the Blueprint deployments surface.';
  }
  res.json({ ok: true, dispatched, note });
});
