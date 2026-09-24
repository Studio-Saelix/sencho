/**
 * Decomposed authority actions: source acceptance, placement approval, and
 * rollout authorization for Git-managed Blueprint applications.
 *
 * The routes are hub-owned and write the same authority records the combined
 * Apply flow writes, so the tests seed a Git-managed application at each stage
 * and assert the record plus the refusals that keep a stale review from
 * writing authority.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import { commitBlueprintCreate } from '../services/gitops/blueprintProducers';
import {
  encodeArtifactEvidenceJson,
  encodeGitOpsApprovedTargetEffectJson,
  encodeGitOpsRequiredTargetsJson,
} from '../services/gitops/json';
import { buildBlueprintPreview } from '../services/blueprintPreviewProjection';
import type {
  GitOpsApplicationRow,
  GitOpsArtifactSetRow,
  GitOpsGenerationRow,
  GitOpsIntentRevisionRow,
  GitOpsRolloutCandidateRow,
} from '../services/gitops/types';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let GitOpsStore: typeof import('../services/gitops/store').GitOpsStore;
let GitOpsTransitions: typeof import('../services/gitops/transitions').GitOpsTransitions;
let GitSourceService: typeof import('../services/GitSourceService').GitSourceService;
let setRegistryReadinessDepsForTests: typeof import('../services/gitops/handoff').setRegistryReadinessDepsForTests;
let adminCookie: string;
let viewerCookie: string;

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

function intentRow(id: string, applicationId: string, blueprintId: number): GitOpsIntentRevisionRow {
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

function candidateRow(
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

function artifactRow(
  id: string,
  generationId: string,
  qualification: GitOpsArtifactSetRow['qualification'] = 'unresolved',
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
    evidence_version: 1,
    authoritative: 0,
    qualification,
    evidence_json: JSON.stringify(evidence),
    created_at: 1,
  };
}

function insertNode(name: string): number {
  const result = DatabaseService.getInstance().getDb().prepare(
    `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
     VALUES (?, 'local', 'proxy', '/tmp/compose', 0, 'online', ?)`,
  ).run(name, Date.now());
  return result.lastInsertRowid as number;
}

type Seeded = {
  blueprintId: number;
  applicationId: string;
  intentId: string;
  candidateId: string;
  generationId: string;
  nodeIds: number[];
};

/**
 * A Git-managed Blueprint application. `sourceAccepted` controls whether the
 * candidate generation is waiting for acceptance (operable by the source
 * action) or already accepted with a placement approval left to write.
 */
function seedGitManagedBlueprint(opts: { sourceAccepted: boolean; nodeCount?: number }): Seeded {
  const store = GitOpsStore.getInstance();
  const nodeIds: number[] = [];
  for (let i = 0; i < (opts.nodeCount ?? 1); i += 1) {
    nodeIds.push(insertNode(`auth-node-${randomUUID().slice(0, 8)}`));
  }
  const applicationId = `app-${randomUUID().slice(0, 8)}`;
  const intentId = `intent-${randomUUID().slice(0, 8)}`;
  const candidateId = `cand-${randomUUID().slice(0, 8)}`;
  const generationId = `gen-${randomUUID().slice(0, 8)}`;
  const blueprint = DatabaseService.getInstance().createBlueprint({
    name: `bp-auth-${randomUUID().slice(0, 8)}`,
    description: null,
    compose_content: 'services:\n  snapshot:\n    image: nginx:stale\n',
    selector: { type: 'nodes', ids: nodeIds },
    drift_mode: 'suggest',
    classification: 'stateless',
    classification_reasons: [],
    enabled: true,
    created_by: 'tester',
  });
  DatabaseService.getInstance().updateBlueprintContentOrigin(blueprint.id, 'git', applicationId);

  const artifactId = `art-${randomUUID().slice(0, 8)}`;
  const acceptanceId = `acc-${randomUUID().slice(0, 8)}`;
  const row: GitOpsApplicationRow = {
    ...directApplicationFixture(applicationId, `src-${applicationId}`),
    target_mode: 'blueprint',
    lifecycle_key: `blueprint:${blueprint.id}`,
    stack_name: null,
    configured_source_stack_name: `src-${applicationId}`,
    blueprint_id: blueprint.id,
    intent_revision_id: intentId,
    rollout_candidate_id: candidateId,
    candidate_generation_id: opts.sourceAccepted ? null : generationId,
    accepted_generation_id: opts.sourceAccepted ? generationId : null,
    artifact_set_id: opts.sourceAccepted ? artifactId : null,
    latest_artifact_set_id: opts.sourceAccepted ? artifactId : null,
    source_acceptance_ref: opts.sourceAccepted ? acceptanceId : null,
    review_required: opts.sourceAccepted ? 0 : 1,
    source_policy: 'manual',
  };
  store.insertApplication(row);
  store.insertIntentRevision(intentRow(intentId, applicationId, blueprint.id));
  store.insertRolloutCandidate(candidateRow(candidateId, applicationId, intentId, nodeIds));
  insertGeneration(generationId, applicationId, row.materialization_fingerprint ?? undefined);
  if (opts.sourceAccepted) {
    store.insertArtifactSet(artifactRow(artifactId, generationId, 'exact'));
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
  }
  return { blueprintId: blueprint.id, applicationId, intentId, candidateId, generationId, nodeIds };
}

async function seedAndLoginRole(username: string, password: string, role: 'viewer'): Promise<string> {
  const passwordHash = await bcrypt.hash(password, 1);
  DatabaseService.getInstance().addUser({ username, password_hash: passwordHash, role });
  const res = await request(app).post('/api/auth/login').send({ username, password });
  const cookies = res.headers['set-cookie'] as string | string[];
  return Array.isArray(cookies) ? cookies[0] : cookies;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ LicenseService } = await import('../services/LicenseService'));
  ({ GitOpsStore } = await import('../services/gitops/store'));
  ({ GitOpsTransitions } = await import('../services/gitops/transitions'));
  ({ GitSourceService } = await import('../services/GitSourceService'));
  ({ setRegistryReadinessDepsForTests } = await import('../services/gitops/handoff'));
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
  viewerCookie = await seedAndLoginRole('auth-viewer', 'auth-viewer-pass', 'viewer');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
  GitOpsStore.resetForTests();
  GitOpsTransitions.resetForTests();
  setRegistryReadinessDepsForTests(registryReadyTestDeps());
});

afterEach(() => {
  setRegistryReadinessDepsForTests(null);
});

describe('POST /api/gitops/applications/:id/source/accept', () => {
  it('accepts the waiting candidate as an operator', async () => {
    const seeded = seedGitManagedBlueprint({ sourceAccepted: false });
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/source/accept`)
      .set('Cookie', adminCookie)
      .send({ generationId: seeded.generationId });
    expect(res.status).toBe(200);
    const row = GitOpsStore.getInstance().getApplication(seeded.applicationId)!;
    expect(row.accepted_generation_id).toBe(seeded.generationId);
    expect(row.source_acceptance_ref).toBeTruthy();
    expect(row.candidate_generation_id).toBeNull();
    const approval = GitOpsStore.getInstance().getApproval(row.source_acceptance_ref!)!;
    expect(approval.kind).toBe('source_acceptance');
    expect(approval.authority).toBe('operator');
    expect(approval.generation_id).toBe(seeded.generationId);
  });

  it('refuses a generation that is not the current candidate', async () => {
    const seeded = seedGitManagedBlueprint({ sourceAccepted: false });
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/source/accept`)
      .set('Cookie', adminCookie)
      .send({ generationId: 'gen-something-else' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SOURCE_ACCEPTANCE_REFUSED');
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)!.source_acceptance_ref).toBeNull();
  });

  it('requires the generation the caller reviewed', async () => {
    const seeded = seedGitManagedBlueprint({ sourceAccepted: false });
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/source/accept`)
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONFIRM_REQUIRED');
  });

  it('refuses a Direct application id', async () => {
    const res = await request(app)
      .post('/api/gitops/applications/1:some-direct-app/source/accept')
      .set('Cookie', adminCookie)
      .send({ generationId: 'gen-1' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_GIT_MANAGED');
  });

  it('rejects a caller without stack:create', async () => {
    const seeded = seedGitManagedBlueprint({ sourceAccepted: false });
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/source/accept`)
      .set('Cookie', viewerCookie)
      .send({ generationId: seeded.generationId });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/gitops/applications/:id/placement/approve', () => {
  it('records the reviewed placement as an operator and opens a placement generation', async () => {
    const seeded = seedGitManagedBlueprint({ sourceAccepted: true });
    const preview = await buildBlueprintPreview(seeded.blueprintId);
    expect(preview).not.toBeNull();
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/placement/approve`)
      .set('Cookie', adminCookie)
      .send({ planFingerprint: preview!.planFingerprint, actions: preview!.confirmableActions });
    expect(res.status).toBe(200);
    const store = GitOpsStore.getInstance();
    const row = store.getApplication(seeded.applicationId)!;
    expect(row.placement_approval_ref).toBeTruthy();
    const approval = store.getApproval(row.placement_approval_ref!)!;
    expect(approval.kind).toBe('placement_approval');
    expect(approval.authority).toBe('operator');
    expect(approval.intent_revision_id).toBe(seeded.intentId);
    expect(store.getRolloutGeneration(row.rollout_generation_id!)?.provenance).toBe('placement_approval');
  });

  it('refuses a stale plan with a fresh preview', async () => {
    const seeded = seedGitManagedBlueprint({ sourceAccepted: true });
    const preview = await buildBlueprintPreview(seeded.blueprintId);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/placement/approve`)
      .set('Cookie', adminCookie)
      .send({ planFingerprint: '0'.repeat(64), actions: preview!.confirmableActions });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PREVIEW_STALE');
    expect(res.body.preview.planFingerprint).toBe(preview!.planFingerprint);
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)!.placement_approval_ref).toBeNull();
  });

  it('refuses when the reviewed actions move', async () => {
    const seeded = seedGitManagedBlueprint({ sourceAccepted: true });
    const preview = await buildBlueprintPreview(seeded.blueprintId);
    // The fixture is a never-placed enumerable node, so the plan it reviews
    // has a place to diverge from.
    expect(preview!.confirmableActions.length).toBeGreaterThan(0);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/placement/approve`)
      .set('Cookie', adminCookie)
      .send({ planFingerprint: preview!.planFingerprint, actions: [] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PREVIEW_STALE');
  });

  it('refuses a disabled Blueprint before writing placement authority', async () => {
    const seeded = seedGitManagedBlueprint({ sourceAccepted: true });
    DatabaseService.getInstance().updateBlueprint(seeded.blueprintId, { enabled: false });
    const preview = await buildBlueprintPreview(seeded.blueprintId);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/placement/approve`)
      .set('Cookie', adminCookie)
      .send({ planFingerprint: preview!.planFingerprint, actions: preview!.confirmableActions });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BLUEPRINT_DISABLED');
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)!.placement_approval_ref).toBeNull();
  });

  it('refuses an Inline Blueprint application', async () => {
    const blueprint = commitBlueprintCreate({
      name: `bp-inline-${randomUUID().slice(0, 8)}`,
      description: null,
      compose_content: 'services:\n  app:\n    image: nginx\n',
      selector: { type: 'nodes', ids: [1] },
      drift_mode: 'suggest',
      classification: 'stateless',
      classification_reasons: [],
      enabled: true,
      created_by: 'tester',
    }, () => [1]);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${blueprint.id}/placement/approve`)
      .set('Cookie', adminCookie)
      .send({ planFingerprint: 'a'.repeat(64), actions: [] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_GIT_MANAGED');
  });

  it('rejects a caller without stack:deploy', async () => {
    const seeded = seedGitManagedBlueprint({ sourceAccepted: true });
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/placement/approve`)
      .set('Cookie', viewerCookie)
      .send({ planFingerprint: 'a'.repeat(64), actions: [] });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/gitops/applications/:id/rollout/authorize', () => {
  it('mints an operator authorization and dispatches the accepted generation', async () => {
    const seeded = seedGitManagedBlueprint({ sourceAccepted: true });
    const transitions = GitOpsTransitions.getInstance();
    // Approve placement the same way the placement route does, then authorize.
    const preview = await buildBlueprintPreview(seeded.blueprintId);
    transitions.placementApproved({
      applicationId: seeded.applicationId,
      approvalId: `place-${randomUUID().slice(0, 8)}`,
      intentRevisionId: seeded.intentId,
      blastJson: encodeGitOpsApprovedTargetEffectJson(
        seeded.nodeIds.map(nodeId => ({ nodeId, outcome: 'place' as const })),
      ),
      requiredNodeIds: seeded.nodeIds,
      fingerprint: preview!.planFingerprint,
      actor: 'tester',
      envelope: { operationId: randomUUID(), actor: 'tester', trigger: 'manual', at: Date.now() },
      rolloutGenerationId: `rgen-${randomUUID().slice(0, 8)}`,
      candidateId: seeded.candidateId,
      provenance: 'placement_approval',
    });
    // The dispatch is exercised by its own suite; here it stands in for
    // "the rollout started" so the route result can be asserted.
    const dispatchSpy = vi
      .spyOn(GitSourceService.getInstance(), 'dispatchAcceptedGeneration')
      .mockResolvedValue({ status: 'dispatched' });

    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/authorize`)
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, dispatched: true, note: null });
    expect(dispatchSpy).toHaveBeenCalledTimes(1);

    const store = GitOpsStore.getInstance();
    const row = store.getApplication(seeded.applicationId)!;
    const approval = store.getApproval(row.rollout_authorization_ref!)!;
    expect(approval.kind).toBe('rollout_authorization');
    expect(approval.authority).toBe('operator');
    expect(store.getRolloutGeneration(row.rollout_generation_id!)?.provenance).toBe('rollout_authorization');
  });

  it('refuses when placement approval is missing', async () => {
    const seeded = seedGitManagedBlueprint({ sourceAccepted: true });
    const dispatchSpy = vi
      .spyOn(GitSourceService.getInstance(), 'dispatchAcceptedGeneration')
      .mockResolvedValue({ status: 'dispatched' });
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/authorize`)
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ROLLOUT_AUTHORIZATION_REFUSED');
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)!.rollout_authorization_ref).toBeNull();
  });

  it('records the authorization and reports a blocked dispatch as a note', async () => {
    const seeded = seedGitManagedBlueprint({ sourceAccepted: true });
    const transitions = GitOpsTransitions.getInstance();
    transitions.placementApproved({
      applicationId: seeded.applicationId,
      approvalId: `place-${randomUUID().slice(0, 8)}`,
      intentRevisionId: seeded.intentId,
      blastJson: encodeGitOpsApprovedTargetEffectJson(
        seeded.nodeIds.map(nodeId => ({ nodeId, outcome: 'place' as const })),
      ),
      requiredNodeIds: seeded.nodeIds,
      fingerprint: null,
      actor: 'tester',
      envelope: { operationId: randomUUID(), actor: 'tester', trigger: 'manual', at: Date.now() },
      rolloutGenerationId: `rgen-${randomUUID().slice(0, 8)}`,
      candidateId: seeded.candidateId,
      provenance: 'placement_approval',
    });
    vi.spyOn(GitSourceService.getInstance(), 'dispatchAcceptedGeneration')
      .mockResolvedValue({ status: 'blocked', reason: 'Another operation is already in progress.' });
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/authorize`)
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.dispatched).toBe(false);
    expect(res.body.note).toBe('Another operation is already in progress.');
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)!.rollout_authorization_ref).toBeTruthy();
  });

  it('refuses a disabled Blueprint before recording rollout authority', async () => {
    const seeded = seedGitManagedBlueprint({ sourceAccepted: true });
    DatabaseService.getInstance().updateBlueprint(seeded.blueprintId, { enabled: false });
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/authorize`)
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BLUEPRINT_DISABLED');
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)!.rollout_authorization_ref).toBeNull();
  });

  it('refuses a recorded placement approval the frozen set no longer matches', async () => {
    const seeded = seedGitManagedBlueprint({ sourceAccepted: true });
    const store = GitOpsStore.getInstance();
    const transitions = GitOpsTransitions.getInstance();
    const preview = await buildBlueprintPreview(seeded.blueprintId);
    transitions.placementApproved({
      applicationId: seeded.applicationId,
      approvalId: `place-${randomUUID().slice(0, 8)}`,
      intentRevisionId: seeded.intentId,
      blastJson: encodeGitOpsApprovedTargetEffectJson(
        seeded.nodeIds.map(nodeId => ({ nodeId, outcome: 'place' as const })),
      ),
      requiredNodeIds: seeded.nodeIds,
      fingerprint: preview!.planFingerprint,
      actor: 'tester',
      envelope: { operationId: randomUUID(), actor: 'tester', trigger: 'manual', at: Date.now() },
      rolloutGenerationId: `rgen-${randomUUID().slice(0, 8)}`,
      candidateId: seeded.candidateId,
      provenance: 'placement_approval',
    });
    // A frozen set the recorded blast no longer covers: the approval places a
    // node the candidate set no longer contains. Written directly, because
    // every transition that moves a candidate also clears the approval.
    const extraNodeId = insertNode(`auth-node-extra-${randomUUID().slice(0, 8)}`);
    DatabaseService.getInstance().getDb().prepare(
      'UPDATE gitops_rollout_candidates SET required_targets_json = ? WHERE id = ?',
    ).run(encodeGitOpsRequiredTargetsJson([extraNodeId]), seeded.candidateId);

    const dispatchSpy = vi
      .spyOn(GitSourceService.getInstance(), 'dispatchAcceptedGeneration')
      .mockResolvedValue({ status: 'dispatched' });
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/authorize`)
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ROLLOUT_AUTHORIZATION_REFUSED');
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(store.getApplication(seeded.applicationId)!.rollout_authorization_ref).toBeNull();
  });

  it('names the unresolved artifact identity when an operator-accepted generation is authorized', async () => {
    const seeded = seedGitManagedBlueprint({ sourceAccepted: false });

    // The operator review chain, through the routes only: the acceptance seed
    // carries an unresolved artifact set, exactly as production does.
    const accept = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/source/accept`)
      .set('Cookie', adminCookie)
      .send({ generationId: seeded.generationId });
    expect(accept.status).toBe(200);
    const accepted = GitOpsStore.getInstance().getApplication(seeded.applicationId)!;
    expect(GitOpsStore.getInstance().getArtifactSet(accepted.artifact_set_id!)?.qualification).toBe('unresolved');

    const preview = await buildBlueprintPreview(seeded.blueprintId);
    const approve = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/placement/approve`)
      .set('Cookie', adminCookie)
      .send({ planFingerprint: preview!.planFingerprint, actions: preview!.confirmableActions });
    expect(approve.status).toBe(200);

    const dispatchSpy = vi
      .spyOn(GitSourceService.getInstance(), 'dispatchAcceptedGeneration')
      .mockResolvedValue({ status: 'dispatched' });
    const authorize = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/authorize`)
      .set('Cookie', adminCookie)
      .send({});
    expect(authorize.status).toBe(409);
    expect(authorize.body.code).toBe('ROLLOUT_AUTHORIZATION_REFUSED');
    expect(authorize.body.error).toMatch(/artifact identity/i);
    expect(authorize.body.error).not.toMatch(/registry readiness/i);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)!.rollout_authorization_ref).toBeNull();
  });

  it('authorizes and dispatches once executable artifact evidence is recorded', async () => {
    const seeded = seedGitManagedBlueprint({ sourceAccepted: false });
    await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/source/accept`)
      .set('Cookie', adminCookie)
      .send({ generationId: seeded.generationId })
      .expect(200);
    const preview = await buildBlueprintPreview(seeded.blueprintId);
    await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/placement/approve`)
      .set('Cookie', adminCookie)
      .send({ planFingerprint: preview!.planFingerprint, actions: preview!.confirmableActions })
      .expect(200);

    // No producer resolves artifact evidence for a Git-managed Blueprint yet,
    // so this records what that producer will write: resolved evidence for the
    // accepted generation, advancing the pointer. It proves the chain
    // completes once evidence exists, and guards the refusal above from
    // over-reaching.
    const appRow = GitOpsStore.getInstance().getApplication(seeded.applicationId)!;
    GitOpsTransitions.getInstance().recordArtifactEvidence({
      applicationId: seeded.applicationId,
      generationId: appRow.accepted_generation_id!,
      artifactSetId: `art-${randomUUID().slice(0, 8)}`,
      evidenceVersion: 2,
      qualification: 'exact',
      evidenceJson: encodeArtifactEvidenceJson({ kind: 'exact', identity: 'sha256:deadbeef' }),
      authoritative: 0,
      envelope: { operationId: randomUUID(), actor: 'tester', trigger: 'manual', at: Date.now() },
    });
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)!.artifact_set_id).toBeTruthy();

    const dispatchSpy = vi
      .spyOn(GitSourceService.getInstance(), 'dispatchAcceptedGeneration')
      .mockResolvedValue({ status: 'dispatched' });
    const authorize = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/authorize`)
      .set('Cookie', adminCookie)
      .send({});
    expect(authorize.status).toBe(200);
    expect(authorize.body).toMatchObject({ dispatched: true, note: null });
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const authorized = GitOpsStore.getInstance().getApplication(seeded.applicationId)!;
    expect(authorized.rollout_authorization_ref).toBeTruthy();
  });

  it('rejects a caller without stack:deploy', async () => {
    const seeded = seedGitManagedBlueprint({ sourceAccepted: true });
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/authorize`)
      .set('Cookie', viewerCookie)
      .send({});
    expect(res.status).toBe(403);
  });
});
