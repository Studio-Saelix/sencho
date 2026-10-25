import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'path';

import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { GitOpsStore, emptyTargetRow } from '../services/gitops/store';
import { GitOpsTransitions, type EventEnvelope } from '../services/gitops/transitions';
import { projectApplication, deriveGitOpsRevision } from '../services/gitops/derive';
import { NodeRegistry } from '../services/NodeRegistry';
import { encodeObservedInvocation } from '../services/gitops/json';
import type {
  GitOpsApplicationRow,
  GitOpsGenerationRow,
  GitOpsRevisionProjection,
} from '../services/gitops/types';
import { DEFAULT_PLACEMENT_POLICY, DEFAULT_ROLLOUT_AUTHORIZATION_POLICY } from '../services/gitops/policyComposition';

/**
 * The `invocation` class, against a real store and a real database.
 *
 * The three states the issue names are the whole contract: a difference
 * produces one item whose two sides are both real observations, a match
 * produces nothing, and no observation produces nothing plus a caveat rather
 * than agreement.
 */
describe('gitops invocation drift', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    GitOpsStore.resetForTests();
    GitOpsTransitions.resetForTests();
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  const NODE_ID = 1;

  /**
   * A Direct application with an accepted generation and a target that applied
   * it, which is the only shape the class is allowed to judge.
   */
  function settledDirect(id: string, stackName: string, invocationJson: string): GitOpsApplicationRow {
    const store = GitOpsStore.getInstance();
    const tx = GitOpsTransitions.getInstance();
    const generationId = `${id}-gen`;
    const application = app(id, stackName);
    tx.activateDirect({ application, nodeId: NODE_ID, envelope: env(`op-${id}-act`) });
    store.insertGeneration(gen(generationId, id, invocationJson));
    // Driven through the real transitions rather than by writing the pointers,
    // so the accepted generation and the target's applied pointer are a pair
    // production can actually produce.
    tx.fetchStarted(id, env(`op-${id}-fetch`));
    tx.fetched(id, 'abc123', env(`op-${id}-fetch`));
    tx.candidateReady(id, generationId, false, env(`op-${id}-cand`));
    tx.applied({
      applicationId: id,
      generationId,
      artifactSetId: `art-${id}`,
      sourceAcceptanceId: `acc-${id}`,
      authority: 'operator',
      envelope: env(`op-${id}-acc`),
    });
    // The deploy arm on top, so the target is converged rather than pending.
    tx.deployStarted(id, NODE_ID, generationId, env(`op-${id}-dep`));
    tx.deployBound(id, NODE_ID, generationId, env(`op-${id}-dep`));
    store.upsertTarget({
      ...store.getTarget(id, NODE_ID)!,
      desired_generation_id: generationId,
    });
    return application;
  }

  const stackDir = (stackName: string): string =>
    path.join(NodeRegistry.getInstance().getComposeDir(NODE_ID), stackName);

  const observation = (stackName: string, overrides: Record<string, unknown> = {}): string =>
    encodeObservedInvocation({
      composeFileOrder: ['compose.yaml'],
      projectName: stackName.toLowerCase(),
      projectDirectory: '.',
      envFileOrder: [],
      observedAt: 1_700_000_000_000,
      ...overrides,
    } as Parameters<typeof encodeObservedInvocation>[0]);

  /**
   * The argv Compose is given for a single-file selection, which is no flags at
   * all. The whole single-file branch of the design hangs off this being the
   * real value rather than a convenient one.
   */
  const singleFileArgv = (): string => JSON.stringify([]);

  const project = (applicationId: string): GitOpsRevisionProjection => {
    const revision = projectApplication(applicationId, false);
    if (revision.targetMode === 'not_applicable') throw new Error('expected application');
    return revision;
  };

  const limitationCodes = (revision: GitOpsRevisionProjection): string[] =>
    revision.limitations.map((limitation) => limitation.code);

  const setObservation = (applicationId: string, raw: string | null): void => {
    GitOpsStore.getInstance().upsertTarget({
      ...GitOpsStore.getInstance().getTarget(applicationId, NODE_ID)!,
      observed_invocation_json: raw,
    });
  };

  it('reports one item when the node is running another invocation than was authored', () => {
    const stack = 'inv-diff-web';
    settledDirect('app-inv-diff', stack, singleFileArgv());
    // The stack is running an override Compose was pointed at by hand. The
    // accepted generation named compose.yaml, so both sides of the item are
    // real observations rather than one real side and a permanent unknown.
    setObservation('app-inv-diff', observation(stack, { composeFileOrder: ['override.yml'] }));

    const revision = project('app-inv-diff');
    const items = revision.drift.filter((item) => item.class === 'invocation');
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item?.expected).toEqual({
      kind: 'invocation',
      authored: {
        composeFileOrder: ['compose.yaml'],
        projectName: stack,
        projectDirectory: '.',
        envFileOrder: [],
      },
    });
    expect(item?.observed).toEqual({
      kind: 'observed_invocation',
      observed: {
        composeFileOrder: ['override.yml'],
        projectName: stack,
        projectDirectory: '.',
        envFileOrder: [],
      },
      observedAt: 1_700_000_000_000,
    });
    // The evidence carries its own age, so a reader can judge it.
    expect(item?.freshnessAt).toBe(1_700_000_000_000);
    expect(item?.owner).toBe('ComposeService');
    expect(item?.reason).toBe('the compose invocation on this node is not the one this generation was applied with');
    expect(item?.affectedTargets).toEqual([{ nodeId: NODE_ID, stackName: stack }]);
    // The policy is read off the stack's Git source row, which this fixture
    // does not create, so the item carries null rather than a policy nothing
    // wrote.
    expect(item?.configuredPolicy).toBeNull();
  });

  it('reports nothing when the observed invocation matches the authored one', () => {
    const stack = 'inv-match-web';
    settledDirect('app-inv-match', stack, singleFileArgv());
    setObservation('app-inv-match', observation(stack));

    const revision = project('app-inv-match');
    expect(revision.drift.filter((item) => item.class === 'invocation')).toHaveLength(0);
    expect(limitationCodes(revision)).not.toContain('invocation_observation_missing');
  });

  it('reports nothing and says why when no invocation has been observed', () => {
    const stack = 'inv-none-web';
    settledDirect('app-inv-none', stack, singleFileArgv());

    const revision = project('app-inv-none');
    expect(revision.drift.filter((item) => item.class === 'invocation')).toHaveLength(0);
    // The missing evidence is named rather than reported as agreement, which
    // is the whole reason the class does not fire on a bare pointer mismatch.
    expect(limitationCodes(revision)).toContain('invocation_observation_missing');
  });

  it('says why when the recorded observation cannot be read', () => {
    const stack = 'inv-bad-obs-web';
    settledDirect('app-inv-bad-obs', stack, singleFileArgv());
    setObservation('app-inv-bad-obs', '{"kind":"nonsense"}');

    const revision = project('app-inv-bad-obs');
    expect(revision.drift.filter((item) => item.class === 'invocation')).toHaveLength(0);
    expect(limitationCodes(revision)).toContain('invocation_observed_invalid');
    expect(limitationCodes(revision)).not.toContain('invocation_observation_missing');
  });

  it('says why when the generation authored no compose invocation', () => {
    // A generation that names no compose file has no expected order to compare
    // an observed one against, and inventing one would report drift on every
    // stack that was migrated in.
    const stack = 'inv-noauth-web';
    settledDirect(
      'app-inv-noauth',
      stack,
      '{"composeFileOrder":[],"projectName":null,"projectDirectory":null,"envFileOrder":[]}',
    );
    setObservation('app-inv-noauth', observation(stack));

    const revision = project('app-inv-noauth');
    expect(revision.drift.filter((item) => item.class === 'invocation')).toHaveLength(0);
    expect(limitationCodes(revision)).toContain('invocation_expected_invalid');
  });

  it('says why when the authored paths belong to a different compose directory', () => {
    // The shape a Direct target has when its argv was built against another
    // node's compose directory. Reporting a mount path as drift would be
    // fabricated on every such target.
    const stack = 'inv-elsewhere-web';
    settledDirect('app-inv-elsewhere', stack, JSON.stringify(['-f', '/somewhere/else/compose.yaml', '-p', stack]));
    setObservation('app-inv-elsewhere', observation(stack));

    const revision = project('app-inv-elsewhere');
    expect(revision.drift.filter((item) => item.class === 'invocation')).toHaveLength(0);
    expect(limitationCodes(revision)).toContain('invocation_expected_invalid');
  });

  it('reports a difference in the project directory, not only the file order', () => {
    const stack = 'inv-dir-web';
    settledDirect(
      'app-inv-dir',
      stack,
      JSON.stringify(['-f', 'compose.yaml', '-p', stack, '--project-directory', 'ctx']),
    );
    setObservation('app-inv-dir', observation(stack, { projectDirectory: '.' }));

    const items = project('app-inv-dir').drift.filter((item) => item.class === 'invocation');
    expect(items).toHaveLength(1);
    expect(items[0]?.expected).toEqual({
      kind: 'invocation',
      authored: {
        composeFileOrder: ['compose.yaml'],
        projectName: stack,
        projectDirectory: 'ctx',
        envFileOrder: [],
      },
    });
  });

  it('compares against the target\'s own stack directory', () => {
    // Both sides are reduced against the stack directory of the node the target
    // is deployed on, so the same observation matches regardless of where the
    // compose directory happens to be mounted.
    const stack = 'inv-mount-web';
    settledDirect('app-inv-mount', stack, JSON.stringify([
      '-f', path.join(stackDir(stack), 'compose.yaml'),
      '-p', stack,
    ]));
    setObservation('app-inv-mount', observation(stack));

    expect(project('app-inv-mount').drift.filter((item) => item.class === 'invocation')).toHaveLength(0);
  });

  it('stays quiet while the target is still deploying', () => {
    const stack = 'inv-inflight-web';
    settledDirect('app-inv-inflight', stack, singleFileArgv());
    // A deploy in flight means the pointers and the observation describe
    // different moments, so a caveat here would be noise on every apply.
    GitOpsStore.getInstance().upsertTarget({
      ...GitOpsStore.getInstance().getTarget('app-inv-inflight', NODE_ID)!,
      active_operation_stage: 'deploy_started',
    });
    setObservation('app-inv-inflight', observation(stack, { composeFileOrder: ['override.yml'] }));

    const revision = project('app-inv-inflight');
    expect(revision.drift.filter((item) => item.class === 'invocation')).toHaveLength(0);
    expect(limitationCodes(revision)).not.toContain('invocation_observation_missing');
  });

  it('stays quiet on a target whose applied pointer is behind the accepted generation', () => {
    // Acceptance binds both pointers together, so this state is reached only
    // by a recovery or a resumed apply. The application row is built directly
    // for the same reason: the gate is a defensive predicate, and the point of
    // the test is the predicate rather than a transition sequence that would
    // never produce it.
    const stack = 'inv-unapplied-web';
    const id = 'app-inv-unapplied';
    const older = `${id}-older`;
    const accepted = `${id}-gen`;
    const store = GitOpsStore.getInstance();
    store.insertGeneration(gen(older, id, singleFileArgv()));
    store.insertGeneration(gen(accepted, id, singleFileArgv()));

    const revision = deriveGitOpsRevision({
      application: { ...app(id, stack), accepted_generation_id: accepted },
      targets: [{
        ...emptyTargetRow(id, NODE_ID, 1),
        applied_generation_id: older,
        deployed_generation_id: older,
        observed_invocation_json: observation(stack, { composeFileOrder: ['override.yml'] }),
      }],
      healthDisabled: true,
    }, null);
    if (revision.targetMode === 'not_applicable') throw new Error('expected application');
    expect(revision.drift.filter((item) => item.class === 'invocation')).toHaveLength(0);
    expect(limitationCodes(revision)).not.toContain('invocation_observation_missing');
  });

  it('reports nothing for a Blueprint target', () => {
    // A Blueprint target is deployed under its own deploy stack name, and the
    // argv its generation carries was authored for the source stack, so there
    // is no correct expected side to compare against.
    const store = GitOpsStore.getInstance();
    const id = 'app-inv-bp';
    const generationId = `${id}-gen`;
    const application: GitOpsApplicationRow = {
      ...app(id, 'inv-bp-web'),
      target_mode: 'blueprint',
      stack_name: null,
      configured_source_stack_name: null,
      lifecycle_key: 'blueprint:404',
      blueprint_id: 404,
    };
    store.insertApplication(application);
    store.insertGeneration(gen(generationId, id, singleFileArgv()));
    store.upsertTarget({
      ...emptyTargetRow(id, NODE_ID, 1),
      applied_generation_id: generationId,
    });
    setObservation(id, observation('inv-bp-web', { composeFileOrder: ['override.yml'] }));

    const revision = project(id);
    expect(revision.drift.filter((item) => item.class === 'invocation')).toHaveLength(0);
    expect(limitationCodes(revision)).not.toContain('invocation_observation_missing');
  });
});

function env(operationId: string): EventEnvelope {
  return { operationId, actor: 'tester', trigger: 'manual', at: 1 };
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
    pause_origin: 'operator',
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

function gen(id: string, applicationId: string, expectedInvocationJson: string): GitOpsGenerationRow {
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
    expected_invocation_json: expectedInvocationJson,
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
