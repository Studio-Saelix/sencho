/**
 * Blueprint deployment-state writes, recorded by what caused them.
 *
 * Every production write to a Blueprint deployment row comes through here, so
 * the revision state hears one event per real change rather than one per call.
 * The cause is passed in rather than inferred from the resulting status,
 * because several causes land on the same status: a deploy that failed and a
 * withdraw that failed both read `failed`, and telling them apart afterwards is
 * impossible.
 *
 * Preview cleanup deliberately does not come through here. It reverses a
 * projection nobody deployed, so recording it would report removals that never
 * happened.
 */
import { DatabaseService, type BlueprintDeployment } from '../DatabaseService';
import { GitOpsStore, emptyTargetRow } from './store';
import { GitOpsTransitions, GitOpsTransitionError } from './transitions';
import { envelopeFor, recordableApplication } from './blueprintProducers';
import { resolveAndRecordArtifactSet } from './artifactResolve';
import { newGitOpsId } from './directApplication';
import type { Blueprint } from '../DatabaseService';
import type { GitOpsGenerationRow, GitOpsIntentRevisionRow } from './types';
import { sanitizeForLog } from '../../utils/safeLog';

/** Why a deployment row moved. */
export type BlueprintDeploymentCause =
  | 'deploy_start'
  | 'deploy_ack'
  | 'deploy_fail'
  | 'name_conflict'
  | 'withdraw_start'
  | 'withdraw_success'
  | 'withdraw_fail'
  | 'withdraw_name_conflict'
  | 'await_state_review'
  | 'await_evict_confirm'
  | 'drift_observed'
  | 'drift_enforce_start'
  | 'drift_cleared'
  | 'drift_repair_held';

/**
 * Causes that only observe, and must never acknowledge or mint anything.
 *
 * `drift_cleared` is an observation like the rest, not a silent write: a check
 * found the target already matched, so the row returns to active. It has to
 * advance the observation stage, because the projection reads the latest stage
 * and would otherwise keep reporting the drift or hold that just cleared.
 */
const OBSERVATION_STAGE = {
  await_state_review: 'blueprint_state_review',
  await_evict_confirm: 'blueprint_evict_blocked',
  drift_observed: 'blueprint_drifted',
  drift_enforce_start: 'blueprint_correcting',
  drift_cleared: 'blueprint_drift_cleared',
  drift_repair_held: 'blueprint_repair_held',
} as const;

type ObservationCause = keyof typeof OBSERVATION_STAGE;

/**
 * Narrows to the observation causes, so the stage lookup below reads as a fact
 * the compiler derives rather than one an assertion claims.
 */
function isObservation(cause: BlueprintDeploymentCause): cause is ObservationCause {
  return cause in OBSERVATION_STAGE;
}

type DeploymentFields = Omit<Parameters<DatabaseService['upsertDeployment']>[0], 'blueprint_id' | 'node_id'>;

/**
 * Write a deployment row and record what caused it.
 *
 * The write happens either way. Recording is skipped when the effective status
 * did not move, so a reconciler tick that re-asserts a state it already
 * reported does not append a second event describing the same fact.
 */
export function commitBlueprintDeploymentCause(
  cause: BlueprintDeploymentCause,
  blueprintId: number,
  nodeId: number,
  fields: DeploymentFields,
  actor: string | null,
): BlueprintDeployment {
  const db = DatabaseService.getInstance();

  return db.getDb().transaction(() => {
    const previous = db.getDeployment(blueprintId, nodeId);
    const deployment = db.upsertDeployment({ blueprint_id: blueprintId, node_id: nodeId, ...fields });
    const statusMoved = previous?.status !== deployment.status;

    try {
      record(cause, blueprintId, nodeId, statusMoved, actor);
    } catch (error) {
      // The deployment happened whatever the record says. Failing the write
      // here would turn a bookkeeping problem into a stuck rollout.
      //
      // A rejection is louder than an infrastructure error on purpose: it means
      // the model refused this as invalid, and a target that keeps refusing
      // holds its active slot and stops recording anything further.
      const rejected = error instanceof GitOpsTransitionError;
      console.error(
        '[GitOps] %s recording blueprint %s for blueprint %d on node %d:',
        rejected ? 'Rejected' : 'Could not record', cause, blueprintId, nodeId,
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
    }
    return deployment;
  })();
}

function record(
  cause: BlueprintDeploymentCause,
  blueprintId: number,
  nodeId: number,
  statusMoved: boolean,
  actor: string | null,
): void {
  const store = GitOpsStore.getInstance();
  const tx = GitOpsTransitions.getInstance();
  const app = store.getLiveBlueprintApplication(blueprintId);
  // A Blueprint that predates the model has nothing to record against.
  if (!recordableApplication(app)) return;

  const envelope = envelopeFor(actor, `blueprint_${cause}`);

  if (isObservation(cause)) {
    // Observations are the only causes the status guard applies to. A start
    // writes the identity terminals are matched against, so suppressing one
    // because the row already read `deploying` would let a later
    // acknowledgement answer a request that had been superseded.
    if (!statusMoved) return;
    // A stateful first placement is held for review before anything deploys,
    // so there is no target yet and nothing to observe against. Creating it
    // here is the same first-contact write `deploy_start` does below: the
    // node has been asked to hold this Blueprint, which is exactly what the
    // observation is about. Any other cause arriving without a target is
    // dropped, which is also what happens to a drift or evict report for a
    // Blueprint that migration brought in: migration records the application,
    // its intent and its candidate, but no targets, so a fleet that predates
    // this model reports nothing here until its next deploy creates one.
    const firstPlacement = !store.getTarget(app.id, nodeId);
    if (firstPlacement && cause !== 'await_state_review') return;
    const stage = OBSERVATION_STAGE[cause];
    // Both writes in one transaction so they succeed or fail together. The
    // observation refuses a tombstoned target, and it runs in its own
    // savepoint, so creating the target outside this would leave an active
    // target with no generation, no stage and no history behind a refusal: a
    // placement relationship the model never established, which the delete
    // path would later tombstone as if it were real.
    DatabaseService.getInstance().getDb().transaction(() => {
      if (firstPlacement) store.upsertTarget(emptyTargetRow(app.id, nodeId, envelope.at));
      tx.blueprintObservation({ applicationId: app.id, nodeId, stage, envelope });
    })();
    return;
  }

  if (cause === 'deploy_start') {
    // First deploy to this node: the target is created here, because a
    // Blueprint application has no targets until something is sent somewhere.
    if (!store.getTarget(app.id, nodeId)) {
      store.upsertTarget(emptyTargetRow(app.id, nodeId, envelope.at));
    }
    if (!app.intent_revision_id) return;
    tx.blueprintDeployStarted({
      applicationId: app.id,
      nodeId,
      intentRevisionId: app.intent_revision_id,
      rolloutCandidateId: app.rollout_candidate_id,
      envelope,
    });
    return;
  }

  const target = store.getTarget(app.id, nodeId);
  if (!target) return;

  // Terminals answer the request the target says it was given, not whatever the
  // Blueprint currently wants. An ack matched against the current intent would
  // accept work for a revision this node was never sent.
  const requested = target.active_operation_stage !== null
    ? target.active_intent_revision_id
    : target.interruption_intent_revision_id;

  switch (cause) {
    case 'deploy_ack':
      if (!requested) return;
      tx.blueprintAckRecorded({
        applicationId: app.id,
        nodeId,
        intentRevisionId: requested,
        rolloutCandidateId: target.active_operation_stage !== null
          ? target.active_rollout_candidate_id
          : target.interruption_rollout_candidate_id,
        legacyAppliedRevision: null,
        envelope,
      });
      return;
    case 'deploy_fail':
    case 'name_conflict':
      tx.blueprintDeployFailed({
        applicationId: app.id,
        nodeId,
        failureClass: cause === 'name_conflict' ? 'name_conflict' : 'post_mutation',
        envelope,
      });
      return;
    case 'withdraw_start':
      if (!target.intent_revision_id) return;
      tx.blueprintWithdrawStarted({
        applicationId: app.id,
        nodeId,
        // The intent being removed is the one this node acknowledged, never a
        // later replacement.
        intentRevisionId: target.intent_revision_id,
        envelope,
      });
      return;
    case 'withdraw_success':
      if (!requested) return;
      tx.blueprintWithdrawn({ applicationId: app.id, nodeId, intentRevisionId: requested, envelope });
      return;
    case 'withdraw_fail':
    case 'withdraw_name_conflict':
      tx.blueprintWithdrawFailed({
        applicationId: app.id,
        nodeId,
        failureClass: cause === 'withdraw_name_conflict' ? 'name_conflict' : 'post_mutation',
        envelope,
      });
      return;
  }
}

/**
 * Record a withdraw that removed the deployment row entirely.
 *
 * Split from the cause above because the row is deleted rather than updated, so
 * there is no status to compare.
 */
export function commitBlueprintDeploymentRemoved(
  blueprintId: number,
  nodeId: number,
  actor: string | null,
): void {
  const db = DatabaseService.getInstance();
  db.getDb().transaction(() => {
    const existed = db.getDeployment(blueprintId, nodeId) !== undefined;
    db.deleteDeployment(blueprintId, nodeId);
    if (!existed) return;
    try {
      record('withdraw_success', blueprintId, nodeId, true, actor);
    } catch (error) {
      console.error(
        '[GitOps] Could not record blueprint withdrawal for blueprint %d on node %d:',
        blueprintId, nodeId,
        error instanceof Error ? error.stack ?? error.message : String(error),
      );
    }
  })();
}

/**
 * The stack name an Inline Blueprint's artifact is resolved against.
 *
 * Prefers the intent's recorded stack name, because that is what the deploy
 * applied, and falls back to the Blueprint's own name for an application with
 * no intent revision yet. Shared with the freeze so a retry can never resolve
 * against a different stack than the freeze did.
 */
function inlineFreezeStackName(
  intent: GitOpsIntentRevisionRow | undefined,
  blueprint: Blueprint | undefined,
): string | null {
  return intent?.deploy_stack_name ?? blueprint?.name ?? null;
}

/**
 * Re-resolve an already-frozen Inline Blueprint generation, without re-freezing.
 *
 * This is the recovery half of `freezeInlineRevisionAfterDeploy`: the freeze
 * itself mints a generation and is a no-op once one exists, so a transient
 * registry failure at freeze time would otherwise park the target's approved
 * identity at `unresolved` until an unrelated redeploy of the same revision
 * happened to land. Resolving again against the generation that is already
 * frozen is the same operation the freeze performs, minus the mint.
 *
 * This is a deferred freeze, and it trusts exactly what a freeze trusts: the
 * registry, right now. Nothing here compares the result against an approval,
 * because the freeze that failed recorded no digests to compare against. So a
 * tag that moved between the failed freeze and this retry resolves to its new
 * digest, and that becomes the expectation, which is the same trust a redeploy
 * of this revision would extend and the same exposure the pre-existing redeploy
 * recovery already carries. What the transition does bound is narrower and
 * worth stating exactly: recording a fresh `exact`/`qualified` set moves an
 * expectation that is not already resolved and leaves a resolved one alone. So
 * a retry cannot redefine an identity that was ever approved, and it cannot
 * move an already-stale set either. It is not, and does not claim to be, a
 * second line of defence against a moving tag.
 *
 * No-op unless the application is a live Inline Blueprint, since a Git-managed
 * one resolves its artifact from the repository rather than from a node's
 * running compose model.
 */
export async function retryInlineArtifactFreeze(args: {
  blueprintId: number;
  nodeId: number;
  generationId: string;
}): Promise<void> {
  const store = GitOpsStore.getInstance();
  const app = store.getLiveBlueprintApplication(args.blueprintId);
  if (!recordableApplication(app) || app.target_mode !== 'inline_blueprint') return;
  // The generation is the one the caller compared the observation against. A
  // newer accepted generation makes that comparison stale, and the newer one
  // owns its own resolve.
  if (app.accepted_generation_id !== args.generationId) return;

  const intent = app.intent_revision_id
    ? store.getIntentRevision(app.intent_revision_id)
    : undefined;
  const stackName = inlineFreezeStackName(intent, DatabaseService.getInstance().getBlueprint(args.blueprintId));
  if (!stackName) {
    console.error(
      '[GitOps] Inline artifact retry skipped for blueprint %s: no stack name on intent or blueprint',
      sanitizeForLog(String(args.blueprintId)),
    );
    return;
  }

  await resolveAndRecordArtifactSet({
    stackName,
    nodeId: args.nodeId,
    applicationId: app.id,
    generationId: args.generationId,
    buildContexts: [],
    envelope: envelopeFor(null, 'inline_revision_frozen'),
  });
}

/**
 * After the first successful Inline deploy of a revision, freeze executable identity.
 *
 * Mints an inline-owned generation and unresolved expected set, then resolves
 * registry digests against the target node. Git-managed Blueprint applications
 * already freeze at authorization and are skipped. Same-revision re-ticks
 * no-op in this producer when the freeze set is already exact/qualified (and
 * again inside `inlineRevisionFrozen` if called). A frozen but unresolved set
 * still retries registry resolve.
 */
export async function freezeInlineRevisionAfterDeploy(args: {
  blueprintId: number;
  nodeId: number;
  actor: string | null;
}): Promise<void> {
  const store = GitOpsStore.getInstance();
  const app = store.getLiveBlueprintApplication(args.blueprintId);
  if (!recordableApplication(app) || app.target_mode !== 'inline_blueprint') return;

  const intent = app.intent_revision_id
    ? store.getIntentRevision(app.intent_revision_id)
    : undefined;
  const blueprint = DatabaseService.getInstance().getBlueprint(args.blueprintId);
  const stackName = inlineFreezeStackName(intent, blueprint);
  if (!stackName) {
    console.error(
      '[GitOps] Inline freeze skipped for blueprint %s: no stack name on intent or blueprint',
      sanitizeForLog(String(args.blueprintId)),
    );
    return;
  }

  const envelope = envelopeFor(args.actor, 'inline_revision_frozen');

  // A lost write race on the evidence row is not a failed resolve, so
  // `resolveAndRecordArtifactSet` rethrows it rather than recording
  // `unavailable`. A deploy has already applied the workload by this point, so
  // letting that escape would report a successful deploy as failed; the
  // generation is frozen either way and the next resolve picks it up.
  const resolveFreezeSet = async (generationId: string): Promise<void> => {
    try {
      await resolveAndRecordArtifactSet({
        stackName,
        nodeId: args.nodeId,
        applicationId: app.id,
        generationId,
        buildContexts: [],
        envelope,
      });
    } catch (error) {
      if (!(error instanceof GitOpsTransitionError)) throw error;
      console.error(
        '[GitOps] Inline freeze resolve lost a write race for blueprint %s on node %s; the generation stays frozen and unresolved',
        sanitizeForLog(String(args.blueprintId)),
        args.nodeId,
      );
    }
  };

  if (app.accepted_generation_id && app.artifact_set_id) {
    const existing = store.getArtifactSet(app.artifact_set_id);
    if (
      existing
      && (existing.qualification === 'exact' || existing.qualification === 'qualified')
    ) {
      return;
    }
    await resolveFreezeSet(app.accepted_generation_id);
    return;
  }

  const fingerprint = intent?.compose_content_sha256
    ?? `inline-unversioned:${app.id}`;
  const generationId = newGitOpsId();
  const artifactSetId = newGitOpsId();
  const generation: GitOpsGenerationRow = {
    id: generationId,
    application_id: app.id,
    commit_sha: fingerprint.length >= 40 ? fingerprint.slice(0, 40) : fingerprint.padEnd(40, '0'),
    repo_url: `inline://blueprint/${args.blueprintId}`,
    configured_ref: intent ? `intent/${intent.id}` : 'inline',
    resolved_ref_kind: null,
    repo_identity_json: JSON.stringify({
      host: 'inline',
      pathname: `/blueprint/${args.blueprintId}`,
    }),
    manifest_version: 1,
    candidate_dir: `generations/inline-${generationId}`,
    applied_dir: `generations/inline-${generationId}-applied`,
    expected_invocation_json: '{}',
    materialization_fingerprint: fingerprint.length === 64 ? fingerprint : fingerprint.padEnd(64, '0').slice(0, 64),
    validation_ok: 1,
    plan_blocked: 0,
    change_plan_fingerprint: null,
    operation_id: envelope.operationId,
    trigger: envelope.trigger,
    actor: envelope.actor,
    previous_generation_id: null,
    redacted_limitations_json: '[]',
    portable_manifest_json: null,
    compose_inputs_json: null,
    source_policy_evidence_json: null,
    security_policy_evidence_json: null,
    support_requirements_json: null,
    compatibility_requirements_json: null,
    secret_capability_json: null,
    created_at: envelope.at,
  };

  try {
    const result = GitOpsTransitions.getInstance().inlineRevisionFrozen({
      applicationId: app.id,
      generation,
      artifactSetId,
      envelope,
    });
    if (result.replayed) return;
  } catch (error) {
    console.error(
      '[GitOps] Inline freeze failed for blueprint %s on node %d:',
      sanitizeForLog(String(args.blueprintId)),
      args.nodeId,
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return;
  }

  await resolveFreezeSet(generationId);
}
