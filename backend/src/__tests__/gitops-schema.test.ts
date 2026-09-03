import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { isHubOnlyPath } from '../helpers/proxyExemptPaths';
import { GitOpsStore, emptyTargetRow } from '../services/gitops/store';
import { encodeArtifactEvidenceJson } from '../services/gitops/json';
import type { GitOpsApplicationRow, GitOpsGenerationRow } from '../services/gitops/types';

describe('gitops schema', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('creates gitops tables, recovery columns, and the schema version', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance().getDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'gitops_%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      'gitops_applications',
      'gitops_approvals',
      'gitops_artifact_sets',
      'gitops_create_checkpoints',
      'gitops_generations',
      'gitops_history',
      'gitops_intent_revisions',
      'gitops_migration_checkpoints',
      'gitops_rollout_candidates',
      'gitops_target_current',
    ]);
    const version = db.prepare(
      "SELECT value FROM global_settings WHERE key = 'gitops_schema_version'",
    ).get() as { value: string };
    expect(version.value).toBe('1');
    const recoveryCols = new Set(
      (db.pragma('table_info(stack_update_recovery_generations)') as Array<{ name: string }>).map((c) => c.name),
    );
    expect(recoveryCols.has('gitops_generation_id')).toBe(true);
    expect(recoveryCols.has('gitops_artifact_set_id')).toBe(true);
    expect(recoveryCols.has('gitops_source_acceptance_ref')).toBe(true);
    expect(recoveryCols.has('desired_target_generation_id')).toBe(false);
    const appCols = new Set(
      (db.pragma('table_info(gitops_applications)') as Array<{ name: string }>).map((c) => c.name),
    );
    expect(appCols.has('desired_target_generation_id')).toBe(false);
    expect(appCols.has('desired_commit_sha')).toBe(true);
    const targetCols = new Set(
      (db.pragma('table_info(gitops_target_current)') as Array<{ name: string }>).map((c) => c.name),
    );
    expect(targetCols.has('desired_generation_id')).toBe(true);
    expect(targetCols.has('candidate_generation_id')).toBe(true);
    expect(targetCols.has('lkg_artifact_set_id')).toBe(true);
    expect(targetCols.has('lkg_unavailable_at')).toBe(true);
    expect(targetCols.has('lkg_unavailable_reason')).toBe(true);
    const candidateCols = new Set(
      (db.pragma('table_info(gitops_rollout_candidates)') as Array<{ name: string }>).map((c) => c.name),
    );
    expect(candidateCols.has('source_acceptance_ref')).toBe(false);
    expect(candidateCols.has('placement_approval_ref')).toBe(false);
    expect(candidateCols.has('preflight_fingerprint')).toBe(false);
  });

  it('accepts recovery health triggers and keeps deployed_generation_id', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    db.insertHealthGateRun({
      id: 'rec-1',
      node_id: 1,
      stack_name: 'web',
      trigger_action: 'recovery',
      status: 'observing',
      reason: null,
      window_seconds: 90,
      containers_json: '[]',
      started_at: 1,
      ended_at: null,
      created_by: 'tester',
      target_scope: 'stack',
      service_name: null,
      failure_source: null,
      deployed_generation_id: 'gen-a',
    });
    const row = db.getHealthGateRun(1, 'web', 'rec-1');
    expect(row?.trigger_action).toBe('recovery');
    expect(row?.deployed_generation_id).toBe('gen-a');
  });

  it('rejects invalid target recovery phases and LKG mismatches', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance().getDb();
    const store = GitOpsStore.getInstance();
    store.insertApplication(directApp('app-lkg', 'lkg-web'));
    store.upsertTarget(emptyTargetRow('app-lkg', 1, 1));
    expect(() => {
      db.prepare("UPDATE gitops_target_current SET recovery_phase = 'armed' WHERE application_id = 'app-lkg'").run();
    }).toThrow();
    expect(() => {
      store.upsertTarget({
        ...emptyTargetRow('app-lkg', 1, 2),
        lkg_generation_id: 'gen-missing',
        lkg_artifact_set_id: 'art-missing',
      });
    }).toThrow(/lkg_artifact_set_id/);
  });

  it('enforces one live Blueprint application across both Blueprint modes', async () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(inlineApp('bp-inline', 7));
    expect(store.assertNoLiveBlueprintApplication(7).ok).toBe(false);
    expect(() => store.insertApplication(blueprintApp('bp-git', 7))).toThrow();
    const { DatabaseService } = await import('../services/DatabaseService');
    DatabaseService.getInstance().getDb().prepare(
      "UPDATE gitops_applications SET lifecycle_status = 'detached' WHERE id = 'bp-inline'",
    ).run();
    store.insertApplication(blueprintApp('bp-git', 7));
    expect(store.getApplication('bp-git')?.target_mode).toBe('blueprint');
  });

  it('round-trips recovery GitOps columns as null on legacy-shaped inserts', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    db.insertStackUpdateRecoveryGeneration({
      id: 'recov-1',
      node_id: 1,
      stack_name: 'web',
      status: 'candidate',
      phase: 'captured',
      is_current: 1,
      backup_slot_id: null,
      content_path: null,
      operation_kind: null,
      override_path: null,
      services_json: '[]',
      health_gate_id: null,
      gate_retain_until: null,
      artifact_expires_at: null,
      operation_lease_expires_at: null,
      created_at: 1,
      updated_at: 1,
      created_by: 'tester',
      artifacts_retired: 0,
      released_at: null,
      released_by: null,
    });
    const row = db.getStackUpdateRecoveryGeneration('recov-1');
    expect(row?.gitops_generation_id ?? null).toBeNull();
    expect(row?.gitops_artifact_set_id ?? null).toBeNull();
    expect(row?.gitops_source_acceptance_ref ?? null).toBeNull();
    db.insertStackUpdateRecoveryGeneration({
      id: 'recov-2',
      node_id: 1,
      stack_name: 'web',
      status: 'candidate',
      phase: 'captured',
      is_current: 0,
      backup_slot_id: null,
      content_path: null,
      operation_kind: null,
      override_path: null,
      services_json: '[]',
      health_gate_id: null,
      gate_retain_until: null,
      artifact_expires_at: null,
      operation_lease_expires_at: null,
      created_at: 2,
      updated_at: 2,
      created_by: 'tester',
      artifacts_retired: 0,
      released_at: null,
      released_by: null,
      gitops_generation_id: 'gen-a',
      gitops_artifact_set_id: 'art-a',
      gitops_source_acceptance_ref: 'acc-a',
    });
    const bound = db.getStackUpdateRecoveryGeneration('recov-2');
    expect(bound?.gitops_generation_id).toBe('gen-a');
    expect(bound?.gitops_artifact_set_id).toBe('art-a');
    expect(bound?.gitops_source_acceptance_ref).toBe('acc-a');
  });

  it('enforces one live Direct application per stack and frees the name on tombstone', async () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(directApp('dup-first', 'dup-web'));
    expect(() => store.insertApplication(directApp('dup-second', 'dup-web'))).toThrow();
    const { DatabaseService } = await import('../services/DatabaseService');
    DatabaseService.getInstance().getDb().prepare(
      "UPDATE gitops_applications SET lifecycle_status = 'deleted' WHERE id = 'dup-first'",
    ).run();
    store.insertApplication(directApp('dup-second', 'dup-web'));
    expect(store.getApplication('dup-second')?.stack_name).toBe('dup-web');
  });

  it('keeps blueprints and node-labels hub-only and git-sources proxyable', () => {
    expect(isHubOnlyPath('/api/blueprints')).toBe(true);
    expect(isHubOnlyPath('/api/blueprints/1')).toBe(true);
    expect(isHubOnlyPath('/api/node-labels')).toBe(true);
    expect(isHubOnlyPath('/api/node-labels/1')).toBe(true);
    expect(isHubOnlyPath('/api/git-sources')).toBe(false);
    expect(isHubOnlyPath('/api/gitops/history')).toBe(false);
  });

  it('inserts unresolved artifact evidence without advancing authority', () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(directApp('app-art', 'art-web'));
    store.insertGeneration(generation('gen-art', 'app-art'));
    store.insertArtifactSet({
      id: 'art-1',
      generation_id: 'gen-art',
      evidence_version: 1,
      authoritative: 0,
      qualification: 'unresolved',
      evidence_json: encodeArtifactEvidenceJson({ kind: 'unresolved' }),
      created_at: 1,
    });
    expect(store.getArtifactSet('art-1')?.qualification).toBe('unresolved');
  });

  it('round-trips resolved_ref_kind for a tag-resolved generation', async () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(directApp('app-tag', 'tag-web'));
    const { DatabaseService } = await import('../services/DatabaseService');
    const raw = DatabaseService.getInstance().getDb();
    raw.prepare("UPDATE gitops_applications SET configured_ref = 'v1' WHERE id = 'app-tag'").run();
    store.insertGeneration({
      ...generation('gen-tag', 'app-tag'),
      commit_sha: 'abc123',
      configured_ref: 'v1',
      resolved_ref_kind: 'tag',
    });
    const row = store.getGeneration('gen-tag');
    expect(row?.resolved_ref_kind).toBe('tag');
    expect(row?.configured_ref).toBe('v1');
  });

  it('round-trips the portable generation contract fields, defaulting to null for legacy rows', async () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(directApp('app-portable', 'portable-web'));
    store.insertGeneration({
      ...generation('gen-portable-legacy', 'app-portable'),
    });
    const legacy = store.getGeneration('gen-portable-legacy');
    expect(legacy?.portable_manifest_json).toBeNull();
    expect(legacy?.compose_inputs_json).toBeNull();
    expect(legacy?.source_policy_evidence_json).toBeNull();
    expect(legacy?.security_policy_evidence_json).toBeNull();
    expect(legacy?.support_requirements_json).toBeNull();
    expect(legacy?.compatibility_requirements_json).toBeNull();

    store.insertGeneration({
      ...generation('gen-portable-new', 'app-portable'),
      portable_manifest_json: '{"files":[]}',
      compose_inputs_json: '{"composeFileOrder":["compose.yaml"]}',
      source_policy_evidence_json: '{"policy":"manual"}',
      security_policy_evidence_json: '{"status":"allowed"}',
      support_requirements_json: '{}',
      compatibility_requirements_json: '{}',
    });
    const populated = store.getGeneration('gen-portable-new');
    expect(populated?.portable_manifest_json).toBe('{"files":[]}');
    expect(populated?.compose_inputs_json).toBe('{"composeFileOrder":["compose.yaml"]}');
    expect(populated?.source_policy_evidence_json).toBe('{"policy":"manual"}');
  });

  it('defaults controller-owned columns to manual, off, and zero on a fresh application', async () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(directApp('app-ctrl', 'ctrl-web'));
    const app = store.getApplication('app-ctrl');
    expect(app?.source_policy).toBe('manual');
    expect(app?.poll_interval_secs).toBeNull();
    expect(app?.next_poll_at).toBeNull();
    expect(app?.attempt_seq).toBe(0);
  });

  it('round-trips a configured poll interval and policy', async () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication({
      ...directApp('app-ctrl2', 'ctrl2-web'),
      source_policy: 'automatic',
      poll_interval_secs: 120,
      next_poll_at: 5000,
      attempt_seq: 3,
    });
    const app = store.getApplication('app-ctrl2');
    expect(app?.source_policy).toBe('automatic');
    expect(app?.poll_interval_secs).toBe(120);
    expect(app?.next_poll_at).toBe(5000);
    expect(app?.attempt_seq).toBe(3);
  });

  it('round-trips fetched_resolved_ref_kind on application fetch transitions', async () => {
    const store = GitOpsStore.getInstance();
    store.insertApplication(directApp('app-fetch-kind', 'fetch-web'));
    const { GitOpsTransitions } = await import('../services/gitops/transitions');
    const tx = GitOpsTransitions.getInstance();
    const env = { operationId: 'op-fetch-kind', actor: 'tester', trigger: 'manual', at: Date.now() };
    tx.fetchStarted('app-fetch-kind', env);
    tx.fetched('app-fetch-kind', 'abc123', env, 'tag');
    const app = store.getApplication('app-fetch-kind');
    expect(app?.fetched_commit_sha).toBe('abc123');
    expect(app?.fetched_resolved_ref_kind).toBe('tag');
  });
});

function directApp(id: string, stackName: string): GitOpsApplicationRow {
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

function inlineApp(id: string, blueprintId: number): GitOpsApplicationRow {
  return {
    ...directApp(id, 'unused'),
    lifecycle_key: `blueprint:${blueprintId}`,
    target_mode: 'inline_blueprint',
    stack_name: null,
    blueprint_id: blueprintId,
    configured_repo_url: null,
    repo_identity_json: null,
    configured_ref: null,
    compose_paths_json: null,
    materialization_fingerprint: null,
  };
}

function blueprintApp(id: string, blueprintId: number): GitOpsApplicationRow {
  return {
    ...directApp(id, 'unused'),
    lifecycle_key: `blueprint:${blueprintId}`,
    target_mode: 'blueprint',
    stack_name: null,
    blueprint_id: blueprintId,
    configured_repo_url: 'https://github.com/org/repo.git',
  };
}

function generation(id: string, applicationId: string): GitOpsGenerationRow {
  return {
    id,
    application_id: applicationId,
    commit_sha: 'abc123',
    repo_url: 'https://github.com/org/repo.git',
    resolved_ref_kind: 'branch',
    configured_ref: 'main',
    repo_identity_json: '{"host":"github.com","pathname":"/org/repo.git"}',
    manifest_version: 0,
    candidate_dir: 'generations/candidate-abc123',
    applied_dir: 'generations/applied-abc123-0',
    expected_invocation_json: '{"composeFileOrder":["compose.yml"],"projectName":null,"projectDirectory":null,"envFileOrder":[]}',
    materialization_fingerprint: 'a'.repeat(64),
    validation_ok: 1,
    plan_blocked: 0,
    change_plan_fingerprint: null,
    operation_id: 'op-1',
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
