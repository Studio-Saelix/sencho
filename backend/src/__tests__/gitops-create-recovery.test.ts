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
import { assertCreatesSettled, resolveInterruptedCreates } from '../services/gitops/createRecovery';
import { candidateRelPathForSha, CREATE_STAGING_MARKER_FILENAME } from '../services/gitops/createStagingMarker';
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

  it('leaves a stack directory alone when the create never recorded making it', async () => {
    // pre_stack is durable proof that createStack had not returned, so a
    // directory present now may be the operator's own. Deleting it is the one
    // mistake recovery cannot take back.
    seedCreate('app-notours', 'notours-web', 'pre_stack');
    const composeDir = process.env.COMPOSE_DIR!;
    const stackDir = path.join(composeDir, 'notours-web');
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services: {}\n');

    const settled = await resolveInterruptedCreates();

    expect(settled[0].outcome).toBe('tombstoned');
    expect(fs.existsSync(path.join(stackDir, 'compose.yaml'))).toBe(true);
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

  it('retains a create whose files could not be removed, and refuses to start on it', async () => {
    // A cleanup that cannot finish must not be recorded as a clean failure: the
    // application stays `creating`, so nothing downstream may treat the stack
    // name as free. The failure is forced through the containment guard, which
    // is a real refusal rather than a stubbed one.
    const store = GitOpsStore.getInstance();
    seedCreate('app-stuck', 'stuck-web', 'stack_created', { createdManagedRoot: 0 });
    store.updateCreateCheckpoint('app-stuck', { generationId: 'gen-app-stuck' }, Date.now());
    const managedRoot = stackManagedRoot('stuck-web');
    // Outside the managed area, which is what makes the guard refuse.
    const external = path.join(process.env.DATA_DIR!, 'external-stuck');
    fs.mkdirSync(external, { recursive: true });
    fs.mkdirSync(managedRoot, { recursive: true });
    fs.symlinkSync(external, path.join(managedRoot, 'generations'), 'junction');

    const settled = await resolveInterruptedCreates();

    expect(settled).toEqual([
      { stackName: 'stuck-web', applicationId: 'app-stuck', outcome: 'retained' },
    ]);
    // Still creating, and its checkpoint survives so the next boot retries.
    expect(store.getApplication('app-stuck')?.lifecycle_status).toBe('creating');
    expect(store.getCreateCheckpoint('app-stuck')).toBeDefined();
    expect(fs.existsSync(external)).toBe(true);

    // What startup does with that outcome: stop, before any mutation service
    // starts or HTTP binds.
    expect(() => assertCreatesSettled(settled)).toThrow(/stuck-web/);
  });

  it('reports a settled create whose marker survived, and still starts', async () => {
    // The counterpart to the test above, driven through the real code rather
    // than a hand-built outcome list. Ownership is decided here, so a marker
    // file that could not be deleted decides nothing and must not stop a boot.
    // The marker path is made a directory so the unlink fails while everything
    // else about the create is already settled.
    const store = GitOpsStore.getInstance();
    seedCreate('app-marker', 'marker-web', 'pointers_committed');
    DatabaseService.getInstance().getDb().prepare(
      "UPDATE gitops_applications SET lifecycle_status = 'active' WHERE id = 'app-marker'",
    ).run();
    fs.mkdirSync(path.join(stackManagedRoot('marker-web'), CREATE_STAGING_MARKER_FILENAME), { recursive: true });

    const settled = await resolveInterruptedCreates();

    expect(settled).toEqual([
      { stackName: 'marker-web', applicationId: 'app-marker', outcome: 'marker_retained' },
    ]);
    // The checkpoint is what makes the next boot retry the marker. Dropping it
    // would leave a claim on the name with nothing left to clear it.
    expect(store.getCreateCheckpoint('app-marker')).toBeDefined();
    expect(() => assertCreatesSettled(settled)).not.toThrow();
  });

  it('clears the marker before the checkpoint for a create that is no longer creating', async () => {
    // An application tombstoned on some other path leaves a stale checkpoint
    // behind. It settles like any other finished create, and it has to clear the
    // marker on the way out: dropping the checkpoint first would leave a claim
    // on the stack name with nothing left to retry it, and every later create
    // for that name would be refused by a marker nothing could remove.
    const store = GitOpsStore.getInstance();
    seedCreate('app-gone', 'gone-web', 'stack_created', { createdManagedRoot: 0 });
    DatabaseService.getInstance().getDb().prepare(
      "UPDATE gitops_applications SET lifecycle_status = 'deleted' WHERE id = 'app-gone'",
    ).run();
    // A directory at the marker path, so the unlink fails the way a permission
    // error would and the ordering becomes observable.
    fs.mkdirSync(path.join(stackManagedRoot('gone-web'), CREATE_STAGING_MARKER_FILENAME), { recursive: true });

    const settled = await resolveInterruptedCreates();

    expect(settled).toEqual([
      { stackName: 'gone-web', applicationId: 'app-gone', outcome: 'marker_retained' },
    ]);
    expect(store.getCreateCheckpoint('app-gone')).toBeDefined();
    expect(() => assertCreatesSettled(settled)).not.toThrow();
  });

  it('drops the checkpoint for a create that is no longer creating once its marker is clear', async () => {
    // The same route with nothing blocking the marker: this is the ordinary
    // outcome, and it must still end with the checkpoint gone.
    const store = GitOpsStore.getInstance();
    seedCreate('app-gone-ok', 'gone-ok-web', 'stack_created', { createdManagedRoot: 0 });
    DatabaseService.getInstance().getDb().prepare(
      "UPDATE gitops_applications SET lifecycle_status = 'deleted' WHERE id = 'app-gone-ok'",
    ).run();

    const settled = await resolveInterruptedCreates();

    expect(settled[0].outcome).toBe('checkpoint_cleared');
    expect(store.getCreateCheckpoint('app-gone-ok')).toBeUndefined();
  });

  it('reports a marker left by a torn-down create without blocking the boot', async () => {
    // The teardown path reaches the same condition by a different route. Its
    // staged directories are gone, so nothing deployable survives and the
    // create is effectively torn down; only the marker is stuck. Treating that
    // as unresolved would make one failed unlink cost an operator their
    // instance, which is the opposite of the settled path's answer.
    const store = GitOpsStore.getInstance();
    seedCreate('app-tearmark', 'tearmark-web', 'stack_created', { createdManagedRoot: 0 });
    fs.mkdirSync(path.join(stackManagedRoot('tearmark-web'), CREATE_STAGING_MARKER_FILENAME), { recursive: true });

    const settled = await resolveInterruptedCreates();

    expect(settled[0].outcome).toBe('marker_retained');
    expect(store.getCreateCheckpoint('app-tearmark')).toBeDefined();
    expect(() => assertCreatesSettled(settled)).not.toThrow();
  });

  it('settles a create when the managed area is not on disk at all', async () => {
    // A database restored without its data directory, or a volume that failed
    // to mount. Nothing under the area exists, so there is nothing to remove
    // and the create tears down normally. Reporting this as unresolved would,
    // with the boot gate, stop the instance starting on every boot over a
    // directory that is merely absent.
    const previous = process.env.DATA_DIR;
    process.env.DATA_DIR = path.join(tmpDir, 'data-without-managed-area');
    try {
      seedCreate('app-noarea', 'noarea-web', 'stack_created', { createdManagedRoot: 0 });
      const settled = await resolveInterruptedCreates();
      expect(settled[0].outcome).toBe('tombstoned');
      expect(() => assertCreatesSettled(settled)).not.toThrow();
    } finally {
      process.env.DATA_DIR = previous;
    }
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
    commit_sha: SHA,
    repo_url: 'https://github.com/org/repo.git',
    resolved_ref_kind: 'branch',
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
