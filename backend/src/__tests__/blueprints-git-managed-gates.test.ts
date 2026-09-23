/**
 * Git-managed Blueprints must not deploy stale Inline YAML, and delete must
 * not withdraw or drop a bound application. These tests call the real
 * reconciler, service, and HTTP routes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { intentFingerprint, serializeApprovedBlast } from '../services/blueprintApproval';
import { GitManagedContentError } from '../services/gitops/binding';
import { directApplicationFixture } from './helpers/gitopsFixtures';

let tmpDir: string;
let app: import('express').Express;
let adminCookie: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let BlueprintReconciler: typeof import('../services/BlueprintReconciler').BlueprintReconciler;
let BlueprintService: typeof import('../services/BlueprintService').BlueprintService;
let GitOpsStore: typeof import('../services/gitops/store').GitOpsStore;
let GitOpsTransitions: typeof import('../services/gitops/transitions').GitOpsTransitions;
let GitOpsBindingService: typeof import('../services/gitops/binding').GitOpsBindingService;
let deriveGitOpsRevision: typeof import('../services/gitops/derive').deriveGitOpsRevision;
let commitBlueprintCreate: typeof import('../services/gitops/blueprintProducers').commitBlueprintCreate;
let counter = 0;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ BlueprintReconciler } = await import('../services/BlueprintReconciler'));
  ({ BlueprintService } = await import('../services/BlueprintService'));
  ({ GitOpsStore } = await import('../services/gitops/store'));
  ({ GitOpsTransitions } = await import('../services/gitops/transitions'));
  ({ GitOpsBindingService } = await import('../services/gitops/binding'));
  ({ deriveGitOpsRevision } = await import('../services/gitops/derive'));
  ({ commitBlueprintCreate } = await import('../services/gitops/blueprintProducers'));
  adminCookie = await loginAsTestAdmin(app);
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  vi.restoreAllMocks();
  GitOpsStore.resetForTests();
  GitOpsTransitions.resetForTests();
  GitOpsBindingService.resetForTests();
});

describe('Git-managed Blueprint fail-closed gates', () => {
  it('skips reconciler deploy after a Git-managed conversion even when approval is restored', async () => {
    const { blueprint, nodeId } = converted();
    approvePlace(blueprint.id, [nodeId]);
    const deploySpy = spyDeploy();
    await BlueprintReconciler.getInstance().reconcileOne(blueprint.id);
    expect(deploySpy).not.toHaveBeenCalled();
  });

  it('refuses a confirmed plan for a Git-managed Blueprint', async () => {
    const { blueprint, nodeId } = converted();
    approvePlace(blueprint.id, [nodeId]);
    const deploySpy = spyDeploy();
    const plan = await BlueprintReconciler.getInstance().reconcileConfirmedPlan(blueprint.id, [
      { nodeId, action: 'create' },
    ]);
    expect(plan.refused).toBe(true);
    expect(plan.outcomes).toEqual([]);
    expect(deploySpy).not.toHaveBeenCalled();
  });

  it('returns 409 git_managed_content for apply and accept before any deploy work', async () => {
    const { blueprint, nodeId } = converted();
    const deploySpy = spyDeploy();
    const apply = await request(app)
      .post(`/api/blueprints/${blueprint.id}/apply`)
      .set('Cookie', adminCookie)
      .send({ planFingerprint: 'stale', actions: [{ nodeId, action: 'create' }] });
    expectGitManaged409(apply);
    const accept = await request(app)
      .post(`/api/blueprints/${blueprint.id}/accept/${nodeId}`)
      .set('Cookie', adminCookie)
      .send({ mode: 'fresh' });
    expectGitManaged409(accept);
    expect(deploySpy).not.toHaveBeenCalled();
  });

  it('refuses delete of a Git-managed Blueprint before withdrawing deployments', async () => {
    const { blueprint, nodeId } = converted();
    DatabaseService.getInstance().upsertDeployment({
      blueprint_id: blueprint.id,
      node_id: nodeId,
      status: 'active',
      last_deployed_at: Date.now(),
    });
    const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode').mockResolvedValue({ status: 'withdrawn' });
    const res = await request(app)
      .delete(`/api/blueprints/${blueprint.id}`)
      .set('Cookie', adminCookie);
    expectGitManaged409(res);
    expect(withdrawSpy).not.toHaveBeenCalled();
    expect(DatabaseService.getInstance().getBlueprint(blueprint.id)?.content_origin).toBe('git');
  });

  it('throws from deployToNode and applyLocalUnderLock when content is Git-managed', async () => {
    const { blueprint, nodeId } = converted();
    const node = DatabaseService.getInstance().getNode(nodeId)!;
    await expect(BlueprintService.getInstance().deployToNode(blueprint, node))
      .rejects.toBeInstanceOf(GitManagedContentError);
    await expect(BlueprintService.getInstance().applyLocalUnderLock(
      nodeId,
      blueprint.name,
      blueprint.compose_content,
      JSON.stringify({ blueprintId: blueprint.id, revision: blueprint.revision, lastApplied: Date.now() }),
      '/api/blueprints/test/apply',
    )).rejects.toBeInstanceOf(GitManagedContentError);
  });

  it('skips the git-managed refuse gate when applyLocalUnderLock allows authorized content', async () => {
    const { blueprint, nodeId } = converted();
    const { ComposeService } = await import('../services/ComposeService');
    const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({
      recoveryId: null,
      deployedGenerationId: null,
      gitopsOperationId: null,
    });
    try {
      await expect(BlueprintService.getInstance().applyLocalUnderLock(
        nodeId,
        blueprint.name,
        'services:\n  fromgen:\n    image: alpine:3.20\n',
        JSON.stringify({
          blueprintId: blueprint.id,
          revision: blueprint.revision,
          lastApplied: Date.now(),
          applicationId: 'app-authorized',
        }),
        '/api/blueprints/test/authorized-apply',
        { allowGitManaged: true },
      )).resolves.toEqual({ ran: true });
      expect(deploySpy).toHaveBeenCalled();
    } finally {
      deploySpy.mockRestore();
    }
  });

  it('returns 409 git_managed_content when compose_content is posted to a Git-managed Blueprint', async () => {
    const { blueprint } = converted();
    const before = DatabaseService.getInstance().getBlueprint(blueprint.id)!.compose_content;
    const res = await request(app)
      .put(`/api/blueprints/${blueprint.id}`)
      .set('Cookie', adminCookie)
      .send({ compose_content: 'services:\n  web:\n    image: nginx:1.28\n' });
    expectGitManaged409(res);
    expect(DatabaseService.getInstance().getBlueprint(blueprint.id)!.compose_content).toBe(before);
  });

  it('ignores allowGitManagedContent on apply-local for cookie sessions', async () => {
    const { blueprint, nodeId, applicationId } = converted();
    const { ComposeService } = await import('../services/ComposeService');
    const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({
      recoveryId: null,
      deployedGenerationId: null,
      gitopsOperationId: null,
    });
    try {
      const res = await request(app)
        .post('/api/blueprints/apply-local')
        .set('Cookie', adminCookie)
        .send({
          stackName: blueprint.name,
          composeContent: 'services:\n  fromgen:\n    image: alpine:3.20\n',
          markerContent: JSON.stringify({
            blueprintId: blueprint.id,
            revision: blueprint.revision,
            lastApplied: Date.now(),
            applicationId,
          }),
          allowGitManagedContent: true,
        });
      expectGitManaged409(res);
      expect(deploySpy).not.toHaveBeenCalled();
      expect(nodeId).toBeGreaterThan(0);
    } finally {
      deploySpy.mockRestore();
    }
  });

  it('refuses a malformed recoveryBinding on apply-local', async () => {
    const { blueprint, applicationId } = converted();
    const token = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const res = await request(app)
      .post('/api/blueprints/apply-local')
      .set('Authorization', `Bearer ${token}`)
      .send({
        stackName: blueprint.name,
        composeContent: 'services:\n  fromgen:\n    image: alpine:3.20\n',
        markerContent: JSON.stringify({
          blueprintId: blueprint.id,
          revision: blueprint.revision,
          lastApplied: Date.now(),
          applicationId,
        }),
        allowGitManagedContent: true,
        captureRecovery: true,
        recoveryBinding: { generationId: 123 },
      });
    expect(res.status).toBe(400);
  });

  it('refuses a non-boolean captureRecovery on apply-local', async () => {
    const { blueprint, applicationId } = converted();
    const token = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const res = await request(app)
      .post('/api/blueprints/apply-local')
      .set('Authorization', `Bearer ${token}`)
      .send({
        stackName: blueprint.name,
        composeContent: 'services:\n  fromgen:\n    image: alpine:3.20\n',
        markerContent: JSON.stringify({
          blueprintId: blueprint.id,
          revision: blueprint.revision,
          lastApplied: Date.now(),
          applicationId,
        }),
        allowGitManagedContent: true,
        captureRecovery: 'yes',
      });
    expect(res.status).toBe(400);
  });

  it('does not capture a recovery point for a cookie session', async () => {
    const { blueprint, applicationId } = converted();
    const { BlueprintService } = await import('../services/BlueprintService');
    const applySpy = vi.spyOn(BlueprintService.prototype, 'applyLocalUnderLock').mockResolvedValue({ ran: true });
    try {
      const res = await request(app)
        .post('/api/blueprints/apply-local')
        .set('Cookie', adminCookie)
        .send({
          stackName: blueprint.name,
          composeContent: 'services:\n  fromgen:\n    image: alpine:3.20\n',
          markerContent: JSON.stringify({
            blueprintId: blueprint.id,
            revision: blueprint.revision,
            lastApplied: Date.now(),
            applicationId,
          }),
          allowGitManagedContent: true,
          captureRecovery: true,
          recoveryBinding: {
            generationId: 'gen-1',
            artifactSetId: null,
            sourceAcceptanceRef: null,
          },
        });
      expect(res.status).toBe(200);
      const options = applySpy.mock.calls[0][5] as { captureRecovery?: boolean };
      expect(options.captureRecovery).toBe(false);
    } finally {
      applySpy.mockRestore();
    }
  });

  it('honors allowGitManagedContent on apply-local for node_proxy', async () => {
    const { blueprint, applicationId } = converted();
    const { ComposeService } = await import('../services/ComposeService');
    const deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({
      recoveryId: null,
      deployedGenerationId: null,
      gitopsOperationId: null,
    });
    const token = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    try {
      const res = await request(app)
        .post('/api/blueprints/apply-local')
        .set('Authorization', `Bearer ${token}`)
        .send({
          stackName: blueprint.name,
          composeContent: 'services:\n  fromgen:\n    image: alpine:3.20\n',
          markerContent: JSON.stringify({
            blueprintId: blueprint.id,
            revision: blueprint.revision,
            lastApplied: Date.now(),
            applicationId,
          }),
          allowGitManagedContent: true,
        });
      expect(res.status).toBe(200);
      expect(res.body.deployed).toBe(true);
      expect(deploySpy).toHaveBeenCalled();
    } finally {
      deploySpy.mockRestore();
    }
  });

  it('projects a blocked rollout after conversion', () => {
    const { applicationId } = converted();
    const application = GitOpsStore.getInstance().getApplication(applicationId)!;
    expect(application.rollout_candidate_id).toBeTruthy();
    const projection = deriveGitOpsRevision({
      application,
      targets: GitOpsStore.getInstance().listTargets(applicationId),
      healthDisabled: false,
    }, null);
    expect(projection.facets?.rollout.status).toBe('rollout_not_executable');
    expect(projection.limitations.some((item) => item.code === 'git_managed_rollout_not_enabled')).toBe(true);
  });
});

function spyDeploy() {
  return vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
}

function expectGitManaged409(res: { status: number; body: { code?: string } }): void {
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('git_managed_content');
}

function converted(): { blueprint: import('../services/DatabaseService').Blueprint; nodeId: number; applicationId: string } {
  counter += 1;
  const nodeId = seedNode();
  const blueprint = commitBlueprintCreate({
    name: `bp-gate-${counter}`,
    description: null,
    compose_content: 'services:\n  web:\n    image: nginx:1.27\n',
    selector: { type: 'nodes', ids: [nodeId] },
    drift_mode: 'suggest',
    classification: 'stateless',
    classification_reasons: [],
    enabled: true,
    created_by: 'tester',
  }, () => [nodeId]);
  const stackName = `gate-web-${counter}`;
  const application = {
    ...directApplicationFixture(`app-${stackName}`, stackName),
    configured_repo_url: `https://github.com/example/${stackName}.git`,
  };
  GitOpsTransitions.getInstance().activateDirect({
    application,
    nodeId,
    envelope: { operationId: `op-${stackName}`, actor: 'tester', trigger: 'manual', at: Date.now() },
  });
  GitOpsBindingService.getInstance().convertInlineToGit({
    blueprintId: blueprint.id,
    applicationId: application.id,
    actor: 'tester',
  });
  return {
    blueprint: DatabaseService.getInstance().getBlueprint(blueprint.id)!,
    nodeId,
    applicationId: application.id,
  };
}

function seedNode(): number {
  const result = DatabaseService.getInstance().getDb().prepare(
    `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
     VALUES (?, 'local', 'proxy', '/tmp/compose', 0, 'online', ?)`,
  ).run(`bp-git-gate-${counter}`, Date.now());
  return result.lastInsertRowid as number;
}

function approvePlace(blueprintId: number, nodeIds: number[]) {
  const bp = DatabaseService.getInstance().getBlueprint(blueprintId)!;
  DatabaseService.getInstance().setBlueprintApproval(blueprintId, {
    intentFingerprint: intentFingerprint(bp),
    blastJson: serializeApprovedBlast(nodeIds.map((nodeId) => ({ nodeId, outcome: 'place' as const }))),
    approvedBy: 'admin',
  });
}
