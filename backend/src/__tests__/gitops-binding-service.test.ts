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

  it('refuses adopt when the Blueprint still has a live Inline application', () => {
    const blueprint = create('bp-adopt-inline');
    const applicationId = seedDirect('adopt-inline-web');
    expect(() => GitOpsBindingService.getInstance().adoptDirectToBlueprint({
      blueprintId: blueprint.id,
      applicationId,
      actor: 'tester',
    })).toThrowError(expect.objectContaining({
      name: 'GitOpsBindingError',
      code: 'live_inline_blueprint',
    }));
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

  it('retires Git-managed content back to a Direct application', () => {
    const { blueprint, applicationId } = bindGit('bp-retire-ok', 'retire-ok-web');
    GitOpsBindingService.getInstance().retireToDirect({ blueprintId: blueprint.id, actor: 'tester' });
    expect(DatabaseService.getInstance().getBlueprint(blueprint.id)).toMatchObject({
      content_origin: 'inline',
      application_id: null,
    });
    expect(GitOpsStore.getInstance().getApplication(applicationId)).toMatchObject({
      id: applicationId,
      target_mode: 'direct',
      stack_name: 'bp-retire-ok',
      configured_source_stack_name: null,
    });
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
