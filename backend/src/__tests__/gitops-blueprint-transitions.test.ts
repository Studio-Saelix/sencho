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
import { attentionReasons } from '../services/gitops/attention';
import { postureOf } from '../services/gitops/portfolioAggregator';
import type {
  GitOpsApplicationRow,
  GitOpsIntentRevisionRow,
  GitOpsRevisionProjection,
  GitOpsRolloutCandidateRow,
} from '../services/gitops/types';
import { DEFAULT_PLACEMENT_POLICY, DEFAULT_ROLLOUT_AUTHORIZATION_POLICY } from '../services/gitops/policyComposition';

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

  it('retires a stale recovery failure when a later deploy is acknowledged', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-ack-rec', 331, 1);
    tx.intentRevised({ applicationId: 'app-ack-rec', intent: intent('int-ack-rec', 'app-ack-rec', 331), envelope: env('op-int-ack-rec') });
    // An earlier rollout left the node's recovery failed and parked the
    // application with it.
    tx.rollbackInProgress({
      applicationId: 'app-ack-rec',
      nodeId: 1,
      recoveryRef: 'rb-old',
      recoveryGenerationId: null,
      envelope: env('op-rec-open'),
    });
    tx.rollbackPartialFailed({
      applicationId: 'app-ack-rec',
      nodeId: 1,
      recoveryRef: 'rb-old',
      failureClass: 'partial',
      envelope: env('op-rec-fail'),
    });
    expect(store.getApplication('app-ack-rec')?.recovery_phase).toBe('failed');

    tx.blueprintDeployStarted({
      applicationId: 'app-ack-rec',
      nodeId: 1,
      intentRevisionId: 'int-ack-rec',
      rolloutCandidateId: null,
      envelope: env('op-dep-ack-rec'),
    });
    tx.blueprintAckRecorded({
      applicationId: 'app-ack-rec',
      nodeId: 1,
      intentRevisionId: 'int-ack-rec',
      rolloutCandidateId: null,
      legacyAppliedRevision: 2,
      envelope: env('op-ack-rec'),
    });

    const target = store.getTarget('app-ack-rec', 1)!;
    expect(target.recovery_phase).toBeNull();
    expect(target.recovery_ref).toBeNull();
    expect(target.failure_stage).toBeNull();
    expect(target.failure_class).toBeNull();
    // The workload is the acknowledged generation now. This is not a health
    // claim: nothing has observed it yet.
    expect(target.healthy_generation_id).toBeNull();
    const app = store.getApplication('app-ack-rec')!;
    expect(app.recovery_phase).toBeNull();
    expect(app.failure_stage).toBeNull();
    expect(app.failure_class).toBeNull();
  });

  it('keeps the application recovery failure while another target still reports one', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-ack-keep', 332, 1);
    store.upsertTarget(emptyTargetRow('app-ack-keep', 2, 1));
    tx.intentRevised({ applicationId: 'app-ack-keep', intent: intent('int-ack-keep', 'app-ack-keep', 332), envelope: env('op-int-ack-keep') });
    for (const nodeId of [1, 2]) {
      tx.rollbackInProgress({
        applicationId: 'app-ack-keep',
        nodeId,
        recoveryRef: 'rb-keep',
        recoveryGenerationId: null,
        envelope: env(`op-open-${nodeId}`),
      });
      tx.rollbackPartialFailed({
        applicationId: 'app-ack-keep',
        nodeId,
        recoveryRef: 'rb-keep',
        failureClass: 'partial',
        envelope: env(`op-fail-${nodeId}`),
      });
    }
    for (const nodeId of [1, 2]) {
      tx.blueprintDeployStarted({
        applicationId: 'app-ack-keep',
        nodeId,
        intentRevisionId: 'int-ack-keep',
        rolloutCandidateId: null,
        envelope: env(`op-dep-${nodeId}`),
      });
    }

    tx.blueprintAckRecorded({
      applicationId: 'app-ack-keep',
      nodeId: 1,
      intentRevisionId: 'int-ack-keep',
      rolloutCandidateId: null,
      legacyAppliedRevision: null,
      envelope: env('op-ack-1'),
    });

    expect(store.getTarget('app-ack-keep', 1)?.failure_stage).toBeNull();
    expect(store.getTarget('app-ack-keep', 2)?.recovery_phase).toBe('failed');
    // One target still reports the failure, so the application keeps the hold
    // that surfaces it.
    expect(store.getApplication('app-ack-keep')?.recovery_phase).toBe('failed');
    expect(store.getApplication('app-ack-keep')?.failure_stage).toBe('recovery');
  });

  it('keeps the application hold while a sibling restore is still moving', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-ack-moving', 336, 1);
    store.upsertTarget(emptyTargetRow('app-ack-moving', 2, 1));
    tx.intentRevised({ applicationId: 'app-ack-moving', intent: intent('int-ack-moving', 'app-ack-moving', 336), envelope: env('op-int-ack-moving') });

    tx.rollbackInProgress({
      applicationId: 'app-ack-moving', nodeId: 1, recoveryRef: 'rb-moving',
      recoveryGenerationId: null, envelope: env('op-open-1'),
    });
    tx.rollbackPartialFailed({
      applicationId: 'app-ack-moving', nodeId: 1, recoveryRef: 'rb-moving',
      failureClass: 'partial', envelope: env('op-fail-1'),
    });
    // Node 2 is opened and never terminalised: its restore is still moving.
    tx.rollbackInProgress({
      applicationId: 'app-ack-moving', nodeId: 2, recoveryRef: 'rb-moving',
      recoveryGenerationId: null, envelope: env('op-open-2'),
    });
    tx.blueprintDeployStarted({
      applicationId: 'app-ack-moving', nodeId: 1, intentRevisionId: 'int-ack-moving',
      rolloutCandidateId: null, envelope: env('op-dep-1'),
    });

    // Node 1's acknowledgement retires its own claim. Node 2's restore is still
    // running, so the application stamp must survive it.
    tx.blueprintAckRecorded({
      applicationId: 'app-ack-moving', nodeId: 1, intentRevisionId: 'int-ack-moving',
      rolloutCandidateId: null, legacyAppliedRevision: null, envelope: env('op-ack-1'),
    });

    expect(store.getTarget('app-ack-moving', 1)?.recovery_phase).toBeNull();
    expect(store.getTarget('app-ack-moving', 2)?.recovery_phase).toBe('restoring');
    expect(store.getApplication('app-ack-moving')?.recovery_phase).toBe('restoring');
  });

  it('releases the application hold when its last claimant is withdrawn', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-wd-hold', 337, 1);
    tx.intentRevised({ applicationId: 'app-wd-hold', intent: intent('int-wd-hold', 'app-wd-hold', 337), envelope: env('op-int-wd-hold') });

    tx.rollbackInProgress({
      applicationId: 'app-wd-hold', nodeId: 1, recoveryRef: 'rb-wd-hold',
      recoveryGenerationId: null, envelope: env('op-wd-hold-open'),
    });
    tx.rollbackPartialFailed({
      applicationId: 'app-wd-hold', nodeId: 1, recoveryRef: 'rb-wd-hold',
      failureClass: 'partial', envelope: env('op-wd-hold-fail'),
    });
    expect(store.getApplication('app-wd-hold')?.recovery_phase).toBe('failed');

    tx.blueprintWithdrawStarted({
      applicationId: 'app-wd-hold', nodeId: 1, intentRevisionId: 'int-wd-hold',
      envelope: env('op-wd-hold-start'),
    });
    tx.blueprintWithdrawn({
      applicationId: 'app-wd-hold', nodeId: 1, intentRevisionId: 'int-wd-hold',
      envelope: env('op-wd-hold-done'),
    });

    // The tombstone stops answering for the hold; the claim itself stays as
    // residue, so a later revival still knows the restore was never resolved.
    expect(store.getApplication('app-wd-hold')?.recovery_phase).toBeNull();
    expect(store.getTarget('app-wd-hold', 1)?.recovery_phase).toBe('failed');
    expect(store.getTarget('app-wd-hold', 1)?.recovery_failure_class).toBe('partial');
  });

  it('does not let a refused target pin the application after the last real failure is retired', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-ack-mixed', 335, 1);
    store.upsertTarget(emptyTargetRow('app-ack-mixed', 2, 1));
    tx.intentRevised({ applicationId: 'app-ack-mixed', intent: intent('int-ack-mixed', 'app-ack-mixed', 335), envelope: env('op-int-ack-mixed') });

    // Node 1 was refused before any mutation and only carries the visible
    // marker; node 2 failed after a possible mutation and holds the app.
    for (const [nodeId, failureClass] of [[1, 'pre_mutation'], [2, 'partial']] as const) {
      tx.rollbackInProgress({
        applicationId: 'app-ack-mixed',
        nodeId,
        recoveryRef: 'rb-mixed',
        recoveryGenerationId: null,
        envelope: env(`op-open-${nodeId}`),
      });
      tx.rollbackPartialFailed({
        applicationId: 'app-ack-mixed',
        nodeId,
        recoveryRef: 'rb-mixed',
        failureClass,
        envelope: env(`op-fail-${nodeId}`),
      });
    }
    expect(store.getApplication('app-ack-mixed')?.recovery_phase).toBe('failed');
    for (const nodeId of [1, 2]) {
      tx.blueprintDeployStarted({
        applicationId: 'app-ack-mixed',
        nodeId,
        intentRevisionId: 'int-ack-mixed',
        rolloutCandidateId: null,
        envelope: env(`op-dep-${nodeId}`),
      });
    }

    tx.blueprintAckRecorded({
      applicationId: 'app-ack-mixed',
      nodeId: 2,
      intentRevisionId: 'int-ack-mixed',
      rolloutCandidateId: null,
      legacyAppliedRevision: null,
      envelope: env('op-ack-mixed-2'),
    });

    // Node 1's refusal never held the application by itself, so it must not
    // pin it once node 2's real failure is gone.
    expect(store.getTarget('app-ack-mixed', 1)?.recovery_phase).toBe('failed');
    expect(store.getTarget('app-ack-mixed', 1)?.failure_class).toBe('pre_mutation');
    expect(store.getApplication('app-ack-mixed')?.recovery_phase).toBeNull();
    expect(store.getApplication('app-ack-mixed')?.failure_stage).toBeNull();
  });

  it('keeps the application hold when the acknowledged node is itself restoring', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-ack-self-moving', 340, 1);
    store.upsertTarget(emptyTargetRow('app-ack-self-moving', 2, 1));
    tx.intentRevised({ applicationId: 'app-ack-self-moving', intent: intent('int-self-moving', 'app-ack-self-moving', 340), envelope: env('op-int-self-moving') });

    // Node 2 fails after a possible mutation and owns the application hold.
    tx.rollbackPartialFailed({
      applicationId: 'app-ack-self-moving', nodeId: 2, recoveryRef: 'rb-self-other',
      failureClass: 'partial', envelope: env('op-self-other'),
    });
    expect(store.getApplication('app-ack-self-moving')?.recovery_phase).toBe('failed');

    // Node 1 is deployed, then a restore opens beside the deploy. The restore
    // owns the application stamp while it moves.
    tx.blueprintDeployStarted({
      applicationId: 'app-ack-self-moving', nodeId: 1, intentRevisionId: 'int-self-moving',
      rolloutCandidateId: null, envelope: env('op-self-deploy'),
    });
    tx.rollbackInProgress({
      applicationId: 'app-ack-self-moving', nodeId: 1, recoveryRef: 'rb-self-a',
      recoveryGenerationId: null, envelope: env('op-self-a'),
    });

    // The acknowledgement retires the deploy's own claim, but the restore on
    // the same row is still moving and node 2 still holds a moved claim, so the
    // application stamp and node 2's hold must both stay.
    tx.blueprintAckRecorded({
      applicationId: 'app-ack-self-moving', nodeId: 1, intentRevisionId: 'int-self-moving',
      rolloutCandidateId: null, legacyAppliedRevision: null, envelope: env('op-self-ack'),
    });

    expect(store.getTarget('app-ack-self-moving', 1)?.recovery_phase).toBe('restoring');
    expect(store.getTarget('app-ack-self-moving', 2)?.recovery_phase).toBe('failed');
    expect(store.getApplication('app-ack-self-moving')?.recovery_phase).toBe('restoring');
  });

  it('never rewrites a restoring row when an acknowledgement lands beside it', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-ack-beside', 339, 1);
    tx.intentRevised({ applicationId: 'app-ack-beside', intent: intent('int-beside', 'app-ack-beside', 339), envelope: env('op-int-beside') });

    tx.rollbackInProgress({
      applicationId: 'app-ack-beside', nodeId: 1, recoveryRef: 'rb-beside-a',
      recoveryGenerationId: null, envelope: env('op-beside-a'),
    });
    tx.rollbackPartialFailed({
      applicationId: 'app-ack-beside', nodeId: 1, recoveryRef: 'rb-beside-a',
      failureClass: 'pre_mutation', envelope: env('op-beside-a-terminal'),
    });
    tx.blueprintDeployStarted({
      applicationId: 'app-ack-beside', nodeId: 1, intentRevisionId: 'int-beside',
      rolloutCandidateId: null, envelope: env('op-beside-deploy'),
    });
    // A retry opens a restore beside the deploy.
    tx.rollbackInProgress({
      applicationId: 'app-ack-beside', nodeId: 1, recoveryRef: 'rb-beside-b',
      recoveryGenerationId: null, envelope: env('op-beside-b'),
    });

    // The acknowledgement is success evidence for the apply, but the restore
    // beside it is still moving: its phase, ref and claim survive, and the
    // marker goes back to it.
    tx.blueprintAckRecorded({
      applicationId: 'app-ack-beside', nodeId: 1, intentRevisionId: 'int-beside',
      rolloutCandidateId: null, legacyAppliedRevision: null, envelope: env('op-beside-ack'),
    });
    const target = store.getTarget('app-ack-beside', 1)!;
    expect(target.recovery_phase).toBe('restoring');
    expect(target.recovery_ref).toBe('rb-beside-b');
    expect(target.recovery_failure_class).toBe('pre_mutation');
    expect(target.active_operation_stage).toBe('recovery_started');
    expect(store.getApplication('app-ack-beside')?.recovery_phase).toBe('restoring');
  });

  it('keeps a tombstone recovery residue through a revival until the acknowledgement', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-revive-residue', 338, 1);
    tx.intentRevised({ applicationId: 'app-revive-residue', intent: intent('int-res', 'app-revive-residue', 338), envelope: env('op-int-res') });

    tx.rollbackInProgress({
      applicationId: 'app-revive-residue', nodeId: 1, recoveryRef: 'rb-res',
      recoveryGenerationId: null, envelope: env('op-res-open'),
    });
    tx.rollbackPartialFailed({
      applicationId: 'app-revive-residue', nodeId: 1, recoveryRef: 'rb-res',
      failureClass: 'partial', envelope: env('op-res-fail'),
    });
    tx.blueprintWithdrawStarted({
      applicationId: 'app-revive-residue', nodeId: 1, intentRevisionId: 'int-res',
      envelope: env('op-res-wd-start'),
    });
    tx.blueprintWithdrawn({
      applicationId: 'app-revive-residue', nodeId: 1, intentRevisionId: 'int-res',
      envelope: env('op-res-wd-done'),
    });
    expect(store.getTarget('app-revive-residue', 1)?.target_status).toBe('tombstoned');

    // The revival is a placement, not evidence the abandoned restore resolved.
    tx.blueprintDeployStarted({
      applicationId: 'app-revive-residue', nodeId: 1, intentRevisionId: 'int-res',
      rolloutCandidateId: null, envelope: env('op-res-revive'),
    });
    expect(store.getTarget('app-revive-residue', 1)?.target_status).toBe('active');
    expect(store.getTarget('app-revive-residue', 1)?.recovery_phase).toBe('failed');
    expect(store.getTarget('app-revive-residue', 1)?.recovery_failure_class).toBe('partial');
    // The revived row answers for the hold again, so the application holds with
    // it instead of reporting a failure no surface owns.
    expect(store.getApplication('app-revive-residue')?.recovery_phase).toBe('failed');
    expect(store.getApplication('app-revive-residue')?.failure_stage).toBe('recovery');

    // The acknowledgement for the new placement is the evidence that retires it.
    tx.blueprintAckRecorded({
      applicationId: 'app-revive-residue', nodeId: 1, intentRevisionId: 'int-res',
      rolloutCandidateId: null, legacyAppliedRevision: null, envelope: env('op-res-ack'),
    });
    expect(store.getTarget('app-revive-residue', 1)?.recovery_phase).toBeNull();
    expect(store.getTarget('app-revive-residue', 1)?.recovery_failure_class).toBeNull();
  });

  it('re-derives the application hold when a state-review observation revives a residue', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-obs-revive', 341, 1);
    tx.intentRevised({ applicationId: 'app-obs-revive', intent: intent('int-obs-revive', 'app-obs-revive', 341), envelope: env('op-int-obs-revive') });

    tx.rollbackInProgress({
      applicationId: 'app-obs-revive', nodeId: 1, recoveryRef: 'rb-obs-revive',
      recoveryGenerationId: null, envelope: env('op-obs-revive-open'),
    });
    tx.rollbackPartialFailed({
      applicationId: 'app-obs-revive', nodeId: 1, recoveryRef: 'rb-obs-revive',
      failureClass: 'partial', envelope: env('op-obs-revive-fail'),
    });
    tx.blueprintWithdrawStarted({
      applicationId: 'app-obs-revive', nodeId: 1, intentRevisionId: 'int-obs-revive',
      envelope: env('op-obs-revive-wd-start'),
    });
    tx.blueprintWithdrawn({
      applicationId: 'app-obs-revive', nodeId: 1, intentRevisionId: 'int-obs-revive',
      envelope: env('op-obs-revive-wd-done'),
    });
    expect(store.getApplication('app-obs-revive')?.recovery_phase).toBeNull();

    // The state-review observation revives the placement. Both revival paths
    // share one helper, so the hold comes back here exactly as it does for a
    // deploy start.
    tx.blueprintObservation({
      applicationId: 'app-obs-revive', nodeId: 1, stage: 'blueprint_state_review',
      envelope: env('op-obs-revive-revive'),
    });

    expect(store.getTarget('app-obs-revive', 1)?.target_status).toBe('active');
    expect(store.getTarget('app-obs-revive', 1)?.recovery_failure_class).toBe('partial');
    expect(store.getApplication('app-obs-revive')?.recovery_phase).toBe('failed');
    expect(store.getApplication('app-obs-revive')?.failure_stage).toBe('recovery');
  });

  it('retires a non-moving residue on revival instead of masking the placement', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-obs-pre', 342, 1);
    tx.intentRevised({ applicationId: 'app-obs-pre', intent: intent('int-obs-pre', 'app-obs-pre', 342), envelope: env('op-int-obs-pre') });

    tx.rollbackInProgress({
      applicationId: 'app-obs-pre', nodeId: 1, recoveryRef: 'rb-obs-pre',
      recoveryGenerationId: null, envelope: env('op-obs-pre-open'),
    });
    tx.rollbackPartialFailed({
      applicationId: 'app-obs-pre', nodeId: 1, recoveryRef: 'rb-obs-pre',
      failureClass: 'pre_mutation', envelope: env('op-obs-pre-fail'),
    });
    tx.blueprintWithdrawStarted({
      applicationId: 'app-obs-pre', nodeId: 1, intentRevisionId: 'int-obs-pre',
      envelope: env('op-obs-pre-wd-start'),
    });
    tx.blueprintWithdrawn({
      applicationId: 'app-obs-pre', nodeId: 1, intentRevisionId: 'int-obs-pre',
      envelope: env('op-obs-pre-wd-done'),
    });

    tx.blueprintObservation({
      applicationId: 'app-obs-pre', nodeId: 1, stage: 'blueprint_state_review',
      envelope: env('op-obs-pre-revive'),
    });

    // A refusal that moved nothing holds nothing and would otherwise mask the
    // placement's own status through the redeploy, so it is retired.
    expect(store.getTarget('app-obs-pre', 1)?.recovery_phase).toBeNull();
    expect(store.getTarget('app-obs-pre', 1)?.recovery_failure_class).toBeNull();
    expect(store.getApplication('app-obs-pre')?.recovery_phase).toBeNull();
  });

  it('does not retire a recovery failure on an acknowledgement for a superseded intent', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-ack-sup', 334, 1);
    tx.intentRevised({ applicationId: 'app-ack-sup', intent: intent('int-sup-1', 'app-ack-sup', 334), envelope: env('op-int-sup-1') });
    tx.rollbackInProgress({
      applicationId: 'app-ack-sup',
      nodeId: 1,
      recoveryRef: 'rb-sup',
      recoveryGenerationId: null,
      envelope: env('op-open-sup'),
    });
    tx.rollbackPartialFailed({
      applicationId: 'app-ack-sup',
      nodeId: 1,
      recoveryRef: 'rb-sup',
      failureClass: 'partial',
      envelope: env('op-fail-sup'),
    });
    tx.blueprintDeployStarted({
      applicationId: 'app-ack-sup',
      nodeId: 1,
      intentRevisionId: 'int-sup-1',
      rolloutCandidateId: null,
      envelope: env('op-dep-sup'),
    });
    tx.intentRevised({ applicationId: 'app-ack-sup', intent: intent('int-sup-2', 'app-ack-sup', 334), envelope: env('op-int-sup-2') });

    tx.blueprintAckRecorded({
      applicationId: 'app-ack-sup',
      nodeId: 1,
      intentRevisionId: 'int-sup-1',
      rolloutCandidateId: null,
      legacyAppliedRevision: null,
      envelope: env('op-ack-sup'),
    });

    // The ack is real evidence the apply landed, but it names the generation
    // the application has left; it must not retire a failure about the state
    // this target still reports.
    expect(store.getTarget('app-ack-sup', 1)?.recovery_phase).toBe('failed');
    expect(store.getApplication('app-ack-sup')?.recovery_phase).toBe('failed');
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

  it('projects a Blueprint deploy and withdrawal in flight as work in progress', () => {
    // Both stages share the `active_operation_stage` column with the Direct
    // deploy. Read against the Direct value alone they fell through to the
    // applied and deployed pointers, so a rollout under way read as whatever
    // the node last converged on.
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-live', 212, 1);
    tx.intentRevised({ applicationId: 'app-live', intent: intent('int-live', 'app-live', 212), envelope: env('op-int-live') });
    tx.blueprintDeployStarted({
      applicationId: 'app-live', nodeId: 1, intentRevisionId: 'int-live',
      rolloutCandidateId: null, envelope: env('op-live'),
    });
    expect(runtimeStatusOf('app-live')).toBe('deploying');

    // A withdrawal cannot start on top of an in-flight deploy, so the node is
    // acknowledged first, which is the sequence a real rollout follows.
    tx.blueprintAckRecorded({
      applicationId: 'app-live', nodeId: 1, intentRevisionId: 'int-live',
      rolloutCandidateId: null, legacyAppliedRevision: null, envelope: env('op-live-ack'),
    });
    tx.blueprintWithdrawStarted({
      applicationId: 'app-live', nodeId: 1, intentRevisionId: 'int-live', envelope: env('op-live-wd'),
    });
    // Nothing else in the codebase produces this status.
    expect(runtimeStatusOf('app-live')).toBe('withdrawing');
  });

  it('does not let an observation mask an operation that is running now', () => {
    // The same ordering claim as the Direct failure above, on the other side of
    // it: a start supersedes the observation it replaces, so a stale drift
    // report must not read through the operation that is under way.
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-liveobs', 213, 1);
    tx.intentRevised({ applicationId: 'app-liveobs', intent: intent('int-liveobs', 'app-liveobs', 213), envelope: env('op-int-liveobs') });
    tx.blueprintObservation({
      applicationId: 'app-liveobs', nodeId: 1, stage: 'blueprint_drifted', envelope: env('op-liveobs-obs'),
    });
    expect(runtimeStatusOf('app-liveobs')).toBe('drifted');

    tx.blueprintDeployStarted({
      applicationId: 'app-liveobs', nodeId: 1, intentRevisionId: 'int-liveobs',
      rolloutCandidateId: null, envelope: env('op-liveobs-dep'),
    });
    expect(runtimeStatusOf('app-liveobs')).toBe('deploying');
  });

  it.each([
    { stage: 'deploy', class: 'post_mutation', expected: 'failed_after_mutation', blueprintId: 214 },
    { stage: 'deploy', class: 'name_conflict', expected: 'failed_previous_workload_intact', blueprintId: 215 },
    { stage: 'deploy', class: 'pre_mutation', expected: 'failed_previous_workload_intact', blueprintId: 216 },
    { stage: 'deploy', class: 'deploy_failed', expected: 'failed_after_mutation', blueprintId: 219 },
    { stage: 'deploy', class: 'target_missing', expected: 'failed_previous_workload_intact', blueprintId: 224 },
    { stage: 'withdraw', class: 'post_mutation', expected: 'failed_after_mutation', blueprintId: 217 },
    { stage: 'withdraw', class: 'name_conflict', expected: 'failed_previous_workload_intact', blueprintId: 218 },
  ] as const)('projects a failed Blueprint $stage ($class) as a failure', ({ stage, class: failureClass, expected, blueprintId }) => {
    // A recorded Blueprint failure that projects as a pointer state is the
    // sharpest edge of the gap: a failure status is what the attention
    // classifier keys on, so a failure that missed it reached no queue at all.
    // The two classes written only by this path carry the whole argument:
    // `name_conflict` and `target_missing` both refuse before the node is
    // touched, and read against the Direct vocabulary they matched neither arm.
    // `deploy_failed` is the opposite: it is recorded for anything that went
    // wrong once the Compose apply was handed over, so it has to read as
    // mutated, or a half-replaced workload reports as intact.
    const tx = GitOpsTransitions.getInstance();
    // One live application per Blueprint, so each case names its own.
    const id = `app-bp-${blueprintId}`;
    seedInline(id, blueprintId, 1);
    tx.intentRevised({ applicationId: id, intent: intent(`int-${id}`, id, blueprintId), envelope: env(`op-int-${id}`) });
    if (stage === 'deploy') {
      tx.blueprintDeployStarted({
        applicationId: id, nodeId: 1, intentRevisionId: `int-${id}`,
        rolloutCandidateId: null, envelope: env(`op-${id}`),
      });
      tx.blueprintDeployFailed({
        applicationId: id, nodeId: 1, failureClass, envelope: env(`op-${id}`),
      });
    } else {
      // A withdrawal answers an acknowledged deployment, so the node is
      // acknowledged first.
      tx.blueprintDeployStarted({
        applicationId: id, nodeId: 1, intentRevisionId: `int-${id}`,
        rolloutCandidateId: null, envelope: env(`op-${id}`),
      });
      tx.blueprintAckRecorded({
        applicationId: id, nodeId: 1, intentRevisionId: `int-${id}`,
        rolloutCandidateId: null, legacyAppliedRevision: null, envelope: env(`op-${id}-ack`),
      });
      tx.blueprintWithdrawStarted({
        applicationId: id, nodeId: 1, intentRevisionId: `int-${id}`, envelope: env(`op-${id}-wd`),
      });
      tx.blueprintWithdrawFailed({
        applicationId: id, nodeId: 1, failureClass, envelope: env(`op-${id}-wd`),
      });
    }

    expect(runtimeStatusOf(id)).toBe(expected);
    // The operator-visible half: a recorded failure has to reach the queue.
    expect(attentionReasons(mustProject(id))).toContain('deploy_failed');
  });

  it('does not let an observation mask a failure a Blueprint deploy recorded', () => {
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-bpfailfirst', 221, 1);
    tx.intentRevised({ applicationId: 'app-bpfailfirst', intent: intent('int-bpfailfirst', 'app-bpfailfirst', 221), envelope: env('op-int-bpfailfirst') });
    tx.blueprintDeployStarted({
      applicationId: 'app-bpfailfirst', nodeId: 1, intentRevisionId: 'int-bpfailfirst',
      rolloutCandidateId: null, envelope: env('op-bpfailfirst'),
    });
    tx.blueprintDeployFailed({
      applicationId: 'app-bpfailfirst', nodeId: 1, failureClass: 'post_mutation', envelope: env('op-bpfailfirst'),
    });
    tx.blueprintObservation({
      applicationId: 'app-bpfailfirst', nodeId: 1, stage: 'blueprint_drifted', envelope: env('op-bpfailfirst-obs'),
    });

    expect(runtimeStatusOf('app-bpfailfirst')).toBe('failed_after_mutation');
    expect(attentionReasons(mustProject('app-bpfailfirst'))).toContain('deploy_failed');
  });

  it('reads a Blueprint target mid-deploy as in progress in the portfolio', () => {
    // The in-flight classification keys on `deploying` and `withdrawing`, so a
    // Blueprint rollout under way was neither in progress nor failed: the
    // portfolio reported the fleet as settled while it was still rolling out.
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-posture', 222, 1);
    tx.intentRevised({ applicationId: 'app-posture', intent: intent('int-posture', 'app-posture', 222), envelope: env('op-int-posture') });
    tx.blueprintDeployStarted({
      applicationId: 'app-posture', nodeId: 1, intentRevisionId: 'int-posture',
      rolloutCandidateId: null, envelope: env('op-posture'),
    });

    expect(postureOf(mustProject('app-posture'))).toBe('in_progress');
  });

  it('retires a recorded withdrawal failure once the node converges again', () => {
    // The reconciler retries a node it could not withdraw by deploying it, so
    // clearing only a deploy failure would leave a target that has since
    // converged reporting its old withdrawal as a standing failure for ever.
    const tx = GitOpsTransitions.getInstance();
    const store = GitOpsStore.getInstance();
    seedInline('app-wdfail', 223, 1);
    tx.intentRevised({ applicationId: 'app-wdfail', intent: intent('int-wdfail', 'app-wdfail', 223), envelope: env('op-int-wdfail') });
    tx.blueprintDeployStarted({
      applicationId: 'app-wdfail', nodeId: 1, intentRevisionId: 'int-wdfail',
      rolloutCandidateId: null, envelope: env('op-wdfail'),
    });
    tx.blueprintAckRecorded({
      applicationId: 'app-wdfail', nodeId: 1, intentRevisionId: 'int-wdfail',
      rolloutCandidateId: null, legacyAppliedRevision: null, envelope: env('op-wdfail-ack'),
    });
    tx.blueprintWithdrawStarted({
      applicationId: 'app-wdfail', nodeId: 1, intentRevisionId: 'int-wdfail', envelope: env('op-wdfail-wd'),
    });
    tx.blueprintWithdrawFailed({
      applicationId: 'app-wdfail', nodeId: 1, failureClass: 'post_mutation', envelope: env('op-wdfail-wd'),
    });
    expect(store.getTarget('app-wdfail', 1)!.failure_stage).toBe('blueprint_withdraw');

    tx.blueprintDeployStarted({
      applicationId: 'app-wdfail', nodeId: 1, intentRevisionId: 'int-wdfail',
      rolloutCandidateId: null, envelope: env('op-wdfail-again'),
    });
    tx.blueprintAckRecorded({
      applicationId: 'app-wdfail', nodeId: 1, intentRevisionId: 'int-wdfail',
      rolloutCandidateId: null, legacyAppliedRevision: null, envelope: env('op-wdfail-again-ack'),
    });

    expect(store.getTarget('app-wdfail', 1)!.failure_stage).toBeNull();
    expect(attentionReasons(mustProject('app-wdfail'))).not.toContain('deploy_failed');
  });

  it('freezes an Inline revision once: mints generation and set, binds null targets, then no-ops', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-freeze', 320, 1);
    tx.intentRevised({
      applicationId: 'app-freeze',
      intent: intent('int-freeze', 'app-freeze', 320),
      envelope: env('op-int-freeze'),
    });
    tx.blueprintDeployStarted({
      applicationId: 'app-freeze',
      nodeId: 1,
      intentRevisionId: 'int-freeze',
      rolloutCandidateId: null,
      envelope: env('op-dep-freeze'),
    });
    tx.blueprintAckRecorded({
      applicationId: 'app-freeze',
      nodeId: 1,
      intentRevisionId: 'int-freeze',
      rolloutCandidateId: null,
      legacyAppliedRevision: 1,
      envelope: env('op-ack-freeze'),
    });
    expect(store.getTarget('app-freeze', 1)?.desired_generation_id).toBeNull();

    const generationId = 'gen-freeze-1';
    const artifactSetId = 'art-freeze-1';
    const first = tx.inlineRevisionFrozen({
      applicationId: 'app-freeze',
      generation: inlineGeneration(generationId, 'app-freeze', 'c'.repeat(64)),
      artifactSetId,
      envelope: env('op-freeze-1'),
    });
    expect(first.replayed).toBe(false);
    const app = store.getApplication('app-freeze')!;
    expect(app.accepted_generation_id).toBe(generationId);
    expect(app.artifact_set_id).toBe(artifactSetId);
    expect(store.getArtifactSet(artifactSetId)?.qualification).toBe('unresolved');
    const target = store.getTarget('app-freeze', 1)!;
    expect(target.desired_generation_id).toBe(generationId);
    expect(target.expected_artifact_set_id).toBe(artifactSetId);

    const second = tx.inlineRevisionFrozen({
      applicationId: 'app-freeze',
      generation: inlineGeneration('gen-freeze-2', 'app-freeze', 'd'.repeat(64)),
      artifactSetId: 'art-freeze-2',
      envelope: env('op-freeze-2'),
    });
    expect(second.replayed).toBe(true);
    expect(store.getApplication('app-freeze')?.accepted_generation_id).toBe(generationId);
    expect(store.getApplication('app-freeze')?.artifact_set_id).toBe(artifactSetId);
    expect(store.getGeneration('gen-freeze-2')).toBeUndefined();
  });

  it('clears Inline freeze pointers on a new intent so the next deploy can re-freeze', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-freeze-revise', 322, 1);
    tx.intentRevised({
      applicationId: 'app-freeze-revise',
      intent: intent('int-freeze-r1', 'app-freeze-revise', 322),
      envelope: env('op-int-r1'),
    });
    tx.blueprintDeployStarted({
      applicationId: 'app-freeze-revise',
      nodeId: 1,
      intentRevisionId: 'int-freeze-r1',
      rolloutCandidateId: null,
      envelope: env('op-dep-r1'),
    });
    tx.blueprintAckRecorded({
      applicationId: 'app-freeze-revise',
      nodeId: 1,
      intentRevisionId: 'int-freeze-r1',
      rolloutCandidateId: null,
      legacyAppliedRevision: 1,
      envelope: env('op-ack-r1'),
    });
    tx.inlineRevisionFrozen({
      applicationId: 'app-freeze-revise',
      generation: inlineGeneration('gen-freeze-r1', 'app-freeze-revise', 'c'.repeat(64)),
      artifactSetId: 'art-freeze-r1',
      envelope: env('op-freeze-r1'),
    });
    expect(store.getApplication('app-freeze-revise')?.accepted_generation_id).toBe('gen-freeze-r1');
    expect(store.getTarget('app-freeze-revise', 1)?.expected_artifact_set_id).toBe('art-freeze-r1');

    tx.intentRevised({
      applicationId: 'app-freeze-revise',
      intent: intent('int-freeze-r2', 'app-freeze-revise', 322),
      envelope: env('op-int-r2'),
    });
    const cleared = store.getApplication('app-freeze-revise')!;
    expect(cleared.accepted_generation_id).toBeNull();
    expect(cleared.artifact_set_id).toBeNull();
    expect(store.getTarget('app-freeze-revise', 1)?.expected_artifact_set_id).toBeNull();

    const again = tx.inlineRevisionFrozen({
      applicationId: 'app-freeze-revise',
      generation: inlineGeneration('gen-freeze-r2', 'app-freeze-revise', 'd'.repeat(64)),
      artifactSetId: 'art-freeze-r2',
      envelope: env('op-freeze-r2'),
    });
    expect(again.replayed).toBe(false);
    expect(store.getApplication('app-freeze-revise')?.accepted_generation_id).toBe('gen-freeze-r2');
    expect(store.getApplication('app-freeze-revise')?.artifact_set_id).toBe('art-freeze-r2');
  });

  it('refuses an Inline freeze whose artifact set does not belong to the generation', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedInline('app-freeze-ptr', 321, 1);
    store.insertGeneration(inlineGeneration('gen-other', 'app-freeze-ptr', 'e'.repeat(64)));
    store.insertArtifactSet({
      id: 'art-other-gen',
      generation_id: 'gen-other',
      evidence_version: 1,
      authoritative: 0,
      qualification: 'unresolved',
      evidence_json: JSON.stringify({ kind: 'unresolved' }),
      created_at: 1,
    });
    // Pre-seed a target desired pointer at a different generation so binding
    // the freeze set would violate assertArtifactPointer.
    store.upsertTarget({
      ...emptyTargetRow('app-freeze-ptr', 1, 1),
      desired_generation_id: 'gen-other',
    });

    expect(() => tx.inlineRevisionFrozen({
      applicationId: 'app-freeze-ptr',
      generation: inlineGeneration('gen-freeze-ptr', 'app-freeze-ptr', 'f'.repeat(64)),
      artifactSetId: 'art-freeze-ptr',
      envelope: env('op-freeze-ptr'),
    })).toThrow(/desired generation does not match/);
  });
});

function inlineGeneration(
  id: string,
  applicationId: string,
  materializationFingerprint: string,
): import('../services/gitops/types').GitOpsGenerationRow {
  return {
    id,
    application_id: applicationId,
    commit_sha: materializationFingerprint.slice(0, 40),
    repo_url: `inline://blueprint/${applicationId}`,
    configured_ref: 'inline',
    resolved_ref_kind: null,
    repo_identity_json: JSON.stringify({ host: 'inline', pathname: `/blueprint/${applicationId}` }),
    manifest_version: 1,
    candidate_dir: `generations/inline-${id}`,
    applied_dir: `generations/inline-${id}-applied`,
    expected_invocation_json: '{}',
    materialization_fingerprint: materializationFingerprint,
    validation_ok: 1,
    plan_blocked: 0,
    change_plan_fingerprint: null,
    operation_id: `op-${id}`,
    trigger: 'manual',
    actor: 'tester',
    previous_generation_id: null,
    redacted_limitations_json: '[]',
    portable_manifest_json: null,
    compose_inputs_json: null,
    source_policy_evidence_json: null,
    security_policy_evidence_json: null,
    support_requirements_json: null,
    compatibility_requirements_json: null,
    secret_capability_json: null,
    created_at: 1,
  };
}

function runtimeStatusOf(applicationId: string): string | undefined {
  return mustProject(applicationId).targets[0]?.runtime.status;
}

function mustProject(applicationId: string): Extract<GitOpsRevisionProjection, { applicationId: string }> {
  const projection = projectApplication(applicationId, false);
  if (projection.targetMode === 'not_applicable') throw new Error('expected application');
  return projection;
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
    configured_source_stack_name: null,
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
    review_block_reason: null,
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
    latest_preflight_evidence_json: null,
    latest_operation_id: null,
    active_operation_id: null,
    active_operation_stage: null,
    active_operation_at: null,
    active_generation_id: null,
    pause_at: null,
    pause_reason: null,
    source_suspended_reason: null,
    source_policy: 'manual',
    placement_policy: DEFAULT_PLACEMENT_POLICY,
    rollout_authorization_policy: DEFAULT_ROLLOUT_AUTHORIZATION_POLICY,
        placement_policy_refusal_reason: null,
        placement_policy_refused_at: null,
    poll_interval_secs: null,
    next_poll_at: null,
    attempt_seq: 0,
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
