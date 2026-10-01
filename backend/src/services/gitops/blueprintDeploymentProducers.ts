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
import { parse as parseYaml } from 'yaml';
import { DatabaseService, type BlueprintDeployment } from '../DatabaseService';
import type { EffectiveServiceSpec } from '../effectiveServiceModel';
import { GitOpsStore, emptyTargetRow } from './store';
import { GitOpsTransitions, GitOpsTransitionError } from './transitions';
import { envelopeFor, recordableApplication, sha256 } from './blueprintProducers';
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
 * Re-resolve an already-frozen Inline Blueprint generation against a node.
 *
 * One implementation, three callers: the deploy-time freeze, its same-revision
 * re-tick, and the drift check's recovery. Keeping them together is what stops
 * the deploy-time path (which may read the compose directory it just wrote) from
 * drifting into the recovery path's (which must not), and vice versa.
 *
 * `approvedServices` is what separates them. The freeze omits it, reading the
 * node's rendered model, because it runs immediately after writing that
 * directory and the two are the same bytes by construction; reading the render
 * is also what gives it Compose's own interpolation and `extends` resolution.
 * The retry supplies it, because a reconcile tick can run long after the deploy
 * and the directory is no longer evidence of what was approved.
 *
 * Returns whether the target's expectation actually moved, so the caller can
 * tell "resolved" from "tried, and there was nothing to resolve".
 */
async function resolveInlineArtifactSet(args: {
  stackName: string;
  nodeId: number;
  applicationId: string;
  generationId: string;
  blueprintId: number;
  actor: string | null;
  /**
   * History trigger for the evidence this writes. The caller supplies it rather
   * than this defaulting to the freeze's, because the two are different events:
   * one pins identity at deploy time, the other recovers it from a later tick,
   * and an audit trail that cannot tell them apart is not an audit trail.
   */
  trigger: string;
  approvedServices?: readonly EffectiveServiceSpec[];
}): Promise<boolean> {
  const store = GitOpsStore.getInstance();
  const before = store.getTarget(args.applicationId, args.nodeId)?.expected_artifact_set_id ?? null;
  await resolveAndRecordArtifactSet({
    stackName: args.stackName,
    nodeId: args.nodeId,
    applicationId: args.applicationId,
    generationId: args.generationId,
    buildContexts: [],
    envelope: envelopeFor(args.actor, args.trigger),
    ...(args.approvedServices ? { approvedServices: args.approvedServices } : {}),
  });
  const after = store.getTarget(args.applicationId, args.nodeId)?.expected_artifact_set_id ?? null;
  return after !== null && after !== before;
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
 * The recovery half of `freezeInlineRevisionAfterDeploy`, which mints a
 * generation and is a replayed no-op once one exists. A transient registry
 * failure at freeze time otherwise parks the target's approved identity at
 * `unresolved` until an unrelated redeploy of the same revision re-runs the
 * resolve, which makes an operator action the price of proving what a node is
 * running.
 *
 * **It resolves approved intent, not the node's directory.** The specs come
 * from the compose text the intent hashed, and the only thing read from the
 * node is its Docker platform, because which manifest child is correct is a
 * property of the machine. The deploy-time freeze reads the directory
 * legitimately because it runs immediately after writing it; a later tick
 * cannot make that assumption, and reading the directory here would let a hand
 * edit or a restored backup become the approved identity.
 *
 * **What it does not do.** It does not compare the result against a prior
 * approval, because the freeze that failed recorded no digests to compare
 * against. So a tag that moved between the failed freeze and this retry
 * resolves to its new digest, exactly as the freeze would have had it resolve
 * if the registry had answered. The transition bounds something narrower:
 * recording a fresh `exact`/`qualified` set moves an expectation that is not
 * already resolved and leaves a resolved one alone, so a retry cannot redefine
 * an identity that was ever approved and cannot move an already-stale set.
 *
 * No-op unless the application is a live Inline Blueprint on the generation
 * the caller named. A Git-managed one resolves from the repository rather than
 * from a node, so its recovery runs through preflight and authorization.
 */
export async function retryInlineArtifactFreeze(args: {
  blueprintId: number;
  nodeId: number;
  generationId: string;
}): Promise<boolean> {
  const store = GitOpsStore.getInstance();
  const app = store.getLiveBlueprintApplication(args.blueprintId);
  if (!recordableApplication(app) || app.target_mode !== 'inline_blueprint') return false;
  // The generation is the one the caller compared the observation against. A
  // newer accepted generation makes that comparison stale, and the newer one
  // owns its own resolve.
  if (app.accepted_generation_id !== args.generationId) return false;

  const intent = app.intent_revision_id
    ? store.getIntentRevision(app.intent_revision_id)
    : undefined;
  const blueprint = DatabaseService.getInstance().getBlueprint(args.blueprintId);
  const stackName = inlineFreezeStackName(intent, blueprint);
  if (!stackName) {
    console.error(
      '[GitOps] Inline artifact retry skipped for blueprint %s: no stack name on intent or blueprint',
      sanitizeForLog(String(args.blueprintId)),
    );
    return false;
  }
  const approved = approvedInlineServiceSpecs(intent, blueprint);
  if ('refusal' in approved) {
    // Refused rather than resolved without specs: every refusal here is a compose
    // shape whose authored text can disagree with the rendered model, and
    // resolving from it would report a healthy stack as drifted.
    console.error(
      '[GitOps] Inline artifact retry skipped for blueprint %s: %s',
      sanitizeForLog(String(args.blueprintId)),
      sanitizeForLog(approved.refusal),
    );
    return false;
  }

  return resolveInlineArtifactSet({
    stackName,
    nodeId: args.nodeId,
    applicationId: app.id,
    generationId: args.generationId,
    blueprintId: args.blueprintId,
    actor: null,
    // Distinct from the freeze's `inline_revision_frozen`, so the history says
    // this identity was recovered by a later reconcile tick rather than pinned by
    // the deploy that applied the revision.
    trigger: 'inline_artifact_freeze_retried',
    approvedServices: approved.specs,
  });
}

/**
 * The service specs an intent's approved compose content declares, or the reason
 * the authored content cannot stand in for the rendered model.
 *
 * Parsed from the stored content, never from the node's directory. That
 * distinction is the whole point of the retry: a reconcile tick can run days
 * after the deploy, by which time the node's compose may have been hand-edited,
 * restored from a backup, or replaced wholesale. Resolving from the directory
 * would record whatever it now holds as the approved identity, which turns a
 * local change into fleet intent and would let drift read as converged against
 * content nobody approved.
 *
 * **What it refuses, and why refusing is the whole design.** The freeze resolves
 * the *rendered* model, which is what `docker compose config` produced on the
 * node. This parses the authored text. Those agree for a plain stack and diverge
 * for anything Compose expands, and a divergence is not cosmetic: a service the
 * authored text declares but the rendered model excludes ends up in the expected
 * set, is absent from the observation, and `observationMatchesExpected` reads a
 * missing expected service as drift. That is a healthy stack reported as drifted,
 * and under Enforce the repair cannot make it converge, so it would redeploy on
 * every tick.
 *
 * So this returns a refusal instead of a best-effort parse for every construct
 * that can change the rendered service set:
 *
 * - `include`, which merges services from other files the parse never sees.
 * - `profiles`, which the node's `docker compose config` does not activate, so
 *   the rendered model omits those services while a flat parse keeps them.
 * - `extends`, which can import `profiles` (and other fields) onto a service
 *   that shows no trace of them in its own body.
 * - `<<` merge keys, which the YAML parser does not resolve at all: it leaves a
 *   literal `<<` key, so the merged fields are invisible, `image` reads as null,
 *   and the failure is silent rather than loud.
 *
 * Refusing leaves the target `unresolved` and therefore `unverified`, which is
 * the honest state, and the projection already reports that as a limitation. The
 * cost is that a Blueprint using these constructs recovers its expectation only
 * through a redeploy, which is where it stood before this retry existed.
 */
function approvedInlineServiceSpecs(
  intent: GitOpsIntentRevisionRow | undefined,
  blueprint: Blueprint | undefined,
): { specs: EffectiveServiceSpec[] } | { refusal: string } {
  // The intent records the hash of the content that was approved. If the
  // Blueprint has moved on since, the intent's content is the one that was
  // approved and the current Blueprint text is not, so the hash is what
  // decides, not the live row.
  const content = intent && blueprint
    ? composeContentForIntent(intent, blueprint)
    : null;
  if (content === null) {
    return { refusal: 'the approved intent content is unreadable, or the Blueprint has been edited since it was approved' };
  }

  let doc: { services?: unknown; include?: unknown } | null;
  try {
    doc = parseYaml(content) as { services?: unknown; include?: unknown } | null;
  } catch {
    return { refusal: 'the approved intent content does not parse as YAML' };
  }
  if (doc?.include !== undefined && doc.include !== null) {
    return { refusal: 'the approved compose uses include, whose services the flat parse cannot see' };
  }
  const services = doc?.services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    return { refusal: 'the approved intent content declares no services' };
  }

  const specs: EffectiveServiceSpec[] = [];
  for (const [name, raw] of Object.entries(services as Record<string, unknown>)) {
    const hazard = authoredServiceHazard(raw);
    if (hazard) return { refusal: `${hazard} (service ${name})` };
    specs.push(approvedServiceSpec(name, raw));
  }
  return { specs };
}

/**
 * The first construct on this service that makes the authored text an untrustworthy
 * stand-in for the rendered model, or null when the service is safe to use.
 *
 * `profiles` is checked here rather than in the caller so the refusal can name the
 * service, and `<<` is checked by key because the parser hands it back verbatim
 * instead of merging it.
 */
function authoredServiceHazard(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const svc = raw as Record<string, unknown>;
  if ('<<' in svc) {
    return 'the approved compose uses a merge key, which the YAML parse leaves unresolved';
  }
  if (svc.profiles !== undefined && svc.profiles !== null) {
    return 'the approved compose gates a service on profiles, which the node does not activate when it renders';
  }
  if (svc.extends !== undefined && svc.extends !== null) {
    return 'the approved compose uses extends, which can import fields the service body does not show';
  }
  return null;
}

/**
 * The compose text an intent approved.
 *
 * Prefers the live Blueprint row only when it still hashes to what the intent
 * recorded. An Inline intent is minted from the Blueprint's own content, so the
 * two agree until the Blueprint is edited, and after an edit the intent's hash
 * is the authority: the deploy applied the old text.
 */
function composeContentForIntent(intent: GitOpsIntentRevisionRow, blueprint: Blueprint): string | null {
  if (sha256(blueprint.compose_content) !== intent.compose_content_sha256) {
    return null;
  }
  return blueprint.compose_content;
}

/**
 * Spec shape from *authored* YAML rather than from `docker compose config`
 * output, so the three fields this needs (`image`, `build`) are read with the
 * same tolerance the effective-model parser applies. Compose interpolation has
 * already happened by the time the rendered model exists, but authored content
 * is what the intent hashed, so a `${VAR}` image reference resolves to a ref
 * that cannot be classified and stays unresolved rather than being guessed.
 */
function approvedServiceSpec(name: string, raw: unknown): EffectiveServiceSpec {
  const svc = (raw ?? {}) as Record<string, unknown>;
  return {
    name,
    declaredImage: typeof svc.image === 'string' ? svc.image : null,
    hasBuild: svc.build !== undefined && svc.build !== null,
    expectedReplicas: 1,
    dependsOn: [],
    hasHealthcheck: false,
  };
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

  // Same-resolution seam as the retry, minus the approved specs: this path may
  // read the compose directory because it just wrote it.
  const resolveFreezeSet = (generationId: string) => resolveInlineArtifactSet({
    stackName,
    nodeId: args.nodeId,
    applicationId: app.id,
    generationId,
    blueprintId: args.blueprintId,
    actor: args.actor,
    trigger: 'inline_revision_frozen',
  });

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
