import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService, type Blueprint } from '../services/DatabaseService';
import { BlueprintReconciler } from '../services/BlueprintReconciler';
import { BlueprintService } from '../services/BlueprintService';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions } from '../services/gitops/transitions';
import { commitBlueprintCreate, commitBlueprintUpdate } from '../services/gitops/blueprintProducers';
import { encodeGitOpsApprovedTargetEffectJson } from '../services/gitops/json';
import { configuredSnapshotFor, encodePolicySnapshot } from '../services/gitops/policyComposition';
import { newGitOpsId } from '../services/gitops/directApplication';
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

  it('does not place a new node from a Git-managed revision stamp after Detach is re-armed', async () => {
    // The Git-managed case: bounded placement approved the node that is running,
    // and the startup migration had set automatic rollout authorization, so no
    // operator chose either for Inline. Detach changes who decides. Re-arming
    // rollout and adding a node must still wait, because the running node's
    // stamp is the revision Git content was deployed at.
    const store = GitOpsStore.getInstance();
    const blueprint = commitBlueprintCreate({
      name: 'bp-detach-authority',
      description: null,
      compose_content: 'services:\n  web:\n    image: nginx:1.27\n',
      selector: { type: 'nodes', ids: [1] },
      drift_mode: 'suggest',
      classification: 'stateless',
      classification_reasons: [],
      enabled: true,
      created_by: 'tester',
    }, () => [1]);
    const applicationId = seedDirect('detach-authority-web');
    GitOpsBindingService.getInstance().convertInlineToGit({
      blueprintId: blueprint.id,
      applicationId,
      actor: 'tester',
    });
    const app = store.getApplication(applicationId)!;
    DatabaseService.getInstance().getDb().prepare(
      `UPDATE gitops_applications
          SET placement_policy = 'bounded_auto', rollout_authorization_policy = 'automatic'
        WHERE id = ?`,
    ).run(applicationId);
    // Read back after the policy write: a policy-authorized approval has to
    // carry the snapshot of the policies that decided it.
    const configuredApp = store.getApplication(applicationId)!;

    // Node 1 runs the placed revision. The approval names only that node, so a
    // later selector edit that adds a real second node is one stateless place.
    DatabaseService.getInstance().upsertDeployment({
      blueprint_id: blueprint.id,
      node_id: 1,
      status: 'active',
      applied_revision: blueprint.revision,
      last_deployed_at: Date.now(),
    });
    GitOpsTransitions.getInstance().placementApproved({
      applicationId,
      approvalId: newGitOpsId(),
      intentRevisionId: app.intent_revision_id!,
      blastJson: encodeGitOpsApprovedTargetEffectJson([{ nodeId: 1, outcome: 'place' }]),
      requiredNodeIds: [1],
      fingerprint: null,
      actor: 'tester',
      envelope: { operationId: newGitOpsId(), actor: 'tester', trigger: 'test', at: Date.now() },
      rolloutGenerationId: newGitOpsId(),
      candidateId: app.rollout_candidate_id!,
      authority: 'configured_policy',
      policyProvenanceJson: encodePolicySnapshot(configuredSnapshotFor(configuredApp)),
    });
    expect(store.getApplication(applicationId)!.placement_approval_ref).not.toBeNull();

    const stampedRevision = blueprint.revision;
    GitOpsBindingService.getInstance().detachToInline({ blueprintId: blueprint.id, actor: 'tester' });

    const demoted = store.getApplication(applicationId)!;
    expect(demoted.target_mode).toBe('inline_blueprint');
    expect(demoted.placement_approval_ref).toBeNull();
    expect(demoted.rollout_authorization_ref).toBeNull();
    expect(demoted.rollout_authorization_policy).toBe('manual');
    expect(DatabaseService.getInstance().getDeployment(blueprint.id, 1)?.applied_revision)
      .toBe(stampedRevision);

    // The operator sets Inline rollout authorization back to automatic, which
    // Detach had reset to operator-authorized. A real second node then joins the
    // selector. The policy may approve that place; the tick must not run it,
    // because node 1's stamp is the revision Git content was deployed at.
    const node2 = DatabaseService.getInstance().getDb().prepare(
      `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
       VALUES ('detach-authority-b', 'local', 'proxy', '/tmp/compose', 0, 'online', ?)`,
    ).run(Date.now());
    const node2Id = Number(node2.lastInsertRowid);
    DatabaseService.getInstance().getDb().prepare(
      `UPDATE gitops_applications SET rollout_authorization_policy = 'automatic' WHERE id = ?`,
    ).run(applicationId);

    const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode')
      .mockResolvedValue({ status: 'active' });
    try {
      commitBlueprintUpdate(
        blueprint.id,
        { selector: { type: 'nodes', ids: [1, node2Id] } },
        'tester',
        () => [1, node2Id],
      );
      const rearmed = store.getApplication(applicationId)!;
      const approval = rearmed.placement_approval_ref
        ? store.getApproval(rearmed.placement_approval_ref)
        : undefined;
      expect(approval?.authority).toBe('configured_policy');

      await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);
      expect(deploySpy).not.toHaveBeenCalled();
    } finally {
      deploySpy.mockRestore();
    }
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
