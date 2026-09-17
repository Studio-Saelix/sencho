import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService, type Blueprint } from '../services/DatabaseService';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import { commitBlueprintCreate, commitBlueprintUpdate } from '../services/gitops/blueprintProducers';
import {
  GitManagedContentError,
  GitOpsBindingService,
} from '../services/gitops/binding';
import { directApplicationFixture } from './helpers/gitopsFixtures';

function desiredNodeIdsFor(): number[] {
  return [1];
}

describe('GitOps binding service', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
  });

  afterAll(() => {
    GitOpsBindingService.resetForTests();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
    cleanupTestDb(tmpDir);
  });

  it('rejects compose edits while the Blueprint is Git-managed', () => {
    const { blueprint } = bindGit('bp-git-edit', 'git-edit-web');
    expect(() => commitBlueprintUpdate(
      blueprint.id,
      { compose_content: 'services: {}\n' },
      'tester',
      desiredNodeIdsFor,
    )).toThrow(GitManagedContentError);
  });

  it('converts Inline to Git by moving the selected Direct application', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = create('bp-convert-git');
    const inlineId = store.getLiveBlueprintApplication(blueprint.id)!.id;
    const applicationId = seedDirect('convert-git-web');

    GitOpsBindingService.getInstance().convertInlineToGit({
      blueprintId: blueprint.id,
      applicationId,
      actor: 'tester',
    });

    const bound = DatabaseService.getInstance().getBlueprint(blueprint.id)!;
    expect(bound.content_origin).toBe('git');
    expect(bound.application_id).toBe(applicationId);
    expect(bound.approval_status).toBe('pending');
    expect(store.getApplication(inlineId)?.lifecycle_status).toBe('deleted');
    expect(store.getApplication(applicationId)).toMatchObject({
      id: applicationId,
      target_mode: 'blueprint',
      stack_name: null,
      configured_source_stack_name: 'convert-git-web',
      blueprint_id: blueprint.id,
    });
  });

  it('adopts a Direct source by tombstoning the live Inline application', () => {
    const store = GitOpsStore.getInstance();
    const blueprint = create('bp-adopt-inline');
    const inlineId = store.getLiveBlueprintApplication(blueprint.id)!.id;
    const applicationId = seedDirect('adopt-inline-web');

    GitOpsBindingService.getInstance().adoptDirectToBlueprint({
      blueprintId: blueprint.id,
      applicationId,
      actor: 'tester',
    });

    expect(store.getApplication(inlineId)?.lifecycle_status).toBe('deleted');
    expect(store.getApplication(applicationId)).toMatchObject({
      target_mode: 'blueprint',
      configured_source_stack_name: 'adopt-inline-web',
      blueprint_id: blueprint.id,
    });
    expect(DatabaseService.getInstance().getBlueprint(blueprint.id)).toMatchObject({
      content_origin: 'git',
      application_id: applicationId,
    });
  });

  it('blocks retire while deployments are still active', () => {
    const { blueprint } = bindGit('bp-retire-active', 'retire-active-web');
    DatabaseService.getInstance().upsertDeployment({
      blueprint_id: blueprint.id,
      node_id: 1,
      status: 'active',
    });
    expect(() => GitOpsBindingService.getInstance().retireToDirect({
      blueprintId: blueprint.id,
      actor: 'tester',
    })).toThrow(/deploy/i);
  });

  it('blocks detach when the Inline snapshot was never materialized', () => {
    const { blueprint } = bindGit('bp-detach-empty', 'detach-empty-web');
    DatabaseService.getInstance().getDb()
      .prepare('UPDATE blueprints SET compose_content = ? WHERE id = ?')
      .run('', blueprint.id);
    expect(() => GitOpsBindingService.getInstance().detachToInline({
      blueprintId: blueprint.id,
      actor: 'tester',
    })).toThrowError(expect.objectContaining({
      name: 'GitOpsBindingError',
      code: 'git_managed_content_unmaterialized',
    }));
  });

  it('retires Git-managed content back to the original Direct stack identity', () => {
    const { blueprint, applicationId } = bindGit('bp-retire-ok', 'retire-ok-web');
    DatabaseService.getInstance().upsertGitSource({
      stack_name: 'retire-ok-web',
      repo_url: 'https://github.com/example/retire-ok-web.git',
      branch: 'main',
      compose_path: 'compose.yaml',
      compose_paths: ['compose.yaml'],
      context_dir: null,
      sync_env: false,
      env_path: null,
      auth_type: 'none',
      encrypted_token: null,
      encrypted_deploy_key: null,
      ssh_known_hosts_entry: null,
      ssh_host_key_fingerprint: null,
      encrypted_ca_bundle: null,
      auto_apply_on_webhook: false,
      auto_deploy_on_apply: false,
      last_applied_commit_sha: null,
      last_applied_content_hash: null,
      pending_commit_sha: null,
      pending_compose_content: null,
      pending_env_content: null,
      pending_fetched_at: null,
      last_debounce_at: null,
    });
    expect(GitOpsStore.getInstance().getApplication(applicationId)?.evidence_limitations_json)
      .toContain('git_managed_rollout_not_enabled');

    GitOpsBindingService.getInstance().retireToDirect({ blueprintId: blueprint.id, actor: 'tester' });
    expect(DatabaseService.getInstance().getBlueprint(blueprint.id)).toMatchObject({
      content_origin: 'inline',
      application_id: null,
    });
    const retired = GitOpsStore.getInstance().getApplication(applicationId)!;
    expect(retired).toMatchObject({
      id: applicationId,
      target_mode: 'direct',
      stack_name: 'retire-ok-web',
      configured_source_stack_name: null,
    });
    expect(retired.evidence_limitations_json ?? '').not.toContain('git_managed_rollout_not_enabled');
    expect(DatabaseService.getInstance().getGitSource('retire-ok-web')).toBeTruthy();
    expect(GitOpsStore.getInstance().getLiveDirectApplication('retire-ok-web')?.id).toBe(applicationId);
  });

  it('detaches Git-managed content back to Inline editing', () => {
    const { blueprint, applicationId } = bindGit('bp-detach-ok', 'detach-ok-web');
    GitOpsBindingService.getInstance().detachToInline({ blueprintId: blueprint.id, actor: 'tester' });
    expect(DatabaseService.getInstance().getBlueprint(blueprint.id)).toMatchObject({
      content_origin: 'inline',
      application_id: null,
    });
    expect(GitOpsStore.getInstance().getApplication(applicationId)?.target_mode).toBe('inline_blueprint');
  });

  it('describes Git-managed content without the retained source stack identity', () => {
    const { blueprint, applicationId } = bindGit('bp-describe', 'describe-web');
    const view = GitOpsBindingService.getInstance().describeContentBinding(blueprint.id);
    expect(view).toMatchObject({
      contentOrigin: 'git',
      applicationId,
      repoUrl: 'https://github.com/example/describe-web.git',
      ref: 'main',
      composePaths: ['compose.yaml'],
      blockedRollout: true,
      snapshotPresent: true,
    });
    expect(view).not.toHaveProperty('configured_source_stack_name');
    expect(view).not.toHaveProperty('stackName');
  });
});

function bindGit(name: string, stackName: string): { blueprint: Blueprint; applicationId: string } {
  const blueprint = create(name);
  const applicationId = seedDirect(stackName);
  GitOpsBindingService.getInstance().convertInlineToGit({
    blueprintId: blueprint.id,
    applicationId,
    actor: 'tester',
  });
  return { blueprint, applicationId };
}

function create(name: string): Blueprint {
  return commitBlueprintCreate({
    name,
    description: null,
    compose_content: 'services:\n  web:\n    image: nginx:1.27\n',
    selector: { type: 'nodes', ids: [1] },
    drift_mode: 'suggest',
    classification: 'stateless',
    classification_reasons: [],
    enabled: true,
    created_by: 'tester',
  }, desiredNodeIdsFor);
}

function seedDirect(stackName: string): string {
  const application = {
    ...directApplicationFixture(`app-${stackName}`, stackName),
    configured_repo_url: `https://github.com/example/${stackName}.git`,
  };
  GitOpsTransitions.getInstance().activateDirect({
    application,
    nodeId: 1,
    envelope: { operationId: `op-${stackName}`, actor: 'tester', trigger: 'manual', at: Date.now() },
  });
  return application.id;
}
