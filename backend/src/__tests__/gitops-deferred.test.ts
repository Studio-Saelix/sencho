/**
 * Deferred-state events: retry, suspend, pause, and partial rollout.
 *
 * These have no production writer by design; later tickets emit them. They are
 * implemented and tested now so the deriver has no branch a writer cannot
 * reach, and so the shape a future producer must satisfy is pinned rather than
 * inferred from the deriver.
 *
 * The rule they all share is that none of them is a statement about health. A
 * suspended source, a paused rollout, and a partial rollout each leave every
 * success pointer exactly where it was.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions, type EventEnvelope } from '../services/gitops/transitions';
import { projectApplication } from '../services/gitops/derive';
import type { GitOpsApplicationRow, GitOpsGenerationRow } from '../services/gitops/types';

describe('gitops deferred state', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('schedules a retry without hiding the failure that caused it', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-retry', 'retry-web');
    tx.fetchStarted('app-retry', env('op-retry-f'));
    tx.fetchFailed('app-retry', env('op-retry-f'));

    tx.sourceRetryScheduled('app-retry', 5_000, 2, env('op-retry-s'));

    const app = store.getApplication('app-retry')!;
    expect(app.retry_at).toBe(5_000);
    expect(app.retry_count).toBe(2);
    // A retry is a plan, not a resolution: a stack that keeps failing must not
    // read as merely busy.
    expect(app.failure_stage).toBe('fetch');
    expect(projectOf('app-retry').facets.source.status).toBe('source_failed');

    // Starting the retry clears the schedule and keeps the count.
    tx.fetchStarted('app-retry', env('op-retry-f2'));
    expect(store.getApplication('app-retry')?.retry_at).toBeNull();
    expect(store.getApplication('app-retry')?.retry_count).toBe(2);
  });

  it('suspends a source without forgetting what it had accepted', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-susp', 'susp-web');
    const accepted = store.getApplication('app-susp')!.accepted_generation_id;

    tx.sourceSuspended('app-susp', 'operator paused sync', env('op-susp'));

    const app = store.getApplication('app-susp')!;
    expect(app.suspended_at).not.toBeNull();
    expect(app.accepted_generation_id).toBe(accepted);
    const sourceFacet = projectOf('app-susp').facets.source;
    expect(sourceFacet.status).toBe('source_suspended');
    if (sourceFacet.status === 'source_suspended') {
      expect(sourceFacet.suspendedReason).toBe('operator paused sync');
    }
    // A suspended source refuses new work rather than queueing it.
    expect(() => tx.fetchStarted('app-susp', env('op-susp-f'))).toThrow(/suspended/);

    tx.sourceUnsuspended('app-susp', env('op-unsusp'));
    expect(store.getApplication('app-susp')?.suspended_at).toBeNull();
    expect(projectOf('app-susp').facets.source.status).toBe('application_generation_accepted');
  });

  it('interrupts an operation in flight when the source is suspended', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-susp2', 'susp2-web');
    tx.fetchStarted('app-susp2', env('op-susp2-f'));

    tx.sourceSuspended('app-susp2', 'operator paused sync', env('op-susp2'));

    const app = store.getApplication('app-susp2')!;
    // Abandoning the operation without recording it would leave the source
    // reporting a fetch in flight that nothing will ever finish.
    expect(app.active_operation_stage).toBeNull();
    expect(app.interruption_stage).toBe('fetch_started');
    expect(app.suspended_at).not.toBeNull();
  });

  it('keeps a source-suspension reason independent of an application-wide rollout pause reason', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-susp3', 'susp3-web');

    tx.sourceSuspended('app-susp3', 'operator paused sync', env('op-susp3'));
    // A later, unrelated application-wide rollout pause must not clobber the
    // suspension reason: the two events share the application row but not
    // its reason field.
    tx.rolloutPaused('app-susp3', null, 'awaiting approval', env('op-pause3'));

    const app = store.getApplication('app-susp3')!;
    expect(app.source_suspended_reason).toBe('operator paused sync');
    expect(app.pause_reason).toBe('awaiting approval');

    tx.sourceUnsuspended('app-susp3', env('op-unsusp3'));
    expect(store.getApplication('app-susp3')?.source_suspended_reason).toBeNull();
    // Unsuspending the source must not touch the unrelated rollout pause.
    expect(store.getApplication('app-susp3')?.pause_reason).toBe('awaiting approval');
  });

  it('pauses a rollout without claiming anything about health', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-pause', 'pause-web');
    tx.deployStarted('app-pause', 1, 'gen-app-pause', env('op-pause-d'));
    tx.deployBound('app-pause', 1, 'gen-app-pause', env('op-pause-d'));

    tx.rolloutPaused('app-pause', 1, 'awaiting approval', env('op-pause'));

    const target = store.getTarget('app-pause', 1)!;
    expect(target.pause_at).not.toBeNull();
    // What was deployed is still deployed.
    expect(target.deployed_generation_id).toBe('gen-app-pause');
    expect(projectOf('app-pause').targets[0]?.runtime.status).toBe('paused');

    tx.rolloutUnpaused('app-pause', 1, env('op-unpause'));
    expect(store.getTarget('app-pause', 1)?.pause_at).toBeNull();
    expect(projectOf('app-pause').targets[0]?.runtime.status).not.toBe('paused');
  });

  it('records a partial rollout without inventing a deployed pointer', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-partial', 'partial-web');

    tx.partiallyRolledOut('app-partial', 1, '{"reached":[1],"pending":[2]}', env('op-partial'));

    const target = store.getTarget('app-partial', 1)!;
    expect(target.partial_json).toBe('{"reached":[1],"pending":[2]}');
    expect(target.deployed_generation_id).toBeNull();
    expect(projectOf('app-partial').targets[0]?.runtime.status).toBe('partially_rolled_out');

    tx.partialCleared('app-partial', 1, env('op-partial-clear'));
    expect(store.getTarget('app-partial', 1)?.partial_json).toBeNull();
  });

  it('refuses partial state that is not decodable', () => {
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-partial-bad', 'partial-bad-web');
    expect(() => tx.partiallyRolledOut('app-partial-bad', 1, 'not json', env('op-partial-bad')))
      .toThrow();
  });

  it('reports a rollback in flight on both the application and the target', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-start', 'rb-start-web');
    const generationId = 'gen-app-rb-start';

    tx.rollbackInProgress({
      applicationId: 'app-rb-start',
      nodeId: 1,
      recoveryRef: 'rb-1',
      recoveryGenerationId: generationId,
      envelope: env('op-rb-start'),
    });

    const target = store.getTarget('app-rb-start', 1)!;
    expect(target.recovery_phase).toBe('restoring');
    expect(target.recovery_ref).toBe('rb-1');
    expect(target.recovery_generation_id).toBe(generationId);
    // Written to both, because a target-only write left the source facet
    // reporting whatever the source last did instead of the rollback.
    expect(store.getApplication('app-rb-start')?.recovery_phase).toBe('restoring');
    expect(projectOf('app-rb-start').facets.rollout.status).toBe('rollback_in_progress');
  });

  it('persists the failure class a partial rollback was given', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-partial', 'rb-partial-web');
    const applied = store.getTarget('app-rb-partial', 1)!.applied_generation_id;

    tx.rollbackPartialFailed({
      applicationId: 'app-rb-partial',
      nodeId: 1,
      recoveryRef: 'rb-2',
      failureClass: 'partial',
      envelope: env('op-rb-partial'),
    });

    const target = store.getTarget('app-rb-partial', 1)!;
    expect(target.recovery_phase).toBe('failed');
    expect(target.failure_stage).toBe('recovery');
    // Reported verbatim: the deriver reads these columns rather than inventing
    // a class, and `partial` is the one this alias adds over a recovery.
    expect(target.failure_class).toBe('partial');
    // A failed rollback moves no success pointer.
    expect(target.applied_generation_id).toBe(applied);
    expect(target.healthy_generation_id).toBeNull();
  });

  it('completes a rollback only against a generation it can prove', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-done', 'rb-done-web');
    const generationId = 'gen-app-rb-done';

    // Nothing bound yet, so there is no generation to complete against.
    expect(() => tx.rollbackCompleted({
      applicationId: 'app-rb-done',
      nodeId: 1,
      recoveryRef: 'rb-3',
      capturedArtifactSetId: null,
      capturedSourceAcceptanceRef: null,
      envelope: env('op-rb-done-early'),
    })).toThrow(/bound recovery generation/);

    tx.rollbackInProgress({
      applicationId: 'app-rb-done',
      nodeId: 1,
      recoveryRef: 'rb-3',
      recoveryGenerationId: generationId,
      envelope: env('op-rb-done-start'),
    });
    tx.rollbackCompleted({
      applicationId: 'app-rb-done',
      nodeId: 1,
      recoveryRef: 'rb-3',
      capturedArtifactSetId: null,
      capturedSourceAcceptanceRef: null,
      envelope: env('op-rb-done'),
    });

    const target = store.getTarget('app-rb-done', 1)!;
    expect(target.recovery_phase).toBe('complete');
    expect(target.desired_generation_id).toBe(generationId);
    expect(target.applied_generation_id).toBe(generationId);
    // The workload is back but nothing has observed it yet.
    expect(target.healthy_generation_id).toBeNull();
  });

  it('refuses to complete a rollback onto another application generation', () => {
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-rb-foreign', 'rb-foreign-web');
    seedApplied('app-rb-owner', 'rb-owner-web');

    tx.rollbackInProgress({
      applicationId: 'app-rb-foreign',
      nodeId: 1,
      recoveryRef: 'rb-4',
      recoveryGenerationId: 'gen-app-rb-owner',
      envelope: env('op-rb-foreign-start'),
    });

    expect(() => tx.rollbackCompleted({
      applicationId: 'app-rb-foreign',
      nodeId: 1,
      recoveryRef: 'rb-4',
      capturedArtifactSetId: null,
      capturedSourceAcceptanceRef: null,
      envelope: env('op-rb-foreign'),
    })).toThrow(/does not own/);
  });
});

function projectOf(applicationId: string) {
  const projection = projectApplication(applicationId, true);
  if (projection.targetMode === 'not_applicable') throw new Error('expected an application');
  return projection;
}

function seedApplied(applicationId: string, stackName: string): void {
  const store = GitOpsStore.getInstance();
  const tx = GitOpsTransitions.getInstance();
  const generationId = `gen-${applicationId}`;
  tx.activateDirect({ application: app(applicationId, stackName), nodeId: 1, envelope: env(`op-act-${applicationId}`) });
  store.insertGeneration(gen(generationId, applicationId));
  tx.fetchStarted(applicationId, env(`op-f-${applicationId}`));
  tx.fetched(applicationId, 'abc123', env(`op-f-${applicationId}`));
  tx.candidateReady(applicationId, generationId, false, env(`op-c-${applicationId}`));
  tx.applied({
    applicationId,
    generationId,
    artifactSetId: `art-${applicationId}`,
    sourceAcceptanceId: `acc-${applicationId}`,
    authority: 'operator',
    envelope: env(`op-a-${applicationId}`),
  });
}

function env(operationId: string): EventEnvelope {
  return { operationId, actor: 'tester', trigger: 'manual', at: Date.now() };
}

function app(id: string, stackName: string): GitOpsApplicationRow {
  return {
    id,
    lifecycle_key: `direct:${stackName}`,
    lifecycle_status: 'active',
    target_mode: 'direct',
    stack_name: stackName,
    blueprint_id: null,
    configured_repo_url: 'https://github.com/org/repo.git',
    repo_identity_json: '{"host":"github.com","pathname":"/org/repo.git"}',
    configured_ref: 'main',
    compose_paths_json: '["compose.yml"]',
    context_dir: null,
    sync_env: 0,
    env_path: null,
    materialization_fingerprint: 'a'.repeat(64),
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
    source_suspended_reason: null,
    source_policy: 'manual',
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

function gen(id: string, applicationId: string): GitOpsGenerationRow {
  return {
    id,
    application_id: applicationId,
    commit_sha: 'abc123',
    repo_url: 'https://github.com/org/repo.git',
    resolved_ref_kind: 'branch',
    configured_ref: 'main',
    repo_identity_json: '{"host":"github.com","pathname":"/org/repo.git"}',
    manifest_version: 0,
    candidate_dir: `generations/candidate-${id}`,
    applied_dir: `generations/applied-${id}-0`,
    expected_invocation_json: '{"composeFileOrder":[],"projectName":null,"projectDirectory":null,"envFileOrder":[]}',
    materialization_fingerprint: 'a'.repeat(64),
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
    created_at: 1,
  };
}
