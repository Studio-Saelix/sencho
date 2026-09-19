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
} from '../services/gitops/preflight';
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
let GitOpsTransitions: typeof import('../services/gitops/transitions').GitOpsTransitions;
let deriveGitOpsRevision: typeof import('../services/gitops/derive').deriveGitOpsRevision;
let FACET_EVIDENCE_SOURCE: typeof import('../services/gitops/types').FACET_EVIDENCE_SOURCE;
let BlueprintTargetAdapter: typeof import('../services/gitops/handoff').BlueprintTargetAdapter;
let buildAcceptedGeneration: typeof import('../services/gitops/handoff').buildAcceptedGeneration;
let ensureRolloutAuthorization: typeof import('../services/gitops/handoff').ensureRolloutAuthorization;
let setRegistryReadinessDepsForTests: typeof import('../services/gitops/handoff').setRegistryReadinessDepsForTests;
let reconstructBlueprintRolloutQueue: typeof import('../services/gitops/handoff').reconstructBlueprintRolloutQueue;
let BlueprintService: typeof import('../services/BlueprintService').BlueprintService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let dataDir: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  ({ GitOpsStore } = await import('../services/gitops/store'));
  ({ GitOpsTransitions } = await import('../services/gitops/transitions'));
  ({ deriveGitOpsRevision } = await import('../services/gitops/derive'));
  ({ FACET_EVIDENCE_SOURCE } = await import('../services/gitops/types'));
  ({
    BlueprintTargetAdapter,
    buildAcceptedGeneration,
    ensureRolloutAuthorization,
    reconstructBlueprintRolloutQueue,
    setRegistryReadinessDepsForTests,
  } = await import('../services/gitops/handoff'));
  ({ BlueprintService } = await import('../services/BlueprintService'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
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
      }
      expect(failedSpy).not.toHaveBeenCalled();
      const target = GitOpsStore.getInstance().getTarget(fixture.applicationId, fixture.nodeId);
      expect(target?.failure_stage).toBeNull();
      expect(target?.active_operation_stage).toBeNull();
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
    });
    const projection = deriveGitOpsRevision({
      application: store.getApplication(fixture.applicationId)!,
      targets: store.listTargets(fixture.applicationId),
      healthDisabled: false,
    }, null);
    expect(projection.facets?.rollout.status).toBe('exactly_converged_healthy');
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

describe('ensureRolloutAuthorization', () => {
  it('auto-mints when ingredients are ready and preflight is not blocked', async () => {
    const fixture = seedAuthorizedReadyApp();
    const result = await ensureRolloutAuthorization(fixture.applicationId, 'tester');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.binding.acceptedGenerationId).toBe(fixture.generationId);
    }
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
  return {
    application_id: applicationId,
    node_id: nodeId,
    target_status: 'active' as const,
    desired_generation_id: null,
    candidate_generation_id: null,
    applied_generation_id: null,
    deployed_generation_id: null,
    healthy_generation_id: null,
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
