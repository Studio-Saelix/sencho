/**
 * What the boot sweep does with a managed area no database row claims.
 *
 * The three staging-marker states drive three different actions, and the
 * difference between "missing" and "corrupt" is the whole rule: nothing ever
 * claimed a missing-marker area, so it is an ordinary orphan and is reaped,
 * while a corrupt marker is evidence of a claim we cannot read, so the area is
 * preserved. See docs/internal/adrs/2026-08-16-managed-area-orphan-reaping.md.
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { GitSourceService } from '../services/GitSourceService';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import { candidateRelPathForSha, stagingMarkerPath } from '../services/gitops/createStagingMarker';
import { stackManagedRoot } from '../services/gitops/directApplication';
import type { GitOpsApplicationRow, GitOpsCreateCheckpointRow } from '../services/gitops/types';

const SHA = 'beef5678';

describe('managed-area orphan sweep', () => {
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
    db.prepare('DELETE FROM gitops_target_current').run();
    db.prepare('DELETE FROM gitops_applications').run();
    db.prepare('DELETE FROM stack_git_sources').run();
  });

  function seedArea(stackName: string): { area: string; candidate: string; sentinel: string } {
    const area = stackManagedRoot(stackName);
    const candidate = path.join(area, candidateRelPathForSha(SHA));
    const sentinel = path.join(area, 'generations', 'applied-earlier');
    fs.mkdirSync(candidate, { recursive: true });
    fs.mkdirSync(sentinel, { recursive: true });
    return { area, candidate, sentinel };
  }

  it('reaps an area nothing has ever claimed', async () => {
    const { area } = seedArea('orphan-none');

    await GitSourceService.getInstance().sweepOrphans();

    expect(fs.existsSync(area)).toBe(false);
  });

  it('preserves an area whose marker cannot be read', async () => {
    const { area, sentinel } = seedArea('orphan-corrupt');
    fs.writeFileSync(stagingMarkerPath(area), '{ not json', 'utf8');

    await GitSourceService.getInstance().sweepOrphans();

    expect(fs.existsSync(sentinel)).toBe(true);
  });

  it('removes only the staged candidate when a valid marker claims the area', async () => {
    const { area, candidate, sentinel } = seedArea('orphan-marked');
    fs.writeFileSync(stagingMarkerPath(area), JSON.stringify({
      schemaVersion: 1,
      operationId: 'op-live',
      rootPreexisted: true,
      candidateRelPath: candidateRelPathForSha(SHA),
      createdAt: Date.now(),
    }), 'utf8');

    await GitSourceService.getInstance().sweepOrphans();

    expect(fs.existsSync(candidate)).toBe(false);
    expect(fs.existsSync(sentinel)).toBe(true);
  });

  it('leaves an area claimed by an in-flight create alone', async () => {
    const { area, candidate } = seedArea('orphan-inflight');
    GitOpsStore.getInstance().insertApplication(creatingApp('app-inflight', 'orphan-inflight'));
    GitOpsStore.getInstance().insertCreateCheckpoint(checkpoint('app-inflight', 'orphan-inflight'));

    await GitSourceService.getInstance().sweepOrphans();

    expect(fs.existsSync(area)).toBe(true);
    expect(fs.existsSync(candidate)).toBe(true);
  });
});

function checkpoint(applicationId: string, stackName: string): GitOpsCreateCheckpointRow {
  return {
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
    encrypted_deploy_key: null,
    ssh_known_hosts_entry: null,
    ssh_host_key_fingerprint: null,
            encrypted_ca_bundle: null,
    auto_apply_on_webhook: 0,
    auto_deploy_on_apply: 0,
    commit_sha: SHA,
    applied_spec_json: null,
    created_managed_root: 1,
    created_at: 1,
    updated_at: 1,
  };
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
