/**
 * Recovery pointer rules.
 *
 * A restore moves a target back to an older generation, which is the one case
 * where the target and its application legitimately disagree about what is
 * current. These tests pin what may move with it and what may not: the
 * expectation comes from what the recovery point captured, the acceptance must
 * still prove the restored generation, and a last-known-good survives unless
 * the generation behind it is genuinely gone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions, type EventEnvelope } from '../services/gitops/transitions';
import { projectApplication } from '../services/gitops/derive';
import type { GitOpsApplicationRow, GitOpsGenerationRow } from '../services/gitops/types';

describe('gitops recovery', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('marks the target as recovering before anything is restored', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedTwoGenerations('app-rec-start', 'rec-start-web');

    tx.recoveryStarted({
      applicationId: 'app-rec-start',
      nodeId: 1,
      recoveryRef: 'rec-1',
      recoveryGenerationId: 'gen-a-app-rec-start',
      envelope: env('op-rec-start'),
    });

    const target = store.getTarget('app-rec-start', 1)!;
    expect(target.recovery_phase).toBe('restoring');
    expect(target.recovery_ref).toBe('rec-1');
    expect(target.active_operation_stage).toBe('recovery_started');
    // Nothing has been restored, so nothing has moved.
    expect(target.desired_generation_id).toBe('gen-b-app-rec-start');
    expect(projectApplication('app-rec-start', true).targets[0]?.runtime.status).toBe('recovery_required');
  });

  it('moves the target back to the restored generation while the application stays ahead', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedTwoGenerations('app-rec-ok', 'rec-ok-web');
    const genA = 'gen-a-app-rec-ok';

    tx.recoveryStarted({
      applicationId: 'app-rec-ok',
      nodeId: 1,
      recoveryRef: 'rec-ok',
      recoveryGenerationId: genA,
      envelope: env('op-rec-ok'),
    });
    tx.recoverySucceeded({
      applicationId: 'app-rec-ok',
      nodeId: 1,
      recoveryRef: 'rec-ok',
      recoveryGenerationId: genA,
      proven: true,
      gitopsBinding: 'bound',
      capturedArtifactSetId: 'art-a-app-rec-ok',
      capturedSourceAcceptanceRef: 'acc-a-app-rec-ok',
      envelope: env('op-rec-ok'),
    });

    const target = store.getTarget('app-rec-ok', 1)!;
    expect(target.desired_generation_id).toBe(genA);
    expect(target.applied_generation_id).toBe(genA);
    expect(target.deployed_generation_id).toBe(genA);
    // The restored workload has not been observed healthy yet.
    expect(target.healthy_generation_id).toBeNull();
    expect(target.recovery_phase).toBe('complete');
    // The expectation and the acceptance both describe the restored generation.
    expect(target.expected_artifact_set_id).toBe('art-a-app-rec-ok');
    expect(target.source_acceptance_ref).toBe('acc-a-app-rec-ok');
    // The application is still accepted at the newer generation.
    expect(store.getApplication('app-rec-ok')?.accepted_generation_id).toBe('gen-b-app-rec-ok');
    expect(store.getApplication('app-rec-ok')?.source_acceptance_ref).toBe('acc-b-app-rec-ok');
  });

  it('refuses to bind an acceptance that authorized a different generation', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedTwoGenerations('app-rec-xacc', 'rec-xacc-web');

    tx.recoveryStarted({
      applicationId: 'app-rec-xacc',
      nodeId: 1,
      recoveryRef: 'rec-xacc',
      recoveryGenerationId: 'gen-a-app-rec-xacc',
      envelope: env('op-rec-xacc'),
    });
    tx.recoverySucceeded({
      applicationId: 'app-rec-xacc',
      nodeId: 1,
      recoveryRef: 'rec-xacc',
      recoveryGenerationId: 'gen-a-app-rec-xacc',
      proven: true,
      gitopsBinding: 'bound',
      capturedArtifactSetId: 'art-b-app-rec-xacc',
      // The acceptance for B cannot vouch for A.
      capturedSourceAcceptanceRef: 'acc-b-app-rec-xacc',
      envelope: env('op-rec-xacc'),
    });

    const target = store.getTarget('app-rec-xacc', 1)!;
    expect(target.source_acceptance_ref).toBeNull();
    // Nor can B's artifact set describe A.
    expect(target.expected_artifact_set_id).toBeNull();
  });

  it('leaves every pointer alone when the restore cannot be proven', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedTwoGenerations('app-rec-unproven', 'rec-unproven-web');
    const beforeTarget = store.getTarget('app-rec-unproven', 1)!;

    tx.recoveryStarted({
      applicationId: 'app-rec-unproven',
      nodeId: 1,
      recoveryRef: 'rec-unproven',
      recoveryGenerationId: null,
      envelope: env('op-rec-unproven'),
    });
    tx.recoverySucceeded({
      applicationId: 'app-rec-unproven',
      nodeId: 1,
      recoveryRef: 'rec-unproven',
      recoveryGenerationId: null,
      proven: false,
      gitopsBinding: 'unbound',
      capturedArtifactSetId: null,
      capturedSourceAcceptanceRef: null,
      envelope: env('op-rec-unproven'),
    });

    const target = store.getTarget('app-rec-unproven', 1)!;
    expect(target.desired_generation_id).toBe(beforeTarget.desired_generation_id);
    expect(target.applied_generation_id).toBe(beforeTarget.applied_generation_id);
    expect(target.healthy_generation_id).toBe(beforeTarget.healthy_generation_id);
    expect(target.recovery_phase).toBe('complete');
  });

  it('keeps a still-valid last-known-good and records why one is lost', () => {
    const store = GitOpsStore.getInstance();
    const db = DatabaseService.getInstance().getDb();

    // A last-known-good on the generation being restored survives intact.
    seedTwoGenerations('app-rec-lkg', 'rec-lkg-web');
    db.prepare(
      `UPDATE gitops_target_current
       SET lkg_generation_id = 'gen-a-app-rec-lkg', lkg_artifact_set_id = 'art-a-app-rec-lkg'
       WHERE application_id = 'app-rec-lkg'`,
    ).run();
    recover('app-rec-lkg', 'gen-a-app-rec-lkg', 'art-a-app-rec-lkg', 'acc-a-app-rec-lkg');
    let target = store.getTarget('app-rec-lkg', 1)!;
    expect(target.lkg_generation_id).toBe('gen-a-app-rec-lkg');
    expect(target.lkg_artifact_set_id).toBe('art-a-app-rec-lkg');
    expect(target.lkg_unavailable_at).toBeNull();

    // A last-known-good whose generation is gone becomes explicitly
    // unavailable, which is a different statement from never having had one.
    seedTwoGenerations('app-rec-lkg-gone', 'rec-lkg-gone-web');
    db.prepare(
      `UPDATE gitops_target_current
       SET lkg_generation_id = 'gen-vanished', lkg_artifact_set_id = NULL
       WHERE application_id = 'app-rec-lkg-gone'`,
    ).run();
    recover('app-rec-lkg-gone', 'gen-a-app-rec-lkg-gone', 'art-a-app-rec-lkg-gone', 'acc-a-app-rec-lkg-gone');
    target = store.getTarget('app-rec-lkg-gone', 1)!;
    expect(target.lkg_generation_id).toBeNull();
    expect(target.lkg_unavailable_reason).toBe('generation_missing');
    expect(projectApplication('app-rec-lkg-gone', true).targets[0]?.lkg.status).toBe('unavailable');
  });

  it('says why it dropped a pointer it could not prove', () => {
    const tx = GitOpsTransitions.getInstance();
    seedTwoGenerations('app-rec-why', 'rec-why-web');

    tx.recoveryStarted({
      applicationId: 'app-rec-why',
      nodeId: 1,
      recoveryRef: 'rec-why',
      recoveryGenerationId: 'gen-a-app-rec-why',
      envelope: env('op-rec-why'),
    });
    tx.recoverySucceeded({
      applicationId: 'app-rec-why',
      nodeId: 1,
      recoveryRef: 'rec-why',
      recoveryGenerationId: 'gen-a-app-rec-why',
      proven: true,
      gitopsBinding: 'bound',
      // Both captured references belong to the other generation.
      capturedArtifactSetId: 'art-b-app-rec-why',
      capturedSourceAcceptanceRef: 'acc-b-app-rec-why',
      envelope: env('op-rec-why'),
    });

    // Without these the cleared pointers are indistinguishable from pointers
    // that never existed, and the target reads healthier than it is.
    const codes = projectApplication('app-rec-why', true).limitations.map((l) => l.code);
    expect(codes).toContain('artifact_expectation_unprovable');
    expect(codes).toContain('source_acceptance_unprovable');
  });

  it('flags an unproven restore so it cannot read as healthy', () => {
    const tx = GitOpsTransitions.getInstance();
    seedTwoGenerations('app-rec-flag', 'rec-flag-web');

    tx.recoveryStarted({
      applicationId: 'app-rec-flag',
      nodeId: 1,
      recoveryRef: 'rec-flag',
      recoveryGenerationId: null,
      envelope: env('op-rec-flag'),
    });
    tx.recoverySucceeded({
      applicationId: 'app-rec-flag',
      nodeId: 1,
      recoveryRef: 'rec-flag',
      recoveryGenerationId: null,
      proven: false,
      gitopsBinding: 'unbound',
      capturedArtifactSetId: null,
      capturedSourceAcceptanceRef: null,
      envelope: env('op-rec-flag'),
    });

    const codes = projectApplication('app-rec-flag', true).limitations.map((l) => l.code);
    expect(codes).toContain('recovery_unproven');
  });

  it('clears a limitation once the evidence is provable again', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedTwoGenerations('app-rec-clear', 'rec-clear-web');
    const genA = 'gen-a-app-rec-clear';

    const restore = (artifactSetId: string, acceptanceRef: string): void => {
      tx.recoveryStarted({
        applicationId: 'app-rec-clear',
        nodeId: 1,
        recoveryRef: 'rec-clear',
        recoveryGenerationId: genA,
        envelope: env(`op-rec-clear-${artifactSetId}`),
      });
      tx.recoverySucceeded({
        applicationId: 'app-rec-clear',
        nodeId: 1,
        recoveryRef: 'rec-clear',
        recoveryGenerationId: genA,
        proven: true,
        gitopsBinding: 'bound',
        capturedArtifactSetId: artifactSetId,
        capturedSourceAcceptanceRef: acceptanceRef,
        envelope: env(`op-rec-clear-${artifactSetId}`),
      });
    };

    restore('art-b-app-rec-clear', 'acc-b-app-rec-clear');
    expect(store.getTarget('app-rec-clear', 1)?.evidence_limitations_json).not.toBeNull();

    restore('art-a-app-rec-clear', 'acc-a-app-rec-clear');
    // A stale limitation is worse than none: it would keep reporting doubt
    // about evidence that is now proven.
    expect(store.getTarget('app-rec-clear', 1)?.evidence_limitations_json).toBeNull();
    expect(projectApplication('app-rec-clear', true).limitations).toHaveLength(0);
  });

  it('opens and closes a recovery from the restore path itself', async () => {
    const { StackUpdateRecoveryService } = await import('../services/StackUpdateRecoveryService');
    const store = GitOpsStore.getInstance();
    seedTwoGenerations('app-rec-wire', 'rec-wire-web');
    const genA = 'gen-a-app-rec-wire';

    // A recovery row bound to generation A, exactly as capture writes one.
    DatabaseService.getInstance().insertStackUpdateRecoveryGeneration({
      id: 'rec-wire-1',
      node_id: 1,
      stack_name: 'rec-wire-web',
      status: 'candidate',
      phase: 'captured',
      is_current: 0,
      operation_kind: 'update',
      content_path: null,
      backup_slot_id: null,
      services_json: '[]',
      override_path: null,
      health_gate_id: null,
      gate_retain_until: null,
      artifact_expires_at: null,
      operation_lease_expires_at: Date.now() + 60_000,
      created_at: Date.now(),
      updated_at: Date.now(),
      created_by: 'tester',
      artifacts_retired: 0,
      released_at: null,
      released_by: null,
      gitops_generation_id: genA,
      gitops_artifact_set_id: 'art-a-app-rec-wire',
      gitops_source_acceptance_ref: 'acc-a-app-rec-wire',
    });

    // The restore fails before touching files, which is the classification the
    // model has to get right: the previous workload is provably intact.
    await StackUpdateRecoveryService.getInstance().compensateWithCandidate(
      'rec-wire-1',
      async () => { throw new Error('compose unavailable'); },
    );

    const target = store.getTarget('app-rec-wire', 1)!;
    expect(target.recovery_phase).toBe('failed');
    expect(target.failure_stage).toBe('recovery');
    expect(target.failure_class).toBe('pre_mutation');
    expect(target.active_operation_stage).toBeNull();
    // The restore never completed, so nothing moved back to generation A.
    expect(target.desired_generation_id).toBe('gen-b-app-rec-wire');
    expect(projectApplication('app-rec-wire', true).targets[0]?.runtime.status).toBe('recovery_failed');
  });

  it('records a failed restore without moving success pointers', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedTwoGenerations('app-rec-fail', 'rec-fail-web');
    const before = store.getTarget('app-rec-fail', 1)!;

    tx.recoveryStarted({
      applicationId: 'app-rec-fail',
      nodeId: 1,
      recoveryRef: 'rec-fail',
      recoveryGenerationId: 'gen-a-app-rec-fail',
      envelope: env('op-rec-fail'),
    });
    tx.recoveryFailed({
      applicationId: 'app-rec-fail',
      nodeId: 1,
      recoveryRef: 'rec-fail',
      failureClass: 'post_mutation',
      envelope: env('op-rec-fail'),
    });

    const target = store.getTarget('app-rec-fail', 1)!;
    expect(target.recovery_phase).toBe('failed');
    expect(target.failure_stage).toBe('recovery');
    expect(target.failure_class).toBe('post_mutation');
    expect(target.desired_generation_id).toBe(before.desired_generation_id);
    expect(target.active_operation_stage).toBeNull();

    const projection = projectApplication('app-rec-fail', true);
    if (projection.targetMode === 'not_applicable') throw new Error('expected an application');
    expect(projection.targets[0]?.runtime.status).toBe('recovery_failed');
    expect(projection.facets.source.status).toBe('recovery_failed');
  });
});

function recover(
  applicationId: string,
  generationId: string,
  artifactSetId: string,
  acceptanceRef: string,
): void {
  const tx = GitOpsTransitions.getInstance();
  tx.recoveryStarted({
    applicationId,
    nodeId: 1,
    recoveryRef: `rec-${applicationId}`,
    recoveryGenerationId: generationId,
    envelope: env(`op-${applicationId}`),
  });
  tx.recoverySucceeded({
    applicationId,
    nodeId: 1,
    recoveryRef: `rec-${applicationId}`,
    recoveryGenerationId: generationId,
    proven: true,
    gitopsBinding: 'bound',
    capturedArtifactSetId: artifactSetId,
    capturedSourceAcceptanceRef: acceptanceRef,
    envelope: env(`op-${applicationId}`),
  });
}

/** Apply generation A, then B, so the target has something to fall back to. */
function seedTwoGenerations(applicationId: string, stackName: string): void {
  const store = GitOpsStore.getInstance();
  const tx = GitOpsTransitions.getInstance();
  tx.activateDirect({ application: app(applicationId, stackName), nodeId: 1, envelope: env(`op-act-${applicationId}`) });
  for (const label of ['a', 'b'] as const) {
    const generationId = `gen-${label}-${applicationId}`;
    store.insertGeneration(gen(generationId, applicationId));
    tx.fetchStarted(applicationId, env(`op-f-${label}-${applicationId}`));
    tx.fetched(applicationId, `sha-${label}`, env(`op-f-${label}-${applicationId}`));
    tx.candidateReady(applicationId, generationId, false, env(`op-c-${label}-${applicationId}`));
    tx.applied({
      applicationId,
      generationId,
      artifactSetId: `art-${label}-${applicationId}`,
      sourceAcceptanceId: `acc-${label}-${applicationId}`,
      authority: 'operator',
      envelope: env(`op-a-${label}-${applicationId}`),
    });
  }
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

function gen(id: string, applicationId: string): GitOpsGenerationRow {
  return {
    id,
    application_id: applicationId,
    commit_sha: 'abc123',
    repo_url: 'https://github.com/org/repo.git',
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
    created_at: 1,
  };
}
