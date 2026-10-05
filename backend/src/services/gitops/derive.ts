import path from 'path';

import {
  decodeArtifactEvidenceJson,
  decodeGitOpsEvidenceLimitations,
  decodeGitOpsRequiredTargetsJson,
  decodeObservedArtifactIdentity,
  decodeObservedInvocation,
  GitOpsJsonError,
  type ObservedArtifactIdentity,
  type ObservedInvocationIdentity,
} from './json';
import { DatabaseService } from '../DatabaseService';
import { NodeRegistry } from '../NodeRegistry';
import { GitOpsStore } from './store';
import { authorityPolicyReads } from './authorityPolicyProjection';
import { comparableObservationMatches } from './artifactIdentity';
import { canonicalizeAuthoredInvocation, compareInvocations } from './invocationIdentity';
import { runningGenerationForTarget } from './recoveryCapture';
import {
  DEFAULT_HEALTH_ROLLOUT_POLICY,
  decodeFrozenRolloutStrategy,
  decodeIntentHealthPolicy,
  gatesAdvancement,
  type HealthRolloutPolicy,
} from './healthPolicy';
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
  HealthGateFacet,
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
  // An application that does not exist has no policy to report. Present and
  // empty rather than absent, so a reader never has to tell "no application"
  // from "an older build said nothing".
  authorityPolicies: [],
};
// Frozen after construction rather than inline: the collections stay mutable
// types so the projection union still matches, while the shared instance
// refuses writes at runtime.
for (const collection of [
  NOT_APPLICABLE.targets,
  NOT_APPLICABLE.drift,
  NOT_APPLICABLE.limitations,
  NOT_APPLICABLE.availableActions,
  NOT_APPLICABLE.authorityPolicies,
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
// Targets are derived before the placement facet, which reads them to report
  // a stateful hold. The dependency is one-way: `deriveTarget` reads the
  // application row and the target's own evidence, never the placement facet,
  // so deriving them first introduces no cycle.
  // Resolved once here because it reads the application's intent revision and
  // the live Blueprint row, neither of which varies per target.
  const confirmationExpected = blueprintConfirmsOutcome(app, facts.healthDisabled);
  // Also resolved once per application, for the same reason: it is the accepted
  // intent revision, and a Blueprint target's stack name is read from it rather
  // than from the application, so the health supersede rule needs it. Resolved
  // here so a fleet of targets costs one read. `collectHealthDrift` reads the
  // same revision again for its own stack name.
  const acceptedIntent = app.intent_revision_id
    ? GitOpsStore.getInstance().getIntentRevision(app.intent_revision_id)
    : undefined;
  const targets = facts.targets
    .slice()
    .sort((a, b) => a.node_id - b.node_id)
    .map((target) => deriveTarget(app, acceptedIntent, target, facts.healthDisabled, limitations, confirmationExpected));
  const placement = derivePlacement(app, futureEvidence, targets);
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
    authorityPolicies: authorityPolicyReads(app, { source, placement, rollout }),
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
 * The `invocation` class compares the compose invocation a generation was
 * authored with against the one a node recorded at apply time. It is the one
 * class that needs a read of the node to mean anything, so it reports nothing
 * until an observation exists, and a missing observation is a caveat rather
 * than agreement.
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
    ...collectRuntimeDrift(app, targets, rawByNodeId(rawTargets)),
    ...collectSourceDrift(app, facts.source, availableActions),
    ...collectPlacementDrift(app, rawTargets, facts.placement, facts.rollout, limitations),
    ...collectManagedProjectDrift(app, rawTargets),
    ...collectHealthDrift(app, rawTargets, facts.healthDisabled),
    ...collectInvocationDrift(app, rawTargets, projectionByNodeId(targets), limitations),
  ];
}

/**
 * The projections keyed by node, so a collector reading raw rows can reach the
 * derived facet of the same target. The two lists are the same targets in a
 * possibly different order, so a position lookup would pair a target with its
 * neighbour.
 */
function projectionByNodeId(targets: GitOpsTargetProjection[]): Map<number, GitOpsTargetProjection> {
  return new Map(targets.map((target) => [target.nodeId, target]));
}

/**
 * The raw per-target rows, keyed by node.
 *
 * `runningGenerationForTarget` reads the row rather than the projection, so a
 * caller comparing a projected target against its running generation needs the
 * row behind it. A missing row is absent rather than null, which the helper
 * already answers as "nothing is running".
 */
function rawByNodeId(targets: GitOpsTargetCurrentRow[]): Map<number, GitOpsTargetCurrentRow> {
  return new Map(targets.map((target) => [target.node_id, target]));
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
  rawByNodeId: ReadonlyMap<number, GitOpsTargetCurrentRow>,
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
    //
    // Compared against the per-mode running generation, not the deployed
    // pointer. A Blueprint target has no deploy-bound writer, so its deployed
    // pointer is null by construction rather than because a deploy is
    // outstanding; reading it here made the item unreachable for every Blueprint
    // target, which is how a confirmed divergence could show in the runtime
    // facet while contributing nothing to this list. `deriveRuntime` resolves
    // the same helper for the same reason, so the two surfaces cannot disagree
    // about which generation is running.
    const runningGenerationId = runningGenerationForTarget(app, rawByNodeId.get(target.nodeId));
    if (
      !target.tombstoned
      && target.desiredGenerationId !== null
      && runningGenerationId !== null
      && target.desiredGenerationId !== runningGenerationId
    ) {
      items.push({
        class: 'runtime',
        expected: { kind: 'generation', id: target.desiredGenerationId },
        observed: { kind: 'generation', id: runningGenerationId },
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
    // Which of the two runtime-family classes it belongs to is the helper's
    // call, because a Blueprint's reconciler observation reports it too.
    const driftClass = runtimeDriftClass(target);
    if (!driftClass) continue;
    const expected = target.artifact.status !== 'not_applicable' && 'expected' in target.artifact
      ? target.artifact.expected
      : null;
    if (!expected || expected.identity === null) continue;
    // The expected set has to be comparable too, not just the observation.
    // `deriveRuntime` checks this before it assigns either artifact-identity
    // status, so those two arrive here already qualified. `drifted` is assigned
    // before that check, so this path has to enforce it for itself: a set Sencho
    // could not resolve, or resolved against a stale resolution, still carries a
    // real fingerprint identity, and without this the item would report a
    // confirmed divergence against an expectation nothing verified. The facet
    // already reads that case as pending or unverified, and the two must agree.
    if (expected.qualification !== 'exact' && expected.qualification !== 'qualified') continue;
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
      observed: {
        kind: 'runtime_artifact',
        identity: observed.identity,
        observedAt: observed.observedAt,
        // The identity is a fingerprint over the set, so on its own the item
        // cannot say which service moved to which digest. The expected side is
        // a pointer to a stored set that a reader resolves itself; the observed
        // side was inlined, so its per-service evidence travels with it.
        services: observed.services,
      },
      freshnessAt: observed.observedAt,
      owner: 'observed_artifact_identity',
      reason: reasonForRuntimeDrift(target.runtime.status, driftClass),
      configuredPolicy: null,
      affectedTargets: [{ nodeId: target.nodeId, stackName: app.stack_name }],
      action: 'none',
    });
  }
  return items;
}

/**
 * Why a runtime-family item is reported, in words that stay true for every
 * cause that can produce one.
 *
 * The two artifact-identity statuses are decided by comparing an expected set
 * against an observation on rows written by a deploy, so the workload behind
 * the observation is the one that is running, and the reason can say so.
 *
 * `drifted` is different, and this is the case worth being careful about. The
 * Blueprint reconciler records that status for three causes: a digest
 * mismatch, a revision mismatch, and a container that is not running. It
 * refreshes the stored observation only on the first, because the other two
 * return before it reads the node, so the identity this item compares is the
 * last one that was observed, not necessarily a current reading. The cause is
 * held on the Blueprint deployment row, which this projection does not read and
 * which a remote node's hub has no copy of, so the item cannot name it. The
 * reason therefore states the comparison that was actually made and leaves the
 * cause to the facet, which does report `drifted`. `freshnessAt` carries the
 * observation's own timestamp, so a reader can see how old the evidence is.
 */
function reasonForRuntimeDrift(
  status: RuntimeFacet['status'],
  driftClass: 'runtime' | 'rollout',
): string {
  if (status === 'drifted') {
    return 'the last artifact identity observed for this target differs from the expected artifact set';
  }
  return driftClass === 'rollout'
    ? 'a required rollout target reports an artifact identity other than the approved rollout set'
    : 'the running workload reports an artifact identity other than the expected artifact set';
}

/**
 * Which runtime-family class a target's artifact divergence belongs to, or null
 * when the status is not a candidate for one. Whether it is actually reported
 * is decided by the evidence guards at the call site, not here.
 *
 * The class answers whose authority the divergence is from, which is a fact
 * about the target rather than about the status: a target bound to an
 * authorized rollout answers `rollout`, everything else answers `runtime`.
 * `deriveRuntime` picks `rollout_artifact_drift` over `runtime_artifact_drift`
 * on that same test, so for those two statuses the class is the one the target's
 * own facet already implies. `drifted` names no class in that vocabulary, which
 * is why the same test is what answers for it, and why its reason is worded
 * separately by `reasonForRuntimeDrift`. The test is spelled the way
 * `deriveRuntime` spells it, so the two cannot answer differently about the
 * same target.
 *
 * A rollout target is therefore reported once as rollout, not also as runtime:
 * one target yields at most one item for this comparison, whatever class it
 * lands in. (A target whose desired and deployed generations also disagree is a
 * different comparison and keeps its own item, which is unchanged by this.)
 *
 * `drifted` is in this set because it is how a Blueprint reports a drift the
 * reconciler observed. That observation outranks the pointer and artifact
 * comparisons in `deriveRuntime`, so a recorded Blueprint digest drift arrives
 * carrying this status rather than either of the two above, and without it the
 * canonical list would say nothing about an application the deployment row
 * already calls drifted. Being reported still depends on the comparison, and on
 * both sides of it: an approved set that is not exact or qualified, an
 * observation that is not exact or qualified, a stale stage whose digests have
 * since been corrected, and a repair Enforce is applying all report nothing.
 *
 * `correcting` is deliberately absent: a divergence Enforce is repairing on
 * this pass is work in progress, and reporting it would describe a repair as a
 * settled divergence.
 */
function runtimeDriftClass(target: GitOpsTargetProjection): 'runtime' | 'rollout' | null {
  const { status } = target.runtime;
  if (status !== 'runtime_artifact_drift' && status !== 'rollout_artifact_drift' && status !== 'drifted') {
    return null;
  }
  return target.rolloutGenerationId || target.approvals.rolloutAuthorizationRef
    ? 'rollout'
    : 'runtime';
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
  const policy = blueprintDriftPolicy(app, intent);
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
  // The manifest cache this compares against is written by the Direct
  // promotion, and a Git-managed Blueprint deliberately never promotes through
  // that path: its content authority is the accepted generation and its
  // materialization lives in the hub's generations directory. Comparing the
  // cache here would report the previous generation's commit as drift the
  // moment the new one converges, with no writer that could ever clear it.
  if (app.target_mode === 'blueprint') return [];
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
 * Invocation drift: the compose invocation a node recorded does not match the
 * one the accepted generation was authored with.
 *
 * This is the only class whose two sides come from different places. The
 * expected side is the generation's own `expected_invocation_json`, reduced
 * against the target's own stack directory. The observed side is what Compose
 * recorded on the running project when the apply landed, which is the only
 * evidence in the model that can contradict the authored invocation at all:
 * reading the argv back would only ever confirm what Sencho already believes.
 *
 * Three states produce nothing, and each says so rather than reporting
 * agreement:
 *
 * - No observation. The column is null when no apply has recorded one and when
 *   the node could not be reached at the time, because those are the same fact
 *   to a reader: Sencho has not looked. A caveat is pushed instead, and only
 *   for a settled target, so a deploy in progress does not raise one.
 * - An unreadable observation or an authored record that names no compose
 *   file. Neither side is a value, so neither can be compared.
 * - An authored path that will not resolve inside this target's own stack
 *   directory. That is the shape a Direct target has when its argv was built
 *   against a different node's compose directory, and comparing it would
 *   report a mount path as drift.
 *
 * Direct applications only. A Blueprint target is deployed from a materialized
 * Blueprint under its own `deploy_stack_name`, and the argv its generation
 * carries was authored for the source stack, so there is no correct expected
 * side to compare an observation against. Saying nothing is the honest answer;
 * the alternative would be reporting every Blueprint target as drifted.
 *
 * The gates around it mirror the managed-project class: an operation in flight,
 * an interruption or a recovery means the pointers and the observation are
 * describing different moments, and a target that has not applied the accepted
 * generation has nothing to compare against it yet.
 */
function collectInvocationDrift(
  app: GitOpsApplicationRow,
  rawTargets: GitOpsTargetCurrentRow[],
  projections: Map<number, GitOpsTargetProjection>,
  limitations: GitOpsLimitation[],
): GitOpsDriftItem[] {
  if (app.target_mode !== 'direct') return [];
  if (!app.accepted_generation_id) return [];
  if (app.active_operation_stage !== null || app.interruption_stage !== null) return [];
  if (recoveryInProgress(app.recovery_phase)) return [];
  const stackName = app.stack_name;
  if (!stackName) return [];
  const store = GitOpsStore.getInstance();
  const generation = store.getGeneration(app.accepted_generation_id);
  if (!generation || generation.application_id !== app.id) return [];
  const policy = configuredGitSourcePolicy(app);
  const items: GitOpsDriftItem[] = [];

  for (const target of rawTargets) {
    if (target.target_status !== 'active') continue;
    if (target.applied_generation_id !== generation.id) continue;
    if (target.active_operation_stage || target.interruption_stage) continue;
    if (recoveryInProgress(target.recovery_phase)) continue;

    // Three outcomes, and they are three different facts. An unreadable
    // observation has already pushed its own caveat, so it must not also be
    // reported as never observed: "what is stored cannot be read" and "nothing
    // was ever stored" call for different next steps.
    const decoded = decodeObservedInvocationSafe(target.observed_invocation_json, limitations);
    if (decoded.kind === 'invalid') continue;
    if (decoded.kind === 'missing') {
      limitations.push({
        code: 'invocation_observation_missing',
        message: 'no compose invocation has been observed for this target',
        evidence: { nodeId: target.node_id, stackName },
      });
      continue;
    }
    const observed = decoded.observation;

    // The action predicate reads the derived runtime facet, so it needs this
    // target's projection. A target with no projection cannot be judged, and a
    // drift item that cannot name a legal action says none.
    const projection = projections.get(target.node_id);
    const authored = canonicalizeAuthoredInvocation({
      expectedInvocationJson: generation.expected_invocation_json,
      composePathsJson: app.compose_paths_json,
      stackName,
      stackDir: targetStackDirectory(target.node_id, stackName),
    });
    if (authored.kind === 'not_comparable') {
      limitations.push({
        code: 'invocation_expected_invalid',
        message: `the accepted generation's compose invocation cannot be compared (${authored.reason})`,
        evidence: { nodeId: target.node_id, generationId: generation.id, reason: authored.reason },
      });
      continue;
    }

    const comparison = compareInvocations(authored.invocation, observed);
    if (comparison.kind !== 'different') continue;
    items.push({
      class: 'invocation',
      expected: { kind: 'invocation', authored: comparison.expected },
      observed: { kind: 'observed_invocation', observed: comparison.observed, observedAt: observed.observedAt },
      freshnessAt: observed.observedAt,
      owner: 'ComposeService',
      reason: 'the compose invocation on this node is not the one this generation was applied with',
      configuredPolicy: policy,
      affectedTargets: [{ nodeId: target.node_id, stackName }],
      // The fix is a re-apply of the accepted generation, which is the deploy
      // action. It is offered under the same legality predicate the runtime
      // class uses, so a paused or failed target gets no action rather than one
      // that cannot run.
      action: projection && targetDeployLegal(app, projection) ? 'deploy' : 'none',
    });
  }
  return items;
}

/**
 * The stack directory a target's own node keeps this stack in.
 *
 * The node's, not the default node's: the authored argv is reduced against
 * whichever directory this target is actually deployed under, and a target
 * whose argv names a path outside it is reported as not comparable rather than
 * as a difference.
 */
function targetStackDirectory(nodeId: number, stackName: string): string {
  return path.join(NodeRegistry.getInstance().getComposeDir(nodeId), stackName);
}

function decodeObservedInvocationSafe(
  raw: string | null,
  limitations: GitOpsLimitation[],
): { kind: 'missing' } | { kind: 'invalid' } | { kind: 'ok'; observation: ObservedInvocationIdentity } {
  if (raw === null) return { kind: 'missing' };
  try {
    const observation = decodeObservedInvocation(raw);
    return observation ? { kind: 'ok', observation } : { kind: 'missing' };
  } catch (err) {
    // An unusable observation must not read as "nothing observed yet", which
    // would quietly downgrade a real invocation difference to silence.
    limitations.push({
      code: 'invocation_observed_invalid',
      message: err instanceof Error ? err.message : String(err),
      evidence: raw,
    });
    return { kind: 'invalid' };
  }
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
 * does not host has no run row here, so the class stays silent for those rather
 * than claiming a verdict nobody wrote. Each target is queried under the stack
 * name its own intent deployed, so a renamed stack reads its real runs.
 *
 * A Git-managed Blueprint deployment does open a generation-bound stack gate,
 * through the health-gated rollout policy: the run is reserved before the apply
 * so the verdict survives a lost response. Blueprint targets attribute on their
 * applied generation, which is the pointer their mode can prove.
 */

/**
 * The health policy frozen for the rollout a target is running under.
 *
 * Null when the target belongs to no authorized rollout, or when the generation
 * is unreadable. A drift item naming a policy nobody can verify would be worse
 * than one that says the policy is unknown.
 */
function frozenPolicyForTarget(
  store: GitOpsStore,
  app: GitOpsApplicationRow,
  target: GitOpsTargetCurrentRow,
): ConfiguredPolicy | null {
  if (!target.rollout_generation_id) return null;
  const generation = store.getRolloutGeneration(target.rollout_generation_id);
  if (!generation || generation.application_id !== app.id) return null;
  try {
    const { healthPolicy } = decodeFrozenRolloutStrategy(generation.rollout_strategy_json);
    return { kind: 'health_rollout', healthPolicy };
  } catch {
    return null;
  }
}
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
    // The generation the target is running, per target mode. A Blueprint
    // target's deployed pointer is null because nothing writes it, so reading
    // health drift off that pointer alone would skip every Blueprint target,
    // which is exactly the population this class is meant to cover.
    const runningGenerationId = runningGenerationForTarget(app, target);
    if (!runningGenerationId) continue;
    if (target.active_operation_stage || target.interruption_stage) continue;
    if (recoveryInProgress(target.recovery_phase)) continue;
    const stackName = targetStackName(app, intent, target);
    if (!stackName) continue;
    const run = store.getLatestStackHealthRun(target.node_id, stackName);
    if (!run || run.status !== 'failed' || run.deployed_generation_id !== runningGenerationId) continue;
    items.push({
      class: 'health',
      expected: { kind: 'generation', id: runningGenerationId },
      observed: { kind: 'health_run', runId: run.id, deployedGenerationId: run.deployed_generation_id ?? null },
      freshnessAt: run.ended_at ?? run.started_at,
      owner: 'HealthGateService',
      reason: 'the stack-scoped health run for the running generation failed',
      // The policy that decided what to do about it, read from the rollout
      // generation that was authorized. A drift item that says what was found
      // but not which policy was in force leaves an operator unable to tell a
      // deliberate observation from a policy that failed to act.
      configuredPolicy: frozenPolicyForTarget(store, app, target),
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

/**
 * The drift mode the Blueprint is configured with right now.
 *
 * The live Blueprint wins over the intent's snapshot, because the drift mode is
 * a policy the operator sets on the Blueprint and a mode-only edit deliberately
 * mints no new intent. Reading the snapshot alone left the reported mode stale
 * after every mode change until the next edit that did mint one, and an
 * explanation of "what Sencho will do here" that names the wrong mode is worse
 * than no explanation.
 */
function blueprintDriftPolicy(app: GitOpsApplicationRow, intent: GitOpsIntentRevisionRow): ConfiguredPolicy {
  const live = app.blueprint_id === null
    ? null
    : DatabaseService.getInstance().getBlueprint(app.blueprint_id)?.drift_mode;
  const mode = live ?? intent.runtime_drift_policy;
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
  // Read before `toExpected` because the expected set's limitation is decided by
  // the latest evidence, and this is the only place that has both.
  const latestRow = latestId ? store.getArtifactSet(latestId) : undefined;
  const expected = expectedId
    ? toExpected(store, expectedId, latestRow?.qualification ?? null, limitations)
    : null;
  if (!latestId) {
    return {
      status: 'artifact_unresolved',
      generationId,
      expected,
      latestEvidence: null,
      limitation: 'artifact_pointer_missing',
    };
  }
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

/**
 * The artifact set a target or application expects, with its qualification.
 *
 * `latestQualification` is the qualification of the row recorded last, and it is
 * what decides the limitation below. Deliberate: the facet status one call away
 * is derived from the same value, so the caveat and the status cannot disagree
 * about the same target, and neither outlives the condition it describes.
 */
function toExpected(
  store: GitOpsStore,
  id: string,
  latestQualification: ArtifactQualification | null,
  limitations: GitOpsLimitation[],
): ArtifactExpectedIdentity | null {
  const row = store.getArtifactSet(id);
  if (!row) {
    limitations.push({ code: 'artifact_pointer_missing', message: 'expected artifact row is missing', evidence: id });
    return null;
  }
  // Fires when the *expectation* is not comparable, because that is the claim the
  // copy makes: drift between what is running and what was intended is not being
  // checked.
  //
  // The latest evidence is consulted for one thing only: a stack that builds on
  // the node keeps an `unresolved` expected row for the generation's whole life,
  // while every recorded row says `local_build_unverified`. That is a permanent
  // property of the stack rather than an unresolved state a resolve can clear, so
  // a caveat there would be true forever and would duplicate a facet status that
  // already explains it more precisely.
  //
  // It is deliberately *not* the sole condition. Reading only the latest row fired
  // this caveat whenever newer evidence disagreed with an expectation that was
  // itself comparable, which claims drift is unchecked at a moment it is being
  // checked. The expectation decides whether the claim is true; the latest row
  // only decides whether it is worth repeating.
  //
  // A `stale` expectation is not specially excluded, and does not need to be:
  // `allowedExpectedAdvance` refuses stale the same way it refuses everything but
  // exact/qualified, so the expected pointer never holds a stale row. Staleness
  // is recorded on the latest row, which is why it reaches the operator through
  // the facet status rather than through this caveat.
  //
  // Deliberately not scoped to the target mode, and the copy therefore does not
  // promise a retry. The drift check re-resolves an expectation only for an
  // Inline Blueprint (`retryInlineArtifactFreeze`); a Git-managed one recovers
  // through its own preflight and authorization path, and a Direct one through
  // the next apply. What the caveat reports, that what is running is not being
  // compared against what was intended, is true of all of them.
  const expectationIsComparable = row.qualification === 'exact' || row.qualification === 'qualified';
  const isPermanentLocalBuild = latestQualification === 'local_build_unverified';
  if (!expectationIsComparable && !isPermanentLocalBuild) {
    limitations.push({
      code: 'artifact_expectation_unresolved',
      message: 'the expected artifact set has no provable executable identity',
      evidence: row.id,
    });
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
  } catch (error) {
    console.warn(
      '[GitOpsProjection] Invalid artifact evidence for set %s: %s',
      id,
      error instanceof Error ? error.message : String(error),
    );
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
  targets: GitOpsTargetProjection[],
): PlacementFacet {
  const authority = derivePlacementAuthority(app, futureEvidence);
  // A node holding stateful changes for review blocks this placement, and the
  // hold is per-target, so the application-level facet is the only place an
  // operator sees that one node is waiting on them. The runtime facet reports
  // the same fact per target, and the two agree by construction: the read is
  // the derived status, not a second decode of the observation column.
  //
  // It replaces the settled answer only. Every earlier authority state outranks
  // it, because ranking a hold above an outstanding approval or authorization
  // hid the affordance that clears it: the authority actions are offered on
  // those statuses, so an operator whose rollout was unauthorized and who also
  // had one node held was shown a confirmation to perform and no way to
  // authorize it, and neither clears the other. Authority first, then the hold,
  // which is the order an operator works through anyway. A drift observation is
  // deliberately not a hold: it is a fact about a node's runtime, which the
  // runtime facet owns, and reporting it here would name one divergence at two
  // altitudes.
  if (authority.status === 'blueprint_bound'
    && targets.some((target) => target.runtime.status === 'pending_state_review')) {
    return { status: 'stateful_confirmation_required' };
  }
  return authority;
}

/**
 * The authority chain for a placement, with no target evidence consulted.
 *
 * Split from `derivePlacement` so the stateful hold has exactly one place to
 * apply. Inlined into the chain it would have had to be repeated at each of the
 * three `blueprint_bound` returns, and a fourth copy is the kind of duplication
 * that silently rots.
 */
function derivePlacementAuthority(
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
  const currentTargets = targets.filter((target) => !target.tombstoned);
  const failed = currentTargets.find((target) => target.runtime.status === 'recovery_failed');
  if (failed && failed.runtime.status === 'recovery_failed') {
    return {
      status: 'rollback_partial_failed',
      recoveryRef: failed.runtime.recoveryRef ?? app.recovery_ref ?? '',
      recoveryGenerationId: failed.runtime.recoveryGenerationId,
      failureClass: failed.runtime.failureClass,
      failureAt: failed.runtime.failureAt,
    };
  }
  if (currentTargets.some((target) => target.connectivity === 'unreachable')) return { status: 'target_unreachable' };
  if (currentTargets.some((target) => target.connectivity === 'stale')) return { status: 'target_stale' };
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

/**
 * Whether the node holding this target could actually be asked, projected from
 * the observation that answering left behind.
 *
 * The stored `connectivity` column could not answer this. It is seeded to null
 * and no producer ever wrote it, so every target read it back as `unknown` and
 * no application could ever settle. The observation is the evidence that does
 * exist, because recording one requires the node to have been reached and to
 * have looked at its own runtime.
 *
 * A recording is read as a statement about reachability rather than a
 * timestamp to age out. Nothing re-observes a Direct target on a timer, so a
 * wall-clock freshness window would quietly turn a healthy, untouched Direct
 * application unknown again once the window passed. No connectivity value is
 * derived from elapsed time at all.
 *
 * Nothing in production writes a negative connectivity value today, so the
 * negative branch below honors one verbatim in case a producer is added, and
 * fails closed when there is nothing to honor. A node that answered but
 * reported it could not observe its own workload (`unavailable`) is unknown
 * evidence, which is a different claim from a node that never answered.
 */
function connectivityFromObservation(
  target: GitOpsTargetCurrentRow,
  observed: ReturnType<typeof decodeObservedSafe>,
  limitations: GitOpsLimitation[],
): GitOpsTargetProjection['connectivity'] {
  if (target.connectivity && !['unknown', 'reachable', 'unreachable', 'stale'].includes(target.connectivity)) {
    limitations.push({ code: 'connectivity_invalid', message: 'stored connectivity is illegal', evidence: target.connectivity });
  }
  if (target.target_status === 'tombstoned') return 'unknown';
  // A recorded negative claim is honored as written. It can only withhold
  // convergence, which is the safe direction. The positive claim is the one
  // that must be earned, because trusting it is what made this unreadable in
  // the first place.
  if (target.connectivity === 'unreachable' || target.connectivity === 'stale') {
    return target.connectivity;
  }
  switch (observed.kind) {
    // The node was reached and reported what it saw, which is all this claims.
    // `stale` and `local_build_unverified` are arms no current observation
    // producer emits, and they are handled here so that adding one cannot
    // silently change what connectivity means: either way the node answered,
    // and the artifact and runtime facets decide what that evidence settles.
    case 'exact':
    case 'qualified':
    case 'stale':
    case 'local_build_unverified':
      return 'reachable';
    // No observation, or a node reporting it could not look at its own
    // workload. Nothing here claims the node was unreachable, so the honest
    // answer is that we do not know.
    case 'unknown':
    case 'missing':
    case 'unavailable':
      return 'unknown';
    default: {
      const exhaustive: never = observed;
      return exhaustive;
    }
  }
}

function deriveTarget(
  app: GitOpsApplicationRow,
  acceptedIntent: GitOpsIntentRevisionRow | undefined,
  target: GitOpsTargetCurrentRow,
  healthDisabled: boolean,
  limitations: GitOpsLimitation[],
  confirmationExpected: boolean,
): GitOpsTargetProjection {
  mergePersistedLimitations(target.evidence_limitations_json, limitations);
  const observed = decodeObservedSafe(target.observed_artifact_identity_json, limitations);
  const connectivity = connectivityFromObservation(target, observed, limitations);
  const artifact = deriveArtifact(app, target.desired_generation_id, target.expected_artifact_set_id, target.latest_artifact_set_id, limitations);
  const runtime = deriveRuntime(target, artifact, observed, healthDisabled, app, confirmationExpected);
  // A withdrawal hides a failed recovery rather than resolving it. The tombstone
  // answers before the runtime facet reads a recovery field, and the retirement
  // cleared the failure columns without clearing the recovery ones, so the row
  // still holds the failed recovery and nothing else reports it. The condition
  // is the one `deriveRuntime` reads, so the caveat and the status cannot
  // disagree about the same row.
  //
  // Only a retirement that carried one. After any withdrawal Sencho cannot
  // prove the compose project came down, because the teardown is best effort
  // and swallows its own error, but a caveat on every retirement would qualify
  // the ordinary case and train a reader to skip the block. The rest of that is
  // recorded in the internal architecture docs rather than asserted per target.
  if (
    target.target_status === 'tombstoned'
    && (target.recovery_phase === 'failed' || target.failure_stage === 'recovery')
  ) {
    limitations.push({
      code: 'withdrawal_residue',
      message: 'target withdrawn while a recovery on it had failed',
      // The node, because the operator copy names one and `limitationCaveats`
      // deduplicates by sentence: without it, two withdrawn nodes collapse into
      // one caveat that says "this node" without saying which.
      evidence: { nodeId: target.node_id, recoveryRef: target.recovery_ref },
    });
  }
  // The generation the target is running, in the sense each target mode can
  // prove. Health reads it from here rather than from deployed_generation_id,
  // which a Blueprint target never has a writer for.
  const runningGenerationId = runningGenerationForTarget(app, target);
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
    health: deriveHealth(target, healthDisabled, runningGenerationId),
    healthFailureSuperseded: healthFailureSuperseded(app, acceptedIntent, target),
    // What the health-gated rollout has decided for this target, and whether a
    // rollback has anything to restore from. Surfaced here rather than as a
    // separate surface so the rollout controls read the same evidence the
    // decision was made from.
    healthGate: deriveHealthGate(app, target),
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
type ObservationRuntimeStatus =
  | 'pending_state_review'
  | 'evict_blocked'
  | 'drifted'
  | 'correcting'
  | 'repair_held'
  | 'fully_deployed_health_pending';

const BLUEPRINT_OBSERVATION_STATUS: Record<string, ObservationRuntimeStatus | undefined> = {
  blueprint_state_review: 'pending_state_review',
  blueprint_evict_blocked: 'evict_blocked',
  blueprint_drifted: 'drifted',
  blueprint_correcting: 'correcting',
  blueprint_repair_held: 'repair_held',
  // A check that matched. It has to project to something, and the only honest
  // option already in the vocabulary is "deployed, no health verdict claimed":
  // a matched drift check is not a health verdict, so it must not read as one.
  // The alternative, leaving the stage on the hold, reports drift that is gone.
  blueprint_drift_cleared: 'fully_deployed_health_pending',
} satisfies Record<BlueprintObservationStage, ObservationRuntimeStatus>;

/**
 * The runtime status a live target operation projects as.
 *
 * `active_operation_stage` and `interruption_stage` are two vocabularies over the
 * same physical operations, and they are written by the same transitions: a
 * Direct deploy and a Blueprint deploy are both "put this generation on that
 * node". Reading the live column against only the Direct value is what left a
 * Blueprint deploy or withdrawal reading as a pointer state, because the fall
 * through past this table landed on the applied and deployed comparisons.
 *
 * Keyed on an open string for the same reason as the observation table above:
 * the column is null when nothing is in flight, and a miss must fall through to
 * the states below rather than claim one.
 */
const LIVE_OPERATION_STATUS: Record<string, 'deploying' | 'withdrawing' | undefined> = {
  deploy_started: 'deploying',
  blueprint_deploy_started: 'deploying',
  blueprint_withdraw_started: 'withdrawing',
} satisfies Partial<Record<
  NonNullable<GitOpsTargetCurrentRow['active_operation_stage']>,
  'deploying' | 'withdrawing'
>>;

/**
 * Whether work already under way is producing the verdict that will replace a
 * recorded health failure.
 *
 * A recorded failure is reported until a newer verdict lands, which is right. But
 * once something is under way that is going to produce that verdict, the failure
 * is the thing being worked on rather than something an operator has to act on,
 * and the fleet should read it as work in progress. `collectHealthDrift` already
 * withholds the drift item for the same window and for the same reason.
 *
 * Two moments count, because they are the two halves of one redeploy, and they
 * are not reachable by the same targets:
 *
 * - **The deploy step: Direct only.** A live operation whose recorded generation
 *   is the one the failure was recorded against. Gated on
 *   `LIVE_OPERATION_STATUS` and on a non-null `active_generation_id`, which is
 *   what only a Direct `deployStarted` writes. A Blueprint deploy and withdrawal
 *   record their intent and candidate instead and leave that column alone, so
 *   there is no generation on either side of this comparison to make and the
 *   arm stays false for them.
 * - **The observation step: every mode.** A stack-scope health run for the same
 *   generation that is still `observing`. Without it the application drops back
 *   to `failed` for the whole observation window and the reading flip-flops:
 *   failed, in progress, failed, then the new verdict. This arm is what covers a
 *   Blueprint target, and what covers the automatic retry the health rollout
 *   policy performs, since a rollout reserves its run *before* the apply and so
 *   has an observation to be seen by for the whole deploy. It reads a run that
 *   already exists and changes no gate behavior, window, or decision.
 *
 * The generation match is the whole rule, and it is the failure's own identity
 * rather than the running pointer, because `deriveHealth` judges a verdict
 * against the desired generation when there is one, so the two can differ while
 * a newer generation waits to be deployed. It is the failure's own record that
 * the work has to be about in order to supersede it. A consumer cannot make this
 * comparison from the projection, because the runtime facet collapses an
 * operation into a status and drops which generation it is for.
 *
 * **A Direct redeploy has a short gap between the two moments.** A Direct deploy
 * binds the generation and then does its baseline, drift and exposure
 * bookkeeping before the route opens the observation, and in that window neither
 * arm has anything to read, so the recorded failure shows again. It is the
 * handover between the deploy and the gate, not a missing state: Blueprint
 * rollouts reserve the run first and have no such gap. Closing it would mean
 * opening the observation before the bind, which reorders the deploy path, so
 * the gap is stated and pinned rather than closed.
 *
 * What ends the suppression: arm one ends at any terminal for the operation
 * (`deployBound`, `deployUnbound`, `deployFailed`); arm two ends at a terminal
 * verdict for the run, or the startup sweep that finalizes an observation a
 * previous process left open. An observation a newer stack operation supersedes
 * is finalized by that operation rather than left reading as open.
 */
function healthFailureSuperseded(
  app: GitOpsApplicationRow,
  acceptedIntent: GitOpsIntentRevisionRow | undefined,
  target: GitOpsTargetCurrentRow,
): boolean {
  // A tombstoned target has no failure left to supersede, and a recovery
  // restores a generation rather than redeploying what runs, so its own run is
  // not the successor of this failure either. Both are answered from the row
  // before any lookup, which is also what keeps a healthy target off the store:
  // a target whose own last verdict passed has nothing standing to supersede.
  if (target.target_status !== 'active') return false;
  if (target.last_health_status !== 'failed') return false;
  if (recoveryInProgress(target.recovery_phase)) return false;
  const failedGenerationId = target.last_health_generation_id;
  if (failedGenerationId === null) return false;
  if (LIVE_OPERATION_STATUS[target.active_operation_stage ?? '']
    && target.active_generation_id !== null
    && target.active_generation_id === failedGenerationId) {
    return true;
  }
  const stackName = targetStackName(app, acceptedIntent, target);
  if (!stackName) return false;
  const run = GitOpsStore.getInstance().getLatestStackHealthRun(target.node_id, stackName);
  return run !== undefined
    && run.status === 'observing'
    && run.deployed_generation_id === failedGenerationId;
}

/**
 * The failure stages that record a mutation attempt against a target's workload,
 * as opposed to the recovery failures the recovery branches above already read.
 *
 * A Blueprint deploy and a Blueprint withdrawal both land here, because both are
 * attempts to change what the node runs, and the recorded class is what
 * separates the one that never got that far from the one that did.
 */
const MUTATION_FAILURE_STAGE: ReadonlySet<GitOpsTargetCurrentRow['failure_stage']> = new Set([
  'deploy',
  'blueprint_deploy',
  'blueprint_withdraw',
]);

/**
 * The failure classes that mean the mutation reached the node.
 *
 * An open `TEXT` column, so the read is a set lookup rather than a comparison
 * against a closed union: a class a future producer invents is read as
 * non-mutating, which withholds a claim rather than making one.
 */
const APPLIED_MUTATION_CLASS: ReadonlySet<string> = new Set(['post_mutation', 'deploy_failed']);

/**
 * What a Blueprint target's acknowledgement means, or null when the question
 * does not apply.
 *
 * A Blueprint target has no deploy-bound writer: nothing resolves a Direct
 * application for a Blueprint-managed stack, so the ack's `applied_generation_id`
 * is the only pointer that names what the node acknowledged running
 * (`runningGenerationForTarget` reads the applied pointer for exactly this
 * reason). Its `deployed_generation_id` is therefore structurally null, and
 * every acked Blueprint target fell through to the `!deployed` check and
 * reported `applied_not_deployed`. That says "applied, awaiting deploy" for a
 * deploy that does not exist, and `targetDeployLegal` correctly refuses to
 * recommend one for a Blueprint target, so the status described a wait that no
 * action could ever resolve. Two statuses replace it, split by what is actually
 * known.
 *
 * `stale_acknowledgement` is the identity test: the target acknowledged an
 * intent or candidate the application has since left. `blueprintAckRecorded`
 * makes the same comparison when the ack lands and deliberately declines to
 * move the convergence pointers on a superseded request, so the divergence
 * outlives the ack that recorded it. The candidate is part of the test because a
 * new candidate under the same intent is the same fact.
 *
 * `acknowledged_completion_unknown` is the evidence test, and deliberately
 * narrow. The ack proves the apply was handed to the node; it claims nothing
 * about what is running since. So this is reported only while nothing has
 * confirmed the outcome, which is what keeps it from being a second name for
 * "has not been drift-checked recently": a target the reconciler actually
 * looked at has its answer, however old that observation is, and a target with a
 * health verdict has been judged. A target nobody has checked is genuinely
 * unconfirmed, which is what this status is for, and it is deliberately a
 * failure-toned attention reason because an unconfirmed acknowledgement is an
 * unknown outcome rather than progress.
 *
 * Direct targets are excluded: they have a real deploy pointer, so the ordinary
 * `applied_not_deployed` reading is true and actionable for them, and the
 * identity test would misreport every Direct target mid-rollout as stale.
 */
function blueprintAckStatus(
  app: GitOpsApplicationRow,
  target: GitOpsTargetCurrentRow,
  observed: ReturnType<typeof decodeObservedSafe>,
  healthDisabled: boolean,
  confirmationExpected: boolean,
): 'stale_acknowledgement' | 'acknowledged_completion_unknown' | null {
  if (app.target_mode === 'direct') return null;
  if (target.target_status === 'tombstoned') return null;
  if (!target.applied_generation_id) return null;
  // The identity test runs first, and runs on its own. Whether this node was
  // asked to run something the application has since left is a fact about the
  // request, not about what has been observed since, so a health verdict or a
  // later drift check cannot make a superseded acknowledgement current again.
  // Testing it after the evidence gates made a stale target read
  // `synced_and_healthy`, which is the same over-report this change removes.
  //
  // Each leg is only a staleness claim when the application has something to
  // have moved on from. A target that recorded an intent against an application
  // that never established one is running an unplaced generation, not a
  // superseded one, and reads as the unconfirmed acknowledgement it is.
  const identityStale = (app.intent_revision_id !== null
      && target.intent_revision_id !== null
      && target.intent_revision_id !== app.intent_revision_id)
    || (app.rollout_candidate_id !== null
      && target.rollout_candidate_id !== null
      && target.rollout_candidate_id !== app.rollout_candidate_id);
  if (identityStale) return 'stale_acknowledgement';
  // The outcome is only unconfirmed while something is going to confirm it.
  // A Blueprint whose drift policy never observes and whose health contract is
  // off has no confirmation coming, so claiming the outcome is unknown would
  // pin the target, and every application built from it, to a failure-toned
  // status for ever. That is worse than the honest pointer reading: the
  // operator asked Sencho not to check, so the absence of a check says nothing
  // about the workload.
  if (!confirmationExpected) return null;
  if (!healthDisabled) {
    if (target.healthy_generation_id !== null) return null;
    if (target.last_health_status !== null && target.last_health_status !== 'unknown') return null;
  }
  // Same three kinds `connectivityFromObservation` reads as "the node could not
  // tell us": it answered, but not with an identity of its own runtime.
  if (observed.kind !== 'unknown' && observed.kind !== 'missing' && observed.kind !== 'unavailable') {
    return null;
  }
  return 'acknowledged_completion_unknown';
}

/**
 * Whether anything is going to confirm a Blueprint target's outcome.
 *
 * This is the honest question behind the unknown-outcome status, and it has two
 * answers rather than one, because two producers confirm a target and either is
 * enough. The reconciler's drift check records an observation whenever the
 * Blueprint's drift policy observes. A health verdict arrives only for a target
 * the rollout executor reserved a run against, which happens only under a policy
 * that gates advancement: the default `observe` arms no run, and the verdict
 * path resolves a Blueprint target through the run's own application id, since
 * there is no Direct application for a Blueprint-managed stack to fall back to.
 *
 * Getting this wrong in either direction is expensive. Treating every target as
 * confirmed leaves a genuine unknown unmarked; treating every target as
 * confirmable, which is where the first version of this landed, pins a target
 * that nothing will ever check to a failure-toned status for ever, and takes the
 * whole application's posture with it.
 *
 * Resolved once per application rather than per target: everything it reads is
 * application-scoped.
 */
function blueprintConfirmsOutcome(app: GitOpsApplicationRow, healthDisabled: boolean): boolean {
  if (app.blueprint_id !== null && app.intent_revision_id) {
    const intent = GitOpsStore.getInstance().getIntentRevision(app.intent_revision_id);
    if (intent && blueprintDriftPolicy(app, intent) !== null) return true;
  }
  if (healthDisabled) return false;
  // Either policy is enough, and they are read separately on purpose. A run is
  // reserved under the policy frozen into the authorized rollout generation,
  // which is what is actually arming verdicts right now, while the configured
  // policy is what the next authorization would freeze. Reading only the
  // configured one made a policy change flip this answer before any run existed
  // to justify it, in both directions: gating-to-observe hid a real unknown that
  // the still-gating rollout was about to confirm, and observe-to-gating
  // reported one that nothing had been armed to answer.
  return gatesAdvancement(configuredPolicyForApp(GitOpsStore.getInstance(), app))
    || rolloutGenerationGatesHealth(GitOpsStore.getInstance(), app);
}

/**
 * Whether the app's active rollout generation froze a health policy that gates.
 *
 * Unreadable or missing reads as not gating, which withholds the unknown-outcome
 * status rather than asserting a confirmation that may never arrive. The other
 * direction would put a failure-toned status on a target for a run nobody
 * armed.
 */
function rolloutGenerationGatesHealth(store: GitOpsStore, app: GitOpsApplicationRow): boolean {
  if (!app.rollout_generation_id) return false;
  const generation = store.getRolloutGeneration(app.rollout_generation_id);
  if (!generation || generation.application_id !== app.id) return false;
  try {
    return gatesAdvancement(decodeFrozenRolloutStrategy(generation.rollout_strategy_json).healthPolicy);
  } catch {
    return false;
  }
}

function deriveRuntime(
  target: GitOpsTargetCurrentRow,
  artifact: ArtifactFacet,
  observed: ReturnType<typeof decodeObservedSafe>,
  healthDisabled: boolean,
  app: GitOpsApplicationRow,
  confirmationExpected: boolean,
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
  // Ahead of the interruption branch, exactly as the Direct deploy was: a start
  // clears its own interruption, so when both columns are set the live
  // operation is the later fact. A cross-stage interruption survives the clear
  // (it only retires the stage it matches), and it is still the right thing to
  // mask here, because an operation that is running now is what the target is
  // doing, and the unresolved one resurfaces the moment this one settles.
  const liveOperation = LIVE_OPERATION_STATUS[target.active_operation_stage ?? ''];
  if (liveOperation) return { status: liveOperation };
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
  if (MUTATION_FAILURE_STAGE.has(target.failure_stage)) {
    // The class records whether the mutation was handed to the node, and that is
    // what decides which of the two statuses is honest. `post_mutation` is the
    // Direct spelling. `deploy_failed` is what the Blueprint dispatch path
    // records for anything that went wrong once it handed the Compose apply
    // over, and its sibling writer records the same physical event as
    // `post_mutation`. A skip that found the stack already in place is the one
    // pre-mutation case hiding inside it, and it resolves the safe way round:
    // over-claiming a mutation is corrected by looking at the node, while
    // under-claiming is how a half-replaced workload goes on reporting healthy.
    //
    // Every other class, including the ones only the Blueprint path records
    // (`name_conflict`, `target_missing`) and a class a future producer invents,
    // reports the workload as intact. Reading a stage against the Direct
    // vocabulary alone left all of them falling through to the applied and
    // deployed pointers, and a status is what puts a target in the attention
    // queue, so a failed Blueprint deploy reached no queue at all.
    return APPLIED_MUTATION_CLASS.has(target.failure_class ?? '')
      ? { status: 'failed_after_mutation' }
      : { status: 'failed_previous_workload_intact' };
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
  // A health-gated rollout holds this target between its apply and its verdict.
  // Ranked above the pointer checks, which a Blueprint target would otherwise
  // answer `applied_not_deployed` (it has no deploy-bound writer, so its
  // deployed pointer is null). A target mid-rollout is deliberately not judged
  // yet, and reading it off the previous workload's pointers would call the
  // fleet converged while it is still verifying one target.
  if (target.pending_health_run_id) return { status: 'health_checking' };
  if (!target.applied_generation_id) return { status: 'never_applied' };
  // What a Blueprint acknowledgement means, read before the pointer checks.
  // See `blueprintAckStatus` for what each status claims and why.
  const ackStatus = blueprintAckStatus(app, target, observed, healthDisabled, confirmationExpected);
  if (ackStatus) return { status: ackStatus };
  // The generation this target actually runs, which is not the deployed pointer
  // in every mode. Reading `deployed_generation_id` directly is what made every
  // Blueprint target report `applied_not_deployed` for ever: nothing binds a
  // deploy for a Blueprint-managed stack, so the pointer is null by
  // construction rather than because a deploy is outstanding, and
  // `targetDeployLegal` refuses to offer one. `runningGenerationForTarget`
  // already resolves the per-mode answer (the applied pointer for Blueprint),
  // and this is the same fact the health comparison at the end of this function
  // reads, so the two agree on what "running" means for a given target.
  const runningGenerationId = runningGenerationForTarget(app, target);
  if (!runningGenerationId) return { status: 'applied_not_deployed' };
  // The target's contract is its desired generation, so a populated running
  // pointer alone proves nothing: a newer applied generation with the old one
  // still running stays deploy-pending, or a stack awaiting its deploy would
  // read as synced and healthy off the previous workload's pointers. A null
  // desired id is the unknown case (legacy rows, recovered targets), where the
  // running pointer remains the only basis to judge.
  if (
    target.desired_generation_id !== null
    && runningGenerationId !== target.desired_generation_id
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
  if (target.healthy_generation_id === runningGenerationId) {
    return { status: 'synced_and_healthy' };
  }
  return { status: 'fully_deployed_health_pending' };
}

/**
 * What the health-gated rollout is doing with one target.
 *
 * The policy is read from the rollout generation rather than the live intent, so
 * what is shown is the policy this rollout was authorized under rather than the
 * one an operator has since selected.
 */
function deriveHealthGate(
  app: GitOpsApplicationRow,
  target: GitOpsTargetCurrentRow,
): HealthGateFacet {
  const policy = frozenPolicyForTarget(GitOpsStore.getInstance(), app, target);
  const configuredPolicy = configuredPolicyForApp(GitOpsStore.getInstance(), app);
  // Same test the decision uses, so a policy that was told recovery is
  // available never reports as unavailable a moment later and strands the
  // rollout in a state that is neither advancing nor held. The generation is
  // the test because that is what the restore consumes.
  const recoveryAvailable = target.recovery_generation_id !== null;
  if (policy?.kind !== 'health_rollout') {
    return {
      policy: null,
      configuredPolicy,
      awaitingRunId: target.pending_health_run_id,
      attempts: target.health_attempts,
      stopReason: target.health_stop_reason,
      recoveryAvailable,
    };
  }
  return {
    policy: policy.healthPolicy,
    configuredPolicy,
    awaitingRunId: target.pending_health_run_id,
    attempts: target.health_attempts,
    stopReason: target.health_stop_reason,
    recoveryAvailable,
  };
}

/**
 * The health policy the operator has set on the application's current intent,
 * which is what the next rollout will freeze.
 *
 * Reported alongside the frozen policy rather than instead of it. The two answer
 * different questions, and after a change only the configured one moves: the
 * frozen one is still what the running rollout is under until the next
 * authorization. Reporting only the frozen one would make a confirmed change look
 * like it had not been saved.
 */
function configuredPolicyForApp(
  store: GitOpsStore,
  app: GitOpsApplicationRow,
): HealthRolloutPolicy {
  if (!app.intent_revision_id) return DEFAULT_HEALTH_ROLLOUT_POLICY;
  const intent = store.getIntentRevision(app.intent_revision_id);
  if (!intent) return DEFAULT_HEALTH_ROLLOUT_POLICY;
  // Guarded, as the frozen policy beside it is: one corrupt row would otherwise
  // take down the projection for the whole application, and this is a display
  // field rather than an authority decision.
  try {
    return decodeIntentHealthPolicy(intent.health_failure_rollback_policy_json);
  } catch {
    return DEFAULT_HEALTH_ROLLOUT_POLICY;
  }
}

function deriveHealth(
  target: GitOpsTargetCurrentRow,
  healthDisabled: boolean,
  runningGenerationId: string | null,
): HealthFacet {
  if (healthDisabled) return { status: 'not_applicable' };
  if (!runningGenerationId) return { status: 'unbound' };
  // A passing run answers for the generation the target was asked to run, so
  // it is judged against the desired id and only falls back to the deployed
  // pointer when no desired id is recorded. Judging against whatever is
  // deployed would let the previous workload's green run vouch for a newer
  // generation nobody has watched.
  const expectedGeneration = target.desired_generation_id ?? runningGenerationId;
  if (target.healthy_generation_id === expectedGeneration) {
    return { status: 'passed', runId: '', deployedGenerationId: runningGenerationId };
  }
  // A recorded failure about the generation this target is running outranks the
  // fallback to `pending`. Without it, withdrawing a failed check's promotion
  // would make a known-bad workload indistinguishable from one that has never
  // been checked, and the portfolio would show it as work in progress for ever.
  if (
    target.last_health_status === 'failed'
    && target.last_health_generation_id === expectedGeneration
  ) {
    return {
      status: 'failed',
      runId: target.last_health_run_id ?? '',
      deployedGenerationId: target.deployed_generation_id,
    };
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
    // A fault carries no application either, so it has no policy to report, and
    // it is deliberately not the shared sentinel's identity.
    authorityPolicies: [],
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
