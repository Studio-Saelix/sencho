import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { FACET_EVIDENCE_SOURCE } from '../services/gitops/types';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions, type EventEnvelope } from '../services/gitops/transitions';
import { projectApplication } from '../services/gitops/derive';
import type { GitOpsApplicationRow, GitOpsGenerationRow } from '../services/gitops/types';

describe('gitops derivation', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('registers every facet status exactly once', () => {
    expect(FACET_EVIDENCE_SOURCE.source.applying).toBe('current');
    expect(FACET_EVIDENCE_SOURCE.rollout.completion_unknown).toBe('current_or_future');
    expect(FACET_EVIDENCE_SOURCE.source.source_superseded).toBe('future');
    expect(FACET_EVIDENCE_SOURCE.runtime.rollout_artifact_drift).toBe('future');
    expect(FACET_EVIDENCE_SOURCE.lkg.none).toBe('current');
  });

  it('projects applying with no fetch/apply/dismiss actions', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-apply-facet', 'facet-web'), nodeId: 1, envelope: env('op-act') });
    store.insertGeneration(gen('gen-facet', 'app-apply-facet'));
    tx.fetchStarted('app-apply-facet', env('op-f'));
    tx.fetched('app-apply-facet', 'abc123', env('op-f'));
    tx.candidateReady('app-apply-facet', 'gen-facet', false, env('op-c'));
    tx.applyStarted('app-apply-facet', 'gen-facet', env('op-a'));
    const projection = projectApplication('app-apply-facet', false);
    expect(projection.targetMode).toBe('direct');
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.source.status).toBe('applying');
    expect(projection.availableActions).toEqual(['none']);
    expect(projection.targets[0]?.desiredGenerationId).toBeNull();
    expect(projection.targets[0]?.candidateGenerationId).toBe('gen-facet');
  });

  it('projects a freshly activated target as never applied and offers no deploy', () => {
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-idle', 'idle-web'), nodeId: 1, envelope: env('op-act-idle') });
    const projection = projectApplication('app-idle', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('never_applied');
    expect(projection.availableActions).not.toContain('deploy');
    expect(projection.availableActions).toContain('fetch');
  });

  it('keeps a never-applied target out of deploy actions when health gating is disabled', () => {
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-idle-nohealth', 'idle-nohealth-web'), nodeId: 1, envelope: env('op-act-idle-2') });
    const projection = projectApplication('app-idle-nohealth', true);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('never_applied');
    expect(projection.availableActions).not.toContain('deploy');
  });

  it('projects accepted application and applied-not-deployed after apply', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-done', 'done-web'), nodeId: 1, envelope: env('op-act-2') });
    store.insertGeneration(gen('gen-done', 'app-done'));
    tx.fetchStarted('app-done', env('op-f2'));
    tx.fetched('app-done', 'abc123', env('op-f2'));
    tx.candidateReady('app-done', 'gen-done', false, env('op-c2'));
    tx.applied({
      applicationId: 'app-done',
      generationId: 'gen-done',
      artifactSetId: 'art-done',
      sourceAcceptanceId: 'acc-done',
      authority: 'operator',
      envelope: env('op-a2'),
    });
    const projection = projectApplication('app-done', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.facets.source.status).toBe('application_generation_accepted');
    expect(projection.facets.artifact.status).toBe('artifact_resolution_pending');
    expect(projection.facets.placement.status).toBe('unbound_direct');
    expect(projection.targets[0]?.runtime.status).toBe('applied_not_deployed');
    expect(projection.targets[0]?.lkg.status).toBe('none');
    expect(projection.availableActions).toContain('deploy');
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
