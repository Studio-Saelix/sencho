/**
 * Hub-owned aggregate read model for the GitOps portfolio workplace
 * (`GET /api/gitops/applications`).
 *
 * Two invariants define this module:
 *
 * 1. No browser-side fan-out. The hub collects every contributing node's rows
 *    here, with a fleet-style bounded probe per remote (reachable/unreachable is
 *    reported as coverage, never as a silent omission), so the page is one
 *    bounded response regardless of fleet size.
 * 2. No private truth. Every row is built from the canonical projection
 *    (`projectApplication`, or the projection a remote instance already
 *    attached to its `GET /api/git-sources` rows through the identity proxy
 *    contract), attention comes from `attention.ts`, and read authorization
 *    reuses `readAuth.ts` per row, fail-closed. Keys never carry credentials.
 */

import type { Request } from 'express';
import { DatabaseService } from '../DatabaseService';
import { NodeRegistry } from '../NodeRegistry';
import { checkPermission } from '../../middleware/permissions';
import { safeRemoteFetch } from '../../utils/outboundTarget';
import { NOT_APPLICABLE_REVISION, projectStackRevision, stackResourceSet, healthGateDisabled } from '../../helpers/gitopsResponse';
import { filterRemoteIdentityPayload, rewriteIdentityPayload } from '../../proxy/gitopsIdentityProxy';
import { projectApplication } from './derive';
import { latestTransitionByApplication } from './history';
import { classifySourceRow, satisfiesGitOpsRead } from './readAuth';
import { GitOpsStore } from './store';
import { attentionReasons, hasFailureReason } from './attention';
import { FACET_EVIDENCE_SOURCE } from './types';
import type {
  GitOpsPortfolioNodeCoverage,
  GitOpsPortfolioPosture,
  GitOpsPortfolioRepository,
  GitOpsPortfolioRow,
  GitOpsPortfolioTargetSummary,
} from './portfolioTypes';
import type { FutureRolloutAuthorizationBinding, GitOpsRevisionProjection } from './types';
import { isRecord } from './json';

/** Per-remote probe budget; mirrors the fleet overview probe so one dead node cannot stall the portfolio. */
const REMOTE_PROBE_TIMEOUT_MS = 3000;

/** Merge bound across all contributors. Beyond this the response reports `truncated`. */
export const PORTFOLIO_MERGE_CAP = 1000;

/** Triage order of postures, most urgent first. Shared by the merge cap and the attention sort. */
export const POSTURE_RANK: Readonly<Record<GitOpsPortfolioPosture, number>> = {
  failed: 0,
  attention: 1,
  in_progress: 2,
  unknown: 3,
  converged_qualified: 4,
  converged: 5,
};

/** Runtime facet statuses grouped from worst to best, for the row's worst-target summary. */
const RUNTIME_SEVERITY: readonly string[] = [
  'failed_after_mutation',
  'failed_previous_workload_intact',
  'recovery_failed',
  'recovery_required',
  'drifted',
  'health_drift',
  'runtime_artifact_drift',
  'rollout_artifact_drift',
  'disk_invocation_drift',
  'completion_unknown',
  'acknowledged_completion_unknown',
  'stale_acknowledgement',
  'partially_rolled_out',
  'paused',
  'retry_scheduled',
  'pending_state_review',
  'evict_blocked',
  'deploying',
  'withdrawing',
  'correcting',
  'health_checking',
  'fully_deployed_health_pending',
  'artifact_verification_pending',
  'applied_not_deployed',
  'never_applied',
  'synced_and_healthy',
  'tombstoned',
];

const RUNTIME_RANK: ReadonlyMap<string, number> = new Map(RUNTIME_SEVERITY.map((status, index) => [status, index]));

const HEALTH_SEVERITY: readonly string[] = ['failed', 'unknown', 'pending', 'checking', 'passed', 'unbound', 'not_applicable'];
const HEALTH_RANK: ReadonlyMap<string, number> = new Map(HEALTH_SEVERITY.map((status, index) => [status, index]));

const OBSERVED_ARTIFACT_KINDS: ReadonlySet<string> = new Set([
  'unknown',
  'missing',
  'unavailable',
  'exact',
  'qualified',
  'stale',
  'local_build_unverified',
]);

const GENERATION_BOUND_ROLLOUT_STATES: ReadonlySet<string> = new Set([
  'rollout_queued',
  'canary_in_progress',
  'batch_in_progress',
  'fully_deployed_health_pending',
  'configuration_converged_artifact_qualified',
  'exactly_converged_healthy',
  'rollout_superseded',
]);

/**
 * The one qualification each artifact status may carry, keyed by that status.
 * Its value domain is exactly `ARTIFACT_QUALIFICATIONS`, so the vocabulary is
 * written once: a status missing here carries no pairing requirement.
 */
const STATUS_QUALIFICATION: Readonly<Record<string, string>> = {
  artifact_exact: 'exact',
  artifact_qualified: 'qualified',
  artifact_stale: 'stale',
  artifact_unavailable: 'unavailable',
  artifact_local_build_unverified: 'local_build_unverified',
  artifact_resolution_pending: 'unresolved',
};

const ARTIFACT_QUALIFICATIONS: ReadonlySet<string> = new Set([
  'unresolved',
  'exact',
  'qualified',
  'stale',
  'unavailable',
  'local_build_unverified',
]);

const PREFLIGHT_FINGERPRINT_RE = /^[0-9a-f]{64}$/;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNullablePositiveInteger(value: unknown): boolean {
  return value === null || isPositiveInteger(value);
}

function isLkgUnavailableReason(value: unknown): boolean {
  return value === null || value === 'generation_missing' || value === 'recovery_unretainable';
}

/**
 * A status this build does not know ranks among the bad-but-not-failed band:
 * below every recognized in-flight status and above the settled ones, so an
 * unknown state sorts as "needs a look" rather than masquerading as either a
 * proven convergence or a proven failure. It still flags unknown evidence
 * wherever it appears.
 */
function rankUnknownAware(rank: ReadonlyMap<string, number>, status: string, unknownRank: number): number {
  return rank.get(status) ?? unknownRank;
}

const UNKNOWN_RUNTIME_RANK = 17; // at the in-flight boundary, tied with `deploying`
const UNKNOWN_HEALTH_RANK = 1; // at `unknown`'s rank: unproven, not failed

function worstRuntimeStatus(projection: GitOpsRevisionProjection): string {
  if (projection.targetMode === 'not_applicable' || projection.targets.length === 0) return 'not_applicable';
  let worst: string | null = null;
  let worstRank = Number.POSITIVE_INFINITY;
  for (const target of liveTargetsOf(projection)) {
    const status = target.runtime.status;
    const rank = rankUnknownAware(RUNTIME_RANK, status, UNKNOWN_RUNTIME_RANK);
    if (rank < worstRank) {
      worst = status;
      worstRank = rank;
    }
  }
  return worst ?? 'not_applicable';
}

function worstHealthStatus(projection: GitOpsRevisionProjection): string {
  if (projection.targetMode === 'not_applicable' || projection.targets.length === 0) return 'not_applicable';
  let worst: string | null = null;
  let worstRank = Number.POSITIVE_INFINITY;
  for (const target of liveTargetsOf(projection)) {
    const status = target.health.status;
    const rank = rankUnknownAware(HEALTH_RANK, status, UNKNOWN_HEALTH_RANK);
    if (rank < worstRank) {
      worst = status;
      worstRank = rank;
    }
  }
  return worst ?? 'not_applicable';
}

/**
 * Whether every artifact qualification this facet carries is vocabulary this
 * build knows. A newer node's qualification is accepted structurally, but it
 * is reported as unknown evidence rather than read as a convergence claim.
 */
function hasKnownArtifactVocabulary(artifact: { status: string } & Record<string, unknown>): boolean {
  if ('qualification' in artifact && !ARTIFACT_QUALIFICATIONS.has(String(artifact.qualification))) return false;
  const expected = artifact.expected;
  if (isRecord(expected) && !ARTIFACT_QUALIFICATIONS.has(String(expected.qualification))) return false;
  const latest = artifact.latestEvidence;
  if (isRecord(latest) && !ARTIFACT_QUALIFICATIONS.has(String(latest.qualification))) return false;
  return true;
}

/**
 * Whether the projection carries any status this build has never heard of.
 *
 * Checks the four top-level facets against the canonical status registry
 * (`FACET_EVIDENCE_SOURCE`, which is total over the closed unions) plus the
 * per-target runtime/health/connectivity statuses, so a newer node answering
 * an older hub is reported as unknown evidence rather than silently
 * reinterpreted (or, worse, read as a convergence claim).
 */
function hasUnrecognizedStatus(projection: GitOpsRevisionProjection): boolean {
  if (projection.targetMode === 'not_applicable') return false;
  const { source, artifact, placement, rollout } = projection.facets;
  if (!Object.hasOwn(FACET_EVIDENCE_SOURCE.source, source.status)) return true;
  if (!Object.hasOwn(FACET_EVIDENCE_SOURCE.artifact, artifact.status)) return true;
  if (!hasKnownArtifactVocabulary(artifact)) return true;
  if (!Object.hasOwn(FACET_EVIDENCE_SOURCE.placement, placement.status)) return true;
  if (!Object.hasOwn(FACET_EVIDENCE_SOURCE.rollout, rollout.status)) return true;
  for (const target of liveTargetsOf(projection)) {
    if (!RUNTIME_RANK.has(target.runtime.status)) return true;
    if (!HEALTH_RANK.has(target.health.status)) return true;
    if (!Object.hasOwn(FACET_EVIDENCE_SOURCE.artifact, target.artifact.status)) return true;
    if (!hasKnownArtifactVocabulary(target.artifact)) return true;
    if (!Object.hasOwn(FACET_EVIDENCE_SOURCE.lkg, target.lkg.status)) return true;
    if (!OBSERVED_ARTIFACT_KINDS.has(target.observedArtifactIdentity.kind)) return true;
    if (target.connectivity !== 'reachable' && target.connectivity !== 'unreachable' && target.connectivity !== 'stale' && target.connectivity !== 'unknown') return true;
  }
  return false;
}

/**
 * Posture of one application.
 *
 * Read top to bottom: the first matching rule wins, and the rules are ordered
 * so failures outrank pending decisions, which outrank work in flight, which
 * outranks a provable converged state. What remains is `unknown`: the model
 * cannot currently prove anything about this application, and the portfolio
 * says so rather than inferring health from silence.
 */
export function postureOf(projection: GitOpsRevisionProjection): GitOpsPortfolioPosture {
  if (projection.targetMode === 'not_applicable') return 'unknown';
  const attention = attentionReasons(projection);
  if (hasFailureReason(attention)) return 'failed';
  if (attention.length > 0) return 'attention';

  const { source, placement, rollout } = projection.facets;
  const evidenceUnknown = hasUnrecognizedStatus(projection);
  const inFlight =
    source.status === 'checking_fetching'
    || source.status === 'applying'
    || source.status === 'candidate_ready'
    || placement.status === 'source_acceptance_pending'
    || rollout.status === 'rollout_queued'
    || rollout.status === 'canary_in_progress'
    || rollout.status === 'batch_in_progress'
    || rollout.status === 'fully_deployed_health_pending'
    || liveTargetsOf(projection).some(target => (
      target.runtime.status === 'deploying'
      || target.runtime.status === 'withdrawing'
      || target.runtime.status === 'correcting'
      || target.runtime.status === 'health_checking'
      || target.runtime.status === 'fully_deployed_health_pending'
      || target.runtime.status === 'artifact_verification_pending'
      || target.health.status === 'pending'
      || target.health.status === 'checking'));
  if (inFlight) return 'in_progress';

  const artifact = projection.facets.artifact;
  const latestEvidence = 'latestEvidence' in artifact ? artifact.latestEvidence : null;
  const artifactIdentity = latestEvidence?.identity ?? null;
  const artifactSetId = 'artifactSetId' in artifact && typeof artifact.artifactSetId === 'string'
    ? artifact.artifactSetId
    : null;
  const artifactGenerationId = 'generationId' in artifact && typeof artifact.generationId === 'string'
    ? artifact.generationId
    : null;
  const acceptedGenerationId = source.status === 'not_applicable' ? null : source.acceptedGenerationId;
  const liveTargets = liveTargetsOf(projection);
  const targetEvidenceMatches = projection.lifecycleStatus === 'active'
    && isNonEmptyString(acceptedGenerationId)
    && isNonEmptyString(artifactIdentity)
    && isNonEmptyString(artifactSetId)
    && isNonEmptyString(artifactGenerationId)
    && artifactGenerationId === acceptedGenerationId
    && liveTargets.length > 0
    && (projection.targetMode !== 'direct' || liveTargets.length === 1)
    && liveTargets.every(target => target.connectivity === 'reachable'
      && target.runtime.status === 'synced_and_healthy'
      && ((target.health.status === 'passed' && target.healthyGenerationId === acceptedGenerationId)
        || target.health.status === 'not_applicable')
      && isNonEmptyString(target.desiredGenerationId)
      && isNonEmptyString(target.appliedGenerationId)
      && isNonEmptyString(target.deployedGenerationId)
      && target.desiredGenerationId === acceptedGenerationId
      && target.appliedGenerationId === acceptedGenerationId
      && target.deployedGenerationId === acceptedGenerationId
      && target.expectedArtifactSetId === artifactSetId
      && target.latestArtifactSetId === artifactSetId
      && target.artifact.status === artifact.status
      && 'artifactSetId' in target.artifact
      && target.artifact.artifactSetId === artifactSetId
      && 'generationId' in target.artifact
      && target.artifact.generationId === acceptedGenerationId
      && (target.observedArtifactIdentity.kind === 'exact' || target.observedArtifactIdentity.kind === 'qualified')
      && isNonEmptyString(target.observedArtifactIdentity.identity));
  const rolloutFacetGenerationMatches = (rollout.status === 'exactly_converged_healthy' || rollout.status === 'configuration_converged_artifact_qualified')
    && rollout.rolloutGenerationId === projection.rolloutGenerationId;
  // Convergence is claimed only for a Blueprint application: a Direct
  // application is proven by the target evidence rule below, and an Inline
  // Blueprint has no rollout facet of its own to prove anything with. A blank
  // rollout generation is no identity, so it cannot satisfy the generation
  // agreement either.
  const rolloutTargetsKnown = targetEvidenceMatches
    && projection.targetMode === 'blueprint'
    && isNonEmptyString(projection.rolloutGenerationId)
    && rolloutFacetGenerationMatches
    && liveTargets.every(target => target.connectivity === 'reachable'
      && target.rolloutGenerationId === projection.rolloutGenerationId
      && target.runtime.status === 'synced_and_healthy'
      && (target.health.status === 'passed' || target.health.status === 'not_applicable' || target.health.status === 'unbound'));
  if (!evidenceUnknown && rolloutTargetsKnown) {
    if (rollout.status === 'exactly_converged_healthy' && artifact.status === 'artifact_exact') return 'converged';
    if (rollout.status === 'configuration_converged_artifact_qualified' && artifact.status === 'artifact_qualified') return 'converged_qualified';
  }

  // Direct applications have no rollout facet; their convergence claim is the
  // source settled on an accepted generation, every target reporting its
  // running state in agreement with it, and no drift evidence anywhere. The
  // artifact facet must be a status this build knows before either claim is
  // made: an unknown qualification could be anything, and calling it exact or
  // qualified would assert proof nobody has.
  // The registry check is already folded into `evidenceUnknown`, so a facet
  // this build does not know cannot reach either claim below.
  if (
    projection.targetMode === 'direct'
    && artifact.status !== 'not_applicable'
    && targetEvidenceMatches
    && !evidenceUnknown
    && (source.status === 'application_generation_accepted' || source.status === 'source_poll_scheduled')
    && projection.drift.length === 0
  ) {
    if (artifact.status === 'artifact_exact') return 'converged';
    if (artifact.status === 'artifact_qualified') return 'converged_qualified';
  }

  return 'unknown';
}

/** Repository identity, secret-free. Only present when the projection carries source identity. */
function repositoryOf(projection: GitOpsRevisionProjection): GitOpsPortfolioRepository | null {
  if (projection.targetMode === 'not_applicable') return null;
  const source = projection.facets.source;
  if (source.status === 'not_applicable') return null;
  return {
    configuredRepoUrl: source.configuredRepoUrl,
    host: source.repoIdentity.host,
    pathname: source.repoIdentity.pathname,
    configuredRef: source.configuredRef,
  };
}

function targetSummaries(projection: GitOpsRevisionProjection, nodeNames: Map<number, string | null>): GitOpsPortfolioTargetSummary[] {
  if (projection.targetMode === 'not_applicable') return [];
  return liveTargetsOf(projection).map(target => ({
    nodeId: target.nodeId,
    nodeName: nodeNames.get(target.nodeId) ?? null,
    stackName: target.stackName,
    runtime: target.runtime.status,
    health: target.health.status,
    connectivity: target.connectivity,
    // Unknown connectivity is its own evidence grade: it means the evidence
    // never arrived, which is not the same as evidence that arrived fresh.
    evidence: target.connectivity === 'reachable'
      ? 'fresh'
      : target.connectivity === 'stale' ? 'stale' : 'unknown',
  }));
}

/** The freshest evidence timestamp on a projection's facet fields, for remote rows with no local history. */
export function freshestFacetTimestamp(projection: GitOpsRevisionProjection): number | null {
  if (projection.targetMode === 'not_applicable') return null;
  let latest: number | null = null;
  const consider = (value: number | null | undefined): void => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (latest === null || value > latest) latest = value;
    }
  };
  const source = projection.facets.source;
  if (source.status === 'source_failed') consider(source.failureAt);
  if (source.status === 'source_retry_scheduled') consider(source.retryAt);
  if (source.status === 'source_poll_scheduled') consider(source.nextPollAt);
  if (source.status === 'source_suspended') consider(source.suspendedAt);
  if (source.status === 'source_unknown') consider(source.interruptedAt);
  for (const target of liveTargetsOf(projection)) consider(target.lkgUnavailableAt);
  return latest;
}

function finiteTimestamp(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

type RowInput = {
  id: string;
  projection: GitOpsRevisionProjection;
  name: string;
  stackName: string | null;
  blueprintId: number | null;
  nodeId: number | null;
  nodeName: string | null;
  lastActivityAt: number | null;
  partialNodes: number[];
  nodeNames: Map<number, string | null>;
};

/** Build one row from a canonical projection and the caller's context. */
export function rowFromProjection(input: RowInput): GitOpsPortfolioRow {
  const { id, projection, name, stackName, blueprintId, nodeId, nodeName, lastActivityAt, partialNodes, nodeNames } = input;
  if (projection.targetMode === 'not_applicable') {
    return {
      id,
      targetMode: 'direct',
      name,
      stackName,
      blueprintId,
      nodeId,
      nodeName,
      repository: null,
      desiredCommitSha: null,
      fetchedCommitSha: null,
      candidateGenerationId: null,
      acceptedGenerationId: null,
      sourceStatus: 'not_applicable',
      artifactStatus: 'not_applicable',
      artifactQualification: null,
      placementStatus: 'not_applicable',
      rolloutStatus: 'not_applicable',
      runtimeStatus: 'not_applicable',
      healthStatus: 'not_applicable',
      targets: [],
      drift: { count: 0, classes: [] },
      attention: [],
      posture: 'unknown',
      availableActions: [],
      limitations: projection.limitations.map(limitation => limitation.code),
      lastActivityAt,
      evidence: { partial: partialNodes.length > 0, unreachableNodes: partialNodes, unknown: true },
    };
  }
  const source = projection.facets.source;
  const artifact = projection.facets.artifact;
  const driftClasses = [...new Set(projection.drift.map(item => item.class))];
  // Unreachable targets are named per row, from the projection itself: a
  // target whose evidence never arrived is the row-level fact the evidence
  // filter and the UI's "unreachable" qualifier read, independent of which
  // node (if any) failed to answer the aggregate.
  const unreachableNodes = [...new Set([
    ...partialNodes,
    ...projection.targets.filter(target => !target.tombstoned && target.connectivity === 'unreachable').map(target => target.nodeId),
  ])];
  const unknownEvidence = hasUnrecognizedStatus(projection)
    || liveTargetsOf(projection).some(target => target.connectivity === 'unknown');
  return {
    id,
    targetMode: projection.targetMode,
    name,
    stackName: projection.stackName ?? stackName,
    blueprintId: projection.blueprintId ?? blueprintId,
    nodeId,
    nodeName,
    repository: repositoryOf(projection),
    desiredCommitSha: source.status === 'not_applicable' ? null : source.desiredCommitSha,
    fetchedCommitSha: source.status === 'not_applicable' ? null : source.fetchedCommitSha,
    candidateGenerationId: source.status === 'not_applicable' ? null : source.candidateGenerationId,
    acceptedGenerationId: source.status === 'not_applicable' ? null : source.acceptedGenerationId,
    sourceStatus: source.status,
    artifactStatus: artifact.status,
    artifactQualification: artifact.status === 'not_applicable' ? null
      : artifact.status.replace(/^artifact_/, ''),
    placementStatus: projection.facets.placement.status,
    rolloutStatus: projection.facets.rollout.status,
    runtimeStatus: worstRuntimeStatus(projection),
    healthStatus: worstHealthStatus(projection),
    targets: targetSummaries(projection, nodeNames),
    drift: { count: projection.drift.length, classes: driftClasses },
    attention: attentionReasons(projection),
    posture: postureOf(projection),
    availableActions: projection.availableActions,
    limitations: projection.limitations.map(limitation => limitation.code),
    lastActivityAt,
    evidence: {
      partial: unreachableNodes.length > 0 || unknownEvidence,
      unreachableNodes,
      unknown: unknownEvidence,
    },
  };
}

/**
 * Aggregate the portfolio rows this request may read.
 *
 * Direct applications live on the node that owns the stack; Blueprint
 * applications are hub-owned. Remote Direct rows are fetched from each remote's
 * own `/api/git-sources`, identity-rewritten into hub node numbering by the
 * share proxy helpers, and re-authorized against this request's user (the
 * remote authorized for the machine credential, not the person). An
 * unreachable node contributes a coverage entry, not silence: the portfolio
 * keeps calling the portfolio "what we could reach", and the row set never
 * claims completeness it does not have.
 */
export type AggregateOptions = {
  /**
   * Remote probe seam. Tests inject this so no test needs a listening remote
   * node; production callers use the default (`fetchRemoteSourceRows`).
   */
  fetchRows?: (nodeId: number) => Promise<unknown[] | null | 'unsupported'>;
};

export async function aggregateGitOpsPortfolio(req: Request, options: AggregateOptions = {}): Promise<{
  rows: GitOpsPortfolioRow[];
  coverage: GitOpsPortfolioNodeCoverage[];
  truncated: boolean;
}> {
  const fetchRows = options.fetchRows ?? fetchRemoteSourceRows;
  const db = DatabaseService.getInstance();
  const store = GitOpsStore.getInstance();
  const nodes = db.getNodes();
  const registry = NodeRegistry.getInstance();
  const localNodeId = registry.getDefaultNodeId();
  // Node names are a fleet-management read (`GET /api/nodes` asks for
  // `node:read`); a caller without it still gets the portfolio, with nodes
  // identified by id only, so this surface never grants a wider view of the
  // fleet than the roster itself does.
  const maySeeNodeNames = checkPermission(req, 'node:read');
  const nodeNames = new Map<number, string | null>(nodes.map(node => [node.id, maySeeNodeNames ? node.name ?? null : null]));

  const rows: GitOpsPortfolioRow[] = [];
  const coverage: GitOpsPortfolioNodeCoverage[] = [];

  // Hub-local Direct applications. Authorization per row through the same
  // classifier the Git-source list route uses.
  const localDirect = store.listActiveDirectApplications();
  const latestByApp = latestTransitionByApplication(
    db.getDb(),
    localDirect.map(application => application.id),
  );
  const stackPresent = await stackResourceSet(req.nodeId);
  for (const application of localDirect) {
    const projection = projectApplication(application.id, healthGateDisabled());
    const requirement = classifySourceRow({
      stackName: application.stack_name,
      gitopsRevision: projection,
      stackResourcePresent: application.stack_name !== null && stackPresent.has(application.stack_name),
    });
    if (!satisfiesGitOpsRead(req, requirement)) continue;
    rows.push(rowFromProjection({
      id: `${localNodeId}:${application.id}`,
      projection,
      name: application.stack_name ?? application.configured_source_stack_name ?? 'unknown',
      stackName: application.stack_name,
      blueprintId: null,
      nodeId: localNodeId,
      nodeName: nodeNames.get(localNodeId) ?? null,
      lastActivityAt: latestByApp.get(application.id) ?? null,
      partialNodes: [],
      nodeNames,
    }));
  }

  // Hub-local Git sources with no application behind them (they predate the
  // revision model, or their application write failed). Remote nodes report
  // these through their `/git-sources` rows; the hub reports its own the same
  // way, so a stack's Git indicator never leads to a portfolio without it.
  for (const source of db.getGitSources()) {
    const projection = projectStackRevision(source.stack_name);
    if (projection !== NOT_APPLICABLE_REVISION) continue;
    const requirement = classifySourceRow({
      stackName: source.stack_name,
      gitopsRevision: projection,
      stackResourcePresent: stackPresent.has(source.stack_name),
    });
    if (!satisfiesGitOpsRead(req, requirement)) continue;
    rows.push(legacyPortfolioRow(localNodeId, nodeNames.get(localNodeId) ?? null, source.stack_name, source.updated_at));
  }

  // Hub-local Blueprint applications are read like the Blueprint catalog: the
  // fleet-wide read grant (`node:read`) is what that surface uses, so the
  // portfolio shows the same subset the catalog would.
  const blueprintRows = store.listLiveBlueprintApplications();
  if (checkPermission(req, 'node:read')) {
    const blueprintTransitions = latestTransitionByApplication(
      db.getDb(),
      blueprintRows.map(application => application.id),
    );
    for (const application of blueprintRows) {
      if (application.blueprint_id === null) continue;
      const projection = projectApplication(application.id, healthGateDisabled());
      const blueprint = db.getBlueprint(application.blueprint_id);
      rows.push(rowFromProjection({
        id: `bp:${application.blueprint_id}`,
        projection,
        name: blueprint?.name ?? `blueprint #${application.blueprint_id}`,
        stackName: null,
        blueprintId: application.blueprint_id,
        nodeId: null,
        nodeName: null,
        lastActivityAt: blueprintTransitions.get(application.id) ?? null,
        partialNodes: [],
        nodeNames,
      }));
    }
  }

  // Remote Direct applications. One bounded probe per node, all in flight at
  // once; each leg degrades to a coverage entry. A leg that throws anyway
  // (a payload this build cannot walk) is reported as unsupported rather than
  // rejecting the whole aggregate: one malformed node must never 500 the page.
  // The local node is listed first so the workplace's node dimension always
  // includes the hub itself, even on a fleet of one.
  coverage.push({ nodeId: localNodeId, nodeName: nodeNames.get(localNodeId) ?? null, state: 'ok' });
  const remoteNodes = nodes.filter(node => node.id !== localNodeId);
  await Promise.all(remoteNodes.map(async node => {
    const nodeLabel = maySeeNodeNames ? node.name ?? null : null;
    try {
      const remoteRows = await fetchRows(node.id);
      if (remoteRows === null) {
        coverage.push({ nodeId: node.id, nodeName: nodeLabel, state: 'unreachable' });
        return;
      }
      if (remoteRows === 'unsupported') {
        coverage.push({ nodeId: node.id, nodeName: nodeLabel, state: 'unsupported' });
        return;
      }
      rewriteIdentityPayload(remoteRows, node.id);
      const filtered = filterRemoteIdentityPayload(
        '/git-sources',
        remoteRows,
        (requirement, nodeId) => satisfiesGitOpsRead(req, requirement, nodeId),
        node.id,
      );
      if (!Array.isArray(filtered)) {
        coverage.push({ nodeId: node.id, nodeName: nodeLabel, state: 'unsupported' });
        return;
      }
      coverage.push({ nodeId: node.id, nodeName: nodeLabel, state: 'ok' });
      for (const row of filtered) {
        const portfolioRow = remotePortfolioRow(row, node.id, nodeLabel, nodeNames);
        if (portfolioRow !== null) rows.push(portfolioRow);
      }
    } catch (error) {
      console.warn(
        `[GitOps portfolio] Node ${node.id} contributed a payload this build could not read:`,
        error instanceof Error ? error.message : error,
      );
      coverage.push({ nodeId: node.id, nodeName: nodeLabel, state: 'unsupported' });
    }
  }));

  // Most urgent first, then id for a stable order, so the merge cap drops
  // settled rows before it drops a failure the operator must see.
  rows.sort((a, b) => POSTURE_RANK[a.posture] - POSTURE_RANK[b.posture]
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  coverage.sort((a, b) => a.nodeId - b.nodeId);
  if (rows.length > PORTFOLIO_MERGE_CAP) {
    return { rows: rows.slice(0, PORTFOLIO_MERGE_CAP), coverage, truncated: true };
  }
  return { rows, coverage, truncated: false };
}

/** Raw rows from one remote's GET /api/git-sources: null unreachable, 'unsupported' no usable answer. */
export async function fetchRemoteSourceRows(nodeId: number): Promise<unknown[] | null | 'unsupported'> {
  const target = NodeRegistry.getInstance().getProxyTarget(nodeId);
  if (!target) return null;
  const baseUrl = target.apiUrl.replace(/\/$/, '');
  const headers: Record<string, string> = target.apiToken
    ? { Authorization: `Bearer ${target.apiToken}` }
    : {};
  try {
    const res = await safeRemoteFetch(
      `${baseUrl}/api/git-sources`,
      { headers, signal: AbortSignal.timeout(REMOTE_PROBE_TIMEOUT_MS) },
      target.trustedLoopback,
    );
    if (!res.ok) {
      // 404/405/501 mean the endpoint is not there (a node older than this
      // surface); anything else is a failed probe, not an unsupported node.
      // The body is cancelled in both cases so the connection is released
      // rather than held by an undrained stream.
      await res.body?.cancel().catch(() => {});
      return res.status === 404 || res.status === 405 || res.status === 501 ? 'unsupported' : null;
    }
    const payload: unknown = await res.json();
    if (!Array.isArray(payload)) return 'unsupported';
    return payload;
  } catch (error) {
    console.warn(`[GitOps portfolio] Node ${nodeId} source probe failed:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * The targets that still say something about the application.
 *
 * A tombstoned target is one the intent withdrew: it is kept in the projection
 * for the audit trail, and it is excluded everywhere a current answer is read,
 * so a retired failure cannot keep an application in the attention queue.
 */
function liveTargetsOf(projection: GitOpsRevisionProjection): GitOpsRevisionProjection['targets'] {
  return projection.targets.filter(target => !target.tombstoned);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

/** An identity field: absent (null) or a real identifier, never a blank string. */
function isNullableIdentifier(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.length > 0);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableNumber(value: unknown): boolean {
  return value === null || isFiniteNumber(value);
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isApprovalRefs(value: unknown): boolean {
  return isRecord(value) && [
    'sourceAcceptanceRef',
    'placementApprovalRef',
    'rolloutAuthorizationRef',
    'legacyCombinedApprovalRef',
  ].every(key => isNullableString(value[key]));
}

function isIdentityRef(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'none':
    case 'unknown':
      return true;
    case 'commit':
      return typeof value.sha === 'string' && typeof value.repoUrl === 'string' && typeof value.ref === 'string';
    case 'generation':
    case 'rollout_candidate':
    case 'rollout_generation':
      return typeof value.id === 'string';
    case 'artifact_set':
      return typeof value.id === 'string'
        && isNonEmptyString(value.qualification)
        && isFiniteNumber(value.evidenceVersion);
    case 'runtime_artifact':
      return typeof value.identity === 'string' && isNullableNumber(value.observedAt);
    case 'intent':
      return typeof value.id === 'string' && typeof value.composeContentSha256 === 'string';
    case 'invocation':
      return isRecord(value.authored)
        && isStringArray(value.authored.composeFileOrder)
        && isNullableString(value.authored.projectName)
        && isNullableString(value.authored.projectDirectory)
        && isStringArray(value.authored.envFileOrder);
    case 'health_run':
      return typeof value.runId === 'string' && isNullableString(value.deployedGenerationId);
    default:
      return false;
  }
}

function isObservedArtifactIdentity(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'unknown':
    case 'missing':
    case 'unavailable':
      return true;
    case 'exact':
    case 'qualified':
    case 'stale':
    case 'local_build_unverified':
      return typeof value.identity === 'string' && isFiniteNumber(value.observedAt);
    default:
      return true;
  }
}

function isBinding(value: unknown): value is FutureRolloutAuthorizationBinding {
  return isRecord(value)
    && typeof value.acceptedGenerationId === 'string'
    && typeof value.artifactSetId === 'string'
    && typeof value.intentRevisionId === 'string'
    && typeof value.placementApprovalRef === 'string'
    && typeof value.preflightFingerprint === 'string'
    && PREFLIGHT_FINGERPRINT_RE.test(value.preflightFingerprint)
    && typeof value.rolloutCandidateId === 'string'
    && typeof value.sourceAcceptanceRef === 'string'
    && Array.isArray(value.requiredNodeIds)
    && value.requiredNodeIds.every(isPositiveInteger);
}

type ArtifactEvidenceShape = {
  artifactSetId: string;
  evidenceVersion: number;
  qualification: string;
  identity: string | null;
};

function isExpectedArtifact(value: unknown): value is ArtifactEvidenceShape | null {
  return value === null || isLatestArtifact(value);
}

function isLatestArtifact(value: unknown): value is ArtifactEvidenceShape {
  return isRecord(value)
    && isNonEmptyString(value.artifactSetId)
    && isFiniteNumber(value.evidenceVersion)
    && isNonEmptyString(value.qualification)
    && (value.identity === null || isNonEmptyString(value.identity));
}

function isSourceFacet(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.status !== 'string') return false;
  if (value.status === 'not_applicable') return true;
  const repoIdentity = value.repoIdentity;
  if (!isRecord(repoIdentity)
    || typeof value.configuredRepoUrl !== 'string'
    || typeof repoIdentity.host !== 'string'
    || typeof repoIdentity.pathname !== 'string'
    || typeof value.configuredRef !== 'string'
    || !isNullableString(value.desiredCommitSha)
    || !isNullableString(value.fetchedCommitSha)
    || !isNullableString(value.candidateGenerationId)
    || !isNullableString(value.acceptedGenerationId)) return false;
  switch (value.status) {
    case 'source_review_pending':
      return value.reviewBlockReason === null || value.reviewBlockReason === 'stateful_withdrawal';
    case 'application_generation_accepted':
      return typeof value.acceptedGenerationId === 'string';
    case 'source_superseded':
      return typeof value.supersededGenerationId === 'string';
    case 'applying':
      return typeof value.activeOperationId === 'string' && typeof value.activeGenerationId === 'string';
    case 'source_retry_scheduled':
      return isFiniteNumber(value.retryAt) && isFiniteNumber(value.retryCount);
    case 'source_poll_scheduled':
      return isFiniteNumber(value.nextPollAt);
    case 'source_suspended':
      return isFiniteNumber(value.suspendedAt) && isNullableString(value.suspendedReason);
    case 'source_failed':
      return typeof value.failureStage === 'string'
        && ['fetch', 'validation', 'apply', 'create'].includes(value.failureStage)
        && typeof value.failureClass === 'string'
        && isFiniteNumber(value.failureAt)
        && isNullableNumber(value.retryAt)
        && isFiniteNumber(value.retryCount);
    case 'source_unknown':
      return typeof value.interruptedStage === 'string'
        && ['fetch_started', 'apply_started'].includes(value.interruptedStage)
        && isFiniteNumber(value.interruptedAt)
        && isNullableString(value.interruptedOperationId)
        && isNullableString(value.interruptedGenerationId);
    case 'recovery_required':
      return isNullableString(value.recoveryRef) && isNullableString(value.recoveryGenerationId);
    case 'recovery_failed':
      return isNullableString(value.recoveryRef)
        && isNullableString(value.recoveryGenerationId)
        && typeof value.failureClass === 'string'
        && isFiniteNumber(value.failureAt);
    case 'not_live':
      return value.lifecycleStatus === 'detached' || value.lifecycleStatus === 'deleted';
    default:
      return true;
  }
}

function isArtifactFacet(value: unknown): boolean {
  if (!isRecord(value) || typeof value.status !== 'string') return false;
  if (value.status === 'not_applicable') return true;
  if (!isNonEmptyString(value.generationId)) return false;
  if (value.latestEvidence === null) {
    return value.status === 'artifact_unresolved'
      && value.limitation === 'artifact_pointer_missing'
      && isExpectedArtifact(value.expected);
  }
  const latest = value.latestEvidence;
  if (!isLatestArtifact(latest)) return false;
  const expected = value.expected;
  if (!isExpectedArtifact(expected)) return false;
  if (value.artifactSetId !== latest.artifactSetId || value.evidenceVersion !== latest.evidenceVersion) return false;
  // An exact or qualified verdict is a claim that the observed artifact is the
  // expected one, so a provable identity disagreement between expected and
  // latest cannot coexist with it. Unqualified expectations carry no identity
  // to compare and are left to the status pairing checks below.
  if ((value.status === 'artifact_exact' || value.status === 'artifact_qualified' || value.status === 'artifact_identity_changed')
    && (latest.identity === null || (expected !== null && expected.qualification !== 'unresolved' && expected.identity === null))) return false;
  if ((value.status === 'artifact_exact' || value.status === 'artifact_qualified')
    && expected !== null
    && expected.identity !== null
    && expected.identity !== latest.identity) return false;
  if (value.status === 'artifact_identity_changed'
    && (expected === null
      || (expected.qualification !== 'exact' && expected.qualification !== 'qualified')
      || latest.identity === null
      || expected.identity === null
      || latest.identity === expected.identity)) return false;
  // Every status except `artifact_identity_changed` names the one qualification
  // it may carry, on the facet and on the latest evidence alike.
  const pairedQualification = STATUS_QUALIFICATION[value.status];
  if (pairedQualification !== undefined
    && (value.qualification !== pairedQualification || latest.qualification !== pairedQualification)) return false;
  if (value.status === 'artifact_identity_changed'
    && (value.qualification !== latest.qualification
      || (value.qualification !== 'exact' && value.qualification !== 'qualified'))) return false;
  return isNonEmptyString(value.artifactSetId)
    && isFiniteNumber(value.evidenceVersion)
    && isNonEmptyString(value.qualification)
    && isFiniteNumber(value.freshnessAt);
}

function isPlacementFacet(value: unknown): boolean {
  if (!isRecord(value) || typeof value.status !== 'string') return false;
  switch (value.status) {
    case 'not_applicable':
    case 'unbound_direct':
    case 'placement_review_pending':
    case 'stateful_confirmation_required':
      return true;
    case 'blueprint_bound':
      return value.completion === 'unknown';
    case 'unknown':
      return value.limitation === 'missing_intent';
    case 'source_acceptance_pending':
      return isNullableString(value.sourceAcceptanceRef) && typeof value.candidateGenerationId === 'string';
    case 'rollout_authorization_pending':
      return value.rolloutAuthorizationRef === null && isBinding(value.binding);
    case 'rollout_authorization_stale':
      return typeof value.rolloutAuthorizationRef === 'string' && isBinding(value.bound);
    case 'preflight_blocked':
      return typeof value.reason === 'string' && isBinding(value.binding);
    default:
      return true;
  }
}

function isRolloutFacet(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.status !== 'string') return false;
  if (GENERATION_BOUND_ROLLOUT_STATES.has(value.status)) return isNonEmptyString(value.rolloutGenerationId);
  switch (value.status) {
    case 'not_applicable':
    case 'target_stale':
    case 'target_unreachable':
    case 'recovery_required':
    case 'completion_unknown':
      return true;
    case 'rollout_not_executable':
      return typeof value.rolloutCandidateId === 'string';
    case 'rollout_paused':
      return isFiniteNumber(value.pauseAt) && isNullableString(value.pauseReason);
    case 'partially_rolled_out':
      return Object.hasOwn(value, 'partial');
    case 'rollback_in_progress':
      return typeof value.recoveryRef === 'string' && isNullableString(value.recoveryGenerationId);
    case 'rollback_partial_failed':
      return typeof value.recoveryRef === 'string'
        && isNullableString(value.recoveryGenerationId)
        && typeof value.failureClass === 'string'
        && isFiniteNumber(value.failureAt);
    default:
      return true;
  }
}

function isRuntimeFacet(value: unknown): boolean {
  if (!isRecord(value) || typeof value.status !== 'string') return false;
  switch (value.status) {
    case 'paused':
      return isFiniteNumber(value.pauseAt) && isNullableString(value.pauseReason);
    case 'recovery_failed':
      return isNullableString(value.recoveryRef)
        && isNullableString(value.recoveryGenerationId)
        && typeof value.failureClass === 'string'
        && isFiniteNumber(value.failureAt);
    case 'completion_unknown':
      return typeof value.interruptedStage === 'string'
        && ['deploy_started', 'blueprint_deploy_started', 'blueprint_withdraw_started'].includes(value.interruptedStage)
        && isFiniteNumber(value.interruptedAt)
        && isNullableString(value.interruptedOperationId)
        && isNullableString(value.interruptedGenerationId)
        && isNullableString(value.interruptedIntentRevisionId)
        && isNullableString(value.interruptedRolloutCandidateId);
    default:
      return true;
  }
}

function isHealthFacet(value: unknown): boolean {
  if (!isRecord(value) || typeof value.status !== 'string') return false;
  switch (value.status) {
    case 'not_applicable':
    case 'unbound':
      return true;
    case 'pending':
      return isNullableString(value.runId);
    case 'checking':
    case 'failed':
      return typeof value.runId === 'string' && isNullableString(value.deployedGenerationId);
    case 'passed':
      return typeof value.runId === 'string' && typeof value.deployedGenerationId === 'string';
    case 'unknown':
      return isNullableString(value.runId) && value.limitation === 'health_unknown';
    default:
      return true;
  }
}

function isLkgFacet(value: unknown): boolean {
  if (!isRecord(value) || typeof value.status !== 'string') return false;
  switch (value.status) {
    case 'none':
    case 'unavailable':
      return true;
    case 'available':
      return typeof value.generationId === 'string' && isNullableString(value.artifactSetId);
    case 'qualified':
      return typeof value.generationId === 'string' && typeof value.artifactSetId === 'string';
    default:
      return true;
  }
}

function isConfiguredPolicy(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'git_source') return typeof value.autoApplyOnWebhook === 'boolean' && typeof value.autoDeployOnApply === 'boolean';
  if (value.kind === 'blueprint_drift') {
    return typeof value.driftMode === 'string'
      && ['observe', 'suggest', 'enforce'].includes(value.driftMode);
  }
  return true;
}

function isDriftItem(value: unknown): boolean {
  return isRecord(value)
    && typeof value.class === 'string'
    && isIdentityRef(value.expected)
    && isIdentityRef(value.observed)
    && isNullableNumber(value.freshnessAt)
    && typeof value.owner === 'string'
    && typeof value.reason === 'string'
    && isConfiguredPolicy(value.configuredPolicy)
    && Array.isArray(value.affectedTargets)
    && value.affectedTargets.every(target => isRecord(target) && isNullablePositiveInteger(target.nodeId) && isNullableString(target.stackName))
    && typeof value.action === 'string';
}

function isLimitation(value: unknown): boolean {
  return isRecord(value)
    && typeof value.code === 'string'
    && typeof value.message === 'string'
    && Object.hasOwn(value, 'evidence');
}

function isRemoteTarget(value: unknown): boolean {
  return isRecord(value)
    && isPositiveInteger(value.nodeId)
    && isNullableString(value.stackName)
    && [
      'desiredGenerationId',
      'candidateGenerationId',
      'appliedGenerationId',
      'deployedGenerationId',
      'healthyGenerationId',
      'lkgGenerationId',
      'lkgArtifactSetId',
      'expectedArtifactSetId',
      'latestArtifactSetId',
      'intentRevisionId',
      'rolloutCandidateId',
      'rolloutGenerationId',
    ].every(key => isNullableIdentifier(value[key]))
    && isNullableNumber(value.lkgUnavailableAt)
    && isLkgUnavailableReason(value.lkgUnavailableReason)
    && isArtifactFacet(value.artifact)
    && isObservedArtifactIdentity(value.observedArtifactIdentity)
    && isApprovalRefs(value.approvals)
    && typeof value.connectivity === 'string'
    && isNullableNumber(value.legacyAppliedRevision)
    && isRuntimeFacet(value.runtime)
    && isHealthFacet(value.health)
    && isLkgFacet(value.lkg)
    && typeof value.tombstoned === 'boolean';
}

/**
 * Whether a value is a walkable live projection.
 *
 * Narrows to the live arm of the union: the sentinel variant carries no facets
 * and is rejected here, so the caller takes the unknown-evidence path instead
 * and can read `facets`/`targets` after this guard without another
 * discriminant check.
 */
export function isUsableRevision(value: unknown): value is Extract<GitOpsRevisionProjection, { applicationId: string }> {
  if (!isRecord(value)) return false;
  const mode = value.targetMode;
  if (mode !== 'direct' && mode !== 'blueprint' && mode !== 'inline_blueprint') return false;
  if (value.schemaVersion !== 1) return false;
  if (typeof value.applicationId !== 'string'
    || value.applicationId.length === 0
    || value.applicationId.startsWith('legacy:')
    || value.applicationId.startsWith('bp:')
    || typeof value.lifecycleStatus !== 'string'
    || !['active', 'creating', 'detached', 'deleted'].includes(value.lifecycleStatus)) return false;
  if (!isNullableString(value.stackName) || !isNullablePositiveInteger(value.blueprintId) || !isNullableString(value.rolloutGenerationId)) return false;
  if (!isApprovalRefs(value.approvals)) return false;
  const facets = value.facets;
  if (!isRecord(facets)) return false;
  const source = facets.source;
  const artifact = facets.artifact;
  const placement = facets.placement;
  const rollout = facets.rollout;
  if (!isSourceFacet(source)
    || !isArtifactFacet(artifact)
    || !isPlacementFacet(placement)
    || !isRolloutFacet(rollout)) return false;
  if (typeof rollout.status === 'string'
    && GENERATION_BOUND_ROLLOUT_STATES.has(rollout.status)
    && rollout.rolloutGenerationId !== value.rolloutGenerationId) return false;
  if (source.status === 'not_live' && source.lifecycleStatus !== value.lifecycleStatus) return false;
  if (!Array.isArray(value.targets) || !value.targets.every(isRemoteTarget)) return false;
  if (!Array.isArray(value.drift) || !value.drift.every(isDriftItem)) return false;
  if (!Array.isArray(value.limitations) || !value.limitations.every(isLimitation)) return false;
  return Array.isArray(value.availableActions) && value.availableActions.every(item => typeof item === 'string');
}

/**
 * The row for a Git source with no live application behind it, on any node.
 *
 * Every facet reads `unknown` and the evidence is partial: nobody derived a
 * state for it, so it must not read as converged. The `legacy:` id segment is
 * resolved by the detail route by stack name, so the id is routable.
 */
export function legacyPortfolioRow(
  nodeId: number,
  nodeName: string | null,
  stackName: string,
  updatedAt: number | null,
): GitOpsPortfolioRow {
  return {
    id: `${nodeId}:legacy:${stackName}`,
    targetMode: 'direct',
    name: stackName,
    stackName,
    blueprintId: null,
    nodeId,
    nodeName,
    repository: null,
    desiredCommitSha: null,
    fetchedCommitSha: null,
    candidateGenerationId: null,
    acceptedGenerationId: null,
    sourceStatus: 'unknown',
    artifactStatus: 'unknown',
    artifactQualification: null,
    placementStatus: 'unknown',
    rolloutStatus: 'unknown',
    runtimeStatus: 'unknown',
    healthStatus: 'unknown',
    targets: [],
    drift: { count: 0, classes: [] },
    attention: [],
    posture: 'unknown',
    availableActions: [],
    limitations: [],
    lastActivityAt: finiteTimestamp(updatedAt),
    evidence: { partial: true, unreachableNodes: [], unknown: true },
  };
}

/**
 * One portfolio row from a remote, already rewritten + re-authorized row.
 *
 * The row's `gitopsRevision` is the owning instance's projection; statuses this
 * build does not know are carried through verbatim and marked as unknown
 * evidence rather than re-named. Rows without a live projection (a legacy node
 * predating the model, or a source row whose application vanished) are kept
 * with unknown evidence so the fleet never reads smaller than it is; a payload
 * that is present but not walkable degrades to the same unknown row instead of
 * throwing into the node leg.
 */
function unavailablePortfolioRow(
  nodeId: number,
  nodeName: string | null,
  applicationId: string,
  stackName: string | null,
  updatedAt: number | null,
  targetMode: 'direct' | 'blueprint' | 'inline_blueprint',
  blueprintId: number | null,
): GitOpsPortfolioRow {
  return {
    id: `${nodeId}:${applicationId}`,
    targetMode,
    name: stackName ?? applicationId,
    stackName,
    blueprintId,
    nodeId,
    nodeName,
    repository: null,
    desiredCommitSha: null,
    fetchedCommitSha: null,
    candidateGenerationId: null,
    acceptedGenerationId: null,
    sourceStatus: 'unknown',
    artifactStatus: 'unknown',
    artifactQualification: null,
    placementStatus: 'unknown',
    rolloutStatus: 'unknown',
    runtimeStatus: 'unknown',
    healthStatus: 'unknown',
    targets: [],
    drift: { count: 0, classes: [] },
    attention: [],
    posture: 'unknown',
    availableActions: [],
    limitations: ['evidence_unavailable'],
    lastActivityAt: finiteTimestamp(updatedAt),
    evidence: { partial: true, unreachableNodes: [], unknown: true },
  };
}

function remotePortfolioRow(
  row: unknown,
  nodeId: number,
  nodeName: string | null,
  nodeNames: Map<number, string | null>,
): GitOpsPortfolioRow | null {
  if (!isRecord(row)) return null;
  const rawRevision = row.gitopsRevision;
  const revision = isUsableRevision(rawRevision) ? rawRevision : null;
  const stackName = typeof row.stack_name === 'string' ? row.stack_name : null;
  const rawTargetMode = isRecord(rawRevision)
    && (rawRevision.targetMode === 'blueprint' || rawRevision.targetMode === 'inline_blueprint')
    ? rawRevision.targetMode
    : 'direct';
  const rawBlueprintId = isRecord(rawRevision) && isPositiveInteger(rawRevision.blueprintId)
    ? rawRevision.blueprintId
    : null;
  const applicationId = isRecord(rawRevision) && typeof rawRevision.applicationId === 'string'
    && rawRevision.applicationId.length > 0
    && !rawRevision.applicationId.startsWith('legacy:')
    && !rawRevision.applicationId.startsWith('bp:')
    ? rawRevision.applicationId
    : null;
  if (revision === null) {
    if (applicationId !== null) {
      return unavailablePortfolioRow(
        nodeId,
        nodeName,
        applicationId,
        stackName,
        typeof row.updated_at === 'number' ? row.updated_at : null,
        rawTargetMode,
        rawTargetMode === 'direct' ? null : rawBlueprintId,
      );
    }
    if (stackName === null) return null;
    return legacyPortfolioRow(nodeId, nodeName, stackName, typeof row.updated_at === 'number' ? row.updated_at : null);
  }
  const displayName = revision.stackName ?? stackName ?? `application ${revision.applicationId}`;
  return rowFromProjection({
    id: `${nodeId}:${revision.applicationId}`,
    projection: revision,
    name: displayName,
    stackName: revision.stackName ?? stackName,
    blueprintId: revision.blueprintId,
    nodeId,
    nodeName,
    lastActivityAt: freshestFacetTimestamp(revision),
    partialNodes: [],
    nodeNames,
  });
}
