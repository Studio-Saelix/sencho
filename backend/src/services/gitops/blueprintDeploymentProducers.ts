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
import { GitOpsTransitions } from './transitions';
import { envelopeFor } from './blueprintProducers';

/** Why a deployment row moved. */
export type BlueprintDeploymentCause =
  | 'deploy_start'
  | 'deploy_ack'
  | 'deploy_fail'
  | 'name_conflict'
  | 'withdraw_start'
  | 'withdraw_success'
  | 'withdraw_fail'
  | 'await_state_review'
  | 'await_evict_confirm'
  | 'drift_observed'
  | 'drift_enforce_start';

/** Causes that only observe, and must never acknowledge or mint anything. */
const OBSERVATION_STAGE = {
  await_state_review: 'blueprint_state_review',
  await_evict_confirm: 'blueprint_evict_blocked',
  drift_observed: 'blueprint_drifted',
  drift_enforce_start: 'blueprint_correcting',
} as const;

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
      console.error(
        '[GitOps] Could not record blueprint %s for blueprint %d on node %d:',
        cause, blueprintId, nodeId,
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
  if (!app || app.lifecycle_status !== 'active') return;
  if (!statusMoved) return;

  const envelope = envelopeFor(actor, `blueprint_${cause}`);

  if (cause in OBSERVATION_STAGE) {
    if (!store.getTarget(app.id, nodeId)) return;
    tx.blueprintObservation({
      applicationId: app.id,
      nodeId,
      stage: OBSERVATION_STAGE[cause as keyof typeof OBSERVATION_STAGE],
      envelope,
    });
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
      tx.blueprintWithdrawFailed({ applicationId: app.id, nodeId, failureClass: 'post_mutation', envelope });
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
