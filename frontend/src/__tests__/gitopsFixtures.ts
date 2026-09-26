// Builders for GitOps revision projections in tests.
//
// A full projection is roughly forty fields across four facets and a target, so
// hand-rolling one per suite is both noise and a place for drift. Not a suite
// itself: vitest collects only *.test.* / *.spec.*.

import type {
  ArtifactFacet,
  GitOpsApprovalRefs,
  GitOpsDriftItem,
  GitOpsFacets,
  GitOpsLimitation,
  GitOpsRevisionAbsent,
  GitOpsRevisionLive,
  GitOpsTargetProjection,
  SourceFacet,
  SourceIdentityFields,
} from '@/types/gitops';
import type { GitOpsPortfolioRow, GitOpsPortfolioTargetSummary } from '@/types/gitopsPortfolio';

/**
 * The candidate-bearing source statuses, which are the ones this slice renders.
 *
 * Narrower than the set that structurally fits: the identity defaults below
 * describe a stack that has fetched and accepted a commit, which is a state
 * `never_reconciled` and `checking_fetching` cannot be in. Building those from
 * here would produce a fixture no backend could emit.
 */
export type PlainSourceStatus =
  | 'application_generation_accepted'
  | 'candidate_ready'
  | 'source_review_pending'
  | 'source_conflict_blocker'
  | 'source_reconcile_required';

export const noApprovals: GitOpsApprovalRefs = {
  sourceAcceptanceRef: null,
  placementApprovalRef: null,
  rolloutAuthorizationRef: null,
  legacyCombinedApprovalRef: null,
};

export function sourceIdentity(overrides: Partial<SourceIdentityFields> = {}): SourceIdentityFields {
  return {
    configuredRepoUrl: 'https://example.test/acme/infra.git',
    repoIdentity: { host: 'example.test', pathname: '/acme/infra' },
    configuredRef: 'main',
    desiredCommitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    fetchedCommitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    candidateGenerationId: 'gen-candidate',
    acceptedGenerationId: 'gen-accepted',
    ...overrides,
  };
}

/** A source facet with a waiting candidate by default. Pass `candidateGenerationId: null` for the accepted case. */
export function plainSource(
  status: PlainSourceStatus,
  overrides: Partial<SourceIdentityFields> = {},
): SourceFacet {
  return { ...sourceIdentity(overrides), status };
}

export function target(overrides: Partial<GitOpsTargetProjection> = {}): GitOpsTargetProjection {
  return {
    nodeId: 1,
    stackName: 'bookstack',
    desiredGenerationId: 'gen-accepted',
    candidateGenerationId: null,
    appliedGenerationId: 'gen-accepted',
    deployedGenerationId: 'gen-accepted',
    healthyGenerationId: 'gen-accepted',
    lkgGenerationId: null,
    lkgArtifactSetId: null,
    lkgUnavailableAt: null,
    lkgUnavailableReason: null,
    expectedArtifactSetId: null,
    latestArtifactSetId: null,
    artifact: { status: 'not_applicable' },
    observedArtifactIdentity: { kind: 'unknown' },
    intentRevisionId: null,
    rolloutCandidateId: null,
    rolloutGenerationId: null,
    approvals: noApprovals,
    connectivity: 'reachable',
    legacyAppliedRevision: null,
    runtime: { status: 'synced_and_healthy' },
    health: { status: 'not_applicable' },
    lkg: { status: 'none' },
    tombstoned: false,
    ...overrides,
  };
}

/**
 * One classified divergence. The fixture shapes itself after the runtime
 * artifact mismatch the backend has always emitted, so it stays the simplest
 * complete item; every class shares the same shape.
 */
export function driftItem(overrides: Partial<GitOpsDriftItem> = {}): GitOpsDriftItem {
  return {
    class: 'runtime',
    expected: { kind: 'artifact_set', id: 'art-accepted', qualification: 'exact', evidenceVersion: 1 },
    observed: { kind: 'runtime_artifact', identity: 'nginx@sha256:abc', observedAt: 1 },
    freshnessAt: 1,
    owner: 'observed_artifact_identity',
    reason: 'the running workload reports an artifact identity other than the expected artifact set',
    configuredPolicy: null,
    affectedTargets: [{ nodeId: 1, stackName: 'bookstack' }],
    action: 'none',
    ...overrides,
  };
}

export function facets(overrides: Partial<GitOpsFacets> = {}): GitOpsFacets {
  return {
    source: plainSource('candidate_ready'),
    artifact: { status: 'not_applicable' },
    placement: { status: 'unbound_direct' },
    rollout: { status: 'not_applicable' },
    ...overrides,
  };
}

type LiveArtifactFacet = Extract<ArtifactFacet, { artifactSetId: string }>;

/** A live exact artifact facet. Expected and latest evidence share one identity unless overridden. */
export function liveArtifact(overrides: Partial<LiveArtifactFacet> = {}): LiveArtifactFacet {
  const identity = 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  return {
    status: 'artifact_exact',
    artifactSetId: 'art-1',
    generationId: 'gen-accepted',
    evidenceVersion: 1,
    qualification: 'exact',
    freshnessAt: 1,
    expected: {
      artifactSetId: 'art-1',
      evidenceVersion: 1,
      qualification: 'exact',
      identity,
    },
    latestEvidence: {
      artifactSetId: 'art-1',
      evidenceVersion: 1,
      qualification: 'exact',
      identity,
    },
    ...overrides,
  };
}

/** A live Direct application with one healthy target and a candidate waiting. */
export function liveRevision(overrides: Partial<GitOpsRevisionLive> = {}): GitOpsRevisionLive {
  return {
    schemaVersion: 1,
    targetMode: 'direct',
    applicationId: 'app-1',
    lifecycleStatus: 'active',
    stackName: 'bookstack',
    blueprintId: null,
    rolloutGenerationId: null,
    approvals: noApprovals,
    facets: facets(),
    targets: [target()],
    drift: [],
    limitations: [],
    availableActions: ['apply', 'dismiss'],
    ...overrides,
  };
}

/**
 * The common case in the consumer suites: a live Direct application whose Git
 * source sits in one named state. Pass `candidateGenerationId: null` for the
 * variants that must have no candidate waiting behind that state.
 */
export function sourceRevision(
  status: PlainSourceStatus,
  overrides: Partial<SourceIdentityFields> = {},
): GitOpsRevisionLive {
  return liveRevision({ facets: facets({ source: plainSource(status, overrides) }) });
}

/** Nothing to project. Pass limitations for the fault case; empty is the ordinary one. */
export function absentRevision(limitations: GitOpsLimitation[] = []): GitOpsRevisionAbsent {
  return {
    schemaVersion: 1,
    targetMode: 'not_applicable',
    applicationId: null,
    facets: null,
    targets: [],
    drift: [],
    limitations,
    availableActions: [],
    approvals: null,
  };
}

export const missingApplicationLimitation: GitOpsLimitation = {
  code: 'application_row_missing',
  message: 'The application row backing this stack could not be read, so its GitOps state cannot be reported.',
  evidence: { applicationId: 'app-1' },
};

/**
 * One row of the hub-owned portfolio, which is where the canonical posture
 * lives.
 *
 * Separate from `liveRevision` because the two answer different questions and
 * the distinction is the point: a revision is one node's own view, while this
 * row is the settled or unsettled answer computed across every node holding a
 * target. A test that builds only one of them cannot tell whether a surface
 * read the canonical posture or re-derived its own.
 */
export function portfolioRow(overrides: Partial<GitOpsPortfolioRow> = {}): GitOpsPortfolioRow {
  return {
    id: '1:app-1',
    targetMode: 'direct',
    name: 'bookstack',
    stackName: 'bookstack',
    blueprintId: null,
    nodeId: 1,
    nodeName: 'local',
    repository: {
      configuredRepoUrl: 'https://github.com/example/repo.git',
      host: 'github.com',
      pathname: '/example/repo.git',
      configuredRef: 'main',
    },
    desiredCommitSha: 'abc123',
    fetchedCommitSha: 'abc123',
    candidateGenerationId: null,
    acceptedGenerationId: 'gen-1',
    sourceStatus: 'application_generation_accepted',
    artifactStatus: 'artifact_exact',
    artifactQualification: 'exact',
    placementStatus: 'unbound_direct',
    rolloutStatus: 'not_applicable',
    runtimeStatus: 'synced_and_healthy',
    healthStatus: 'passed',
    targets: [portfolioTarget()],
    drift: { count: 0, classes: [] },
    attention: [],
    posture: 'converged',
    availableActions: [],
    limitations: [],
    lastActivityAt: 1,
    evidence: { partial: false, unreachableNodes: [], unknown: false },
    ...overrides,
  };
}

export function portfolioTarget(overrides: Partial<GitOpsPortfolioTargetSummary> = {}): GitOpsPortfolioTargetSummary {
  return {
    nodeId: 1,
    nodeName: 'local',
    stackName: 'bookstack',
    runtime: 'synced_and_healthy',
    health: 'passed',
    connectivity: 'reachable',
    tombstoned: false,
    evidence: 'fresh',
    ...overrides,
  };
}
