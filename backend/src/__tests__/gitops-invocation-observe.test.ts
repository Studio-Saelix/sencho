import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { GitOpsStore } from '../services/gitops/store';
import { GitOpsTransitions, type EventEnvelope } from '../services/gitops/transitions';
import { observeStackInvocation, recordObservedInvocationForDeploy } from '../services/gitops/invocationObserve';
import { decodeObservedInvocation } from '../services/gitops/json';
import { NodeRegistry } from '../services/NodeRegistry';
import type { GitOpsApplicationRow, GitOpsGenerationRow } from '../services/gitops/types';
import { DEFAULT_PLACEMENT_POLICY, DEFAULT_ROLLOUT_AUTHORIZATION_POLICY } from '../services/gitops/policyComposition';

const mockListContainers = vi.fn();

vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({
      getDocker: () => ({
        listContainers: (...args: unknown[]) => mockListContainers(...args),
      }),
    }),
  },
}));

const NODE_ID = 1;
const STACK = 'invoke-observe-web';

/**
 * The read side of the invocation observation: what Compose's own labels say
 * about how the project on the node was brought up.
 *
 * The labels are the whole point. Reading the argv Sencho built would confirm
 * Sencho's own belief, and an invocation made on the node by hand is exactly
 * what this evidence has to be able to see.
 */
describe('invocation observation', () => {
  let tmpDir: string;
  let stackDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
    stackDir = `${NodeRegistry.getInstance().getComposeDir(NODE_ID)}/${STACK}`;
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
    vi.restoreAllMocks();
  });

  const projectLabels = (overrides: Record<string, string> = {}): Record<string, string> => ({
    'com.docker.compose.project': STACK,
    'com.docker.compose.project.config_files': `${stackDir}/compose.yaml`,
    'com.docker.compose.project.working_dir': stackDir,
    ...overrides,
  });

  it('reads the invocation off the project container labels', async () => {
    mockListContainers.mockResolvedValueOnce([{ Labels: projectLabels() }]);
    const observed = await observeStackInvocation({ stackName: STACK, nodeId: NODE_ID, observedAt: 7 });
    expect(observed).toEqual({
      composeFileOrder: ['compose.yaml'],
      projectName: STACK,
      projectDirectory: '.',
      envFileOrder: [],
      observedAt: 7,
    });
    // The filter is the compose project label, which is how the project is
    // found at all: the stack name is not a container name.
    expect(mockListContainers).toHaveBeenCalledWith({
      all: true,
      filters: { label: [`com.docker.compose.project=${STACK}`] },
    });
  });

  it('reads a multi-file order, an env file list, and a project subdirectory', async () => {
    mockListContainers.mockResolvedValueOnce([{
      Labels: projectLabels({
        'com.docker.compose.project.config_files': `${stackDir}/compose.yaml,${stackDir}/override.yml`,
        'com.docker.compose.project.environment_file': `${stackDir}/.env`,
        'com.docker.compose.project.working_dir': `${stackDir}/ctx`,
      }),
    }]);
    const observed = await observeStackInvocation({ stackName: STACK, nodeId: NODE_ID, observedAt: 1 });
    expect(observed).toEqual({
      composeFileOrder: ['compose.yaml', 'override.yml'],
      projectName: STACK,
      projectDirectory: 'ctx',
      envFileOrder: ['.env'],
      observedAt: 1,
    });
  });

  it('records nothing when the project containers disagree about the invocation', async () => {
    // An ordinary `up` recreates only the services whose configuration changed,
    // so a project can hold containers from two different invocations. Picking
    // whichever the daemon listed first would flap: two applies with nothing
    // changed on the node would alternate between reporting and clearing a drift
    // item, and could report agreement while a sibling container disagrees.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockListContainers.mockResolvedValueOnce([
      { Id: 'aaa', Labels: projectLabels() },
      { Id: 'bbb', Labels: projectLabels({
        'com.docker.compose.project.config_files': `${stackDir}/override.yml`,
      }) },
    ]);
    expect(await observeStackInvocation({ stackName: STACK, nodeId: NODE_ID })).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('reads the invocation when the containers agree, whatever order they arrive in', async () => {
    // Unanimity is the only requirement, so the answer does not depend on the
    // order the daemon happens to list the project's containers in.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const order of [['aaa', 'bbb'], ['bbb', 'aaa']]) {
      mockListContainers.mockResolvedValueOnce(order.map((Id) => ({ Id, Labels: projectLabels() })));
      expect(await observeStackInvocation({ stackName: STACK, nodeId: NODE_ID, observedAt: 1 })).toEqual({
        composeFileOrder: ['compose.yaml'],
        projectName: STACK,
        projectDirectory: '.',
        envFileOrder: [],
        observedAt: 1,
      });
    }
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('ignores a container of the project that carries no labels at all', async () => {
    // The filter is the project label, so a container can arrive with the label
    // absent from the summary. It is not evidence of an invocation and must not
    // be read as disagreeing with one that is.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockListContainers.mockResolvedValueOnce([
      { Id: 'aaa', Labels: projectLabels() },
      { Id: 'bbb' },
    ]);
    expect(await observeStackInvocation({ stackName: STACK, nodeId: NODE_ID, observedAt: 1 })).not.toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('records nothing when the project has no container on the node', async () => {
    mockListContainers.mockResolvedValueOnce([]);
    expect(await observeStackInvocation({ stackName: STACK, nodeId: NODE_ID })).toBeNull();
  });

  it('records nothing when the node cannot be reached', async () => {
    // The container list is the only call that can fail here, and a node that
    // will not answer leaves the column null rather than a synthesized value.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockListContainers.mockRejectedValueOnce(new Error('is not connected'));
    expect(await observeStackInvocation({ stackName: STACK, nodeId: NODE_ID })).toBeNull();
    errorSpy.mockRestore();
  });

  it('records nothing when the labels are not a readable invocation', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A container carrying the project label but no config_files: not something
    // Compose wrote, so there is no invocation to read.
    mockListContainers.mockResolvedValueOnce([{ Labels: { 'com.docker.compose.project': STACK } }]);
    expect(await observeStackInvocation({ stackName: STACK, nodeId: NODE_ID })).toBeNull();
    errorSpy.mockRestore();
  });

  it('records nothing when a compose file sits outside the stack directory', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockListContainers.mockResolvedValueOnce([{
      Labels: projectLabels({
        'com.docker.compose.project.config_files': '/elsewhere/compose.yaml',
      }),
    }]);
    expect(await observeStackInvocation({ stackName: STACK, nodeId: NODE_ID })).toBeNull();
    errorSpy.mockRestore();
  });

  it('writes the observation onto the target at deploy time', async () => {
    const store = GitOpsStore.getInstance();
    seedApplied('app-invoke-deploy', STACK, 'gen-invoke-deploy');
    mockListContainers.mockResolvedValue([{ Labels: projectLabels() }]);

    await recordObservedInvocationForDeploy({
      stackName: STACK,
      nodeId: NODE_ID,
      applicationId: 'app-invoke-deploy',
      envelope: envelope('op-invoke-deploy'),
    });

    expect(decodeObservedInvocation(
      store.getTarget('app-invoke-deploy', NODE_ID)?.observed_invocation_json ?? null,
    )).toEqual({
      composeFileOrder: ['compose.yaml'],
      projectName: STACK,
      projectDirectory: '.',
      envFileOrder: [],
      observedAt: 1,
    });
  });

  it('leaves the target unobserved when the node cannot be reached at deploy time', async () => {
    const store = GitOpsStore.getInstance();
    const stack = 'invoke-unreachable-web';
    seedApplied('app-invoke-unreachable', stack, 'gen-invoke-unreachable');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockListContainers.mockRejectedValueOnce(new Error('is not connected'));

    await recordObservedInvocationForDeploy({
      stackName: stack,
      nodeId: NODE_ID,
      applicationId: 'app-invoke-unreachable',
      envelope: envelope('op-invoke-unreachable'),
    });

    // A successful apply must not leave a placeholder behind: the column stays
    // null, which the projection reports as a caveat rather than as agreement.
    expect(store.getTarget('app-invoke-unreachable', NODE_ID)?.observed_invocation_json).toBeNull();
    errorSpy.mockRestore();
  });

  it('leaves the target unobserved when there is no project on the node', async () => {
    const store = GitOpsStore.getInstance();
    const stack = 'invoke-no-project-web';
    seedApplied('app-invoke-no-project', stack, 'gen-invoke-no-project');
    mockListContainers.mockResolvedValueOnce([]);

    await recordObservedInvocationForDeploy({
      stackName: stack,
      nodeId: NODE_ID,
      applicationId: 'app-invoke-no-project',
      envelope: envelope('op-invoke-no-project'),
    });

    expect(store.getTarget('app-invoke-no-project', NODE_ID)?.observed_invocation_json).toBeNull();
  });
});

function envelope(operationId: string): EventEnvelope {
  return { operationId, actor: 'tester', trigger: 'manual', at: 1 };
}

/** A Direct application with an accepted generation and one deployed target. */
function seedApplied(applicationId: string, stackName: string, generationId: string): void {
  const store = GitOpsStore.getInstance();
  const tx = GitOpsTransitions.getInstance();
  tx.activateDirect({ application: app(applicationId, stackName), nodeId: NODE_ID, envelope: envelope(`op-${applicationId}-act`) });
  store.insertGeneration(gen(generationId, applicationId));
  tx.fetchStarted(applicationId, envelope(`op-${applicationId}-fetch`));
  tx.fetched(applicationId, 'abc123', envelope(`op-${applicationId}-fetch`));
  tx.candidateReady(applicationId, generationId, false, envelope(`op-${applicationId}-cand`));
  tx.applied({
    applicationId,
    generationId,
    artifactSetId: `art-${applicationId}`,
    sourceAcceptanceId: `acc-${applicationId}`,
    authority: 'operator',
    envelope: envelope(`op-${applicationId}-acc`),
  });
  tx.deployStarted(applicationId, NODE_ID, generationId, envelope(`op-${applicationId}-dep`));
  tx.deployBound(applicationId, NODE_ID, generationId, envelope(`op-${applicationId}-dep`));
}

function app(id: string, stackName: string): GitOpsApplicationRow {
  return {
    id,
    lifecycle_key: `direct:${stackName}`,
    lifecycle_status: 'active',
    target_mode: 'direct',
    stack_name: stackName,
    configured_source_stack_name: null,
    blueprint_id: null,
    configured_repo_url: 'https://github.com/org/repo.git',
    repo_identity_json: '{"host":"github.com","pathname":"/org/repo.git"}',
    configured_ref: 'main',
    compose_paths_json: '["compose.yaml"]',
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
    review_block_reason: null,
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
    latest_preflight_evidence_json: null,
    latest_operation_id: null,
    active_operation_id: null,
    active_operation_stage: null,
    active_operation_at: null,
    active_generation_id: null,
    pause_at: null,
    pause_reason: null,
    source_suspended_reason: null,
    source_policy: 'manual',
    placement_policy: DEFAULT_PLACEMENT_POLICY,
    rollout_authorization_policy: DEFAULT_ROLLOUT_AUTHORIZATION_POLICY,
    placement_policy_refusal_reason: null,
    placement_policy_refused_at: null,
    poll_interval_secs: null,
    next_poll_at: null,
    attempt_seq: 0,
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
    commit_sha: 'abc123',
    repo_url: 'https://github.com/org/repo.git',
    resolved_ref_kind: 'branch',
    configured_ref: 'main',
    repo_identity_json: '{"host":"github.com","pathname":"/org/repo.git"}',
    manifest_version: 1,
    candidate_dir: `generations/candidate-${id}`,
    applied_dir: `generations/applied-${id}-0`,
    expected_invocation_json: '[]',
    materialization_fingerprint: 'a'.repeat(64),
    validation_ok: 1,
    plan_blocked: 0,
    change_plan_fingerprint: null,
    operation_id: `op-${id}`,
    trigger: 'manual',
    actor: 'tester',
    previous_generation_id: null,
    redacted_limitations_json: '[]',
    portable_manifest_json: null,
    compose_inputs_json: null,
    source_policy_evidence_json: null,
    security_policy_evidence_json: null,
    support_requirements_json: null,
    compatibility_requirements_json: null,
    secret_capability_json: null,
    created_at: 1,
  };
}
