// Mirrors the backend GitOps read contract (the frontend never imports backend).
// Source of truth: backend/src/services/gitops/types.ts.
//
// Two conventions run through the whole contract and are worth knowing before
// reading further. Nothing is optional: absence on the wire is `null`, and a
// shape that cannot carry a field omits the key entirely rather than sending
// undefined. And every status union is closed, so a `Record<Status, ...>` built
// over one (see lib/gitopsState.ts) stops compiling as soon as a member is
// added here. Nothing detects a backend change on its own: this file is
// hand-written, so widening it is the step that surfaces the missing cases.

// --- scalars and closed enums ---------------------------------------------

export type GitOpsTargetMode = 'direct' | 'inline_blueprint' | 'blueprint';

export type GitOpsLifecycleStatus = 'active' | 'creating' | 'detached' | 'deleted';

export type ArtifactQualification =
  | 'unresolved'
  | 'exact'
  | 'qualified'
  | 'stale'
  | 'unavailable'
  | 'local_build_unverified';

export type Connectivity = 'unknown' | 'reachable' | 'unreachable' | 'stale';

export type LkgUnavailableReason = 'generation_missing' | 'recovery_unretainable';

export type GitOpsAvailableAction = 'fetch' | 'apply' | 'dismiss' | 'deploy' | 'approve_legacy' | 'none';

// --- limitations ------------------------------------------------------------

/**
 * A fact the projection could not establish, carried alongside the answer
 * instead of dropped.
 *
 * `code` is an open string by contract, not a closed union: the backend adds
 * codes without a schema bump, so a reader that switches exhaustively on it
 * silently stops rendering the newest ones. Render `message`, which is already
 * written for an operator, and use `code` only to group.
 *
 * Whether a limitation is a fault is decided by which arm of the projection
 * carries it, not by its code: see absentFault in lib/gitopsState.ts.
 */
export interface GitOpsLimitation {
  code: string;
  message: string;
  evidence: unknown;
}

// --- identity ---------------------------------------------------------------

/** Secret-free repository identity. Both fields degrade to '' when the stored identity is absent or malformed. */
export interface RepoIdentity {
  host: string;
  pathname: string;
}

export interface AuthoredInvocationIdentity {
  composeFileOrder: string[];
  projectName: string | null;
  projectDirectory: string | null;
  envFileOrder: string[];
}

/** One side of a drift comparison: what a thing is identified by, whatever kind of thing it is. */
export type GitOpsIdentityRef =
  | { kind: 'none' }
  | { kind: 'unknown' }
  | { kind: 'commit'; sha: string; repoUrl: string; ref: string }
  | { kind: 'generation'; id: string }
  | { kind: 'artifact_set'; id: string; qualification: ArtifactQualification; evidenceVersion: number }
  | { kind: 'runtime_artifact'; identity: string; observedAt: number | null }
  | { kind: 'intent'; id: string; composeContentSha256: string }
  | { kind: 'rollout_candidate'; id: string }
  | { kind: 'rollout_generation'; id: string }
  | { kind: 'invocation'; authored: AuthoredInvocationIdentity }
  | { kind: 'health_run'; runId: string; deployedGenerationId: string | null };

export interface GitOpsApprovalRefs {
  sourceAcceptanceRef: string | null;
  placementApprovalRef: string | null;
  rolloutAuthorizationRef: string | null;
  legacyCombinedApprovalRef: string | null;
}

// --- source facet -----------------------------------------------------------

export interface SourceIdentityFields {
  configuredRepoUrl: string;
  repoIdentity: RepoIdentity;
  configuredRef: string;
  desiredCommitSha: string | null;
  fetchedCommitSha: string | null;
  // Set while a fetched candidate is waiting, and kept as a frozen fact after
  // the application is retired. This, not the status, is what "a Git update is
  // waiting" means for a live application: source_reconcile_required is
  // reachable both with a candidate and from an accepted generation without
  // one. See pendingSourceStatus, which reads both this and the lifecycle.
  candidateGenerationId: string | null;
  acceptedGenerationId: string | null;
}

/**
 * What the Git source is doing. `not_applicable` is the Inline Blueprint case:
 * a Blueprint application has no Git source, and reporting one would be a claim
 * the model never made.
 */
export type SourceFacet =
  | { status: 'not_applicable' }
  | (SourceIdentityFields & {
      status:
        | 'never_reconciled'
        | 'checking_fetching'
        | 'application_generation_accepted'
        | 'candidate_ready'
        | 'source_review_pending'
        | 'source_conflict_blocker'
        | 'source_reconcile_required';
    })
  | (SourceIdentityFields & { status: 'source_superseded'; supersededGenerationId: string })
  | (SourceIdentityFields & { status: 'applying'; activeOperationId: string; activeGenerationId: string })
  | (SourceIdentityFields & { status: 'source_retry_scheduled'; retryAt: number; retryCount: number })
  | (SourceIdentityFields & { status: 'source_suspended'; suspendedAt: number; suspendedReason: string | null })
  | (SourceIdentityFields & {
      status: 'source_failed';
      failureStage: 'fetch' | 'validation' | 'apply' | 'create';
      failureClass: string;
      failureAt: number;
      retryAt: number | null;
      retryCount: number;
    })
  | (SourceIdentityFields & {
      status: 'source_unknown';
      interruptedStage: 'fetch_started' | 'apply_started';
      interruptedAt: number;
      interruptedOperationId: string | null;
      interruptedGenerationId: string | null;
    })
  | (SourceIdentityFields & {
      status: 'recovery_required';
      recoveryRef: string | null;
      recoveryGenerationId: string | null;
    })
  | (SourceIdentityFields & {
      status: 'recovery_failed';
      recoveryRef: string | null;
      recoveryGenerationId: string | null;
      failureClass: string;
      failureAt: number;
    })
  | (SourceIdentityFields & { status: 'not_live'; lifecycleStatus: 'detached' | 'deleted' });

export type GitOpsSourceStatus = SourceFacet['status'];

// --- artifact facet ---------------------------------------------------------

export interface ArtifactExpectedIdentity {
  artifactSetId: string;
  evidenceVersion: number;
  qualification: ArtifactQualification;
  identity: string | null;
}

export interface ArtifactLatestEvidence {
  artifactSetId: string;
  evidenceVersion: number;
  qualification: ArtifactQualification;
  identity: string | null;
}

/**
 * `artifact_unresolved` appears in two members. Discriminate on
 * `latestEvidence === null`, not on the status alone: the null-evidence member
 * is the missing-pointer variant and carries no set id or freshness.
 */
export type ArtifactFacet =
  | { status: 'not_applicable' }
  | {
      status: 'artifact_unresolved';
      generationId: string;
      expected: ArtifactExpectedIdentity | null;
      latestEvidence: null;
      limitation: 'artifact_pointer_missing';
    }
  | {
      status:
        | 'artifact_unresolved'
        | 'artifact_resolution_pending'
        | 'artifact_exact'
        | 'artifact_qualified'
        | 'artifact_stale'
        | 'artifact_unavailable'
        | 'artifact_local_build_unverified'
        | 'artifact_identity_changed';
      artifactSetId: string;
      generationId: string;
      evidenceVersion: number;
      qualification: ArtifactQualification;
      freshnessAt: number;
      expected: ArtifactExpectedIdentity | null;
      latestEvidence: ArtifactLatestEvidence;
    };

// --- placement and rollout facets -------------------------------------------

export interface FutureRolloutAuthorizationBinding {
  readonly rolloutCandidateId: string;
  readonly acceptedGenerationId: string;
  readonly artifactSetId: string;
  readonly intentRevisionId: string;
  readonly requiredNodeIds: readonly number[];
  readonly sourceAcceptanceRef: string;
  readonly placementApprovalRef: string;
  readonly preflightFingerprint: string;
}

export type PlacementFacet =
  | { status: 'not_applicable' }
  | { status: 'unbound_direct' }
  | { status: 'unknown'; limitation: 'missing_intent' }
  | { status: 'source_acceptance_pending'; sourceAcceptanceRef: string | null; candidateGenerationId: string }
  | { status: 'placement_review_pending' }
  | { status: 'rollout_authorization_pending'; rolloutAuthorizationRef: null; binding: FutureRolloutAuthorizationBinding }
  | { status: 'rollout_authorization_stale'; rolloutAuthorizationRef: string; bound: FutureRolloutAuthorizationBinding }
  | { status: 'stateful_confirmation_required' }
  | { status: 'preflight_blocked'; reason: string; binding: FutureRolloutAuthorizationBinding }
  | { status: 'blueprint_bound'; completion: 'unknown' };

/** `partial` arrives as the stored JSON string, not a parsed object. Nothing decodes it yet. */
export type RolloutFacet =
  | { status: 'not_applicable' }
  | { status: 'rollout_not_executable'; rolloutCandidateId: string }
  | { status: 'rollout_queued'; rolloutGenerationId: string }
  | { status: 'canary_in_progress'; rolloutGenerationId: string }
  | { status: 'batch_in_progress'; rolloutGenerationId: string }
  | { status: 'rollout_paused'; pauseAt: number; pauseReason: string | null }
  | { status: 'partially_rolled_out'; partial: unknown }
  | { status: 'fully_deployed_health_pending'; rolloutGenerationId: string }
  | { status: 'configuration_converged_artifact_qualified'; rolloutGenerationId: string }
  | { status: 'exactly_converged_healthy'; rolloutGenerationId: string }
  | { status: 'rollout_superseded'; rolloutGenerationId: string }
  | { status: 'target_stale' }
  | { status: 'target_unreachable' }
  | { status: 'rollback_in_progress'; recoveryRef: string; recoveryGenerationId: string | null }
  | {
      status: 'rollback_partial_failed';
      recoveryRef: string;
      recoveryGenerationId: string | null;
      failureClass: string;
      failureAt: number;
    }
  | { status: 'recovery_required' }
  | { status: 'completion_unknown' };

// --- per-target facets ------------------------------------------------------

/** What one node is actually doing with the generation it was asked to run. */
export type RuntimeFacet =
  | {
      status:
        | 'tombstoned'
        | 'recovery_required'
        | 'deploying'
        | 'withdrawing'
        | 'failed_previous_workload_intact'
        | 'failed_after_mutation'
        | 'disk_invocation_drift'
        | 'rollout_artifact_drift'
        | 'runtime_artifact_drift'
        | 'artifact_verification_pending'
        | 'never_applied'
        | 'applied_not_deployed'
        | 'acknowledged_completion_unknown'
        | 'stale_acknowledgement'
        | 'pending_state_review'
        | 'evict_blocked'
        | 'drifted'
        | 'correcting'
        | 'fully_deployed_health_pending'
        | 'health_checking'
        | 'synced_and_healthy'
        | 'health_drift'
        | 'partially_rolled_out'
        | 'retry_scheduled';
    }
  | { status: 'paused'; pauseAt: number; pauseReason: string | null }
  | {
      status: 'recovery_failed';
      recoveryRef: string | null;
      recoveryGenerationId: string | null;
      failureClass: string;
      failureAt: number;
    }
  | {
      status: 'completion_unknown';
      interruptedStage: 'deploy_started' | 'blueprint_deploy_started' | 'blueprint_withdraw_started';
      interruptedAt: number;
      interruptedOperationId: string | null;
      interruptedGenerationId: string | null;
      interruptedIntentRevisionId: string | null;
      interruptedRolloutCandidateId: string | null;
    };

export type GitOpsRuntimeStatus = RuntimeFacet['status'];

/** `none` is "never established"; `unavailable` is "established then lost". They are not the same. */
export type LkgFacet =
  | { status: 'none' }
  | { status: 'available'; generationId: string; artifactSetId: string | null }
  | { status: 'unavailable' }
  | { status: 'qualified'; generationId: string; artifactSetId: string };

export type HealthFacet =
  | { status: 'not_applicable' | 'unbound' }
  | { status: 'pending'; runId: string | null }
  | { status: 'checking'; runId: string; deployedGenerationId: string | null }
  | { status: 'passed'; runId: string; deployedGenerationId: string }
  | { status: 'failed'; runId: string; deployedGenerationId: string | null }
  | { status: 'unknown'; runId: string | null; limitation: 'health_unknown' };

/** What was observed running, and how much that observation can be trusted as proof. */
export type ObservedArtifactIdentity =
  | { kind: 'unknown' }
  | { kind: 'missing' }
  | { kind: 'unavailable' }
  | { kind: 'exact'; identity: string; observedAt: number }
  | { kind: 'qualified'; identity: string; observedAt: number }
  | { kind: 'stale'; identity: string; observedAt: number }
  | { kind: 'local_build_unverified'; identity: string; observedAt: number };

// --- application facets, targets, drift -------------------------------------

/** Application-level facets. Runtime, health and LKG are per-target and live on the target instead. */
export interface GitOpsFacets {
  source: SourceFacet;
  artifact: ArtifactFacet;
  placement: PlacementFacet;
  rollout: RolloutFacet;
}

/** One node's copy of the application. Ordered by nodeId ascending. */
export interface GitOpsTargetProjection {
  nodeId: number;
  // Copied from the application, not from the target row.
  stackName: string | null;
  desiredGenerationId: string | null;
  candidateGenerationId: string | null;
  appliedGenerationId: string | null;
  deployedGenerationId: string | null;
  healthyGenerationId: string | null;
  lkgGenerationId: string | null;
  lkgArtifactSetId: string | null;
  lkgUnavailableAt: number | null;
  lkgUnavailableReason: LkgUnavailableReason | null;
  expectedArtifactSetId: string | null;
  latestArtifactSetId: string | null;
  artifact: ArtifactFacet;
  observedArtifactIdentity: ObservedArtifactIdentity;
  intentRevisionId: string | null;
  rolloutCandidateId: string | null;
  rolloutGenerationId: string | null;
  approvals: GitOpsApprovalRefs;
  connectivity: Connectivity;
  legacyAppliedRevision: number | null;
  runtime: RuntimeFacet;
  health: HealthFacet;
  lkg: LkgFacet;
  tombstoned: boolean;
}

export type ConfiguredPolicy =
  | { kind: 'git_source'; autoApplyOnWebhook: boolean; autoDeployOnApply: boolean }
  | { kind: 'blueprint_drift'; driftMode: 'observe' | 'suggest' | 'enforce' }
  | null;

/**
 * A classified divergence between what was intended and what was observed.
 *
 * The backend currently emits one class of item on its own evidence, a runtime
 * artifact mismatch; every other class still needs a producer. An empty list
 * therefore means "no confirmed drift", never "in sync": a state the model was
 * never asked about also answers empty.
 */
export interface GitOpsDriftItem {
  class: 'source' | 'managed_project' | 'invocation' | 'placement' | 'rollout' | 'runtime' | 'health';
  expected: GitOpsIdentityRef;
  observed: GitOpsIdentityRef;
  freshnessAt: number | null;
  owner: string;
  reason: string;
  configuredPolicy: ConfiguredPolicy;
  affectedTargets: Array<{ nodeId: number | null; stackName: string | null }>;
  action: GitOpsAvailableAction;
}

// --- the projection ---------------------------------------------------------

/**
 * Nothing to project.
 *
 * `limitations` carries two different facts and they must not render the same.
 * Empty is the ordinary case: a stack or Blueprint the model was never asked
 * about, and the right rendering is nothing at all. Non-empty is a fault, an
 * application the projection had reason to believe exists and could not reach,
 * and it has to be surfaced.
 *
 * `lifecycleStatus`, `stackName`, `blueprintId` and `rolloutGenerationId` are
 * absent keys rather than nulls, so reaching for one without narrowing first is
 * a compile error instead of an undefined that renders as a blank.
 */
export interface GitOpsRevisionAbsent {
  schemaVersion: 1;
  targetMode: 'not_applicable';
  applicationId: null;
  facets: null;
  targets: readonly [];
  drift: readonly [];
  limitations: readonly GitOpsLimitation[];
  availableActions: readonly [];
  approvals: null;
}

/** A live application. `availableActions` is never empty: "nothing to do" is ['none']. */
export interface GitOpsRevisionLive {
  schemaVersion: 1;
  targetMode: GitOpsTargetMode;
  applicationId: string;
  lifecycleStatus: GitOpsLifecycleStatus;
  stackName: string | null;
  blueprintId: number | null;
  rolloutGenerationId: string | null;
  approvals: GitOpsApprovalRefs;
  facets: GitOpsFacets;
  targets: readonly GitOpsTargetProjection[];
  drift: readonly GitOpsDriftItem[];
  // Caveats on state that is being reported, not faults. The fault codes ride
  // the absent arm above.
  limitations: readonly GitOpsLimitation[];
  availableActions: readonly GitOpsAvailableAction[];
}

/** Narrow on `targetMode === 'not_applicable'`; the live modes are disjoint from it. */
export type GitOpsRevisionProjection = GitOpsRevisionAbsent | GitOpsRevisionLive;

// --- wire carriers ----------------------------------------------------------

/** Responses that describe one application: the git-source reads, drift, blueprint reads and mutations. */
export interface GitOpsRevisionCarrier {
  gitopsRevision: GitOpsRevisionProjection;
}

/**
 * Responses for a write that could move several Blueprints at once: node label
 * add, cordon, uncordon, node delete. Ordered by blueprintId ascending.
 *
 * Empty means both "nothing moved" and "the projection faulted after the write
 * committed", so it can never be reported as the first.
 */
export interface GitOpsRevisionsCarrier {
  gitopsRevisions: readonly GitOpsRevisionProjection[];
}
