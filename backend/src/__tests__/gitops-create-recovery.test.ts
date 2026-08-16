/**
 * Boot-time settlement of creates that a previous process left in flight.
 *
 * Each case seeds the durable state a crash would have left at one phase, runs
 * the recovery the startup sweep runs, and asserts the outcome: finish the
 * create only when its project is already on disk, tear it down only after its
 * files are gone, and never touch a source row that outlived the application.
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions, type EventEnvelope } from '../services/gitops/transitions';
import { resolveInterruptedCreates } from '../services/gitops/createRecovery';
import { candidateRelPathForSha } from '../services/gitops/createStagingMarker';
import { stackManagedRoot } from '../services/gitops/directApplication';
import type {
  GitOpsApplicationRow,
  GitOpsCreateCheckpointRow,
  GitOpsGenerationRow,
} from '../services/gitops/types';

const SHA = 'feed1234';

describe('gitops interrupted create recovery', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  beforeEach(() => {
    const db = DatabaseService.getInstance().getDb();
    db.prepare('DELETE FROM gitops_create_checkpoints').run();
    db.prepare('DELETE FROM gitops_history').run();
    db.prepare('DELETE FROM gitops_target_current').run();
    db.prepare('DELETE FROM gitops_generations').run();
    db.prepare('DELETE FROM gitops_applications').run();
  });

  it('tears down a create that stopped before the stack existed', async () => {
    const store = GitOpsStore.getInstance();
    seedCreate('app-pre', 'pre-stack-web', 'pre_stack');
    const managedRoot = stackManagedRoot('pre-stack-web');
    fs.mkdirSync(path.join(managedRoot, candidateRelPathForSha(SHA)), { recursive: true });

    const settled = await resolveInterruptedCreates();

    expect(settled).toEqual([
      { stackName: 'pre-stack-web', applicationId: 'app-pre', outcome: 'tombstoned' },
    ]);
    expect(store.getApplication('app-pre')?.lifecycle_status).toBe('deleted');
    expect(store.getCreateCheckpoint('app-pre')).toBeUndefined();
    expect(store.getLiveDirectApplication('pre-stack-web')).toBeUndefined();
    expect(fs.existsSync(managedRoot)).toBe(false);
  });

  it('removes the stack directory a crashed create had already made', async () => {
    seedCreate('app-mid', 'mid-web', 'stack_created');
    const composeDir = process.env.COMPOSE_DIR!;
    fs.mkdirSync(path.join(composeDir, 'mid-web'), { recursive: true });
    fs.writeFileSync(path.join(composeDir, 'mid-web', 'compose.yaml'), 'services: {}\n');

    const settled = await resolveInterruptedCreates();

    expect(settled[0].outcome).toBe('tombstoned');
    expect(fs.existsSync(path.join(composeDir, 'mid-web'))).toBe(false);
  });

  it('preserves a managed root the create did not create', async () => {
    seedCreate('app-shared', 'shared-web', 'pre_stack', { createdManagedRoot: 0 });
    const managedRoot = stackManagedRoot('shared-web');
    const sentinel = path.join(managedRoot, 'generations', 'applied-earlier');
    fs.mkdirSync(sentinel, { recursive: true });
    fs.mkdirSync(path.join(managedRoot, candidateRelPathForSha(SHA)), { recursive: true });

    await resolveInterruptedCreates();

    expect(fs.existsSync(sentinel)).toBe(true);
    expect(fs.existsSync(path.join(managedRoot, candidateRelPathForSha(SHA)))).toBe(false);
  });

  it('finishes a create whose manifest was already committed on disk', async () => {
    const store = GitOpsStore.getInstance();
    const db = DatabaseService.getInstance();
    seedCreate('app-finish', 'finish-web', 'manifest_committed');
    const composeDir = process.env.COMPOSE_DIR!;
    fs.mkdirSync(path.join(composeDir, 'finish-web'), { recursive: true });

    const settled = await resolveInterruptedCreates();

    expect(settled[0].outcome).toBe('completed');
    const app = store.getApplication('app-finish')!;
    expect(app.lifecycle_status).toBe('active');
    expect(app.accepted_generation_id).toBe('gen-app-finish');
    expect(app.source_acceptance_ref).not.toBeNull();
    expect(store.getTarget('app-finish', 1)?.applied_generation_id).toBe('gen-app-finish');
    expect(db.getGitSource('finish-web')?.last_applied_commit_sha).toBe(SHA);
    expect(store.getCreateCheckpoint('app-finish')).toBeUndefined();
  });

  it('clears the checkpoint of a create that already reached its boundary', async () => {
    const store = GitOpsStore.getInstance();
    seedCreate('app-done', 'done-web', 'pointers_committed');
    DatabaseService.getInstance().getDb().prepare(
      "UPDATE gitops_applications SET lifecycle_status = 'active' WHERE id = 'app-done'",
    ).run();

    const settled = await resolveInterruptedCreates();

    expect(settled[0].outcome).toBe('checkpoint_cleared');
    expect(store.getApplication('app-done')?.lifecycle_status).toBe('active');
    expect(store.getCreateCheckpoint('app-done')).toBeUndefined();
  });

  it('tombstones a creating application with no checkpoint and keeps its source row', async () => {
    const store = GitOpsStore.getInstance();
    const db = DatabaseService.getInstance();
    seedCreate('app-orphan', 'orphan-web', 'pre_stack');
    store.deleteCreateCheckpoint('app-orphan');
    db.upsertGitSource({
      stack_name: 'orphan-web',
      repo_url: 'https://github.com/org/repo.git',
      branch: 'main',
      compose_path: 'compose.yml',
      compose_paths: ['compose.yml'],
      context_dir: null,
      sync_env: false,
      env_path: null,
      auth_type: 'none',
      encrypted_token: null,
      auto_apply_on_webhook: false,
      auto_deploy_on_apply: false,
      last_applied_commit_sha: SHA,
      last_applied_content_hash: null,
      pending_commit_sha: null,
      pending_compose_content: null,
      pending_env_content: null,
      pending_fetched_at: null,
      last_debounce_at: null,
    });

    const settled = await resolveInterruptedCreates();

    expect(settled).toEqual([
      { stackName: 'orphan-web', applicationId: 'app-orphan', outcome: 'source_preserved' },
    ]);
    expect(store.getApplication('app-orphan')?.lifecycle_status).toBe('deleted');
    expect(db.getGitSource('orphan-web')).toBeTruthy();
    expect(store.getLiveDirectApplication('orphan-web')).toBeUndefined();
  });

  it('is idempotent across repeated boots', async () => {
    seedCreate('app-replay', 'replay-web', 'pre_stack');
    const first = await resolveInterruptedCreates();
    const second = await resolveInterruptedCreates();
    expect(first[0].outcome).toBe('tombstoned');
    expect(second).toEqual([]);
  });
});

function seedCreate(
  applicationId: string,
  stackName: string,
  phase: GitOpsCreateCheckpointRow['phase'],
  options: { createdManagedRoot?: number } = {},
): void {
  const store = GitOpsStore.getInstance();
  const generationId = `gen-${applicationId}`;
  GitOpsTransitions.getInstance().activateCreateFromGit({
    application: creatingApp(applicationId, stackName),
    nodeId: 1,
    commitSha: SHA,
    generation: gen(generationId, applicationId),
    checkpoint: {
      application_id: applicationId,
      stack_name: stackName,
      phase: 'pre_stack',
      generation_id: null,
      operation_id: `op-${applicationId}`,
      repo_url: 'https://github.com/org/repo.git',
      branch: 'main',
      compose_path: 'compose.yml',
      compose_paths_json: '["compose.yml"]',
      context_dir: null,
      sync_env: 0,
      env_path: null,
      auth_type: 'none',
      encrypted_token: null,
      auto_apply_on_webhook: 0,
      auto_deploy_on_apply: 0,
      commit_sha: SHA,
      applied_spec_json: null,
      created_managed_root: options.createdManagedRoot ?? 1,
      created_at: 1,
      updated_at: 1,
    },
    envelope: envelope(`op-${applicationId}`),
  });
  if (phase !== 'pre_stack') {
    store.updateCreateCheckpoint(applicationId, { phase }, Date.now());
  }
}

function envelope(operationId: string): EventEnvelope {
  return { operationId, actor: 'tester', trigger: 'manual', at: Date.now() };
}

function creatingApp(id: string, stackName: string): GitOpsApplicationRow {
  return {
    id,
    lifecycle_key: `direct:${stackName}`,
    lifecycle_status: 'creating',
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
    commit_sha: SHA,
    repo_url: 'https://github.com/org/repo.git',
    configured_ref: 'main',
    repo_identity_json: '{"host":"github.com","pathname":"/org/repo.git"}',
    manifest_version: 1,
    candidate_dir: candidateRelPathForSha(SHA),
    applied_dir: `generations/applied-${SHA}-1`,
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
