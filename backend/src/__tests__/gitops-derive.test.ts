import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { FACET_EVIDENCE_SOURCE } from '../services/gitops/types';
import { GitOpsStore, emptyTargetRow } from '../services/gitops/store';
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

  it('keeps a stale deployment deploy-pending instead of synced and healthy', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-stale-deploy', 'stale-deploy-web'), nodeId: 1, envelope: env('op-stale') });
    store.insertGeneration(gen('gen-a-stale', 'app-stale-deploy'));
    store.insertGeneration(gen('gen-b-stale', 'app-stale-deploy'));
    // Generation A is deployed and healthy; generation B is applied and
    // desired, with automatic deployment off so nothing moves it.
    const target = {
      ...emptyTargetRow('app-stale-deploy', 1, 1),
      desired_generation_id: 'gen-b-stale',
      applied_generation_id: 'gen-b-stale',
      deployed_generation_id: 'gen-a-stale',
      healthy_generation_id: 'gen-a-stale',
    };
    store.upsertTarget(target);

    let projection = projectApplication('app-stale-deploy', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('applied_not_deployed');
    expect(projection.targets[0]?.health.status).toBe('pending');
    expect(projection.availableActions).toContain('deploy');

    // Re-derived from the store rows rather than any carried-over state, so a
    // restart reads the same answer.
    expect(GitOpsStore.getInstance().getTarget('app-stale-deploy', 1)?.deployed_generation_id).toBe('gen-a-stale');
    projection = projectApplication('app-stale-deploy', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('applied_not_deployed');

    // Once the deploy lands the target awaits its own health run instead of
    // inheriting generation A's green verdict.
    store.upsertTarget({ ...target, deployed_generation_id: 'gen-b-stale' });
    projection = projectApplication('app-stale-deploy', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('fully_deployed_health_pending');
    expect(projection.targets[0]?.health.status).toBe('pending');

    // A passing run recorded against the desired generation answers for it
    // even while a different generation is deployed. No producer reaches this
    // combination today; the pin keeps any tightening of the comparison a
    // conscious decision rather than an accident.
    store.upsertTarget({ ...target, healthy_generation_id: 'gen-b-stale' });
    projection = projectApplication('app-stale-deploy', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('applied_not_deployed');
    expect(projection.targets[0]?.health.status).toBe('passed');
  });

  it('still judges a target with no desired id against its deployed pointer', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-null-desired', 'null-desired-web'), nodeId: 1, envelope: env('op-null') });
    store.insertGeneration(gen('gen-a-null', 'app-null-desired'));
    // Recovered and legacy rows can carry pointers with no desired id. The
    // deployed pointer stays their only basis to judge.
    store.upsertTarget({
      ...emptyTargetRow('app-null-desired', 1, 1),
      applied_generation_id: 'gen-a-null',
      deployed_generation_id: 'gen-a-null',
      healthy_generation_id: 'gen-a-null',
    });

    const projection = projectApplication('app-null-desired', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('synced_and_healthy');
    expect(projection.targets[0]?.health.status).toBe('passed');
  });

  it('emits the runtime drift item when a comparable observation disagrees', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-drift-item', 'drift-item-web'), nodeId: 1, envelope: env('op-drift') });
    store.insertGeneration(gen('gen-drift', 'app-drift-item'));
    store.insertArtifactSet({
      id: 'art-expected-drift',
      generation_id: 'gen-drift',
      evidence_version: 1,
      authoritative: 0,
      qualification: 'exact',
      evidence_json: JSON.stringify({ kind: 'exact', identity: 'sha256:wanted' }),
      created_at: 1,
    });
    store.upsertTarget({
      ...emptyTargetRow('app-drift-item', 1, 1),
      desired_generation_id: 'gen-drift',
      applied_generation_id: 'gen-drift',
      deployed_generation_id: 'gen-drift',
      expected_artifact_set_id: 'art-expected-drift',
      observed_artifact_identity_json: JSON.stringify({ kind: 'exact', identity: 'sha256:serving', observedAt: 42 }),
    });

    let projection = projectApplication('app-drift-item', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('runtime_artifact_drift');
    expect(projection.drift).toHaveLength(1);
    expect(projection.drift[0]).toEqual({
      class: 'runtime',
      expected: { kind: 'artifact_set', id: 'art-expected-drift', qualification: 'exact', evidenceVersion: 1 },
      observed: { kind: 'runtime_artifact', identity: 'sha256:serving', observedAt: 42 },
      freshnessAt: 42,
      owner: 'observed_artifact_identity',
      reason: 'the running workload reports an artifact identity other than the expected artifact set',
      configuredPolicy: null,
      affectedTargets: [{ nodeId: 1, stackName: 'drift-item-web' }],
      action: 'none',
    });

    // Equal comparable identities are not drift: the item disappears and the
    // chain continues to health instead of parking in verification pending.
    store.upsertTarget({
      ...emptyTargetRow('app-drift-item', 1, 1),
      desired_generation_id: 'gen-drift',
      applied_generation_id: 'gen-drift',
      deployed_generation_id: 'gen-drift',
      expected_artifact_set_id: 'art-expected-drift',
      observed_artifact_identity_json: JSON.stringify({ kind: 'qualified', identity: 'sha256:wanted', observedAt: 43 }),
    });
    projection = projectApplication('app-drift-item', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.drift).toHaveLength(0);

    // An observation that is not comparable never becomes a confirmed item.
    store.upsertTarget({
      ...emptyTargetRow('app-drift-item', 1, 1),
      desired_generation_id: 'gen-drift',
      applied_generation_id: 'gen-drift',
      deployed_generation_id: 'gen-drift',
      expected_artifact_set_id: 'art-expected-drift',
      observed_artifact_identity_json: JSON.stringify({ kind: 'stale', identity: 'sha256:serving', observedAt: 44 }),
    });
    projection = projectApplication('app-drift-item', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('artifact_verification_pending');
    expect(projection.drift).toHaveLength(0);

    // Ordering pin: a stale deployment outranks artifact verification. With
    // the desired generation applied but an older one deployed, the deploy
    // question comes first and no drift item is emitted for an observation
    // that describes the workload about to be replaced.
    store.insertGeneration(gen('gen-b-drift', 'app-drift-item'));
    store.upsertTarget({
      ...emptyTargetRow('app-drift-item', 1, 1),
      desired_generation_id: 'gen-drift',
      applied_generation_id: 'gen-drift',
      deployed_generation_id: 'gen-b-drift',
      healthy_generation_id: 'gen-b-drift',
      expected_artifact_set_id: 'art-expected-drift',
      observed_artifact_identity_json: JSON.stringify({ kind: 'exact', identity: 'sha256:serving', observedAt: 45 }),
    });
    projection = projectApplication('app-drift-item', false);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');
    expect(projection.targets[0]?.runtime.status).toBe('applied_not_deployed');
    expect(projection.drift).toHaveLength(0);
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
