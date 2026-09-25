import {
  decodeArtifactEvidenceJson,
  decodeGitOpsEvidenceLimitations,
  decodeGitOpsRequiredTargetsJson,
  decodeObservedArtifactIdentity,
  GitOpsJsonError,
  type ObservedArtifactIdentity,
} from './json';
import { GitOpsStore } from './store';
import { comparableObservationMatches } from './artifactIdentity';
import { parseSecretCapabilityFromJson } from './sops/capability';
import { SopsIdentityStore } from './sops/identityStore';
import {
  buildPreflightEvidence,
  decodePreflightEvidenceJson,
  executableArtifactRefusalReason,
  fingerprintPreflightEvidence,
  isPreflightBlocked,
  REGISTRY_PREFLIGHT_UNEVALUATED_REASON,
  registryPreflightBlockReason,
} from './preflight';
import type { BlueprintObservationStage } from './transitions';
import type {
  ArtifactExpectedIdentity,
  ArtifactFacet,
  ArtifactLatestEvidence,
  ArtifactQualification,
  ConfiguredPolicy,
  FutureGitOpsEvidence,
  GitOpsApplicationRow,
  GitOpsAvailableAction,
  GitOpsIdentityRef,
  GitOpsIntentRevisionRow,
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
  SourceReviewBlockReason,
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
  const app = facts.application;
  if (!app) return NOT_APPLICABLE_REVISION;
  const limitations: GitOpsLimitation[] = [];
  mergePersistedLimitations(app.evidence_limitations_json, limitations);
  const source = deriveSource(app, limitations);
  const artifact = deriveArtifact(app, app.accepted_generation_id, app.artifact_set_id, app.latest_artifact_set_id, limitations);
  const placement = derivePlacement(app, futureEvidence);
  const targets = facts.targets
    .slice()
    .sort((a, b) => a.node_id - b.node_id)
    .map((target) => deriveTarget(app, target, facts.healthDisabled, limitations));
  const rollout = deriveRollout(app, targets, artifact, facts.healthDisabled, futureEvidence);
  const availableActions = deriveActions(app, source, placement, targets);
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
    drift: collectDrift(app, facts.targets, targets, availableActions, {
      healthDisabled: facts.healthDisabled,
      source,
      placement,
      rollout,
    }, limitations),
    limitations,
    availableActions,
  };
}

/**
 * Every confirmed divergence the rows can prove, in a stable class order.
 *
 * Items are derived state: nothing here is ever written into
 * `stack_drift_findings` (that table belongs to the spatial Docker drift
 * engine, a different question). The order below is deliberate: the per-target
 * runtime and rollout items first, in target order, then the application-level
 * classes. Waiting states are not drift: a staged candidate, a pending review,
 * a queued rollout, and a deployed target still awaiting its health verdict are
 * progress, and the attention queue stays for exceptions.
 *
 * The application-level classes key off the facets this same projection shows,
 * so an item can never claim a divergence the facet calls settled progress, and
 * every facet status that means progress or waiting suppresses its class.
 *
 * The `invocation` class has no producer here: the observed invocation is not
 * persisted anywhere derive can read (no column, no history field), and
 * emitting the authored invocation against a permanent `unknown` would be
 * constant fabricated drift. It lands once an apply-time observation is
 * recorded.
 */
function collectDrift(
  app: GitOpsApplicationRow,
  rawTargets: GitOpsTargetCurrentRow[],
  targets: GitOpsTargetProjection[],
  availableActions: GitOpsAvailableAction[],
  facts: {
    healthDisabled: boolean;
    source: SourceFacet;
    placement: PlacementFacet;
    rollout: RolloutFacet;
  },
  limitations: GitOpsLimitation[],
): GitOpsDriftItem[] {
  return [
    ...collectRuntimeDrift(app, targets),
    ...collectSourceDrift(app, facts.source, availableActions),
    ...collectPlacementDrift(app, rawTargets, facts.placement, facts.rollout, limitations),
    ...collectManagedProjectDrift(app, rawTargets),
    ...collectHealthDrift(app, rawTargets, facts.healthDisabled),
  ];
}

/**
 * The two runtime-family classes.
 *
 * A comparable runtime artifact mismatch and a desired-versus-deployed
 * generation mismatch rest entirely on rows that exist now. Leaving `drift`
 * empty while a facet says `runtime_artifact_drift` would report one fault
 * twice with only one copy readable; the same holds whenever the known
 * pointers disagree, whatever presentation status outranks them.
 *
 * The generation-mismatch item carries the desired generation as expected and
 * the deployed generation as observed, owned by ComposeService. It clears
 * once the desired generation is deployed.
 *
 * The artifact item is emitted only for an exact or qualified expectation
 * against an exact or qualified observation whose identity strings differ.
 * Every other observation kind stays `artifact_verification_pending`, and
 * equal identities emit nothing. Policy composition has no producer yet, so
 * items carry null rather than a policy nothing wrote.
 */
function collectRuntimeDrift(
  app: GitOpsApplicationRow,
  targets: GitOpsTargetProjection[],
): GitOpsDriftItem[] {
  const items: GitOpsDriftItem[] = [];
  for (const target of targets) {
    // Generation mismatch: the target's contract is its desired generation,
    // and a different generation is running. Judged from the pointers
    // themselves, not from any one runtime status: paused, failed, recovering,
    // interrupted, and in-flight states all outrank the pointer comparison in
    // deriveRuntime, so keying the item to `applied_not_deployed` would drop
    // the report exactly when a failed deploy leaves the old workload serving.
    // A retired target is excluded: its pointers survive retirement on
    // purpose, but nothing can ever rebind it, so its mismatch would be a
    // permanently unresolvable item rather than a live divergence.
    if (
      !target.tombstoned
      && target.desiredGenerationId !== null
      && target.deployedGenerationId !== null
      && target.desiredGenerationId !== target.deployedGenerationId
    ) {
      items.push({
        class: 'runtime',
        expected: { kind: 'generation', id: target.desiredGenerationId },
        observed: { kind: 'generation', id: target.deployedGenerationId },
        freshnessAt: null,
        owner: 'ComposeService',
        reason: 'the target is running a different generation than the one it was asked to run',
        configuredPolicy: null,
        affectedTargets: [{ nodeId: target.nodeId, stackName: app.stack_name }],
        // The action answers for this affected target alone, using the same
        // legality predicate that puts deploy into availableActions, so a
        // sibling's clean convergence can never recommend deploying this one
        // while it is paused, failed, or otherwise unable to act.
        action: targetDeployLegal(app, target) ? 'deploy' : 'none',
      });
    }
    // Artifact mismatch: comparable exact/qualified expectation vs observation.
    // Per-node Direct (and unbound) mismatch stays runtime class;
    // authorized-rollout disagreement is rollout class.
    const driftClass =
      target.runtime.status === 'rollout_artifact_drift' ? 'rollout'
        : target.runtime.status === 'runtime_artifact_drift' ? 'runtime'
          : null;
    if (!driftClass) continue;
    const expected = target.artifact.status !== 'not_applicable' && 'expected' in target.artifact
      ? target.artifact.expected
      : null;
    if (!expected || expected.identity === null) continue;
    const observed = target.observedArtifactIdentity;
    if (observed.kind !== 'exact' && observed.kind !== 'qualified') continue;
    if (expectedSetAgreesWithObservation(expected.artifactSetId, observed, expected.identity)) continue;
    items.push({
      class: driftClass,
      expected: {
        kind: 'artifact_set',
        id: expected.artifactSetId,
        qualification: expected.qualification,
        evidenceVersion: expected.evidenceVersion,
      },
      observed: { kind: 'runtime_artifact', identity: observed.identity, observedAt: observed.observedAt },
      freshnessAt: observed.observedAt,
      owner: 'observed_artifact_identity',
      reason: driftClass === 'rollout'
        ? 'a required rollout target reports an artifact identity other than the approved rollout set'
        : 'the running workload reports an artifact identity other than the expected artifact set',
      configuredPolicy: null,
      affectedTargets: [{ nodeId: target.nodeId, stackName: app.stack_name }],
      action: 'none',
    });
  }
  return items;
}

/**
 * Source drift: the accepted generation is not the commit the configured ref
 * names, or the last fetch/validation failed so no revision is established.
 *
 * Both items key off the derived source facet, never off the raw pointers. A
 * fetch advances `desired_commit_sha` before any candidate is accepted, so the
 * pointer comparison alone would report a staged candidate (`candidate_ready`,
 * `source_review_pending`, `source_conflict_blocker`), a scheduled retry, an
 * apply in flight, or a suspended source as drift. The facet says which of
 * those is progress and which is a reconcile problem, and only
 * `source_reconcile_required` and a fetch or validation `source_failed` are
 * divergence. Inline Blueprint has no Git source to drift from.
 */
function collectSourceDrift(
  app: GitOpsApplicationRow,
  source: SourceFacet,
  availableActions: GitOpsAvailableAction[],
): GitOpsDriftItem[] {
  if (app.target_mode === 'inline_blueprint') return [];
  const policy = configuredGitSourcePolicy(app);
  const affectedTargets = [{ nodeId: null, stackName: app.stack_name ?? app.configured_source_stack_name }];
  const action: GitOpsAvailableAction = availableActions.includes('fetch') ? 'fetch' : 'none';
  const items: GitOpsDriftItem[] = [];

  if (source.status === 'source_reconcile_required' && app.desired_commit_sha && app.accepted_generation_id) {
    const store = GitOpsStore.getInstance();
    const accepted = store.getGeneration(app.accepted_generation_id);
    if (accepted && accepted.application_id === app.id && accepted.commit_sha !== app.desired_commit_sha) {
      items.push({
        class: 'source',
        expected: commitRef(app, app.desired_commit_sha),
        // The accepted generation carries the identity it was built from, so
        // after a rebind the old commit is still described by the old repo and
        // ref rather than the ones the application points at now.
        observed: commitRef(app, accepted.commit_sha, {
          repoUrl: accepted.repo_url,
          configuredRef: accepted.configured_ref,
        }),
        freshnessAt: null,
        owner: 'GitSourceService',
        reason: 'the accepted generation was built from a commit other than the one the configured ref names',
        configuredPolicy: policy,
        affectedTargets,
        action,
      });
    }
  }

  if (source.status === 'source_failed' && (source.failureStage === 'fetch' || source.failureStage === 'validation')) {
    items.push({
      class: 'source',
      expected: commitRef(app, app.desired_commit_sha),
      observed: app.fetched_commit_sha ? commitRef(app, app.fetched_commit_sha) : { kind: 'unknown' },
      freshnessAt: source.failureAt,
      owner: 'GitSourceService',
      reason: 'the last fetch or validation failed, so the configured ref content is not established',
      configuredPolicy: policy,
      affectedTargets,
      action,
    });
  }
  return items;
}

/**
 * Placement drift: a recorded placement approval that no longer binds the
 * current intent, or a live target that applied authority outside the
 * currently required target set.
 *
 * Git-managed Blueprint applications only: Direct has no placement model to
 * drift from, and Inline applies without a placement decision.
 *
 * Both items are gated on a settled application. The placement facet has to be
 * `blueprint_bound`, which is the only status that says no decision is
 * outstanding (acceptance, placement review, authorization, and preflight all
 * have their own statuses), and no operation may be in flight or interrupted:
 * while a decision is pending or a rollout is moving, an extra target or an
 * approval the current candidate no longer matches is the expected shape of
 * that work, not divergence. The extra-target branch additionally requires the
 * rollout to have settled as converged, because until it does the previous
 * target set is still the one serving.
 */
function collectPlacementDrift(
  app: GitOpsApplicationRow,
  rawTargets: GitOpsTargetCurrentRow[],
  placement: PlacementFacet,
  rollout: RolloutFacet,
  limitations: GitOpsLimitation[],
): GitOpsDriftItem[] {
  if (app.target_mode !== 'blueprint') return [];
  if (placement.status !== 'blueprint_bound') return [];
  if (app.active_operation_stage !== null || app.interruption_stage !== null) return [];
  if (recoveryInProgress(app.recovery_phase)) return [];
  const store = GitOpsStore.getInstance();
  const intent = app.intent_revision_id ? store.getIntentRevision(app.intent_revision_id) : undefined;
  if (!intent || intent.application_id !== app.id) return [];
  const policy = blueprintDriftPolicy(intent);
  const candidate = app.rollout_candidate_id ? store.getRolloutCandidate(app.rollout_candidate_id) : undefined;
  const candidateBelongs = candidate && candidate.application_id === app.id
    && candidate.intent_revision_id === app.intent_revision_id;
  let requiredNodeIds: number[] | null = null;
  if (candidateBelongs) {
    try {
      requiredNodeIds = decodeGitOpsRequiredTargetsJson(candidate.required_targets_json).nodeIds;
    } catch {
      // Without a readable required set there is no comparison to make, and
      // saying nothing quietly would read as agreement. Record why instead.
      limitations.push({
        code: 'placement_required_targets_invalid',
        message: 'rollout candidate required targets json is invalid',
        evidence: candidate.required_targets_json,
      });
    }
  }
  const items: GitOpsDriftItem[] = [];

  // A recorded approval that a live transition wrote but that no longer
  // resolves is stale. A ref with no row at all is a dangling pointer, which
  // approval resolution already refuses; it is not a stale approval.
  if (app.placement_approval_ref && requiredNodeIds) {
    const approval = store.getApproval(app.placement_approval_ref);
    const resolves = approval !== undefined && store.resolveApprovalRef(app.placement_approval_ref, {
      kind: 'placement_approval',
      applicationId: app.id,
      intentRevisionId: intent.id,
      requiredNodeIds,
    }) !== null;
    if (approval && !resolves) {
      const approvalIntent = approval.intent_revision_id
        ? store.getIntentRevision(approval.intent_revision_id)
        : undefined;
      items.push({
        class: 'placement',
        expected: intentRef(intent),
        observed: approvalIntent ? intentRef(approvalIntent) : { kind: 'unknown' },
        freshnessAt: approval.created_at,
        owner: 'BlueprintReconciler',
        reason: 'the recorded placement approval no longer binds the current intent and target set',
        configuredPolicy: policy,
        affectedTargets: [{ nodeId: null, stackName: intent.deploy_stack_name }],
        action: 'none',
      });
    }
  }

  // Acked authority outside the current required set, once the rollout that
  // should have withdrawn it has settled. Each target is judged under its own
  // intent, so a renamed stack reports the name the target actually runs.
  const settled = rollout.status === 'exactly_converged_healthy'
    || rollout.status === 'configuration_converged_artifact_qualified';
  if (requiredNodeIds && settled) {
    const required = new Set(requiredNodeIds);
    for (const target of rawTargets) {
      if (target.target_status !== 'active') continue;
      if (target.applied_generation_id === null) continue;
      if (required.has(target.node_id)) continue;
      if (target.active_operation_stage || target.interruption_stage) continue;
      if (recoveryInProgress(target.recovery_phase)) continue;
      const targetIntent = target.intent_revision_id
        ? store.getIntentRevision(target.intent_revision_id)
        : undefined;
      items.push({
        class: 'placement',
        expected: intentRef(intent),
        observed: targetIntent ? intentRef(targetIntent) : { kind: 'unknown' },
        freshnessAt: target.updated_at,
        owner: 'BlueprintReconciler',
        reason: 'the node holds placement authority outside the current required target set',
        configuredPolicy: policy,
        affectedTargets: [{ nodeId: target.node_id, stackName: targetStackName(app, intent, target) }],
        action: 'none',
      });
    }
  }
  return items;
}

/**
 * Managed-project drift: the applied managed project no longer matches the
 * accepted generation that owns it, per the stack's manifest cache.
 *
 * The manifest file is the source of truth and the cache columns are a cheap
 * projection of it, written after the promotion lands. So a null cache field
 * is unknown rather than disagreement and is skipped, and an apply, an
 * interrupted apply, or a recovery makes no claim at all: those windows
 * legitimately hold a new manifest with the previous commit, or the reverse,
 * until the writers finish. A Blueprint deploy or withdrawal runs on the
 * target while the application sits idle, so the targets are checked too.
 * Only a settled application whose every live target has applied the accepted
 * generation is compared, because acceptance lands before the apply reaches
 * the node.
 */
function collectManagedProjectDrift(
  app: GitOpsApplicationRow,
  rawTargets: GitOpsTargetCurrentRow[],
): GitOpsDriftItem[] {
  if (!app.accepted_generation_id) return [];
  if (app.active_operation_stage !== null || app.interruption_stage !== null) return [];
  if (recoveryInProgress(app.recovery_phase)) return [];
  const stackName = app.stack_name ?? app.configured_source_stack_name;
  if (!stackName) return [];
  const store = GitOpsStore.getInstance();
  const source = store.getStackGitSource(stackName);
  if (!source) return [];
  const generation = store.getGeneration(app.accepted_generation_id);
  if (!generation || generation.application_id !== app.id) return [];
  if (generation.manifest_version <= 0) return [];
  // Acceptance lands before the apply that promotes the project reaches the
  // node, so the cache still describes the previous generation until every
  // live target has applied this one. Until then the cache is behind, not
  // divergent. A target mid-deploy, interrupted, or recovering is the same
  // story one level down: a Blueprint deploy runs on the target alone.
  const live = rawTargets.filter((target) => target.target_status !== 'tombstoned');
  const settled = live.every((target) => target.applied_generation_id === generation.id
    && !target.active_operation_stage
    && !target.interruption_stage
    && !recoveryInProgress(target.recovery_phase));
  if (!settled) return [];

  const unusableManifest = source.manifest_state === 'absent'
    || source.manifest_state === 'migration_required'
    || source.manifest_state === 'unsupported';
  const versionMismatch = source.manifest_version !== null && source.manifest_version !== generation.manifest_version;
  const generationMismatch = source.manifest_generation !== null && source.manifest_generation !== generation.applied_dir;
  const commitMismatch = source.last_applied_commit_sha !== null && source.last_applied_commit_sha !== generation.commit_sha;
  if (!unusableManifest && !versionMismatch && !generationMismatch && !commitMismatch) return [];

  return [{
    class: 'managed_project',
    expected: { kind: 'generation', id: generation.id },
    observed: commitMismatch ? commitRef(app, source.last_applied_commit_sha) : { kind: 'unknown' },
    freshnessAt: source.updated_at,
    owner: 'GitProjectManifestService',
    reason: unusableManifest
      ? `the applied managed project has no usable manifest (state ${source.manifest_state})`
      : commitMismatch
        ? 'the applied managed project belongs to a commit other than the accepted generation'
        : 'the applied managed project does not match the manifest of the accepted generation',
    configuredPolicy: null,
    affectedTargets: [{ nodeId: null, stackName }],
    action: 'none',
  }];
}

/**
 * Health drift: the latest stack-scoped health run on a node failed for
 * exactly the generation that node is deployed on.
 *
 * A failed run bound to an older generation was superseded by the redeploy and
 * is not divergence, an observing or unknown run is uncertainty rather than
 * evidence, and a target mid-deploy or mid-recovery has no verdict to read yet.
 * The run is read from this instance's own `health_gate_runs`, which is where a
 * generation-bound stack gate is recorded: a target on a node this instance
 * does not host has no run row here, and a Git-managed Blueprint deployment
 * opens no generation-bound stack gate at all, so the class stays silent for
 * those rather than claiming a verdict nobody wrote. Each target is queried
 * under the stack name its own intent deployed, so a renamed stack reads its
 * real runs.
 */
function collectHealthDrift(
  app: GitOpsApplicationRow,
  rawTargets: GitOpsTargetCurrentRow[],
  healthDisabled: boolean,
): GitOpsDriftItem[] {
  if (healthDisabled) return [];
  if (app.active_operation_stage !== null || app.interruption_stage !== null) return [];
  if (recoveryInProgress(app.recovery_phase)) return [];
  const store = GitOpsStore.getInstance();
  const intent = app.intent_revision_id ? store.getIntentRevision(app.intent_revision_id) : undefined;
  const items: GitOpsDriftItem[] = [];
  for (const target of rawTargets) {
    if (target.target_status !== 'active') continue;
    if (!target.deployed_generation_id) continue;
    if (target.active_operation_stage || target.interruption_stage) continue;
    if (recoveryInProgress(target.recovery_phase)) continue;
    const stackName = targetStackName(app, intent, target);
    if (!stackName) continue;
    const run = store.getLatestStackHealthRun(target.node_id, stackName);
    if (!run || run.status !== 'failed' || run.deployed_generation_id !== target.deployed_generation_id) continue;
    items.push({
      class: 'health',
      expected: { kind: 'generation', id: target.deployed_generation_id },
      observed: { kind: 'health_run', runId: run.id, deployedGenerationId: run.deployed_generation_id ?? null },
      freshnessAt: run.ended_at ?? run.started_at,
      owner: 'HealthGateService',
      reason: 'the stack-scoped health run for the deployed generation failed',
      configuredPolicy: null,
      affectedTargets: [{ nodeId: target.node_id, stackName }],
      action: 'none',
    });
  }
  return items;
}

/**
 * The stack a target is running under.
 *
 * A Direct target keeps the application's stack. A Blueprint target is named by
 * the intent that deployed it, and an application converted from Direct to
 * Blueprint keeps the stack it was running under as its retained source stack
 * until the first Blueprint rollout gives the target an intent of its own, so
 * that retained identity outranks the current intent's stack.
 */
function targetStackName(
  app: GitOpsApplicationRow,
  currentIntent: GitOpsIntentRevisionRow | undefined,
  target: GitOpsTargetCurrentRow,
): string | null {
  if (app.target_mode === 'direct') return app.stack_name;
  const targetIntent = target.intent_revision_id
    ? GitOpsStore.getInstance().getIntentRevision(target.intent_revision_id)
    : undefined;
  return targetIntent?.deploy_stack_name
    ?? app.configured_source_stack_name
    ?? currentIntent?.deploy_stack_name
    ?? null;
}

/**
 * Whether a recovery is still moving. A recovery that finished, or that failed
 * and is waiting for an operator, is a terminal state the runtime facet
 * already reports, so it does not hold back the application-level classes.
 */
function recoveryInProgress(phase: string | null): boolean {
  return phase === 'capturing' || phase === 'restoring' || phase === 'compensating';
}

function commitRef(
  app: GitOpsApplicationRow,
  sha: string | null,
  identity?: { repoUrl: string; configuredRef: string },
): GitOpsIdentityRef {
  if (!sha) return { kind: 'none' };
  return {
    kind: 'commit',
    sha,
    repoUrl: identity?.repoUrl ?? app.configured_repo_url ?? '',
    ref: identity?.configuredRef ?? app.configured_ref ?? '',
  };
}

function intentRef(intent: GitOpsIntentRevisionRow): GitOpsIdentityRef {
  return { kind: 'intent', id: intent.id, composeContentSha256: intent.compose_content_sha256 };
}

function configuredGitSourcePolicy(app: GitOpsApplicationRow): ConfiguredPolicy {
  const stackName = app.stack_name ?? app.configured_source_stack_name;
  if (!stackName) return null;
  const source = GitOpsStore.getInstance().getStackGitSource(stackName);
  if (!source) return null;
  return {
    kind: 'git_source',
    autoApplyOnWebhook: source.auto_apply_on_webhook,
    autoDeployOnApply: source.auto_deploy_on_apply,
  };
}

function blueprintDriftPolicy(intent: GitOpsIntentRevisionRow): ConfiguredPolicy {
  const mode = intent.runtime_drift_policy;
  if (mode === 'observe' || mode === 'suggest' || mode === 'enforce') {
    return { kind: 'blueprint_drift', driftMode: mode };
  }
  return null;
}

/**
 * True when a target's observed identity is exact or qualified and matches
 * the expected set by per-service membership (platform child or index),
 * falling back to identity-string equality only when the set has no services.
 * Used to withhold exactly_converged_healthy until every required live target
 * has digest proof, not only applied/healthy pointers.
 */
function expectedSetAgreesWithObservation(
  expectedSetId: string,
  observed: ObservedArtifactIdentity,
  identityFallback: string | null,
): boolean {
  if (observed.kind !== 'exact' && observed.kind !== 'qualified') return false;
  const expectedRow = GitOpsStore.getInstance().getArtifactSet(expectedSetId);
  if (expectedRow) {
    try {
      const decoded = decodeArtifactEvidenceJson(expectedRow.evidence_json);
      if (decoded.services && decoded.services.length > 0) {
        return comparableObservationMatches(decoded.services, observed);
      }
    } catch {
      return false;
    }
  }
  return identityFallback !== null && observed.identity === identityFallback;
}

function targetObservationMatchesExpected(target: GitOpsTargetProjection): boolean {
  const expected = target.artifact.status !== 'not_applicable' && 'expected' in target.artifact
    ? target.artifact.expected
    : null;
  if (!expected || expected.identity === null) return false;
  if (expected.qualification !== 'exact' && expected.qualification !== 'qualified') return false;
  return expectedSetAgreesWithObservation(expected.artifactSetId, target.observedArtifactIdentity, expected.identity);
}

/**
 * The persisted block reason, narrowed to the codes this build knows.
 *
 * A value from a newer writer is dropped rather than passed through: the
 * projection feeds a closed classifier, and an unknown code would have to be
 * treated as a code by every consumer anyway. Dropping degrades to the plain
 * review state, which is still truthful about what is happening.
 */
function normalizeSourceReviewBlockReason(value: string | null): SourceReviewBlockReason | null {
  return value === 'stateful_withdrawal' ? value : null;
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
  if (app.suspended_at) {
    return {
      ...identity,
      status: 'source_suspended',
      suspendedAt: app.suspended_at,
      suspendedReason: app.source_suspended_reason,
    };
  }
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
    // A candidate only counts as ready when its generation row exists under
    // this application and the application's materialization fingerprint is
    // still the one the generation was built from; applyStarted refuses
    // anything else, so a dangling or foreign row is a reconcile problem,
    // not a ready one.
    if (!generation || generation.application_id !== app.id) {
      limitations.push({
        code: 'candidate_generation_invalid',
        message: 'candidate generation row is missing or belongs to another application',
        evidence: app.candidate_generation_id,
      });
      return { ...identity, status: 'source_reconcile_required' };
    }
    if (generation.materialization_fingerprint !== app.materialization_fingerprint) {
      return { ...identity, status: 'source_reconcile_required' };
    }
    if (app.candidate_plan_blocked === 1) return { ...identity, status: 'source_conflict_blocker' };
    if (app.review_required === 1) {
      return {
        ...identity,
        status: 'source_review_pending',
        reviewBlockReason: normalizeSourceReviewBlockReason(app.review_block_reason),
      };
    }
    return { ...identity, status: 'candidate_ready' };
  }
  if (app.accepted_generation_id) {
    const accepted = store.getGeneration(app.accepted_generation_id);
    // An acceptance only counts when its generation row exists under this
    // application; missing evidence cannot establish the fingerprint and sha
    // agreement (the latter when a desired commit is configured) that the
    // success claim rests on, so a dangling or foreign pointer is a reconcile
    // problem, not an accepted one.
    if (!accepted || accepted.application_id !== app.id) {
      limitations.push({
        code: 'accepted_generation_invalid',
        message: 'accepted generation row is missing or belongs to another application',
        evidence: app.accepted_generation_id,
      });
      return { ...identity, status: 'source_reconcile_required' };
    }
    if (
      !app.desired_commit_sha
      || accepted.materialization_fingerprint !== app.materialization_fingerprint
      || accepted.commit_sha !== app.desired_commit_sha
    ) {
      return { ...identity, status: 'source_reconcile_required' };
    }
    return { ...identity, status: 'application_generation_accepted' };
  }
  // A scheduled poll means the source settled without any stronger evidence
  // to report (no candidate, no accepted generation): the controller is
  // waiting for the next poll. The failure and retry branches above win over
  // this cursor, so a poll schedule is never an excuse to hide a failure.
  if (app.next_poll_at) {
    return { ...identity, status: 'source_poll_scheduled', nextPollAt: app.next_poll_at };
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
  // Inline without a frozen generation stays not_applicable (no fabricated
  // exact convergence). Once freeze binds generation + expected set pointers,
  // Inline derives the same way as Git-managed. Direct with a null
  // generationId is likewise not_applicable.
  if (app.target_mode === 'inline_blueprint' && !generationId) return { status: 'not_applicable' };
  if (!generationId) return { status: 'not_applicable' };
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
      ...(decoded.services ? { services: decoded.services } : {}),
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

function derivePlacement(
  app: GitOpsApplicationRow,
  futureEvidence: FutureGitOpsEvidence | null,
): PlacementFacet {
  if (futureEvidence?.placement) {
    const ev = futureEvidence.placement;
    if (ev.kind === 'source_acceptance_pending') {
      return {
        status: 'source_acceptance_pending',
        sourceAcceptanceRef: app.source_acceptance_ref,
        candidateGenerationId: ev.candidateGenerationId,
      };
    }
    if (ev.kind === 'authorization_pending') {
      return {
        status: 'rollout_authorization_pending',
        rolloutAuthorizationRef: null,
        binding: ev.binding,
      };
    }
    if (ev.kind === 'authorization_stale') {
      return {
        status: 'rollout_authorization_stale',
        rolloutAuthorizationRef: ev.rolloutAuthorizationRef,
        bound: ev.bound,
      };
    }
    if (ev.kind === 'preflight_blocked') {
      return {
        status: 'preflight_blocked',
        reason: ev.reason,
        binding: ev.binding,
      };
    }
  }

  if (app.target_mode === 'direct') return { status: 'unbound_direct' };
  if (!app.intent_revision_id) return { status: 'unknown', limitation: 'missing_intent' };
  if (app.legacy_combined_approval_ref && !app.placement_approval_ref) {
    return { status: 'placement_review_pending' };
  }

  const store = GitOpsStore.getInstance();
  const candidateGenerationId = app.candidate_generation_id
    ?? (app.rollout_candidate_id
      ? store.getRolloutCandidate(app.rollout_candidate_id)?.accepted_generation_id
      : null);
  // A Git-managed application takes every generation through its own
  // acceptance, so a staged generation that is not the accepted one leaves
  // source acceptance outstanding even when an earlier generation was already
  // accepted. Only a live staged generation asks for that decision: the
  // candidate's own binding names the generation an earlier rollout
  // authorized, and after a source-only update it names the previous one, so
  // treating it as pending would report a review no generation is waiting for.
  // The other modes keep the original ref-based test: their staged candidate is
  // the Inline Apply review, not a source decision.
  const sourceAcceptanceOutstanding = app.target_mode === 'blueprint'
    ? app.candidate_generation_id !== null && app.candidate_generation_id !== app.accepted_generation_id
    : candidateGenerationId !== null && !app.source_acceptance_ref;
  if (sourceAcceptanceOutstanding && candidateGenerationId != null) {
    return {
      status: 'source_acceptance_pending',
      sourceAcceptanceRef: app.source_acceptance_ref,
      candidateGenerationId,
    };
  }

  // Git-managed placement decision. A current candidate with no recorded
  // placement approval means an operator approval is the next authority step.
  // This does not depend on the accepted generation or artifact set: the
  // approval binds the intent plus the frozen blast, and the earlier
  // source_acceptance_pending branch above already speaks for a candidate
  // whose source has not been accepted.
  if (app.target_mode === 'blueprint' && app.rollout_candidate_id && !app.placement_approval_ref) {
    return { status: 'placement_review_pending' };
  }

  const ingredients = store.authorizationIngredients(app);
  if (!ingredients) {
    return { status: 'blueprint_bound', completion: 'unknown' };
  }

  // Stored evidence drives derive. Never probe here.
  let stored = app.latest_preflight_evidence_json
    ? decodePreflightEvidenceJson(app.latest_preflight_evidence_json)
    : null;
  // Artifact set mismatch: treat stored body as unknown (do not project last cycle).
  if (stored && stored.artifactSetId !== app.artifact_set_id) {
    stored = buildPreflightEvidence({
      artifactSetId: app.artifact_set_id,
      targets: ingredients.requiredNodeIds.map((nodeId) => ({
        nodeId,
        sourceClass: 'hub_ephemeral' as const,
        readiness: 'unknown' as const,
        hosts: [],
        expired: false,
      })),
    });
  }

  const fingerprint = stored
    ? fingerprintPreflightEvidence(stored)
    : fingerprintPreflightEvidence(buildPreflightEvidence({
      artifactSetId: app.artifact_set_id,
      targets: [],
    }));
  const binding = { ...ingredients, preflightFingerprint: fingerprint };

  // 2a. Executable artifact evidence must exist before registry readiness is a
  // question: naming the artifact identity keeps the operator off a registry
  // hunt when the set was never resolved.
  const artifactRefusal = executableArtifactRefusalReason(
    store.getArtifactSet(ingredients.artifactSetId)?.qualification,
  );
  if (artifactRefusal) {
    return { status: 'preflight_blocked', reason: artifactRefusal, binding };
  }

  // 2. Stored blocked/unknown outranks live pointers.
  if (stored && isPreflightBlocked(stored)) {
    return {
      status: 'preflight_blocked',
      reason: registryPreflightBlockReason(stored),
      binding,
    };
  }

  const authRef = app.rollout_authorization_ref;
  const live = authRef ? store.currentAuthorizationBinding(app) : null;
  const liveResolved = Boolean(
    live
    && authRef
    && store.resolveApprovalRef(authRef, {
      kind: 'rollout_authorization',
      applicationId: app.id,
      binding: live,
    }),
  );

  // 3. Live resolving auth and no stored evaluation: keep authorized path (R6).
  if (liveResolved && !stored) {
    return { status: 'blueprint_bound', completion: 'unknown' };
  }

  // 4. Live auth fingerprint disagrees with stored evidence.
  if (liveResolved && live && stored && live.preflightFingerprint !== fingerprint) {
    return {
      status: 'rollout_authorization_stale',
      rolloutAuthorizationRef: authRef!,
      bound: live,
    };
  }

  // 5. Stored ready and live auth fingerprint matches.
  if (liveResolved && stored && live && live.preflightFingerprint === fingerprint) {
    return { status: 'blueprint_bound', completion: 'unknown' };
  }

  // Stale/missing live ref while pointer present.
  if (authRef && !liveResolved) {
    return {
      status: 'rollout_authorization_stale',
      rolloutAuthorizationRef: authRef,
      bound: live ?? binding,
    };
  }

  // 6. Stored ready/not_required and no live auth.
  if (stored && !isPreflightBlocked(stored) && !liveResolved) {
    return {
      status: 'rollout_authorization_pending',
      rolloutAuthorizationRef: null,
      binding,
    };
  }

  // 7. No stored evidence, no live auth: blocked with unevaluated reason.
  return {
    status: 'preflight_blocked',
    reason: REGISTRY_PREFLIGHT_UNEVALUATED_REASON,
    binding,
  };
}

function deriveRollout(
  app: GitOpsApplicationRow,
  targets: GitOpsTargetProjection[],
  artifact: ArtifactFacet,
  healthDisabled: boolean,
  futureEvidence: FutureGitOpsEvidence | null,
): RolloutFacet {
  if (futureEvidence?.rollout) {
    const ev = futureEvidence.rollout;
    const statusMap = {
      queued: 'rollout_queued',
      canary: 'canary_in_progress',
      batch: 'batch_in_progress',
      superseded: 'rollout_superseded',
      fully_deployed_health_pending: 'fully_deployed_health_pending',
      configuration_converged_artifact_qualified: 'configuration_converged_artifact_qualified',
      exactly_converged_healthy: 'exactly_converged_healthy',
    } as const;
    return {
      status: statusMap[ev.kind],
      rolloutGenerationId: ev.rolloutGenerationId,
    };
  }

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
  if (targets.some(target => !target.tombstoned && target.connectivity === 'unreachable')) return { status: 'target_unreachable' };
  if (targets.some(target => !target.tombstoned && target.connectivity === 'stale')) return { status: 'target_stale' };
  if (app.pause_at) return { status: 'rollout_paused', pauseAt: app.pause_at, pauseReason: app.pause_reason };
  if (app.partial_json) return { status: 'partially_rolled_out', partial: app.partial_json };
  if (app.target_mode === 'direct') return { status: 'not_applicable' };

  const store = GitOpsStore.getInstance();
  if (app.rollout_generation_id) {
    const generation = store.getRolloutGeneration(app.rollout_generation_id);
    if (generation?.superseded_at) {
      return { status: 'rollout_superseded', rolloutGenerationId: app.rollout_generation_id };
    }
  }

  if (app.rollout_authorization_ref && app.rollout_generation_id) {
    const binding = store.currentAuthorizationBinding(app);
    if (binding) {
      const rolloutGenerationId = app.rollout_generation_id;
      const required = binding.requiredNodeIds;
      const byNode = new Map(targets.map((target) => [target.nodeId, target]));

      const liveTarget = (nodeId: number): GitOpsTargetProjection | undefined => {
        const target = byNode.get(nodeId);
        return target && !target.tombstoned ? target : undefined;
      };

      const allAcked = required.every((nodeId) => {
        const target = liveTarget(nodeId);
        return !!target
          && target.appliedGenerationId === binding.acceptedGenerationId
          && target.intentRevisionId === binding.intentRevisionId
          && target.approvals.rolloutAuthorizationRef === app.rollout_authorization_ref;
      });
      if (!allAcked) {
        return { status: 'rollout_queued', rolloutGenerationId };
      }

      const allHealthy = required.every((nodeId) => {
        const target = liveTarget(nodeId);
        if (!target) return false;
        return healthDisabled || target.healthyGenerationId === binding.acceptedGenerationId;
      });
      if (!allHealthy) {
        return { status: 'fully_deployed_health_pending', rolloutGenerationId };
      }

      if (artifact.status !== 'artifact_exact') {
        return { status: 'configuration_converged_artifact_qualified', rolloutGenerationId };
      }
      // Exact convergence also needs per-target digest proof. Pointers and
      // health alone must not claim exactly_converged_healthy while any
      // required live target lacks a matching exact/qualified observation.
      const allDigestMatched = required.every((nodeId) => {
        const target = liveTarget(nodeId);
        return !!target && targetObservationMatchesExpected(target);
      });
      if (!allDigestMatched) {
        return {
          status: 'partially_rolled_out',
          partial: app.partial_json ?? { reason: 'runtime_artifact_divergence' },
        };
      }
      return { status: 'exactly_converged_healthy', rolloutGenerationId };
    }
  }

  if (app.rollout_candidate_id) {
    return { status: 'rollout_not_executable', rolloutCandidateId: app.rollout_candidate_id };
  }
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
      && !expectedSetAgreesWithObservation(artifact.expected.artifactSetId, observed, artifact.expected.identity)
    ) {
      if (target.rollout_authorization_ref || target.rollout_generation_id) {
        return { status: 'rollout_artifact_drift' };
      }
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
  if (generation) {
    const cap = parseSecretCapabilityFromJson(generation.secret_capability_json);
    if (cap && cap.requiredRecipients.length > 0) {
      const app = GitOpsStore.getInstance().getApplication(target.application_id);
      const stackName = app?.stack_name;
      if (stackName) {
        const known = new Set(
          SopsIdentityStore.getInstance().listPublic(target.application_id, stackName).map((i) => i.recipient),
        );
        const missing = cap.requiredRecipients.filter((recipient) => !known.has(recipient));
        if (missing.length > 0) {
          limitations.push({
            code: 'lkg_missing_sops_key',
            message: 'LKG generation requires age identities that are not available on this node',
            evidence: missing.join(','),
          });
          return { status: 'unavailable' };
        }
      }
    }
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

/**
 * Application-level conditions under which deploying is withheld outright: an
 * operation or recovery already owns the stack, so nothing may start a deploy
 * even where a target's own state would make one legal.
 */
function appDeployWithheld(app: GitOpsApplicationRow): boolean {
  return app.active_operation_stage === 'fetch_started'
    || app.active_operation_stage === 'apply_started'
    || app.recovery_phase === 'restoring'
    || app.recovery_phase === 'compensating'
    || app.recovery_phase === 'failed'
    || app.failure_stage === 'recovery';
}

/**
 * Whether deploying this exact target is legal right now, per the revision-state
 * plan's available-action rules. Deliberately per target: the application-wide
 * action list is a union across targets, so keying an item to it would tell a
 * paused or failed sibling to deploy because a healthy sibling diverged.
 *
 * Direct targets converge a known divergence outright; an interrupted deploy is
 * retried only against the generation still applied, exactly what deployStarted
 * will demand. Writers keep applied and desired equal today, so keying on
 * applied can never advertise an action the transition would refuse.
 *
 * Targets of Blueprint modes have no Direct deploy at all: their sole retry
 * repeats an interrupted deploy or withdraw, legal only while both persisted
 * identities equal what the application currently requires. An absent pair
 * counts as matching: rollout candidates come from a later-phase producer, so
 * inline Blueprints carry no candidate id on either side yet, and demanding one
 * here would leave every interrupted inline deploy permanently unactionable. A
 * superseded value on either side fails the comparison.
 *
 * disk_invocation_drift is deliberately absent: no producer reaches that
 * status in this slice, and until one lands the predicate fails safe to a
 * reported mismatch with no deploy recommendation.
 */
function targetDeployLegal(app: GitOpsApplicationRow, target: GitOpsTargetProjection): boolean {
  if (appDeployWithheld(app) || target.tombstoned) return false;
  if (app.target_mode !== 'direct') {
    if (target.runtime.status !== 'completion_unknown') return false;
    const stage = target.runtime.interruptedStage;
    if (stage !== 'blueprint_deploy_started' && stage !== 'blueprint_withdraw_started') return false;
    return (
      target.runtime.interruptedIntentRevisionId === app.intent_revision_id
      && target.runtime.interruptedRolloutCandidateId === app.rollout_candidate_id
    );
  }
  if (target.runtime.status === 'applied_not_deployed') return true;
  return (
    target.runtime.status === 'completion_unknown'
    && target.runtime.interruptedStage === 'deploy_started'
    && target.runtime.interruptedGenerationId !== null
    && target.runtime.interruptedGenerationId === target.appliedGenerationId
  );
}

function deriveActions(
  app: GitOpsApplicationRow,
  source: SourceFacet,
  placement: PlacementFacet,
  targets: GitOpsTargetProjection[],
): GitOpsAvailableAction[] {
  if (source.status === 'applying' || source.status === 'checking_fetching') return ['none'];
  if (source.status === 'recovery_required' || source.status === 'recovery_failed') return ['none'];
  const actions = new Set<GitOpsAvailableAction>();
  // Fetch is offered only to live Direct applications: Blueprint Git-source
  // integration ships later, until then no Blueprint mode advertises fetch.
  if (
    app.target_mode === 'direct'
    && (
      source.status === 'never_reconciled'
      || source.status === 'source_reconcile_required'
      || source.status === 'source_retry_scheduled'
      || (source.status === 'source_unknown' && source.interruptedStage === 'fetch_started')
      || (source.status === 'source_failed' && (source.failureStage === 'fetch' || source.failureStage === 'validation'))
    )
  ) {
    actions.add('fetch');
  }
  if (source.status === 'candidate_ready') actions.add('apply');
  // An interrupted apply may be finished only while its recorded generation is
  // still the current candidate and nothing has since suspended the source or
  // blocked that candidate, all of which applyStarted would refuse. No shipped
  // producer pairs blockage with a matching interruption today, because
  // blocking always mints a fresh candidate id; these clauses hold the gate to
  // the transition table's contract regardless of what future producers do.
  if (
    source.status === 'source_unknown'
    && source.interruptedStage === 'apply_started'
    && source.interruptedGenerationId !== null
    && source.interruptedGenerationId === app.candidate_generation_id
    && !app.suspended_at
    && app.candidate_plan_blocked !== 1
  ) {
    // applyStarted also demands the candidate generation exist under this
    // application with an unchanged materialization fingerprint; prove all of
    // it here rather than recommend a transition that would refuse.
    const candidate = GitOpsStore.getInstance().getGeneration(app.candidate_generation_id);
    if (
      candidate !== undefined
      && candidate.application_id === app.id
      && candidate.materialization_fingerprint === app.materialization_fingerprint
    ) {
      actions.add('apply');
    }
  }
  if (app.candidate_generation_id && !app.active_operation_stage) actions.add('dismiss');
  if (targets.some((target) => targetDeployLegal(app, target))) actions.add('deploy');
  // The combined Apply is the Inline placement decision. A Git-managed
  // placement review is the decomposed approval action, which is not this
  // action vocabulary; offering `approve_legacy` there would name a flow the
  // application refuses.
  if (placement.status === 'placement_review_pending' && app.target_mode === 'inline_blueprint') {
    actions.add('approve_legacy');
  }
  // Controller controls are Direct-only. In-flight and recovery statuses
  // already returned ['none'] above, so those never offer suspend/resume/retry.
  if (app.target_mode === 'direct') {
    if (app.suspended_at) {
      actions.add('resume');
    } else {
      actions.add('suspend');
      if (source.status === 'source_failed' || source.status === 'source_retry_scheduled') {
        actions.add('retry');
      }
    }
  }
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
