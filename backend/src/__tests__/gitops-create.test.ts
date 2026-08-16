/**
 * Create-from-Git durability: the activation transaction, the teardown of a
 * create that never reached `applied`, and the staging marker plus
 * operation-owned cleanup that together decide what a crashed create is
 * allowed to delete.
 */
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions, type EventEnvelope } from '../services/gitops/transitions';
import {
  appliedRelPathFor,
  candidateRelPathForSha,
  deleteStagingMarker,
  readStagingMarker,
  stagingMarkerPath,
  writeStagingMarker,
  CreateStagingMarkerError,
} from '../services/gitops/createStagingMarker';
import { cleanupUnclaimedManagedRoot, removeOperationOwnedPaths } from '../services/gitops/createCleanup';
import type {
  GitOpsApplicationRow,
  GitOpsCreateCheckpointRow,
  GitOpsGenerationRow,
} from '../services/gitops/types';

const SHA = 'a1b2c3d4';

describe('gitops create-from-git', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('commits application, fetch, generation, checkpoint, and candidate in one transaction', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    const result = tx.activateCreateFromGit({
      application: creatingApp('app-create', 'create-web'),
      nodeId: 1,
      commitSha: SHA,
      generation: gen('gen-create', 'app-create'),
      checkpoint: checkpoint('app-create', 'create-web'),
      envelope: envelope('op-create'),
    });

    const app = store.getApplication('app-create')!;
    expect(app.lifecycle_status).toBe('creating');
    expect(app.desired_commit_sha).toBe(SHA);
    expect(app.fetched_commit_sha).toBe(SHA);
    expect(app.candidate_generation_id).toBe('gen-create');
    expect(app.accepted_generation_id).toBeNull();
    expect(app.source_acceptance_ref).toBeNull();

    const target = store.getTarget('app-create', 1)!;
    expect(target.candidate_generation_id).toBe('gen-create');
    expect(target.desired_generation_id).toBeNull();
    expect(target.applied_generation_id).toBeNull();

    expect(store.getCreateCheckpoint('app-create')?.generation_id).toBe('gen-create');
    expect(store.getCreateCheckpoint('app-create')?.phase).toBe('pre_stack');

    expect(result.historyIds).toHaveLength(3);
    const stages = DatabaseService.getInstance().getDb().prepare(
      'SELECT stage FROM gitops_history WHERE application_id = ? ORDER BY rowid ASC',
    ).all('app-create') as Array<{ stage: string }>;
    expect(stages.map((row) => row.stage)).toEqual(['application_activated', 'fetched', 'candidate_ready']);
  });

  it('refuses to persist a create whose candidate is blocked or stale', () => {
    const tx = GitOpsTransitions.getInstance();
    expect(() => tx.activateCreateFromGit({
      application: creatingApp('app-blocked', 'blocked-web'),
      nodeId: 1,
      commitSha: SHA,
      generation: { ...gen('gen-blocked', 'app-blocked'), plan_blocked: 1 },
      checkpoint: checkpoint('app-blocked', 'blocked-web'),
      envelope: envelope('op-blocked'),
    })).toThrow(/invalid or blocked candidate/);

    expect(() => tx.activateCreateFromGit({
      application: creatingApp('app-stale', 'stale-web'),
      nodeId: 1,
      commitSha: SHA,
      generation: { ...gen('gen-stale', 'app-stale'), materialization_fingerprint: 'b'.repeat(64) },
      checkpoint: checkpoint('app-stale', 'stale-web'),
      envelope: envelope('op-stale'),
    })).toThrow(/fingerprint/);

    expect(GitOpsStore.getInstance().getApplication('app-blocked')).toBeUndefined();
    expect(GitOpsStore.getInstance().getApplication('app-stale')).toBeUndefined();
  });

  it('activates the application only at applied, which is the success boundary', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateCreateFromGit({
      application: creatingApp('app-boundary', 'boundary-web'),
      nodeId: 1,
      commitSha: SHA,
      generation: gen('gen-boundary', 'app-boundary'),
      checkpoint: checkpoint('app-boundary', 'boundary-web'),
      envelope: envelope('op-boundary'),
    });
    expect(store.getApplication('app-boundary')?.lifecycle_status).toBe('creating');

    tx.applied({
      applicationId: 'app-boundary',
      generationId: 'gen-boundary',
      artifactSetId: 'art-boundary',
      sourceAcceptanceId: 'acc-boundary',
      authority: 'operator',
      envelope: envelope('op-boundary-applied'),
      activateCreating: true,
    });

    const app = store.getApplication('app-boundary')!;
    expect(app.lifecycle_status).toBe('active');
    expect(app.accepted_generation_id).toBe('gen-boundary');
    expect(store.getTarget('app-boundary', 1)?.applied_generation_id).toBe('gen-boundary');

    // After the success boundary the create can no longer be torn down.
    expect(() => tx.createFailed('app-boundary', 'post_boundary', envelope('op-boundary-fail')))
      .toThrow(/requires a creating application/);
    expect(store.getApplication('app-boundary')?.lifecycle_status).toBe('active');
  });

  it('tombstones a failed create, drops its checkpoint, and frees the stack name', () => {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    tx.activateCreateFromGit({
      application: creatingApp('app-fail', 'fail-web'),
      nodeId: 1,
      commitSha: SHA,
      generation: gen('gen-fail', 'app-fail'),
      checkpoint: checkpoint('app-fail', 'fail-web'),
      envelope: envelope('op-fail'),
    });
    tx.createFailed('app-fail', 'validation', envelope('op-fail'));

    const app = store.getApplication('app-fail')!;
    expect(app.lifecycle_status).toBe('deleted');
    expect(app.failure_stage).toBe('create');
    expect(app.failure_class).toBe('validation');
    expect(store.getCreateCheckpoint('app-fail')).toBeUndefined();
    expect(store.getTarget('app-fail', 1)?.target_status).toBe('tombstoned');
    expect(store.getLiveDirectApplication('fail-web')).toBeUndefined();

    // Retry is a brand new application id against the now-free stack name.
    tx.activateCreateFromGit({
      application: creatingApp('app-fail-retry', 'fail-web'),
      nodeId: 1,
      commitSha: SHA,
      generation: gen('gen-fail-retry', 'app-fail-retry'),
      checkpoint: checkpoint('app-fail-retry', 'fail-web'),
      envelope: envelope('op-fail-retry'),
    });
    expect(store.getLiveDirectApplication('fail-web')?.id).toBe('app-fail-retry');
  });
});

describe('gitops create staging marker', () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'sencho-marker-'));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function areaFor(name: string): string {
    return path.join(root, name);
  }

  it('derives generation paths without depending on import order', () => {
    // These were briefly built from a constant imported across a module cycle,
    // which evaluated as undefined and produced `undefined/candidate-<sha>`:
    // a path that passes containment, names nothing, and makes cleanup a no-op.
    expect(candidateRelPathForSha('abc123')).toBe('generations/candidate-abc123');
    expect(appliedRelPathFor('abc123', 2)).toBe('generations/applied-abc123-2');
  });

  it('round-trips a valid marker and refuses a foreign live marker', async () => {
    const area = areaFor('round-trip');
    await writeStagingMarker(area, {
      schemaVersion: 1,
      operationId: 'op-1',
      rootPreexisted: true,
      candidateRelPath: candidateRelPathForSha(SHA),
      createdAt: 1,
    });
    const read = await readStagingMarker(area);
    expect(read.state).toBe('valid');
    if (read.state !== 'valid') throw new Error('expected a valid marker');
    expect(read.marker.operationId).toBe('op-1');
    expect(read.marker.candidateRelPath).toBe(`generations/candidate-${SHA}`);

    // Same operation may rewrite its own marker; a different one may not.
    await writeStagingMarker(area, { ...read.marker, createdAt: 2 });
    await expect(writeStagingMarker(area, { ...read.marker, operationId: 'op-2' }))
      .rejects.toBeInstanceOf(CreateStagingMarkerError);

    await deleteStagingMarker(area);
    expect((await readStagingMarker(area)).state).toBe('missing');
  });

  it('treats every unsafe candidate path as corrupt', async () => {
    const cases: Array<[string, unknown]> = [
      ['absolute', path.resolve(root, 'elsewhere')],
      ['dotdot', '../escape'],
      ['empty', ''],
      ['wrong prefix', 'applied/candidate-abc'],
      ['escape', 'generations/candidate-../../../etc'],
      ['null', null],
    ];
    for (const [label, candidateRelPath] of cases) {
      const area = areaFor(`corrupt-${label.replace(/\s/g, '-')}`);
      await fsPromises.mkdir(area, { recursive: true });
      await fsPromises.writeFile(
        stagingMarkerPath(area),
        JSON.stringify({ schemaVersion: 1, operationId: 'op-x', rootPreexisted: true, candidateRelPath, createdAt: 1 }),
        'utf8',
      );
      const read = await readStagingMarker(area);
      expect(read.state, `${label} should be corrupt`).toBe('corrupt');
    }
  });

  it('rejects a marker with a bad schema version or missing fields', async () => {
    const area = areaFor('bad-shape');
    await fsPromises.mkdir(area, { recursive: true });
    await fsPromises.writeFile(stagingMarkerPath(area), '{"schemaVersion":2}', 'utf8');
    expect((await readStagingMarker(area)).state).toBe('corrupt');
    await fsPromises.writeFile(stagingMarkerPath(area), 'not json', 'utf8');
    expect((await readStagingMarker(area)).state).toBe('corrupt');
  });
});

describe('gitops create cleanup', () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'sencho-cleanup-'));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function seedArea(name: string): Promise<{ area: string; candidateRel: string; sentinel: string }> {
    const area = path.join(root, name);
    const candidateRel = candidateRelPathForSha(SHA);
    await fsPromises.mkdir(path.join(area, candidateRel), { recursive: true });
    const sentinel = path.join(area, 'generations', 'applied-old');
    await fsPromises.mkdir(sentinel, { recursive: true });
    return { area, candidateRel, sentinel };
  }

  it('removes only the staged candidate when the managed root pre-existed', async () => {
    const { area, candidateRel, sentinel } = await seedArea('preexisting');
    await removeOperationOwnedPaths({ stackManagedRoot: area, candidateRelPath: candidateRel, ownsManagedRoot: false });
    expect(fs.existsSync(path.join(area, candidateRel))).toBe(false);
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(fs.existsSync(area)).toBe(true);
  });

  it('removes the whole root only when the operation created it', async () => {
    const { area, candidateRel } = await seedArea('owned');
    await removeOperationOwnedPaths({ stackManagedRoot: area, candidateRelPath: candidateRel, ownsManagedRoot: true });
    expect(fs.existsSync(area)).toBe(false);
  });

  it('refuses to remove a path outside the managed root', async () => {
    const { area } = await seedArea('escape-guard');
    await expect(removeOperationOwnedPaths({
      stackManagedRoot: area,
      candidateRelPath: '../../outside',
      ownsManagedRoot: false,
    })).rejects.toThrow(/outside the managed root/);
  });

  it('preserves an unclaimed root whose marker is missing or corrupt', async () => {
    const { area, sentinel } = await seedArea('unclaimed');
    expect(await cleanupUnclaimedManagedRoot(area, null)).toBe('preserved');
    expect(fs.existsSync(sentinel)).toBe(true);

    expect(await cleanupUnclaimedManagedRoot(area, {
      operationId: 'op-x',
      rootPreexisted: true,
      candidateRelPath: '../escape',
    })).toBe('preserved');
    expect(fs.existsSync(sentinel)).toBe(true);
  });

  it('applies operation-owned cleanup for an unclaimed root with a valid marker', async () => {
    const preexisting = await seedArea('unclaimed-preexisting');
    expect(await cleanupUnclaimedManagedRoot(preexisting.area, {
      operationId: 'op-x',
      rootPreexisted: true,
      candidateRelPath: preexisting.candidateRel,
    })).toBe('removed_candidate');
    expect(fs.existsSync(path.join(preexisting.area, preexisting.candidateRel))).toBe(false);
    expect(fs.existsSync(preexisting.sentinel)).toBe(true);

    const owned = await seedArea('unclaimed-owned');
    expect(await cleanupUnclaimedManagedRoot(owned.area, {
      operationId: 'op-x',
      rootPreexisted: false,
      candidateRelPath: owned.candidateRel,
    })).toBe('removed_root');
    expect(fs.existsSync(owned.area)).toBe(false);
  });
});

function envelope(operationId: string): EventEnvelope {
  return { operationId, actor: 'tester', trigger: 'manual', at: Date.now() };
}

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
    manifest_version: 0,
    candidate_dir: candidateRelPathForSha(SHA),
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
