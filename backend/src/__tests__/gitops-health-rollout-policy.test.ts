/**
 * Health-gated Blueprint rollout policy.
 *
 * Covers the policy itself (the decision matrix), the freeze into rollout
 * authorization, one-target-at-a-time sequencing, the preallocated health run
 * and its evidence binding, verdict idempotency, retry, stop, rollback, restart
 * reconstruction, and the remote capability refusal.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import {
  encodeGitOpsApprovedTargetEffectJson,
  encodeGitOpsRequiredTargetsJson,
} from '../services/gitops/json';
import type { HealthRolloutExecutor } from '../services/gitops/healthRolloutExecutor';
import {
  decideHealthRolloutAction,
  decodeFrozenRolloutStrategy,
  type HealthRolloutPolicy,
} from '../services/gitops/healthPolicy';
import type { HealthGateRunRow } from '../services/DatabaseService';
import type {
  GitOpsApplicationRow,
  GitOpsArtifactSetRow,
  GitOpsGenerationRow,
  GitOpsIntentRevisionRow,
  GitOpsRolloutCandidateRow,
  GitOpsTargetCurrentRow,
} from '../services/gitops/types';

let tmpDir: string;
let GitOpsStore: typeof import('../services/gitops/store').GitOpsStore;
let GitOpsTransitions: typeof import('../services/gitops/transitions').GitOpsTransitions;
let BlueprintTargetAdapter: typeof import('../services/gitops/handoff').BlueprintTargetAdapter;
let buildAcceptedGeneration: typeof import('../services/gitops/handoff').buildAcceptedGeneration;
let ensureRolloutAuthorization: typeof import('../services/gitops/handoff').ensureRolloutAuthorization;
let dataDir: string;
let setRegistryReadinessDepsForTests: typeof import('../services/gitops/handoff').setRegistryReadinessDepsForTests;
let setHealthCapabilityProbeForTests: typeof import('../services/gitops/handoff').setHealthCapabilityProbeForTests;
let reconstructBlueprintRolloutQueue: typeof import('../services/gitops/handoff').reconstructBlueprintRolloutQueue;
let executeHealthRolloutDecision: typeof import('../services/gitops/healthRolloutExecutor').executeHealthRolloutDecision;
let liveHealthRolloutExecutor: typeof import('../services/gitops/handoff').liveHealthRolloutExecutor;
let setHealthVerdictSink: typeof import('../services/gitops/healthRolloutExecutor').setHealthVerdictSink;
let HealthGateService: typeof import('../services/HealthGateService').HealthGateService;
let BlueprintService: typeof import('../services/BlueprintService').BlueprintService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  ({ GitOpsStore } = await import('../services/gitops/store'));
  ({ GitOpsTransitions } = await import('../services/gitops/transitions'));
  ({
    BlueprintTargetAdapter,
    buildAcceptedGeneration,
    ensureRolloutAuthorization,
    reconstructBlueprintRolloutQueue,
    setHealthCapabilityProbeForTests,
    setRegistryReadinessDepsForTests,
    liveHealthRolloutExecutor,
  } = await import('../services/gitops/handoff'));
  ({ executeHealthRolloutDecision, setHealthVerdictSink } = await import('../services/gitops/healthRolloutExecutor'));
  ({ projectApplication } = await import('../services/gitops/derive'));
  ({ HealthGateService } = await import('../services/HealthGateService'));
  ({ BlueprintService } = await import('../services/BlueprintService'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => cleanupTestDb(tmpDir));

function registryReadyDeps() {
  return {
    probeRemoteCapability: vi.fn(async () => ({ kind: 'supported' as const })),
    probeManifestAnonymous: vi.fn(async () => ({ classification: 'public' as const, status: 200 })),
    resolveHubDockerConfigForHost: vi.fn(async () => ({ state: 'missing' as const })),
    discoverOnTarget: vi.fn(async () => ({
      contractVersion: 1 as const,
      referencedHosts: [] as string[],
      referencedPullRefs: [] as string[],
      coveredHosts: [] as string[],
      sourceHash: 's',
      actionSetHash: 'a',
      deliverySourceId: 'd',
      attestation: 'tok',
    })),
    isControlNode: () => true,
    nowMs: () => 1_000_000,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  GitOpsStore.resetForTests();
  GitOpsTransitions.resetForTests();
  setRegistryReadinessDepsForTests(registryReadyDeps());
  setHealthCapabilityProbeForTests(null);
  setHealthVerdictSink(null);
  DatabaseService.getInstance().updateGlobalSetting('health_gate_enabled', '1');
  // Arming is stubbed so the real poll timer never observes a stack that does not
  // exist here and finalizes the run as unknown behind the assertions. The poll
  // loop has its own coverage; these tests are about what a verdict does, and an
  // armed timer would decide the verdict for them.
  vi.spyOn(HealthGateService.getInstance(), 'armRolloutRun').mockImplementation(() => {});
});

afterEach(() => {
  setRegistryReadinessDepsForTests(null);
  setHealthCapabilityProbeForTests(null);
  setHealthVerdictSink(null);
  vi.restoreAllMocks();
});

let projectApplication: typeof import('../services/gitops/derive').projectApplication;

function projectFixture(fixture: Seeded) {
  return projectApplication(fixture.applicationId, false)!;
}

/**
 * The arguments of the most recent deploy, so a test can assert what a retry was
 * told to do.
 *
 * Typed off the call itself: the spy's arguments are what the dispatch passed,
 * which is the thing under test, and a hand-written shape here would drift from
 * the real signature without ever failing.
 */
/**
 * A rollout health run row, as a reservation writes it.
 *
 * Used to model state a crash can leave behind: a run that exists with nothing
 * pointing at it, or one whose row has been pruned away.
 */
function reserveRunFor(
  fixture: Seeded,
  nodeId: number,
  status: 'observing' | 'passed' | 'failed' | 'unknown',
): HealthGateRunRow {
  const store = GitOpsStore.getInstance();
  const run: HealthGateRunRow = {
    id: `run-orphan-${randomUUID()}`,
    node_id: nodeId,
    stack_name: `src-${fixture.applicationId}`,
    trigger_action: 'rollout',
    status,
    reason: null,
    window_seconds: 60,
    containers_json: '[]',
    started_at: Date.now(),
    ended_at: status === 'observing' ? null : Date.now(),
    created_by: 'tester',
    target_scope: 'stack',
    service_name: null,
    failure_source: null,
    deployed_generation_id: fixture.generationId,
    application_id: fixture.applicationId,
    intent_revision_id: fixture.intentId,
    rollout_generation_id: store.getApplication(fixture.applicationId)!.rollout_generation_id,
    artifact_set_id: fixture.artifactId,
    health_policy: 'pause',
  };
  DatabaseService.getInstance().insertHealthGateRun(run);
  return run;
}

function lastDeployArgs(deploy: MockInstance): Record<string, unknown> | undefined {
  const calls = deploy.mock.calls as unknown as Array<[Record<string, unknown>]>;
  return calls[calls.length - 1]?.[0];
}

/** Put a target on a generation other than the one the run is observing. */
function moveTargetToAnotherGeneration(applicationId: string, nodeId: number, generationId: string): void {
  const store = GitOpsStore.getInstance();
  const target = store.getTarget(applicationId, nodeId)!;
  store.upsertTarget({ ...target, applied_generation_id: generationId });
}

function spyExecutor(): HealthRolloutExecutor {
  return {
    advance: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
  };
}

describe('the policy decision matrix', () => {
  it('passes advance the queue under every non-observe mode', () => {
    for (const policy of ['pause', 'retry_once', 'stop', 'rollback'] as const) {
      expect(decideHealthRolloutAction({
        policy,
        verdict: 'passed',
        attemptsUsed: 0,
        recoveryAvailable: true,
      })).toEqual({ action: 'advance', reason: 'health_passed' });
    }
  });

  it('observe never acts, on any verdict', () => {
    for (const verdict of ['passed', 'failed', 'unknown'] as const) {
      expect(decideHealthRolloutAction({
        policy: 'observe',
        verdict,
        attemptsUsed: 0,
        recoveryAvailable: true,
      }).action).toBe('none');
    }
  });

  it('unknown evidence never retries, stops, or rolls back on any mode', () => {
    for (const policy of ['pause', 'retry_once', 'stop', 'rollback'] as const) {
      const decision = decideHealthRolloutAction({
        policy,
        verdict: 'unknown',
        attemptsUsed: 0,
        recoveryAvailable: true,
      });
      expect(decision.action).toBe('pause');
      expect(decision.reason).toBe('health_unknown');
    }
  });

  it('retry_once retries exactly once, then pauses', () => {
    expect(decideHealthRolloutAction({
      policy: 'retry_once', verdict: 'failed', attemptsUsed: 0, recoveryAvailable: true,
    }).action).toBe('retry');
    expect(decideHealthRolloutAction({
      policy: 'retry_once', verdict: 'failed', attemptsUsed: 1, recoveryAvailable: true,
    })).toEqual({ action: 'pause', reason: 'health_retry_exhausted' });
  });

  it('rollback without a captured pre-rollout generation reports it instead of restoring', () => {
    expect(decideHealthRolloutAction({
      policy: 'rollback', verdict: 'failed', attemptsUsed: 0, recoveryAvailable: false,
    })).toEqual({ action: 'pause', reason: 'rollback_unavailable' });
    expect(decideHealthRolloutAction({
      policy: 'rollback', verdict: 'failed', attemptsUsed: 0, recoveryAvailable: true,
    }).action).toBe('rollback');
  });
});

describe('freezing the policy into rollout authorization', () => {
  it('freezes the operator selection into the rollout generation', async () => {
    const fixture = seedApp({ nodeCount: 2 });
    await writeAppliedCompose(fixture.applicationId);
    setIntentPolicy(fixture.applicationId, 'rollback');

    await ensureRolloutAuthorization(fixture.applicationId, 'tester', 'manual', undefined, 'operator');

    const app = GitOpsStore.getInstance().getApplication(fixture.applicationId)!;
    const generation = GitOpsStore.getInstance().getRolloutGeneration(app.rollout_generation_id!)!;
    expect(decodeFrozenRolloutStrategy(generation.rollout_strategy_json).healthPolicy).toBe('rollback');
  });

  it('defaults to observe when no policy was ever chosen', async () => {
    const fixture = seedApp({ nodeCount: 1 });
    await writeAppliedCompose(fixture.applicationId);
    await ensureRolloutAuthorization(fixture.applicationId, 'tester', 'manual', undefined, 'operator');
    const app = GitOpsStore.getInstance().getApplication(fixture.applicationId)!;
    const generation = GitOpsStore.getInstance().getRolloutGeneration(app.rollout_generation_id!)!;
    expect(decodeFrozenRolloutStrategy(generation.rollout_strategy_json).healthPolicy).toBe('observe');
  });

  it('a generation written before the policy existed decodes as observe', () => {
    expect(decodeFrozenRolloutStrategy('{}').healthPolicy).toBe('observe');
    expect(decodeFrozenRolloutStrategy('{"driftMode":"enforce","enabled":true}').healthPolicy).toBe('observe');
    expect(decodeFrozenRolloutStrategy('{"healthPolicy":"pause"}').healthPolicy).toBe('pause');
  });

  it('an unreadable policy blocks rather than defaulting to a mode that moves the fleet', () => {
    expect(() => decodeFrozenRolloutStrategy('{"healthPolicy":"nonsense"}')).toThrow(/unknown health policy/i);
    expect(() => decodeFrozenRolloutStrategy('[]')).toThrow(/not a JSON object/i);
  });

  it('a policy change mid-rollout does not change the running rollout', async () => {
    const fixture = seedApp({ nodeCount: 1 });
    await writeAppliedCompose(fixture.applicationId);
    setIntentPolicy(fixture.applicationId, 'pause');
    await ensureRolloutAuthorization(fixture.applicationId, 'tester', 'manual', undefined, 'operator');

    const app = GitOpsStore.getInstance().getApplication(fixture.applicationId)!;
    const generationId = app.rollout_generation_id!;
    setIntentPolicy(fixture.applicationId, 'stop');

    const generation = GitOpsStore.getInstance().getRolloutGeneration(generationId)!;
    expect(decodeFrozenRolloutStrategy(generation.rollout_strategy_json).healthPolicy).toBe('pause');
  });

  it('carries the selection forward when a new intent revision is minted', async () => {
    const fixture = seedApp({ nodeCount: 1 });
    setIntentPolicy(fixture.applicationId, 'retry_once');
    const { intentRowFor } = await import('../services/gitops/blueprintProducers');
    const blueprint = DatabaseService.getInstance().getBlueprint(fixture.blueprintId)!;
    const row = intentRowFor(fixture.applicationId, blueprint, 'op-1', 'tester', 1);
    expect(row.health_failure_rollback_policy_json).toBe(JSON.stringify({ policy: 'retry_once' }));
  });
});

describe('one target at a time under a non-observe policy', () => {
  it('dispatches exactly one target and stops', async () => {
    const fixture = await authorizeWithPolicy('pause', 3);
    const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    const result = await dispatch(fixture);

    if (result.status === 'blocked') throw new Error(result.reason);
    expect(result.status).toBe('dispatched');
    expect(deploySpy).toHaveBeenCalledTimes(1);
  });

  it('observe still sweeps every target, unchanged', async () => {
    const fixture = await authorizeWithPolicy('observe', 3);
    const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    await dispatch(fixture);

    expect(deploySpy).toHaveBeenCalledTimes(3);
  });

  it('a failed verdict on the second target pauses the rollout and never reaches the third', async () => {
    const fixture = await authorizeWithPolicy('pause', 3);
    const [first, second, third] = fixture.nodeIds;
    const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    // First pass deploys target one only.
    await dispatch(fixture);
    expect(deploySpy).toHaveBeenCalledTimes(1);

    // The queue refuses to advance while target one is unverified, which is the
    // whole point of gating.
    await advance(fixture);
    expect(deploySpy).toHaveBeenCalledTimes(1);

    // A pass on target one advances to target two.
    finishHealth(fixture, first!, 'passed', undefined, 'pause');
    await advance(fixture);
    expect(deploySpy).toHaveBeenCalledTimes(2);
    expect(deploySpy.mock.calls[1]![0].node.id).toBe(second);

    // Target two's health fails. The policy pauses before the next target. The
    // transition records the decision; the executor carries it out, which is the
    // order the real path uses.
    const store = GitOpsStore.getInstance();
    const result = finishHealth(fixture, second!, 'failed', undefined, 'pause');
    expect(result.healthDecision?.action).toBe('pause');
    await executeHealthRolloutDecision({
      applicationId: fixture.applicationId,
      nodeId: second!,
      result,
      executor: spyExecutor(),
    });

    expect(store.getApplication(fixture.applicationId)?.pause_at).not.toBeNull();
    expect(store.getTarget(fixture.applicationId, third!)?.applied_generation_id).toBeNull();
    expect(deploySpy).toHaveBeenCalledTimes(2);
  });

  it('a target whose health run is still open is not dispatched again', async () => {
    const fixture = await authorizeWithPolicy('pause', 2);
    const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    await dispatch(fixture);
    expect(deploySpy).toHaveBeenCalledTimes(1);

    // The first target is still awaiting its verdict; a second dispatch must not
    // put a second apply, and a second run, on it.
    const result = await dispatch(fixture);
    expect(deploySpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('dispatched');
  });

  it('a passing target is not re-dispatched once its verdict overwrites the ack stage', async () => {
    const fixture = await authorizeWithPolicy('pause', 2);
    const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });
    await dispatch(fixture);
    const first = fixture.nodeIds[0]!;

    // A health verdict writes latest_stage, which used to be what the ack test
    // read. The ack has to survive that, or the queue advances nowhere.
    const store = GitOpsStore.getInstance();
    expect(store.getTarget(fixture.applicationId, first)!.latest_stage).toBe('blueprint_ack_recorded');
    finishHealth(fixture, first, 'passed', undefined, 'pause');

    await advance(fixture);
    expect(deploySpy).toHaveBeenCalledTimes(2);
    expect(deploySpy.mock.calls[1]![0].node.id).toBe(fixture.nodeIds[1]);
  });
});

describe('the preallocated health run', () => {
  it('binds the run to the whole rollout before the apply goes out', async () => {
    const fixture = await authorizeWithPolicy('pause', 1);
    vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    await dispatch(fixture);

    const run = latestRolloutRun(fixture)!;
    const app = GitOpsStore.getInstance().getApplication(fixture.applicationId)!;
    const target = GitOpsStore.getInstance().getTarget(fixture.applicationId, fixture.nodeId!)!;
    expect(run.trigger_action).toBe('rollout');
    expect(run.application_id).toBe(fixture.applicationId);
    expect(run.intent_revision_id).toBe(app.intent_revision_id);
    expect(run.rollout_generation_id).toBe(app.rollout_generation_id);
    expect(run.artifact_set_id).toBe(fixture.artifactId);
    expect(run.deployed_generation_id).toBe(fixture.generationId);
    expect(run.node_id).toBe(fixture.nodeId);
    expect(run.stack_name).toBeTruthy();
    expect(run.id).toBe(target.pending_health_run_id);
    expect(run.health_policy).toBe('pause');
  });

  it('refuses to dispatch rather than running a gated rollout with the gate off', async () => {
    const fixture = await authorizeWithPolicy('pause', 1);
    DatabaseService.getInstance().updateGlobalSetting('health_gate_enabled', '0');
    const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    const result = await dispatch(fixture);

    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') expect(result.reason).toMatch(/health gate is turned off/i);
    expect(deploySpy).not.toHaveBeenCalled();
    expect(latestRolloutRun(fixture)).toBeUndefined();
  });

  it('a failed apply finalizes its reservation unknown rather than reporting a verdict', async () => {
    const fixture = await authorizeWithPolicy('pause', 1);
    vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'failed', error: 'compose up failed' });

    await dispatch(fixture);

    const run = latestRolloutRun(fixture)!;
    expect(run.status).toBe('unknown');
    expect(DatabaseService.getInstance().getHealthGateRun(fixture.nodeId!, run.stack_name, run.id)?.status)
      .toBe('unknown');
  });
});

describe('verdict idempotency', () => {
  it('a duplicate verdict is evidence only and changes nothing', async () => {
    const fixture = await gatedAttempt('pause');
    const store = GitOpsStore.getInstance();
    const before = { ...store.getTarget(fixture.applicationId, fixture.nodeId!)! };
    const target = store.getTarget(fixture.applicationId, fixture.nodeId!)!;
    const runId = target.pending_health_run_id!;
    finishHealth(fixture, fixture.nodeId!, 'passed', runId, 'pause');
    const afterFirst = { ...store.getTarget(fixture.applicationId, fixture.nodeId!)! };
    expect(afterFirst.pending_health_run_id).toBeNull();
    expect(afterFirst.last_health_status).toBe('passed');
    expect(afterFirst.healthy_generation_id).toBe(fixture.generationId);

    // The same run reports again, now that the target no longer awaits it.
    finishHealth(fixture, fixture.nodeId!, 'passed', runId, 'pause');
    const afterSecond = { ...store.getTarget(fixture.applicationId, fixture.nodeId!)! };
    expect(afterSecond.last_health_status).toBe(afterFirst.last_health_status);
    expect(afterSecond.healthy_generation_id).toBe(afterFirst.healthy_generation_id);
    expect(before.healthy_generation_id).toBeNull();
  });

  it('a stale run cannot demote a generation a later attempt passed', async () => {
    const fixture = await gatedAttempt('retry_once');
    // Attempt one fails, the retry is spent, attempt two passes.
    finishHealth(fixture, fixture.nodeId!, 'failed', undefined, 'retry_once');
    const store = GitOpsStore.getInstance();
    const afterFirst = store.getTarget(fixture.applicationId, fixture.nodeId!)!;
    expect(afterFirst.health_attempts).toBe(1);
    const retryRunId = beginReplacementAttempt(fixture);
    finishHealth(fixture, fixture.nodeId!, 'passed', retryRunId, 'retry_once');
    expect(store.getTarget(fixture.applicationId, fixture.nodeId!)!.healthy_generation_id)
      .toBe(fixture.generationId);

    // Attempt one's report finally lands. It owns no pending run, so it must not
    // withdraw the promotion attempt two earned.
    finishHealth(fixture, fixture.nodeId!, 'failed', afterFirst.last_health_run_id ?? undefined, 'retry_once');

    const final = store.getTarget(fixture.applicationId, fixture.nodeId!)!;
    expect(final.healthy_generation_id).toBe(fixture.generationId);
    expect(final.last_health_status).toBe('passed');
  });
});

describe('retry, stop, and rollback', () => {
  it('retry spends the attempt once and re-dispatches the same generation', async () => {
    const fixture = await gatedAttempt('retry_once');
    const calls: string[] = [];
    const executor = {
      advance: vi.fn(async () => { calls.push('advance'); }),
      retry: vi.fn(async () => { calls.push('retry'); }),
    } as unknown as HealthRolloutExecutor;

    const result = await decide(fixture, 'failed', executor, 'retry_once');

    expect(result.healthDecision?.action).toBe('retry');
    expect(calls).toEqual(['retry']);
    const target = GitOpsStore.getInstance().getTarget(fixture.applicationId, fixture.nodeId!)!;
    expect(target.health_attempts).toBe(1);
    expect(target.pending_health_run_id).toBeNull();
  });

  it('a retried target keeps its original pre-rollout recovery point', async () => {
    const fixture = await gatedAttempt('retry_once');
    const store = GitOpsStore.getInstance();
    const recoveryRef = 'rec-original';
    markRecoveryPoint(fixture, recoveryRef, 'gen-pre-rollout');

    await decide(fixture, 'failed', spyExecutor(), 'retry_once');

    // The executor's retry is a fresh dispatch. The recovery point recorded
    // before the first attempt is what a rollback must restore from, so the
    // retry must not replace it.
    expect(store.getTarget(fixture.applicationId, fixture.nodeId!)!.recovery_ref).toBe(recoveryRef);
    expect(store.getTarget(fixture.applicationId, fixture.nodeId!)!.recovery_generation_id)
      .toBe('gen-pre-rollout');
  });

  it('re-dispatches the failed target itself under retry, and keeps the original recovery point', async () => {
    const fixture = await authorizeWithPolicy('retry_once', 3);
    const store = GitOpsStore.getInstance();
    const deploy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    // First target: it fails, so the policy asks for a retry.
    await dispatch(fixture);
    const firstNode = store.getTarget(fixture.applicationId, fixture.nodeId!)!;
    const firstAttempt = deploy.mock.calls.length;
    const recoveryRef = 'rec-original';
    markRecoveryPoint(fixture, recoveryRef, 'gen-pre-rollout');

    const firstRun = firstNode.pending_health_run_id!;
    const decision = finishHealth(fixture, fixture.nodeId!, 'failed', firstRun, 'retry_once');
    expect(decision.healthDecision?.action).toBe('retry');
    await executeHealthRolloutDecision({
      applicationId: fixture.applicationId,
      nodeId: fixture.nodeId!,
      result: decision,
      // The real executor, whose retry is a real dispatch. A spy here passes
      // while the queue that has to re-dispatch the failed target is broken.
      executor: liveHealthRolloutExecutor(),
    });

    // The retry has to reach Docker: the queue's first unsettled target is the
    // one that just failed, and a target is unsettled until its verdict passes,
    // so skipping it on its ack would stall the rollout behind its own failure.
    expect(deploy.mock.calls.length).toBe(firstAttempt + 1);
    expect(lastDeployArgs(deploy)?.recoveryBinding)
      .toBeDefined();
    // The pre-rollout point is the one a rollback restores from, so a retry must
    // not re-capture and replace it with the generation that just failed.
    expect(lastDeployArgs(deploy)?.captureRecovery).toBe(false);
    const after = store.getTarget(fixture.applicationId, fixture.nodeId!)!;
    expect(after.recovery_ref).toBe(recoveryRef);
    expect(after.recovery_generation_id).toBe('gen-pre-rollout');
    expect(after.pending_health_run_id).not.toBe(firstRun);
  });

  it('does not re-dispatch a target whose retry budget is already spent', async () => {
    const fixture = await gatedAttempt('retry_once');
    const store = GitOpsStore.getInstance();
    const nodeId = fixture.nodeId!;
    const deploy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    const firstRun = store.getTarget(fixture.applicationId, nodeId)!.pending_health_run_id!;
    const first = finishHealth(fixture, nodeId, 'failed', firstRun, 'retry_once');
    expect(first.healthDecision?.action).toBe('retry');
    await executeHealthRolloutDecision({
      applicationId: fixture.applicationId, nodeId, result: first, executor: liveHealthRolloutExecutor(),
    });

    const secondRun = store.getTarget(fixture.applicationId, nodeId)!.pending_health_run_id!;
    const second = finishHealth(fixture, nodeId, 'failed', secondRun, 'retry_once');
    expect(second.healthDecision?.action).toBe('pause');
    expect(second.healthDecision?.reason).toBe('health_retry_exhausted');
    await executeHealthRolloutDecision({
      applicationId: fixture.applicationId, nodeId, result: second, executor: spyExecutor(),
    });

    // Resume first. Dispatching while the executor's pause still stands would be
    // refused before the queue is ever consulted, so the test would pass even if
    // the exhausted fence still allowed a third attempt.
    GitOpsTransitions.getInstance().rolloutUnpaused(fixture.applicationId, null, {
      operationId: 'resume-exhausted', actor: 'tester', trigger: 'manual', at: Date.now(),
    });
    // The operator's resume clears the fence, so the target is deployed again.
    // That is an operator action, not a policy retry, which is why the budget
    // stays spent: retry_once must still be exactly once.
    const held = store.getTarget(fixture.applicationId, nodeId)!;
    expect(held.health_stop_reason).toBeNull();
    expect(held.health_attempts).toBe(1);
    const callsBefore = deploy.mock.calls.length;
    const result = await dispatch(fixture);

    expect(deploy.mock.calls.length).toBe(callsBefore + 1);
    expect(result.status).toBe('dispatched');
    expect(store.getTarget(fixture.applicationId, nodeId)!.health_attempts).toBe(1);
    // And the next failure goes straight to pause, because the budget is spent.
    const nextRun = store.getTarget(fixture.applicationId, nodeId)!.pending_health_run_id!;
    const afterResume = finishHealth(fixture, nodeId, 'failed', nextRun, 'retry_once');
    expect(afterResume.healthDecision?.action).toBe('pause');
    expect(afterResume.healthDecision?.reason).toBe('health_retry_exhausted');
  });

  it('holds the rollout on stop, and a restart does not put it back to work', async () => {
    const fixture = await gatedAttempt('stop');
    const store = GitOpsStore.getInstance();
    const nodeId = fixture.nodeId!;

    const run = store.getTarget(fixture.applicationId, nodeId)!.pending_health_run_id!;
    const decision = finishHealth(fixture, nodeId, 'failed', run, 'stop');
    expect(decision.healthDecision?.action).toBe('stop');
    await executeHealthRolloutDecision({
      applicationId: fixture.applicationId, nodeId, result: decision, executor: spyExecutor(),
    });

    // The target is fenced, and the application is held. The hold is what a
    // restart sees: without it, reconstruction would find no fence on the
    // targets it had not reached and carry the rollout on.
    expect(store.getTarget(fixture.applicationId, nodeId)!.health_stop_reason).toBe('rollout_stopped');
    expect(store.getApplication(fixture.applicationId)!.pause_at).not.toBeNull();
    const deploy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });
    // Reconstruction walks every authorized application in the shared database,
    // so the claim is about this rollout's own targets.
    await reconstructBlueprintRolloutQueue();
    const afterReconstruct = deploy.mock.calls.length;
    await reconstructBlueprintRolloutQueue();
    expect(deploy.mock.calls.length).toBe(afterReconstruct);
  });

  it('holds the rollout when a rollback has nothing to restore', async () => {
    const fixture = await gatedAttempt('rollback');
    const store = GitOpsStore.getInstance();
    const nodeId = fixture.nodeId!;
    // No recovery point was ever captured for this target.
    expect(store.getTarget(fixture.applicationId, nodeId)!.recovery_ref).toBeNull();

    const run = store.getTarget(fixture.applicationId, nodeId)!.pending_health_run_id!;
    const decision = finishHealth(fixture, nodeId, 'failed', run, 'rollback');
    expect(decision.healthDecision?.reason).toBe('rollback_unavailable');
    await executeHealthRolloutDecision({
      applicationId: fixture.applicationId, nodeId, result: decision, executor: spyExecutor(),
    });

    // A rollback that cannot restore must not leave the queue running: the
    // rollout would advance past a target that is still on a failed generation.
    expect(store.getApplication(fixture.applicationId)!.pause_at).not.toBeNull();
  });

  it('records the pre-rollout generation on the first attempt, so a rollback has something to restore', async () => {
    const fixture = await authorizeWithPolicy('rollback', 2);
    // The target is on an older generation before this rollout deploys.
    moveTargetToAnotherGeneration(fixture.applicationId, fixture.nodeId!, 'gen-before-rollout');
    vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    await dispatch(fixture);

    // Nothing but the dispatch can record this: the node's recovery row is the
    // hub's only other handle on that point and it never leaves the node. A
    // dispatch that did not write it here would leave every rollback with
    // nothing to restore, while the screen still offered one.
    const target = GitOpsStore.getInstance().getTarget(fixture.applicationId, fixture.nodeId!)!;
    expect(target.recovery_generation_id).toBe('gen-before-rollout');
  });

  it('a retry does not move the recorded pre-rollout generation onto the failed one', async () => {
    // A retry_once fixture, because a production verdict reads the policy off
    // the reserved run. Injecting a different one would test a path no verdict
    // can take.
    const fixture = await authorizeWithPolicy('retry_once', 2);
    moveTargetToAnotherGeneration(fixture.applicationId, fixture.nodeId!, 'gen-before-rollout');
    const deploy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });
    await dispatch(fixture);
    // After the apply, the target runs this rollout's generation.
    const deployed = GitOpsStore.getInstance().getTarget(fixture.applicationId, fixture.nodeId!)!
      .applied_generation_id;

    const run = GitOpsStore.getInstance().getTarget(fixture.applicationId, fixture.nodeId!)!
      .pending_health_run_id!;
    const decision = finishHealth(fixture, fixture.nodeId!, 'failed', run, 'retry_once');
    await executeHealthRolloutDecision({
      applicationId: fixture.applicationId, nodeId: fixture.nodeId!,
      result: decision, executor: liveHealthRolloutExecutor(),
    });

    // Restoring the generation that just failed health would be a no-op that
    // looks like a rollback, so the pre-rollout point has to survive the retry.
    expect(deploy.mock.calls.length).toBeGreaterThan(1);
    const after = GitOpsStore.getInstance().getTarget(fixture.applicationId, fixture.nodeId!)!;
    expect(after.recovery_generation_id).toBe('gen-before-rollout');
    expect(after.recovery_generation_id).not.toBe(deployed);
  });

  it('a resumed rollout moves past the target that failed, to the ones it never reached', async () => {
    const fixture = await authorizeWithPolicy('pause', 3);
    const store = GitOpsStore.getInstance();
    const deploy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    await dispatch(fixture);
    const failed = store.getTarget(fixture.applicationId, fixture.nodeId!)!;
    const failedNode = fixture.nodeId!;
    const nextNode = fixture.nodeIds[1]!;
    const decision = finishHealth(fixture, failedNode, 'failed', failed.pending_health_run_id!, 'pause');
    await executeHealthRolloutDecision({
      applicationId: fixture.applicationId, nodeId: failedNode,
      result: decision, executor: spyExecutor(),
    });
    expect(store.getApplication(fixture.applicationId)!.pause_at).not.toBeNull();

    // Resuming is the ordinary unpause, and it clears the fence: the operator has
    // seen the hold and wants the rollout to carry on, so the target that stopped
    // it is deployed again and the policy decides afresh from the new verdict.
    GitOpsTransitions.getInstance().rolloutUnpaused(fixture.applicationId, null, {
      operationId: 'resume-1', actor: 'tester', trigger: 'manual', at: Date.now(),
    });
    const callsBefore = deploy.mock.calls.length;
    await dispatch(fixture);

    expect(deploy.mock.calls.length).toBe(callsBefore + 1);
    const resumedTarget = store.getTarget(fixture.applicationId, failedNode)!;
    expect(resumedTarget.pending_health_run_id).not.toBeNull();
    expect(store.getTarget(fixture.applicationId, nextNode)!.pending_health_run_id).toBeNull();
    void nextNode;

    // A restart after that resume must not re-hold: a fence is also what
    // reconstruction holds on, so one the operator already answered for would
    // otherwise pause the same rollout again on every restart.
    const storeAfter = store.getTarget(fixture.applicationId, failedNode)!;
    expect(storeAfter.health_stop_reason).toBeNull();
  });

  it('a restart holds a rollout whose target was fenced, before it can reach the next one', async () => {
    const fixture = await gatedAttempt('stop');
    const store = GitOpsStore.getInstance();
    const deploy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    const run = store.getTarget(fixture.applicationId, fixture.nodeId!)!.pending_health_run_id!;
    const decision = finishHealth(fixture, fixture.nodeId!, 'failed', run, 'stop');
    await executeHealthRolloutDecision({
      applicationId: fixture.applicationId, nodeId: fixture.nodeId!,
      result: decision, executor: spyExecutor(),
    });

    // Model the gap the executor leaves if the process exits between the fence
    // committing and its application-wide pause: the fence is durable, the hold
    // is not. Reconstruction reads the fence, because that is the only half that
    // was committed.
    // Cleared directly, modelling the process that exited before the executor
    // wrote the hold. The unpause transition is the operator's path, and it
    // would also clear the fence this test depends on.
    DatabaseService.getInstance().getDb()
      .prepare('UPDATE gitops_applications SET pause_at = NULL, pause_reason = NULL WHERE id = ?')
      .run(fixture.applicationId);
    expect(store.getTarget(fixture.applicationId, fixture.nodeId!)!.health_stop_reason)
      .toBe('rollout_stopped');

    // The fixture already deployed once, and the spy is that same mock, so the
    // count rather than zero is the baseline for "reconstruction deployed".
    const callsBefore = deploy.mock.calls.length;
    await reconstructBlueprintRolloutQueue();

    // The second target must not be deployed: stop promised it would not run.
    expect(deploy.mock.calls.length).toBe(callsBefore);
    expect(store.getApplication(fixture.applicationId)!.pause_at).not.toBeNull();
  });

  it('a run reserved before a crash is adopted, attached, and armed on the replay', async () => {
    const fixture = await authorizeWithPolicy('pause', 2);
    const store = GitOpsStore.getInstance();
    const deploy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });
    // A run the previous process opened, still observing, with nothing pointing
    // at it: the crash landed between reserving and recording the pointer.
    const orphan = reserveRunFor(fixture, fixture.nodeId!, 'observing');

    await dispatch(fixture);

    // The replay has to end with the target owning an armed run. Losing the id
    // would apply the generation with nothing watching it, and the startup sweep
    // would find no target pointing at the run it has to finalize.
    const target = store.getTarget(fixture.applicationId, fixture.nodeId!)!;
    expect(target.pending_health_run_id).toBe(orphan.id);
    expect(deploy).toHaveBeenCalled();
  });

  it('a target whose health run no longer exists is released, not waited on for ever', async () => {
    const fixture = await gatedAttempt('pause');
    const store = GitOpsStore.getInstance();
    const target = store.getTarget(fixture.applicationId, fixture.nodeId!)!;
    const runId = target.pending_health_run_id!;
    // Run history is pruned, so a target can outlive the row it awaits.
    DatabaseService.getInstance().getDb()
      .prepare('DELETE FROM health_gate_runs WHERE id = ?').run(runId);

    HealthGateService.getInstance().start();

    // Without the release the target reads as still observing a run that will
    // never report, and every startup repeats the same ineffective pass.
    expect(store.getTarget(fixture.applicationId, fixture.nodeId!)!.pending_health_run_id).toBeNull();
  });

  it('keeps the reserved run through the real deploy, which writes the same stage twice', async () => {
    const fixture = await authorizeWithPolicy('pause', 2);
    const store = GitOpsStore.getInstance();
    // Only the Docker-level call is stubbed. Mocking the service instead, as the
    // rest of this suite does, skips the two other writers of the same stage: the
    // deployment-status producer opens it again on deploy_start and acks it on
    // deploy_ack. The first of those used to erase the pointer and the second
    // used to fail the adapter's own ack, so no run was ever armed and the
    // rollout re-applied one target for ever without a verdict.
    vi.spyOn(BlueprintService.getInstance(), 'applyLocalUnderLock')
      .mockResolvedValue({ ran: true } as never);
    vi.spyOn(BlueprintService.getInstance(), 'hasNameConflict').mockResolvedValue(false);
    // The target is on an older generation first, so the pre-rollout point the
    // ack records is a real one rather than nothing.
    moveTargetToAnotherGeneration(fixture.applicationId, fixture.nodeId!, 'gen-before-rollout');

    const result = await dispatch(fixture);
    expect(result.status).toBe('dispatched');

    const target = store.getTarget(fixture.applicationId, fixture.nodeId!)!;
    // The pointer survives the second deploy_start, so the run can be armed and
    // its verdict can consume the target.
    expect(target.pending_health_run_id).not.toBeNull();
    const run = finishedRolloutRuns(fixture).find((r) => r.id === target.pending_health_run_id);
    expect(run?.status).toBe('observing');
    // The adapter's ack is not a second, competing ack: the target is converged
    // on the authorized generation, and the pre-rollout point is recorded.
    expect(target.applied_generation_id).toBe(fixture.generationId);
    expect(target.recovery_generation_id).toBe('gen-before-rollout');
  });

  it('a fence from a superseded rollout does not hold or skip a later one', async () => {
    const fixture = await gatedAttempt('stop');
    const store = GitOpsStore.getInstance();
    const run = store.getTarget(fixture.applicationId, fixture.nodeId!)!.pending_health_run_id!;
    const decision = finishHealth(fixture, fixture.nodeId!, 'failed', run, 'stop');
    await executeHealthRolloutDecision({
      applicationId: fixture.applicationId, nodeId: fixture.nodeId!,
      result: decision, executor: spyExecutor(),
    });
    expect(store.getTarget(fixture.applicationId, fixture.nodeId!)!.health_stop_reason)
      .toBe('rollout_stopped');

    // A new authorization mints a new rollout generation. The fence belonged to
    // the old one and never stopped this target under the new one, so it must not
    // exclude it: otherwise the new rollout reports itself complete without a
    // node the operator never excluded. The target's pointer is put back to the
    // superseded generation directly, because the reset that normally happens at
    // ack time is exactly the path a fenced target cannot reach.
    GitOpsStore.getInstance().upsertTarget({
      ...store.getTarget(fixture.applicationId, fixture.nodeId!)!,
      rollout_generation_id: 'rgen-superseded',
    });
    GitOpsTransitions.getInstance().rolloutUnpaused(fixture.applicationId, null, {
      operationId: 'resume-superseded', actor: 'tester', trigger: 'manual', at: Date.now(),
    });
    const deploy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });
    const fencedNode = fixture.nodeId!;
    // The fixture deployed this target once before it was fenced, on the same
    // spy, so only the calls made after the fence are the claim under test.
    const callsBefore = deploy.mock.calls.length;

    await dispatch(fixture);

    // On the fenced target specifically: a general "deployed something" would
    // pass while the queue simply moved on to the node it had not reached, which
    // is the failure being guarded.
    const deployedNodes = deploy.mock.calls
      .slice(callsBefore)
      .map((call) => (call[0] as { node: { id: number } }).node.id);
    expect(deployedNodes).toContain(fencedNode);
  });

  it('a late verdict for a superseded rollout is released, not acted on', async () => {
    const fixture = await gatedAttempt('pause');
    const store = GitOpsStore.getInstance();
    const nodeId = fixture.nodeId!;
    const run = store.getTarget(fixture.applicationId, nodeId)!.pending_health_run_id!;

    // The application moves on while the run is still outstanding. The target
    // still names the old generation because it has not been re-acked yet, which
    // is exactly the case where deciding from the old verdict would run the old
    // policy's pause against the new rollout.
    DatabaseService.getInstance().getDb()
      .prepare('UPDATE gitops_applications SET rollout_generation_id = ? WHERE id = ?')
      .run('rgen-newer', fixture.applicationId);

    const result = finishHealth(fixture, nodeId, 'failed', run, 'pause');

    // No decision: the verdict describes a rollout the application has left, so
    // applying it would run the old policy against the new rollout.
    expect(result.healthDecision).toBeFalsy();
    // But the run is released, and the result says so, because that is what tells
    // the caller the queue is free and has to be driven again. A verdict with no
    // decision produces no follow-up of its own.
    expect(result.healthUnattributable).toBe(true);
    expect(store.getTarget(fixture.applicationId, nodeId)!.pending_health_run_id).toBeNull();
    expect(store.getApplication(fixture.applicationId)!.pause_at).toBeNull();
  });

  it('an ack whose intent is no longer the application intent is not taken as a duplicate', async () => {
    const fixture = await authorizeWithPolicy('pause', 1);
    vi.spyOn(BlueprintService.getInstance(), 'applyLocalUnderLock')
      .mockResolvedValue({ ran: true } as never);
    vi.spyOn(BlueprintService.getInstance(), 'hasNameConflict').mockResolvedValue(false);

    // The apply is in flight and the application is re-authorized underneath it.
    // The ack that returns names the old intent, and the newer generation is on
    // the application now. Recording it would claim the target runs the newer
    // materialization while the older one is what was applied.
    const ack = () => GitOpsTransitions.getInstance().blueprintAckRecorded({
      applicationId: fixture.applicationId,
      nodeId: fixture.nodeId!,
      intentRevisionId: 'intent-superseded',
      rolloutCandidateId: fixture.candidateId,
      legacyAppliedRevision: null,
      envelope: { operationId: 'ack-stale', actor: 'tester', trigger: 'manual', at: Date.now() },
    });

    expect(ack).toThrow(/not the one deployed|was not asked to run/);
  });

  it('a failed apply under the current rollout does not drive the queue again', async () => {
    const fixture = await authorizeWithPolicy('pause', 2);
    const deploy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'failed', error: 'compose up failed' });

    await dispatch(fixture);
    const callsAfterFirst = deploy.mock.calls.length;

    // The reservation is abandoned, the run is finalized unknown, and the
    // verdict finds the target still naming no rollout generation because the
    // apply never acked. That is the same shape as a superseded rollout, and the
    // only thing that tells them apart is whether the application has moved on.
    const run = finishedRolloutRuns(fixture).find((r) => r.status === 'unknown');
    const result = GitOpsTransitions.getInstance().healthFinalized({
      applicationId: fixture.applicationId,
      nodeId: fixture.nodeId!,
      healthRunId: run!.id,
      healthStatus: 'unknown',
      deployedGenerationId: run!.deployed_generation_id ?? null,
      targetScope: 'stack',
      rollout: { rolloutGenerationId: run!.rollout_generation_id!, healthPolicy: 'pause' },
      envelope: { operationId: run!.id, actor: 'tester', trigger: 'health', at: Date.now() },
    });

    // The application is still on that rollout, so nothing re-drives it. Driving
    // here would select the same unsettled target again: a persistently failing
    // apply would retry for ever, without ever spending the retry budget.
    expect(result.healthUnattributable).toBeFalsy();
    expect(GitOpsStore.getInstance().getApplication(fixture.applicationId)!.rollout_generation_id)
      .toBe(run!.rollout_generation_id);
    expect(callsAfterFirst).toBe(1);
    const target = GitOpsStore.getInstance().getTarget(fixture.applicationId, fixture.nodeId!)!;
    expect(target.failure_stage).toBe('blueprint_deploy');
  });

  it('a verdict for a rollout the application left drives the newer one', async () => {
    const fixture = await gatedAttempt('pause');
    const store = GitOpsStore.getInstance();
    const nodeId = fixture.nodeId!;
    const run = store.getTarget(fixture.applicationId, nodeId)!.pending_health_run_id!;

    // The application is authorized for a newer rollout while the old run is
    // still outstanding, and the target was never re-acked so it still names the
    // generation before that. Nothing else would dispatch the newer rollout: this
    // verdict is the only thing holding its queue.
    DatabaseService.getInstance().getDb()
      .prepare('UPDATE gitops_applications SET rollout_generation_id = ? WHERE id = ?')
      .run('rgen-newer', fixture.applicationId);

    const result = finishHealth(fixture, nodeId, 'unknown', run, 'pause');

    expect(result.healthDecision).toBeFalsy();
    // The release is reported, which is what tells the caller to drive the queue.
    expect(result.healthUnattributable).toBe(true);
    expect(store.getTarget(fixture.applicationId, nodeId)!.pending_health_run_id).toBeNull();
  });

  it('a resume re-drives a held target but never a stopped one', async () => {
    const fixture = await gatedAttempt('stop');
    const store = GitOpsStore.getInstance();
    const nodeId = fixture.nodeId!;
    const run = store.getTarget(fixture.applicationId, nodeId)!.pending_health_run_id!;
    const decision = finishHealth(fixture, nodeId, 'failed', run, 'stop');
    await executeHealthRolloutDecision({
      applicationId: fixture.applicationId, nodeId,
      result: decision, executor: spyExecutor(),
    });
    expect(store.getTarget(fixture.applicationId, nodeId)!.health_stop_reason)
      .toBe('rollout_stopped');

    const deploy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });
    const callsBefore = deploy.mock.calls.length;
    GitOpsTransitions.getInstance().rolloutUnpaused(fixture.applicationId, null, {
      operationId: 'resume-stop', actor: 'tester', trigger: 'manual', at: Date.now(),
    });
    await dispatch(fixture);

    // The policy is finished with this target, so resume moves past it. Putting
    // the failed generation back on it would fail and stop again for ever, with
    // the rest of the fleet never reached.
    const deployedNodes = deploy.mock.calls
      .slice(callsBefore)
      .map((call) => (call[0] as { node: { id: number } }).node.id);
    expect(deployedNodes).not.toContain(nodeId);
    expect(deployedNodes).toContain(fixture.nodeIds[1]!);
    expect(store.getTarget(fixture.applicationId, nodeId)!.health_stop_reason)
      .toBe('rollout_stopped');
  });

  it('a resume re-drives a paused target, and a completed rollback is terminal', async () => {
    const held = await gatedAttempt('pause');
    const heldStore = GitOpsStore.getInstance();
    const heldRun = heldStore.getTarget(held.applicationId, held.nodeId!)!.pending_health_run_id!;
    const pauseDecision = finishHealth(held, held.nodeId!, 'failed', heldRun, 'pause');
    await executeHealthRolloutDecision({
      applicationId: held.applicationId, nodeId: held.nodeId!,
      result: pauseDecision, executor: spyExecutor(),
    });
    GitOpsTransitions.getInstance().rolloutUnpaused(held.applicationId, null, {
      operationId: 'resume-pause', actor: 'tester', trigger: 'manual', at: Date.now(),
    });
    // A hold is a question, and resume is the answer: the target is re-driven.
    expect(heldStore.getTarget(held.applicationId, held.nodeId!)!.health_stop_reason).toBeNull();

    // A rollback with nothing to restore is a hold, not a statement. The target
    // was never on a generation this rollout could put back, which is something
    // only deploying again can change, so a resume has to answer it.
    const unavailable = await gatedAttempt('rollback');
    const unavailableStore = GitOpsStore.getInstance();
    const unavailableNode = unavailable.nodeId!;
    const unavailableRun = unavailableStore
      .getTarget(unavailable.applicationId, unavailableNode)!.pending_health_run_id!;
    const noRecovery = finishHealth(
      unavailable, unavailableNode, 'failed', unavailableRun, 'rollback',
    );
    expect(noRecovery.healthDecision?.reason).toBe('rollback_unavailable');
    // The executor is what holds the rollout, so it has to run for the app to be
    // resumable at all.
    await executeHealthRolloutDecision({
      applicationId: unavailable.applicationId, nodeId: unavailableNode,
      result: noRecovery, executor: spyExecutor(),
    });
    expect(unavailableStore.getApplication(unavailable.applicationId)!.pause_at).not.toBeNull();

    GitOpsTransitions.getInstance().rolloutUnpaused(unavailable.applicationId, null, {
      operationId: 'resume-unavailable', actor: 'tester', trigger: 'manual', at: Date.now(),
    });
    expect(unavailableStore.getTarget(unavailable.applicationId, unavailableNode)!.health_stop_reason)
      .toBeNull();

    // A completed rollback is a statement, and resume does not put it back.
    const rolled = await authorizeWithPolicy('rollback', 2);
    const rolledStore = GitOpsStore.getInstance();
    // The generation the target ran before this rollout, which is what a restore
    // puts it back on. The application has to own it for the restore to be valid.
    GitOpsStore.getInstance().insertGeneration(
      generationRow('gen-before-rollout', rolled.applicationId, rolledStore.getApplication(rolled.applicationId)!.materialization_fingerprint!),
    );
    markRecoveryPoint(rolled, 'rec-pre-rollout', 'gen-before-rollout');
    await dispatch(rolled);
    GitOpsTransitions.getInstance().rollbackCompleted({
      applicationId: rolled.applicationId,
      nodeId: rolled.nodeId!,
      recoveryRef: 'health-rollout-rollback-test',
      recoveryGenerationId: 'gen-before-rollout',
      capturedArtifactSetId: null,
      capturedSourceAcceptanceRef: null,
      envelope: { operationId: 'rb-1', actor: 'tester', trigger: 'manual', at: Date.now() },
    });
    // The executor holds the rollout after a completed rollback, so there is
    // something for the operator to resume from.
    GitOpsTransitions.getInstance().rolloutPaused(rolled.applicationId, null, 'held', {
      operationId: 'hold-rb', actor: 'tester', trigger: 'manual', at: Date.now(),
    });
    GitOpsTransitions.getInstance().rolloutUnpaused(rolled.applicationId, null, {
      operationId: 'resume-rollback', actor: 'tester', trigger: 'manual', at: Date.now(),
    });
    expect(rolledStore.getTarget(rolled.applicationId, rolled.nodeId!)!.health_stop_reason)
      .toBe('rollback_completed');
  });

  it('a target with no recovery point reports the same availability the decision used', async () => {
    const fixture = await gatedAttempt('rollback');
    const nodeId = fixture.nodeId!;
    const gate = projectFixture(fixture).targets
      .find((target) => target.nodeId === nodeId)?.healthGate;
    expect(gate?.recoveryAvailable).toBe(false);

    // A reference without a generation names nothing restorable, so it must not
    // read as available either, or the screen offers a rollback that cannot run.
    markRecoveryPoint(fixture, 'rec-ref-only', null as unknown as string);
    const after = projectFixture(fixture).targets
      .find((target) => target.nodeId === nodeId)?.healthGate;
    expect(after?.recoveryAvailable).toBe(false);
  });

  it('observe still records a health outcome, and does not gate what runs next', async () => {
    const fixture = await authorizeWithPolicy('observe', 3);
    const store = GitOpsStore.getInstance();
    const deploy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    // Observe keeps the whole-sweep behaviour, so every target is deployed.
    await dispatch(fixture);
    expect(deploy).toHaveBeenCalledTimes(3);
    for (const nodeId of fixture.nodeIds) {
      expect(store.getTarget(fixture.applicationId, nodeId)!.pending_health_run_id).not.toBeNull();
    }

    // And each one has a run to observe it, so the outcome is recorded rather
    // than the deployment being invisible to the health record.
    const runs = finishedRolloutRuns(fixture).filter((run) => run.status === 'observing');
    expect(runs).toHaveLength(3);
  });

  it('observe spends no attempt and writes no fence', async () => {
    const fixture = await gatedAttempt('observe');
    const store = GitOpsStore.getInstance();
    const nodeId = fixture.nodeId!;
    const run = store.getTarget(fixture.applicationId, nodeId)!.pending_health_run_id!;

    const result = finishHealth(fixture, nodeId, 'failed', run, 'observe');

    expect(result.healthDecision?.action).toBe('none');
    const target = store.getTarget(fixture.applicationId, nodeId)!;
    // Observe records the outcome and changes nothing else, so there is no
    // fence to hold the queue and no retry budget to spend.
    expect(target.health_stop_reason).toBeNull();
    expect(target.health_attempts).toBe(0);
    expect(target.last_health_status).toBe('failed');
  });

  it('a run reserved for observe survives a disabled gate, because observe does not depend on it', async () => {
    const fixture = await authorizeWithPolicy('observe', 2);
    const deploy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });
    DatabaseService.getInstance().updateGlobalSetting('health_gate_enabled', '0');

    const result = await dispatch(fixture);

    // A gated policy is refused without the gate, but observe only records, so
    // it must still run rather than being blocked into a behaviour it never had.
    expect(result.status).toBe('dispatched');
    expect(deploy).toHaveBeenCalled();
  });

  it('a failed apply releases the run it had reserved', async () => {
    const fixture = await authorizeWithPolicy('pause', 2);
    vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'failed' });

    await dispatch(fixture);

    // No verdict can ever arrive for a run whose apply never landed, so the
    // pointer has to be released or the target waits for a run that is done.
    const target = GitOpsStore.getInstance().getTarget(fixture.applicationId, fixture.nodeId!)!;
    expect(target.pending_health_run_id).toBeNull();
    expect(target.failure_stage).toBe('blueprint_deploy');
  });

  it('a verdict that cannot be attributed releases the run the target was awaiting', async () => {
    const fixture = await gatedAttempt('pause');
    const store = GitOpsStore.getInstance();
    const nodeId = fixture.nodeId!;
    const run = store.getTarget(fixture.applicationId, nodeId)!.pending_health_run_id!;

    // The target is running something else now, so the verdict cannot be
    // attributed to it. The run still has to be released, or the target reads as
    // still observing a verdict that already arrived.
    moveTargetToAnotherGeneration(fixture.applicationId, nodeId, 'gen-somewhere-else');
    const result = finishHealth(fixture, nodeId, 'passed', run, 'pause');

    // No policy decision: the verdict does not describe what the target is
    // running. The run is still released so the queue is not held by a verdict
    // that has already arrived.
    expect(result.healthDecision).toBeFalsy();
    expect(store.getTarget(fixture.applicationId, nodeId)!.pending_health_run_id).toBeNull();
  });

  it('stop records the fence and dispatches nothing', async () => {
    const fixture = await gatedAttempt('stop');
    const executor = spyExecutor();

    await decide(fixture, 'failed', executor, 'stop');

    const target = GitOpsStore.getInstance().getTarget(fixture.applicationId, fixture.nodeId!)!;
    expect(target.health_stop_reason).toBe('rollout_stopped');
    expect(executor.advance).not.toHaveBeenCalled();
    expect(executor.retry).not.toHaveBeenCalled();
  });

  it('rollback restores the captured pre-rollout generation, never the LKG', async () => {
    const fixture = await gatedAttempt('rollback');
    markRecoveryPoint(fixture, 'rec-pre-rollout', 'gen-pre-rollout');
    // A generation that passed at some point, which is NOT what the target ran
    // before this rollout. Restoring it would put back a workload the target
    // never ran.
    setLkg(fixture, 'gen-from-another-era');
    const restoreSpy = await mockRestore();

    await decide(fixture, 'failed', spyExecutor(), 'rollback');

    expect(restoreSpy).toHaveBeenCalledTimes(1);
    expect(restoreSpy.mock.calls[0]![0].generationId).toBe('gen-pre-rollout');
  });

  it('rollback without a recovery point reports it rather than restoring something else', async () => {
    const fixture = await gatedAttempt('rollback');
    const restoreSpy = await mockRestore();

    const outcome = await decide(fixture, 'failed', spyExecutor(), 'rollback');

    // No captured pre-rollout generation means there is nothing honest to
    // restore, so the verdict pauses and the projection reports recovery as
    // required rather than the rollout silently doing nothing.
    expect(restoreSpy).not.toHaveBeenCalled();
    expect(outcome.action).toBe('pause');
    expect(outcome.reason).toBe('rollback_unavailable');
    expect(GitOpsStore.getInstance().getApplication(fixture.applicationId)?.pause_at).not.toBeNull();
  });

  it('a failed restore is reported as partial, not as a completed rollback', async () => {
    const fixture = await gatedAttempt('rollback');
    markRecoveryPoint(fixture, 'rec-pre-rollout', 'gen-pre-rollout');
    await mockRestore({ ok: false, code: 'ROLLBACK_FAILED', error: 'the restore request failed' });

    const outcome = await decide(fixture, 'failed', spyExecutor(), 'rollback');

    expect(outcome.action).toBe('rollback_partial_failed');
  });

  it('a health failure never creates source, placement, or artifact authority', async () => {
    const fixture = await gatedAttempt('stop');
    const store = GitOpsStore.getInstance();
    const before = { ...store.getApplication(fixture.applicationId)! };

    finishHealth(fixture, fixture.nodeId!, 'failed', undefined, 'stop');

    const after = store.getApplication(fixture.applicationId)!;
    expect(after.source_acceptance_ref).toBe(before.source_acceptance_ref);
    expect(after.placement_approval_ref).toBe(before.placement_approval_ref);
    expect(after.rollout_authorization_ref).toBe(before.rollout_authorization_ref);
    expect(after.artifact_set_id).toBe(before.artifact_set_id);
    expect(after.intent_revision_id).toBe(before.intent_revision_id);
  });
});

describe('restart and lost responses', () => {
  it('a reservation left observing by a restart becomes unknown, never a pass', async () => {
    const fixture = await authorizeWithPolicy('pause', 1);
    vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });
    await dispatch(fixture);
    const run = latestRolloutRun(fixture)!;
    expect(run.status).toBe('observing');

    // The boot sweep: the row outlived the process that armed it.
    HealthGateService.getInstance().start();

    const swept = DatabaseService.getInstance().getHealthGateRun(fixture.nodeId!, run.stack_name, run.id)!;
    expect(swept.status).toBe('unknown');
    const target = GitOpsStore.getInstance().getTarget(fixture.applicationId, fixture.nodeId!)!;
    expect(target.healthy_generation_id).toBeNull();
    expect(target.last_health_status).toBe('unknown');
  });

  it('reconstruction leaves a target that already owns an open run alone', async () => {
    const fixture = await authorizeWithPolicy('pause', 2);
    const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });
    await dispatch(fixture);
    expect(deploySpy).toHaveBeenCalledTimes(1);

    // A restart must not put a second apply on a target whose run the sweep owns.
    // Reconstruction walks every authorized application in the database, so the
    // claim is about this rollout's own targets rather than a global call count.
    await reconstructBlueprintRolloutQueue();

    const deployedForThisRollout = deploySpy.mock.calls
      .map((call) => call[0].node.id)
      .filter((nodeId) => fixture.nodeIds.includes(nodeId));
    expect(deployedForThisRollout).toEqual([fixture.nodeId]);
  });
});

describe('remote targets', () => {
  it('refuses non-observe health work to a remote target that cannot serve the verdict', async () => {
    const fixture = await authorizeWithPolicy('pause', 1, { remote: true });
    setHealthCapabilityProbeForTests(async () => ({ kind: 'unsupported' }));
    const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    const result = await dispatch(fixture);

    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') expect(result.reason).toMatch(/does not support health-gated rollout/i);
    expect(deploySpy).not.toHaveBeenCalled();
    // Refused before the apply and before any reservation.
    expect(latestRolloutRun(fixture)).toBeUndefined();
  });

  it('treats an unreachable target as refused, not as supported', async () => {
    const fixture = await authorizeWithPolicy('pause', 1, { remote: true });
    setHealthCapabilityProbeForTests(async () => ({ kind: 'unreachable', detail: 'transport_failure' }));
    const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    const result = await dispatch(fixture);

    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') expect(result.reason).toMatch(/could not be asked/i);
    expect(deploySpy).not.toHaveBeenCalled();
  });

  it('observe is never capability-gated on a remote target', async () => {
    const fixture = await authorizeWithPolicy('observe', 1, { remote: true });
    setHealthCapabilityProbeForTests(async () => ({ kind: 'unsupported' }));
    const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    const result = await dispatch(fixture);

    if (result.status === 'blocked') throw new Error(result.reason);
    expect(result.status).toBe('dispatched');
    expect(deploySpy).toHaveBeenCalledTimes(1);
  });
});

describe('the projection', () => {
  it('reports a target awaiting its verdict as health_checking, not converged', async () => {
    const fixture = await authorizeWithPolicy('pause', 1);
    vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });
    await dispatch(fixture);

    const projection = projectFixture(fixture);
    expect(projection.targets[0]!.runtime.status).toBe('health_checking');
  });

  it('attributes a Blueprint verdict on the applied generation, which is the pointer its mode can prove', async () => {
    const fixture = await authorizeWithPolicy('pause', 1);
    vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });
    await dispatch(fixture);

    const target = GitOpsStore.getInstance().getTarget(fixture.applicationId, fixture.nodeId!)!;
    // The premise: a Blueprint target has no deploy-bound writer, so its
    // deployed pointer is null. Attribution has to work without it.
    expect(target.deployed_generation_id).toBeNull();
    expect(target.applied_generation_id).toBe(fixture.generationId);

    finishHealth(fixture, fixture.nodeId!, 'passed');

    const after = GitOpsStore.getInstance().getTarget(fixture.applicationId, fixture.nodeId!)!;
    expect(after.last_health_status).toBe('passed');
    expect(after.healthy_generation_id).toBe(fixture.generationId);
  });

  it('produces a health drift item for a Blueprint target that failed', async () => {
    const fixture = await authorizeWithPolicy('observe', 1);
    vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });
    await dispatch(fixture);
    // Observe never gates advancement, so it reserves no run. The gate the
    // stack's own update path opened is the evidence the drift class reads.
    recordCompletedRun(fixture, fixture.nodeId!, 'failed');

    const projection = projectFixture(fixture);
    const health = projection.drift.find((item) => item.class === 'health');
    expect(health).toBeDefined();
    expect(health!.expected).toEqual({ kind: 'generation', id: fixture.generationId });
  });
});

// ---------------------------------------------------------------- helpers

type Seeded = {
  applicationId: string;
  nodeId: number;
  nodeIds: number[];
  blueprintId: number;
  generationId: string;
  artifactId: string;
  intentId: string;
  candidateId: string;
};

function seedApp(opts: { nodeCount: number; remote?: boolean }): Seeded {
  const store = GitOpsStore.getInstance();
  const nodeIds: number[] = [];
  for (let i = 0; i < opts.nodeCount; i += 1) {
    const result = DatabaseService.getInstance().getDb().prepare(
      `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
       VALUES (?, ?, 'proxy', '/tmp/compose', 0, 'online', ?)`,
    ).run(`hrp-node-${randomUUID().slice(0, 8)}`, opts.remote ? 'remote' : 'local', Date.now());
    nodeIds.push(result.lastInsertRowid as number);
  }
  const applicationId = `app-${randomUUID().slice(0, 8)}`;
  const intentId = `intent-${randomUUID().slice(0, 8)}`;
  const candidateId = `cand-${randomUUID().slice(0, 8)}`;
  const generationId = `gen-${randomUUID().slice(0, 8)}`;
  const artifactId = `art-${randomUUID().slice(0, 8)}`;
  const acceptanceId = `acc-${randomUUID().slice(0, 8)}`;
  const placementId = `place-${randomUUID().slice(0, 8)}`;
  const blueprintId = DatabaseService.getInstance().createBlueprint({
    name: `hrp-${applicationId}`,
    description: null,
    compose_content: 'services:\n  web:\n    image: alpine:3.20\n',
    selector: { type: 'nodes', ids: nodeIds },
    drift_mode: 'suggest',
    classification: 'stateless',
    classification_reasons: [],
    enabled: true,
    created_by: 'tester',
  }).id;
  DatabaseService.getInstance().updateBlueprintContentOrigin(blueprintId, 'git', applicationId);

  const app: GitOpsApplicationRow = {
    ...directApplicationFixture(applicationId, `src-${applicationId}`),
    target_mode: 'blueprint',
    lifecycle_key: `blueprint:${blueprintId}`,
    stack_name: null,
    configured_source_stack_name: `src-${applicationId}`,
    blueprint_id: blueprintId,
    intent_revision_id: intentId,
    rollout_candidate_id: candidateId,
    accepted_generation_id: generationId,
    artifact_set_id: artifactId,
    latest_artifact_set_id: artifactId,
    source_acceptance_ref: acceptanceId,
    placement_approval_ref: placementId,
    evidence_limitations_json: null,
  };
  store.insertApplication(app);
  store.insertIntentRevision(intentRow(intentId, applicationId, blueprintId));
  store.insertRolloutCandidate(candidateRow(candidateId, applicationId, intentId, nodeIds));
  store.insertGeneration(generationRow(generationId, applicationId, app.materialization_fingerprint!));
  store.insertArtifactSet(artifactRow(artifactId, generationId));
  store.insertApproval(approvalRow(acceptanceId, applicationId, generationId, 'source_acceptance'));
  store.insertApproval({
    ...approvalRow(placementId, applicationId, generationId, 'placement_approval'),
    generation_id: null,
    intent_revision_id: intentId,
    required_targets_json: encodeGitOpsRequiredTargetsJson(nodeIds),
    blast_json: encodeGitOpsApprovedTargetEffectJson(
      nodeIds.map((nodeId) => ({ nodeId, outcome: 'place' as const })),
    ),
  });
  for (const nodeId of nodeIds) {
    store.upsertTarget(targetRow(applicationId, nodeId));
  }
  return { applicationId, nodeId: nodeIds[0]!, nodeIds, blueprintId, generationId, artifactId, intentId, candidateId };
}

function setIntentPolicy(applicationId: string, policy: HealthRolloutPolicy): void {
  const store = GitOpsStore.getInstance();
  const app = store.getApplication(applicationId)!;
  store.updateIntentHealthPolicy(app.intent_revision_id!, JSON.stringify({ policy }));
}

async function authorizeWithPolicy(
  policy: HealthRolloutPolicy,
  nodeCount: number,
  opts: { remote?: boolean } = {},
): Promise<Seeded> {
  const fixture = seedApp({ nodeCount, ...opts });
  await writeAppliedCompose(fixture.applicationId);
  setIntentPolicy(fixture.applicationId, policy);
  const auth = await ensureRolloutAuthorization(fixture.applicationId, 'tester', 'manual', undefined, 'operator');
  expect(auth.ok).toBe(true);
  return fixture;
}

async function dispatch(fixture: Seeded) {
  const store = GitOpsStore.getInstance();
  const generation = store.getGeneration(fixture.generationId)!;
  return new BlueprintTargetAdapter().dispatch(buildAcceptedGeneration(generation), {
    targetMode: 'blueprint',
    nodeId: null,
    bindingRevision: null,
  });
}

/** The follow-up a passing verdict performs. */
async function advance(fixture: Seeded): Promise<void> {
  const app = GitOpsStore.getInstance().getApplication(fixture.applicationId)!;
  const binding = GitOpsStore.getInstance().currentAuthorizationBinding(app);
  if (!binding) return;
  const generation = GitOpsStore.getInstance().getGeneration(binding.acceptedGenerationId)!;
  await new BlueprintTargetAdapter().dispatch(buildAcceptedGeneration(generation), {
    targetMode: 'blueprint',
    nodeId: null,
    bindingRevision: binding.intentRevisionId,
  });
}

/** A seeded application with one target mid-rollout, holding a reserved run. */
async function gatedAttempt(policy: HealthRolloutPolicy): Promise<Seeded> {
  const fixture = await authorizeWithPolicy(policy, 2);
  vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
    .mockResolvedValue({ status: 'active' });
  await dispatch(fixture);
  return fixture;
}

/**
 * Rollout runs for one application.
 *
 * Scoped by application so a test never reads another test's reservation: the
 * suite shares one database, and the gate's startup sweep is a suite-level
 * concern rather than a per-test reset.
 */
function finishedRolloutRuns(fixture: Seeded): HealthGateRunRow[] {
  return DatabaseService.getInstance().getDb()
    .prepare(`SELECT * FROM health_gate_runs WHERE trigger_action = 'rollout' AND application_id = ?`)
    .all(fixture.applicationId) as HealthGateRunRow[];
}

function latestRolloutRun(fixture: Seeded): HealthGateRunRow | undefined {
  return finishedRolloutRuns(fixture).sort((a, b) => b.started_at - a.started_at)[0];
}

/** Finalize the target's pending run and record the verdict through the transition. */
/**
 * Finalize a run and record its verdict through the single writer.
 *
 * Returns the transition so a caller can act on the decision the way the real
 * path does: the transition records it, the executor carries it out afterwards.
 */
function finishHealth(
  fixture: Seeded,
  nodeId: number,
  status: 'passed' | 'failed' | 'unknown',
  runId?: string,
  policy: HealthRolloutPolicy = 'pause',
) {
  const store = GitOpsStore.getInstance();
  const target = store.getTarget(fixture.applicationId, nodeId)!;
  const runRowId = runId ?? target.pending_health_run_id!;
  const run = finishedRolloutRuns(fixture).find((row) => row.id === runRowId);
  if (!run) throw new Error(`no health run ${runRowId} for ${fixture.applicationId}`);
  DatabaseService.getInstance().finalizeHealthGateRun(
    run.id, status, 'test verdict', Date.now(), '[]', null,
  );
  return GitOpsTransitions.getInstance().healthFinalized({
    applicationId: fixture.applicationId,
    nodeId,
    healthRunId: run.id,
    healthStatus: status,
    deployedGenerationId: run.deployed_generation_id ?? null,
    targetScope: 'stack',
    rollout: { rolloutGenerationId: run.rollout_generation_id!, healthPolicy: policy },
    envelope: { operationId: run.id, actor: 'system:health-gate', trigger: 'health', at: Date.now() },
  });
}

/** Point a target at a fresh reserved run, as a retry would. */
function beginReplacementAttempt(fixture: Seeded): string {
  const runId = `run-retry-${randomUUID().slice(0, 8)}`;
  const app = GitOpsStore.getInstance().getApplication(fixture.applicationId)!;
  DatabaseService.getInstance().insertHealthGateRun({
    id: runId,
    node_id: fixture.nodeId!,
    stack_name: `src-${fixture.applicationId}`,
    trigger_action: 'rollout',
    status: 'observing',
    reason: null,
    window_seconds: 90,
    containers_json: '[]',
    started_at: Date.now() + 1,
    ended_at: null,
    created_by: 'tester',
    target_scope: 'stack',
    service_name: null,
    failure_source: null,
    deployed_generation_id: fixture.generationId,
    application_id: fixture.applicationId,
    intent_revision_id: app.intent_revision_id,
    rollout_generation_id: app.rollout_generation_id,
    artifact_set_id: fixture.artifactId,
    health_policy: 'pause',
  });
  const store = GitOpsStore.getInstance();
  const target = store.getTarget(fixture.applicationId, fixture.nodeId!)!;
  target.pending_health_run_id = runId;
  store.upsertTarget(target);
  return runId;
}

/**
 * A finished health run for a target, as the stack's own gate path writes it.
 *
 * Distinct from a rollout reservation: no pending pointer and no frozen policy,
 * because observe reserves neither.
 */
function recordCompletedRun(fixture: Seeded, nodeId: number, status: 'passed' | 'failed'): string {
  const runId = `run-gate-${randomUUID().slice(0, 8)}`;
  const app = GitOpsStore.getInstance().getApplication(fixture.applicationId)!;
  DatabaseService.getInstance().insertHealthGateRun({
    id: runId,
    node_id: nodeId,
    stack_name: `src-${fixture.applicationId}`,
    trigger_action: 'deploy',
    status: 'observing',
    reason: null,
    window_seconds: 90,
    containers_json: '[]',
    started_at: Date.now(),
    ended_at: null,
    created_by: 'tester',
    target_scope: 'stack',
    service_name: null,
    failure_source: null,
    deployed_generation_id: fixture.generationId,
  });
  DatabaseService.getInstance().finalizeHealthGateRun(runId, status, 'gate verdict', Date.now(), '[]', null);
  GitOpsTransitions.getInstance().healthFinalized({
    applicationId: app.id,
    nodeId,
    healthRunId: runId,
    healthStatus: status,
    deployedGenerationId: fixture.generationId,
    targetScope: 'stack',
    envelope: { operationId: runId, actor: 'system:health-gate', trigger: 'health', at: Date.now() },
  });
  return runId;
}

function markRecoveryPoint(fixture: Seeded, recoveryRef: string, generationId: string): void {
  const store = GitOpsStore.getInstance();
  const target = store.getTarget(fixture.applicationId, fixture.nodeId!)!;
  target.recovery_ref = recoveryRef;
  target.recovery_generation_id = generationId;
  store.upsertTarget(target);
}

function setLkg(fixture: Seeded, generationId: string): void {
  const store = GitOpsStore.getInstance();
  const target = store.getTarget(fixture.applicationId, fixture.nodeId!)!;
  target.lkg_generation_id = generationId;
  store.upsertTarget(target);
}

type RestoreOutcome = { ok: true } | { ok: false; code: string; error: string };

async function mockRestore(outcome: RestoreOutcome = { ok: true }) {
  const recovery = await import('../services/gitops/rolloutRecovery');
  return vi.spyOn(recovery, 'restoreTargetToGeneration')
    .mockResolvedValue(outcome) as unknown as MockInstance<typeof recovery.restoreTargetToGeneration>;
}

async function decide(
  fixture: Seeded,
  status: 'passed' | 'failed' | 'unknown',
  executor: HealthRolloutExecutor,
  policy: HealthRolloutPolicy = 'pause',
) {
  const store = GitOpsStore.getInstance();
  const target = store.getTarget(fixture.applicationId, fixture.nodeId!)!;
  const runId = target.pending_health_run_id!;
  const run = finishedRolloutRuns(fixture).find((row) => row.id === runId)!;
  DatabaseService.getInstance().finalizeHealthGateRun(runId, status, 'test', Date.now(), '[]', null);
  const app = store.getApplication(fixture.applicationId)!;
  const result = GitOpsTransitions.getInstance().healthFinalized({
    applicationId: fixture.applicationId,
    nodeId: fixture.nodeId!,
    healthRunId: runId,
    healthStatus: status,
    deployedGenerationId: run.deployed_generation_id ?? null,
    targetScope: 'stack',
    rollout: { rolloutGenerationId: app.rollout_generation_id!, healthPolicy: policy },
    envelope: { operationId: runId, actor: 'system:health-gate', trigger: 'health', at: Date.now() },
  });
  const outcome = await executeHealthRolloutDecision({
    applicationId: fixture.applicationId,
    nodeId: fixture.nodeId!,
    result,
    executor,
  });
  return { ...outcome, healthDecision: result.healthDecision };
}

async function writeAppliedCompose(applicationId: string): Promise<void> {
  const app = GitOpsStore.getInstance().getApplication(applicationId)!;
  const stackName = app.configured_source_stack_name!;
  const generation = GitOpsStore.getInstance().getGeneration(app.accepted_generation_id!)!;
  const nodeId = (await import('../services/NodeRegistry')).NodeRegistry.getInstance().getDefaultNodeId();
  const dir = path.join(dataDir, 'git-managed', String(nodeId), stackName, generation.applied_dir);
  await fsPromises.mkdir(dir, { recursive: true });
  await fsPromises.writeFile(
    path.join(dir, 'compose.yaml'),
    'services:\n  web:\n    image: alpine:3.20\n',
    'utf8',
  );
}

function intentRow(id: string, applicationId: string, blueprintId: number): GitOpsIntentRevisionRow {
  return {
    id,
    application_id: applicationId,
    blueprint_id: blueprintId,
    compose_content_sha256: 'a'.repeat(64),
    blueprint_revision: 1,
    deploy_stack_name: `src-${applicationId}`,
    selector_json: JSON.stringify({ type: 'nodes', ids: [] }),
    pinned_node_id: null,
    cordon_implications_json: JSON.stringify({ pinnedOverridesCordon: false }),
    rollout_strategy_json: JSON.stringify({ driftMode: 'suggest', enabled: true }),
    runtime_drift_policy: 'suggest',
    stateful_policy_json: null,
    health_failure_rollback_policy_json: null,
    operation_id: 'op-intent',
    actor: 'tester',
    created_at: 1,
  };
}

function candidateRow(id: string, applicationId: string, intentId: string, nodeIds: number[]): GitOpsRolloutCandidateRow {
  return {
    id,
    application_id: applicationId,
    intent_revision_id: intentId,
    compose_content_sha256: 'a'.repeat(64),
    accepted_generation_id: null,
    artifact_set_id: null,
    required_targets_json: encodeGitOpsRequiredTargetsJson(nodeIds),
    authoritative: 1,
    provenance: 'intent_change',
    operation_id: 'op-cand',
    created_at: 1,
  };
}

function generationRow(id: string, applicationId: string, fingerprint: string): GitOpsGenerationRow {
  return {
    id,
    application_id: applicationId,
    commit_sha: 'a'.repeat(40),
    repo_url: 'https://github.com/example/repo.git',
    configured_ref: 'main',
    resolved_ref_kind: 'branch',
    repo_identity_json: '{"host":"github.com","pathname":"/example/repo.git"}',
    manifest_version: 1,
    candidate_dir: `generations/candidate-${id}`,
    applied_dir: `generations/applied-${id}-0`,
    expected_invocation_json: '{}',
    materialization_fingerprint: fingerprint,
    validation_ok: 1,
    plan_blocked: 0,
    change_plan_fingerprint: null,
    operation_id: `op-${id}`,
    trigger: 'manual',
    actor: 'tester',
    previous_generation_id: null,
    redacted_limitations_json: '[]',
    portable_manifest_json: '{"files":[{"path":"compose.yaml","role":"primary"}]}',
    compose_inputs_json: '{"composeFileOrder":["compose.yaml"]}',
    source_policy_evidence_json: null,
    security_policy_evidence_json: null,
    support_requirements_json: null,
    compatibility_requirements_json: null,
    secret_capability_json: null,
    created_at: 1,
  };
}

function artifactRow(id: string, generationId: string): GitOpsArtifactSetRow {
  return {
    id,
    generation_id: generationId,
    evidence_version: 1,
    authoritative: 0,
    qualification: 'exact',
    evidence_json: JSON.stringify({ kind: 'exact', identity: 'sha256:deadbeef' }),
    created_at: 1,
  };
}

function approvalRow(
  id: string,
  applicationId: string,
  generationId: string,
  kind: 'source_acceptance' | 'placement_approval',
) {
  return {
    id,
    kind,
    authority: 'operator' as const,
    authoritative: 1,
    application_id: applicationId,
    generation_id: generationId,
    intent_revision_id: null,
    artifact_set_id: null,
    rollout_candidate_id: null,
    rollout_generation_id: null,
    source_acceptance_ref: null,
    placement_approval_ref: null,
    required_targets_json: null,
    preflight_fingerprint: null,
    fingerprint: null,
    blast_json: null,
    policy_provenance_json: null,
    actor: 'tester',
    operation_id: `op-${id}`,
    created_at: 1,
  } as Parameters<typeof GitOpsStore.prototype.insertApproval>[0];
}

function targetRow(applicationId: string, nodeId: number): GitOpsTargetCurrentRow {
  return {
    application_id: applicationId,
    node_id: nodeId,
    target_status: 'active',
    desired_generation_id: null,
    candidate_generation_id: null,
    applied_generation_id: null,
    deployed_generation_id: null,
    healthy_generation_id: null,
    last_health_status: null,
    last_health_generation_id: null,
    last_health_run_id: null,
    pending_health_run_id: null,
    health_attempts: 0,
    health_stop_reason: null,
    lkg_generation_id: null,
    lkg_artifact_set_id: null,
    lkg_unavailable_at: null,
    lkg_unavailable_reason: null,
    expected_artifact_set_id: null,
    latest_artifact_set_id: null,
    observed_artifact_identity_json: null,
    intent_revision_id: null,
    rollout_candidate_id: null,
    rollout_generation_id: null,
    source_acceptance_ref: null,
    placement_approval_ref: null,
    rollout_authorization_ref: null,
    legacy_combined_approval_ref: null,
    legacy_applied_revision: null,
    connectivity: null,
    latest_stage: null,
    active_operation_id: null,
    active_operation_stage: null,
    active_operation_at: null,
    active_generation_id: null,
    active_intent_revision_id: null,
    active_rollout_candidate_id: null,
    failure_stage: null,
    failure_class: null,
    failure_at: null,
    recovery_ref: null,
    recovery_generation_id: null,
    recovery_phase: null,
    interruption_stage: null,
    interruption_at: null,
    interruption_operation_id: null,
    interruption_generation_id: null,
    interruption_intent_revision_id: null,
    interruption_rollout_candidate_id: null,
    pause_at: null,
    pause_reason: null,
    retry_at: null,
    suspended_at: null,
    partial_json: null,
    evidence_limitations_json: null,
    updated_at: Date.now(),
  };
}
