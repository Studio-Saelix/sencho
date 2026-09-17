import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import { GitSourceError } from '../services/GitSourceService';
import { projectApplication } from '../services/gitops/derive';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let GitOpsStore: typeof import('../services/gitops/store').GitOpsStore;
let GitOpsTransitions: typeof import('../services/gitops/transitions').GitOpsTransitions;
let GitOpsBindingService: typeof import('../services/gitops/binding').GitOpsBindingService;
let SourceController: typeof import('../services/gitops/SourceController').SourceController;
let GitSourceService: typeof import('../services/GitSourceService').GitSourceService;
let DeployedStackDeletionService: typeof import('../services/DeployedStackDeletionService').DeployedStackDeletionService;
let commitBlueprintCreate: typeof import('../services/gitops/blueprintProducers').commitBlueprintCreate;
let migrateDirectGitStacks: typeof import('../services/gitops/migrate').migrateDirectGitStacks;
let counter = 0;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ GitOpsStore } = await import('../services/gitops/store'));
  ({ GitOpsTransitions } = await import('../services/gitops/transitions'));
  ({ GitOpsBindingService } = await import('../services/gitops/binding'));
  ({ SourceController } = await import('../services/gitops/SourceController'));
  ({ GitSourceService } = await import('../services/GitSourceService'));
  ({ DeployedStackDeletionService } = await import('../services/DeployedStackDeletionService'));
  ({ commitBlueprintCreate } = await import('../services/gitops/blueprintProducers'));
  ({ migrateDirectGitStacks } = await import('../services/gitops/migrate'));
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  vi.restoreAllMocks();
  GitOpsStore.resetForTests();
  GitOpsTransitions.resetForTests();
  GitOpsBindingService.resetForTests();
  SourceController.resetForTests();
});

describe('converted GitOps source continuity', () => {
  it('keeps a converted application in poll and retry due-scans', () => {
    const { applicationId } = converted();
    const now = Date.now();
    DatabaseService.getInstance().getDb().prepare(
      `UPDATE gitops_applications SET next_poll_at = ?, retry_at = NULL, source_policy = 'automatic',
        lifecycle_status = 'active', suspended_at = NULL, active_operation_stage = NULL WHERE id = ?`,
    ).run(now - 1, applicationId);
    expect(GitOpsStore.getInstance().listSourcesDueForPoll(now).map((row) => row.id)).toContain(applicationId);

    DatabaseService.getInstance().getDb().prepare(
      `UPDATE gitops_applications SET retry_at = ?, next_poll_at = NULL WHERE id = ?`,
    ).run(now - 1, applicationId);
    expect(GitOpsStore.getInstance().listApplicationsDueForRetry(now).map((row) => row.id)).toContain(applicationId);
  });

  it('reschedules poll cursors for converted applications', () => {
    const { applicationId } = converted({ sourcePolicy: 'automatic' });
    DatabaseService.getInstance().getDb().prepare(
      `UPDATE gitops_applications SET poll_interval_secs = 60, next_poll_at = NULL, retry_at = NULL WHERE id = ?`,
    ).run(applicationId);
    SourceController.getInstance().rescheduleAll('tester');
    expect(GitOpsStore.getInstance().getApplication(applicationId)?.next_poll_at).toEqual(expect.any(Number));
  });

  it('does not mint a second Direct application for a converted source stack', () => {
    const { stackName, applicationId } = converted();
    seedGitSource(stackName);
    expect(migrateDirectGitStacks()).toContainEqual({ stackName, outcome: 'skipped_live_application' });
    expect(GitOpsStore.getInstance().getLiveDirectApplication(stackName)).toBeUndefined();
    expect(GitOpsStore.getInstance().getApplication(applicationId)?.target_mode).toBe('blueprint');
  });

  it('refuses save, detach, and pull on a stack claimed by a Blueprint', async () => {
    const { stackName } = converted();
    seedGitSource(stackName);
    const svc = GitSourceService.getInstance();
    await expect(svc.upsert({
      stackName,
      repoUrl: `https://github.com/example/${stackName}.git`,
      branch: 'main',
      composePaths: ['compose.yaml'],
      contextDir: null,
      syncEnv: false,
      envPath: null,
      authType: 'none',
      autoApplyOnWebhook: false,
      autoDeployOnApply: false,
    })).rejects.toMatchObject({ code: 'SOURCE_CLAIMED_BY_BLUEPRINT' });
    await expect(svc.detach(stackName)).rejects.toMatchObject({ code: 'SOURCE_CLAIMED_BY_BLUEPRINT' });
    await expect(svc.pull(stackName, { actor: 'tester' })).rejects.toMatchObject({
      code: 'SOURCE_CLAIMED_BY_BLUEPRINT',
    });
    await expect(svc.apply(stackName, 'a'.repeat(40))).rejects.toMatchObject({
      code: 'SOURCE_CLAIMED_BY_BLUEPRINT',
    });
    expect(() => svc.dismissPending(stackName)).toThrow(GitSourceError);
  });

  it('refuses stack deletion while a Blueprint still holds the source', async () => {
    const { stackName, nodeId } = converted();
    seedGitSource(stackName);
    const result = await DeployedStackDeletionService.getInstance().deleteDeployedStack({
      nodeId,
      stackName,
      pruneVolumes: false,
      actor: 'tester',
    });
    expect(result).toMatchObject({ ok: false, code: 'source_claimed_by_blueprint' });
    expect(DatabaseService.getInstance().getGitSource(stackName)).toBeTruthy();
  });

  it('retries a converted stack against the Blueprint adapter, not as a missing application', async () => {
    const { stackName, applicationId } = converted();
    const svc = GitSourceService.getInstance();
    const reconcile = vi.spyOn(svc, 'reconcile').mockResolvedValue({
      outcome: 'no_source_change',
      reason: 'held',
      nextAction: 'none',
    });
    const result = await svc.retry(stackName, { actor: 'tester' });
    expect(result.outcome).not.toBe('unknown');
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      applicationId,
      stackName,
      trigger: 'retry',
    }));
  });

  it('reconciles a converted application instead of treating it as missing', async () => {
    const { stackName, applicationId } = converted();
    seedGitSource(stackName);
    const svc = GitSourceService.getInstance();
    const pullLocked = vi.spyOn(Object.getPrototypeOf(svc), 'pullLocked').mockResolvedValue({
      commitSha: 'a'.repeat(40),
      validation: { ok: true },
      refusals: [],
      manifestSummary: null,
      candidateReady: false,
      warnings: [],
      plan: null,
      planFingerprint: null,
    });
    const result = await svc.reconcile({
      intent: 'fetch',
      applicationId,
      stackName,
      trigger: 'poll',
      actor: 'tester',
    });
    expect(pullLocked).toHaveBeenCalled();
    expect(result.reason).toBe('The source has never been reconciled.');
  });

  it('evaluates a converted source through the controller wake path', async () => {
    const { stackName, applicationId } = converted({ sourcePolicy: 'automatic' });
    const reconcile = vi.spyOn(GitSourceService.getInstance(), 'reconcile').mockResolvedValue({
      outcome: 'no_source_change',
      reason: 'held',
      nextAction: 'none',
    });
    await SourceController.getInstance().evaluateNow(stackName);
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      intent: 'fetch',
      applicationId,
      stackName,
      trigger: 'resume',
    }));
  });

  it('skips webhook pull on a stack claimed by a Blueprint', async () => {
    const { stackName } = converted();
    seedGitSource(stackName);
    const result = await GitSourceService.getInstance().handleWebhookPull(stackName, false);
    expect(result).toMatchObject({ status: 'skipped' });
    expect(result.message).toMatch(/bound to a Blueprint/i);
  });

  it('projects blueprint mode after conversion', () => {
    const { applicationId } = converted();
    const projection = projectApplication(applicationId, false);
    expect(projection.targetMode).toBe('blueprint');
  });

  it('dispatches an accepted generation for blueprint mode to the blocked adapter', async () => {
    const { applicationId } = converted();
    const dispatch = await GitSourceService.getInstance().dispatchAcceptedGeneration(
      {
        contractVersion: 1,
        generationId: 'gen-blocked',
        applicationId,
        repoIdentity: { host: 'github.com', pathname: '/example/cont.git' },
        configuredRef: 'main',
        commitSha: 'a'.repeat(40),
        resolvedRefKind: 'branch',
        manifestVersion: 1,
        portableManifest: null,
        composeInputs: { composeFileOrder: ['compose.yaml'] },
        materializationFingerprint: 'b'.repeat(64),
        changePlanFingerprint: null,
        validationOk: true,
        sourcePolicyEvidence: null,
        securityPolicyEvidence: null,
        supportRequirements: null,
        compatibilityRequirements: null,
        secretCapability: null,
        trigger: 'retry',
        actor: 'tester',
        operationId: 'op-blocked',
        previousGenerationId: null,
        limitations: [],
      },
      { targetMode: 'blueprint', nodeId: 1, bindingRevision: null },
      { trigger: 'retry', actor: 'tester' },
    );
    expect(dispatch).toMatchObject({
      status: 'blocked',
      reason: expect.stringMatching(/Blueprint rollout/i),
    });
  });
});

function converted(opts: { sourcePolicy?: 'manual' | 'automatic' } = {}): {
  applicationId: string;
  stackName: string;
  nodeId: number;
} {
  counter += 1;
  const nodeId = seedNode();
  const blueprint = commitBlueprintCreate({
    name: `bp-cont-${counter}`,
    description: null,
    compose_content: 'services:\n  web:\n    image: nginx:1.27\n',
    selector: { type: 'nodes', ids: [nodeId] },
    drift_mode: 'suggest',
    classification: 'stateless',
    classification_reasons: [],
    enabled: true,
    created_by: 'tester',
  }, () => [nodeId]);
  const stackName = `cont-web-${counter}`;
  const application = {
    ...directApplicationFixture(`app-${stackName}`, stackName),
    configured_repo_url: `https://github.com/example/${stackName}.git`,
    source_policy: opts.sourcePolicy ?? 'manual',
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
  return { applicationId: application.id, stackName, nodeId };
}

function seedNode(): number {
  const result = DatabaseService.getInstance().getDb().prepare(
    `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
     VALUES (?, 'local', 'proxy', '/tmp/compose', 0, 'online', ?)`,
  ).run(`bp-cont-node-${counter}`, Date.now());
  return result.lastInsertRowid as number;
}

function seedGitSource(stackName: string): void {
  DatabaseService.getInstance().upsertGitSource({
    stack_name: stackName,
    repo_url: `https://github.com/example/${stackName}.git`,
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
}
