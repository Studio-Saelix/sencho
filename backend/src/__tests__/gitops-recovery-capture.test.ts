import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { captureGitOpsRecoveryBinding } from '../services/gitops/recoveryCapture';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions, type EventEnvelope } from '../services/gitops/transitions';
import type { GitOpsApplicationRow, GitOpsGenerationRow } from '../services/gitops/types';

describe('gitops recovery capture', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('returns nulls when no live Direct application exists', () => {
    expect(captureGitOpsRecoveryBinding('missing-stack', 1)).toEqual({
      gitops_generation_id: null,
      gitops_artifact_set_id: null,
      gitops_source_acceptance_ref: null,
    });
  });

  it('captures deployed generation and generation-bound source acceptance', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-cap', 'cap-web'), nodeId: 1, envelope: env('op-act') });
    store.insertGeneration(gen('gen-cap', 'app-cap'));
    tx.fetchStarted('app-cap', env('op-f'));
    tx.fetched('app-cap', 'abc123', env('op-f'));
    tx.candidateReady('app-cap', 'gen-cap', false, env('op-c'));
    tx.applied({
      applicationId: 'app-cap',
      generationId: 'gen-cap',
      artifactSetId: 'art-cap',
      sourceAcceptanceId: 'acc-cap',
      authority: 'operator',
      envelope: env('op-a'),
    });
    const target = store.getTarget('app-cap', 1)!;
    store.upsertTarget({ ...target, deployed_generation_id: 'gen-cap' });
    expect(captureGitOpsRecoveryBinding('cap-web', 1)).toEqual({
      gitops_generation_id: 'gen-cap',
      gitops_artifact_set_id: 'art-cap',
      gitops_source_acceptance_ref: 'acc-cap',
    });
  });

  it('does not capture a newer generation acceptance for an older deployed generation', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-old', 'old-web'), nodeId: 1, envelope: env('op-act-2') });
    store.insertGeneration(gen('gen-old', 'app-old'));
    store.insertGeneration(gen('gen-new', 'app-old'));
    tx.fetchStarted('app-old', env('op-f2'));
    tx.fetched('app-old', 'abc123', env('op-f2'));
    tx.candidateReady('app-old', 'gen-old', false, env('op-c2'));
    tx.applied({
      applicationId: 'app-old',
      generationId: 'gen-old',
      artifactSetId: 'art-old',
      sourceAcceptanceId: 'acc-old',
      authority: 'operator',
      envelope: env('op-a2'),
    });
    store.insertApproval({
      id: 'acc-new',
      kind: 'source_acceptance',
      authority: 'operator',
      authoritative: 1,
      application_id: 'app-old',
      generation_id: 'gen-new',
      intent_revision_id: null,
      artifact_set_id: null,
      rollout_candidate_id: null,
      rollout_generation_id: null,
      source_acceptance_ref: null,
      placement_approval_ref: null,
      required_targets_json: null,
      preflight_fingerprint: null,
      fingerprint: null,
      blast_json: null,
      policy_provenance_json: null,
      actor: 'tester',
      created_at: 9,
    });
    const target = store.getTarget('app-old', 1)!;
    store.upsertTarget({
      ...target,
      deployed_generation_id: 'gen-old',
      source_acceptance_ref: 'acc-new',
    });
    const captured = captureGitOpsRecoveryBinding('old-web', 1);
    expect(captured.gitops_generation_id).toBe('gen-old');
    expect(captured.gitops_artifact_set_id).toBe('art-old');
    expect(captured.gitops_source_acceptance_ref).toBe('acc-old');
  });
});

function env(operationId: string): EventEnvelope {
  return { operationId, actor: 'tester', trigger: 'manual', at: 1 };
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
    commit_sha: id,
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
