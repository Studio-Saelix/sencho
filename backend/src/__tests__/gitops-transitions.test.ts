import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { encodeArtifactEvidenceJson } from '../services/gitops/json';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions, type EventEnvelope } from '../services/gitops/transitions';
import { projectApplication } from '../services/gitops/derive';
import type { GitOpsApplicationRow, GitOpsGenerationRow } from '../services/gitops/types';

describe('gitops transitions', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('binds desired+applied and source acceptance on Direct apply', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    const env = envelope('op-apply');
    tx.activateDirect({ application: app('app-apply', 'apply-web'), nodeId: 1, envelope: env });
    store.insertGeneration(gen('gen-apply', 'app-apply'));
    tx.fetchStarted('app-apply', envelope('op-fetch'));
    tx.fetched('app-apply', 'deadbeef', envelope('op-fetch'));
    tx.candidateReady('app-apply', 'gen-apply', false, envelope('op-cand'));
    tx.applyStarted('app-apply', 'gen-apply', envelope('op-apply'));
    tx.applied({
      applicationId: 'app-apply',
      generationId: 'gen-apply',
      artifactSetId: 'art-apply',
      sourceAcceptanceId: 'acc-apply',
      authority: 'operator',
      envelope: env,
    });
    const application = store.getApplication('app-apply')!;
    const target = store.getTarget('app-apply', 1)!;
    expect(application.accepted_generation_id).toBe('gen-apply');
    expect(application.source_acceptance_ref).toBe('acc-apply');
    expect(target.desired_generation_id).toBe('gen-apply');
    expect(target.applied_generation_id).toBe('gen-apply');
    expect(target.candidate_generation_id).toBeNull();
    expect(target.source_acceptance_ref).toBe('acc-apply');
    expect(target.expected_artifact_set_id).toBe('art-apply');
    expect(store.resolveApprovalRef('acc-apply', {
      kind: 'source_acceptance',
      applicationId: 'app-apply',
      generationId: 'gen-apply',
    })?.authoritative).toBe(1);
    expect(() => tx.applied({
      applicationId: 'app-apply',
      generationId: 'gen-other',
      artifactSetId: 'art-x',
      sourceAcceptanceId: 'acc-x',
      authority: 'operator',
      envelope: envelope('op-apply-2'),
    })).toThrow(/not the current candidate/);
  });

  it('advances expected only on first exact after unaccepted rows', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-art', 'art-web', 'gen-art', 'art-v1', 'acc-art');
    tx.recordArtifactEvidence({
      applicationId: 'app-art',
      generationId: 'gen-art',
      artifactSetId: 'art-v2',
      evidenceVersion: 2,
      qualification: 'unavailable',
      evidenceJson: encodeArtifactEvidenceJson({ kind: 'unavailable' }),
      authoritative: 0,
      envelope: envelope('op-art-2'),
    });
    tx.recordArtifactEvidence({
      applicationId: 'app-art',
      generationId: 'gen-art',
      artifactSetId: 'art-v3',
      evidenceVersion: 3,
      qualification: 'exact',
      evidenceJson: encodeArtifactEvidenceJson({ kind: 'exact', identity: 'sha256:aaa' }),
      authoritative: 0,
      envelope: envelope('op-art-3'),
    });
    const application = store.getApplication('app-art')!;
    expect(application.artifact_set_id).toBe('art-v3');
    expect(application.latest_artifact_set_id).toBe('art-v3');
    tx.recordArtifactEvidence({
      applicationId: 'app-art',
      generationId: 'gen-art',
      artifactSetId: 'art-v4',
      evidenceVersion: 4,
      qualification: 'stale',
      evidenceJson: encodeArtifactEvidenceJson({ kind: 'stale', identity: 'sha256:aaa' }),
      authoritative: 0,
      envelope: envelope('op-art-4'),
    });
    expect(store.getApplication('app-art')?.artifact_set_id).toBe('art-v3');
    expect(store.getApplication('app-art')?.latest_artifact_set_id).toBe('art-v4');
    tx.recordArtifactEvidence({
      applicationId: 'app-art',
      generationId: 'gen-art',
      artifactSetId: 'art-v5',
      evidenceVersion: 5,
      qualification: 'exact',
      evidenceJson: encodeArtifactEvidenceJson({ kind: 'exact', identity: 'sha256:bbb' }),
      authoritative: 0,
      envelope: envelope('op-art-5'),
    });
    expect(store.getApplication('app-art')?.artifact_set_id).toBe('art-v3');
    expect(store.getApplication('app-art')?.latest_artifact_set_id).toBe('art-v5');
    expect(store.getTarget('app-art', 1)?.expected_artifact_set_id).toBe('art-v3');
    expect(store.getTarget('app-art', 1)?.latest_artifact_set_id).toBe('art-v5');
  });

  it('clears fetch failure on successful fetch and keeps accepted pointers', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-fail', 'fail-web', 'gen-fail', 'art-fail', 'acc-fail');
    tx.fetchStarted('app-fail', envelope('op-fail'));
    tx.fetchFailed('app-fail', envelope('op-fail'));
    expect(store.getApplication('app-fail')?.failure_stage).toBe('fetch');
    expect(store.getApplication('app-fail')?.accepted_generation_id).toBe('gen-fail');
    tx.fetchStarted('app-fail', envelope('op-fail-2'));
    tx.fetched('app-fail', 'cafebabe', envelope('op-fail-2'));
    const application = store.getApplication('app-fail')!;
    expect(application.failure_stage).toBeNull();
    expect(application.desired_commit_sha).toBe('cafebabe');
    expect(application.accepted_generation_id).toBe('gen-fail');
    expect(store.getTarget('app-fail', 1)?.applied_generation_id).toBe('gen-fail');
  });

  it('rejects a candidate whose fingerprint no longer matches configuration', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-fp', 'fp-web'), nodeId: 1, envelope: envelope('op-act-fp') });
    store.insertGeneration(gen('gen-fp', 'app-fp'));
    DatabaseService.getInstance().getDb().prepare(
      "UPDATE gitops_applications SET materialization_fingerprint = ? WHERE id = 'app-fp'",
    ).run('b'.repeat(64));
    expect(() => tx.candidateReady('app-fp', 'gen-fp', false, envelope('op-c-fp'))).toThrow(/fingerprint/);
    DatabaseService.getInstance().getDb().prepare(
      "UPDATE gitops_applications SET materialization_fingerprint = ? WHERE id = 'app-fp'",
    ).run('a'.repeat(64));
    tx.fetchStarted('app-fp', envelope('op-f-fp'));
    tx.fetched('app-fp', 'abc123', envelope('op-f-fp'));
    tx.candidateReady('app-fp', 'gen-fp', false, envelope('op-c-fp2'));
    DatabaseService.getInstance().getDb().prepare(
      "UPDATE gitops_applications SET materialization_fingerprint = ? WHERE id = 'app-fp'",
    ).run('c'.repeat(64));
    expect(() => tx.applyStarted('app-fp', 'gen-fp', envelope('op-a-fp'))).toThrow(/fingerprint/);
  });

  it('refuses to replace the candidate while an apply is in flight', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-race', 'race-web'), nodeId: 1, envelope: envelope('op-act-race') });
    store.insertGeneration(gen('gen-race-a', 'app-race'));
    store.insertGeneration(gen('gen-race-b', 'app-race'));
    tx.fetchStarted('app-race', envelope('op-f-race'));
    tx.fetched('app-race', 'abc123', envelope('op-f-race'));
    tx.candidateReady('app-race', 'gen-race-a', false, envelope('op-c-race-a'));
    tx.applyStarted('app-race', 'gen-race-a', envelope('op-a-race'));
    expect(() => tx.candidateReady('app-race', 'gen-race-b', false, envelope('op-c-race-b')))
      .toThrow(/apply is in flight/);
    expect(store.getApplication('app-race')?.candidate_generation_id).toBe('gen-race-a');
    tx.applied({
      applicationId: 'app-race',
      generationId: 'gen-race-a',
      artifactSetId: 'art-race',
      sourceAcceptanceId: 'acc-race',
      authority: 'operator',
      envelope: envelope('op-a-race'),
    });
    expect(store.getApplication('app-race')?.accepted_generation_id).toBe('gen-race-a');
  });

  it('rejects re-accepting a generation that is already accepted', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    seedApplied('app-reapply', 'reapply-web', 'gen-reapply', 'art-reapply', 'acc-reapply');
    tx.candidateReady('app-reapply', 'gen-reapply', false, envelope('op-c-reapply-2'));
    expect(() => tx.applied({
      applicationId: 'app-reapply',
      generationId: 'gen-reapply',
      artifactSetId: 'art-reapply-2',
      sourceAcceptanceId: 'acc-reapply-2',
      authority: 'operator',
      envelope: envelope('op-a-reapply-2'),
    })).toThrow(/already accepted/);
    expect(store.getArtifactSet('art-reapply-2')).toBeUndefined();
  });

  it('surfaces an invalid stored observation as a limitation instead of a clean unknown', () => {
    const store = GitOpsStore.getInstance();
    seedApplied('app-obs', 'obs-web', 'gen-obs', 'art-obs', 'acc-obs');
    DatabaseService.getInstance().getDb().prepare(
      "UPDATE gitops_target_current SET observed_artifact_identity_json = ? WHERE application_id = 'app-obs'",
    ).run('{"kind":"nonsense"}');
    const projection = mustProject('app-obs');
    expect(projection.limitations.map((l) => l.code)).toContain('artifact_observation_invalid');
    expect(store.getTarget('app-obs', 1)?.observed_artifact_identity_json).toBe('{"kind":"nonsense"}');
  });

  it('rejects terminal events with no matching operation', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-guard', 'guard-web'), nodeId: 1, envelope: envelope('op-act-guard') });
    store.insertGeneration(gen('gen-guard', 'app-guard'));
    expect(() => tx.applyFailed('app-guard', 'apply', envelope('op-g1')))
      .toThrow(/no matching apply operation/);
    expect(() => tx.deployStarted('app-guard', 1, 'gen-guard', envelope('op-g2')))
      .toThrow(/not applied/);
    expect(() => tx.deployBound('app-guard', 1, 'gen-guard', envelope('op-g3')))
      .toThrow(/no matching deploy operation/);
    expect(store.getTarget('app-guard', 1)?.deployed_generation_id).toBeNull();
  });

  it('writes one history row per transition with the bound identity', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-hist', 'hist-web'), nodeId: 1, envelope: envelope('op-act-hist') });
    store.insertGeneration(gen('gen-hist', 'app-hist'));
    tx.fetchStarted('app-hist', envelope('op-f-hist'));
    tx.fetched('app-hist', 'abc123', envelope('op-f-hist'));
    tx.candidateReady('app-hist', 'gen-hist', false, envelope('op-c-hist'));
    const applied = tx.applied({
      applicationId: 'app-hist',
      generationId: 'gen-hist',
      artifactSetId: 'art-hist',
      sourceAcceptanceId: 'acc-hist',
      authority: 'operator',
      envelope: envelope('op-a-hist'),
    });
    expect(applied.replayed).toBe(false);
    expect(applied.historyIds).toHaveLength(1);
    const row = DatabaseService.getInstance().getDb().prepare(
      'SELECT stage, outcome, dedupe_target, generation_id, artifact_set_id, source_acceptance_ref, node_id FROM gitops_history WHERE id = ?',
    ).get(applied.historyIds[0]) as Record<string, unknown>;
    expect(row.stage).toBe('applied');
    expect(row.outcome).toBe('committed');
    expect(row.dedupe_target).toBe('app');
    expect(row.generation_id).toBe('gen-hist');
    expect(row.artifact_set_id).toBe('art-hist');
    expect(row.source_acceptance_ref).toBe('acc-hist');
    expect(row.node_id).toBeNull();
  });

  it('interrupts live apply and binds deploy after applied', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateDirect({ application: app('app-int', 'int-web'), nodeId: 1, envelope: envelope('op-act-int') });
    store.insertGeneration(gen('gen-int', 'app-int'));
    tx.fetchStarted('app-int', envelope('op-f-int'));
    tx.fetched('app-int', 'abc123', envelope('op-f-int'));
    tx.candidateReady('app-int', 'gen-int', false, envelope('op-c-int'));
    tx.applyStarted('app-int', 'gen-int', envelope('op-apply-live'));
    expect(mustProject('app-int').facets.source.status).toBe('applying');
    tx.interruptActiveOperations('app-int', envelope('op-boot'));
    expect(mustProject('app-int').facets.source.status).toBe('source_unknown');
    tx.applied({
      applicationId: 'app-int',
      generationId: 'gen-int',
      artifactSetId: 'art-int',
      sourceAcceptanceId: 'acc-int',
      authority: 'operator',
      envelope: envelope('op-a-int'),
    });
    tx.deployStarted('app-int', 1, 'gen-int', envelope('op-dep'));
    tx.deployBound('app-int', 1, 'gen-int', envelope('op-dep'));
    expect(store.getTarget('app-int', 1)?.deployed_generation_id).toBe('gen-int');
    expect(store.getTarget('app-int', 1)?.failure_stage).toBeNull();
  });
});

function mustProject(applicationId: string) {
  const projection = projectApplication(applicationId, false);
  if (projection.targetMode === 'not_applicable') throw new Error('expected application');
  return projection;
}

function seedApplied(
  applicationId: string,
  stackName: string,
  generationId: string,
  artifactSetId: string,
  sourceAcceptanceId: string,
): void {
  const store = GitOpsStore.getInstance();
  const tx = GitOpsTransitions.getInstance();
  tx.activateDirect({ application: app(applicationId, stackName), nodeId: 1, envelope: envelope(`op-act-${applicationId}`) });
  store.insertGeneration(gen(generationId, applicationId));
  tx.fetchStarted(applicationId, envelope(`op-f-${applicationId}`));
  tx.fetched(applicationId, 'abc123', envelope(`op-f-${applicationId}`));
  tx.candidateReady(applicationId, generationId, false, envelope(`op-c-${applicationId}`));
  tx.applied({
    applicationId,
    generationId,
    artifactSetId,
    sourceAcceptanceId,
    authority: 'operator',
    envelope: envelope(`op-a-${applicationId}`),
  });
}

function envelope(operationId: string): EventEnvelope {
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
