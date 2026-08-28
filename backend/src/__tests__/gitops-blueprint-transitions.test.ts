/**
 * Blueprint source and deployment transitions.
 *
 * These have no production caller yet; the Blueprint routes and the reconciler
 * are wired to them in the same step. They are tested directly so the shape a
 * caller must satisfy is pinned here rather than inferred from the deriver.
 *
 * The rule they share is that a terminal event has to name the request it is
 * answering. A node that acknowledges a superseded intent has not converged on
 * anything anyone asked for, and recording it as an acknowledgement is how a
 * fleet comes to report agreement it does not have.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { GitOpsStore, emptyTargetRow } from '../services/gitops/store';
import { GitOpsTransitions, type EventEnvelope } from '../services/gitops/transitions';
import { projectApplication } from '../services/gitops/derive';
import type {
  GitOpsApplicationRow,
  GitOpsIntentRevisionRow,
  GitOpsRolloutCandidateRow,
} from '../services/gitops/types';

describe('gitops blueprint transitions', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('mints an intent and opens a candidate against it', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-intent', 101);

    tx.intentRevised({
      applicationId: 'app-intent',
      intent: intent('int-1', 'app-intent', 101),
      envelope: env('op-int-1'),
    });
    expect(store.getApplication('app-intent')?.intent_revision_id).toBe('int-1');

    tx.rolloutCandidateOpened({
      applicationId: 'app-intent',
      candidate: candidate('cand-1', 'app-intent', 'int-1'),
      envelope: env('op-cand-1'),
    });
    const app = store.getApplication('app-intent')!;
    expect(app.rollout_candidate_id).toBe('cand-1');
    // Candidate-time facts only: nothing here claims anything was authorized.
    const row = store.getRolloutCandidate('cand-1')!;
    expect(row.intent_revision_id).toBe('int-1');
    expect(row.accepted_generation_id).toBeNull();
  });

  it('refuses a candidate that does not name the current intent', () => {
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-stale-cand', 102);
    tx.intentRevised({
      applicationId: 'app-stale-cand',
      intent: intent('int-2', 'app-stale-cand', 102),
      envelope: env('op-int-2'),
    });

    expect(() => tx.rolloutCandidateOpened({
      applicationId: 'app-stale-cand',
      candidate: { ...candidate('cand-2', 'app-stale-cand', 'int-nonexistent') },
      envelope: env('op-cand-2'),
    })).toThrow(/current intent/);
  });

  it('records a deploy, then accepts the ack that names it', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-ack', 103, 1);
    tx.intentRevised({ applicationId: 'app-ack', intent: intent('int-3', 'app-ack', 103), envelope: env('op-int-3') });

    tx.blueprintDeployStarted({
      applicationId: 'app-ack',
      nodeId: 1,
      intentRevisionId: 'int-3',
      rolloutCandidateId: null,
      envelope: env('op-dep-3'),
    });
    let target = store.getTarget('app-ack', 1)!;
    expect(target.active_operation_stage).toBe('blueprint_deploy_started');
    expect(target.active_intent_revision_id).toBe('int-3');
    // Nothing is acknowledged yet: the request is in flight, not converged.
    expect(target.intent_revision_id).toBeNull();

    tx.blueprintAckRecorded({
      applicationId: 'app-ack',
      nodeId: 1,
      intentRevisionId: 'int-3',
      rolloutCandidateId: null,
      legacyAppliedRevision: 7,
      envelope: env('op-ack-3'),
    });
    target = store.getTarget('app-ack', 1)!;
    expect(target.intent_revision_id).toBe('int-3');
    expect(target.active_operation_stage).toBeNull();
    expect(target.legacy_applied_revision).toBe(7);
    // A Blueprint target has no Git generation to point at.
    expect(target.desired_generation_id).toBeNull();
  });

  it('ignores an acknowledgement for an intent the target was never asked to run', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-super', 104, 1);
    tx.intentRevised({ applicationId: 'app-super', intent: intent('int-4', 'app-super', 104), envelope: env('op-int-4') });
    tx.blueprintDeployStarted({
      applicationId: 'app-super',
      nodeId: 1,
      intentRevisionId: 'int-4',
      rolloutCandidateId: null,
      envelope: env('op-dep-4'),
    });

    // A newer intent superseded the one this node is running.
    tx.intentRevised({ applicationId: 'app-super', intent: intent('int-5', 'app-super', 104), envelope: env('op-int-5') });

    expect(() => tx.blueprintAckRecorded({
      applicationId: 'app-super',
      nodeId: 1,
      intentRevisionId: 'int-5',
      rolloutCandidateId: null,
      legacyAppliedRevision: null,
      envelope: env('op-ack-5'),
    })).toThrow(/was not asked to run/);
    expect(store.getTarget('app-super', 1)?.intent_revision_id).toBeNull();
  });

  it('clears a deploy failure only when the next deploy is acknowledged', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-fail', 105, 1);
    tx.intentRevised({ applicationId: 'app-fail', intent: intent('int-6', 'app-fail', 105), envelope: env('op-int-6') });
    tx.blueprintDeployStarted({
      applicationId: 'app-fail',
      nodeId: 1,
      intentRevisionId: 'int-6',
      rolloutCandidateId: null,
      envelope: env('op-dep-6'),
    });
    tx.blueprintDeployFailed({
      applicationId: 'app-fail',
      nodeId: 1,
      failureClass: 'name_conflict',
      envelope: env('op-dep-6'),
    });

    let target = store.getTarget('app-fail', 1)!;
    expect(target.failure_stage).toBe('blueprint_deploy');
    expect(target.failure_class).toBe('name_conflict');
    expect(target.active_operation_stage).toBeNull();
    // A failure does not acknowledge anything.
    expect(target.intent_revision_id).toBeNull();

    tx.blueprintDeployStarted({
      applicationId: 'app-fail',
      nodeId: 1,
      intentRevisionId: 'int-6',
      rolloutCandidateId: null,
      envelope: env('op-dep-6b'),
    });
    tx.blueprintAckRecorded({
      applicationId: 'app-fail',
      nodeId: 1,
      intentRevisionId: 'int-6',
      rolloutCandidateId: null,
      legacyAppliedRevision: null,
      envelope: env('op-ack-6b'),
    });
    target = store.getTarget('app-fail', 1)!;
    expect(target.failure_stage).toBeNull();
    expect(target.intent_revision_id).toBe('int-6');
  });

  it('withdraws against the intent being removed, not a later one', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-wd', 106, 1);
    tx.intentRevised({ applicationId: 'app-wd', intent: intent('int-7', 'app-wd', 106), envelope: env('op-int-7') });
    tx.blueprintWithdrawStarted({
      applicationId: 'app-wd',
      nodeId: 1,
      intentRevisionId: 'int-7',
      envelope: env('op-wd-7'),
    });

    expect(() => tx.blueprintWithdrawn({
      applicationId: 'app-wd',
      nodeId: 1,
      intentRevisionId: 'int-other',
      envelope: env('op-wd-7'),
    })).toThrow(/was not asked to run/);

    tx.blueprintWithdrawn({
      applicationId: 'app-wd',
      nodeId: 1,
      intentRevisionId: 'int-7',
      envelope: env('op-wd-7'),
    });
    const target = store.getTarget('app-wd', 1)!;
    expect(target.target_status).toBe('tombstoned');
    expect(target.active_operation_stage).toBeNull();
  });

  it('re-opens a severed placement when a deploy starts again', () => {
    // Withdrawal is terminal for the placement, not for the node. A later
    // explicit deploy re-activates the target and records the revival in the
    // same event, so the projection and the workload cannot disagree about
    // whether this node runs the Blueprint.
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-revive', 220, 1);
    tx.intentRevised({
      applicationId: 'app-revive',
      intent: intent('int-rev', 'app-revive', 220),
      envelope: env('op-rev-int'),
    });
    tx.blueprintDeployStarted({
      applicationId: 'app-revive', nodeId: 1, intentRevisionId: 'int-rev',
      rolloutCandidateId: null, envelope: env('op-rev-d1'),
    });
    tx.blueprintAckRecorded({
      applicationId: 'app-revive', nodeId: 1, intentRevisionId: 'int-rev',
      rolloutCandidateId: null, legacyAppliedRevision: null, envelope: env('op-rev-a1'),
    });
    tx.blueprintWithdrawStarted({
      applicationId: 'app-revive', nodeId: 1, intentRevisionId: 'int-rev',
      envelope: env('op-rev-w1'),
    });
    tx.blueprintWithdrawn({
      applicationId: 'app-revive', nodeId: 1, intentRevisionId: 'int-rev',
      envelope: env('op-rev-w2'),
    });
    expect(store.getTarget('app-revive', 1)?.target_status).toBe('tombstoned');

    tx.blueprintDeployStarted({
      applicationId: 'app-revive', nodeId: 1, intentRevisionId: 'int-rev',
      rolloutCandidateId: null, envelope: env('op-rev-d2'),
    });

    const revived = store.getTarget('app-revive', 1)!;
    expect(revived.target_status).toBe('active');
    expect(revived.active_operation_stage).toBe('blueprint_deploy_started');
    // The acknowledged intent survives severance; only a fresh ack rewrites it.
    expect(revived.intent_revision_id).toBe('int-rev');
  });

  it('keeps a failed withdraw distinct from a failed deploy', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-wdf', 107, 1);
    tx.intentRevised({ applicationId: 'app-wdf', intent: intent('int-8', 'app-wdf', 107), envelope: env('op-int-8') });
    tx.blueprintWithdrawStarted({
      applicationId: 'app-wdf',
      nodeId: 1,
      intentRevisionId: 'int-8',
      envelope: env('op-wd-8'),
    });
    tx.blueprintWithdrawFailed({
      applicationId: 'app-wdf',
      nodeId: 1,
      failureClass: 'post_mutation',
      envelope: env('op-wd-8'),
    });

    const target = store.getTarget('app-wdf', 1)!;
    expect(target.failure_stage).toBe('blueprint_withdraw');
    // Still active: a withdraw that failed has not removed the deployment.
    expect(target.target_status).toBe('active');
  });

  it('releases the request identity with the operation, not just the stage', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-ident', 120, 1);
    tx.intentRevised({ applicationId: 'app-ident', intent: intent('int-20', 'app-ident', 120), envelope: env('op-int-20') });
    tx.blueprintDeployStarted({
      applicationId: 'app-ident',
      nodeId: 1,
      intentRevisionId: 'int-20',
      rolloutCandidateId: null,
      envelope: env('op-dep-20'),
    });
    tx.blueprintDeployFailed({
      applicationId: 'app-ident',
      nodeId: 1,
      failureClass: 'pre_mutation',
      envelope: env('op-dep-20'),
    });

    // Identity has to go with the stage. Left behind, a later start that only
    // sets a stage would make the superseded intent read as live again, and a
    // duplicate ack for it would then be accepted.
    const target = store.getTarget('app-ident', 1)!;
    expect(target.active_operation_stage).toBeNull();
    expect(target.active_intent_revision_id).toBeNull();
    expect(target.active_rollout_candidate_id).toBeNull();

    expect(() => tx.blueprintAckRecorded({
      applicationId: 'app-ident',
      nodeId: 1,
      intentRevisionId: 'int-20',
      rolloutCandidateId: null,
      legacyAppliedRevision: null,
      envelope: env('op-ack-20'),
    })).toThrow(/was not asked to run/);
  });

  it('acknowledges an interrupted deploy, and retires the interruption with it', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-int', 121, 1);
    tx.intentRevised({ applicationId: 'app-int', intent: intent('int-21', 'app-int', 121), envelope: env('op-int-21') });
    tx.blueprintDeployStarted({
      applicationId: 'app-int',
      nodeId: 1,
      intentRevisionId: 'int-21',
      rolloutCandidateId: 'cand-21',
      envelope: env('op-dep-21'),
    });
    tx.interruptActiveOperations('app-int', env('op-boot-21'));
    expect(store.getTarget('app-int', 1)?.interruption_stage).toBe('blueprint_deploy_started');

    // An ack that arrives after a restart still names a request this target was
    // genuinely given, so it is accepted.
    tx.blueprintAckRecorded({
      applicationId: 'app-int',
      nodeId: 1,
      intentRevisionId: 'int-21',
      rolloutCandidateId: 'cand-21',
      legacyAppliedRevision: null,
      envelope: env('op-ack-21'),
    });

    const target = store.getTarget('app-int', 1)!;
    expect(target.intent_revision_id).toBe('int-21');
    expect(target.rollout_candidate_id).toBe('cand-21');
    // Retired, or it would keep matching and let a third ack regress the
    // pointer after two later deploys had succeeded.
    expect(target.interruption_stage).toBeNull();
    expect(target.interruption_intent_revision_id).toBeNull();
    expect(target.interruption_rollout_candidate_id).toBeNull();
  });

  it('refuses an acknowledgement that pairs the deployed intent with another candidate', () => {
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-pair', 122, 1);
    tx.intentRevised({ applicationId: 'app-pair', intent: intent('int-22', 'app-pair', 122), envelope: env('op-int-22') });
    tx.blueprintDeployStarted({
      applicationId: 'app-pair',
      nodeId: 1,
      intentRevisionId: 'int-22',
      rolloutCandidateId: 'cand-22',
      envelope: env('op-dep-22'),
    });

    expect(() => tx.blueprintAckRecorded({
      applicationId: 'app-pair',
      nodeId: 1,
      intentRevisionId: 'int-22',
      rolloutCandidateId: 'cand-other',
      legacyAppliedRevision: null,
      envelope: env('op-ack-22'),
    })).toThrow(/not the one deployed/);
  });

  it('will not settle a deploy out of a withdraw, or the reverse', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-cross', 123, 1);
    tx.intentRevised({ applicationId: 'app-cross', intent: intent('int-23', 'app-cross', 123), envelope: env('op-int-23') });
    tx.blueprintWithdrawStarted({
      applicationId: 'app-cross',
      nodeId: 1,
      intentRevisionId: 'int-23',
      envelope: env('op-wd-23'),
    });

    // Same intent, but it names the deploy this target is not running. Taking
    // it would claim the deployment is live while it is being torn down.
    expect(() => tx.blueprintAckRecorded({
      applicationId: 'app-cross',
      nodeId: 1,
      intentRevisionId: 'int-23',
      rolloutCandidateId: null,
      legacyAppliedRevision: null,
      envelope: env('op-ack-23'),
    })).toThrow(/was not asked to run/);
    expect(store.getTarget('app-cross', 1)?.target_status).toBe('active');
    expect(store.getTarget('app-cross', 1)?.active_operation_stage).toBe('blueprint_withdraw_started');
  });

  it('refuses a start that would displace an unrelated operation', () => {
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-conflict', 124, 1);
    tx.intentRevised({ applicationId: 'app-conflict', intent: intent('int-24', 'app-conflict', 124), envelope: env('op-int-24') });
    tx.blueprintDeployStarted({
      applicationId: 'app-conflict',
      nodeId: 1,
      intentRevisionId: 'int-24',
      rolloutCandidateId: null,
      envelope: env('op-dep-24'),
    });

    // Overwriting would leave the displaced operation with no terminal event
    // and no history saying it was abandoned.
    expect(() => tx.blueprintWithdrawStarted({
      applicationId: 'app-conflict',
      nodeId: 1,
      intentRevisionId: 'int-24',
      envelope: env('op-wd-24-other'),
    })).toThrow(/conflicting target operation/);
  });

  it('records an observation without acknowledging or minting anything', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-obs', 108, 1);
    tx.intentRevised({ applicationId: 'app-obs', intent: intent('int-9', 'app-obs', 108), envelope: env('op-int-9') });
    const before = store.getApplication('app-obs')!;

    for (const stage of ['blueprint_state_review', 'blueprint_evict_blocked', 'blueprint_drifted', 'blueprint_correcting'] as const) {
      tx.blueprintObservation({ applicationId: 'app-obs', nodeId: 1, stage, envelope: env(`op-obs-${stage}`) });
    }

    const after = store.getApplication('app-obs')!;
    expect(after.intent_revision_id).toBe(before.intent_revision_id);
    expect(after.rollout_candidate_id).toBe(before.rollout_candidate_id);
    expect(store.getTarget('app-obs', 1)?.intent_revision_id).toBeNull();
  });

  it('projects every observation stage as its runtime status', () => {
    // Recording an observation nothing reads would leave a deployed Blueprint
    // reporting itself as never applied, which is what the pointers alone say.
    const tx = GitOpsTransitions.getInstance();
    const expected = {
      blueprint_state_review: 'pending_state_review',
      blueprint_evict_blocked: 'evict_blocked',
      blueprint_drifted: 'drifted',
      blueprint_correcting: 'correcting',
    } as const;

    // One live application per Blueprint, so each case needs its own id.
    Object.entries(expected).forEach(([stage, status], index) => {
      const applicationId = `app-proj-${stage}`;
      seedInline(applicationId, 200 + index, 1);
      tx.blueprintObservation({
        applicationId,
        nodeId: 1,
        stage: stage as keyof typeof expected,
        envelope: env(`op-proj-${stage}`),
      });

      expect(runtimeStatusOf(applicationId), stage).toBe(status);
    });
  });

  it('stops projecting an observation once something else happens to the target', () => {
    // The observation is what was seen last, not a state the target is stuck
    // in. A deploy after it has to win, or a corrected stack reads as drifting
    // for ever. A deploy start rather than a tombstone, so the runtime
    // assertion is load-bearing: the tombstone check sits above the observation
    // branch and would hold whatever `latest_stage` said.
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-superseded', 210, 1);
    tx.intentRevised({
      applicationId: 'app-superseded',
      intent: intent('int-sup', 'app-superseded', 210),
      envelope: env('op-sup-int'),
    });
    tx.blueprintObservation({
      applicationId: 'app-superseded', nodeId: 1, stage: 'blueprint_drifted', envelope: env('op-sup-obs'),
    });
    expect(runtimeStatusOf('app-superseded')).toBe('drifted');

    tx.blueprintDeployStarted({
      applicationId: 'app-superseded',
      nodeId: 1,
      intentRevisionId: 'int-sup',
      rolloutCandidateId: null,
      envelope: env('op-sup-deploy'),
    });

    expect(store.getTarget('app-superseded', 1)?.latest_stage).toBe('blueprint_deploy_started');
    expect(runtimeStatusOf('app-superseded')).not.toBe('drifted');
  });

  it('does not let an observation mask a failure this node actually hit', () => {
    // The ordering claim in the deriver, asserted at its upper boundary. A
    // failed mutation describes what this node did; an observation describes
    // what was seen about it. Reporting the observation instead would hide a
    // deploy that broke the running workload.
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-failfirst', 211, 1);
    tx.deployFailed('app-failfirst', 1, 'post_mutation', env('op-fail'));
    tx.blueprintObservation({
      applicationId: 'app-failfirst', nodeId: 1, stage: 'blueprint_drifted', envelope: env('op-fail-obs'),
    });

    expect(runtimeStatusOf('app-failfirst')).toBe('failed_after_mutation');
  });
});

function runtimeStatusOf(applicationId: string): string | undefined {
  const projection = projectApplication(applicationId, false);
  if (projection.targetMode === 'not_applicable') throw new Error('expected application');
  return projection.targets[0]?.runtime.status;
}

function seedInline(applicationId: string, blueprintId: number, nodeId?: number): void {
  const store = GitOpsStore.getInstance();
  store.insertApplication(inlineApp(applicationId, blueprintId));
  if (nodeId !== undefined) {
    store.upsertTarget(emptyTargetRow(applicationId, nodeId, 1));
  }
}

function env(operationId: string): EventEnvelope {
  return { operationId, actor: 'tester', trigger: 'manual', at: Date.now() };
}

function intent(id: string, applicationId: string, blueprintId: number): GitOpsIntentRevisionRow {
  return {
    id,
    application_id: applicationId,
    blueprint_id: blueprintId,
    compose_content_sha256: 'c'.repeat(64),
    blueprint_revision: 1,
    deploy_stack_name: 'bp-stack',
    selector_json: '{"nodeIds":[1]}',
    pinned_node_id: null,
    cordon_implications_json: '{}',
    rollout_strategy_json: '{}',
    runtime_drift_policy: null,
    stateful_policy_json: null,
    health_failure_rollback_policy_json: null,
    operation_id: `op-${id}`,
    actor: 'tester',
    created_at: 1,
  };
}

function candidate(id: string, applicationId: string, intentRevisionId: string): GitOpsRolloutCandidateRow {
  return {
    id,
    application_id: applicationId,
    intent_revision_id: intentRevisionId,
    compose_content_sha256: 'c'.repeat(64),
    accepted_generation_id: null,
    artifact_set_id: null,
    required_targets_json: '{"nodeIds":[1]}',
    authoritative: 1,
    provenance: 'intent_change',
    operation_id: `op-${id}`,
    created_at: 1,
  };
}

function inlineApp(id: string, blueprintId: number): GitOpsApplicationRow {
  return {
    id,
    lifecycle_key: `blueprint:${blueprintId}`,
    lifecycle_status: 'active',
    target_mode: 'inline_blueprint',
    stack_name: null,
    blueprint_id: blueprintId,
    configured_repo_url: null,
    repo_identity_json: null,
    configured_ref: null,
    compose_paths_json: null,
    context_dir: null,
    sync_env: 0,
    env_path: null,
    materialization_fingerprint: null,
    desired_commit_sha: null,
    fetched_commit_sha: null,
    fetched_resolved_ref_kind: null,
    candidate_generation_id: null,
    accepted_generation_id: null,
    candidate_plan_blocked: 0,
    review_required: 0,
    artifact_set_id: null,
    latest_artifact_set_id: null,
    intent_revision_id: null,
    rollout_candidate_id: null,
    rollout_generation_id: null,
    source_acceptance_ref: null,
    placement_approval_ref: null,
    rollout_authorization_ref: null,
    legacy_combined_approval_ref: null,
    preflight_fingerprint: null,
    latest_operation_id: null,
    active_operation_id: null,
    active_operation_stage: null,
    active_operation_at: null,
    active_generation_id: null,
    pause_at: null,
    pause_reason: null,
    partial_json: null,
    failure_stage: null,
    failure_class: null,
    failure_at: null,
    retry_at: null,
    retry_count: 0,
    suspended_at: null,
    recovery_ref: null,
    recovery_phase: null,
    interruption_stage: null,
    interruption_at: null,
    interruption_operation_id: null,
    interruption_generation_id: null,
    evidence_fresh_at: null,
    evidence_limitations_json: null,
    created_at: 1,
    updated_at: 1,
  };
}
