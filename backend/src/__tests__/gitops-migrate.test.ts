/**
 * Migration of Git stacks that predate the revision state model.
 *
 * The rule under test is that a canonical pointer is written only when the
 * evidence proves that exact generation under the repository and ref configured
 * now. A legacy applied commit is not that proof by itself, so the interesting
 * cases are the ones where it is *not* promoted: a missing manifest, an
 * unreadable one, and one stamped for a repository the stack no longer points
 * at. In each the commit survives as recorded evidence and the projection asks
 * for a fetch instead of asserting something nobody verified.
 */
import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService, type StackGitSource } from '../services/DatabaseService';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import { migrateDirectGitStacks, primeMigrationManifests } from '../services/gitops/migrate';
import { projectApplication } from '../services/gitops/derive';

const REPO = 'https://github.com/example/legacy.git';
const SHA = 'legacy01';

type ManifestFixture = { manifestVersion: number; generation: { appliedDir: string } } | { corrupt: string } | null;

describe('gitops migration of pre-existing Git stacks', () => {
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
    db.prepare('DELETE FROM gitops_migration_checkpoints').run();
    db.prepare('DELETE FROM gitops_target_current').run();
    db.prepare('DELETE FROM gitops_generations').run();
    db.prepare('DELETE FROM gitops_applications').run();
    db.prepare('DELETE FROM stack_git_sources').run();
  });

  it('leaves a config-only stack asking for a fetch', () => {
    seedStack('cfg-only', { lastApplied: null });
    primeManifests({ 'cfg-only': null });

    expect(migrateDirectGitStacks()).toEqual([{ stackName: 'cfg-only', outcome: 'migrated_unreconciled' }]);

    const app = GitOpsStore.getInstance().getLiveDirectApplication('cfg-only')!;
    expect(app.desired_commit_sha).toBeNull();
    expect(app.accepted_generation_id).toBeNull();
    expect(app.materialization_fingerprint).not.toBeNull();
    const projection = projectOf(app.id);
    expect(projection.facets.source.status).toBe('never_reconciled');
    expect(projection.availableActions).toContain('fetch');
    expect(projection.limitations).toHaveLength(0);
  });

  it('accepts the applied commit only when a trusted manifest proves it', () => {
    seedStack('trusted', { lastApplied: SHA });
    primeManifests({ trusted: { manifestVersion: 3, generation: { appliedDir: `generations/applied-${SHA}-3` } } });

    expect(migrateDirectGitStacks()).toEqual([{ stackName: 'trusted', outcome: 'migrated_accepted' }]);

    const store = GitOpsStore.getInstance();
    const app = store.getLiveDirectApplication('trusted')!;
    expect(app.desired_commit_sha).toBe(SHA);
    expect(app.fetched_commit_sha).toBe(SHA);
    expect(app.accepted_generation_id).not.toBeNull();

    const generation = store.getGeneration(app.accepted_generation_id!)!;
    expect(generation.commit_sha).toBe(SHA);
    // Equal fingerprints, or the accepted generation would immediately read as
    // stale against the configuration that produced it.
    expect(generation.materialization_fingerprint).toBe(app.materialization_fingerprint);

    const target = store.getTarget(app.id, 1)!;
    expect(target.desired_generation_id).toBe(app.accepted_generation_id);
    expect(target.applied_generation_id).toBe(app.accepted_generation_id);
    // A manifest proves what was materialized, never what is running.
    expect(target.deployed_generation_id).toBeNull();
    expect(target.healthy_generation_id).toBeNull();
    expect(target.lkg_generation_id).toBeNull();
    // Nobody approved this generation through the model.
    expect(app.source_acceptance_ref).toBeNull();

    expect(projectOf(app.id).facets.source.status).toBe('application_generation_accepted');
  });

  it('keeps an unprovable applied commit as evidence, never as a pointer', () => {
    const cases: Array<[string, ManifestFixture, string]> = [
      ['manifest-gone', null, 'manifest_absent'],
      ['manifest-broken', { corrupt: 'invalid manifest shape' }, 'manifest_corrupt'],
      ['manifest-foreign', { corrupt: 'identity repository mismatch' }, 'manifest_identity_invalid'],
    ];
    for (const [stackName, manifest, expectedCode] of cases) {
      seedStack(stackName, { lastApplied: SHA });
      primeManifests({ [stackName]: manifest });

      migrateDirectGitStacks();

      const app = GitOpsStore.getInstance().getLiveDirectApplication(stackName)!;
      expect(app.desired_commit_sha, stackName).toBeNull();
      expect(app.fetched_commit_sha, stackName).toBeNull();
      expect(app.accepted_generation_id, stackName).toBeNull();

      const projection = projectOf(app.id);
      expect(projection.facets.source.status, stackName).toBe('never_reconciled');
      expect(projection.limitations.map((l) => l.code), stackName).toContain(expectedCode);
      // The commit is retained as the evidence behind the limitation, so an
      // operator can see what the stack used to be at.
      expect(projection.limitations.map((l) => l.evidence), stackName).toContain(SHA);
    }
  });

  it('does not let a pending pull stand in for proof', () => {
    seedStack('pending-only', { lastApplied: null, pending: 'pending99' });
    primeManifests({ 'pending-only': null });

    migrateDirectGitStacks();

    const app = GitOpsStore.getInstance().getLiveDirectApplication('pending-only')!;
    expect(app.desired_commit_sha).toBeNull();
    expect(app.candidate_generation_id).toBeNull();
    const projection = projectOf(app.id);
    expect(projection.facets.source.status).toBe('never_reconciled');
    expect(projection.limitations.map((l) => l.code)).toContain('legacy_pending');
  });

  it('is a no-op on replay and re-runs only when the configuration changes', () => {
    seedStack('replay', { lastApplied: SHA });
    primeManifests({ replay: { manifestVersion: 1, generation: { appliedDir: `generations/applied-${SHA}-1` } } });

    expect(migrateDirectGitStacks()[0].outcome).toBe('migrated_accepted');
    const firstId = GitOpsStore.getInstance().getLiveDirectApplication('replay')!.id;

    expect(migrateDirectGitStacks()).toEqual([{ stackName: 'replay', outcome: 'skipped_current' }]);
    expect(GitOpsStore.getInstance().getLiveDirectApplication('replay')!.id).toBe(firstId);

    // A material configuration change replays the matrix, and the existing
    // application is left alone rather than being rebuilt over.
    seedStack('replay', { lastApplied: SHA, composePaths: ['compose.yaml', 'compose.prod.yaml'] });
    expect(migrateDirectGitStacks()).toEqual([{ stackName: 'replay', outcome: 'skipped_live_application' }]);
    expect(GitOpsStore.getInstance().getLiveDirectApplication('replay')!.id).toBe(firstId);
  });

  it('never touches a stack the new path already described', () => {
    seedStack('already-modelled', { lastApplied: SHA });
    primeManifests({ 'already-modelled': null });
    migrateDirectGitStacks();
    const before = GitOpsStore.getInstance().getLiveDirectApplication('already-modelled')!;

    DatabaseService.getInstance().getDb().prepare('DELETE FROM gitops_migration_checkpoints').run();
    migrateDirectGitStacks();

    expect(GitOpsStore.getInstance().getLiveDirectApplication('already-modelled')!.id).toBe(before.id);
  });

  it('retires a stack whose directory is gone instead of claiming its name', () => {
    seedStack('vanished', { lastApplied: SHA, createDir: false });
    primeManifests({ vanished: null });

    expect(migrateDirectGitStacks()).toEqual([
      { stackName: 'vanished', outcome: 'tombstoned_missing_stack' },
    ]);
    expect(GitOpsStore.getInstance().getLiveDirectApplication('vanished')).toBeUndefined();
  });
});

function projectOf(applicationId: string) {
  const projection = projectApplication(applicationId, true);
  if (projection.targetMode === 'not_applicable') throw new Error('expected an application');
  return projection;
}

function primeManifests(fixtures: Record<string, ManifestFixture>): void {
  primeMigrationManifests((stackName) => fixtures[stackName] ?? null);
}

function seedStack(
  stackName: string,
  options: { lastApplied: string | null; pending?: string; composePaths?: string[]; createDir?: boolean },
): void {
  if (options.createDir !== false) {
    const composeDir = process.env.COMPOSE_DIR!;
    fs.mkdirSync(path.join(composeDir, stackName), { recursive: true });
    fs.writeFileSync(path.join(composeDir, stackName, 'compose.yaml'), 'services: {}\n');
  }
  const row: Parameters<DatabaseService['upsertGitSource']>[0] = {
    stack_name: stackName,
    repo_url: REPO,
    branch: 'main',
    compose_path: 'compose.yaml',
    compose_paths: options.composePaths ?? ['compose.yaml'],
    context_dir: null,
    sync_env: false,
    env_path: null,
    auth_type: 'none',
    encrypted_token: null,
    auto_apply_on_webhook: false,
    auto_deploy_on_apply: false,
    last_applied_commit_sha: options.lastApplied,
    last_applied_content_hash: null,
    pending_commit_sha: options.pending ?? null,
    pending_compose_content: null,
    pending_env_content: null,
    pending_fetched_at: null,
    last_debounce_at: null,
  } as StackGitSource;
  DatabaseService.getInstance().upsertGitSource(row);
  if (options.lastApplied) {
    DatabaseService.getInstance().markGitSourceApplied(stackName, options.lastApplied, '');
  }
  if (options.pending) {
    // upsertGitSource does not write the pending columns on insert, so a
    // legacy row carrying an unapplied pull is seeded directly.
    DatabaseService.getInstance().getDb()
      .prepare('UPDATE stack_git_sources SET pending_commit_sha = ? WHERE stack_name = ?')
      .run(options.pending, stackName);
  }
}
