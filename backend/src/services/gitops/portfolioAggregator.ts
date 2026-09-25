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
import { comparableObservationMatches } from './artifactIdentity';
import { latestTransitionByApplication } from './history';
import { classifySourceRow, satisfiesGitOpsRead } from './readAuth';
import { GitOpsStore } from './store';
import { attentionReasons, currentDrift, hasFailureReason } from './attention';
import { FACET_EVIDENCE_SOURCE } from './types';
import type {
  GitOpsPortfolioNodeCoverage,
  GitOpsPortfolioPosture,
  GitOpsPortfolioRepository,
  GitOpsPortfolioRow,
  GitOpsPortfolioTargetSummary,
} from './portfolioTypes';
import type { GitOpsRevisionProjection, GitOpsTargetProjection } from './types';
import { canonicalizeServiceEvidence, isRecord } from './json';
import type { ServiceArtifactEvidence } from './json';

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

const RUNTIME_RANK = new Map(RUNTIME_SEVERITY.map((status, index) => [status, index]));

const HEALTH_SEVERITY: readonly string[] = ['failed', 'unknown', 'pending', 'checking', 'passed', 'unbound', 'not_applicable'];
const HEALTH_RANK = new Map(HEALTH_SEVERITY.map((status, index) => [status, index]));
const ARTIFACT_QUALIFICATIONS: ReadonlySet<string> = new Set([
  'unresolved',
  'exact',
  'qualified',
  'stale',
  'unavailable',
  'local_build_unverified',
]);
const ARTIFACT_SERVICE_SOURCES: ReadonlySet<string> = new Set(['registry', 'build', 'unsupported']);
const ARTIFACT_SERVICE_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  'unresolved',
  'registry_unavailable',
  'credential_failure',
  'unsupported_registry',
  'platform_ambiguity',
  'digest_unavailable',
  'stale_resolution',
]);
const DRIFT_CLASSES: ReadonlySet<string> = new Set([
  'source',
  'managed_project',
  'invocation',
  'placement',
  'rollout',
  'runtime',
  'health',
]);
const LIFECYCLE_STATUSES: ReadonlySet<string> = new Set(['active', 'creating', 'detached', 'deleted']);
const SETTLED_SOURCE_STATUSES: ReadonlySet<string> = new Set(['application_generation_accepted', 'source_poll_scheduled']);
const SETTLED_ROLLOUT_ARTIFACT: ReadonlyMap<string, 'artifact_exact' | 'artifact_qualified'> = new Map([
  ['exactly_converged_healthy', 'artifact_exact'],
  ['configuration_converged_artifact_qualified', 'artifact_qualified'],
]);
const OBSERVED_ARTIFACT_KINDS: ReadonlySet<string> = new Set(['exact', 'qualified', 'stale', 'local_build_unverified']);
const AVAILABLE_ACTIONS: ReadonlySet<string> = new Set([
  'fetch',
  'apply',
  'dismiss',
  'deploy',
  'approve_legacy',
  'suspend',
  'resume',
  'retry',
  'none',
]);
const TARGET_GENERATION_FIELDS = [
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
] as const;
const LKG_UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  'generation_missing',
  'recovery_unretainable',
]);

function hasFacetStatus(registry: object, status: string): boolean {
  return Object.prototype.hasOwnProperty.call(registry, status);
}

function isSettledSourceStatus(source: Extract<GitOpsRevisionProjection, { applicationId: string }>['facets']['source']): boolean {
  return SETTLED_SOURCE_STATUSES.has(source.status);
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

function worstTargetStatus(
  targets: GitOpsTargetProjection[],
  facet: 'runtime' | 'health',
  rank: ReadonlyMap<string, number>,
  unknownRank: number,
): string {
  let worst: string | null = null;
  let worstRank = Number.POSITIVE_INFINITY;
  for (const target of targets) {
    const status = facet === 'runtime' ? target.runtime.status : target.health.status;
    const statusRank = rankUnknownAware(rank, status, unknownRank);
    if (statusRank < worstRank) {
      worst = status;
      worstRank = statusRank;
    }
  }
  return worst ?? 'not_applicable';
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
function hasUnrecognizedStatus(
  projection: GitOpsRevisionProjection,
  targets: GitOpsTargetProjection[],
): boolean {
  if (projection.targetMode === 'not_applicable') return false;
  if (!LIFECYCLE_STATUSES.has(projection.lifecycleStatus)) return true;
  const { source, artifact, placement, rollout } = projection.facets;
  if (!hasFacetStatus(FACET_EVIDENCE_SOURCE.source, source.status)) return true;
  if (!hasFacetStatus(FACET_EVIDENCE_SOURCE.artifact, artifact.status)) return true;
  if (!hasFacetStatus(FACET_EVIDENCE_SOURCE.placement, placement.status)) return true;
  if (!hasFacetStatus(FACET_EVIDENCE_SOURCE.rollout, rollout.status)) return true;
  for (const target of targets) {
    if (!RUNTIME_RANK.has(target.runtime.status)) return true;
    if (!HEALTH_RANK.has(target.health.status)) return true;
    if (target.connectivity !== 'reachable' && target.connectivity !== 'unreachable' && target.connectivity !== 'stale' && target.connectivity !== 'unknown') return true;
  }
  return false;
}

function currentTargets(projection: GitOpsRevisionProjection): GitOpsTargetProjection[] {
  return projection.targetMode === 'not_applicable'
    ? []
    : projection.targets.filter(target => !target.tombstoned);
}

function sourceModeIsCompatible(projection: GitOpsRevisionProjection): boolean {
  if (projection.targetMode === 'not_applicable') return false;
  return projection.targetMode === 'inline_blueprint'
    ? projection.facets.source.status === 'not_applicable'
    : projection.facets.source.status !== 'not_applicable';
}

function currentTargetSetIsUnique(targets: GitOpsTargetProjection[]): boolean {
  return new Set(targets.map(target => target.nodeId)).size === targets.length;
}

function claimsSettledConvergence(projection: GitOpsRevisionProjection): boolean {
  if (projection.targetMode === 'not_applicable') return false;
  const { source, rollout } = projection.facets;
  return SETTLED_ROLLOUT_ARTIFACT.has(rollout.status)
    || projection.targetMode === 'direct'
      && isSettledSourceStatus(source);
}

function targetArtifactMatchesSettledFacet(
  target: GitOpsTargetProjection,
  artifact: Extract<GitOpsRevisionProjection, { applicationId: string }>['facets']['artifact'],
  generationId: string,
): boolean {
  if (artifact.status !== 'artifact_exact' && artifact.status !== 'artifact_qualified') return false;
  const expectedSetId = artifact.expected?.artifactSetId ?? artifact.artifactSetId;
  if (
    target.artifact.status !== artifact.status
    || target.artifact.generationId !== generationId
    || target.artifact.evidenceVersion !== artifact.evidenceVersion
    || target.artifact.latestEvidence.evidenceVersion !== artifact.latestEvidence.evidenceVersion
    || target.artifact.artifactSetId !== artifact.artifactSetId
    || target.latestArtifactSetId !== artifact.artifactSetId
    || target.expectedArtifactSetId !== expectedSetId
  ) return false;
  const observed = target.observedArtifactIdentity;
  if (artifact.expected === null) {
    if (target.artifact.latestEvidence.identity !== artifact.latestEvidence.identity) return false;
    const targetExpected = 'expected' in target.artifact ? target.artifact.expected : null;
    if (
      !targetExpected
      || targetExpected.artifactSetId !== expectedSetId
      || targetExpected.evidenceVersion !== artifact.evidenceVersion
    ) return false;
    if (observed.kind !== 'exact' && observed.kind !== 'qualified') return false;
    if (observed.identity !== artifact.latestEvidence.identity) return false;
    if (
      targetExpected.qualification !== artifact.qualification
      || targetExpected.identity !== null && targetExpected.identity !== observed.identity
    ) return false;
    return !targetExpected.services?.length || comparableObservationMatches(targetExpected.services, observed);
  }
  const expected = 'expected' in target.artifact ? target.artifact.expected : null;
  if (
    !expected
    || expected.artifactSetId !== artifact.expected.artifactSetId
    || expected.qualification !== artifact.expected.qualification
    || expected.identity !== artifact.expected.identity
    || expected.evidenceVersion !== artifact.expected.evidenceVersion
  ) return false;
  const topServices = artifact.expected.services ?? [];
  const targetServices = expected.services ?? [];
  if (topServices.length > 0 || targetServices.length > 0) {
    if (topServices.length !== targetServices.length) return false;
    if (!servicesEquivalent(topServices, targetServices)) return false;
  }
  if (observed.kind !== 'exact' && observed.kind !== 'qualified') return false;
  if (artifact.expected.identity === null) {
    if (target.artifact.latestEvidence.identity !== artifact.latestEvidence.identity) return false;
    if (observed.identity !== artifact.latestEvidence.identity) return false;
    return !expected.services?.length || comparableObservationMatches(expected.services, observed);
  }
  if (expected.services && expected.services.length > 0) {
    return comparableObservationMatches(expected.services, observed);
  }
  return observed.identity === artifact.expected.identity;
}

function hasValidModeShape(projection: {
  targetMode?: unknown;
  stackName?: unknown;
  blueprintId?: unknown;
}): boolean {
  if (projection.targetMode === 'direct') {
    return isNonEmptyString(projection.stackName) && projection.blueprintId === null;
  }
  return projection.targetMode === 'blueprint' || projection.targetMode === 'inline_blueprint'
    ? projection.stackName === null
      && typeof projection.blueprintId === 'number'
      && Number.isSafeInteger(projection.blueprintId)
      && projection.blueprintId > 0
    : false;
}

function hasSettledGenerationProof(
  projection: GitOpsRevisionProjection,
  targets: GitOpsTargetProjection[],
): boolean {
  if (!claimsSettledConvergence(projection)) return true;
  if (projection.targetMode === 'not_applicable' || projection.lifecycleStatus !== 'active') return false;
  if (!hasValidModeShape(projection)) return false;
  const { source, artifact, placement, rollout } = projection.facets;
  const settledArtifactStatus = SETTLED_ROLLOUT_ARTIFACT.get(rollout.status);
  if (settledArtifactStatus && artifact.status !== settledArtifactStatus) return false;
  if (artifact.status !== 'artifact_exact' && artifact.status !== 'artifact_qualified') return false;
  const generationId = artifact.generationId;
  if (!isNonEmptyString(generationId) || !isNonEmptyString(artifact.artifactSetId)) return false;
  if (!sourceModeIsCompatible(projection)) return false;
  const authorizationRef = projection.approvals.rolloutAuthorizationRef;
  if (projection.targetMode === 'direct') {
    if (
      placement.status !== 'unbound_direct'
      || projection.rolloutGenerationId !== null
      || projection.approvals.rolloutAuthorizationRef !== null
    ) return false;
  } else if (
    placement.status !== 'blueprint_bound'
    || placement.completion !== 'unknown'
    || !isNonEmptyString(authorizationRef)
    || !isNonEmptyString(projection.rolloutGenerationId)
    || !('rolloutGenerationId' in rollout)
    || !isNonEmptyString(rollout.rolloutGenerationId)
    || projection.rolloutGenerationId !== rollout.rolloutGenerationId
  ) return false;
  if ('candidateGenerationId' in source && source.candidateGenerationId !== null) return false;
  if (source.status !== 'not_applicable' && (
    !isSettledSourceStatus(source) || source.acceptedGenerationId !== generationId
  )) return false;
  return targets.length > 0
    && currentTargetSetIsUnique(targets)
    && targets.every(target => (
    target.runtime.status === 'synced_and_healthy'
    && targetArtifactMatchesSettledFacet(target, artifact, generationId)
    && target.desiredGenerationId === generationId
    && target.appliedGenerationId === generationId
    && target.deployedGenerationId === generationId
    && target.approvals.sourceAcceptanceRef === projection.approvals.sourceAcceptanceRef
    && target.approvals.placementApprovalRef === projection.approvals.placementApprovalRef
    && target.approvals.legacyCombinedApprovalRef === projection.approvals.legacyCombinedApprovalRef
    && (
      projection.targetMode === 'direct'
      && target.stackName === projection.stackName
      && target.candidateGenerationId === null
      && target.intentRevisionId === null
      && target.rolloutCandidateId === null
      && target.rolloutGenerationId === null
      && target.approvals.rolloutAuthorizationRef === null
      || (
        projection.targetMode !== 'direct'
        && isNonEmptyString(target.intentRevisionId)
        && target.rolloutGenerationId === projection.rolloutGenerationId
        && target.approvals.rolloutAuthorizationRef === authorizationRef
      )
    )
    && (
      target.health.status === 'not_applicable'
      || target.health.status === 'passed'
        && target.healthyGenerationId === generationId
        && target.health.deployedGenerationId === generationId
    )
  ));
}

function targetSetIsCurrent(
  projection: GitOpsRevisionProjection,
  targets: GitOpsTargetProjection[],
): boolean {
  if (projection.targetMode === 'not_applicable') return false;
  if (!currentTargetSetIsUnique(targets)) return false;
  const rollout = projection.facets.rollout;
  if (SETTLED_ROLLOUT_ARTIFACT.has(rollout.status)) {
    if (!('rolloutGenerationId' in rollout)) return false;
    return projection.targetMode !== 'direct'
      && targets.length > 0
      && projection.rolloutGenerationId === rollout.rolloutGenerationId
      && targets.every(target => target.rolloutGenerationId === rollout.rolloutGenerationId)
      && hasSettledGenerationProof(projection, targets);
  }
  if (projection.targetMode === 'direct') return targets.length === 1;
  return true;
}

function hasFreshReachableTargets(
  projection: GitOpsRevisionProjection,
  targets: GitOpsTargetProjection[],
): boolean {
  return targets.length > 0
    && targetSetIsCurrent(projection, targets)
    && targets.every(target => target.connectivity === 'reachable')
    && hasSettledGenerationProof(projection, targets);
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
  const targets = currentTargets(projection);
  const attention = attentionReasons(projection);
  if (hasFailureReason(attention)) return 'failed';
  if (attention.length > 0) return 'attention';
  if (!currentTargetSetIsUnique(targets) || !sourceModeIsCompatible(projection)) return 'unknown';

  const { source, placement, rollout } = projection.facets;
  const targetEvidenceFresh = hasFreshReachableTargets(projection, targets);
  const inFlight =
    source.status === 'checking_fetching'
    || source.status === 'applying'
    || source.status === 'candidate_ready'
    || placement.status === 'source_acceptance_pending'
    || rollout.status === 'rollout_queued'
    || rollout.status === 'canary_in_progress'
    || rollout.status === 'batch_in_progress'
    || rollout.status === 'fully_deployed_health_pending'
    || targets.some(target =>
      target.runtime.status === 'deploying'
      || target.runtime.status === 'withdrawing'
      || target.runtime.status === 'correcting'
      || target.runtime.status === 'health_checking'
      || target.runtime.status === 'fully_deployed_health_pending'
      || target.runtime.status === 'artifact_verification_pending'
      || target.health.status === 'pending'
      || target.health.status === 'checking');
  if (inFlight) return 'in_progress';
  if (hasUnrecognizedStatus(projection, targets)) return 'unknown';

  if (targetEvidenceFresh && SETTLED_ROLLOUT_ARTIFACT.get(rollout.status) === 'artifact_exact') return 'converged';
  if (targetEvidenceFresh && SETTLED_ROLLOUT_ARTIFACT.get(rollout.status) === 'artifact_qualified') return 'converged_qualified';

  // Direct applications have no rollout facet; their convergence claim is the
  // source settled on an accepted generation, every target reporting its
  // running state in agreement with it, and no drift evidence anywhere. The
  // artifact facet must be a status this build knows before either claim is
  // made: an unknown qualification could be anything, and calling it exact or
  // qualified would assert proof nobody has.
  const artifact = projection.facets.artifact;
  const artifactKnown = hasFacetStatus(FACET_EVIDENCE_SOURCE.artifact, artifact.status) && artifact.status !== 'not_applicable';
  if (
    projection.targetMode === 'direct'
    && targetEvidenceFresh
    && artifactKnown
    && isSettledSourceStatus(source)
    && targets.every(target => target.runtime.status === 'synced_and_healthy')
    && targets.every(target => target.health.status === 'passed' || target.health.status === 'not_applicable')
    && currentDrift(projection).length === 0
  ) {
    if (artifact.status === 'artifact_exact') return 'converged';
    return 'converged_qualified';
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
  return projection.targets.map(target => ({
    nodeId: target.nodeId,
    nodeName: nodeNames.get(target.nodeId) ?? null,
    stackName: target.stackName,
    runtime: target.runtime.status,
    health: target.health.status,
    connectivity: target.connectivity,
    tombstoned: target.tombstoned,
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
  for (const target of currentTargets(projection)) consider(target.lkgUnavailableAt);
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
  const activeDrift = currentDrift(projection);
  const driftClasses = [...new Set(activeDrift.map(item => item.class))];
  // Unreachable targets are named per row, from the projection itself: a
  // target whose evidence never arrived is the row-level fact the evidence
  // filter and the UI's "unreachable" qualifier read, independent of which
  // node (if any) failed to answer the aggregate.
  const requiredTargets = currentTargets(projection);
  const unreachableNodes = [...new Set([
    ...partialNodes,
    ...requiredTargets.filter(target => target.connectivity === 'unreachable').map(target => target.nodeId),
  ])];
  const unrecognized = hasUnrecognizedStatus(projection, requiredTargets);
  const missingTargetEvidence = requiredTargets.length === 0;
  const targetSetMismatch = !targetSetIsCurrent(projection, requiredTargets);
  const unknownTargetEvidence = requiredTargets.some(target => target.connectivity === 'unknown');
  const staleTargetEvidence = requiredTargets.some(target => target.connectivity === 'stale');
  const generationProofMissing = claimsSettledConvergence(projection)
    && requiredTargets.length > 0
    && requiredTargets.every(target => target.connectivity === 'reachable')
    && !hasSettledGenerationProof(projection, requiredTargets);
  const sourceModeMismatch = !sourceModeIsCompatible(projection);
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
    runtimeStatus: worstTargetStatus(requiredTargets, 'runtime', RUNTIME_RANK, UNKNOWN_RUNTIME_RANK),
    healthStatus: worstTargetStatus(requiredTargets, 'health', HEALTH_RANK, UNKNOWN_HEALTH_RANK),
    targets: targetSummaries(projection, nodeNames),
    drift: { count: activeDrift.length, classes: driftClasses },
    attention: attentionReasons(projection),
    posture: postureOf(projection),
    availableActions: projection.availableActions,
    limitations: projection.limitations.map(limitation => limitation.code),
    lastActivityAt,
    evidence: {
      partial: unreachableNodes.length > 0 || missingTargetEvidence || targetSetMismatch || staleTargetEvidence || unknownTargetEvidence || generationProofMissing || sourceModeMismatch || unrecognized,
      unreachableNodes,
      unknown: missingTargetEvidence || targetSetMismatch || unknownTargetEvidence || generationProofMissing || sourceModeMismatch || unrecognized,
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
        (requirement) => satisfiesGitOpsRead(req, requirement),
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

function isFutureRolloutAuthorizationBinding(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.rolloutCandidateId)
    && isNonEmptyString(value.acceptedGenerationId)
    && isNonEmptyString(value.artifactSetId)
    && isNonEmptyString(value.intentRevisionId)
    && isNonEmptyString(value.sourceAcceptanceRef)
    && isNonEmptyString(value.placementApprovalRef)
    && isNonEmptyString(value.preflightFingerprint)
    && Array.isArray(value.requiredNodeIds)
    && value.requiredNodeIds.every(nodeId => typeof nodeId === 'number' && Number.isSafeInteger(nodeId));
}

function isPlacementFacetRecord(placement: Record<string, unknown>): boolean {
  switch (placement.status) {
    case 'not_applicable':
    case 'unbound_direct':
    case 'placement_review_pending':
    case 'stateful_confirmation_required':
      return true;
    case 'unknown':
      return placement.limitation === 'missing_intent';
    case 'source_acceptance_pending':
      return isNullableString(placement.sourceAcceptanceRef) && isNonEmptyString(placement.candidateGenerationId);
    case 'rollout_authorization_pending':
      return placement.rolloutAuthorizationRef === null && isFutureRolloutAuthorizationBinding(placement.binding);
    case 'rollout_authorization_stale':
      return isNonEmptyString(placement.rolloutAuthorizationRef) && isFutureRolloutAuthorizationBinding(placement.bound);
    case 'preflight_blocked':
      return typeof placement.reason === 'string' && isFutureRolloutAuthorizationBinding(placement.binding);
    case 'blueprint_bound':
      return placement.completion === 'unknown';
    default:
      return true;
  }
}

function isSourceFacetRecord(source: Record<string, unknown>): boolean {
  if (source.status === 'not_applicable') return true;
  if (
    typeof source.configuredRepoUrl !== 'string'
    || typeof source.configuredRef !== 'string'
    || !isRecord(source.repoIdentity)
    || typeof source.repoIdentity.host !== 'string'
    || typeof source.repoIdentity.pathname !== 'string'
    || typeof source.desiredCommitSha !== 'string' && source.desiredCommitSha !== null
    || typeof source.fetchedCommitSha !== 'string' && source.fetchedCommitSha !== null
    || typeof source.candidateGenerationId !== 'string' && source.candidateGenerationId !== null
    || typeof source.acceptedGenerationId !== 'string' && source.acceptedGenerationId !== null
  ) return false;
  if (source.status === 'source_poll_scheduled') {
    return typeof source.nextPollAt === 'number' && Number.isFinite(source.nextPollAt);
  }
  return source.status !== 'application_generation_accepted' || typeof source.acceptedGenerationId === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNullableString(value: unknown): boolean {
  return typeof value === 'string' || value === null;
}

function isFiniteNumberOrNull(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) || value === null;
}

function isApprovalRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && isNullableString(value.sourceAcceptanceRef)
    && isNullableString(value.placementApprovalRef)
    && isNullableString(value.rolloutAuthorizationRef)
    && isNullableString(value.legacyCombinedApprovalRef);
}

function isServiceArtifactRecord(value: unknown): value is ServiceArtifactEvidence {
  if (!isRecord(value) || !isNonEmptyString(value.serviceName) || !isNullableString(value.authoredRef)) return false;
  if (typeof value.source !== 'string' || !ARTIFACT_SERVICE_SOURCES.has(value.source)) return false;
  if (!isNullableString(value.platform) || !isNullableString(value.indexDigest) || !isNullableString(value.platformDigest)) return false;
  if (value.platformVariants !== undefined && value.platformVariants !== null) {
    if (!Array.isArray(value.platformVariants)) return false;
    const variants = value.platformVariants;
    const platforms = new Set<string>();
    let previousPlatform = '';
    for (const variant of variants) {
      if (!isRecord(variant) || !isNonEmptyString(variant.platform) || !isNonEmptyString(variant.digest)) return false;
      if (platforms.has(variant.platform) || previousPlatform.localeCompare(variant.platform) > 0) return false;
      platforms.add(variant.platform);
      previousPlatform = variant.platform;
    }
  }
  if (value.localDigests !== undefined && value.localDigests !== null) {
    if (!Array.isArray(value.localDigests)) return false;
    const digests = new Set<string>();
    let previousDigest = '';
    for (const digest of value.localDigests) {
      if (!isNonEmptyString(digest)) return false;
      const key = digest.toLowerCase();
      if (digests.has(key) || previousDigest.localeCompare(digest) > 0) return false;
      digests.add(key);
      previousDigest = digest;
    }
  }
  return isNullableString(value.buildContextFingerprint)
    && isNullableString(value.producedImageId)
    && (value.failureClass === null
      || typeof value.failureClass === 'string' && ARTIFACT_SERVICE_FAILURE_CLASSES.has(value.failureClass))
    && isFiniteNumberOrNull(value.resolvedAt);
}

function serviceEvidenceEquivalent(left: ServiceArtifactEvidence, right: ServiceArtifactEvidence): boolean {
  const leftVariants = left.platformVariants ?? [];
  const rightVariants = right.platformVariants ?? [];
  const leftDigests = left.localDigests ?? [];
  const rightDigests = right.localDigests ?? [];
  return left.serviceName === right.serviceName
    && left.authoredRef === right.authoredRef
    && left.source === right.source
    && left.platform === right.platform
    && left.indexDigest === right.indexDigest
    && left.platformDigest === right.platformDigest
    && left.buildContextFingerprint === right.buildContextFingerprint
    && left.producedImageId === right.producedImageId
    && left.failureClass === right.failureClass
    && left.resolvedAt === right.resolvedAt
    && leftVariants.length === rightVariants.length
    && leftVariants.every((variant, index) => variant.platform === rightVariants[index]?.platform && variant.digest === rightVariants[index]?.digest)
    && leftDigests.length === rightDigests.length
    && leftDigests.every((digest, index) => digest === rightDigests[index]);
}

function servicesEquivalent(left: readonly ServiceArtifactEvidence[], right: readonly ServiceArtifactEvidence[]): boolean {
  if (left.length !== right.length) return false;
  const canonicalLeft = canonicalizeServiceEvidence(left);
  const canonicalRight = canonicalizeServiceEvidence(right);
  return canonicalLeft.every((service, index) => serviceEvidenceEquivalent(service, canonicalRight[index]!));
}

function isServiceEvidenceList(value: unknown): value is ServiceArtifactEvidence[] {
  if (!Array.isArray(value) || !value.every(isServiceArtifactRecord)) return false;
  const names = new Set<string>();
  let previousName = '';
  for (const service of value) {
    if (names.has(service.serviceName) || previousName.localeCompare(service.serviceName) > 0) return false;
    names.add(service.serviceName);
    previousName = service.serviceName;
  }
  return true;
}

function isArtifactExpectedRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && isNonEmptyString(value.artifactSetId)
    && typeof value.evidenceVersion === 'number'
    && Number.isFinite(value.evidenceVersion)
    && typeof value.qualification === 'string'
    && ARTIFACT_QUALIFICATIONS.has(value.qualification)
    && (value.identity === null || typeof value.identity === 'string' && value.identity.length > 0)
    && (value.services === undefined || (
      isServiceEvidenceList(value.services)
    ));
}

function isTargetArtifactRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && typeof value.status === 'string'
    && Object.prototype.hasOwnProperty.call(FACET_EVIDENCE_SOURCE.artifact, value.status)
    && (value.expected === undefined || value.expected === null || isArtifactExpectedRecord(value.expected))
    && isArtifactFacetRecord(value);
}

function isObservedArtifactIdentityRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.services !== undefined && !isServiceEvidenceList(value.services)) return false;
  if (value.kind === 'unknown' || value.kind === 'missing' || value.kind === 'unavailable') return true;
  if (!OBSERVED_ARTIFACT_KINDS.has(value.kind)) return false;
  return typeof value.identity === 'string'
    && value.identity.length > 0
    && typeof value.observedAt === 'number'
    && Number.isFinite(value.observedAt);
}

function isLkgRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.status !== 'string') return false;
  if (value.status === 'none' || value.status === 'unavailable') return true;
  if (value.status === 'available') {
    return isNonEmptyString(value.generationId)
      && (value.artifactSetId === null || isNonEmptyString(value.artifactSetId));
  }
  if (value.status === 'qualified') {
    return isNonEmptyString(value.generationId) && isNonEmptyString(value.artifactSetId);
  }
  return false;
}

function isHealthRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.status !== 'string') return false;
  if (value.status === 'not_applicable' || value.status === 'unbound') return true;
  if (value.status === 'pending') return isNullableString(value.runId);
  if (value.status === 'unknown') {
    return isNullableString(value.runId) && value.limitation === 'health_unknown';
  }
  if (value.status === 'checking' || value.status === 'failed') {
    return typeof value.runId === 'string' && isNullableString(value.deployedGenerationId);
  }
  if (value.status === 'passed') {
    return typeof value.runId === 'string' && typeof value.deployedGenerationId === 'string';
  }
  return true;
}

function lkgMirrorsAreConsistent(lkg: unknown, value: Record<string, unknown>): boolean {
  if (!isRecord(lkg)) return false;
  const unavailableAt = value.lkgUnavailableAt;
  const unavailableReason = value.lkgUnavailableReason;
  const generationId = value.lkgGenerationId;
  const artifactSetId = value.lkgArtifactSetId;
  if (unavailableAt === null) {
    if (unavailableReason !== null) return false;
  } else if (unavailableReason === null || generationId !== null || artifactSetId !== null) {
    return false;
  }
  if (lkg.status === 'none') {
    return generationId === null && artifactSetId === null && unavailableAt === null;
  }
  if (lkg.status === 'unavailable') {
    return unavailableAt !== null || generationId !== null;
  }
  return unavailableAt === null
    && unavailableReason === null
    && lkg.generationId === generationId
    && lkg.artifactSetId === artifactSetId;
}

function isTargetRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && isRecord(value.runtime)
    && isHealthRecord(value.health)
    && isTargetArtifactRecord(value.artifact)
    && isObservedArtifactIdentityRecord(value.observedArtifactIdentity)
    && isLkgRecord(value.lkg)
    && isApprovalRecord(value.approvals)
    && typeof value.nodeId === 'number'
    && Number.isFinite(value.nodeId)
    && (typeof value.stackName === 'string' || value.stackName === null)
    && typeof value.tombstoned === 'boolean'
    && typeof value.connectivity === 'string'
    && TARGET_GENERATION_FIELDS.every(field => typeof value[field] === 'string' || value[field] === null)
    && (typeof value.legacyAppliedRevision === 'number' && Number.isFinite(value.legacyAppliedRevision)
      || value.legacyAppliedRevision === null)
    && isFiniteNumberOrNull(value.lkgUnavailableAt)
    && (value.lkgUnavailableReason === null || (
      typeof value.lkgUnavailableReason === 'string'
      && LKG_UNAVAILABLE_REASONS.has(value.lkgUnavailableReason)
    ))
    && lkgMirrorsAreConsistent(value.lkg, value)
    && typeof value.runtime.status === 'string';
}

function isIdentityRefRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'none':
    case 'unknown':
      return true;
    case 'commit':
      return isNonEmptyString(value.sha)
        && isNonEmptyString(value.repoUrl)
        && isNonEmptyString(value.ref);
    case 'generation':
    case 'rollout_candidate':
    case 'rollout_generation':
      return isNonEmptyString(value.id);
    case 'artifact_set':
      return isNonEmptyString(value.id)
        && typeof value.qualification === 'string'
        && ARTIFACT_QUALIFICATIONS.has(value.qualification)
        && typeof value.evidenceVersion === 'number'
        && Number.isFinite(value.evidenceVersion);
    case 'runtime_artifact':
      return isNonEmptyString(value.identity) && isFiniteNumberOrNull(value.observedAt);
    case 'intent':
      return isNonEmptyString(value.id) && isNonEmptyString(value.composeContentSha256);
    case 'invocation':
      return isRecord(value.authored)
        && Array.isArray(value.authored.composeFileOrder)
        && value.authored.composeFileOrder.every(item => typeof item === 'string')
        && isNullableString(value.authored.projectName)
        && isNullableString(value.authored.projectDirectory)
        && Array.isArray(value.authored.envFileOrder)
        && value.authored.envFileOrder.every(item => typeof item === 'string');
    case 'health_run':
      return isNonEmptyString(value.runId)
        && (value.deployedGenerationId === null || isNonEmptyString(value.deployedGenerationId));
    default:
      return false;
  }
}

function isConfiguredPolicyRecord(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (value.kind === 'git_source') {
    return typeof value.autoApplyOnWebhook === 'boolean' && typeof value.autoDeployOnApply === 'boolean';
  }
  if (value.kind === 'blueprint_drift') {
    return value.driftMode === 'observe' || value.driftMode === 'suggest' || value.driftMode === 'enforce';
  }
  return false;
}

function isDriftItemRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && typeof value.class === 'string'
    && DRIFT_CLASSES.has(value.class)
    && isIdentityRefRecord(value.expected)
    && isIdentityRefRecord(value.observed)
    && isFiniteNumberOrNull(value.freshnessAt)
    && typeof value.owner === 'string'
    && typeof value.reason === 'string'
    && isConfiguredPolicyRecord(value.configuredPolicy)
    && typeof value.action === 'string'
    && AVAILABLE_ACTIONS.has(value.action)
    && Array.isArray(value.affectedTargets)
    && value.affectedTargets.every(target => (
      isRecord(target)
      && (typeof target.nodeId === 'number' && Number.isFinite(target.nodeId) || target.nodeId === null)
      && (typeof target.stackName === 'string' || target.stackName === null)
    ));
}

function isArtifactFacetRecord(artifact: Record<string, unknown>): boolean {
  if (artifact.status !== 'artifact_exact' && artifact.status !== 'artifact_qualified') return true;
  const qualification = artifact.status === 'artifact_exact' ? 'exact' : 'qualified';
  if (
    !isNonEmptyString(artifact.artifactSetId)
    || !isNonEmptyString(artifact.generationId)
    || typeof artifact.evidenceVersion !== 'number'
    || !Number.isFinite(artifact.evidenceVersion)
    || artifact.qualification !== qualification
    || typeof artifact.freshnessAt !== 'number'
    || !Number.isFinite(artifact.freshnessAt)
    || artifact.expected !== null && !isArtifactExpectedRecord(artifact.expected)
    || !isRecord(artifact.latestEvidence)
    || !isNonEmptyString(artifact.latestEvidence.artifactSetId)
    || artifact.latestEvidence.artifactSetId !== artifact.artifactSetId
    || typeof artifact.latestEvidence.evidenceVersion !== 'number'
    || !Number.isFinite(artifact.latestEvidence.evidenceVersion)
    || artifact.latestEvidence.evidenceVersion !== artifact.evidenceVersion
    || artifact.latestEvidence.qualification !== qualification
    || typeof artifact.latestEvidence.identity !== 'string'
    || artifact.latestEvidence.identity.length === 0
  ) return false;
  if (artifact.expected === null) return true;
  return !(
    (artifact.expected.qualification === 'exact' || artifact.expected.qualification === 'qualified')
    && typeof artifact.expected.identity === 'string'
    && typeof artifact.latestEvidence.identity === 'string'
    && artifact.expected.identity !== artifact.latestEvidence.identity
  );
}

function isSettledRolloutRecord(rollout: Record<string, unknown>, generationId: unknown): boolean {
  if (typeof rollout.status !== 'string' || !SETTLED_ROLLOUT_ARTIFACT.has(rollout.status)) return true;
  return isNonEmptyString(generationId) && isNonEmptyString(rollout.rolloutGenerationId);
}

/**
 * Whether a value looks like a walkable live projection.
 *
 * Narrows to the live arm of the union: the sentinel variant carries no facets
 * and must take the unknown-evidence path instead, so a caller can read
 * `facets`/`targets` after this guard without another discriminant check.
 */
export function isUsableRevision(value: unknown): value is Extract<GitOpsRevisionProjection, { applicationId: string }> {
  if (!isRecord(value)) return false;
  const mode = value.targetMode;
  if (mode !== 'direct' && mode !== 'blueprint' && mode !== 'inline_blueprint') return false;
  if (value.schemaVersion !== 1 || !isNonEmptyString(value.applicationId)) return false;
  if (
    !isNonEmptyString(value.lifecycleStatus)
    || !isApprovalRecord(value.approvals)
    || value.rolloutGenerationId !== null && !isNonEmptyString(value.rolloutGenerationId)
  ) return false;
  if (!hasValidModeShape(value)) return false;
  if (
    !Array.isArray(value.targets)
    || !Array.isArray(value.drift)
    || !Array.isArray(value.limitations)
    || !Array.isArray(value.availableActions)
  ) return false;

  const facets = value.facets;
  if (
    !isRecord(facets)
    || !isRecord(facets.source)
    || !isRecord(facets.artifact)
    || !isRecord(facets.placement)
    || !isRecord(facets.rollout)
  ) return false;
  if (![facets.source, facets.artifact, facets.placement, facets.rollout].every(facet => typeof facet.status === 'string')) return false;
  return isSourceFacetRecord(facets.source)
    && value.targets.every(isTargetRecord)
    && isPlacementFacetRecord(facets.placement)
    && value.drift.every(isDriftItemRecord)
    && value.limitations.every(item => (
      isRecord(item)
      && typeof item.code === 'string'
      && typeof item.message === 'string'
      && Object.hasOwn(item, 'evidence')
    ))
    && value.availableActions.every(item => typeof item === 'string' && AVAILABLE_ACTIONS.has(item))
    && isArtifactFacetRecord(facets.artifact)
    && isSettledRolloutRecord(facets.rollout, value.rolloutGenerationId);
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
function remotePortfolioRow(
  row: unknown,
  nodeId: number,
  nodeName: string | null,
  nodeNames: Map<number, string | null>,
): GitOpsPortfolioRow | null {
  if (!isRecord(row)) return null;
  const revision = isUsableRevision(row.gitopsRevision) ? row.gitopsRevision : null;
  const stackName = typeof row.stack_name === 'string' ? row.stack_name : null;
  if (revision === null) {
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
