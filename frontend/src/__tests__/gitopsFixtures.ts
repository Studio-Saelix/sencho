// Builders for GitOps revision projections in tests.
//
// A full projection is roughly forty fields across four facets and a target, so
// hand-rolling one per suite is both noise and a place for drift. Not a suite
// itself: vitest collects only *.test.* / *.spec.*.

import type {
  GitOpsApprovalRefs,
  GitOpsFacets,
  GitOpsLimitation,
  GitOpsRevisionAbsent,
  GitOpsRevisionLive,
  GitOpsTargetProjection,
  SourceFacet,
  SourceIdentityFields,
} from '@/types/gitops';

/** The source statuses that carry identity fields and nothing else. Covers every state this slice renders. */
type PlainSourceStatus =
  | 'never_reconciled'
  | 'checking_fetching'
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

export function facets(overrides: Partial<GitOpsFacets> = {}): GitOpsFacets {
  return {
    source: plainSource('candidate_ready'),
    artifact: { status: 'not_applicable' },
    placement: { status: 'unbound_direct' },
    rollout: { status: 'not_applicable' },
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
