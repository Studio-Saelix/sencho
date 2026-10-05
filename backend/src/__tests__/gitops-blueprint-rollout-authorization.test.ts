/**
 * PR2: rollout authorization, Git-managed dispatch from materialized
 * generations, derive facets, and restart-safe sequential place.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { encodeGitOpsApprovedTargetEffectJson, encodeGitOpsRequiredTargetsJson } from '../services/gitops/json';
import {
  buildPreflightEvidence,
  encodePreflightEvidenceJson,
  fingerprintPreflightEvidence,
  REGISTRY_PREFLIGHT_UNEVALUATED_REASON,
} from '../services/gitops/preflight';
import {
  configuredSnapshotFor,
  decodeApprovalPolicySnapshot,
  encodePolicySnapshot,
} from '../services/gitops/policyComposition';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import type {
  GitOpsApplicationRow,
  GitOpsArtifactSetRow,
  GitOpsGenerationRow,
  GitOpsIntentRevisionRow,
  GitOpsRolloutCandidateRow,
} from '../services/gitops/types';

let tmpDir: string;
let GitOpsStore: typeof import('../services/gitops/store').GitOpsStore;
let emptyTargetRow: typeof import('../services/gitops/store').emptyTargetRow;
let GitOpsTransitions: typeof import('../services/gitops/transitions').GitOpsTransitions;
let deriveGitOpsRevision: typeof import('../services/gitops/derive').deriveGitOpsRevision;
let projectApplication: typeof import('../services/gitops/derive').projectApplication;
let FACET_EVIDENCE_SOURCE: typeof import('../services/gitops/types').FACET_EVIDENCE_SOURCE;
let BlueprintTargetAdapter: typeof import('../services/gitops/handoff').BlueprintTargetAdapter;
let buildAcceptedGeneration: typeof import('../services/gitops/handoff').buildAcceptedGeneration;
let ensureRolloutAuthorization: typeof import('../services/gitops/handoff').ensureRolloutAuthorization;
let backfillMissingPreflightEvaluations: typeof import('../services/gitops/handoff').backfillMissingPreflightEvaluations;
let setRegistryReadinessDepsForTests: typeof import('../services/gitops/handoff').setRegistryReadinessDepsForTests;
let prepareAcceptedGitManagedGeneration: typeof import('../services/gitops/gitManagedMaterialization').prepareAcceptedGitManagedGeneration;
let readAppliedComposeContent: typeof import('../services/gitops/gitManagedMaterialization').readAppliedComposeContent;
let stackManagedRoot: typeof import('../services/gitops/directApplication').stackManagedRoot;
let CANDIDATE_COMPLETE_MARKER: typeof import('../services/GitProjectManifestService').CANDIDATE_COMPLETE_MARKER;
let reconstructBlueprintRolloutQueue: typeof import('../services/gitops/handoff').reconstructBlueprintRolloutQueue;
let holdBlockedRolloutDispatch: typeof import('../services/gitops/handoff').holdBlockedRolloutDispatch;
let liveHealthRolloutExecutor: typeof import('../services/gitops/handoff').liveHealthRolloutExecutor;
let dispatchPreparedGitManagedGeneration: typeof import('../services/gitops/gitManagedHandoff').dispatchPreparedGitManagedGeneration;
let GitSourceService: typeof import('../services/GitSourceService').GitSourceService;
let BlueprintService: typeof import('../services/BlueprintService').BlueprintService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let dataDir: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  ({ GitOpsStore, emptyTargetRow } = await import('../services/gitops/store'));
  ({ GitOpsTransitions } = await import('../services/gitops/transitions'));
  ({ deriveGitOpsRevision } = await import('../services/gitops/derive'));
  ({ projectApplication } = await import('../services/gitops/derive'));
  ({ FACET_EVIDENCE_SOURCE } = await import('../services/gitops/types'));
  ({
    BlueprintTargetAdapter,
    buildAcceptedGeneration,
    ensureRolloutAuthorization,
    reconstructBlueprintRolloutQueue,
    setRegistryReadinessDepsForTests,
    backfillMissingPreflightEvaluations,
    holdBlockedRolloutDispatch,
    liveHealthRolloutExecutor,
  } = await import('../services/gitops/handoff'));
  ({ dispatchPreparedGitManagedGeneration } = await import('../services/gitops/gitManagedHandoff'));
  ({ GitSourceService } = await import('../services/GitSourceService'));
  ({ BlueprintService } = await import('../services/BlueprintService'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ prepareAcceptedGitManagedGeneration } = await import('../services/gitops/gitManagedMaterialization'));
  ({ readAppliedComposeContent } = await import('../services/gitops/gitManagedMaterialization'));
  ({ stackManagedRoot } = await import('../services/gitops/directApplication'));
  ({ CANDIDATE_COMPLETE_MARKER } = await import('../services/GitProjectManifestService'));
});

afterAll(() => cleanupTestDb(tmpDir));

function registryReadyTestDeps() {
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

/**
 * Reconstruction walks every authorized application in the DB, and earlier
 * tests leave their fixtures behind, so a count assertion needs only this
 * test's application to exist.
 */
function clearGitOpsState(): void {
  const db = DatabaseService.getInstance().getDb();
  for (const table of [
    'gitops_target_current', 'gitops_history', 'gitops_approvals', 'gitops_rollout_generations',
    'gitops_rollout_candidates', 'gitops_artifact_sets', 'gitops_generations',
    'gitops_intent_revisions', 'gitops_applications',
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
  GitOpsStore.resetForTests();
  GitOpsTransitions.resetForTests();
  setRegistryReadinessDepsForTests(registryReadyTestDeps());
});

afterEach(() => {
  setRegistryReadinessDepsForTests(null);
});

describe('rollout authorization transition', () => {
  it('mints rollout_authorization and opens a rollout_authorization generation', () => {
    const fixture = seedAuthorizedReadyApp();
    const preflight = nonBlockingPreflightForApp(fixture.applicationId);
    const fingerprint = fingerprintPreflightEvidence(preflight);
    GitOpsTransitions.getInstance().rolloutAuthorized({
      applicationId: fixture.applicationId,
      approvalId: 'auth-1',
      rolloutGenerationId: 'rgen-auth-1',
      preflightFingerprint: fingerprint,
      preflightEvidenceJson: encodePreflightEvidenceJson(preflight),
      actor: 'tester',
      envelope: { operationId: 'op-auth-1', actor: 'tester', trigger: 'manual', at: 100 },
      authority: 'operator',
      policyProvenanceJson: null,
    });
    const store = GitOpsStore.getInstance();
    const app = store.getApplication(fixture.applicationId)!;
    expect(app.rollout_authorization_ref).toBe('auth-1');
    expect(app.preflight_fingerprint).toBe(fingerprint);
    expect(app.rollout_generation_id).toBe('rgen-auth-1');
    expect(store.getApproval('auth-1')?.kind).toBe('rollout_authorization');
    expect(store.getRolloutGeneration('rgen-auth-1')?.provenance).toBe('rollout_authorization');
    expect(app.evidence_limitations_json ?? '').not.toContain('git_managed_rollout_not_enabled');
  });

  it('keeps placement across source-only change and clears authorization', () => {
    const fixture = seedAuthorizedReadyApp();
    authorize(fixture.applicationId);
    const store = GitOpsStore.getInstance();
    const before = store.getApplication(fixture.applicationId)!;
    expect(before.placement_approval_ref).toBeTruthy();
    expect(before.rollout_authorization_ref).toBeTruthy();
    const placementRef = before.placement_approval_ref;

    const fingerprint = before.materialization_fingerprint!;
    const nextGenId = `gen-${randomUUID().slice(0, 8)}`;
    const artId = `art-${randomUUID().slice(0, 8)}`;
    insertGeneration(nextGenId, fixture.applicationId, fingerprint);
    const envelope = { operationId: randomUUID(), actor: 'tester', trigger: 'manual', at: 200 };
    GitOpsTransitions.getInstance().candidateReady(fixture.applicationId, nextGenId, false, envelope);
    GitOpsTransitions.getInstance().setGitManagedArtifactLimitation({
      applicationId: fixture.applicationId,
      detail: 'the approved compose interpolates an image reference',
    });
    expect(store.getApplication(fixture.applicationId)!.evidence_limitations_json)
      .toContain('git_managed_artifact_unmodellable');
    GitOpsTransitions.getInstance().sourceAccepted({
      applicationId: fixture.applicationId,
      generationId: nextGenId,
      artifactSetId: artId,
      sourceAcceptanceId: `acc-${randomUUID().slice(0, 8)}`,
      authority: 'operator',
      envelope: { operationId: randomUUID(), actor: 'tester', trigger: 'manual', at: 201 },
    });

    const after = store.getApplication(fixture.applicationId)!;
    expect(after.placement_approval_ref).toBe(placementRef);
    expect(after.accepted_generation_id).toBe(nextGenId);
    expect(after.rollout_authorization_ref).toBeNull();
    expect(after.preflight_fingerprint).toBeNull();

    // The candidate the first authorization stamped must move with the
    // acceptance, or `authorizationIngredients` refuses the new generation and
    // the rollout can never be authorized again. Its artifact binding is
    // cleared, not pointed at the seed set: the freeze that follows advances the
    // application's set, and authorization re-stamps both from the resolved one.
    const candidate = after.rollout_candidate_id
      ? store.getRolloutCandidate(after.rollout_candidate_id)
      : undefined;
    expect(candidate?.accepted_generation_id).toBe(nextGenId);
    expect(candidate?.artifact_set_id).toBeNull();
    // A new acceptance replaces the content the previous refusal described, so
    // the stale reason goes with it before the new freeze runs.
    expect(after.evidence_limitations_json ?? '').not.toContain('git_managed_artifact_unmodellable');
    expect(
      store.authorizationIngredients(after),
      'the rebound candidate and the kept placement form a binding the next authorization can use',
    ).not.toBeNull();
  });

  function acceptNextGeneration(
    fixture: { applicationId: string; generationId: string },
    at: number,
  ): string {
    const store = GitOpsStore.getInstance();
    const before = store.getApplication(fixture.applicationId)!;
    const nextGenId = `gen-${randomUUID().slice(0, 8)}`;
    insertGeneration(nextGenId, fixture.applicationId, before.materialization_fingerprint!);
    const envelope = { operationId: randomUUID(), actor: 'tester', trigger: 'manual', at };
    GitOpsTransitions.getInstance().candidateReady(fixture.applicationId, nextGenId, false, envelope);
    GitOpsTransitions.getInstance().sourceAccepted({
      applicationId: fixture.applicationId,
      generationId: nextGenId,
      artifactSetId: `art-${randomUUID().slice(0, 8)}`,
      sourceAcceptanceId: `acc-${randomUUID().slice(0, 8)}`,
      authority: 'operator',
      envelope,
    });
    return nextGenId;
  }

  it('clears a system hold when a source acceptance supersedes its rollout', () => {
    const fixture = seedAuthorizedReadyApp();
    authorize(fixture.applicationId);
    const store = GitOpsStore.getInstance();
    holdBlockedRolloutDispatch(fixture.applicationId, { reason: 'Deploy to node 2 failed: boom', holdable: true });
    expect(store.getApplication(fixture.applicationId)!.pause_at).not.toBeNull();
    expect(store.getApplication(fixture.applicationId)!.pause_origin).toBe('system');

    acceptNextGeneration(fixture, 400);

    // The hold belonged to the rollout this acceptance supersedes, and its
    // reason described that rollout. Leaving it would block the new generation
    // with a stale reason until a person resumed.
    const after = store.getApplication(fixture.applicationId)!;
    expect(after.pause_at).toBeNull();
    expect(after.pause_origin).toBe('operator');
  });

  it('keeps an operator pause across a source acceptance', () => {
    const fixture = seedAuthorizedReadyApp();
    authorize(fixture.applicationId);
    const store = GitOpsStore.getInstance();
    GitOpsTransitions.getInstance().rolloutPaused(fixture.applicationId, null, 'maintenance window', {
      operationId: randomUUID(), actor: 'tester', trigger: 'manual', at: 300,
    });
    expect(store.getApplication(fixture.applicationId)!.pause_origin).toBe('operator');

    acceptNextGeneration(fixture, 400);

    // A deliberate stop is the operator's, and only the operator's own resume
    // clears it.
    const after = store.getApplication(fixture.applicationId)!;
    expect(after.pause_at).not.toBeNull();
    expect(after.pause_reason).toBe('maintenance window');
  });

  it('keeps a health-policy hold across a source acceptance', () => {
    const fixture = seedAuthorizedReadyApp();
    authorize(fixture.applicationId);
    const store = GitOpsStore.getInstance();
    GitOpsTransitions.getInstance().rolloutPaused(fixture.applicationId, null, 'health hold', {
      operationId: randomUUID(), actor: 'tester', trigger: 'test', at: 300,
    }, 'health');
    expect(store.getApplication(fixture.applicationId)!.pause_origin).toBe('health');

    acceptNextGeneration(fixture, 400);

    // A health-policy hold is a deliberate stop; a new commit must not resume
    // it behind the operator's back.
    const after = store.getApplication(fixture.applicationId)!;
    expect(after.pause_at).not.toBeNull();
    expect(after.pause_origin).toBe('health');
  });

  it('leaves a system hold in place while a target has an unfinished rollback', () => {
    const fixture = seedAuthorizedReadyApp();
    authorize(fixture.applicationId);
    const store = GitOpsStore.getInstance();
    holdBlockedRolloutDispatch(fixture.applicationId, { reason: 'Deploy to node 2 failed: boom', holdable: true });
    store.upsertTarget({
      ...store.getTarget(fixture.applicationId, fixture.nodeId)!,
      health_stop_reason: 'rollback_pending',
    });

    acceptNextGeneration(fixture, 400);

    // The target's rollback fence is scoped to the old rollout generation, so
    // the next dispatch's guard no longer sees it. Lifting the hold here would
    // deploy over a target whose rollback never finished.
    expect(store.getApplication(fixture.applicationId)!.pause_at).not.toBeNull();
  });

  it('the health executor holds a transient advance refusal with the health origin', async () => {
    const fixture = seedAuthorizedReadyApp();
    authorize(fixture.applicationId);
    const dispatchSpy = vi.spyOn(BlueprintTargetAdapter.prototype, 'dispatch')
      .mockResolvedValue({ status: 'blocked', reason: 'Deploy to node 1 is already in progress.', holdable: false });

    await liveHealthRolloutExecutor().advance(fixture.applicationId, null);

    // On this path the dispatch is the only thing that brings the next target,
    // so a transient refusal is held rather than left queued with no reason.
    const app = GitOpsStore.getInstance().getApplication(fixture.applicationId)!;
    expect(app.pause_at).not.toBeNull();
    expect(app.pause_origin).toBe('health');
    dispatchSpy.mockRestore();
  });

  it('the health executor does not escalate a per-target pause', async () => {
    const fixture = seedAuthorizedReadyApp();
    authorize(fixture.applicationId);
    const dispatchSpy = vi.spyOn(BlueprintTargetAdapter.prototype, 'dispatch')
      .mockResolvedValue({
        status: 'blocked',
        reason: 'The rollout is paused on 1 target.',
        holdable: false,
        alreadyPaused: true,
      });

    await liveHealthRolloutExecutor().advance(fixture.applicationId, null);

    // The pause is already on record on the target; an application pause would
    // need a second, broader Resume to undo one node's decision.
    expect(GitOpsStore.getInstance().getApplication(fixture.applicationId)!.pause_at).toBeNull();
    dispatchSpy.mockRestore();
  });

  it('rejects reusing authorization when artifact identity changes', () => {
    const fixture = seedAuthorizedReadyApp();
    authorize(fixture.applicationId);
    const store = GitOpsStore.getInstance();
    const movedId = `art-${randomUUID().slice(0, 8)}`;
    store.insertArtifactSet(artifact(movedId, fixture.generationId, 'exact', 2));
    GitOpsTransitions.getInstance().acceptArtifactExpectation({
      applicationId: fixture.applicationId,
      generationId: fixture.generationId,
      artifactSetId: movedId,
      envelope: { operationId: randomUUID(), actor: 'tester', trigger: 'manual', at: 300 },
    });
    const app = store.getApplication(fixture.applicationId)!;
    expect(app.artifact_set_id).toBe(movedId);
    expect(app.rollout_authorization_ref).toBeNull();
    expect(store.currentAuthorizationBinding(app)).toBeNull();
  });
});

describe('BlueprintTargetAdapter unlock', () => {
  it('refuses dispatch when placement is missing', async () => {
    const fixture = seedAuthorizedReadyApp({ skipPlacement: true });
    const gen = buildAcceptedGeneration(GitOpsStore.getInstance().getGeneration(fixture.generationId)!);
    const result = await new BlueprintTargetAdapter().dispatch(gen, {
      targetMode: 'blueprint',
      nodeId: fixture.nodeId,
      bindingRevision: null,
    });
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.reason).toMatch(/Placement approval/i);
    }
  });

  it('dispatches materialized compose bytes, never blueprint.compose_content', async () => {
    const fixture = seedAuthorizedReadyApp();
    await writeAppliedCompose(fixture.applicationId, fixture.generationId, 'services:\n  fromgen:\n    image: alpine:3.20\n');
    DatabaseService.getInstance().getDb().prepare(
      `UPDATE blueprints SET compose_content = ? WHERE id = ?`,
    ).run('services:\n  snapshot:\n    image: nginx:stale\n', fixture.blueprintId);

    const seen: string[] = [];
    vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization').mockImplementation(async (args) => {
      seen.push(args.composeContent);
      return { status: 'active' };
    });

    const gen = buildAcceptedGeneration(GitOpsStore.getInstance().getGeneration(fixture.generationId)!);
    const result = await new BlueprintTargetAdapter().dispatch(gen, {
      targetMode: 'blueprint',
      nodeId: fixture.nodeId,
      bindingRevision: null,
    });
    expect(result.status).toBe('dispatched');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('fromgen');
    expect(seen[0]).not.toContain('snapshot');
    expect(GitOpsStore.getInstance().getApplication(fixture.applicationId)?.rollout_authorization_ref).toBeTruthy();
  });

  it('creates a target row for every frozen node before the first deploy', async () => {
    const fixture = seedAuthorizedReadyApp({ nodeCount: 2 });
    await writeAppliedCompose(fixture.applicationId, fixture.generationId, 'services:\n  web:\n    image: alpine:3.20\n');
    // Model a converted source: the frozen set names a node that never
    // received a Direct deploy, so it has no target row yet. Without the
    // dispatch-boundary materialization this is the audit's
    // "Could not open deploy for node N: target not found".
    const store = GitOpsStore.getInstance();
    DatabaseService.getInstance().getDb().prepare(
      'DELETE FROM gitops_target_current WHERE application_id = ? AND node_id = ?',
    ).run(fixture.applicationId, fixture.nodeIds[1]);
    expect(store.getTarget(fixture.applicationId, fixture.nodeIds[1])).toBeUndefined();

    const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });
    const gen = buildAcceptedGeneration(store.getGeneration(fixture.generationId)!);
    const result = await new BlueprintTargetAdapter().dispatch(gen, {
      targetMode: 'blueprint',
      nodeId: fixture.nodeId,
      bindingRevision: null,
    });
    expect(result.status).toBe('dispatched');
    expect(deploySpy).toHaveBeenCalledTimes(2);
    const created = store.getTarget(fixture.applicationId, fixture.nodeIds[1]);
    expect(created?.target_status).toBe('active');
    expect(created?.applied_generation_id).toBe(fixture.generationId);
  });

  it('refuses a frozen node that no longer exists without inventing a row', async () => {
    const fixture = seedAuthorizedReadyApp({ nodeCount: 2 });
    await writeAppliedCompose(fixture.applicationId, fixture.generationId, 'services:\n  web:\n    image: alpine:3.20\n');
    const store = GitOpsStore.getInstance();
    const db = DatabaseService.getInstance().getDb();
    db.prepare('DELETE FROM gitops_target_current WHERE application_id = ? AND node_id = ?')
      .run(fixture.applicationId, fixture.nodeIds[1]);
    db.prepare('DELETE FROM nodes WHERE id = ?').run(fixture.nodeIds[1]);

    const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });
    const gen = buildAcceptedGeneration(store.getGeneration(fixture.generationId)!);
    const result = await new BlueprintTargetAdapter().dispatch(gen, {
      targetMode: 'blueprint',
      nodeId: fixture.nodeId,
      bindingRevision: null,
    });
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') {
      expect(result.reason).toMatch(new RegExp(`node ${fixture.nodeIds[1]} is missing`));
    }
    expect(store.getTarget(fixture.applicationId, fixture.nodeIds[1])).toBeUndefined();
    expect(deploySpy).toHaveBeenCalledTimes(1);
  });

  it('restart mid-place does not re-issue deploy for an already-acked target', async () => {
    const fixture = seedAuthorizedReadyApp({ nodeCount: 2 });
    await writeAppliedCompose(fixture.applicationId, fixture.generationId, 'services:\n  web:\n    image: alpine:3.20\n');
    authorize(fixture.applicationId);
    const store = GitOpsStore.getInstance();
    const app = store.getApplication(fixture.applicationId)!;
    const binding = store.currentAuthorizationBinding(app)!;
    const [firstNode, secondNode] = fixture.nodeIds;

    store.upsertTarget({
      ...emptyTarget(fixture.applicationId, firstNode!),
      intent_revision_id: binding.intentRevisionId,
      rollout_candidate_id: binding.rolloutCandidateId,
      applied_generation_id: binding.acceptedGenerationId,
      desired_generation_id: binding.acceptedGenerationId,
      rollout_authorization_ref: app.rollout_authorization_ref,
      latest_stage: 'blueprint_ack_recorded',
    });
    store.upsertTarget(emptyTarget(fixture.applicationId, secondNode!));

    const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    const resumed = await reconstructBlueprintRolloutQueue();
    expect(resumed).toBe(1);
    expect(deploySpy).toHaveBeenCalledTimes(1);
    expect(deploySpy.mock.calls[0]![0].node.id).toBe(secondNode);
  });

  it('blocks without recording deploy failure when the blueprint lock is held', async () => {
    const fixture = seedAuthorizedReadyApp();
    await writeAppliedCompose(fixture.applicationId, fixture.generationId, 'services:\n  web:\n    image: alpine:3.20\n');
    const svc = BlueprintService.getInstance();
    expect(svc.tryAcquireAuthorizedDeployLock(fixture.blueprintId, fixture.nodeId)).toBe(true);
    try {
      const failedSpy = vi.spyOn(GitOpsTransitions.getInstance(), 'blueprintDeployFailed');
      const gen = buildAcceptedGeneration(GitOpsStore.getInstance().getGeneration(fixture.generationId)!);
      const result = await new BlueprintTargetAdapter().dispatch(gen, {
        targetMode: 'blueprint',
        nodeId: fixture.nodeId,
        bindingRevision: null,
      });
      expect(result.status).toBe('blocked');
      if (result.status === 'blocked') {
        expect(result.reason).toMatch(/already in progress/i);
        // Lock contention resolves when the holder finishes; it must not be
        // escalated into an application pause.
        expect(result.holdable).toBe(false);
      }
      expect(failedSpy).not.toHaveBeenCalled();
      const target = GitOpsStore.getInstance().getTarget(fixture.applicationId, fixture.nodeId);
      expect(target?.failure_stage).toBeNull();
      expect(target?.active_operation_stage).toBeNull();
      // The joint the classification exists for: this real blocked result goes
      // through the real hold helper and must not pause the rollout.
      if (result.status === 'blocked') {
        holdBlockedRolloutDispatch(fixture.applicationId, result);
      }
      expect(GitOpsStore.getInstance().getApplication(fixture.applicationId)?.pause_at).toBeNull();
    } finally {
      svc.releaseAuthorizedDeployLock(fixture.blueprintId, fixture.nodeId);
    }
  });

  it('redeploys when an ack carries a stale rollout authorization ref', async () => {
    const fixture = seedAuthorizedReadyApp();
    await writeAppliedCompose(fixture.applicationId, fixture.generationId, 'services:\n  web:\n    image: alpine:3.20\n');
    authorize(fixture.applicationId);
    const store = GitOpsStore.getInstance();
    const app = store.getApplication(fixture.applicationId)!;
    const binding = store.currentAuthorizationBinding(app)!;
    store.upsertTarget({
      ...emptyTarget(fixture.applicationId, fixture.nodeId),
      intent_revision_id: binding.intentRevisionId,
      rollout_candidate_id: binding.rolloutCandidateId,
      applied_generation_id: binding.acceptedGenerationId,
      desired_generation_id: binding.acceptedGenerationId,
      rollout_authorization_ref: 'stale-auth-ref',
      latest_stage: 'blueprint_ack_recorded',
      target_status: 'active',
    });
    const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });
    const gen = buildAcceptedGeneration(store.getGeneration(fixture.generationId)!);
    const result = await new BlueprintTargetAdapter().dispatch(gen, {
      targetMode: 'blueprint',
      nodeId: fixture.nodeId,
      bindingRevision: null,
    });
    expect(result.status).toBe('dispatched');
    expect(deploySpy).toHaveBeenCalledTimes(1);
  });
});

describe('second source commit', () => {
  it('re-materializes, re-freezes, and redeploys the new generation to every frozen target', async () => {
    const fixture = seedAuthorizedReadyApp({ nodeCount: 2 });
    await writeAppliedCompose(fixture.applicationId, fixture.generationId, 'services:\n  web:\n    image: alpine:3.20\n');
    authorize(fixture.applicationId);
    const store = GitOpsStore.getInstance();
    const firstAuthRef = store.getApplication(fixture.applicationId)!.rollout_authorization_ref;
    const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });
    const firstDispatch = await new BlueprintTargetAdapter().dispatch(
      buildAcceptedGeneration(store.getGeneration(fixture.generationId)!),
      { targetMode: 'blueprint', nodeId: fixture.nodeId, bindingRevision: null },
    );
    expect(firstDispatch.status).toBe('dispatched');
    expect(deploySpy).toHaveBeenCalledTimes(2);

    // A second commit: the poll stages a candidate, the operator (or policy)
    // accepts it, and the Git-managed preparation must promote and resolve it.
    const app = store.getApplication(fixture.applicationId)!;
    const nextGenId = `gen-${randomUUID().slice(0, 8)}`;
    const artId = `art-${randomUUID().slice(0, 8)}`;
    const gen2 = insertGeneration(nextGenId, fixture.applicationId, app.materialization_fingerprint!);
    await writeCandidateCompose(app.configured_source_stack_name!, gen2, 'services:\n  web:\n    image: alpine:3.21\n');
    const envelope = { operationId: randomUUID(), actor: 'tester', trigger: 'manual', at: 900 };
    GitOpsTransitions.getInstance().candidateReady(fixture.applicationId, nextGenId, false, envelope);
    GitOpsTransitions.getInstance().sourceAccepted({
      applicationId: fixture.applicationId,
      generationId: nextGenId,
      artifactSetId: artId,
      sourceAcceptanceId: `acc-${randomUUID().slice(0, 8)}`,
      authority: 'operator',
      envelope,
    });
    const encodeArtifactEvidenceJson = (await import('../services/gitops/json')).encodeArtifactEvidenceJson;
    vi.spyOn(await import('../services/gitops/artifactResolve'), 'resolveAndRecordArtifactSet')
      .mockImplementation(async (call) => {
        GitOpsTransitions.getInstance().recordArtifactEvidence({
          applicationId: call.applicationId,
          generationId: call.generationId,
          artifactSetId: `resolved-${nextGenId}`,
          evidenceVersion: 2,
          qualification: 'exact',
          evidenceJson: encodeArtifactEvidenceJson({ kind: 'exact', identity: 'sha256:cafebabe' }),
          authoritative: 0,
          envelope: { operationId: randomUUID(), actor: 'tester', trigger: 'test', at: 901 },
        });
      });

    const prepared = await prepareAcceptedGitManagedGeneration({
      applicationId: fixture.applicationId,
      generationId: nextGenId,
      actor: 'tester',
      trigger: 'manual',
    });
    expect(prepared.materialized).toBe(true);
    expect(prepared.artifact).toBe('resolved');
    // The candidate was actually promoted: the applied directory holds the new
    // compose and the candidate directory is gone.
    const stackName = store.getApplication(fixture.applicationId)!.configured_source_stack_name!;
    await expect(fsPromises.access(path.join(stackManagedRoot(stackName), gen2.candidate_dir))).rejects.toBeTruthy();
    expect(await readAppliedComposeContent(store.getApplication(fixture.applicationId)!, gen2)).toContain('alpine:3.21');

    const auth = await ensureRolloutAuthorization(fixture.applicationId, 'system:source-controller');
    expect(auth.ok, auth.ok ? '' : auth.reason).toBe(true);
    const authorizedApp = store.getApplication(fixture.applicationId)!;
    expect(authorizedApp.rollout_authorization_ref).toBeTruthy();
    expect(authorizedApp.rollout_authorization_ref).not.toBe(firstAuthRef);
    if (auth.ok) {
      expect(auth.binding.acceptedGenerationId).toBe(nextGenId);
      const candidate = store.getRolloutCandidate(auth.binding.rolloutCandidateId)!;
      expect(candidate.accepted_generation_id).toBe(nextGenId);
      expect(candidate.artifact_set_id).toBe(`resolved-${nextGenId}`);
    }

    const deployed: string[] = [];
    deploySpy.mockClear();
    deploySpy.mockImplementation(async (args) => {
      deployed.push(args.composeContent);
      return { status: 'active' };
    });
    const secondDispatch = await new BlueprintTargetAdapter().dispatch(
      buildAcceptedGeneration(store.getGeneration(nextGenId)!),
      { targetMode: 'blueprint', nodeId: fixture.nodeId, bindingRevision: null },
    );
    expect(secondDispatch.status).toBe('dispatched');
    expect(deploySpy).toHaveBeenCalledTimes(2);
    const calledNodeIds = deploySpy.mock.calls.map((call) => call[0].node.id).sort((a, b) => a - b);
    expect(calledNodeIds).toEqual([...fixture.nodeIds].sort((a, b) => a - b));
    for (const content of deployed) {
      expect(content).toContain('alpine:3.21');
      expect(content).not.toContain('alpine:3.20');
    }
    for (const nodeId of fixture.nodeIds) {
      expect(store.getTarget(fixture.applicationId, nodeId)?.applied_generation_id).toBe(nextGenId);
    }

    // A converged second commit must not read as managed-project drift. The
    // Direct manifest cache still describes the first generation, and the
    // Blueprint path deliberately never writes it, so the comparison would
    // report drift no writer could ever clear.
    seedStaleManifestCache(
      app.configured_source_stack_name!,
      store.getGeneration(fixture.generationId)!.applied_dir,
      'a'.repeat(40),
    );
    const projection = projectApplication(fixture.applicationId, false);
    expect(projection.drift.some((item) => item.class === 'managed_project')).toBe(false);
  });
});

describe('application-driven preparation retry', () => {
  /** Stage and accept a second commit whose first preparation fails. */
  async function acceptSecondCommitWithFailedPreparation(fixture: {
    applicationId: string;
    generationId: string;
    blueprintId: number;
  }): Promise<{ nextGenId: string; resolveNow: () => void }> {
    const store = GitOpsStore.getInstance();
    const app = store.getApplication(fixture.applicationId)!;
    const nextGenId = `gen-${randomUUID().slice(0, 8)}`;
    const artId = `art-${randomUUID().slice(0, 8)}`;
    const gen2 = insertGeneration(nextGenId, fixture.applicationId, app.materialization_fingerprint!);
    await writeCandidateCompose(app.configured_source_stack_name!, gen2, 'services:\n  web:\n    image: alpine:3.21\n');
    const envelope = { operationId: randomUUID(), actor: 'tester', trigger: 'manual', at: 900 };
    GitOpsTransitions.getInstance().candidateReady(fixture.applicationId, nextGenId, false, envelope);
    GitOpsTransitions.getInstance().sourceAccepted({
      applicationId: fixture.applicationId,
      generationId: nextGenId,
      artifactSetId: artId,
      sourceAcceptanceId: `acc-${randomUUID().slice(0, 8)}`,
      authority: 'operator',
      envelope,
    });
    const resolveSpy = vi.spyOn(await import('../services/gitops/artifactResolve'), 'resolveAndRecordArtifactSet')
      .mockResolvedValue(undefined);
    const failed = await prepareAcceptedGitManagedGeneration({
      applicationId: fixture.applicationId,
      generationId: nextGenId,
      actor: 'tester',
      trigger: 'manual',
    });
    expect(failed.materialized).toBe(true);
    expect(failed.artifact).toBe('none');
    const encodeArtifactEvidenceJson = (await import('../services/gitops/json')).encodeArtifactEvidenceJson;
    const resolveNow = (): void => {
      resolveSpy.mockImplementation(async (call) => {
        GitOpsTransitions.getInstance().recordArtifactEvidence({
          applicationId: call.applicationId,
          generationId: call.generationId,
          artifactSetId: `resolved-${nextGenId}`,
          evidenceVersion: 2,
          qualification: 'exact',
          evidenceJson: encodeArtifactEvidenceJson({ kind: 'exact', identity: 'sha256:cafebabe' }),
          authoritative: 0,
          envelope: { operationId: randomUUID(), actor: 'tester', trigger: 'test', at: 901 },
        });
      });
    };
    return { nextGenId, resolveNow };
  }

  it('recovers a failed preparation of a newly accepted generation without a new commit', async () => {
    const fixture = seedAuthorizedReadyApp({ nodeCount: 2 });
    await writeAppliedCompose(fixture.applicationId, fixture.generationId, 'services:\n  web:\n    image: alpine:3.20\n');
    authorize(fixture.applicationId);
    const store = GitOpsStore.getInstance();
    const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });
    const first = await new BlueprintTargetAdapter().dispatch(
      buildAcceptedGeneration(store.getGeneration(fixture.generationId)!),
      { targetMode: 'blueprint', nodeId: fixture.nodeId, bindingRevision: null },
    );
    expect(first.status).toBe('dispatched');

    // A second commit is accepted while the registry is down: the resolver
    // records nothing, so the application stays on the unresolved seed set.
    const app = store.getApplication(fixture.applicationId)!;
    const nextGenId = `gen-${randomUUID().slice(0, 8)}`;
    const artId = `art-${randomUUID().slice(0, 8)}`;
    const gen2 = insertGeneration(nextGenId, fixture.applicationId, app.materialization_fingerprint!);
    await writeCandidateCompose(app.configured_source_stack_name!, gen2, 'services:\n  web:\n    image: alpine:3.21\n');
    const envelope = { operationId: randomUUID(), actor: 'tester', trigger: 'manual', at: 900 };
    GitOpsTransitions.getInstance().candidateReady(fixture.applicationId, nextGenId, false, envelope);
    GitOpsTransitions.getInstance().sourceAccepted({
      applicationId: fixture.applicationId,
      generationId: nextGenId,
      artifactSetId: artId,
      sourceAcceptanceId: `acc-${randomUUID().slice(0, 8)}`,
      authority: 'operator',
      envelope,
    });
    const resolveSpy = vi.spyOn(await import('../services/gitops/artifactResolve'), 'resolveAndRecordArtifactSet')
      .mockResolvedValue(undefined);
    const failed = await prepareAcceptedGitManagedGeneration({
      applicationId: fixture.applicationId,
      generationId: nextGenId,
      actor: 'tester',
      trigger: 'manual',
    });
    expect(failed.materialized).toBe(true);
    expect(failed.artifact).toBe('none');
    // The targets still hold the previous generation, which is exactly the
    // state the per-target artifact retry cannot see past.
    for (const nodeId of fixture.nodeIds) {
      expect(store.getTarget(fixture.applicationId, nodeId)?.desired_generation_id).toBe(fixture.generationId);
    }

    // The registry comes back. The reconciler tick alone must make the new
    // generation authorizable and, under the automatic policy, dispatch it.
    const encodeArtifactEvidenceJson = (await import('../services/gitops/json')).encodeArtifactEvidenceJson;
    resolveSpy.mockImplementation(async (call) => {
      GitOpsTransitions.getInstance().recordArtifactEvidence({
        applicationId: call.applicationId,
        generationId: call.generationId,
        artifactSetId: `resolved-${nextGenId}`,
        evidenceVersion: 2,
        qualification: 'exact',
        evidenceJson: encodeArtifactEvidenceJson({ kind: 'exact', identity: 'sha256:cafebabe' }),
        authoritative: 0,
        envelope: { operationId: randomUUID(), actor: 'tester', trigger: 'test', at: 901 },
      });
    });
    deploySpy.mockClear();
    const reconciler = (await import('../services/BlueprintReconciler')).BlueprintReconciler;
    await reconciler.getInstance().tick();

    // The preparation pass is detached from the tick so a slow registry or a
    // sequential rollout cannot hold the reconciler's running guard; wait for
    // it to settle before asserting.
    await vi.waitFor(() => {
      expect(store.getApplication(fixture.applicationId)?.artifact_set_id).toBe(`resolved-${nextGenId}`);
      expect(deploySpy).toHaveBeenCalledTimes(2);
      for (const nodeId of fixture.nodeIds) {
        expect(store.getTarget(fixture.applicationId, nodeId)?.applied_generation_id).toBe(nextGenId);
      }
    });
  });

  it('prepares a disabled Blueprint but withholds its dispatch', async () => {
    const fixture = seedAuthorizedReadyApp();
    await writeAppliedCompose(fixture.applicationId, fixture.generationId, 'services:\n  web:\n    image: alpine:3.20\n');
    authorize(fixture.applicationId);
    const store = GitOpsStore.getInstance();
    const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });
    await new BlueprintTargetAdapter().dispatch(
      buildAcceptedGeneration(store.getGeneration(fixture.generationId)!),
      { targetMode: 'blueprint', nodeId: fixture.nodeId, bindingRevision: null },
    );

    const { nextGenId, resolveNow } = await acceptSecondCommitWithFailedPreparation(fixture);
    // A disabled-only fleet: no enabled Blueprint at all, so this fails if the
    // content pass still runs after the enabled check.
    DatabaseService.getInstance().getDb().prepare('UPDATE blueprints SET enabled = 0').run();
    DatabaseService.getInstance().updateBlueprint(fixture.blueprintId, { enabled: false });
    expect(DatabaseService.getInstance().listEnabledBlueprints()).toHaveLength(0);
    resolveNow();
    deploySpy.mockClear();
    const reconciler = (await import('../services/BlueprintReconciler')).BlueprintReconciler;
    await reconciler.getInstance().tick();

    // Content is not execution: the generation is prepared so it is ready when
    // the Blueprint is enabled again, but nothing deploys while it is disabled.
    await vi.waitFor(() => {
      expect(store.getApplication(fixture.applicationId)?.artifact_set_id).toBe(`resolved-${nextGenId}`);
    });
    expect(deploySpy).not.toHaveBeenCalled();
    for (const nodeId of fixture.nodeIds) {
      expect(store.getTarget(fixture.applicationId, nodeId)?.applied_generation_id).toBe(fixture.generationId);
    }
  });

  it('does not retry a generation whose artifact evidence is permanently unresolvable', async () => {
    const fixture = seedAuthorizedReadyApp();
    const store = GitOpsStore.getInstance();
    const encodeArtifactEvidenceJson = (await import('../services/gitops/json')).encodeArtifactEvidenceJson;
    store.insertArtifactSet({
      id: 'art-permanent',
      generation_id: fixture.generationId,
      evidence_version: 2,
      authoritative: 0,
      qualification: 'unavailable',
      evidence_json: encodeArtifactEvidenceJson({
        kind: 'unavailable',
        services: [{
          serviceName: 'web',
          authoredRef: 'nginx:latest',
          source: 'registry',
          platform: 'linux/amd64',
          indexDigest: null,
          platformDigest: null,
          platformVariants: null,
          localDigests: null,
          buildContextFingerprint: null,
          producedImageId: null,
          failureClass: 'unsupported_registry',
          resolvedAt: 1,
        }],
      }),
      created_at: 1,
    });
    DatabaseService.getInstance().getDb().prepare(
      'UPDATE gitops_applications SET artifact_set_id = ?, latest_artifact_set_id = ? WHERE id = ?',
    ).run('art-permanent', 'art-permanent', fixture.applicationId);
    const resolveSpy = vi.spyOn(await import('../services/gitops/artifactResolve'), 'resolveAndRecordArtifactSet')
      .mockResolvedValue(undefined);
    const dueSpy = vi.spyOn(BlueprintService.getInstance(), 'gitManagedPreparationRetryDue');

    const reconciler = (await import('../services/BlueprintReconciler')).BlueprintReconciler;
    await reconciler.getInstance().tick();

    // `unsupported_registry` is a property of the reference, not of the
    // registry's mood: the gate refuses before any probe, so no evidence row is
    // appended and no registry traffic is spent. The call-through spy is the
    // positive control: the detached pass has evaluated the application, so a
    // not-called resolver is the gate's decision rather than a race.
    await vi.waitFor(() => expect(dueSpy).toHaveBeenCalled());
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('does not let a slow preparation or dispatch hold the tick', async () => {
    const fixture = seedAuthorizedReadyApp();
    authorize(fixture.applicationId);
    vi.spyOn(BlueprintService.getInstance(), 'gitManagedPreparationRetryDue').mockReturnValue(true);
    vi.spyOn(await import('../services/gitops/gitManagedMaterialization'), 'materializeAndFreezeGitManagedArtifactSet')
      .mockResolvedValue({ status: 'resolved', reason: null });
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const dispatchSpy = vi.spyOn(BlueprintTargetAdapter.prototype, 'dispatch')
      .mockImplementation(async () => {
        await pending;
        return { status: 'blocked', reason: 'released', holdable: true };
      });

    const reconciler = (await import('../services/BlueprintReconciler')).BlueprintReconciler;
    // If the tick awaited the pass, this would hang until release().
    await reconciler.getInstance().tick();
    await vi.waitFor(() => expect(dispatchSpy).toHaveBeenCalled());
    release();
    // The released refusal is durable and the binding is live, so the helper
    // holds it; this also proves the detached pass reached the dispatch.
    await vi.waitFor(() => {
      expect(GitOpsStore.getInstance().getApplication(fixture.applicationId)!.pause_at).not.toBeNull();
    });
    dispatchSpy.mockRestore();
  });
});

describe('the one Git-managed handoff', () => {
  it('skips a disabled Blueprint', async () => {
    const fixture = seedAuthorizedReadyApp();
    DatabaseService.getInstance().updateBlueprint(fixture.blueprintId, { enabled: false });
    const dispatchSpy = vi.spyOn(GitSourceService.getInstance(), 'dispatchAcceptedGeneration');

    const outcome = await dispatchPreparedGitManagedGeneration({
      applicationId: fixture.applicationId,
      generationId: fixture.generationId,
      actor: 'tester',
      trigger: 'manual',
    });

    expect(outcome.status).toBe('skipped');
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('skips a paused rollout', async () => {
    const fixture = seedAuthorizedReadyApp();
    authorize(fixture.applicationId);
    GitOpsTransitions.getInstance().rolloutPaused(fixture.applicationId, null, 'hold', {
      operationId: randomUUID(), actor: 'tester', trigger: 'manual', at: Date.now(),
    });
    const dispatchSpy = vi.spyOn(GitSourceService.getInstance(), 'dispatchAcceptedGeneration');

    const outcome = await dispatchPreparedGitManagedGeneration({
      applicationId: fixture.applicationId,
      generationId: fixture.generationId,
      actor: 'tester',
      trigger: 'manual',
    });

    expect(outcome.status).toBe('skipped');
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('skips a manual authorization policy', async () => {
    const fixture = seedAuthorizedReadyApp();
    DatabaseService.getInstance().getDb().prepare(
      'UPDATE gitops_applications SET rollout_authorization_policy = ? WHERE id = ?',
    ).run('manual', fixture.applicationId);
    const dispatchSpy = vi.spyOn(GitSourceService.getInstance(), 'dispatchAcceptedGeneration');

    const outcome = await dispatchPreparedGitManagedGeneration({
      applicationId: fixture.applicationId,
      generationId: fixture.generationId,
      actor: 'tester',
      trigger: 'manual',
    });

    expect(outcome.status).toBe('skipped');
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('skips a suspended source', async () => {
    const fixture = seedAuthorizedReadyApp();
    DatabaseService.getInstance().getDb().prepare(
      'UPDATE gitops_applications SET suspended_at = ? WHERE id = ?',
    ).run(Date.now(), fixture.applicationId);
    const dispatchSpy = vi.spyOn(GitSourceService.getInstance(), 'dispatchAcceptedGeneration');

    const outcome = await dispatchPreparedGitManagedGeneration({
      applicationId: fixture.applicationId,
      generationId: fixture.generationId,
      actor: 'tester',
      trigger: 'manual',
    });

    expect(outcome.status).toBe('skipped');
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('skips a generation the application has moved past', async () => {
    const fixture = seedAuthorizedReadyApp();
    const dispatchSpy = vi.spyOn(GitSourceService.getInstance(), 'dispatchAcceptedGeneration');

    const outcome = await dispatchPreparedGitManagedGeneration({
      applicationId: fixture.applicationId,
      generationId: 'some-older-generation',
      actor: 'tester',
      trigger: 'manual',
    });

    expect(outcome.status).toBe('skipped');
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('dispatches under the automatic policy', async () => {
    const fixture = seedAuthorizedReadyApp();
    const dispatchSpy = vi.spyOn(GitSourceService.getInstance(), 'dispatchAcceptedGeneration')
      .mockResolvedValue({ status: 'dispatched' });

    const outcome = await dispatchPreparedGitManagedGeneration({
      applicationId: fixture.applicationId,
      generationId: fixture.generationId,
      actor: 'tester',
      trigger: 'manual',
    });

    expect(outcome.status).toBe('dispatched');
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('rollout pause holds execution', () => {
  function pauseEnvelope() {
    return { operationId: randomUUID(), actor: 'tester', trigger: 'test', at: Date.now() };
  }


  it('blocks a dispatch while the application is paused', async () => {
    clearGitOpsState();
    const fixture = seedAuthorizedReadyApp();
    await writeAppliedCompose(fixture.applicationId, fixture.generationId, 'services:\n  web:\n    image: alpine:3.20\n');
    authorize(fixture.applicationId);
    GitOpsTransitions.getInstance().rolloutPaused(
      fixture.applicationId, null, 'wait for the window', pauseEnvelope(),
    );
    const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });
    const store = GitOpsStore.getInstance();
    const before = store.getApplication(fixture.applicationId)!;

    const gen = buildAcceptedGeneration(store.getGeneration(fixture.generationId)!);
    const result = await new BlueprintTargetAdapter().dispatch(gen, {
      targetMode: 'blueprint',
      nodeId: fixture.nodeId,
      bindingRevision: null,
    });
    expect(result.status).toBe('blocked');
    if (result.status === 'blocked') expect(result.reason).toMatch(/paused/i);
    expect(deploySpy).not.toHaveBeenCalled();
    // The hold also prevents minting or superseding an authorization during
    // the preflight window.
    const after = store.getApplication(fixture.applicationId)!;
    expect(after.rollout_authorization_ref).toBe(before.rollout_authorization_ref);
    expect(after.rollout_generation_id).toBe(before.rollout_generation_id);
    expect(after.latest_preflight_evidence_json).toBe(before.latest_preflight_evidence_json);
  });

  it('does not resume a paused rollout on restart', async () => {
    clearGitOpsState();
    const fixture = seedAuthorizedReadyApp({ nodeCount: 2 });
    await writeAppliedCompose(fixture.applicationId, fixture.generationId, 'services:\n  web:\n    image: alpine:3.20\n');
    authorize(fixture.applicationId);
    GitOpsTransitions.getInstance().rolloutPaused(
      fixture.applicationId, null, 'wait for the window', pauseEnvelope(),
    );
    const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });
    const dispatchSpy = vi.spyOn(BlueprintTargetAdapter.prototype, 'dispatch');

    const resumed = await reconstructBlueprintRolloutQueue();
    expect(resumed).toBe(0);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(deploySpy).not.toHaveBeenCalled();
  });

  it('continues the queue but skips an individually paused target', async () => {
    clearGitOpsState();
    const fixture = seedAuthorizedReadyApp({ nodeCount: 3 });
    await writeAppliedCompose(fixture.applicationId, fixture.generationId, 'services:\n  web:\n    image: alpine:3.20\n');
    authorize(fixture.applicationId);
    const store = GitOpsStore.getInstance();
    const app = store.getApplication(fixture.applicationId)!;
    const binding = store.currentAuthorizationBinding(app)!;
    const [firstNode, pausedNode, lastNode] = fixture.nodeIds;

    store.upsertTarget({
      ...emptyTarget(fixture.applicationId, firstNode!),
      intent_revision_id: binding.intentRevisionId,
      rollout_candidate_id: binding.rolloutCandidateId,
      applied_generation_id: binding.acceptedGenerationId,
      desired_generation_id: binding.acceptedGenerationId,
      rollout_authorization_ref: app.rollout_authorization_ref,
      latest_stage: 'blueprint_ack_recorded',
    });
    store.upsertTarget(emptyTarget(fixture.applicationId, pausedNode!));
    GitOpsTransitions.getInstance().rolloutPaused(
      fixture.applicationId, pausedNode!, 'node maintenance', pauseEnvelope(),
    );
    store.upsertTarget(emptyTarget(fixture.applicationId, lastNode!));

    const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });
    const resumed = await reconstructBlueprintRolloutQueue();
    expect(resumed).toBe(1);
    expect(deploySpy).toHaveBeenCalledTimes(1);
    expect(deploySpy.mock.calls[0]![0].node.id).toBe(lastNode);
    expect(store.getTarget(fixture.applicationId, pausedNode!)?.pause_at).not.toBeNull();
  });

  it('reports a hold instead of progress when every remaining target is paused', async () => {
    clearGitOpsState();
    const fixture = seedAuthorizedReadyApp({ nodeCount: 2 });
    await writeAppliedCompose(fixture.applicationId, fixture.generationId, 'services:\n  web:\n    image: alpine:3.20\n');
    authorize(fixture.applicationId);
    const store = GitOpsStore.getInstance();
    const app = store.getApplication(fixture.applicationId)!;
    const binding = store.currentAuthorizationBinding(app)!;
    const [firstNode, pausedNode] = fixture.nodeIds;

    store.upsertTarget({
      ...emptyTarget(fixture.applicationId, firstNode!),
      intent_revision_id: binding.intentRevisionId,
      rollout_candidate_id: binding.rolloutCandidateId,
      applied_generation_id: binding.acceptedGenerationId,
      desired_generation_id: binding.acceptedGenerationId,
      rollout_authorization_ref: app.rollout_authorization_ref,
      latest_stage: 'blueprint_ack_recorded',
    });
    store.upsertTarget(emptyTarget(fixture.applicationId, pausedNode!));
    GitOpsTransitions.getInstance().rolloutPaused(
      fixture.applicationId, pausedNode!, 'node maintenance', pauseEnvelope(),
    );

    const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });
    const resumed = await reconstructBlueprintRolloutQueue();
    expect(resumed).toBe(0);
    expect(deploySpy).not.toHaveBeenCalled();
    // A per-target pause stays per-target: reconstruction must not escalate it
    // to an application pause, which would need a second, broader Resume to
    // undo one node's decision.
    expect(store.getApplication(fixture.applicationId)!.pause_at).toBeNull();
  });
});

describe('derive facets for authorization and convergence', () => {
  it('flips produced placement and rollout statuses to current', () => {
    expect(FACET_EVIDENCE_SOURCE.placement.rollout_authorization_pending).toBe('current');
    expect(FACET_EVIDENCE_SOURCE.placement.preflight_blocked).toBe('current');
    expect(FACET_EVIDENCE_SOURCE.rollout.rollout_queued).toBe('current');
    expect(FACET_EVIDENCE_SOURCE.rollout.exactly_converged_healthy).toBe('current');
    expect(FACET_EVIDENCE_SOURCE.rollout.canary_in_progress).toBe('future');
  });

  it('projects rollout_authorization_pending when binding ingredients are ready', () => {
    const fixture = seedAuthorizedReadyApp();
    recordNonBlockingPreflight(fixture.applicationId);
    const app = GitOpsStore.getInstance().getApplication(fixture.applicationId)!;
    const projection = deriveGitOpsRevision({
      application: app,
      targets: GitOpsStore.getInstance().listTargets(fixture.applicationId),
      healthDisabled: false,
    }, null);
    expect(projection.facets?.placement.status).toBe('rollout_authorization_pending');
    expect(JSON.parse(JSON.stringify(projection.facets?.placement)).status).toBe('rollout_authorization_pending');
  });

  it('projects preflight_blocked as unevaluated when ingredients exist but evidence does not', () => {
    const fixture = seedAuthorizedReadyApp();
    const app = GitOpsStore.getInstance().getApplication(fixture.applicationId)!;
    expect(app.latest_preflight_evidence_json).toBeNull();
    expect(app.rollout_authorization_ref).toBeNull();
    const projection = deriveGitOpsRevision({
      application: app,
      targets: GitOpsStore.getInstance().listTargets(fixture.applicationId),
      healthDisabled: false,
    }, null);
    expect(projection.facets?.placement).toMatchObject({
      status: 'preflight_blocked',
      reason: REGISTRY_PREFLIGHT_UNEVALUATED_REASON,
    });
  });

  it('rejects exactly_converged_healthy when artifact status is not artifact_exact', () => {
    const fixture = seedAuthorizedReadyApp({ artifactQualification: 'exact' });
    authorize(fixture.applicationId);
    const store = GitOpsStore.getInstance();
    const app = store.getApplication(fixture.applicationId)!;
    const binding = store.currentAuthorizationBinding(app)!;
    const changedId = `art-changed-${fixture.applicationId}`;
    store.insertArtifactSet({
      id: changedId,
      generation_id: binding.acceptedGenerationId,
      evidence_version: 2,
      authoritative: 0,
      qualification: 'exact',
      evidence_json: JSON.stringify({ kind: 'exact', identity: 'sha256:different' }),
      created_at: 2,
    });
    app.latest_artifact_set_id = changedId;
    app.updated_at = Date.now();
    store.writeApplicationPointers(app);
    store.upsertTarget({
      ...emptyTarget(fixture.applicationId, fixture.nodeId),
      intent_revision_id: binding.intentRevisionId,
      applied_generation_id: binding.acceptedGenerationId,
      desired_generation_id: binding.acceptedGenerationId,
      deployed_generation_id: binding.acceptedGenerationId,
      healthy_generation_id: binding.acceptedGenerationId,
      expected_artifact_set_id: binding.artifactSetId,
      latest_artifact_set_id: changedId,
      rollout_authorization_ref: app.rollout_authorization_ref,
      latest_stage: 'blueprint_ack_recorded',
    });
    const projection = deriveGitOpsRevision({
      application: store.getApplication(fixture.applicationId)!,
      targets: store.listTargets(fixture.applicationId),
      healthDisabled: false,
    }, null);
    expect(projection.facets?.artifact.status).toBe('artifact_identity_changed');
    expect(projection.facets?.rollout.status).toBe('configuration_converged_artifact_qualified');
    expect(projection.facets?.rollout.status).not.toBe('exactly_converged_healthy');
  });

  it('projects exactly_converged_healthy only when artifact is exact and all targets healthy', () => {
    const fixture = seedAuthorizedReadyApp({ artifactQualification: 'exact' });
    authorize(fixture.applicationId);
    const store = GitOpsStore.getInstance();
    const app = store.getApplication(fixture.applicationId)!;
    const binding = store.currentAuthorizationBinding(app)!;
    store.upsertTarget({
      ...emptyTarget(fixture.applicationId, fixture.nodeId),
      intent_revision_id: binding.intentRevisionId,
      applied_generation_id: binding.acceptedGenerationId,
      desired_generation_id: binding.acceptedGenerationId,
      deployed_generation_id: binding.acceptedGenerationId,
      healthy_generation_id: binding.acceptedGenerationId,
      expected_artifact_set_id: binding.artifactSetId,
      latest_artifact_set_id: binding.artifactSetId,
      rollout_authorization_ref: app.rollout_authorization_ref,
      latest_stage: 'blueprint_ack_recorded',
      observed_artifact_identity_json: JSON.stringify({
        kind: 'exact',
        identity: 'sha256:deadbeef',
        observedAt: 1,
      }),
    });
    const projection = deriveGitOpsRevision({
      application: store.getApplication(fixture.applicationId)!,
      targets: store.listTargets(fixture.applicationId),
      healthDisabled: false,
    }, null);
    expect(projection.facets?.rollout.status).toBe('exactly_converged_healthy');
  });

  it('withholds exactly_converged_healthy when a required target lacks matching digest observation', () => {
    const fixture = seedAuthorizedReadyApp({ artifactQualification: 'exact' });
    authorize(fixture.applicationId);
    const store = GitOpsStore.getInstance();
    const app = store.getApplication(fixture.applicationId)!;
    const binding = store.currentAuthorizationBinding(app)!;
    store.upsertTarget({
      ...emptyTarget(fixture.applicationId, fixture.nodeId),
      intent_revision_id: binding.intentRevisionId,
      applied_generation_id: binding.acceptedGenerationId,
      desired_generation_id: binding.acceptedGenerationId,
      deployed_generation_id: binding.acceptedGenerationId,
      healthy_generation_id: binding.acceptedGenerationId,
      expected_artifact_set_id: binding.artifactSetId,
      latest_artifact_set_id: binding.artifactSetId,
      rollout_authorization_ref: app.rollout_authorization_ref,
      latest_stage: 'blueprint_ack_recorded',
      // No observation: pointers and health alone must not claim exact convergence.
    });
    const projection = deriveGitOpsRevision({
      application: store.getApplication(fixture.applicationId)!,
      targets: store.listTargets(fixture.applicationId),
      healthDisabled: false,
    }, null);
    expect(projection.facets?.rollout.status).not.toBe('exactly_converged_healthy');
    expect(projection.facets?.rollout.status).toBe('partially_rolled_out');
  });

  it('emits rollout_artifact_drift when an authorized target disagrees with the approved set', () => {
    const fixture = seedAuthorizedReadyApp({ artifactQualification: 'exact' });
    authorize(fixture.applicationId);
    const store = GitOpsStore.getInstance();
    const app = store.getApplication(fixture.applicationId)!;
    const binding = store.currentAuthorizationBinding(app)!;
    store.upsertTarget({
      ...emptyTarget(fixture.applicationId, fixture.nodeId),
      intent_revision_id: binding.intentRevisionId,
      applied_generation_id: binding.acceptedGenerationId,
      desired_generation_id: binding.acceptedGenerationId,
      deployed_generation_id: binding.acceptedGenerationId,
      healthy_generation_id: binding.acceptedGenerationId,
      expected_artifact_set_id: binding.artifactSetId,
      latest_artifact_set_id: binding.artifactSetId,
      rollout_authorization_ref: app.rollout_authorization_ref,
      rollout_generation_id: app.rollout_generation_id,
      latest_stage: 'blueprint_ack_recorded',
      observed_artifact_identity_json: JSON.stringify({
        kind: 'exact',
        identity: 'sha256:serving-other',
        observedAt: 9,
      }),
    });
    const projection = deriveGitOpsRevision({
      application: store.getApplication(fixture.applicationId)!,
      targets: store.listTargets(fixture.applicationId),
      healthDisabled: false,
    }, null);
    expect(projection.targets[0]?.runtime.status).toBe('rollout_artifact_drift');
    expect(projection.facets?.rollout.status).not.toBe('exactly_converged_healthy');
    expect(projection.drift.some((item) => item.class === 'rollout')).toBe(true);
  });

  it('reaches exact convergence on a Blueprint target with no deploy-bound pointer', () => {
    // Nothing binds a deploy for a Blueprint-managed stack, so a real Blueprint
    // target carries a null deployed pointer and its applied pointer is what
    // names what the node acknowledged running. Exact convergence has to be
    // reachable in that shape, and it is reached from the pointers, the health
    // verdict, and a per-target observation that matches the approved set. A
    // guard that reads the deployed pointer here would report a false
    // runtime_artifact_divergence on a healthy fleet instead, which is the
    // direction that costs an operator their trust in the model.
    const fixture = seedAuthorizedReadyApp({ artifactQualification: 'exact' });
    authorize(fixture.applicationId);
    const store = GitOpsStore.getInstance();
    const app = store.getApplication(fixture.applicationId)!;
    const binding = store.currentAuthorizationBinding(app)!;
    store.upsertTarget({
      ...emptyTarget(fixture.applicationId, fixture.nodeId),
      intent_revision_id: binding.intentRevisionId,
      applied_generation_id: binding.acceptedGenerationId,
      desired_generation_id: binding.acceptedGenerationId,
      deployed_generation_id: null,
      healthy_generation_id: binding.acceptedGenerationId,
      expected_artifact_set_id: binding.artifactSetId,
      latest_artifact_set_id: binding.artifactSetId,
      rollout_authorization_ref: app.rollout_authorization_ref,
      rollout_generation_id: app.rollout_generation_id,
      latest_stage: 'blueprint_ack_recorded',
      // The identity the fixture froze for the approved set, so the comparison
      // agrees the way a converged target's does.
      observed_artifact_identity_json: JSON.stringify({
        kind: 'exact',
        identity: 'sha256:deadbeef',
        observedAt: 9,
      }),
    });

    const projection = deriveGitOpsRevision({
      application: store.getApplication(fixture.applicationId)!,
      targets: store.listTargets(fixture.applicationId),
      healthDisabled: false,
    }, null);

    expect(projection.facets?.rollout.status).toBe('exactly_converged_healthy');
    expect(projection.drift).toEqual([]);
  });

  it('reaches the artifact drift statuses on a Blueprint target and reports the divergence', () => {
    // This was a KNOWN GAP, pinned deliberately so it stopped being invisible.
    //
    // The runtime facet decided the artifact statuses only after reading the
    // applied and deployed pointers, and required the deployed pointer to be
    // populated. Nothing binds a deploy for a Blueprint-managed stack, so on
    // every real Blueprint target that pointer is null by construction and the
    // facet answered `applied_not_deployed` before it ever compared
    // identities. Both artifact statuses were therefore unreachable for
    // Blueprint targets, and a Blueprint whose digests genuinely disagreed with
    // the approved set contributed nothing to the canonical drift list, while
    // the per-target digest comparison on the Drift tab still showed the
    // divergence. Two surfaces disagreeing about the same confirmed fact is the
    // failure this model exists to prevent.
    //
    // The facet now resolves the running generation per target mode (the applied
    // pointer for Blueprint), which is what the health comparison at the end of
    // the same function already read, so the two agree on what "running" means.
    // The divergence is now reachable, and it belongs to the rollout class
    // because this target is bound to an authorized rollout generation.
    const fixture = seedAuthorizedReadyApp({ artifactQualification: 'exact' });
    authorize(fixture.applicationId);
    const store = GitOpsStore.getInstance();
    const app = store.getApplication(fixture.applicationId)!;
    const binding = store.currentAuthorizationBinding(app)!;
    store.upsertTarget({
      ...emptyTarget(fixture.applicationId, fixture.nodeId),
      intent_revision_id: binding.intentRevisionId,
      applied_generation_id: binding.acceptedGenerationId,
      desired_generation_id: binding.acceptedGenerationId,
      deployed_generation_id: null,
      healthy_generation_id: binding.acceptedGenerationId,
      expected_artifact_set_id: binding.artifactSetId,
      latest_artifact_set_id: binding.artifactSetId,
      rollout_authorization_ref: app.rollout_authorization_ref,
      rollout_generation_id: app.rollout_generation_id,
      latest_stage: 'blueprint_ack_recorded',
      observed_artifact_identity_json: JSON.stringify({
        kind: 'exact',
        identity: 'sha256:serving-other',
        observedAt: 9,
      }),
    });

    const projection = deriveGitOpsRevision({
      application: store.getApplication(fixture.applicationId)!,
      targets: store.listTargets(fixture.applicationId),
      healthDisabled: false,
    }, null);

    expect(projection.targets[0]?.runtime.status).toBe('rollout_artifact_drift');
    // One item, in the rollout class, naming the same mismatch the runtime
    // facet now reports. Before this the canonical list was empty for a
    // confirmed digest divergence, and only the Drift tab showed it.
    expect(projection.drift).toHaveLength(1);
    expect(projection.drift[0]?.class).toBe('rollout');
    expect(projection.drift[0]?.affectedTargets[0]?.nodeId).toBe(fixture.nodeId);
  });

  it('reports the stateful hold once the placement is authorized, and not before', () => {
    // The hold replaces the settled answer only. An operator whose rollout is
    // not yet authorized must still be offered the authorize action, so the
    // hold cannot rank above the authorization statuses or it hides the very
    // affordance that resolves them, and neither clears the other.
    const authorized = seedAuthorizedReadyApp({ artifactQualification: 'exact' });
    authorize(authorized.applicationId);
    const settled = deriveGitOpsRevision({
      application: GitOpsStore.getInstance().getApplication(authorized.applicationId)!,
      targets: GitOpsStore.getInstance().listTargets(authorized.applicationId),
      healthDisabled: false,
    }, null);
    if (settled.targetMode === 'not_applicable') throw new Error('expected application');
    expect(settled.facets.placement.status).toBe('blueprint_bound');

    // Same application, one target now holding stateful changes for review.
    const store = GitOpsStore.getInstance();
    const target = store.getTarget(authorized.applicationId, authorized.nodeId)!;
    store.upsertTarget({ ...target, latest_stage: 'blueprint_state_review' });
    const held = deriveGitOpsRevision({
      application: store.getApplication(authorized.applicationId)!,
      targets: store.listTargets(authorized.applicationId),
      healthDisabled: false,
    }, null);
    if (held.targetMode === 'not_applicable') throw new Error('expected application');
    expect(held.facets.placement.status).toBe('stateful_confirmation_required');
    // The same fact is reported per target, read from the derived status so the
    // two altitudes cannot disagree.
    expect(held.targets[0]?.runtime.status).toBe('pending_state_review');
  });

  it('keeps the authorize affordance reachable while one node is held for state review', () => {
    // The precedence that changed. A hold on one node must not outrank an
    // outstanding rollout authorization: the authority actions are offered on
    // that status, so ranking the hold above it removed the only affordance
    // that resolves the authorization, and neither clears the other. The hold
    // becomes the next action only once authority is settled, which the
    // companion case above pins from the other side.
    const fixture = seedAuthorizedReadyApp();
    recordNonBlockingPreflight(fixture.applicationId);
    const store = GitOpsStore.getInstance();
    const target = store.getTarget(fixture.applicationId, fixture.nodeId)!;
    store.upsertTarget({ ...target, latest_stage: 'blueprint_state_review' });

    const projection = deriveGitOpsRevision({
      application: store.getApplication(fixture.applicationId)!,
      targets: store.listTargets(fixture.applicationId),
      healthDisabled: false,
    }, null);
    if (projection.targetMode === 'not_applicable') throw new Error('expected application');

    expect(projection.facets.placement.status).toBe('rollout_authorization_pending');
    // The hold is still reported, per target, exactly as the operator sees it on
    // the Blueprint screen: the two altitudes say complementary things rather
    // than one of them going quiet.
    expect(projection.targets[0]?.runtime.status).toBe('pending_state_review');
    expect(projection.drift).toEqual([]);
  });

  it('does not treat synced_and_healthy as healthy for a different generation', () => {
    const fixture = seedAuthorizedReadyApp({ artifactQualification: 'exact' });
    authorize(fixture.applicationId);
    const store = GitOpsStore.getInstance();
    const app = store.getApplication(fixture.applicationId)!;
    const binding = store.currentAuthorizationBinding(app)!;
    store.upsertTarget({
      ...emptyTarget(fixture.applicationId, fixture.nodeId),
      intent_revision_id: binding.intentRevisionId,
      applied_generation_id: binding.acceptedGenerationId,
      desired_generation_id: binding.acceptedGenerationId,
      deployed_generation_id: binding.acceptedGenerationId,
      // Healthy pointer lags; runtime may still look synced_and_healthy on deploy===healthy of null desired paths.
      healthy_generation_id: null,
      expected_artifact_set_id: binding.artifactSetId,
      latest_artifact_set_id: binding.artifactSetId,
      rollout_authorization_ref: app.rollout_authorization_ref,
      latest_stage: 'blueprint_ack_recorded',
    });
    const projection = deriveGitOpsRevision({
      application: store.getApplication(fixture.applicationId)!,
      targets: store.listTargets(fixture.applicationId),
      healthDisabled: false,
    }, null);
    expect(projection.facets?.rollout.status).toBe('fully_deployed_health_pending');
  });
});

describe('a rollout authorization records the policy that decided it', () => {
  it('records the configured snapshot on a policy-authorized mint', async () => {
    // The record this exists for. The projection can still answer "what
    // authorized this" from the generation, but only while that generation is
    // reachable: once it is superseded or its row is unreadable, the approval is
    // the only record left, and an approval that cannot name the policy it acted
    // under is an authority record with the authority missing from it.
    const fixture = seedAuthorizedReadyApp();
    const result = await ensureRolloutAuthorization(fixture.applicationId, 'tester');
    expect(result.ok).toBe(true);

    const store = GitOpsStore.getInstance();
    const app = store.getApplication(fixture.applicationId)!;
    const approval = store.getApproval(app.rollout_authorization_ref!)!;
    expect(approval.kind).toBe('rollout_authorization');
    expect(approval.authority).toBe('configured_policy');
    // Decoded rather than compared as text: the assertion is about what the row
    // says, not about the encoder's key order.
    expect(decodeApprovalPolicySnapshot(approval.policy_provenance_json)).toEqual({
      version: 1,
      source: 'manual',
      placement: 'operator',
      rolloutAuthorization: 'automatic',
    });
    // The approval record and the frozen generation are two records of one
    // decision, so they hold the same snapshot. Asserting it here is what makes
    // the agreement check inside the writer mean something.
    const generation = store.getRolloutGeneration(app.rollout_generation_id!)!;
    expect(generation.policy_snapshot_json).toBe(approval.policy_provenance_json);
  });

  it('records no snapshot on an operator mint', async () => {
    // An operator is themselves the authority, so reconstructing a policy here
    // would claim a policy decided something it did not.
    const fixture = seedAuthorizedReadyApp();
    const result = await ensureRolloutAuthorization(
      fixture.applicationId, 'tester', 'manual', undefined, 'operator',
    );
    expect(result.ok).toBe(true);

    const store = GitOpsStore.getInstance();
    const app = store.getApplication(fixture.applicationId)!;
    const approval = store.getApproval(app.rollout_authorization_ref!)!;
    expect(approval.authority).toBe('operator');
    expect(approval.policy_provenance_json).toBeNull();
    // The generation still freezes what the work executes, which is a different
    // fact from who authorized it.
    expect(store.getRolloutGeneration(app.rollout_generation_id!)!.policy_snapshot_json).toBeTruthy();
  });

  it('refuses a policy-authorized mint that records no snapshot', () => {
    // The caller contract, enforced in the single writer because every mint
    // path goes through it and none of them can be trusted to remember.
    const fixture = seedAuthorizedReadyApp();
    const preflight = nonBlockingPreflightForApp(fixture.applicationId);
    expect(() =>
      GitOpsTransitions.getInstance().rolloutAuthorized({
        applicationId: fixture.applicationId,
        approvalId: 'auth-no-snapshot',
        rolloutGenerationId: 'rgen-no-snapshot',
        preflightFingerprint: fingerprintPreflightEvidence(preflight),
        preflightEvidenceJson: encodePreflightEvidenceJson(preflight),
        actor: null,
        envelope: { operationId: 'op-no-snapshot', actor: null, trigger: 'blueprint_dispatch', at: 1 },
        authority: 'configured_policy',
        policyProvenanceJson: null,
      }),
    ).toThrow(/must record its policy snapshot/);
    expect(GitOpsStore.getInstance().getApproval('auth-no-snapshot')).toBeUndefined();
  });

  it('refuses an operator mint that claims a policy decided it', () => {
    const fixture = seedAuthorizedReadyApp();
    const preflight = nonBlockingPreflightForApp(fixture.applicationId);
    expect(() =>
      GitOpsTransitions.getInstance().rolloutAuthorized({
        applicationId: fixture.applicationId,
        approvalId: 'auth-claimed',
        rolloutGenerationId: 'rgen-claimed',
        preflightFingerprint: fingerprintPreflightEvidence(preflight),
        preflightEvidenceJson: encodePreflightEvidenceJson(preflight),
        actor: 'tester',
        envelope: { operationId: 'op-claimed', actor: 'tester', trigger: 'manual', at: 1 },
        authority: 'operator',
        policyProvenanceJson: configuredSnapshotJsonFor(fixture.applicationId),
      }),
    ).toThrow(/records no policy snapshot/);
    expect(GitOpsStore.getInstance().getApproval('auth-claimed')).toBeUndefined();
  });

  it('refuses a policy-authorized mint whose snapshot is no longer configured', () => {
    // The agreement check, and the reason the mint path reads the application
    // row immediately before the write rather than reusing the row it read
    // before the preflight await. On placement the same race is refused, so an
    // approval cannot be granted under a policy the operator has already
    // changed; here it was accepted silently and the generation froze whatever
    // was configured at write time.
    //
    // The edit is to the source policy, not this one, on purpose: the snapshot
    // is the unit of provenance, so a decision taken under a configuration that
    // is no longer the configured one is refused whichever domain moved. A
    // comparison scoped to the rollout domain would mint this and record two
    // versions of one decision that disagree about the source.
    const fixture = seedAuthorizedReadyApp();
    const preflight = nonBlockingPreflightForApp(fixture.applicationId);
    // The snapshot as configured when the decision was made.
    const stale = configuredSnapshotJsonFor(fixture.applicationId);
    GitOpsTransitions.getInstance().sourcePolicyChanged(
      fixture.applicationId,
      'automatic',
      { operationId: 'op-stale-source', actor: 'tester', trigger: 'test', at: Date.now() },
    );

    const mint = (approvalId: string, policyProvenanceJson: string, at: number) => () =>
      GitOpsTransitions.getInstance().rolloutAuthorized({
        applicationId: fixture.applicationId,
        approvalId,
        rolloutGenerationId: `rgen-${approvalId}`,
        preflightFingerprint: fingerprintPreflightEvidence(preflight),
        preflightEvidenceJson: encodePreflightEvidenceJson(preflight),
        actor: null,
        envelope: { operationId: `op-${approvalId}`, actor: null, trigger: 'blueprint_dispatch', at },
        authority: 'configured_policy',
        policyProvenanceJson,
      });

    expect(mint('auth-stale', stale, 2)).toThrow(/policy changed while the decision was being applied/);
    expect(GitOpsStore.getInstance().getApproval('auth-stale')).toBeUndefined();

    // The refusal is the comparison and nothing else: the same mint under the
    // policy configured now is allowed, so a refused mint strands nothing. The
    // dispatch that hit the race simply did not happen this pass.
    expect(mint('auth-fresh', configuredSnapshotJsonFor(fixture.applicationId), 3)).not.toThrow();
  });

  it('records the snapshot again when a racing writer wins and the retry remints', async () => {
    // The retry path this PR changed, which nothing else in the suite reaches.
    //
    // A racing writer can authorize the same application between this one's
    // evaluation and its write. The mint is refused as already live, the live
    // binding's fingerprint is compared against this one's, and a drifted one
    // is invalidated and reminted through a second call. That second call is a
    // separate mint path with its own arguments, so it has to carry the snapshot
    // for itself: the refusal on a policy mint with no snapshot is what a policy
    // remint racing would hit if it did not, and the drift remint is the path
    // that runs unattended with no operator present to see the failure.
    //
    // The racing writer is the real writer, not a stubbed refusal, so the state
    // the retry finds is the state a real race produces rather than a shape
    // invented to make the assertion reachable.
    const fixture = seedAuthorizedReadyApp();
    const store = GitOpsStore.getInstance();
    const transitions = GitOpsTransitions.getInstance();
    // A fingerprint that differs from the one this call evaluates, so the retry
    // invalidates and remints rather than accepting the racing writer's binding
    // as the answer.
    const drifted = 'd'.repeat(64);

    const realMint = transitions.rolloutAuthorized.bind(transitions);
    let planted = false;
    // The racing writer, planting a live authorization under a drifted
    // fingerprint just before this one's mint, which is what makes the mint
    // below refuse as already live.
    vi.spyOn(transitions, 'rolloutAuthorized').mockImplementation((args) => {
      if (!planted) {
        planted = true;
        realMint({
          ...args,
          approvalId: 'raced-approval',
          rolloutGenerationId: 'raced-generation',
          preflightFingerprint: drifted,
        });
      }
      return realMint(args);
    });

    const result = await ensureRolloutAuthorization(fixture.applicationId, 'tester');
    expect(result.ok).toBe(true);
    // The retry is what ran, so the racing writer's approval is gone and this
    // call's own is live.
    const app = store.getApplication(fixture.applicationId)!;
    expect(app.rollout_authorization_ref).toBeTruthy();
    expect(app.rollout_authorization_ref).not.toBe('raced-approval');

    const approval = store.getApproval(app.rollout_authorization_ref!)!;
    expect(approval.authority).toBe('configured_policy');
    // The assertion the branch exists for: the retry recorded a snapshot that
    // decodes to the configured policy, rather than nothing.
    expect(decodeApprovalPolicySnapshot(approval.policy_provenance_json)).toEqual({
      version: 1,
      source: 'manual',
      placement: 'operator',
      rolloutAuthorization: 'automatic',
    });
    expect(store.getRolloutGeneration(app.rollout_generation_id!)!.policy_snapshot_json)
      .toBe(approval.policy_provenance_json);
  });
});

describe('ensureRolloutAuthorization', () => {
  it('auto-mints when ingredients are ready and preflight is not blocked', async () => {
    const fixture = seedAuthorizedReadyApp();
    const result = await ensureRolloutAuthorization(fixture.applicationId, 'tester');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.binding.acceptedGenerationId).toBe(fixture.generationId);
    }
  });

  it('refuses to authorize while the accepted artifact evidence is unresolved', async () => {
    const fixture = seedAuthorizedReadyApp({ artifactQualification: 'unresolved' });
    const result = await ensureRolloutAuthorization(fixture.applicationId, 'tester');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/artifact identity/i);
    expect(GitOpsStore.getInstance().getApplication(fixture.applicationId)!.rollout_authorization_ref).toBeNull();
  });

  it('is idempotent when a live authorization already matches', async () => {
    const fixture = seedAuthorizedReadyApp();
    const first = await ensureRolloutAuthorization(fixture.applicationId, 'tester');
    const second = await ensureRolloutAuthorization(fixture.applicationId, 'tester');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const ref = GitOpsStore.getInstance().getApplication(fixture.applicationId)!.rollout_authorization_ref;
    expect(ref).toBeTruthy();
    expect(() => authorize(fixture.applicationId)).toThrow(/already live/);
    expect(GitOpsStore.getInstance().getApplication(fixture.applicationId)!.rollout_authorization_ref).toBe(ref);
  });

  it('re-authorizes after a source-only change once the new generation is executable', async () => {
    const fixture = seedAuthorizedReadyApp();
    authorize(fixture.applicationId);
    const store = GitOpsStore.getInstance();
    const before = store.getApplication(fixture.applicationId)!;
    const nextGenId = `gen-${randomUUID().slice(0, 8)}`;
    const artId = `art-${randomUUID().slice(0, 8)}`;
    insertGeneration(nextGenId, fixture.applicationId, before.materialization_fingerprint!);
    const envelope = { operationId: randomUUID(), actor: 'tester', trigger: 'manual', at: 500 };
    GitOpsTransitions.getInstance().candidateReady(fixture.applicationId, nextGenId, false, envelope);
    GitOpsTransitions.getInstance().sourceAccepted({
      applicationId: fixture.applicationId,
      generationId: nextGenId,
      artifactSetId: artId,
      sourceAcceptanceId: `acc-${randomUUID().slice(0, 8)}`,
      authority: 'operator',
      envelope,
    });
    // The freeze producer would resolve this in production; here the test
    // records the resolved set directly so the authorization path is what runs.
    const exactId = `art-${randomUUID().slice(0, 8)}`;
    store.insertArtifactSet(artifact(exactId, nextGenId, 'exact', 2));
    GitOpsTransitions.getInstance().acceptArtifactExpectation({
      applicationId: fixture.applicationId,
      generationId: nextGenId,
      artifactSetId: exactId,
      envelope,
    });

    const result = await ensureRolloutAuthorization(fixture.applicationId, 'tester', 'manual', undefined, 'operator');

    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
    if (result.ok) {
      expect(result.binding.acceptedGenerationId).toBe(nextGenId);
      expect(result.binding.artifactSetId).toBe(exactId);
      // Authorization re-stamps the candidate from the resolved set, which is
      // what the next source change will move again.
      const rebound = store.getRolloutCandidate(result.binding.rolloutCandidateId);
      expect(rebound?.accepted_generation_id).toBe(nextGenId);
      expect(rebound?.artifact_set_id).toBe(exactId);
    }
  });

  it('refuses any policy-authorized mint that reaches the transition on a manual policy', () => {
    // The regression this pins, asserted where the guarantee now lives.
    //
    // A drifted authorization is discarded and reminted through this same
    // transition, as is the race-retry path and every other caller: the
    // acceptance handoff, the Blueprint dispatch, the startup reconstruction, the
    // preflight backfill and the operator route. Gating on whether a binding
    // happened to exist, in one caller, left the remint path minting fresh
    // authority with no operator on a manual policy. Enforcing it in the single
    // writer is what makes it unbypassable, and this asserts exactly that.
    const fixture = seedAuthorizedReadyApp();
    const store = GitOpsStore.getInstance();
    const app = store.getApplication(fixture.applicationId)!;
    const preflight = nonBlockingPreflightForApp(fixture.applicationId);

    GitOpsTransitions.getInstance().rolloutAuthorizationPolicyChanged({
      applicationId: fixture.applicationId,
      policy: 'manual',
      envelope: { operationId: 'op-mint-gate', actor: 'tester', trigger: 'test', at: Date.now() },
    });

    expect(() =>
      GitOpsTransitions.getInstance().rolloutAuthorized({
        applicationId: fixture.applicationId,
        approvalId: 'mint-manual',
        rolloutGenerationId: 'rgen-manual',
        preflightFingerprint: fingerprintPreflightEvidence(preflight),
        preflightEvidenceJson: encodePreflightEvidenceJson(preflight),
        actor: null,
        envelope: { operationId: 'op-mint-gate', actor: null, trigger: 'placement', at: 1 },
        authority: 'configured_policy',
        // The snapshot genuinely agrees with the row, so the refusal is the
        // domain rule rather than the snapshot race.
        policyProvenanceJson: configuredSnapshotJsonFor(fixture.applicationId),
      }),
    ).toThrow(/requires an operator/);

    // The operator path is unaffected: an operator is themselves the authority.
    expect(() =>
      GitOpsTransitions.getInstance().rolloutAuthorized({
        applicationId: fixture.applicationId,
        approvalId: 'mint-operator',
        rolloutGenerationId: 'rgen-operator',
        preflightFingerprint: fingerprintPreflightEvidence(preflight),
        preflightEvidenceJson: encodePreflightEvidenceJson(preflight),
        actor: 'tester',
        envelope: { operationId: 'op-mint-operator', actor: 'tester', trigger: 'manual', at: 1 },
        authority: 'operator',
        policyProvenanceJson: null,
      }),
    ).not.toThrow();
    void app;
  });

  it('refuses a policy-authorized mint that reaches the transition mid-operation', () => {
    // The same guarantee for the in-flight guard, on the remint path.
    const fixture = seedAuthorizedReadyApp();
    const preflight = nonBlockingPreflightForApp(fixture.applicationId);
    DatabaseService.getInstance().getDb()
      .prepare("UPDATE gitops_applications SET active_operation_stage = 'deploy_started', active_operation_id = 'op-x' WHERE id = ?")
      .run(fixture.applicationId);

    expect(() =>
      GitOpsTransitions.getInstance().rolloutAuthorized({
        applicationId: fixture.applicationId,
        approvalId: 'mint-busy',
        rolloutGenerationId: 'rgen-busy',
        preflightFingerprint: fingerprintPreflightEvidence(preflight),
        preflightEvidenceJson: encodePreflightEvidenceJson(preflight),
        actor: null,
        envelope: { operationId: 'op-mint-busy', actor: null, trigger: 'preflight_race', at: 1 },
        authority: 'configured_policy',
        policyProvenanceJson: configuredSnapshotJsonFor(fixture.applicationId),
      }),
    ).toThrow(/already in flight/);
  });

  it('keeps dispatching an authorized rollout while a source operation is in flight', async () => {
    // A routine background source fetch must not pause a rollout that is already
    // authorized and running. The in-flight guard is about whether authority may
    // be minted, and this authority already exists.
    const fixture = seedAuthorizedReadyApp();
    const store = GitOpsStore.getInstance();
    await ensureRolloutAuthorization(fixture.applicationId, 'tester');
    expect(store.getApplication(fixture.applicationId)!.rollout_authorization_ref).toBeTruthy();

    const db = DatabaseService.getInstance().getDb();
    db.prepare("UPDATE gitops_applications SET active_operation_stage = 'fetch_started', active_operation_id = 'op-bg' WHERE id = ?")
      .run(fixture.applicationId);

    expect((await ensureRolloutAuthorization(fixture.applicationId, 'tester')).ok).toBe(true);

    // The same holds for a target, which can be mid-apply while the application
    // itself has nothing running.
    db.prepare("UPDATE gitops_applications SET active_operation_stage = NULL WHERE id = ?")
      .run(fixture.applicationId);
    db.prepare(
      `INSERT INTO gitops_target_current (application_id, node_id, target_status, connectivity, latest_stage, active_operation_id, active_operation_stage, updated_at)
       VALUES (?, ?, 'active', 'reachable', 'blueprint_ack_recorded', 'op-t', 'deploy_started', ?)
       ON CONFLICT(application_id, node_id) DO UPDATE SET active_operation_stage = 'deploy_started', active_operation_id = 'op-t'`,
    ).run(fixture.applicationId, fixture.nodeId, Date.now());

    expect((await ensureRolloutAuthorization(fixture.applicationId, 'tester')).ok).toBe(true);
  });

  it('lets an operator-authorized rollout dispatch on the default manual policy', async () => {
    // The regression this pins. An operator authorizes, which succeeds because
    // the operator is the authority, and the dispatch that follows re-enters this
    // function on the automatic path. With the policy at its fresh-install
    // default of manual, the gate used to refuse there, so the operator was told
    // it worked and nothing deployed.
    const fixture = seedAuthorizedReadyApp();
    const store = GitOpsStore.getInstance();
    GitOpsTransitions.getInstance().rolloutAuthorizationPolicyChanged({
      applicationId: fixture.applicationId,
      policy: 'manual',
      envelope: { operationId: 'op-manual-2', actor: 'tester', trigger: 'test', at: Date.now() },
    });

    // Minted by the operator.
    const byOperator = await ensureRolloutAuthorization(
      fixture.applicationId, 'tester', 'manual', undefined, 'operator',
    );
    expect(byOperator.ok).toBe(true);
    expect(store.getApplication(fixture.applicationId)!.rollout_authorization_ref).toBeTruthy();

    // The dispatch that follows asks again as the automatic path, and must be
    // answered from the authority that already exists rather than re-decided.
    const onDispatch = await ensureRolloutAuthorization(fixture.applicationId, 'tester');
    expect(onDispatch.ok).toBe(true);
  });

  it('still refuses a policy-authorized mint on a manual policy with nothing granted', async () => {
    // The gate keeps its teeth for the case it exists for: no authority exists,
    // so policy is the only thing that could grant it, and it does not.
    const fixture = seedAuthorizedReadyApp();
    GitOpsTransitions.getInstance().rolloutAuthorizationPolicyChanged({
      applicationId: fixture.applicationId,
      policy: 'manual',
      envelope: { operationId: 'op-manual-3', actor: 'tester', trigger: 'test', at: Date.now() },
    });
    // Undo the operator mint by clearing the live authorization for this check.
    DatabaseService.getInstance().getDb()
      .prepare('UPDATE gitops_applications SET rollout_authorization_ref = NULL WHERE id = ?')
      .run(fixture.applicationId);

    const result = await ensureRolloutAuthorization(fixture.applicationId, 'tester');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/requires an operator/);
  });

  it('refuses a policy-authorized mint when the policy says an operator authorizes', async () => {
    // The policy is only real if something reads it. Without this gate an
    // operator could set the policy to manual, get a success response and a
    // history row, and then watch the next dispatch mint anyway under a
    // generation frozen with a policy that never governed it.
    const fixture = seedAuthorizedReadyApp();
    const store = GitOpsStore.getInstance();
    GitOpsTransitions.getInstance().rolloutAuthorizationPolicyChanged({
      applicationId: fixture.applicationId,
      policy: 'manual',
      envelope: { operationId: 'op-manual', actor: 'tester', trigger: 'test', at: Date.now() },
    });

    const automatic = await ensureRolloutAuthorization(fixture.applicationId, 'tester');
    expect(automatic.ok).toBe(false);
    if (!automatic.ok) expect(automatic.reason).toMatch(/requires an operator/);
    expect(store.getApplication(fixture.applicationId)!.rollout_authorization_ref).toBeNull();

    // An operator authorizing by hand is itself the authority, so the policy
    // does not stand in their way.
    const byOperator = await ensureRolloutAuthorization(fixture.applicationId, 'tester', 'manual', undefined, 'operator');
    expect(byOperator.ok).toBe(true);
  });

  it('refuses while an operation is in flight for the application', async () => {    // The pause check only knows about a deliberate pause. Without this guard an
    // authorization could be minted while a fetch, apply, deploy, or recovery
    // was still running, and the two would disagree about what the next
    // operation acts on.
    const fixture = seedAuthorizedReadyApp();
    const store = GitOpsStore.getInstance();
    // Set directly: the pointer writer only covers a subset of the row, and an
    // in-flight operation is normally opened by the operation transitions.
    DatabaseService.getInstance().getDb()
      .prepare("UPDATE gitops_applications SET active_operation_stage = 'deploy_started', active_operation_id = ? WHERE id = ?")
      .run('op-x', fixture.applicationId);

    const result = await ensureRolloutAuthorization(fixture.applicationId, 'tester');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/already in flight/);
    expect(store.getApplication(fixture.applicationId)!.rollout_authorization_ref).toBeNull();
  });

  it('refuses while a rollout target has an operation in flight', async () => {
    // A target can be mid-apply while the application itself has nothing
    // running, so the guard reads the target rows rather than the application
    // pointer alone.
    const fixture = seedAuthorizedReadyApp();
    const store = GitOpsStore.getInstance();
    const target = store.getTarget(fixture.applicationId, fixture.nodeId)!;
    void target;
    DatabaseService.getInstance().getDb()
      .prepare("UPDATE gitops_target_current SET active_operation_stage = 'deploy_started', active_operation_id = ? WHERE application_id = ? AND node_id = ?")
      .run('op-y', fixture.applicationId, fixture.nodeId);

    const result = await ensureRolloutAuthorization(fixture.applicationId, 'tester');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/already in flight/);
    expect(store.getApplication(fixture.applicationId)!.rollout_authorization_ref).toBeNull();
  });
});

describe('backfillMissingPreflightEvaluations', () => {
  it('re-evaluates several legacy apps at once and leaves every authorization live', async () => {
    const store = GitOpsStore.getInstance();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    clearGitOpsState();
    const fixtures = Array.from({ length: 5 }, () => seedAuthorizedReadyApp());
    for (const fixture of fixtures) {
      expect((await ensureRolloutAuthorization(fixture.applicationId, 'tester')).ok).toBe(true);
    }
    // The shape this backfill exists for: live authorization, no stored evidence.
    // Scoped to these fixtures by the clear above. A case earlier in this file
    // can hold a live authorization with no stored evidence, which is this same
    // shape, and the backfill walks every authorized application it can see, so
    // leaving those in would let another case decide this count.
    const placeholders = fixtures.map(() => '?').join(',');
    DatabaseService.getInstance().getDb().prepare(
      `UPDATE gitops_applications SET latest_preflight_evidence_json = NULL
       WHERE id IN (${placeholders})`,
    ).run(...fixtures.map((f) => f.applicationId));
    const refsBefore = fixtures.map(
      (f) => store.getApplication(f.applicationId)!.rollout_authorization_ref,
    );

    expect(await backfillMissingPreflightEvaluations()).toBe(fixtures.length);

    for (const [index, fixture] of fixtures.entries()) {
      const app = store.getApplication(fixture.applicationId)!;
      expect(app.latest_preflight_evidence_json).toBeTruthy();
      // Same ref, so the concurrent pass re-evaluated rather than reminted.
      expect(app.rollout_authorization_ref).toBe(refsBefore[index]);
      const again = await ensureRolloutAuthorization(fixture.applicationId, 'tester');
      expect(again.ok).toBe(true);
      expect(store.getApplication(fixture.applicationId)!.rollout_authorization_ref).toBe(refsBefore[index]);
    }
    const backfillWarnings = warn.mock.calls.filter((call) => String(call[0]).includes('Preflight backfill'));
    expect(backfillWarnings).toEqual([]);
  });
});

function nonBlockingPreflightForApp(applicationId: string) {
  const store = GitOpsStore.getInstance();
  const app = store.getApplication(applicationId);
  if (!app) throw new Error('application not found');
  const ingredients = store.authorizationIngredients(app);
  const nodeIds = ingredients?.requiredNodeIds ?? [];
  return buildPreflightEvidence({
    registryReadiness: 'not_required',
    artifactSetId: app.artifact_set_id,
    targets: nodeIds.map((nodeId) => ({
      nodeId,
      sourceClass: 'public' as const,
      readiness: 'not_required' as const,
      hosts: [],
      expired: false,
    })),
  });
}

/**
 * The configured snapshot, encoded the way a policy mint records it.
 *
 * Read from the row rather than hand-built, so a case that is about some other
 * guard cannot accidentally trip the agreement check instead of reaching the
 * guard it means to exercise.
 */
function configuredSnapshotJsonFor(applicationId: string): string {
  const app = GitOpsStore.getInstance().getApplication(applicationId)!;
  return encodePolicySnapshot(configuredSnapshotFor(app));
}

function recordNonBlockingPreflight(applicationId: string): void {
  const preflight = nonBlockingPreflightForApp(applicationId);
  GitOpsTransitions.getInstance().recordPreflightEvaluation({
    applicationId,
    evidenceJson: encodePreflightEvidenceJson(preflight),
  });
}

function authorize(applicationId: string): void {
  const preflight = nonBlockingPreflightForApp(applicationId);
  const evidenceJson = encodePreflightEvidenceJson(preflight);
  GitOpsTransitions.getInstance().recordPreflightEvaluation({
    applicationId,
    evidenceJson,
  });
  GitOpsTransitions.getInstance().rolloutAuthorized({
    applicationId,
    approvalId: randomUUID(),
    rolloutGenerationId: randomUUID(),
    preflightFingerprint: fingerprintPreflightEvidence(preflight),
    preflightEvidenceJson: evidenceJson,
    // An operator mint, because that is what this helper stands for: a person
    // asking to authorize. The fixture's policy is automatic, so the operator
    // path is the one these read-model cases exercise, and it records no policy
    // snapshot because no policy decided it.
    authority: 'operator',
    policyProvenanceJson: null,
    actor: 'tester',
    envelope: { operationId: randomUUID(), actor: 'tester', trigger: 'manual', at: Date.now() },
  });
}

function seedAuthorizedReadyApp(opts: {
  skipPlacement?: boolean;
  nodeCount?: number;
  artifactQualification?: 'unresolved' | 'exact' | 'qualified';
} = {}): { applicationId: string; nodeId: number; nodeIds: number[]; blueprintId: number; generationId: string } {
  const store = GitOpsStore.getInstance();
  const nodeCount = opts.nodeCount ?? 1;
  const nodeIds: number[] = [];
  for (let i = 0; i < nodeCount; i += 1) {
    const result = DatabaseService.getInstance().getDb().prepare(
      `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
       VALUES (?, 'local', 'proxy', '/tmp/compose', 0, 'online', ?)`,
    ).run(`bp-rollout-node-${randomUUID().slice(0, 8)}`, Date.now());
    nodeIds.push(result.lastInsertRowid as number);
  }
  const nodeId = nodeIds[0]!;
  const applicationId = `app-${randomUUID().slice(0, 8)}`;
  const intentId = `intent-${randomUUID().slice(0, 8)}`;
  const candidateId = `cand-${randomUUID().slice(0, 8)}`;
  const generationId = `gen-${randomUUID().slice(0, 8)}`;
  const artifactId = `art-${randomUUID().slice(0, 8)}`;
  const acceptanceId = `acc-${randomUUID().slice(0, 8)}`;
  const placementId = `place-${randomUUID().slice(0, 8)}`;
  const blueprintId = DatabaseService.getInstance().createBlueprint({
    name: `bp-${applicationId}`,
    description: null,
    compose_content: 'services:\n  snapshot:\n    image: nginx:stale\n',
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
    placement_approval_ref: opts.skipPlacement ? null : placementId,
    // Automatic, which is what the acceptance handoff authorizes on its own.
    // This is also what an existing installation migrates to, so a fixture
    // standing in for a live Blueprint app has to say so before a
    // policy-authorized mint is allowed to happen at all.
    rollout_authorization_policy: 'automatic',
    evidence_limitations_json: JSON.stringify([
      { code: 'git_managed_rollout_not_enabled', detail: 'Blueprint rollout generations are not enabled' },
    ]),
  };
  store.insertApplication(app);
  store.insertIntentRevision(intent(intentId, applicationId, blueprintId));
  store.insertRolloutCandidate(candidate(candidateId, applicationId, intentId, nodeIds));
  insertGeneration(generationId, applicationId, app.materialization_fingerprint ?? 'a'.repeat(64));
  store.insertArtifactSet(artifact(artifactId, generationId, opts.artifactQualification ?? 'exact'));
  store.insertApproval({
    id: acceptanceId,
    kind: 'source_acceptance',
    authority: 'operator',
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
    created_at: 1,
  });
  if (!opts.skipPlacement) {
    store.insertApproval({
      id: placementId,
      kind: 'placement_approval',
      authority: 'operator',
      authoritative: 1,
      application_id: applicationId,
      generation_id: null,
      intent_revision_id: intentId,
      artifact_set_id: null,
      rollout_candidate_id: null,
      rollout_generation_id: null,
      source_acceptance_ref: null,
      placement_approval_ref: null,
      required_targets_json: encodeGitOpsRequiredTargetsJson(nodeIds),
      preflight_fingerprint: null,
      fingerprint: null,
      blast_json: encodeGitOpsApprovedTargetEffectJson(nodeIds.map((id) => ({ nodeId: id, outcome: 'place' as const }))),
      policy_provenance_json: null,
      actor: 'tester',
      created_at: 2,
    });
  }
  for (const id of nodeIds) {
    store.upsertTarget(emptyTarget(applicationId, id));
  }
  return { applicationId, nodeId, nodeIds, blueprintId, generationId };
}

function insertGeneration(
  id: string,
  applicationId: string,
  materializationFingerprint = 'b'.repeat(64),
): GitOpsGenerationRow {
  const row: GitOpsGenerationRow = {
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
    materialization_fingerprint: materializationFingerprint,
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
  GitOpsStore.getInstance().insertGeneration(row);
  return row;
}

async function writeAppliedCompose(applicationId: string, generationId: string, content: string): Promise<void> {
  const app = GitOpsStore.getInstance().getApplication(applicationId)!;
  const stackName = app.configured_source_stack_name!;
  const gen = GitOpsStore.getInstance().getGeneration(generationId)!;
  const nodeId = (await import('../services/NodeRegistry')).NodeRegistry.getInstance().getDefaultNodeId();
  const dir = path.join(dataDir, 'git-managed', String(nodeId), stackName, gen.applied_dir);
  await fsPromises.mkdir(dir, { recursive: true });
  await fsPromises.writeFile(path.join(dir, 'compose.yaml'), content, 'utf8');
}

/** A staged candidate as the poller leaves it: compose plus the completeness marker. */
async function writeCandidateCompose(
  stackName: string,
  generation: GitOpsGenerationRow,
  content: string,
): Promise<void> {
  const dir = path.join(stackManagedRoot(stackName), generation.candidate_dir);
  await fsPromises.mkdir(dir, { recursive: true });
  await fsPromises.writeFile(path.join(dir, 'compose.yaml'), content, 'utf8');
  await fsPromises.writeFile(path.join(dir, CANDIDATE_COMPLETE_MARKER), generation.commit_sha, 'utf8');
}

/**
 * A retained Git source whose Direct manifest cache still describes an earlier
 * generation. This is the state a converted source is in after a second
 * commit, because the Direct promotion that would refresh the cache is exactly
 * what the Blueprint path does not run.
 */
function seedStaleManifestCache(stackName: string, appliedDir: string, commitSha: string): void {
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
    last_applied_commit_sha: commitSha,
    last_applied_content_hash: null,
    pending_commit_sha: null,
    pending_compose_content: null,
    pending_env_content: null,
    pending_fetched_at: null,
    last_debounce_at: null,
  });
  DatabaseService.getInstance().setGitSourceManifestState(stackName, 1, 'active', appliedDir);
}

function artifact(
  id: string,
  generationId: string,
  qualification: GitOpsArtifactSetRow['qualification'] = 'unresolved',
  evidenceVersion = 1,
): GitOpsArtifactSetRow {
  const evidence =
    qualification === 'exact'
      ? { kind: 'exact' as const, identity: 'sha256:deadbeef' }
      : qualification === 'qualified'
        ? { kind: 'qualified' as const, identity: 'sha256:cafebabe' }
        : { kind: 'unresolved' as const };
  return {
    id,
    generation_id: generationId,
    evidence_version: evidenceVersion,
    authoritative: 0,
    qualification,
    evidence_json: JSON.stringify(evidence),
    created_at: 1,
  };
}

function intent(id: string, applicationId: string, blueprintId: number): GitOpsIntentRevisionRow {
  return {
    id,
    application_id: applicationId,
    blueprint_id: blueprintId,
    compose_content_sha256: 'c'.repeat(64),
    blueprint_revision: 1,
    deploy_stack_name: `bp-${applicationId}`,
    selector_json: '{}',
    pinned_node_id: null,
    cordon_implications_json: '[]',
    rollout_strategy_json: '{}',
    runtime_drift_policy: null,
    stateful_policy_json: null,
    health_failure_rollback_policy_json: null,
    operation_id: 'op-intent',
    actor: 'tester',
    created_at: 1,
  };
}

function candidate(
  id: string,
  applicationId: string,
  intentRevisionId: string,
  nodeIds: number[],
): GitOpsRolloutCandidateRow {
  return {
    id,
    application_id: applicationId,
    intent_revision_id: intentRevisionId,
    compose_content_sha256: 'c'.repeat(64),
    accepted_generation_id: null,
    artifact_set_id: null,
    required_targets_json: encodeGitOpsRequiredTargetsJson(nodeIds),
    authoritative: 1,
    provenance: 'intent_change',
    operation_id: 'op-cand',
    created_at: 1,
  };
}

function emptyTarget(applicationId: string, nodeId: number) {
  return emptyTargetRow(applicationId, nodeId, 1);
}
