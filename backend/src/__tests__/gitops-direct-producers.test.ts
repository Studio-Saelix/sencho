/**
 * End-to-end coverage for the Direct Git producers.
 *
 * Only the two boundaries the host owns are stubbed: `git.clone` writes a real
 * project into the clone directory and `git.log` returns a commit, and the
 * compose commands that need a running daemon report an exit code each test
 * chooses. Compose commands that only parse files, `config` above all, still
 * shell out for real, so the Compose CLI is a genuine prerequisite here even
 * though the daemon is not. Everything after that runs for real, so fetch,
 * candidate materialization, change-plan classification, the apply, the
 * deploy, and the detach all drive the GitOps state model the way they do in
 * production.
 *
 * This exists because the producer wiring is the seam between the operational
 * Git path and the revision state, and a mismatch there type-checks and passes
 * transition-level tests.
 */
import { EventEmitter } from 'events';
import fsPromises from 'fs/promises';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

const { mockGitClone, mockGitLog, compose } = vi.hoisted(() => ({
  mockGitClone: vi.fn(),
  mockGitLog: vi.fn(),
  /** Exit code the next daemon-dependent compose command reports. */
  compose: { exitCode: 1 },
}));

vi.mock('isomorphic-git', () => {
  const api = { clone: mockGitClone, log: mockGitLog };
  return { default: api, clone: mockGitClone, log: mockGitLog };
});
vi.mock('isomorphic-git/http/node', () => ({ default: {} }));

/**
 * Compose verbs that need a running daemon and are issued through `spawn`.
 *
 * `ps` is deliberately absent: it is issued through `execFile`, which this mock
 * does not replace, so listing it would advertise coverage that is not there.
 */
const DAEMON_COMPOSE_VERBS = new Set(['up', 'down', 'pull', 'build', 'start', 'stop', 'restart']);
const COMPOSE_FLAGS_WITH_VALUE = new Set([
  '-f', '--file', '-p', '--project-name', '--env-file', '--project-directory',
]);

/**
 * The verb in a `docker compose …` argv, skipping global flags and their
 * values so a stack or file named after a verb cannot be mistaken for one.
 */
function composeVerbOf(args: readonly string[]): string | null {
  if (args[0] !== 'compose') return null;
  for (let i = 1; i < args.length; i++) {
    const token = args[i];
    if (COMPOSE_FLAGS_WITH_VALUE.has(token)) {
      i++;
      continue;
    }
    if (token.startsWith('-')) continue;
    return token;
  }
  return null;
}

function fakeComposeChild(): EventEmitter {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  // The caller attaches its listeners synchronously after spawn returns, so the
  // exit cannot be announced until the current turn finishes.
  setImmediate(() => child.emit('close', compose.exitCode));
  return child;
}

/**
 * Only the compose commands that need a daemon are answered here; `config` and
 * everything else still runs for real.
 *
 * That split is the whole point. A deploy failing is otherwise a fact about the
 * host rather than about the adapter: a workstation with the CLI but no daemon
 * parses compose files happily and fails `up`, while a CI runner succeeds at
 * both, so any test that reads "the deploy failed" from the environment says
 * something different in the two places.
 */
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (command: string, args: readonly string[], options?: unknown) => {
      if (command === 'docker' && DAEMON_COMPOSE_VERBS.has(composeVerbOf(args) ?? '')) {
        return fakeComposeChild();
      }
      return (actual.spawn as unknown as (...a: unknown[]) => unknown)(command, args, options);
    },
  };
});

// Rollback capture talks to Docker, which is not available here. Stubbing it
// keeps the apply on its success path so the GitOps wiring is what the test
// actually exercises.
vi.mock('../services/StackUpdateRecoveryService', () => ({
  StackUpdateRecoveryService: {
    getInstance: () => ({
      captureCandidate: vi.fn(async () => ({ id: 'rec-producers-1' })),
      abandon: vi.fn(async () => true),
      markAcquired: vi.fn(() => true),
      handoff: vi.fn(() => true),
      markReconciling: vi.fn(() => true),
      markImmediateVerified: vi.fn(() => true),
      get: vi.fn(() => ({ id: 'rec-producers-1', is_current: 1 })),
      linkGateOrRetain: vi.fn(),
      compensateWithCandidate: vi.fn(async () => true),
      start: vi.fn(),
    }),
  },
}));

const REPO = 'https://github.com/example/project.git';
const COMPOSE = 'services:\n  web:\n    image: nginx:1.27\n';
const COMPOSE_V2 = 'services:\n  web:\n    image: nginx:1.28\n';
const COMPOSE_PROD = 'services:\n  web:\n    restart: always\n';

let tmpDir: string;
let GitSourceService: typeof import('../services/GitSourceService').GitSourceService;
let GitOpsStore: typeof import('../services/gitops/store').GitOpsStore;
let GitOpsTransitions: typeof import('../services/gitops/transitions').GitOpsTransitions;
let projectApplication: typeof import('../services/gitops/derive').projectApplication;

/** Make the next clone produce a project containing this compose content. */
function stageRepo(content: string, sha: string, extraFiles: Record<string, string> = {}): void {
  mockGitClone.mockImplementation(async ({ dir }: { dir: string }) => {
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(path.join(dir, 'compose.yaml'), content, 'utf8');
    for (const [name, body] of Object.entries(extraFiles)) {
      await fsPromises.writeFile(path.join(dir, name), body, 'utf8');
    }
  });
  mockGitLog.mockResolvedValue([{ oid: sha }]);
}

function projectOf(applicationId: string) {
  const projection = projectApplication(applicationId, true);
  if (projection.targetMode === 'not_applicable') throw new Error('expected an application');
  return projection;
}

describe('Direct Git producers drive the revision state', () => {
  beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ GitSourceService } = await import('../services/GitSourceService'));
    ({ GitOpsStore } = await import('../services/gitops/store'));
    ({ GitOpsTransitions } = await import('../services/gitops/transitions'));
    ({ projectApplication } = await import('../services/gitops/derive'));
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  beforeEach(() => {
    mockGitClone.mockReset();
    mockGitLog.mockReset();
    compose.exitCode = 1;
  });

  // Prototype spies a test installs are restored here rather than in a per-test
  // finally, so a failing test cannot leak one into the next. Only spies are
  // touched, so the hoisted git mocks keep the reset above.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates, fetches, applies, and detaches a Git stack through the state model', async () => {
    const svc = GitSourceService.getInstance();
    const store = GitOpsStore.getInstance();
    const stackName = 'producers-web';

    // ── create ────────────────────────────────────────────────────────────
    stageRepo(COMPOSE, 'aaaaaaa1');
    await svc.createStackFromGit({
      stackName,
      repoUrl: REPO,
      branch: 'main',
      composePaths: ['compose.yaml'],
      contextDir: null,
      syncEnv: false,
      envPath: null,
      authType: 'none',
      token: null,
      autoApplyOnWebhook: false,
      autoDeployOnApply: false,
    });

    const app = store.getLiveDirectApplication(stackName);
    expect(app).toBeTruthy();
    if (!app) throw new Error('expected an application');
    expect(app.lifecycle_status).toBe('active');
    expect(app.accepted_generation_id).not.toBeNull();
    expect(app.desired_commit_sha).toBe('aaaaaaa1');
    // The create records a secret-free identity, never the operational URL.
    expect(app.configured_repo_url).toBe('https://github.com/example/project.git');
    // The success boundary cleared its own checkpoint.
    expect(store.getCreateCheckpoint(app.id)).toBeUndefined();

    const afterCreate = projectOf(app.id);
    expect(afterCreate.facets.source.status).toBe('application_generation_accepted');
    expect(afterCreate.targets[0]?.runtime.status).toBe('applied_not_deployed');

    // ── fetch a newer commit ──────────────────────────────────────────────
    stageRepo(COMPOSE_V2, 'bbbbbbb2');
    await svc.pull(stackName, { actor: 'tester' });

    const afterPull = store.getApplication(app.id)!;
    expect(afterPull.desired_commit_sha).toBe('bbbbbbb2');
    expect(afterPull.fetched_commit_sha).toBe('bbbbbbb2');
    // A fetch advances the resolved commit and offers a candidate, but the
    // accepted generation does not move until the apply.
    expect(afterPull.accepted_generation_id).toBe(app.accepted_generation_id);
    expect(afterPull.candidate_generation_id).not.toBeNull();
    expect(afterPull.candidate_generation_id).not.toBe(app.accepted_generation_id);

    const candidateId = afterPull.candidate_generation_id!;
    const candidate = store.getGeneration(candidateId)!;
    expect(candidate.commit_sha).toBe('bbbbbbb2');
    expect(candidate.application_id).toBe(app.id);
    expect(candidate.materialization_fingerprint).toBe(afterPull.materialization_fingerprint);
    expect(store.getTarget(app.id, 1)?.candidate_generation_id).toBe(candidateId);
    expect(projectOf(app.id).availableActions).toContain('apply');

    // ── apply ─────────────────────────────────────────────────────────────
    await svc.apply(stackName, 'bbbbbbb2', { requirePlanFingerprint: false, deploy: false, actor: 'tester' });

    const afterApply = store.getApplication(app.id)!;
    expect(afterApply.accepted_generation_id).toBe(candidateId);
    expect(afterApply.candidate_generation_id).toBeNull();
    expect(afterApply.active_operation_stage).toBeNull();
    expect(afterApply.source_acceptance_ref).not.toBeNull();

    const target = store.getTarget(app.id, 1)!;
    expect(target.desired_generation_id).toBe(candidateId);
    expect(target.applied_generation_id).toBe(candidateId);
    expect(target.candidate_generation_id).toBeNull();

    // The acceptance is provable against the exact generation it authorized.
    expect(store.resolveApprovalRef(afterApply.source_acceptance_ref!, {
      kind: 'source_acceptance',
      applicationId: app.id,
      generationId: candidateId,
    })).toBeTruthy();
    expect(store.resolveApprovalRef(afterApply.source_acceptance_ref!, {
      kind: 'source_acceptance',
      applicationId: app.id,
      generationId: app.accepted_generation_id!,
    })).toBeNull();

    // ── detach ────────────────────────────────────────────────────────────
    await svc.detach(stackName);

    expect(store.getLiveDirectApplication(stackName)).toBeUndefined();
    const tombstoned = store.getApplication(app.id)!;
    expect(tombstoned.lifecycle_status).toBe('detached');
    // Configured identity and resolved commit survive as frozen facts.
    expect(tombstoned.configured_repo_url).toBe('https://github.com/example/project.git');
    expect(tombstoned.desired_commit_sha).toBe('bbbbbbb2');
    expect(store.getTarget(app.id, 1)?.target_status).toBe('tombstoned');
    expect(projectOf(app.id).facets.source.status).toBe('not_live');
  });

  it('binds the deployed generation through the Compose adapter', async () => {
    const { ComposeService } = await import('../services/ComposeService');
    const { default: DockerController } = await import('../services/DockerController');
    const svc = GitSourceService.getInstance();
    const store = GitOpsStore.getInstance();
    const stackName = 'producers-deploy';

    stageRepo(COMPOSE, '11111111');
    await svc.createStackFromGit({
      stackName,
      repoUrl: REPO,
      branch: 'main',
      composePaths: ['compose.yaml'],
      contextDir: null,
      syncEnv: false,
      envPath: null,
      authType: 'none',
      token: null,
      autoApplyOnWebhook: false,
      autoDeployOnApply: false,
    });
    const app = store.getLiveDirectApplication(stackName)!;
    const applied = store.getTarget(app.id, 1)!.applied_generation_id;
    expect(applied).not.toBeNull();
    expect(store.getTarget(app.id, 1)?.deployed_generation_id).toBeNull();

    // The post-deploy probe asks the daemon what came up. It is not what this
    // test is about, and `getInstance` hands back a fresh controller each call,
    // so the stubs go on the prototype. `afterEach` restores them, so a failing
    // test cannot leak one into the next.
    const composeSvc = ComposeService.getInstance(1);
    vi.spyOn(DockerController.prototype, 'getLegacyOrphanContainersByStack')
      .mockResolvedValue([]);
    vi.spyOn(DockerController.prototype, 'getDocker')
      .mockReturnValue({ listContainers: async () => [] } as unknown as ReturnType<
        typeof DockerController.prototype.getDocker
      >);

    // ── the compose command fails ──────────────────────────────────────
    compose.exitCode = 1;
    await expect(composeSvc.deployStack(stackName)).rejects.toThrow();

    const failed = store.getTarget(app.id, 1)!;
    expect(failed.deployed_generation_id).toBeNull();
    expect(failed.failure_stage).toBe('deploy');
    // Classified conservatively: once the compose command has been handed
    // off, we cannot prove the workload was untouched, and claiming it was
    // intact would be the more dangerous error.
    expect(failed.failure_class).toBe('post_mutation');
    expect(projectOf(app.id).targets[0]?.runtime.status).toBe('failed_after_mutation');
    expect(failed.applied_generation_id).toBe(applied);

    // ── the compose command succeeds ───────────────────────────────────
    compose.exitCode = 0;
    const result = await composeSvc.deployStack(stackName);

    // The adapter reports the generation it bound, which is what lets the
    // caller start health against that exact generation rather than against
    // whatever is applied by the time health runs.
    expect(result.deployedGenerationId).toBe(applied);

    const bound = store.getTarget(app.id, 1)!;
    expect(bound.deployed_generation_id).toBe(applied);
    expect(bound.applied_generation_id).toBe(applied);
    // A bound deploy clears the earlier failure: the target is no longer in
    // the state the operator was asked to act on.
    expect(bound.failure_stage).toBeNull();
    expect(bound.failure_class).toBeNull();
    expect(projectOf(app.id).targets[0]?.runtime.status).not.toBe('failed_after_mutation');
  });

  it('reports the deployed generation from an update so health can bind to it', async () => {
    const { ComposeService } = await import('../services/ComposeService');
    const { StackUpdateOrchestrator } = await import('../services/StackUpdateOrchestrator');
    const svc = GitSourceService.getInstance();
    const store = GitOpsStore.getInstance();
    const stackName = 'producers-update';

    stageRepo(COMPOSE, '22222222');
    await svc.createStackFromGit({
      stackName,
      repoUrl: REPO,
      branch: 'main',
      composePaths: ['compose.yaml'],
      contextDir: null,
      syncEnv: false,
      envPath: null,
      authType: 'none',
      token: null,
      autoApplyOnWebhook: false,
      autoDeployOnApply: false,
    });
    const app = store.getLiveDirectApplication(stackName)!;
    const applied = store.getTarget(app.id, 1)!.applied_generation_id;

    // The image pull fails, so the update dies during preparation, before the
    // recreate Compose is handed anything. The deploy operation is opened only
    // at that recreate, so nothing is recorded: an update that never touched
    // the workload must not leave a deploy failure behind for the deriver to
    // report.
    compose.exitCode = 1;
    await expect(ComposeService.getInstance(1).updateStack(stackName)).rejects.toThrow();
    const target = store.getTarget(app.id, 1)!;
    expect(target.deployed_generation_id).toBeNull();
    expect(target.failure_stage).toBeNull();
    expect(target.active_operation_stage).toBeNull();
    expect(target.applied_generation_id).toBe(applied);
    expect(projectOf(app.id).targets[0]?.runtime.status).toBe('applied_not_deployed');

    // The same holds through the orchestrator, which is what the update callers
    // actually use and which carries the binding on to beginStack.
    await expect(StackUpdateOrchestrator.getInstance().execute(
      { nodeId: 1, stackName, target: { scope: 'stack' }, trigger: 'manual', actor: 'tester' },
      { atomic: false, terminalWs: null },
    )).rejects.toThrow();
    expect(store.getTarget(app.id, 1)?.failure_stage).toBeNull();
  });

  it('records a failed fetch without moving any pointer', async () => {
    const svc = GitSourceService.getInstance();
    const store = GitOpsStore.getInstance();
    const stackName = 'producers-fail';

    stageRepo(COMPOSE, 'ccccccc3');
    await svc.createStackFromGit({
      stackName,
      repoUrl: REPO,
      branch: 'main',
      composePaths: ['compose.yaml'],
      contextDir: null,
      syncEnv: false,
      envPath: null,
      authType: 'none',
      token: null,
      autoApplyOnWebhook: false,
      autoDeployOnApply: false,
    });
    const app = store.getLiveDirectApplication(stackName)!;
    const acceptedBefore = app.accepted_generation_id;

    mockGitClone.mockRejectedValue(new Error('could not resolve host'));
    await expect(svc.pull(stackName, { actor: 'tester' })).rejects.toThrow();

    const afterFailure = store.getApplication(app.id)!;
    expect(afterFailure.failure_stage).toBe('fetch');
    expect(afterFailure.active_operation_stage).toBeNull();
    expect(afterFailure.accepted_generation_id).toBe(acceptedBefore);
    expect(afterFailure.candidate_generation_id).toBeNull();

    const projection = projectOf(app.id);
    expect(projection.facets.source.status).toBe('source_failed');
    expect(projection.availableActions).toContain('fetch');

    // A later successful fetch clears the failure.
    stageRepo(COMPOSE_V2, 'ddddddd4');
    await svc.pull(stackName, { actor: 'tester' });
    expect(store.getApplication(app.id)?.failure_stage).toBeNull();
  });

  it('brings a newly linked stack into the model and invalidates its candidate on a material edit', async () => {
    const svc = GitSourceService.getInstance();
    const store = GitOpsStore.getInstance();
    const stackName = 'producers-link';

    const composeDir = process.env.COMPOSE_DIR!;
    await fsPromises.mkdir(path.join(composeDir, stackName), { recursive: true });
    await fsPromises.writeFile(path.join(composeDir, stackName, 'compose.yaml'), COMPOSE, 'utf8');

    stageRepo(COMPOSE, '33333333');
    await svc.upsert({
      stackName,
      repoUrl: REPO,
      branch: 'main',
      composePaths: ['compose.yaml'],
      contextDir: null,
      syncEnv: false,
      envPath: null,
      authType: 'none',
      token: null,
      autoApplyOnWebhook: false,
      autoDeployOnApply: false,
    });

    const app = store.getLiveDirectApplication(stackName);
    expect(app).toBeTruthy();
    if (!app) throw new Error('expected an application');
    // Linked, not fetched: nothing is desired or accepted until a pull runs.
    expect(app.lifecycle_status).toBe('active');
    expect(app.desired_commit_sha).toBeNull();
    expect(app.accepted_generation_id).toBeNull();
    let projection = projectOf(app.id);
    expect(projection.facets.source.status).toBe('never_reconciled');
    expect(projection.availableActions).toContain('fetch');

    // A pull produces a candidate against the current configuration.
    stageRepo(COMPOSE_V2, '44444444');
    await svc.pull(stackName, { actor: 'tester' });
    const candidateId = store.getApplication(app.id)!.candidate_generation_id;
    expect(candidateId).not.toBeNull();

    // A credential-only edit changes nothing material, so the candidate stands.
    stageRepo(COMPOSE_V2, '44444444');
    await svc.upsert({
      stackName,
      repoUrl: REPO,
      branch: 'main',
      composePaths: ['compose.yaml'],
      contextDir: null,
      syncEnv: false,
      envPath: null,
      authType: 'none',
      token: null,
      autoApplyOnWebhook: true,
      autoDeployOnApply: false,
    });
    expect(store.getApplication(app.id)?.candidate_generation_id).toBe(candidateId);

    // Changing the compose file set does invalidate it: that candidate was
    // built from a different set and can no longer be applied.
    stageRepo(COMPOSE_V2, '44444444', { 'compose.prod.yaml': COMPOSE_PROD });
    await svc.upsert({
      stackName,
      repoUrl: REPO,
      branch: 'main',
      composePaths: ['compose.yaml', 'compose.prod.yaml'],
      contextDir: null,
      syncEnv: false,
      envPath: null,
      authType: 'none',
      token: null,
      autoApplyOnWebhook: true,
      autoDeployOnApply: false,
    });
    const afterEdit = store.getApplication(app.id)!;
    expect(afterEdit.candidate_generation_id).toBeNull();
    expect(afterEdit.desired_commit_sha).toBeNull();
    expect(store.getTarget(app.id, 1)?.candidate_generation_id).toBeNull();
    projection = projectOf(app.id);
    expect(projection.availableActions).toContain('fetch');
    expect(projection.availableActions).not.toContain('apply');
  });

  it('retires the application when the stack itself is deleted', async () => {
    const { DeployedStackDeletionService } = await import('../services/DeployedStackDeletionService');
    const svc = GitSourceService.getInstance();
    const store = GitOpsStore.getInstance();
    const stackName = 'producers-delete';

    stageRepo(COMPOSE, '55555555');
    await svc.createStackFromGit({
      stackName,
      repoUrl: REPO,
      branch: 'main',
      composePaths: ['compose.yaml'],
      contextDir: null,
      syncEnv: false,
      envPath: null,
      authType: 'none',
      token: null,
      autoApplyOnWebhook: false,
      autoDeployOnApply: false,
    });
    const app = store.getLiveDirectApplication(stackName)!;

    await DeployedStackDeletionService.getInstance().deleteDeployedStack({
      nodeId: 1,
      stackName,
      pruneVolumes: false,
      actor: 'tester',
    });

    // A deleted stack must not leave a live application behind: it would keep
    // claiming the name and block re-creating it.
    expect(store.getLiveDirectApplication(stackName)).toBeUndefined();
    expect(store.getApplication(app.id)?.lifecycle_status).toBe('deleted');
    expect(store.getTarget(app.id, 1)?.target_status).toBe('tombstoned');
  });

  it('closes the operation when a terminal transition is rejected', async () => {
    const svc = GitSourceService.getInstance();
    const store = GitOpsStore.getInstance();
    const stackName = 'producers-reject';

    stageRepo(COMPOSE, '66666666');
    await svc.createStackFromGit({
      stackName,
      repoUrl: REPO,
      branch: 'main',
      composePaths: ['compose.yaml'],
      contextDir: null,
      syncEnv: false,
      envPath: null,
      authType: 'none',
      token: null,
      autoApplyOnWebhook: false,
      autoDeployOnApply: false,
    });
    const app = store.getLiveDirectApplication(stackName)!;

    // Reject the transition that closes a fetch. Recording must not fail the
    // pull, but it must not leave the operation open either: a fetch that never
    // terminates blocks every later pull from being recorded at all.
    const tx = GitOpsTransitions.getInstance();
    const realFetched = tx.fetched.bind(tx);
    tx.fetched = () => { throw new Error('rejected for test'); };
    try {
      stageRepo(COMPOSE_V2, '77777777');
      await svc.pull(stackName, { actor: 'tester' });
    } finally {
      tx.fetched = realFetched;
    }

    const afterReject = store.getApplication(app.id)!;
    expect(afterReject.active_operation_stage).toBeNull();
    expect(afterReject.failure_stage).toBe('fetch');
    // The projection reports an error the operator can act on, not a spinner.
    const projection = projectOf(app.id);
    expect(projection.facets.source.status).toBe('source_failed');
    expect(projection.availableActions).toContain('fetch');

    // And the next pull records normally, rather than being locked out.
    stageRepo(COMPOSE_V2, '88888888');
    await svc.pull(stackName, { actor: 'tester' });
    const recovered = store.getApplication(app.id)!;
    expect(recovered.fetched_commit_sha).toBe('88888888');
    expect(recovered.failure_stage).toBeNull();
    expect(recovered.active_operation_stage).toBeNull();
  });

  it('leaves a stack with no GitOps application untouched', async () => {
    const svc = GitSourceService.getInstance();
    const store = GitOpsStore.getInstance();
    const stackName = 'producers-legacy';

    // A Git stack exactly as an install carries it across an upgrade: the
    // source row was written before this model existed, so there is no
    // application and nothing has migrated it yet. Seeded directly, because
    // linking through the service now creates one.
    const composeDir = process.env.COMPOSE_DIR!;
    await fsPromises.mkdir(path.join(composeDir, stackName), { recursive: true });
    await fsPromises.writeFile(path.join(composeDir, stackName, 'compose.yaml'), COMPOSE, 'utf8');
    (await import('../services/DatabaseService')).DatabaseService.getInstance().upsertGitSource({
      stack_name: stackName,
      repo_url: REPO,
      branch: 'main',
      compose_path: 'compose.yaml',
      compose_paths: ['compose.yaml'],
      context_dir: null,
      sync_env: false,
      env_path: null,
      auth_type: 'none',
      encrypted_token: null,
      auto_apply_on_webhook: false,
      auto_deploy_on_apply: false,
      last_applied_commit_sha: 'eeeeeee5',
      last_applied_content_hash: null,
      pending_commit_sha: null,
      pending_compose_content: null,
      pending_env_content: null,
      pending_fetched_at: null,
      last_debounce_at: null,
    });
    expect(store.getLiveDirectApplication(stackName)).toBeUndefined();

    stageRepo(COMPOSE_V2, 'fffffff6');
    await svc.pull(stackName, { actor: 'tester' });

    // The pull succeeded operationally and wrote no GitOps rows.
    expect(store.getLiveDirectApplication(stackName)).toBeUndefined();
    const historyRows = (await import('../services/DatabaseService')).DatabaseService
      .getInstance().getDb()
      .prepare('SELECT COUNT(*) AS n FROM gitops_history WHERE stack_name = ?')
      .get(stackName) as { n: number };
    expect(historyRows.n).toBe(0);
  });
});
