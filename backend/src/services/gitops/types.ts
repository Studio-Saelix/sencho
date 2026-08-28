import type { ArtifactEvidenceJson, ObservedArtifactIdentity } from './json';
import type { RepoIdentity } from './repoIdentity';
import type { RefKind } from '../git/types';

export type GitOpsTargetMode = 'direct' | 'inline_blueprint' | 'blueprint';
export type GitOpsLifecycleStatus = 'active' | 'creating' | 'detached' | 'deleted';
export type ArtifactQualification =
  | 'unresolved'
  | 'exact'
  | 'qualified'
  | 'stale'
  | 'unavailable'
  | 'local_build_unverified';

export type GitOpsApprovalKind =
  | 'source_acceptance'
  | 'placement_approval'
  | 'rollout_authorization'
  | 'legacy_combined';

export type GitOpsApprovalAuthority = 'operator' | 'configured_policy' | 'legacy_combined';

export type ApplicationActiveStage = 'fetch_started' | 'apply_started' | 'deploy_started' | 'recovery_started';
export type TargetActiveStage =
  | 'deploy_started'
  | 'blueprint_deploy_started'
  | 'blueprint_withdraw_started'
  | 'recovery_started';
export type RecoveryPhase = 'capturing' | 'restoring' | 'compensating' | 'complete' | 'failed';
export type ApplicationFailureStage = 'fetch' | 'validation' | 'apply' | 'create' | 'recovery';
export type TargetFailureStage = 'deploy' | 'recovery' | 'blueprint_deploy' | 'blueprint_withdraw';
export type Connectivity = 'unknown' | 'reachable' | 'unreachable' | 'stale';
export type LkgUnavailableReason = 'generation_missing' | 'recovery_unretainable';

export type GitOpsApplicationRow = {
  id: string;
  lifecycle_key: string;
  lifecycle_status: GitOpsLifecycleStatus;
  target_mode: GitOpsTargetMode;
  stack_name: string | null;
  blueprint_id: number | null;
  configured_repo_url: string | null;
  repo_identity_json: string | null;
  configured_ref: string | null;
  compose_paths_json: string | null;
  context_dir: string | null;
  sync_env: number | null;
  env_path: string | null;
  materialization_fingerprint: string | null;
  desired_commit_sha: string | null;
  fetched_commit_sha: string | null;
  fetched_resolved_ref_kind: RefKind | null;
  candidate_generation_id: string | null;
  accepted_generation_id: string | null;
  candidate_plan_blocked: number;
  review_required: number;
  artifact_set_id: string | null;
  latest_artifact_set_id: string | null;
  intent_revision_id: string | null;
  rollout_candidate_id: string | null;
  rollout_generation_id: string | null;
  source_acceptance_ref: string | null;
  placement_approval_ref: string | null;
  rollout_authorization_ref: string | null;
  legacy_combined_approval_ref: string | null;
  preflight_fingerprint: string | null;
  latest_operation_id: string | null;
  active_operation_id: string | null;
  active_operation_stage: ApplicationActiveStage | null;
  active_operation_at: number | null;
  active_generation_id: string | null;
  pause_at: number | null;
  pause_reason: string | null;
  partial_json: string | null;
  failure_stage: ApplicationFailureStage | null;
  failure_class: string | null;
  failure_at: number | null;
  retry_at: number | null;
  retry_count: number;
  suspended_at: number | null;
  recovery_ref: string | null;
  recovery_phase: RecoveryPhase | null;
  interruption_stage: ApplicationActiveStage | null;
  interruption_at: number | null;
  interruption_operation_id: string | null;
  interruption_generation_id: string | null;
  evidence_fresh_at: number | null;
  /** Write-time record of what this row could not prove. See json.ts. */
  evidence_limitations_json: string | null;
  created_at: number;
  updated_at: number;
};

/**
 * How far a create-from-Git operation got before it stopped.
 *
 * The phase is what startup uses to decide between finishing the create and
 * tearing it down, so it is advanced only after the durable write it names has
 * actually committed.
 */
export type GitOpsCreatePhase =
  | 'pre_stack'
  | 'stack_created'
  | 'promoting'
  | 'manifest_committed'
  | 'pointers_committed';

export type GitOpsCreateCheckpointRow = {
  application_id: string;
  stack_name: string;
  phase: GitOpsCreatePhase;
  generation_id: string | null;
  operation_id: string;
  repo_url: string;
  branch: string;
  compose_path: string;
  compose_paths_json: string;
  context_dir: string | null;
  sync_env: number;
  env_path: string | null;
  auth_type: string;
  encrypted_token: string | null;
  auto_apply_on_webhook: number;
  auto_deploy_on_apply: number;
  commit_sha: string | null;
  applied_spec_json: string | null;
  /**
   * 1 only when this operation observed the managed root as absent and then
   * created it. Deleting the whole root during cleanup requires that proof.
   */
  created_managed_root: number;
  created_at: number;
  updated_at: number;
};

export type GitOpsGenerationRow = {
  id: string;
  application_id: string;
  commit_sha: string;
  repo_url: string;
  configured_ref: string;
  /** The namespace (branch | tag | sha) the configured ref resolved through. */
  resolved_ref_kind: RefKind | null;
  repo_identity_json: string;
  manifest_version: number;
  candidate_dir: string;
  applied_dir: string;
  expected_invocation_json: string;
  materialization_fingerprint: string;
  validation_ok: number;
  plan_blocked: number;
  change_plan_fingerprint: string | null;
  operation_id: string;
  trigger: string;
  actor: string | null;
  previous_generation_id: string | null;
  redacted_limitations_json: string;
  created_at: number;
};

export type GitOpsArtifactSetRow = {
  id: string;
  generation_id: string;
  evidence_version: number;
  authoritative: number;
  qualification: ArtifactQualification;
  evidence_json: string;
  created_at: number;
};

export type GitOpsIntentRevisionRow = {
  id: string;
  application_id: string;
  blueprint_id: number;
  compose_content_sha256: string;
  blueprint_revision: number;
  deploy_stack_name: string;
  selector_json: string;
  pinned_node_id: number | null;
  cordon_implications_json: string;
  rollout_strategy_json: string;
  runtime_drift_policy: string | null;
  stateful_policy_json: string | null;
  health_failure_rollback_policy_json: string | null;
  operation_id: string;
  actor: string | null;
  created_at: number;
};

export type GitOpsRolloutCandidateRow = {
  id: string;
  application_id: string;
  intent_revision_id: string;
  compose_content_sha256: string;
  accepted_generation_id: string | null;
  artifact_set_id: string | null;
  required_targets_json: string;
  authoritative: number;
  provenance: 'intent_change' | 'roster_change' | 'legacy_inline';
  operation_id: string;
  created_at: number;
};

export type GitOpsApprovalRow = {
  id: string;
  kind: GitOpsApprovalKind;
  authority: GitOpsApprovalAuthority;
  authoritative: number;
  application_id: string;
  generation_id: string | null;
  intent_revision_id: string | null;
  artifact_set_id: string | null;
  rollout_candidate_id: string | null;
  rollout_generation_id: string | null;
  source_acceptance_ref: string | null;
  placement_approval_ref: string | null;
  required_targets_json: string | null;
  preflight_fingerprint: string | null;
  fingerprint: string | null;
  blast_json: string | null;
  policy_provenance_json: string | null;
  actor: string | null;
  created_at: number;
};

export type GitOpsTargetCurrentRow = {
  application_id: string;
  node_id: number;
  target_status: 'active' | 'tombstoned';
  desired_generation_id: string | null;
  candidate_generation_id: string | null;
  applied_generation_id: string | null;
  deployed_generation_id: string | null;
  healthy_generation_id: string | null;
  lkg_generation_id: string | null;
  lkg_artifact_set_id: string | null;
  lkg_unavailable_at: number | null;
  lkg_unavailable_reason: LkgUnavailableReason | null;
  expected_artifact_set_id: string | null;
  latest_artifact_set_id: string | null;
  observed_artifact_identity_json: string | null;
  intent_revision_id: string | null;
  rollout_candidate_id: string | null;
  rollout_generation_id: string | null;
  source_acceptance_ref: string | null;
  placement_approval_ref: string | null;
  rollout_authorization_ref: string | null;
  legacy_combined_approval_ref: string | null;
  legacy_applied_revision: number | null;
  connectivity: Connectivity | null;
  latest_stage: string | null;
  active_operation_id: string | null;
  active_operation_stage: TargetActiveStage | null;
  active_operation_at: number | null;
  active_generation_id: string | null;
  active_intent_revision_id: string | null;
  active_rollout_candidate_id: string | null;
  failure_stage: TargetFailureStage | null;
  failure_class: string | null;
  failure_at: number | null;
  recovery_ref: string | null;
  recovery_generation_id: string | null;
  recovery_phase: RecoveryPhase | null;
  interruption_stage: TargetActiveStage | null;
  interruption_at: number | null;
  interruption_operation_id: string | null;
  interruption_generation_id: string | null;
  interruption_intent_revision_id: string | null;
  interruption_rollout_candidate_id: string | null;
  pause_at: number | null;
  pause_reason: string | null;
  retry_at: number | null;
  suspended_at: number | null;
  partial_json: string | null;
  /** Write-time record of what this target could not prove. See json.ts. */
  evidence_limitations_json: string | null;
  updated_at: number;
};

export type GitOpsHistoryRow = {
  id: string;
  created_at: number;
  application_id: string;
  target_mode: GitOpsTargetMode;
  lifecycle_key: string;
  stack_name: string | null;
  blueprint_id: number | null;
  node_id: number | null;
  dedupe_target: string;
  repo_url: string | null;
  configured_ref: string | null;
  repo_identity_json: string | null;
  commit_sha: string | null;
  generation_id: string | null;
  artifact_set_id: string | null;
  intent_revision_id: string | null;
  rollout_candidate_id: string | null;
  rollout_generation_id: string | null;
  source_acceptance_ref: string | null;
  placement_approval_ref: string | null;
  rollout_authorization_ref: string | null;
  legacy_combined_approval_ref: string | null;
  operation_id: string;
  stage: string;
  outcome: 'committed' | 'failed' | 'skipped' | 'superseded' | 'recovered' | 'unknown';
  trigger: string;
  actor: string | null;
  before_json: string;
  after_json: string;
  required_targets_json: string | null;
  validation_json: string | null;
  per_target_results_json: string | null;
  health_run_id: string | null;
  health_snapshot_json: string | null;
  invocation_observed_json: string | null;
  recovery_ref: string | null;
  redacted_reason_class: string | null;
};

export type FutureRolloutAuthorizationBinding = {
  readonly rolloutCandidateId: string;
  readonly acceptedGenerationId: string;
  readonly artifactSetId: string;
  readonly intentRevisionId: string;
  readonly requiredNodeIds: readonly number[];
  readonly sourceAcceptanceRef: string;
  readonly placementApprovalRef: string;
  readonly preflightFingerprint: string;
};

export type ResolveApprovalExpected =
  | { kind: 'source_acceptance'; applicationId: string; generationId: string }
  | { kind: 'placement_approval'; applicationId: string; intentRevisionId: string; requiredNodeIds: readonly number[] }
  | { kind: 'rollout_authorization'; applicationId: string; binding: FutureRolloutAuthorizationBinding }
  | { kind: 'legacy_combined'; applicationId: string };

export type FutureGitOpsEvidence = {
  readonly applicationId: string;
  readonly source: Readonly<{ kind: 'source_superseded'; supersededGenerationId: string }> | null;
  readonly placement:
    | Readonly<{ kind: 'source_acceptance_pending'; candidateGenerationId: string }>
    | Readonly<{ kind: 'authorization_pending'; binding: FutureRolloutAuthorizationBinding }>
    | Readonly<{ kind: 'authorization_stale'; rolloutAuthorizationRef: string; bound: FutureRolloutAuthorizationBinding }>
    | Readonly<{ kind: 'preflight_blocked'; reason: string; binding: FutureRolloutAuthorizationBinding }>
    | null;
  readonly rollout: Readonly<{
    kind:
      | 'queued'
      | 'canary'
      | 'batch'
      | 'superseded'
      | 'fully_deployed_health_pending'
      | 'configuration_converged_artifact_qualified'
      | 'exactly_converged_healthy';
    rolloutGenerationId: string;
  }> | null;
  readonly targetRuntime: ReadonlyArray<Readonly<{
    nodeId: number;
    kind: 'rollout_artifact_drift';
    rolloutGenerationId: string;
    expectedIdentity: string;
    observedIdentity: string;
    freshnessAt: number;
  }>>;
};

export type GitOpsApprovalRefs = {
  sourceAcceptanceRef: string | null;
  placementApprovalRef: string | null;
  rolloutAuthorizationRef: string | null;
  legacyCombinedApprovalRef: string | null;
};

export type EvidenceSource = 'current' | 'future' | 'current_or_future' | 'not_applicable';

export type SourceIdentityFields = {
  configuredRepoUrl: string;
  repoIdentity: RepoIdentity;
  configuredRef: string;
  desiredCommitSha: string | null;
  fetchedCommitSha: string | null;
  candidateGenerationId: string | null;
  acceptedGenerationId: string | null;
};

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
  | (SourceIdentityFields & { status: 'source_suspended'; suspendedAt: number })
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

export type ArtifactExpectedIdentity = {
  artifactSetId: string;
  evidenceVersion: number;
  qualification: ArtifactQualification;
  identity: string | null;
};

export type ArtifactLatestEvidence = {
  artifactSetId: string;
  evidenceVersion: number;
  qualification: ArtifactQualification;
  identity: string | null;
};

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
  | { status: 'rollback_partial_failed'; recoveryRef: string; recoveryGenerationId: string | null; failureClass: string; failureAt: number }
  | { status: 'recovery_required' }
  | { status: 'completion_unknown' };

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

export type FacetEvidenceSource = {
  source: Record<SourceFacet['status'], EvidenceSource>;
  artifact: Record<ArtifactFacet['status'], EvidenceSource>;
  placement: Record<PlacementFacet['status'], EvidenceSource>;
  rollout: Record<RolloutFacet['status'], EvidenceSource>;
  runtime: Record<RuntimeFacet['status'], EvidenceSource>;
  lkg: Record<LkgFacet['status'], EvidenceSource>;
  health: Record<HealthFacet['status'], EvidenceSource>;
};

/**
 * What kind of evidence can produce each facet status.
 *
 * `current` means it derives from persisted rows. `future` means it can only
 * come from a rollout-evidence envelope that no producer emits yet, so the
 * derivers in this module must never return it. `current_or_future` marks the
 * statuses both paths can reach.
 *
 * The `Record` type makes coverage a compile error in both directions: a new
 * facet status without an entry here fails to compile, and so does an entry
 * whose status no longer exists.
 */
export const FACET_EVIDENCE_SOURCE: FacetEvidenceSource = {
  source: {
    not_applicable: 'not_applicable',
    never_reconciled: 'current',
    checking_fetching: 'current',
    applying: 'current',
    candidate_ready: 'current',
    source_review_pending: 'current',
    source_conflict_blocker: 'current',
    source_reconcile_required: 'current',
    application_generation_accepted: 'current',
    source_superseded: 'future',
    source_retry_scheduled: 'current',
    source_suspended: 'current',
    source_failed: 'current',
    source_unknown: 'current',
    recovery_required: 'current',
    recovery_failed: 'current',
    not_live: 'current',
  },
  artifact: {
    not_applicable: 'not_applicable',
    artifact_unresolved: 'current',
    artifact_resolution_pending: 'current',
    artifact_exact: 'current',
    artifact_qualified: 'current',
    artifact_stale: 'current',
    artifact_unavailable: 'current',
    artifact_local_build_unverified: 'current',
    artifact_identity_changed: 'current',
  },
  placement: {
    not_applicable: 'not_applicable',
    unbound_direct: 'current',
    unknown: 'current',
    placement_review_pending: 'current',
    stateful_confirmation_required: 'current',
    blueprint_bound: 'current',
    source_acceptance_pending: 'future',
    rollout_authorization_pending: 'future',
    rollout_authorization_stale: 'future',
    preflight_blocked: 'future',
  },
  rollout: {
    not_applicable: 'not_applicable',
    rollout_not_executable: 'current',
    rollout_paused: 'current',
    partially_rolled_out: 'current',
    target_stale: 'current',
    target_unreachable: 'current',
    rollback_in_progress: 'current',
    rollback_partial_failed: 'current',
    recovery_required: 'current',
    completion_unknown: 'current_or_future',
    rollout_queued: 'future',
    canary_in_progress: 'future',
    batch_in_progress: 'future',
    fully_deployed_health_pending: 'future',
    configuration_converged_artifact_qualified: 'future',
    exactly_converged_healthy: 'future',
    rollout_superseded: 'future',
  },
  runtime: {
    tombstoned: 'current',
    recovery_required: 'current',
    deploying: 'current',
    withdrawing: 'current',
    failed_previous_workload_intact: 'current',
    failed_after_mutation: 'current',
    disk_invocation_drift: 'current',
    runtime_artifact_drift: 'current',
    artifact_verification_pending: 'current',
    never_applied: 'current',
    applied_not_deployed: 'current',
    acknowledged_completion_unknown: 'current',
    stale_acknowledgement: 'current',
    pending_state_review: 'current',
    evict_blocked: 'current',
    drifted: 'current',
    correcting: 'current',
    fully_deployed_health_pending: 'current',
    health_checking: 'current',
    synced_and_healthy: 'current',
    health_drift: 'current',
    partially_rolled_out: 'current',
    retry_scheduled: 'current',
    paused: 'current',
    recovery_failed: 'current',
    completion_unknown: 'current',
    rollout_artifact_drift: 'future',
  },
  lkg: {
    none: 'current',
    available: 'current',
    unavailable: 'current',
    qualified: 'current',
  },
  health: {
    not_applicable: 'not_applicable',
    unbound: 'current',
    pending: 'current',
    checking: 'current',
    passed: 'current',
    failed: 'current',
    unknown: 'current',
  },
};

export type GitOpsFacets = {
  source: SourceFacet;
  artifact: ArtifactFacet;
  placement: PlacementFacet;
  rollout: RolloutFacet;
};

export type AuthoredInvocationIdentity = {
  composeFileOrder: string[];
  projectName: string | null;
  projectDirectory: string | null;
  envFileOrder: string[];
};

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

/**
 * Cross-instance evidence a history entry carries so any reader can decide who
 * may see it. Only the owning instance can answer any of these questions, so
 * they all travel with the row rather than being inferred by a reader that
 * holds none of that instance's state.
 */
export type GitOpsHistoryEvidenceFields = {
  stackName: string | null;
  applicationLifecycleStatus: GitOpsLifecycleStatus | null;
  stackResourcePresent: boolean;
};

export type GitOpsLimitation = { code: string; message: string; evidence: unknown };
export type GitOpsAvailableAction = 'fetch' | 'apply' | 'dismiss' | 'deploy' | 'approve_legacy' | 'none';

export type ConfiguredPolicy =
  | { kind: 'git_source'; autoApplyOnWebhook: boolean; autoDeployOnApply: boolean }
  | { kind: 'blueprint_drift'; driftMode: 'observe' | 'suggest' | 'enforce' }
  | null;

export type GitOpsDriftItem = {
  class: 'source' | 'managed_project' | 'invocation' | 'placement' | 'rollout' | 'runtime' | 'health';
  expected: GitOpsIdentityRef;
  observed: GitOpsIdentityRef;
  freshnessAt: number | null;
  owner: string;
  reason: string;
  configuredPolicy: ConfiguredPolicy;
  affectedTargets: Array<{ nodeId: number | null; stackName: string | null }>;
  action: GitOpsAvailableAction;
};

export type GitOpsTargetProjection = {
  nodeId: number;
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
};

export type GitOpsRevisionProjection =
  | {
      schemaVersion: 1;
      targetMode: 'not_applicable';
      applicationId: null;
      facets: null;
      targets: [];
      drift: [];
      /**
       * Why there is nothing to project, when the answer is not simply "no
       * application".
       *
       * Empty for the ordinary case: a stack or Blueprint the model has never
       * been asked about. Non-empty when the projection could not reach an
       * application it had reason to believe exists, which is a different fact
       * and must not read as the ordinary one.
       *
       * `readonly` because the shared frozen NOT_APPLICABLE_REVISION is this
       * variant: a caller pushing onto it would corrupt every later response,
       * and this keeps that a compile error rather than a runtime throw.
       */
      limitations: readonly GitOpsLimitation[];
      availableActions: [];
      approvals: null;
    }
  | {
      schemaVersion: 1;
      targetMode: GitOpsTargetMode;
      applicationId: string;
      lifecycleStatus: GitOpsLifecycleStatus;
      stackName: string | null;
      blueprintId: number | null;
      rolloutGenerationId: string | null;
      approvals: GitOpsApprovalRefs;
      facets: GitOpsFacets;
      targets: GitOpsTargetProjection[];
      drift: GitOpsDriftItem[];
      limitations: GitOpsLimitation[];
      availableActions: GitOpsAvailableAction[];
    };

export type { ArtifactEvidenceJson, ObservedArtifactIdentity, RepoIdentity };
