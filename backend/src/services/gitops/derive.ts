import {
  decodeArtifactEvidenceJson,
  decodeGitOpsEvidenceLimitations,
  decodeObservedArtifactIdentity,
  GitOpsJsonError,
} from './json';
import { GitOpsStore } from './store';
import type { BlueprintObservationStage } from './transitions';
import type {
  ArtifactExpectedIdentity,
  ArtifactFacet,
  ArtifactLatestEvidence,
  ArtifactQualification,
  FutureGitOpsEvidence,
  GitOpsApplicationRow,
  GitOpsAvailableAction,
  GitOpsLimitation,
  GitOpsRevisionProjection,
  GitOpsDriftItem,
  GitOpsTargetCurrentRow,
  GitOpsTargetProjection,
  HealthFacet,
  LkgFacet,
  PlacementFacet,
  RolloutFacet,
  RuntimeFacet,
  SourceFacet,
  SourceIdentityFields,
} from './types';

/**
 * The projection for anything that carries no GitOps application.
 *
 * One shared instance, so its collections are frozen alongside it: a caller
 * that pushed a limitation onto this projection would otherwise corrupt every
 * later response in the process. The separate declaration is what gives the
 * literal its contextual type; freezing it inline widens the empty tuples to
 * `never[]` and fails to typecheck.
 */
const NOT_APPLICABLE: GitOpsRevisionProjection = {
  schemaVersion: 1,
  targetMode: 'not_applicable',
  applicationId: null,
  facets: null,
  targets: [],
  drift: [],
  limitations: [],
  availableActions: [],
  approvals: null,
};
// Frozen after construction rather than inline: the collections stay mutable
// types so the projection union still matches, while the shared instance
// refuses writes at runtime.
for (const collection of [
  NOT_APPLICABLE.targets,
  NOT_APPLICABLE.drift,
  NOT_APPLICABLE.limitations,
  NOT_APPLICABLE.availableActions,
]) {
  Object.freeze(collection);
}
export const NOT_APPLICABLE_REVISION: GitOpsRevisionProjection = Object.freeze(NOT_APPLICABLE);

export type DeriveFacts = {
  application: GitOpsApplicationRow | null;
  targets: GitOpsTargetCurrentRow[];
  healthDisabled: boolean;
};

export function deriveGitOpsRevision(
  facts: DeriveFacts,
  futureEvidence: FutureGitOpsEvidence | null,
): GitOpsRevisionProjection {
  // Future-only facets are typed here so callers share one deriver; this slice
  // projects only persisted current evidence.
  void futureEvidence;
  const app = facts.application;
  if (!app) return NOT_APPLICABLE_REVISION;
  const limitations: GitOpsLimitation[] = [];
  mergePersistedLimitations(app.evidence_limitations_json, limitations);
  const source = deriveSource(app, limitations);
  const artifact = deriveArtifact(app, app.accepted_generation_id, app.artifact_set_id, app.latest_artifact_set_id, limitations);
  const placement = derivePlacement(app);
  const targets = facts.targets
    .slice()
    .sort((a, b) => a.node_id - b.node_id)
    .map((target) => deriveTarget(app, target, facts.healthDisabled, limitations));
  const rollout = deriveRollout(app, targets);
  const availableActions = deriveActions(app, source, targets);
  return {
    schemaVersion: 1,
    targetMode: app.target_mode,
    applicationId: app.id,
    lifecycleStatus: app.lifecycle_status,
    stackName: app.stack_name,
    blueprintId: app.blueprint_id,
    rolloutGenerationId: app.rollout_generation_id,
    approvals: {
      sourceAcceptanceRef: app.source_acceptance_ref,
      placementApprovalRef: app.placement_approval_ref,
      rolloutAuthorizationRef: app.rollout_authorization_ref,
      legacyCombinedApprovalRef: app.legacy_combined_approval_ref,
    },
    facets: { source, artifact, placement, rollout },
    targets,
    drift: collectRuntimeDrift(app, targets),
    limitations,
    availableActions,
  };
}

/**
 * The one drift class current evidence can confirm on its own.
 *
 * Most of the seven classes need producers this model deliberately defers, but
 * a comparable runtime artifact mismatch rests entirely on rows that exist
 * now. Leaving `drift` empty while the facet says `runtime_artifact_drift`
 * would report one fault twice with only one copy readable.
 *
 * Emitted only for an exact or qualified expectation against an exact or
 * qualified observation whose identity strings differ. Every other observation
 * kind stays `artifact_verification_pending`, and equal identities emit
 * nothing. Policy composition has no producer yet, so the item carries null
 * rather than a policy nothing wrote.
 */
function collectRuntimeDrift(app: GitOpsApplicationRow, targets: GitOpsTargetProjection[]): GitOpsDriftItem[] {
  const items: GitOpsDriftItem[] = [];
  for (const target of targets) {
    if (target.runtime.status !== 'runtime_artifact_drift') continue;
    const expected = target.artifact.status !== 'not_applicable' && 'expected' in target.artifact
      ? target.artifact.expected
      : null;
    if (!expected || expected.identity === null) continue;
    const observed = target.observedArtifactIdentity;
    if ((observed.kind !== 'exact' && observed.kind !== 'qualified') || observed.identity === expected.identity) {
      continue;
    }
    items.push({
      class: 'runtime',
      expected: {
        kind: 'artifact_set',
        id: expected.artifactSetId,
        qualification: expected.qualification,
        evidenceVersion: expected.evidenceVersion,
      },
      observed: { kind: 'runtime_artifact', identity: observed.identity, observedAt: observed.observedAt },
      freshnessAt: observed.observedAt,
      owner: 'observed_artifact_identity',
      reason: 'the running workload reports an artifact identity other than the expected artifact set',
      configuredPolicy: null,
      affectedTargets: [{ nodeId: target.nodeId, stackName: app.stack_name }],
      action: 'none',
    });
  }
  return items;
}

function deriveSource(app: GitOpsApplicationRow, limitations: GitOpsLimitation[]): SourceFacet {
  if (app.target_mode === 'inline_blueprint') return { status: 'not_applicable' };
  const identity = sourceIdentity(app, limitations);
  if (app.lifecycle_status === 'detached' || app.lifecycle_status === 'deleted') {
    return { ...identity, status: 'not_live', lifecycleStatus: app.lifecycle_status };
  }
  if (app.recovery_phase === 'restoring' || app.recovery_phase === 'compensating') {
    return { ...identity, status: 'recovery_required', recoveryRef: app.recovery_ref, recoveryGenerationId: null };
  }
  if (app.recovery_phase === 'failed' || app.failure_stage === 'recovery') {
    return {
      ...identity,
      status: 'recovery_failed',
      recoveryRef: app.recovery_ref,
      recoveryGenerationId: null,
      failureClass: app.failure_class ?? 'unknown',
      failureAt: app.failure_at ?? 0,
    };
  }
  if (app.active_operation_stage === 'fetch_started') return { ...identity, status: 'checking_fetching' };
  if (app.active_operation_stage === 'apply_started') {
    return {
      ...identity,
      status: 'applying',
      activeOperationId: app.active_operation_id ?? '',
      activeGenerationId: app.active_generation_id ?? '',
    };
  }
  if (app.interruption_stage === 'fetch_started' || app.interruption_stage === 'apply_started') {
    return {
      ...identity,
      status: 'source_unknown',
      interruptedStage: app.interruption_stage,
      interruptedAt: app.interruption_at ?? 0,
      interruptedOperationId: app.interruption_operation_id,
      interruptedGenerationId: app.interruption_generation_id,
    };
  }
  if (app.suspended_at) return { ...identity, status: 'source_suspended', suspendedAt: app.suspended_at };
  if (app.failure_stage === 'fetch' || app.failure_stage === 'validation' || app.failure_stage === 'apply' || app.failure_stage === 'create') {
    return {
      ...identity,
      status: 'source_failed',
      failureStage: app.failure_stage,
      failureClass: app.failure_class ?? app.failure_stage,
      failureAt: app.failure_at ?? 0,
      retryAt: app.retry_at,
      retryCount: app.retry_count,
    };
  }
  if (app.retry_at) {
    return { ...identity, status: 'source_retry_scheduled', retryAt: app.retry_at, retryCount: app.retry_count };
  }
  const store = GitOpsStore.getInstance();
  if (app.candidate_generation_id) {
    const generation = store.getGeneration(app.candidate_generation_id);
    if (generation && generation.materialization_fingerprint !== app.materialization_fingerprint) {
      return { ...identity, status: 'source_reconcile_required' };
    }
    if (app.candidate_plan_blocked === 1) return { ...identity, status: 'source_conflict_blocker' };
    if (app.review_required === 1) return { ...identity, status: 'source_review_pending' };
    return { ...identity, status: 'candidate_ready' };
  }
  if (app.accepted_generation_id) {
    const accepted = store.getGeneration(app.accepted_generation_id);
    const fingerprintMismatch = !!accepted && accepted.materialization_fingerprint !== app.materialization_fingerprint;
    const shaMismatch = !!accepted && !!app.desired_commit_sha && accepted.commit_sha !== app.desired_commit_sha;
    if (!app.desired_commit_sha || fingerprintMismatch || shaMismatch) {
      return { ...identity, status: 'source_reconcile_required' };
    }
    return { ...identity, status: 'application_generation_accepted' };
  }
  return { ...identity, status: 'never_reconciled' };
}

function sourceIdentity(app: GitOpsApplicationRow, limitations: GitOpsLimitation[]): SourceIdentityFields {
  let repoIdentity = { host: '', pathname: '' };
  if (app.repo_identity_json) {
    try {
      const parsed = JSON.parse(app.repo_identity_json) as { host?: unknown; pathname?: unknown };
      if (typeof parsed.host === 'string' && typeof parsed.pathname === 'string') {
        repoIdentity = { host: parsed.host, pathname: parsed.pathname };
      } else {
        limitations.push({ code: 'repo_identity_invalid', message: 'repo identity json is invalid', evidence: null });
      }
    } catch {
      limitations.push({ code: 'repo_identity_invalid', message: 'repo identity json is invalid', evidence: null });
    }
  }
  return {
    configuredRepoUrl: app.configured_repo_url ?? '',
    repoIdentity,
    configuredRef: app.configured_ref ?? '',
    desiredCommitSha: app.desired_commit_sha,
    fetchedCommitSha: app.fetched_commit_sha,
    candidateGenerationId: app.candidate_generation_id,
    acceptedGenerationId: app.accepted_generation_id,
  };
}

function deriveArtifact(
  app: GitOpsApplicationRow,
  generationId: string | null,
  expectedId: string | null,
  latestId: string | null,
  limitations: GitOpsLimitation[],
): ArtifactFacet {
  if (app.target_mode === 'inline_blueprint' || !generationId) return { status: 'not_applicable' };
  const store = GitOpsStore.getInstance();
  const expected = expectedId ? toExpected(store, expectedId, limitations) : null;
  if (!latestId) {
    return {
      status: 'artifact_unresolved',
      generationId,
      expected,
      latestEvidence: null,
      limitation: 'artifact_pointer_missing',
    };
  }
  const latestRow = store.getArtifactSet(latestId);
  if (!latestRow) {
    limitations.push({ code: 'artifact_pointer_missing', message: 'latest artifact row is missing', evidence: latestId });
    return {
      status: 'artifact_unresolved',
      generationId,
      expected,
      latestEvidence: null,
      limitation: 'artifact_pointer_missing',
    };
  }
  let latestEvidence: ArtifactLatestEvidence;
  try {
    const decoded = decodeArtifactEvidenceJson(latestRow.evidence_json);
    latestEvidence = {
      artifactSetId: latestRow.id,
      evidenceVersion: latestRow.evidence_version,
      qualification: latestRow.qualification,
      identity: 'identity' in decoded ? decoded.identity : null,
    };
  } catch {
    limitations.push({ code: 'artifact_evidence_json_invalid', message: 'latest artifact evidence is invalid', evidence: latestId });
    latestEvidence = {
      artifactSetId: latestRow.id,
      evidenceVersion: latestRow.evidence_version,
      qualification: latestRow.qualification,
      identity: null,
    };
    return {
      status: 'artifact_unresolved',
      artifactSetId: latestRow.id,
      generationId,
      evidenceVersion: latestRow.evidence_version,
      qualification: latestRow.qualification,
      freshnessAt: latestRow.created_at,
      expected,
      latestEvidence,
    };
  }
  const status = artifactStatus(latestRow.qualification, expected, latestEvidence);
  return {
    status,
    artifactSetId: latestRow.id,
    generationId,
    evidenceVersion: latestRow.evidence_version,
    qualification: latestRow.qualification,
    freshnessAt: latestRow.created_at,
    expected,
    latestEvidence,
  };
}

function artifactStatus(
  qualification: ArtifactQualification,
  expected: ArtifactExpectedIdentity | null,
  latest: ArtifactLatestEvidence,
): Exclude<ArtifactFacet, { status: 'not_applicable' } | { latestEvidence: null }>['status'] {
  if (qualification === 'unresolved') return expected ? 'artifact_resolution_pending' : 'artifact_unresolved';
  if (qualification === 'stale') return 'artifact_stale';
  if (qualification === 'unavailable') return 'artifact_unavailable';
  if (qualification === 'local_build_unverified') return 'artifact_local_build_unverified';
  if (
    expected
    && (expected.qualification === 'exact' || expected.qualification === 'qualified')
    && latest.identity
    && expected.identity
    && latest.identity !== expected.identity
  ) {
    return 'artifact_identity_changed';
  }
  return qualification === 'qualified' ? 'artifact_qualified' : 'artifact_exact';
}

function toExpected(
  store: GitOpsStore,
  id: string,
  limitations: GitOpsLimitation[],
): ArtifactExpectedIdentity | null {
  const row = store.getArtifactSet(id);
  if (!row) {
    limitations.push({ code: 'artifact_pointer_missing', message: 'expected artifact row is missing', evidence: id });
    return null;
  }
  try {
    const decoded = decodeArtifactEvidenceJson(row.evidence_json);
    return {
      artifactSetId: row.id,
      evidenceVersion: row.evidence_version,
      qualification: row.qualification,
      identity: 'identity' in decoded ? decoded.identity : null,
    };
  } catch {
    limitations.push({ code: 'artifact_evidence_json_invalid', message: 'expected artifact evidence is invalid', evidence: id });
    return {
      artifactSetId: row.id,
      evidenceVersion: row.evidence_version,
      qualification: row.qualification,
      identity: null,
    };
  }
}

function derivePlacement(app: GitOpsApplicationRow): PlacementFacet {
  if (app.target_mode === 'direct') return { status: 'unbound_direct' };
  if (!app.intent_revision_id) return { status: 'unknown', limitation: 'missing_intent' };
  if (app.legacy_combined_approval_ref && !app.placement_approval_ref) {
    return { status: 'placement_review_pending' };
  }
  return { status: 'blueprint_bound', completion: 'unknown' };
}

function deriveRollout(app: GitOpsApplicationRow, targets: GitOpsTargetProjection[]): RolloutFacet {
  if (app.recovery_phase === 'restoring' || app.recovery_phase === 'compensating') {
    return { status: 'rollback_in_progress', recoveryRef: app.recovery_ref ?? '', recoveryGenerationId: null };
  }
  const failed = targets.find((target) => target.runtime.status === 'recovery_failed');
  if (failed && failed.runtime.status === 'recovery_failed') {
    return {
      status: 'rollback_partial_failed',
      recoveryRef: failed.runtime.recoveryRef ?? app.recovery_ref ?? '',
      recoveryGenerationId: failed.runtime.recoveryGenerationId,
      failureClass: failed.runtime.failureClass,
      failureAt: failed.runtime.failureAt,
    };
  }
  if (targets.some((target) => target.connectivity === 'unreachable')) return { status: 'target_unreachable' };
  if (targets.some((target) => target.connectivity === 'stale')) return { status: 'target_stale' };
  if (app.pause_at) return { status: 'rollout_paused', pauseAt: app.pause_at, pauseReason: app.pause_reason };
  if (app.partial_json) return { status: 'partially_rolled_out', partial: app.partial_json };
  if (app.target_mode === 'direct') return { status: 'not_applicable' };
  if (app.rollout_candidate_id) return { status: 'rollout_not_executable', rolloutCandidateId: app.rollout_candidate_id };
  return { status: 'not_applicable' };
}

function deriveTarget(
  app: GitOpsApplicationRow,
  target: GitOpsTargetCurrentRow,
  healthDisabled: boolean,
  limitations: GitOpsLimitation[],
): GitOpsTargetProjection {
  let connectivity: GitOpsTargetProjection['connectivity'] = 'unknown';
  if (
    target.connectivity === 'unknown'
    || target.connectivity === 'reachable'
    || target.connectivity === 'unreachable'
    || target.connectivity === 'stale'
  ) {
    connectivity = target.connectivity;
  } else if (target.connectivity) {
    limitations.push({ code: 'connectivity_invalid', message: 'stored connectivity is illegal', evidence: target.connectivity });
  }
  mergePersistedLimitations(target.evidence_limitations_json, limitations);
  const observed = decodeObservedSafe(target.observed_artifact_identity_json, limitations);
  const artifact = deriveArtifact(app, target.desired_generation_id, target.expected_artifact_set_id, target.latest_artifact_set_id, limitations);
  const runtime = deriveRuntime(target, artifact, observed, healthDisabled);
  return {
    nodeId: target.node_id,
    stackName: app.stack_name,
    desiredGenerationId: target.desired_generation_id,
    candidateGenerationId: target.candidate_generation_id,
    appliedGenerationId: target.applied_generation_id,
    deployedGenerationId: target.deployed_generation_id,
    healthyGenerationId: target.healthy_generation_id,
    lkgGenerationId: target.lkg_generation_id,
    lkgArtifactSetId: target.lkg_artifact_set_id,
    lkgUnavailableAt: target.lkg_unavailable_at,
    lkgUnavailableReason: target.lkg_unavailable_reason,
    expectedArtifactSetId: target.expected_artifact_set_id,
    latestArtifactSetId: target.latest_artifact_set_id,
    artifact,
    observedArtifactIdentity: observed,
    intentRevisionId: target.intent_revision_id,
    rolloutCandidateId: target.rollout_candidate_id,
    rolloutGenerationId: target.rollout_generation_id,
    approvals: {
      sourceAcceptanceRef: target.source_acceptance_ref,
      placementApprovalRef: target.placement_approval_ref,
      rolloutAuthorizationRef: target.rollout_authorization_ref,
      legacyCombinedApprovalRef: target.legacy_combined_approval_ref,
    },
    connectivity,
    legacyAppliedRevision: target.legacy_applied_revision,
    runtime,
    health: deriveHealth(target, healthDisabled),
    lkg: deriveLkg(target, limitations),
    tombstoned: target.target_status === 'tombstoned',
  };
}

/**
 * The runtime status each Blueprint observation stage projects as.
 *
 * The reconciler records what it saw against the target rather than acting on
 * it, so this is the only route those observations have into a derived status.
 *
 * Two type obligations, and they pull in opposite directions. The declared type
 * is keyed on an open string because the value looked up is `latest_stage`,
 * which holds whichever stage was recorded last: anything that is not an
 * observation must be absent here and fall through to the states below, which
 * is exactly how a later transition supersedes an earlier observation. The
 * `satisfies` closes the other side, making the map total over the stages the
 * reconciler can actually record, so a new observation stage that nothing
 * projects fails this build instead of silently reading as never applied.
 *
 * The `| undefined` is load-bearing: this project does not set
 * `noUncheckedIndexedAccess`, so without it a miss would type as a status and
 * the guard at the call site would look like dead code.
 */
type ObservationRuntimeStatus = 'pending_state_review' | 'evict_blocked' | 'drifted' | 'correcting';

const BLUEPRINT_OBSERVATION_STATUS: Record<string, ObservationRuntimeStatus | undefined> = {
  blueprint_state_review: 'pending_state_review',
  blueprint_evict_blocked: 'evict_blocked',
  blueprint_drifted: 'drifted',
  blueprint_correcting: 'correcting',
} satisfies Record<BlueprintObservationStage, ObservationRuntimeStatus>;

function deriveRuntime(
  target: GitOpsTargetCurrentRow,
  artifact: ArtifactFacet,
  observed: ReturnType<typeof decodeObservedSafe>,
  healthDisabled: boolean,
): RuntimeFacet {
  if (target.target_status === 'tombstoned') return { status: 'tombstoned' };
  if (target.recovery_phase === 'restoring' || target.recovery_phase === 'compensating') {
    return { status: 'recovery_required' };
  }
  if (target.recovery_phase === 'failed' || target.failure_stage === 'recovery') {
    return {
      status: 'recovery_failed',
      recoveryRef: target.recovery_ref,
      recoveryGenerationId: target.recovery_generation_id,
      failureClass: target.failure_class ?? 'unknown',
      failureAt: target.failure_at ?? 0,
    };
  }
  if (target.active_operation_stage === 'deploy_started') return { status: 'deploying' };
  if (
    target.interruption_stage === 'deploy_started'
    || target.interruption_stage === 'blueprint_deploy_started'
    || target.interruption_stage === 'blueprint_withdraw_started'
  ) {
    return {
      status: 'completion_unknown',
      interruptedStage: target.interruption_stage,
      interruptedAt: target.interruption_at ?? 0,
      interruptedOperationId: target.interruption_operation_id,
      interruptedGenerationId: target.interruption_generation_id,
      interruptedIntentRevisionId: target.interruption_intent_revision_id,
      interruptedRolloutCandidateId: target.interruption_rollout_candidate_id,
    };
  }
  if (target.pause_at) return { status: 'paused', pauseAt: target.pause_at, pauseReason: target.pause_reason };
  if (target.partial_json) return { status: 'partially_rolled_out' };
  if (target.failure_stage === 'deploy' && (target.failure_class === 'pre_mutation' || target.failure_class === 'unbound')) {
    return { status: 'failed_previous_workload_intact' };
  }
  if (target.failure_stage === 'deploy' && target.failure_class === 'post_mutation') {
    return { status: 'failed_after_mutation' };
  }
  // Placed after every state a live, interrupted or failed mutation puts the
  // target in, and before the applied and deployed pointer checks. So an
  // observation cannot mask an in-flight deploy or a failure, but does outrank
  // pointers that predate it. The case that is easy to miss is the last one: a
  // target with no applied generation that has been observed now reports what
  // was seen rather than `never_applied`, which is what a deployed Blueprint
  // that drifted used to report.
  const blueprintStage = BLUEPRINT_OBSERVATION_STATUS[target.latest_stage ?? ''];
  if (blueprintStage) return { status: blueprintStage };
  if (!target.applied_generation_id) return { status: 'never_applied' };
  if (!target.deployed_generation_id) return { status: 'applied_not_deployed' };
  // The target's contract is its desired generation, so a populated deployed
  // pointer alone proves nothing: a newer applied generation with the old one
  // still running stays deploy-pending, or a stack awaiting its deploy would
  // read as synced and healthy off the previous workload's pointers. A null
  // desired id is the unknown case (legacy rows, recovered targets), where the
  // deployed pointer remains the only basis to judge.
  if (
    target.desired_generation_id !== null
    && target.deployed_generation_id !== target.desired_generation_id
  ) {
    return { status: 'applied_not_deployed' };
  }
  if (artifact.status !== 'not_applicable' && 'expected' in artifact && artifact.expected
    && (artifact.expected.qualification === 'exact' || artifact.expected.qualification === 'qualified')) {
    if (
      observed.kind === 'unknown'
      || observed.kind === 'missing'
      || observed.kind === 'unavailable'
      || observed.kind === 'stale'
      || observed.kind === 'local_build_unverified'
    ) {
      return { status: 'artifact_verification_pending' };
    }
    if (
      (observed.kind === 'exact' || observed.kind === 'qualified')
      && artifact.expected.identity
      && observed.identity !== artifact.expected.identity
    ) {
      return { status: 'runtime_artifact_drift' };
    }
  }
  if (target.retry_at) return { status: 'retry_scheduled' };
  if (healthDisabled) return { status: 'synced_and_healthy' };
  if (target.healthy_generation_id === target.deployed_generation_id) return { status: 'synced_and_healthy' };
  return { status: 'fully_deployed_health_pending' };
}

function deriveHealth(target: GitOpsTargetCurrentRow, healthDisabled: boolean): HealthFacet {
  if (healthDisabled) return { status: 'not_applicable' };
  if (!target.deployed_generation_id) return { status: 'unbound' };
  // A passing run answers for the generation the target was asked to run, so
  // it is judged against the desired id and only falls back to the deployed
  // pointer when no desired id is recorded. Judging against whatever is
  // deployed would let the previous workload's green run vouch for a newer
  // generation nobody has watched.
  const expectedGeneration = target.desired_generation_id ?? target.deployed_generation_id;
  if (target.healthy_generation_id === expectedGeneration) {
    return { status: 'passed', runId: '', deployedGenerationId: target.deployed_generation_id };
  }
  return { status: 'pending', runId: null };
}

function deriveLkg(target: GitOpsTargetCurrentRow, limitations: GitOpsLimitation[]): LkgFacet {
  if (!target.lkg_generation_id && !target.lkg_unavailable_at) return { status: 'none' };
  if (target.lkg_unavailable_at) return { status: 'unavailable' };
  const generation = target.lkg_generation_id
    ? GitOpsStore.getInstance().getGeneration(target.lkg_generation_id)
    : undefined;
  if (target.lkg_generation_id && !generation) {
    limitations.push({ code: 'lkg_generation_missing', message: 'LKG generation row is gone', evidence: target.lkg_generation_id });
    return { status: 'unavailable' };
  }
  if (target.lkg_artifact_set_id) {
    const artifact = GitOpsStore.getInstance().getArtifactSet(target.lkg_artifact_set_id);
    if (!artifact || artifact.generation_id !== target.lkg_generation_id) {
      limitations.push({ code: 'lkg_artifact_invalid', message: 'captured LKG artifact is invalid', evidence: target.lkg_artifact_set_id });
      return { status: 'available', generationId: target.lkg_generation_id!, artifactSetId: target.lkg_artifact_set_id };
    }
    if (artifact.qualification === 'qualified') {
      return { status: 'qualified', generationId: target.lkg_generation_id!, artifactSetId: artifact.id };
    }
    return { status: 'available', generationId: target.lkg_generation_id!, artifactSetId: artifact.id };
  }
  return { status: 'available', generationId: target.lkg_generation_id!, artifactSetId: null };
}

function deriveActions(
  app: GitOpsApplicationRow,
  source: SourceFacet,
  targets: GitOpsTargetProjection[],
): GitOpsAvailableAction[] {
  if (source.status === 'applying' || source.status === 'checking_fetching') return ['none'];
  if (source.status === 'recovery_required' || source.status === 'recovery_failed') return ['none'];
  const actions = new Set<GitOpsAvailableAction>();
  if (
    source.status === 'never_reconciled'
    || source.status === 'source_reconcile_required'
    || source.status === 'source_retry_scheduled'
    || (source.status === 'source_unknown' && source.interruptedStage === 'fetch_started')
    || (source.status === 'source_failed' && (source.failureStage === 'fetch' || source.failureStage === 'validation'))
  ) {
    actions.add('fetch');
  }
  if (source.status === 'candidate_ready') actions.add('apply');
  if (source.status === 'source_unknown' && source.interruptedStage === 'apply_started') actions.add('apply');
  if (app.candidate_generation_id && !app.active_operation_stage) actions.add('dismiss');
  if (targets.some((target) => target.runtime.status === 'applied_not_deployed')) actions.add('deploy');
  if (actions.size === 0) return ['none'];
  return Array.from(actions);
}

/**
 * Fold the limitations a writer recorded into the ones derived here.
 *
 * These cannot be re-derived: they describe evidence that was dropped because
 * it could not be proven, and once dropped the row looks the same as one that
 * never had it. Decoded fail-closed, so a corrupt record surfaces as its own
 * limitation rather than disappearing.
 */
function mergePersistedLimitations(raw: string | null, limitations: GitOpsLimitation[]): void {
  if (!raw) return;
  try {
    for (const item of decodeGitOpsEvidenceLimitations(raw)) {
      limitations.push({
        code: item.code,
        message: 'evidence recorded at write time could not be proven',
        evidence: item.detail,
      });
    }
  } catch (err) {
    limitations.push({
      code: 'evidence_limitations_invalid',
      message: err instanceof Error ? err.message : String(err),
      evidence: raw,
    });
  }
}

function decodeObservedSafe(
  raw: string | null,
  limitations: GitOpsLimitation[],
): ReturnType<typeof decodeObservedArtifactIdentity> {
  try {
    return decodeObservedArtifactIdentity(raw);
  } catch (err) {
    // Any failure here means the runtime observation is unusable, so it must
    // surface as a limitation. Returning a clean 'unknown' without one would
    // read as "nothing observed yet" and quietly downgrade a real artifact
    // drift to a pending check.
    limitations.push({
      code: err instanceof GitOpsJsonError ? 'artifact_observation_invalid' : 'artifact_observation_decode_failed',
      message: err instanceof Error ? err.message : String(err),
      evidence: raw,
    });
    return { kind: 'unknown' };
  }
}

/**
 * The not-applicable shape, carrying why an application we expected was absent.
 *
 * Distinct from `NOT_APPLICABLE_REVISION` on purpose. That one means "nothing
 * here", which is the honest answer for a stack or Blueprint the model was
 * never asked about. This one means "something should have been here and was
 * not", which is a fault. Returning the shared sentinel for both would make a
 * vanished row indistinguishable from one that never existed, and the reader
 * has no third source to tell them apart.
 */
function unreachableApplicationRevision(limitation: GitOpsLimitation): GitOpsRevisionProjection {
  return {
    schemaVersion: 1,
    targetMode: 'not_applicable',
    applicationId: null,
    facets: null,
    targets: [],
    drift: [],
    limitations: [limitation],
    availableActions: [],
    approvals: null,
  };
}

function missingApplicationRevision(applicationId: string): GitOpsRevisionProjection {
  return unreachableApplicationRevision({
    code: 'application_row_missing',
    message: 'The application this projection was resolved from is no longer present.',
    evidence: { applicationId },
  });
}

/**
 * A Blueprint proven to manage a stack directory, with no application row.
 *
 * Its own code, not `application_row_missing`, because the evidence differs:
 * there is no application id to name, only the Blueprint and the stack whose
 * deployment row proved the ownership.
 */
export function missingBlueprintApplicationRevision(blueprintId: number, stackName: string): GitOpsRevisionProjection {
  return unreachableApplicationRevision({
    code: 'blueprint_application_missing',
    message: 'A Blueprint deployed this stack but has no live application to describe it.',
    evidence: { blueprintId, stackName },
  });
}

export function projectApplication(applicationId: string, healthDisabled: boolean): GitOpsRevisionProjection {
  const store = GitOpsStore.getInstance();
  const application = store.getApplication(applicationId);
  // The caller resolved this id from a row it had just read, so a miss here is
  // not "no application": it is a row that went away between the two reads,
  // which are deliberately not in one transaction. Say so rather than reporting
  // the same answer an unmodelled stack gets.
  if (!application) return missingApplicationRevision(applicationId);
  return deriveGitOpsRevision({
    application,
    targets: store.listTargets(applicationId),
    healthDisabled,
  }, null);
}
