/**
 * Data hook for one GitOps application view.
 *
 * Reads the hub-owned detail endpoint with the same conventions as the
 * portfolio hook: `localOnly`, event-driven refresh off the gitops
 * `sencho:state-invalidate` channel (debounced), a generation guard so a slow
 * answer never overwrites a newer one, and a failed refresh that keeps the
 * last good state flagged stale rather than blanking it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import type { FutureRolloutAuthorizationBinding } from '@/types/gitops';
import type { GitOpsPortfolioDetailResponse, GitOpsPortfolioRow, GitOpsPortfolioTargetSummary } from '@/types/gitopsPortfolio';

const INVALIDATE_DEBOUNCE_MS = 250;

/**
 * Why there is no application to show.
 *
 * `not_readable` covers "does not exist" and "not yours to read" (a Direct
 * read answers 404 for both, precisely so the two cannot be told apart) and a
 * Blueprint read without fleet read access (403). `invalid_link` is an id that
 * is not a portfolio id at all (400). `unreachable` is the owning node failing to answer, and
 * `unsupported` is the owning node answering that it cannot serve this read;
 * neither says anything about the application itself.
 * `evidence_unavailable` is the owning node answering that the application
 * exists but its evidence cannot be read yet, which is a retryable answer
 * rather than a missing application. `failed` is anything else, including an
 * answer this build cannot parse.
 */
export type GitOpsApplicationError =
  | { kind: 'not_readable' }
  | { kind: 'invalid_link' }
  | { kind: 'unreachable'; message: string }
  | { kind: 'unsupported'; message: string }
  | { kind: 'evidence_unavailable'; message: string }
  | { kind: 'failed'; message: string };

/**
 * The hook keeps three rules the flat shape (shared with the portfolio hook)
 * does not encode: `data` and `error` are never both set, `staleSince` is only
 * set while `data` is, and `loading` is true only while there is no answer to
 * show (the first load, or a retry after a failed one).
 */
export interface GitOpsApplicationState {
  data: GitOpsPortfolioDetailResponse | null;
  loading: boolean;
  refreshing: boolean;
  error: GitOpsApplicationError | null;
  /** Epoch ms of the first failed refresh since the data was last good; null while fresh. */
  staleSince: number | null;
  refresh: () => void;
}

class ApplicationReadError extends Error {
  readonly failure: GitOpsApplicationError;
  constructor(failure: GitOpsApplicationError) {
    super('message' in failure ? failure.message : failure.kind);
    this.failure = failure;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.length > 0;
}

function isNamedApplicationId(value: unknown): value is string {
  return isString(value) && value.length > 0 && !value.startsWith('legacy:') && !value.startsWith('bp:');
}

function isErrorBody(value: unknown): value is { error?: string; code?: string } {
  return isRecord(value)
    && (value.error === undefined || isString(value.error))
    && (value.code === undefined || isString(value.code));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

/** An identity field: absent (null) or a real identifier, never a blank string. */
function isNullableIdentifier(value: unknown): boolean {
  return value === null || isNonEmptyString(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isNumber(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isPositiveIntegerArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isPositiveInteger);
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord);
}

function isRepository(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return ['configuredRepoUrl', 'host', 'pathname', 'configuredRef'].every(key => isString(value[key]));
}

function isTargetSummary(value: unknown): value is GitOpsPortfolioTargetSummary {
  return isRecord(value)
    && isPositiveInteger(value.nodeId)
    && isNullableString(value.nodeName)
    && isNullableString(value.stackName)
    && ['runtime', 'health', 'connectivity', 'evidence'].every(key => isString(value[key]));
}

function isIdentityRef(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.kind)) return false;
  switch (value.kind) {
    case 'none':
    case 'unknown':
      return true;
    case 'commit':
      return isString(value.sha) && isString(value.repoUrl) && isString(value.ref);
    case 'generation':
    case 'rollout_candidate':
    case 'rollout_generation':
      return isString(value.id);
    case 'artifact_set':
      return isString(value.id)
        && isNonEmptyString(value.qualification)
        && isNumber(value.evidenceVersion);
    case 'runtime_artifact':
      return isString(value.identity) && isNullableNumber(value.observedAt);
    case 'intent':
      return isString(value.id) && isString(value.composeContentSha256);
    case 'invocation':
      return isRecord(value.authored)
        && isStringArray(value.authored.composeFileOrder)
        && isNullableString(value.authored.projectName)
        && isNullableString(value.authored.projectDirectory)
        && isStringArray(value.authored.envFileOrder);
    case 'health_run':
      return isString(value.runId) && isNullableString(value.deployedGenerationId);
    default:
      return false;
  }
}

function isObservedArtifactIdentity(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.kind)) return false;
  switch (value.kind) {
    case 'unknown':
    case 'missing':
    case 'unavailable':
      return true;
    case 'exact':
    case 'qualified':
    case 'stale':
    case 'local_build_unverified':
      return isString(value.identity) && isNumber(value.observedAt);
    default:
      return true;
  }
}

const GENERATION_BOUND_ROLLOUT_STATES: ReadonlySet<string> = new Set([
  'rollout_queued',
  'canary_in_progress',
  'batch_in_progress',
  'fully_deployed_health_pending',
  'configuration_converged_artifact_qualified',
  'exactly_converged_healthy',
  'rollout_superseded',
]);

/** The one qualification each artifact status may carry, keyed by that status. */
const STATUS_QUALIFICATION: Readonly<Record<string, string>> = {
  artifact_exact: 'exact',
  artifact_qualified: 'qualified',
  artifact_stale: 'stale',
  artifact_unavailable: 'unavailable',
  artifact_local_build_unverified: 'local_build_unverified',
  artifact_resolution_pending: 'unresolved',
};

const PREFLIGHT_FINGERPRINT_RE = /^[0-9a-f]{64}$/;

function isPositiveInteger(value: unknown): value is number {
  return isNumber(value) && Number.isSafeInteger(value) && value > 0;
}

function isNullablePositiveInteger(value: unknown): boolean {
  return value === null || isPositiveInteger(value);
}

function isLkgUnavailableReason(value: unknown): boolean {
  return value === null || value === 'generation_missing' || value === 'recovery_unretainable';
}

function isBinding(value: unknown): value is FutureRolloutAuthorizationBinding {
  return isRecord(value)
    && isString(value.acceptedGenerationId)
    && isString(value.artifactSetId)
    && isString(value.intentRevisionId)
    && isString(value.placementApprovalRef)
    && isString(value.preflightFingerprint)
    && PREFLIGHT_FINGERPRINT_RE.test(value.preflightFingerprint)
    && isString(value.rolloutCandidateId)
    && isString(value.sourceAcceptanceRef)
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
    && isNumber(value.evidenceVersion)
    && isNonEmptyString(value.qualification)
    && (value.identity === null || isNonEmptyString(value.identity));
}

function isSourceFacet(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !isString(value.status)) return false;
  if (value.status === 'not_applicable') return true;
  const repoIdentity = value.repoIdentity;
  if (!isRecord(repoIdentity)
    || !isString(value.configuredRepoUrl)
    || !isString(repoIdentity.host)
    || !isString(repoIdentity.pathname)
    || !isString(value.configuredRef)
    || !isNullableString(value.desiredCommitSha)
    || !isNullableString(value.fetchedCommitSha)
    || !isNullableString(value.candidateGenerationId)
    || !isNullableString(value.acceptedGenerationId)) return false;
  switch (value.status) {
    case 'source_review_pending':
      return value.reviewBlockReason === null || value.reviewBlockReason === 'stateful_withdrawal';
    case 'application_generation_accepted':
      return isString(value.acceptedGenerationId);
    case 'source_superseded':
      return isString(value.supersededGenerationId);
    case 'applying':
      return isString(value.activeOperationId) && isString(value.activeGenerationId);
    case 'source_retry_scheduled':
      return isNumber(value.retryAt) && isNumber(value.retryCount);
    case 'source_poll_scheduled':
      return isNumber(value.nextPollAt);
    case 'source_suspended':
      return isNumber(value.suspendedAt) && isNullableString(value.suspendedReason);
    case 'source_failed':
      return isString(value.failureStage)
        && ['fetch', 'validation', 'apply', 'create'].includes(value.failureStage)
        && isString(value.failureClass)
        && isNumber(value.failureAt)
        && isNullableNumber(value.retryAt)
        && isNumber(value.retryCount);
    case 'source_unknown':
      return isString(value.interruptedStage)
        && ['fetch_started', 'apply_started'].includes(value.interruptedStage)
        && isNumber(value.interruptedAt)
        && isNullableString(value.interruptedOperationId)
        && isNullableString(value.interruptedGenerationId);
    case 'recovery_required':
      return isNullableString(value.recoveryRef) && isNullableString(value.recoveryGenerationId);
    case 'recovery_failed':
      return isNullableString(value.recoveryRef)
        && isNullableString(value.recoveryGenerationId)
        && isString(value.failureClass)
        && isNumber(value.failureAt);
    case 'not_live':
      return value.lifecycleStatus === 'detached' || value.lifecycleStatus === 'deleted';
    default:
      return true;
  }
}

function isArtifactFacet(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.status)) return false;
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
  if ((value.status === 'artifact_exact' || value.status === 'artifact_qualified' || value.status === 'artifact_identity_changed')
    && (latest.identity === null || (expected !== null && expected.qualification !== 'unresolved' && expected.identity === null))) return false;
  // An exact or qualified verdict claims the observed artifact is the expected
  // one, so a provable expected-versus-latest identity disagreement cannot
  // coexist with it. An unresolved expectation carries no identity to compare.
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
    && isNumber(value.evidenceVersion)
    && isNonEmptyString(value.qualification)
    && isNumber(value.freshnessAt);
}

function isPlacementFacet(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.status)) return false;
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
      return isNullableString(value.sourceAcceptanceRef) && isString(value.candidateGenerationId);
    case 'rollout_authorization_pending':
      return value.rolloutAuthorizationRef === null && isBinding(value.binding);
    case 'rollout_authorization_stale':
      return isString(value.rolloutAuthorizationRef) && isBinding(value.bound);
    case 'preflight_blocked':
      return isString(value.reason) && isBinding(value.binding);
    default:
      return true;
  }
}

function isRolloutFacet(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !isString(value.status)) return false;
  if (GENERATION_BOUND_ROLLOUT_STATES.has(value.status)) return isNonEmptyString(value.rolloutGenerationId);
  switch (value.status) {
    case 'not_applicable':
    case 'target_stale':
    case 'target_unreachable':
    case 'recovery_required':
    case 'completion_unknown':
      return true;
    case 'rollout_not_executable':
      return isString(value.rolloutCandidateId);
    case 'rollout_paused':
      return isNumber(value.pauseAt) && isNullableString(value.pauseReason);
    case 'partially_rolled_out':
      return Object.hasOwn(value, 'partial');
    case 'rollback_in_progress':
      return isString(value.recoveryRef) && isNullableString(value.recoveryGenerationId);
    case 'rollback_partial_failed':
      return isString(value.recoveryRef)
        && isNullableString(value.recoveryGenerationId)
        && isString(value.failureClass)
        && isNumber(value.failureAt);
    default:
      return true;
  }
}

function isRuntimeFacet(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.status)) return false;
  switch (value.status) {
    case 'paused':
      return isNumber(value.pauseAt) && isNullableString(value.pauseReason);
    case 'recovery_failed':
      return isNullableString(value.recoveryRef)
        && isNullableString(value.recoveryGenerationId)
        && isString(value.failureClass)
        && isNumber(value.failureAt);
    case 'completion_unknown':
      return isString(value.interruptedStage)
        && ['deploy_started', 'blueprint_deploy_started', 'blueprint_withdraw_started'].includes(value.interruptedStage)
        && isNumber(value.interruptedAt)
        && isNullableString(value.interruptedOperationId)
        && isNullableString(value.interruptedGenerationId)
        && isNullableString(value.interruptedIntentRevisionId)
        && isNullableString(value.interruptedRolloutCandidateId);
    default:
      return true;
  }
}

function isHealthFacet(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.status)) return false;
  switch (value.status) {
    case 'not_applicable':
    case 'unbound':
      return true;
    case 'pending':
      return isNullableString(value.runId);
    case 'checking':
    case 'failed':
      return isString(value.runId) && isNullableString(value.deployedGenerationId);
    case 'passed':
      return isString(value.runId) && isString(value.deployedGenerationId);
    case 'unknown':
      return isNullableString(value.runId) && value.limitation === 'health_unknown';
    default:
      return true;
  }
}

function isLkgFacet(value: unknown): boolean {
  if (!isRecord(value) || !isString(value.status)) return false;
  switch (value.status) {
    case 'none':
    case 'unavailable':
      return true;
    case 'available':
      return isString(value.generationId) && isNullableString(value.artifactSetId);
    case 'qualified':
      return isString(value.generationId) && isString(value.artifactSetId);
    default:
      return true;
  }
}

function isConfiguredPolicy(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value) || !isString(value.kind)) return false;
  if (value.kind === 'git_source') return typeof value.autoApplyOnWebhook === 'boolean' && typeof value.autoDeployOnApply === 'boolean';
  if (value.kind === 'blueprint_drift') {
    return isString(value.driftMode) && ['observe', 'suggest', 'enforce'].includes(value.driftMode);
  }
  return true;
}

function isTargetProjection(value: unknown): boolean {
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
    && isString(value.connectivity)
    && isNullableNumber(value.legacyAppliedRevision)
    && isRuntimeFacet(value.runtime)
    && isHealthFacet(value.health)
    && isLkgFacet(value.lkg)
    && typeof value.tombstoned === 'boolean';
}

function isDriftItem(value: unknown): boolean {
  return isRecord(value)
    && isString(value.class)
    && isIdentityRef(value.expected)
    && isIdentityRef(value.observed)
    && isNullableNumber(value.freshnessAt)
    && isString(value.owner)
    && isString(value.reason)
    && isConfiguredPolicy(value.configuredPolicy)
    && Array.isArray(value.affectedTargets)
    && value.affectedTargets.every(target => isRecord(target) && isNullablePositiveInteger(target.nodeId) && isNullableString(target.stackName))
    && isString(value.action);
}

function isApprovalRefs(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ['sourceAcceptanceRef', 'placementApprovalRef', 'rolloutAuthorizationRef', 'legacyCombinedApprovalRef']
    .every(key => value[key] === null || isString(value[key]));
}

function isApplicationRow(value: unknown): value is GitOpsPortfolioRow {
  return isRecord(value)
    && isString(value.id)
    && isString(value.name)
    && (value.targetMode === 'direct' || value.targetMode === 'blueprint' || value.targetMode === 'inline_blueprint')
    && isString(value.sourceStatus)
    && isString(value.artifactStatus)
    && isNullableString(value.artifactQualification)
    && isString(value.placementStatus)
    && isString(value.rolloutStatus)
    && isString(value.runtimeStatus)
    && isString(value.healthStatus)
    && isNullableString(value.stackName)
     && isNullablePositiveInteger(value.blueprintId)
     && isNullablePositiveInteger(value.nodeId)
    && isNullableString(value.nodeName)
    && isRepository(value.repository)
    && ['desiredCommitSha', 'fetchedCommitSha', 'candidateGenerationId', 'acceptedGenerationId']
      .every(key => isNullableString(value[key]))
    && isRecordArray(value.targets)
    && value.targets.every(isTargetSummary)
    && isStringArray(value.attention)
    && isString(value.posture)
    && isRecord(value.drift)
    && isNumber(value.drift.count)
    && isStringArray(value.drift.classes)
    && isStringArray(value.availableActions)
    && isStringArray(value.limitations)
    && isNullableNumber(value.lastActivityAt)
    && isRecord(value.evidence)
    && typeof value.evidence.partial === 'boolean'
    && typeof value.evidence.unknown === 'boolean'
     && isPositiveIntegerArray(value.evidence.unreachableNodes);
}

function isLiveProjection(value: unknown): boolean {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.targetMode === 'not_applicable' || !isString(value.targetMode)) return false;
  if (!isNamedApplicationId(value.applicationId)
    || !isString(value.lifecycleStatus)
    || !['active', 'creating', 'detached', 'deleted'].includes(value.lifecycleStatus)) return false;
  if (!isNullableString(value.stackName) || !isNullablePositiveInteger(value.blueprintId) || !isNullableString(value.rolloutGenerationId)) return false;
  const facets = value.facets;
  if (!isRecord(facets)
    || !isSourceFacet(facets.source)
    || !isArtifactFacet(facets.artifact)
    || !isPlacementFacet(facets.placement)
    || !isRolloutFacet(facets.rollout)) return false;
  if (typeof facets.rollout.status === 'string'
    && GENERATION_BOUND_ROLLOUT_STATES.has(facets.rollout.status)
    && facets.rollout.rolloutGenerationId !== value.rolloutGenerationId) return false;
  if (facets.source.status === 'not_live' && facets.source.lifecycleStatus !== value.lifecycleStatus) return false;
  if (!isApprovalRefs(value.approvals)) return false;
  if (!isRecordArray(value.targets) || !value.targets.every(isTargetProjection)) return false;
  if (!isRecordArray(value.drift) || !value.drift.every(isDriftItem)) return false;
  if (!isRecordArray(value.limitations) || !value.limitations.every(isLimitation)) return false;
  return isStringArray(value.availableActions);
}

function isAbsentProjection(value: unknown): boolean {
  return isRecord(value)
    && value.schemaVersion === 1
    && value.targetMode === 'not_applicable'
    && value.applicationId === null
    && value.facets === null
    && Array.isArray(value.targets)
    && value.targets.length === 0
    && Array.isArray(value.drift)
    && value.drift.length === 0
    && Array.isArray(value.limitations)
    && value.limitations.every(isLimitation)
    && Array.isArray(value.availableActions)
    && value.availableActions.length === 0
    && value.approvals === null;
}

function isLimitation(value: unknown): boolean {
  return isRecord(value)
    && isString(value.code)
    && isString(value.message)
    && Object.hasOwn(value, 'evidence');
}

function isRollbackCandidates(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => isRecord(item)
    && isString(item.generationId)
    && isString(item.rolloutGenerationId)
    && isNumber(item.createdAt));
}

function isDetailResponse(body: unknown, requestedId: string): body is GitOpsPortfolioDetailResponse {
  if (!isRecord(body) || body.schemaVersion !== 1 || !isNumber(body.generatedAt)) return false;
  const application = body.application;
  if (!isApplicationRow(application) || !isRecord(body.projection)) return false;
  if (application.id !== requestedId) return false;
  const isBlueprintRequest = requestedId.startsWith('bp:');
  const isBlueprintApplication = application.targetMode === 'blueprint' || application.targetMode === 'inline_blueprint';
  if (isBlueprintRequest && !isBlueprintApplication) return false;
  if (isBlueprintRequest ? application.nodeId !== null : application.nodeId === null) return false;
  if (isBlueprintRequest) {
    const blueprintId = Number(requestedId.slice(3));
    if (!Number.isSafeInteger(blueprintId) || blueprintId <= 0 || application.blueprintId !== blueprintId) return false;
  } else {
    const separator = requestedId.indexOf(':');
    const nodeId = Number(requestedId.slice(0, separator));
    if (separator < 0 || !Number.isSafeInteger(nodeId) || nodeId <= 0 || application.nodeId !== nodeId) return false;
  }
  if (body.projection.targetMode === 'not_applicable') {
    const applicationId = requestedId.slice(requestedId.indexOf(':') + 1);
    if (isBlueprintRequest || !applicationId.startsWith('legacy:') || !isAbsentProjection(body.projection)) return false;
  } else {
    if (!isLiveProjection(body.projection)) return false;
    if (application.targetMode !== body.projection.targetMode) return false;
    if (application.blueprintId !== body.projection.blueprintId) return false;
    if (isBlueprintRequest) {
      const blueprintId = Number(requestedId.slice(3));
      if (body.projection.blueprintId !== blueprintId) return false;
    } else {
      const separator = requestedId.indexOf(':');
      if (body.projection.applicationId !== requestedId.slice(separator + 1)) return false;
    }
  }
  if (body.rollbackCandidates !== undefined && !isRollbackCandidates(body.rollbackCandidates)) return false;
  // A Blueprint read must state whether this hub may act on the Blueprint. The
  // final return already rejects anything that is not a boolean, null, or
  // absent, so only the absent case needs its own rule here.
  if (isBlueprintRequest && application.targetMode === 'blueprint' && body.blueprintEnabled === undefined) return false;
  return body.blueprintEnabled === undefined || body.blueprintEnabled === null || typeof body.blueprintEnabled === 'boolean';
}

async function readApplication(id: string): Promise<GitOpsPortfolioDetailResponse> {
  const res = await apiFetch(`/gitops/applications/${encodeURIComponent(id)}`, { localOnly: true });
  if (res.ok) {
    const body: unknown = await res.json().catch(() => null);
    if (!isDetailResponse(body, id)) {
      throw new ApplicationReadError({ kind: 'failed', message: 'The server returned an answer this version of Sencho cannot read.' });
    }
    return body;
  }
  const rawBody: unknown = await res.json().catch(() => null);
  const body = isErrorBody(rawBody) ? rawBody : null;
  const message = body?.error ?? `HTTP ${res.status}`;
  if (res.status === 400) throw new ApplicationReadError({ kind: 'invalid_link' });
  if (res.status === 404 || res.status === 403) throw new ApplicationReadError({ kind: 'not_readable' });
  if (res.status === 502 && body?.code === 'node_unsupported') {
    throw new ApplicationReadError({ kind: 'unsupported', message });
  }
  if (res.status === 503 && body?.code === 'evidence_unavailable') {
    throw new ApplicationReadError({ kind: 'evidence_unavailable', message });
  }
  if (res.status === 502 || res.status === 503) throw new ApplicationReadError({ kind: 'unreachable', message });
  throw new ApplicationReadError({ kind: 'failed', message });
}

export function useGitOpsApplication(id: string): GitOpsApplicationState {
  const [data, setData] = useState<GitOpsPortfolioDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<GitOpsApplicationError | null>(null);
  const [staleSince, setStaleSince] = useState<number | null>(null);
  const generation = useRef(0);
  const dataRef = useRef<GitOpsPortfolioDetailResponse | null>(null);

  const fetchApplication = useCallback(async () => {
    const current = ++generation.current;
    // With data on screen this is a refresh; without it (a retry after a
    // failed load) it is a load again, so the view shows progress either way.
    if (dataRef.current !== null) setRefreshing(true);
    else setLoading(true);
    try {
      const body = await readApplication(id);
      if (current !== generation.current) return;
      dataRef.current = body;
      setData(body);
      setError(null);
      setStaleSince(null);
    } catch (e) {
      if (current !== generation.current) return;
      const failure: GitOpsApplicationError = e instanceof ApplicationReadError
        ? e.failure
        : { kind: 'failed', message: e instanceof Error ? e.message : 'Failed to load the application.' };
      if (failure.kind === 'not_readable' || failure.kind === 'invalid_link' || dataRef.current === null) {
        // An application that stopped being readable is gone from this view,
        // not stale: keeping its last state would show something the reader
        // may no longer see.
        dataRef.current = null;
        setData(null);
        setStaleSince(null);
        setError(failure);
      } else {
        console.warn('[GitOps application] refresh failed; showing last-known state', id, failure);
        setStaleSince(prev => prev ?? Date.now());
      }
    } finally {
      if (current === generation.current) {
        setRefreshing(false);
        setLoading(false);
      }
    }
  }, [id]);

  // Callers key the view on the id, so a different application is a fresh
  // mount (and a fresh load), never a refresh that could flash the last one.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchApplication();
  }, [fetchApplication]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onInvalidate = (e: Event) => {
      const detail = (e as CustomEvent<{ scope?: string }>).detail;
      if (detail?.scope !== 'gitops') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void fetchApplication();
      }, INVALIDATE_DEBOUNCE_MS);
    };
    window.addEventListener('sencho:state-invalidate', onInvalidate);
    return () => {
      window.removeEventListener('sencho:state-invalidate', onInvalidate);
      if (timer) clearTimeout(timer);
    };
  }, [fetchApplication]);

  const refresh = useCallback(() => {
    void fetchApplication();
  }, [fetchApplication]);

  return { data, loading, refreshing, error, staleSince, refresh };
}
