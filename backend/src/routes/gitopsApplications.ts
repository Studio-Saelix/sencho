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
import { checkPermission, requirePermission, scopedActionsForStack } from '../middleware/permissions';
import { BlueprintReconciler } from '../services/BlueprintReconciler';
import { projectApplication } from '../services/gitops/derive';
import { latestTransitionByApplication } from '../services/gitops/history';
import { classifySourceRow, satisfiesGitOpsRead } from '../services/gitops/readAuth';
import { healthGateDisabled, NOT_APPLICABLE_REVISION, projectStackRevision, stackResourceSet } from '../helpers/gitopsResponse';
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
import { candidateRowFor, intentRowFor } from '../services/gitops/blueprintProducers';
import {
  resolveRollbackTargets,
  restoreTargetToGeneration,
  rollbackCandidatesForApplication,
  rolloutTargetSet,
  type RestoreTargetOutcome,
  type RolloutRollbackScope,
  type RolloutRollbackTargetResult,
} from '../services/gitops/rolloutRecovery';
import { placementEffectCompatible } from '../services/gitops/store';
import { GitOpsTransitions, GitOpsTransitionError } from '../services/gitops/transitions';
import { newGitOpsId } from '../services/gitops/directApplication';
import { HEALTH_ROLLOUT_POLICIES, isHealthRolloutPolicy } from '../services/gitops/healthPolicy';
import {
  buildAcceptedGeneration,
  ensureRolloutAuthorization,
  frozenStrategyFor,
} from '../services/gitops/handoff';
import { GitSourceService } from '../services/GitSourceService';
import { sanitizeForLog } from '../utils/safeLog';
import {
  aggregateGitOpsPortfolio,
  fetchRemoteSourceRows,
  freshestFacetTimestamp,
  isUsableRevision,
  POSTURE_RANK,
  rowFromProjection,
  probeableRemoteNodeIds,
  probeSilentNodeIds,
  withSilentNodes,
} from '../services/gitops/portfolioAggregator';
import { filterRemoteIdentityPayload, rewriteIdentityPayload } from '../proxy/gitopsIdentityProxy';
import { GitOpsStore } from '../services/gitops/store';
import { isRecord } from '../services/gitops/json';
import type {
  GitOpsPortfolioDetailResponse,
  GitOpsPortfolioFilters,
  GitOpsPortfolioResponse,
  GitOpsPortfolioRow,
  GitOpsPortfolioTargetSummary,
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
      stack: stringParam(query.stack),
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

function currentTargets(row: GitOpsPortfolioRow): GitOpsPortfolioTargetSummary[] {
  return row.targets.filter(target => target.tombstoned === false);
}

function matchesFilters(row: GitOpsPortfolioRow, filters: GitOpsPortfolioFilters): boolean {
  const targets = currentTargets(row);
  if (filters.attentionOnly && row.attention.length === 0) return false;
  if (filters.targetMode === 'direct' && row.targetMode !== 'direct') return false;
  if (filters.targetMode === 'blueprint' && row.targetMode !== 'blueprint' && row.targetMode !== 'inline_blueprint') return false;
  // Node involvement: a Direct application belongs to its owning node; a
  // Blueprint application belongs to every node its targets name, so filtering
  // by node never shrinks the fleet picture into per-node truth.
  if (filters.nodeId !== undefined) {
    const involved = row.nodeId === filters.nodeId
      || targets.some(target => target.nodeId === filters.nodeId);
    if (!involved) return false;
  }
  if (filters.blueprintId !== undefined && row.blueprintId !== filters.blueprintId) return false;
  // Exact, unlike `q`: a stack-scoped entry point must not also match `web2` for `web`.
  if (filters.stack !== undefined && row.stackName !== filters.stack) return false;
  if (filters.sourceStatus !== undefined && row.sourceStatus !== filters.sourceStatus) return false;
  if (filters.rolloutStatus !== undefined && row.rolloutStatus !== filters.rolloutStatus) return false;
  if (filters.healthStatus !== undefined && row.healthStatus !== filters.healthStatus) return false;
  if (filters.driftClass !== undefined && !row.drift.classes.includes(filters.driftClass)) return false;
  if (filters.evidence === 'unknown' && !row.evidence.unknown) return false;
  if (filters.evidence === 'stale'
    && !targets.some(target => target.evidence === 'stale')
    && !row.attention.includes('target_stale')) return false;
  if (filters.evidence === 'unreachable'
    && row.evidence.unreachableNodes.length === 0
    && !targets.some(target => target.connectivity === 'unreachable')) return false;
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
  const attentionByNode: Record<string, number> = {};
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
    if (row.attention.length > 0) {
      // Same involvement rule as the node filter, so a node's count matches
      // what the portfolio lists when filtered to that node.
      const involved = new Set(currentTargets(row).map(target => target.nodeId));
      if (row.nodeId !== null) involved.add(row.nodeId);
      for (const nodeId of involved) attentionByNode[nodeId] = (attentionByNode[nodeId] ?? 0) + 1;
    }
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
    attentionByNode,
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

/** Detail for a legacy id, local or remote: the row predates the revision model, so it reports the not-applicable projection. */
function legacyDetailResponse(
  id: string,
  stackName: string,
  nodeId: number,
  nodeNames: Map<number, string | null>,
  updatedAt: number | null,
): GitOpsPortfolioDetailResponse {
  return {
    schemaVersion: 1,
    generatedAt: Date.now(),
    application: rowFromProjection({
      id,
      projection: NOT_APPLICABLE_REVISION,
      name: stackName,
      stackName,
      blueprintId: null,
      nodeId,
      nodeName: nodeNames.get(nodeId) ?? null,
      lastActivityAt: updatedAt,
      partialNodes: [],
      nodeNames,
    }),
    projection: NOT_APPLICABLE_REVISION,
  };
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

/** One envelope per operator action, so every row it writes shares an operation. */
function authorityEnvelope(req: Request): { operationId: string; actor: string | null; trigger: string; at: number } {
  return { operationId: newGitOpsId(), actor: actorFromRequest(req), trigger: 'manual', at: Date.now() };
}

type AuthorityEnvelope = ReturnType<typeof authorityEnvelope>;

/** `null` when absent, `'invalid'` when present but unusable. */
function parseOptionalNodeId(raw: unknown): number | null | 'invalid' {
  if (raw === undefined) return null;
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 1 ? raw : 'invalid';
}

/**
 * The stack a Blueprint's targets run, from its current intent.
 *
 * Permissions and node-side lookups are both stack-scoped, and the deploy
 * stack name is frozen on the intent rather than copied onto the application.
 */
function deployStackNameFor(app: { intent_revision_id: string | null }): string | null {
  if (!app.intent_revision_id) return null;
  return GitOpsStore.getInstance().getIntentRevision(app.intent_revision_id)?.deploy_stack_name ?? null;
}

/** Exact deploy grant on one target's stack, checked before any target work starts. */
function requireDeployOnTarget(req: Request, res: Response, stackName: string, nodeId: number): boolean {
  if (checkPermission(req, 'stack:deploy', 'stack', stackName, nodeId)) return true;
  res.status(403).json({
    error: `Permission denied for the target on node ${nodeId}.`,
    code: 'PERMISSION_DENIED',
  });
  return false;
}

type ScopeParse = { ok: true; scope: RolloutRollbackScope } | { ok: false; message: string };

function parseRolloutScope(raw: unknown): ScopeParse {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: "scope must be { kind: 'target' | 'failed' | 'all_changed' }" };
  }
  const { kind, nodeId } = raw as { kind?: unknown; nodeId?: unknown };
  if (kind === 'target') {
    if (typeof nodeId !== 'number' || !Number.isSafeInteger(nodeId) || nodeId < 1) {
      return { ok: false, message: 'scope.nodeId must be a positive integer for a target rollback' };
    }
    return { ok: true, scope: { kind: 'target', nodeId } };
  }
  if (kind === 'failed' || kind === 'all_changed') return { ok: true, scope: { kind } };
  return { ok: false, message: "scope.kind must be 'target', 'failed', or 'all_changed'" };
}

function sameNodeSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort((x, y) => x - y);
  const right = [...b].sort((x, y) => x - y);
  return left.every((value, index) => value === right[index]);
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
      // A Blueprint target is projected hub-side, and its recorded observation
      // is a statement about the last time that node answered. Probing the
      // remote target nodes here is what keeps this panel in step with the
      // portfolio row: a node that has gone dark withdraws the settled claim in
      // both places instead of leaving the row and its own detail in
      // contradiction.
      //
      // Only nodes the portfolio also probes are asked, through the same shared
      // set, so the two surfaces cannot answer differently about the hub itself
      // or about a target whose node row is gone. The probe is bounded to this
      // application's remote targets and runs concurrently, so it costs one
      // round trip's worst case, bounded by the shared probe timeout, rather
      // than a fleet sweep.
      const rawProjection = projectApplication(application.id, healthGateDisabled());
      const probeable = probeableRemoteNodeIds();
      const silent = await probeSilentNodeIds(
        rawProjection.targets
          .filter(target => !target.tombstoned)
          .map(target => target.nodeId)
          .filter(nodeId => probeable.has(nodeId)),
      );
      const projection = withSilentNodes(rawProjection, silent);
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
        rollbackCandidates: application.target_mode === 'blueprint'
          ? rollbackCandidatesForApplication(application.id)
          : undefined,
        blueprintEnabled: blueprint?.enabled ?? null,
      };
      res.json(response);
      return;
    }

    const localNodeId = NodeRegistry.getInstance().getDefaultNodeId();
    if (parsedId.nodeId === localNodeId && parsedId.applicationId.startsWith('legacy:')) {
      // The hub's own legacy row: a Git source with no application behind it.
      // Same resolution and authorization as the list, and the same
      // not-applicable projection the remote legacy branch reports.
      const legacyStack = parsedId.applicationId.slice('legacy:'.length);
      const source = db.getGitSource(legacyStack);
      if (
        !source
        || projectStackRevision(legacyStack) !== NOT_APPLICABLE_REVISION
        || !satisfiesGitOpsRead(req, classifySourceRow({
          stackName: legacyStack,
          gitopsRevision: NOT_APPLICABLE_REVISION,
          stackResourcePresent: (await stackResourceSet(req.nodeId)).has(legacyStack),
        }))
      ) {
        res.status(404).json({ error: 'Application not found' });
        return;
      }
      res.json(legacyDetailResponse(id, legacyStack, localNodeId, nodeNames, source.updated_at));
      return;
    }

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
      res.json(legacyDetailResponse(
        id, legacyStack, parsedId.nodeId, nodeNames,
        typeof match.updated_at === 'number' ? match.updated_at : null,
      ));
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
      strategyJson: frozenStrategyFor(GitOpsStore.getInstance(), app, intent.id),
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
    note = 'The rollout was authorized but could not start; the authorization stands and the rollout remains queued.';
  }
  res.json({ ok: true, dispatched, note });
});

/**
 * Pause the rollout, application-wide or on one target.
 *
 * A pause is a statement about future execution, never about health: what was
 * deployed stays deployed, and the projection reports the rollout as paused
 * rather than converged. The reason is required because a paused rollout
 * outlives the session that paused it.
 */
gitopsApplicationsRouter.post('/:id/rollout/pause', (req: Request, res: Response): void => {
  const target = resolveAuthorityTarget(req, res);
  if (!target) return;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (reason.length === 0 || reason.length > 280) {
    res.status(400).json({ error: 'A pause reason of 1 to 280 characters is required', code: 'CONFIRM_REQUIRED' });
    return;
  }
  const nodeId = parseOptionalNodeId(req.body?.nodeId);
  if (nodeId === 'invalid') {
    res.status(400).json({ error: 'nodeId must be a positive integer' });
    return;
  }
  const stackName = deployStackNameFor(target.application);
  if (nodeId !== null) {
    // A single target's pause is an exact stack action; the caller may hold the
    // grant for that target without holding it fleet-wide.
    if (!stackName) {
      res.status(409).json({ error: 'The deploy stack identity could not be resolved', code: 'ROLLOUT_PAUSE_REFUSED' });
      return;
    }
    if (!requireDeployOnTarget(req, res, stackName, nodeId)) return;
  } else if (!requirePermission(req, res, 'stack:deploy')) {
    return;
  }
  if (!target.blueprint.enabled) {
    res.status(409).json({
      error: 'The Blueprint is disabled. Enable it before pausing the rollout.',
      code: 'BLUEPRINT_DISABLED',
    });
    return;
  }
  // A pause holds a rollout that exists. With no authorization and no partial
  // record there is nothing to hold, and recording a pause would only make the
  // surface read as held when it never had anything running.
  const hasRollout = !!target.application.rollout_authorization_ref
    || !!target.application.partial_json;
  if (!hasRollout) {
    res.status(409).json({
      error: 'There is no rollout to pause.',
      code: 'ROLLOUT_PAUSE_REFUSED',
    });
    return;
  }

  try {
    GitOpsTransitions.getInstance().rolloutPaused(
      target.application.id,
      nodeId,
      reason,
      authorityEnvelope(req),
    );
  } catch (error) {
    if (error instanceof GitOpsTransitionError) {
      res.status(409).json({ error: error.message, code: 'ROLLOUT_PAUSE_REFUSED' });
      return;
    }
    console.error(
      '[GitOps authority] Rollout pause failed:',
      sanitizeForLog(error instanceof Error ? error.message : String(error)),
    );
    res.status(500).json({ error: 'Failed to pause the rollout' });
    return;
  }
  res.json({ ok: true });
});

/**
 * Set the health-and-rollout policy for one application.
 *
 * The policy is per application, not a global setting, and it is written through
 * its own endpoint because the write has a side effect the generic settings
 * route cannot express: it changes what the next rollout is authorized to do.
 *
 * It authorizes a future action on every frozen target, so every target is
 * checked before anything is written. That is deliberately stricter than the
 * application-wide `stack:deploy` the other rollout-lifecycle writes take: those
 * act on the application as a whole, while this one names in advance what the
 * system may do to each node's stack, including restoring a previous
 * generation. A bulk action that half-applies on a permission failure would
 * leave some targets on a policy the operator is not entitled to set for them.
 */
gitopsApplicationsRouter.post('/:id/rollout/health-policy', async (req: Request, res: Response): Promise<void> => {
  const target = resolveAuthorityTarget(req, res);
  if (!target) return;
  const policy = req.body?.policy;
  if (!isHealthRolloutPolicy(policy)) {
    res.status(400).json({
      error: `policy must be one of: ${HEALTH_ROLLOUT_POLICIES.join(', ')}`,
      code: 'HEALTH_POLICY_REFUSED',
    });
    return;
  }

  const app = target.application;
  const store = GitOpsStore.getInstance();
  const stackName = deployStackNameFor(app);
  if (!stackName) {
    res.status(409).json({
      error: 'The deploy stack identity could not be resolved.',
      code: 'HEALTH_POLICY_REFUSED',
    });
    return;
  }
  // The application-wide grant first, then the exact per-target checks. The
  // application gate is not redundant: a target set can legitimately be empty
  // (nothing placed yet, or every target retired), and a loop over no targets
  // would authorize the write on its own absence. This write names in advance
  // what the system may do to each stack, so it needs both.
  if (!requirePermission(req, res, 'stack:deploy')) return;
  const frozen = rolloutTargetSet(app);
  const nodeIds = frozen?.nodeIds ?? store.listTargets(app.id)
    .filter((row) => row.target_status === 'active')
    .map((row) => row.node_id);
  for (const nodeId of nodeIds) {
    if (!requireDeployOnTarget(req, res, stackName, nodeId)) return;
  }

  try {
    GitOpsTransitions.getInstance().healthRolloutPolicySet({
      applicationId: app.id,
      policy,
      envelope: authorityEnvelope(req),
    });
  } catch (error) {
    if (error instanceof GitOpsTransitionError) {
      res.status(409).json({ error: error.message, code: 'HEALTH_POLICY_REFUSED' });
      return;
    }
    console.error(
      '[GitOps authority] Health rollout policy change failed:',
      sanitizeForLog(error instanceof Error ? error.message : String(error)),
    );
    res.status(500).json({ error: 'Failed to set the health rollout policy' });
    return;
  }
  res.json({ ok: true, policy });
});

/**
 * Resume a paused rollout and continue the queue when one is still authorized.
 *
 * Unpausing is the decision; continuing is the executor's answer. A resume
 * with no live authorization reports that nothing started rather than
 * minting authority the operator never granted.
 */
gitopsApplicationsRouter.post('/:id/rollout/resume', async (req: Request, res: Response): Promise<void> => {
  const target = resolveAuthorityTarget(req, res);
  if (!target) return;
  const nodeId = parseOptionalNodeId(req.body?.nodeId);
  if (nodeId === 'invalid') {
    res.status(400).json({ error: 'nodeId must be a positive integer' });
    return;
  }
  const stackName = deployStackNameFor(target.application);
  if (nodeId !== null) {
    if (!stackName) {
      res.status(409).json({ error: 'The deploy stack identity could not be resolved', code: 'ROLLOUT_RESUME_REFUSED' });
      return;
    }
    if (!requireDeployOnTarget(req, res, stackName, nodeId)) return;
  } else if (!requirePermission(req, res, 'stack:deploy')) {
    return;
  }
  if (!target.blueprint.enabled) {
    res.status(409).json({
      error: 'The Blueprint is disabled. Enable it before resuming the rollout.',
      code: 'BLUEPRINT_DISABLED',
    });
    return;
  }

  try {
    GitOpsTransitions.getInstance().rolloutUnpaused(target.application.id, nodeId, authorityEnvelope(req));
  } catch (error) {
    if (error instanceof GitOpsTransitionError) {
      res.status(409).json({ error: error.message, code: 'ROLLOUT_RESUME_REFUSED' });
      return;
    }
    console.error(
      '[GitOps authority] Rollout resume failed:',
      sanitizeForLog(error instanceof Error ? error.message : String(error)),
    );
    res.status(500).json({ error: 'Failed to resume the rollout' });
    return;
  }

  // Resuming continues the queue in both scopes: an application resume clears
  // the fleet hold, and a target resume clears that target's hold so the
  // dispatch below reaches it. Targets still individually paused are skipped
  // by the adapter.
  const store = GitOpsStore.getInstance();
  const app = store.getApplication(target.application.id) ?? target.application;
  const binding = store.currentAuthorizationBinding(app);
  if (!binding) {
    res.json({
      ok: true,
      dispatched: false,
      note: 'The rollout is resumed, but no live authorization exists; authorize the rollout to start it.',
    });
    return;
  }
  const genRow = store.getGeneration(binding.acceptedGenerationId);
  if (!genRow) {
    res.json({
      ok: true,
      dispatched: false,
      note: 'The authorized generation could not be read; refresh the application and authorize again.',
    });
    return;
  }

  const actor = actorFromRequest(req);
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
      '[GitOps authority] Rollout dispatch failed after resume:',
      sanitizeForLog(error instanceof Error ? error.message : String(error)),
    );
    note = 'The rollout is resumed but could not start; the authorization stands and the rollout remains queued.';
  }
  res.json({ ok: true, dispatched, note });
});

/**
 * Re-derive placement for the current Blueprint and open a fresh review.
 *
 * Replanning is an operator statement that the current placement question is
 * no longer the right one (a node was rebuilt, a cordon moved, a plan was
 * reviewed against stale intent). It mints intent and candidate through the
 * same producers an edit uses, which invalidates the old placement approval
 * and authorization. Nothing moved means nothing is written: re-opening a
 * review that already describes the Blueprint would invalidate approvals that
 * are still accurate.
 */
gitopsApplicationsRouter.post('/:id/rollout/replan', (req: Request, res: Response): void => {
  if (!requirePermission(req, res, 'stack:create')) return;
  const target = resolveAuthorityTarget(req, res);
  if (!target) return;
  const store = GitOpsStore.getInstance();
  const app = target.application;
  const candidate = app.rollout_candidate_id ? store.getRolloutCandidate(app.rollout_candidate_id) : undefined;
  if (!candidate) {
    res.status(409).json({
      error: 'There is no current placement to replan.',
      code: 'REPLAN_UNAVAILABLE',
    });
    return;
  }
  const intent = app.intent_revision_id ? store.getIntentRevision(app.intent_revision_id) : undefined;
  let frozenNodeIds: number[];
  try {
    frozenNodeIds = decodeGitOpsRequiredTargetsJson(candidate.required_targets_json).nodeIds;
  } catch (error) {
    console.error(
      '[GitOps authority] Rollout candidate frozen set is unreadable:',
      sanitizeForLog(error instanceof Error ? error.message : String(error)),
    );
    res.status(409).json({
      error: 'The current placement could not be read; refresh the application and try again.',
      code: 'REPLAN_UNAVAILABLE',
    });
    return;
  }
  const desiredNodeIds = BlueprintReconciler.getInstance()
    .listDesiredNodes(target.blueprint, DatabaseService.getInstance().getNodes())
    .map(node => node.id);
  const intentIsCurrent = !!intent
    && intent.blueprint_revision === target.blueprint.revision
    && intent.pinned_node_id === target.blueprint.pinned_node_id
    && intent.deploy_stack_name === target.blueprint.name
    && intent.selector_json === JSON.stringify(target.blueprint.selector);
  if (intentIsCurrent && sameNodeSet(desiredNodeIds, frozenNodeIds)) {
    res.status(409).json({
      error: 'The current placement already matches the Blueprint; there is nothing to replan.',
      code: 'REPLAN_UNAVAILABLE',
    });
    return;
  }

  const envelope = authorityEnvelope(req);
  try {
    DatabaseService.getInstance().getDb().transaction(() => {
      const tx = GitOpsTransitions.getInstance();
      const nextIntent = intentRowFor(app.id, target.blueprint, envelope.operationId, envelope.actor, envelope.at);
      tx.intentRevised({ applicationId: app.id, intent: nextIntent, envelope });
      tx.rolloutCandidateOpened({
        applicationId: app.id,
        candidate: candidateRowFor(
          app.id,
          nextIntent,
          desiredNodeIds,
          'roster_change',
          envelope.operationId,
          envelope.at,
        ),
        envelope,
      });
    })();
  } catch (error) {
    if (error instanceof GitOpsTransitionError) {
      res.status(409).json({ error: error.message, code: 'REPLAN_UNAVAILABLE' });
      return;
    }
    console.error(
      '[GitOps authority] Rollout replan failed:',
      sanitizeForLog(error instanceof Error ? error.message : String(error)),
    );
    res.status(500).json({ error: 'Failed to replan the rollout' });
    return;
  }
  res.json({ ok: true });
});

/**
 * Withdraw the live rollout authorization on the operator's decision.
 *
 * The abandoned generation stays visible as superseded, and the authorization
 * is cleared so the dispatch boundary cannot start it again. A later rollout
 * authorization mints a new generation over the same placement and accepted
 * source.
 */
gitopsApplicationsRouter.post('/:id/rollout/supersede', (req: Request, res: Response): void => {
  if (!requirePermission(req, res, 'stack:deploy')) return;
  const target = resolveAuthorityTarget(req, res);
  if (!target) return;
  if (!target.blueprint.enabled) {
    res.status(409).json({
      error: 'The Blueprint is disabled. Enable it before superseding the rollout.',
      code: 'BLUEPRINT_DISABLED',
    });
    return;
  }
  try {
    GitOpsTransitions.getInstance().rolloutSuperseded({
      applicationId: target.application.id,
      envelope: authorityEnvelope(req),
    });
  } catch (error) {
    if (error instanceof GitOpsTransitionError) {
      res.status(409).json({ error: error.message, code: 'ROLLOUT_SUPERSEDE_REFUSED' });
      return;
    }
    console.error(
      '[GitOps authority] Rollout supersede failed:',
      sanitizeForLog(error instanceof Error ? error.message : String(error)),
    );
    res.status(500).json({ error: 'Failed to supersede the rollout' });
    return;
  }
  res.json({ ok: true });
});

/**
 * Restore one target and record what happened, whatever path the restore took.
 *
 * Every exit attempts to record a terminal state for the target: a restore
 * that cannot be opened, cannot be requested, or cannot have its result
 * recorded is reported as a failed target rather than a clean restore. If the
 * terminal write itself fails it is logged; the boot-time reclassification
 * settles a row left in `restoring`.
 */
async function runRollbackTarget(
  ctx: {
    app: GitOpsApplicationRow;
    stackName: string;
    generationId: string;
    recoveryRef: string;
    envelope: AuthorityEnvelope;
    actor: string | null;
    role: string;
    userId: number;
  },
  nodeId: number,
): Promise<RolloutRollbackTargetResult> {
  const tx = GitOpsTransitions.getInstance();
  try {
    tx.rollbackInProgress({
      applicationId: ctx.app.id,
      nodeId,
      recoveryRef: ctx.recoveryRef,
      recoveryGenerationId: ctx.generationId,
      envelope: ctx.envelope,
    });
  } catch (error) {
    return {
      nodeId,
      status: 'failed',
      error: error instanceof Error ? error.message : 'The rollback could not be opened.',
    };
  }

  let outcome: RestoreTargetOutcome;
  try {
    outcome = await restoreTargetToGeneration({
      app: ctx.app,
      stackName: ctx.stackName,
      nodeId,
      generationId: ctx.generationId,
      actor: ctx.actor,
      role: ctx.role,
      scopedActions: scopedActionsForStack(ctx.userId, nodeId, ctx.stackName),
    });
  } catch (error) {
    console.error(
      '[GitOps authority] Rollout restore request failed on node %s:',
      sanitizeForLog(nodeId),
      sanitizeForLog(error instanceof Error ? error.message : String(error)),
    );
    outcome = { ok: false, code: 'ROLLBACK_FAILED', error: 'The restore request failed.' };
  }

  if (outcome.ok) {
    const store = GitOpsStore.getInstance();
    try {
      tx.rollbackCompleted({
        applicationId: ctx.app.id,
        nodeId,
        recoveryRef: ctx.recoveryRef,
        recoveryGenerationId: ctx.generationId,
        // The strongest evidence recorded for the restored generation. The
        // node's own capture is not read here; restoreArtifactPointers drops
        // anything this generation does not own and records the limitation.
        capturedArtifactSetId: store.newestArtifactSetIdForGeneration(ctx.generationId),
        capturedSourceAcceptanceRef: store.newestSourceAcceptanceId(ctx.app.id, ctx.generationId),
        envelope: ctx.envelope,
      });
      return { nodeId, status: 'restored' };
    } catch (error) {
      console.error(
        '[GitOps authority] Restore succeeded but its completion could not be recorded:',
        sanitizeForLog(error instanceof Error ? error.message : String(error)),
      );
      outcome = { ok: false, code: 'RECORD_FAILED', error: 'The restore completed but its result could not be recorded.' };
    }
  }

  console.error(
    '[GitOps authority] Rollout rollback failed on node %s:',
    sanitizeForLog(nodeId),
    sanitizeForLog(outcome.error),
  );
  try {
    tx.rollbackPartialFailed({
      applicationId: ctx.app.id,
      nodeId,
      recoveryRef: ctx.recoveryRef,
      failureClass: 'partial',
      envelope: ctx.envelope,
    });
  } catch (error) {
    console.error(
      '[GitOps authority] Could not record the failed rollback target:',
      sanitizeForLog(error instanceof Error ? error.message : String(error)),
    );
  }
  return { nodeId, status: 'failed', error: outcome.error };
}

/**
 * Roll a rollout back to an explicit prior application generation.
 *
 * The scope names which targets recover: one target, the targets recorded as
 * failed or unreachable, or every changed target in the frozen set. Each
 * target is restored from its own captured recovery point, and that point must
 * name the selected generation, so a rollback that cannot prove what it
 * restored reports a partial failure instead of a completion. Configuration is
 * restored; application data is untouched, and the restored generation's
 * artifact expectation is rebound only from evidence that generation owns.
 */
gitopsApplicationsRouter.post('/:id/rollout/rollback', async (req: Request, res: Response): Promise<void> => {
  // Fleet-wide on purpose: a rollback withdraws the application's rollout
  // authorization, which is broader than any one target. The per-target
  // checks below then pin the exact stack and node of every restore.
  if (!requirePermission(req, res, 'stack:deploy')) return;
  const target = resolveAuthorityTarget(req, res);
  if (!target) return;
  const body = (req.body ?? {}) as { generationId?: unknown; scope?: unknown };
  const generationId = typeof body.generationId === 'string' ? body.generationId : '';
  if (generationId.length === 0) {
    res.status(400).json({ error: 'generationId is required', code: 'CONFIRM_REQUIRED' });
    return;
  }
  const parsedScope = parseRolloutScope(body.scope);
  if (!parsedScope.ok) {
    res.status(400).json({ error: parsedScope.message, code: 'CONFIRM_REQUIRED' });
    return;
  }
  if (!target.blueprint.enabled) {
    res.status(409).json({
      error: 'The Blueprint is disabled. Enable it before rolling back a rollout.',
      code: 'BLUEPRINT_DISABLED',
    });
    return;
  }

  const app = target.application;
  const store = GitOpsStore.getInstance();
  const generation = store.getGeneration(generationId);
  if (!generation || generation.application_id !== app.id) {
    res.status(409).json({
      error: 'The selected application generation is not part of this application.',
      code: 'ROLLBACK_REFUSED',
    });
    return;
  }
  const stackName = deployStackNameFor(app);
  if (!stackName) {
    res.status(409).json({
      error: 'The deploy stack identity could not be resolved.',
      code: 'ROLLBACK_REFUSED',
    });
    return;
  }
  const resolved = resolveRollbackTargets(app, parsedScope.scope, generationId);
  if (!resolved.ok) {
    res.status(409).json({ error: resolved.error, code: resolved.code });
    return;
  }
  // Exact authorization on every resolved target, before any restore starts:
  // the application spans nodes, so a fleet-wide grant is not what this action
  // needs, and a bulk action that half-runs on a permission failure would
  // leave a partial recovery nobody asked for.
  for (const nodeId of resolved.nodeIds) {
    if (!requireDeployOnTarget(req, res, stackName, nodeId)) return;
  }

  // The abandoned rollout must not be dispatchable while its targets are being
  // restored. Only an authorized rollout has a dispatch to stop; a placement
  // generation that never authorized cannot be superseded and does not need to
  // be.
  const liveRolloutGeneration = app.rollout_generation_id
    ? store.getRolloutGeneration(app.rollout_generation_id)
    : undefined;
  if (app.rollout_generation_id && !liveRolloutGeneration) {
    res.status(409).json({
      error: 'The current rollout generation could not be read; refresh the application and try again.',
      code: 'ROLLBACK_REFUSED',
    });
    return;
  }
  const envelope = authorityEnvelope(req);
  if (liveRolloutGeneration?.provenance === 'rollout_authorization') {
    try {
      GitOpsTransitions.getInstance().rolloutSuperseded({ applicationId: app.id, envelope });
    } catch (error) {
      console.error(
        '[GitOps authority] Could not withdraw the rollout before rolling back:',
        sanitizeForLog(error instanceof Error ? error.message : String(error)),
      );
      res.status(409).json({
        error: 'The live rollout authorization could not be withdrawn; refresh the application and try again.',
        code: 'ROLLBACK_REFUSED',
      });
      return;
    }
  }

  const ctx = {
    app,
    stackName,
    generationId,
    recoveryRef: newGitOpsId(),
    envelope,
    actor: actorFromRequest(req),
    role: req.user?.role ?? 'viewer',
    userId: req.user?.userId ?? 0,
  };
  const results: RolloutRollbackTargetResult[] = [];
  for (const nodeId of resolved.nodeIds) {
    results.push(await runRollbackTarget(ctx, nodeId));
  }

  const failedAny = results.some(result => result.status === 'failed');
  if (failedAny) {
    // Lift the application out of `restoring` so the projection reports the
    // partial failure rather than an in-flight rollback that nothing drives.
    try {
      GitOpsTransitions.getInstance().rollbackPartialFailed({
        applicationId: app.id,
        nodeId: null,
        recoveryRef: ctx.recoveryRef,
        failureClass: 'partial',
        envelope,
      });
    } catch (error) {
      console.error(
        '[GitOps authority] Could not record the partial rollback failure:',
        sanitizeForLog(error instanceof Error ? error.message : String(error)),
      );
    }
  }
  res.json({ ok: !failedAny, results });
});
