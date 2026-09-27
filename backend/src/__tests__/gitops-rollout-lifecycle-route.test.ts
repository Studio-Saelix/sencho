/**
 * Rollout lifecycle controls: pause, resume, replan, supersede, rollback.
 *
 * The routes decide and record; the node restores. These tests seed an
 * authorized Git-managed Blueprint rollout and assert the recorded state and
 * the refusals that keep an operator from recovering against evidence that
 * does not name the generation being restored.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import { commitBlueprintCreate } from '../services/gitops/blueprintProducers';
import { emptyTargetRow } from '../services/gitops/store';
import { encodeGitOpsRequiredTargetsJson } from '../services/gitops/json';
import { ensureRolloutAuthorization } from '../services/gitops/handoff';
import { projectApplication } from '../services/gitops/derive';
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
let StackUpdateRecoveryService: typeof import('../services/StackUpdateRecoveryService').StackUpdateRecoveryService;
let setRegistryReadinessDepsForTests: typeof import('../services/gitops/handoff').setRegistryReadinessDepsForTests;
let adminCookie: string;
let viewerCookie: string;
let deployerCookie: string;

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

function insertGeneration(id: string, applicationId: string): GitOpsGenerationRow {
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
    materialization_fingerprint: 'b'.repeat(64),
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

function intentRow(id: string, applicationId: string, blueprintId: number, stackName: string): GitOpsIntentRevisionRow {
  return {
    id,
    application_id: applicationId,
    blueprint_id: blueprintId,
    compose_content_sha256: 'c'.repeat(64),
    blueprint_revision: 1,
    deploy_stack_name: stackName,
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
  stackName: string;
  nodeIds: number[];
};

function seedGitManagedBlueprint(opts: { nodeCount?: number } = {}): Seeded {
  const store = GitOpsStore.getInstance();
  const nodeIds: number[] = [];
  for (let i = 0; i < (opts.nodeCount ?? 1); i += 1) {
    nodeIds.push(insertNode(`lifecycle-node-${randomUUID().slice(0, 8)}`));
  }
  const applicationId = `app-${randomUUID().slice(0, 8)}`;
  const intentId = `intent-${randomUUID().slice(0, 8)}`;
  const candidateId = `cand-${randomUUID().slice(0, 8)}`;
  const generationId = `gen-${randomUUID().slice(0, 8)}`;
  const stackName = `bp-${applicationId}`;
  const blueprint = DatabaseService.getInstance().createBlueprint({
    name: `bp-lifecycle-${randomUUID().slice(0, 8)}`,
    description: null,
    compose_content: 'services:\n  app:\n    image: nginx:1.27\n',
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
    candidate_generation_id: null,
    accepted_generation_id: generationId,
    artifact_set_id: artifactId,
    latest_artifact_set_id: artifactId,
    source_acceptance_ref: acceptanceId,
    review_required: 0,
    review_block_reason: null,
    source_policy: 'manual',
  };
  store.insertApplication(row);
  store.insertIntentRevision(intentRow(intentId, applicationId, blueprint.id, stackName));
  store.insertRolloutCandidate(candidateRow(candidateId, applicationId, intentId, nodeIds));
  insertGeneration(generationId, applicationId);
  store.insertArtifactSet(artifactRow(artifactId, generationId));
  for (const nodeId of nodeIds) {
    store.upsertTarget(emptyTargetRow(applicationId, nodeId, 1));
  }
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
  return { blueprintId: blueprint.id, applicationId, intentId, candidateId, generationId, stackName, nodeIds };
}

/** Record placement approval and mint a live operator rollout authorization. */
async function authorizeRollout(seeded: Seeded): Promise<void> {
  const transitions = (await import('../services/gitops/transitions')).GitOpsTransitions.getInstance();
  const { encodeGitOpsApprovedTargetEffectJson } = await import('../services/gitops/json');
  const envelope = { operationId: randomUUID(), actor: 'tester', trigger: 'test', at: Date.now() };
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
    envelope,
    rolloutGenerationId: `rgen-${randomUUID().slice(0, 8)}`,
    candidateId: seeded.candidateId,
    provenance: 'placement_approval',
  });
  const result = await ensureRolloutAuthorization(seeded.applicationId, 'tester', 'test', undefined, 'operator');
  expect(result.ok).toBe(true);
}

/** A current recovery point bound to one application generation. */
function insertRecoveryPoint(seeded: Seeded, nodeId: number, gitopsGenerationId: string): void {
  DatabaseService.getInstance().insertStackUpdateRecoveryGeneration({
    id: `rec-${randomUUID().slice(0, 8)}`,
    node_id: nodeId,
    stack_name: seeded.stackName,
    status: 'active',
    phase: 'handoff_committed',
    is_current: 1,
    backup_slot_id: null,
    content_path: null,
    operation_kind: 'manual_backup',
    override_path: '/tmp/rollback-override.yaml',
    services_json: '[]',
    health_gate_id: null,
    gate_retain_until: null,
    artifact_expires_at: null,
    operation_lease_expires_at: null,
    created_at: 1,
    updated_at: 1,
    created_by: 'tester',
    artifacts_retired: 0,
    released_at: null,
    released_by: null,
    gitops_generation_id: gitopsGenerationId,
  });
}

async function seedAndLoginRole(username: string, password: string, role: 'viewer' | 'deployer'): Promise<string> {
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
  ({ StackUpdateRecoveryService } = await import('../services/StackUpdateRecoveryService'));
  ({ setRegistryReadinessDepsForTests } = await import('../services/gitops/handoff'));
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
  viewerCookie = await seedAndLoginRole('lifecycle-viewer', 'lifecycle-viewer-pass', 'viewer');
  deployerCookie = await seedAndLoginRole('lifecycle-deployer', 'lifecycle-deployer-pass', 'deployer');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
  GitOpsStore.resetForTests();
  setRegistryReadinessDepsForTests(registryReadyTestDeps());
});

afterEach(() => {
  setRegistryReadinessDepsForTests(null);
});

describe('POST /api/gitops/applications/:id/rollout/pause', () => {
  it('pauses the rollout with the operator reason', async () => {
    const seeded = seedGitManagedBlueprint();
    await authorizeRollout(seeded);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/pause`)
      .set('Cookie', adminCookie)
      .send({ reason: 'waiting for the maintenance window' });
    expect(res.status).toBe(200);
    const row = GitOpsStore.getInstance().getApplication(seeded.applicationId)!;
    expect(row.pause_reason).toBe('waiting for the maintenance window');
    expect(projectApplication(seeded.applicationId, false).facets?.rollout.status).toBe('rollout_paused');
  });

  it('records the pause as one notification naming the operator decision', async () => {
    const seeded = seedGitManagedBlueprint();
    await authorizeRollout(seeded);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/pause`)
      .set('Cookie', adminCookie)
      .send({ reason: 'waiting for the maintenance window' });
    expect(res.status).toBe(200);

    // The live drain runs on a macrotask; the startup repair drains the same
    // row synchronously and would duplicate it if the dedupe key were missing.
    const { repairGitOpsOutbox } = await import('../services/gitops/outbox');
    repairGitOpsOutbox();

    const db = DatabaseService.getInstance().getDb();
    const history = db.prepare(
      `SELECT operation_id, actor FROM gitops_history
       WHERE application_id = ? AND stage = 'rollout_paused'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(seeded.applicationId) as { operation_id: string; actor: string };
    const notes = db.prepare(
      `SELECT category, level, message, actor_username, gitops_operation_id
       FROM notification_history WHERE gitops_operation_id = ?`,
    ).all(history.operation_id) as Array<{
      category: string;
      level: string;
      message: string;
      actor_username: string;
      gitops_operation_id: string;
    }>;
    expect(notes).toHaveLength(1);
    expect(notes[0].category).toBe('gitops_rollout_paused');
    expect(notes[0].level).toBe('warning');
    expect(notes[0].message).toContain('rollout paused');
    expect(notes[0].message).toContain('waiting for the maintenance window');
    expect(notes[0].actor_username).toBe(history.actor);
  });

  it('requires a reason', async () => {
    const seeded = seedGitManagedBlueprint();
    await authorizeRollout(seeded);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/pause`)
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONFIRM_REQUIRED');
  });

  it('refuses to pause when there is no rollout to hold', async () => {
    const seeded = seedGitManagedBlueprint();
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/pause`)
      .set('Cookie', adminCookie)
      .send({ reason: 'wait for the window' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ROLLOUT_PAUSE_REFUSED');
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)!.pause_at).toBeNull();
  });

  it('rejects a caller without stack:deploy', async () => {
    const seeded = seedGitManagedBlueprint();
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/pause`)
      .set('Cookie', viewerCookie)
      .send({ reason: 'nope' });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/gitops/applications/:id/rollout/resume', () => {
  it('resumes a paused rollout and continues the authorized queue', async () => {
    const seeded = seedGitManagedBlueprint();
    await authorizeRollout(seeded);
    const transitions = (await import('../services/gitops/transitions')).GitOpsTransitions.getInstance();
    transitions.rolloutPaused(seeded.applicationId, null, 'hold', {
      operationId: randomUUID(), actor: 'tester', trigger: 'test', at: Date.now(),
    });
    const dispatchSpy = vi
      .spyOn((await import('../services/GitSourceService')).GitSourceService.getInstance(), 'dispatchAcceptedGeneration')
      .mockResolvedValue({ status: 'dispatched' });
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/resume`)
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, dispatched: true });
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)!.pause_at).toBeNull();
  });

  it('reports that nothing started when no authorization is live', async () => {
    const seeded = seedGitManagedBlueprint();
    const transitions = (await import('../services/gitops/transitions')).GitOpsTransitions.getInstance();
    transitions.rolloutPaused(seeded.applicationId, null, 'hold', {
      operationId: randomUUID(), actor: 'tester', trigger: 'test', at: Date.now(),
    });
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/resume`)
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.dispatched).toBe(false);
    expect(res.body.note).toContain('no live authorization');
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)!.pause_at).toBeNull();
  });

  it('refuses to resume a rollout that is not paused', async () => {
    const seeded = seedGitManagedBlueprint();
    await authorizeRollout(seeded);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/resume`)
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ROLLOUT_RESUME_REFUSED');
  });

  it('pauses and resumes a single target without touching the application pause', async () => {
    const seeded = seedGitManagedBlueprint();
    await authorizeRollout(seeded);
    const store = GitOpsStore.getInstance();
    const pause = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/pause`)
      .set('Cookie', adminCookie)
      .send({ reason: 'node maintenance', nodeId: seeded.nodeIds[0] });
    expect(pause.status).toBe(200);
    expect(store.getTarget(seeded.applicationId, seeded.nodeIds[0])!.pause_at).not.toBeNull();
    expect(store.getApplication(seeded.applicationId)!.pause_at).toBeNull();

    // A target resume clears that target's hold and continues the queue, so
    // the still-authorized rollout is dispatched again.
    const dispatchSpy = vi
      .spyOn((await import('../services/GitSourceService')).GitSourceService.getInstance(), 'dispatchAcceptedGeneration')
      .mockResolvedValue({ status: 'dispatched' });
    const resume = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/resume`)
      .set('Cookie', adminCookie)
      .send({ nodeId: seeded.nodeIds[0] });
    expect(resume.status).toBe(200);
    expect(resume.body).toMatchObject({ ok: true, dispatched: true, note: null });
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(store.getTarget(seeded.applicationId, seeded.nodeIds[0])!.pause_at).toBeNull();
  });

  it('refuses an unusable nodeId', async () => {
    const seeded = seedGitManagedBlueprint();
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/pause`)
      .set('Cookie', adminCookie)
      .send({ reason: 'node maintenance', nodeId: 'one' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/gitops/applications/:id/rollout/supersede', () => {
  it('withdraws the live authorization and reports the abandoned rollout', async () => {
    const seeded = seedGitManagedBlueprint();
    await authorizeRollout(seeded);
    const store = GitOpsStore.getInstance();
    const generationId = store.getApplication(seeded.applicationId)!.rollout_generation_id!;
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/supersede`)
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(200);
    const row = store.getApplication(seeded.applicationId)!;
    expect(row.rollout_authorization_ref).toBeNull();
    expect(store.getRolloutGeneration(generationId)?.superseded_at).toBeTruthy();
    expect(projectApplication(seeded.applicationId, false).facets?.rollout.status).toBe('rollout_superseded');
  });

  it('refuses when no authorized rollout exists', async () => {
    const seeded = seedGitManagedBlueprint();
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/supersede`)
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ROLLOUT_SUPERSEDE_REFUSED');
  });

  it('refuses a placement generation that was never authorized', async () => {
    const seeded = seedGitManagedBlueprint();
    const transitions = (await import('../services/gitops/transitions')).GitOpsTransitions.getInstance();
    const { encodeGitOpsApprovedTargetEffectJson } = await import('../services/gitops/json');
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
      envelope: { operationId: randomUUID(), actor: 'tester', trigger: 'test', at: Date.now() },
      rolloutGenerationId: `rgen-${randomUUID().slice(0, 8)}`,
      candidateId: seeded.candidateId,
      provenance: 'placement_approval',
    });
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/supersede`)
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ROLLOUT_SUPERSEDE_REFUSED');
  });
});

describe('POST /api/gitops/applications/:id/rollout/replan', () => {
  it('mints a fresh intent and candidate when placement moved', async () => {
    const seeded = seedGitManagedBlueprint();
    const store = GitOpsStore.getInstance();
    const extraNode = insertNode(`replan-node-${randomUUID().slice(0, 8)}`);
    DatabaseService.getInstance().updateBlueprint(seeded.blueprintId, {
      selector: { type: 'nodes', ids: [...seeded.nodeIds, extraNode] },
    });
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/replan`)
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(200);
    const row = store.getApplication(seeded.applicationId)!;
    expect(row.intent_revision_id).not.toBe(seeded.intentId);
    expect(row.rollout_candidate_id).not.toBe(seeded.candidateId);
    const candidate = store.getRolloutCandidate(row.rollout_candidate_id!)!;
    expect(JSON.parse(candidate.required_targets_json).nodeIds).toContain(extraNode);
  });

  it('refuses when the current placement already matches', async () => {
    const seeded = seedGitManagedBlueprint();
    // The seeded intent describes another stack, so it is not the Blueprint's
    // current intent and replan has a real question to ask. Re-seed that
    // relationship by minting once, then replanning again with nothing moved.
    const first = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/replan`)
      .set('Cookie', adminCookie)
      .send({});
    expect(first.status).toBe(200);
    const second = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/replan`)
      .set('Cookie', adminCookie)
      .send({});
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('REPLAN_UNAVAILABLE');
  });

  it('refuses when the application has no candidate to replan', async () => {
    const seeded = seedGitManagedBlueprint();
    DatabaseService.getInstance().getDb()
      .prepare('UPDATE gitops_applications SET rollout_candidate_id = NULL WHERE id = ?')
      .run(seeded.applicationId);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/replan`)
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REPLAN_UNAVAILABLE');
  });

  it('rejects a caller without stack:create', async () => {
    const seeded = seedGitManagedBlueprint();
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/replan`)
      .set('Cookie', viewerCookie)
      .send({});
    expect(res.status).toBe(403);
  });

  it('lets a deployer pause without stack:create but not replan', async () => {
    const seeded = seedGitManagedBlueprint();
    await authorizeRollout(seeded);
    const pause = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/pause`)
      .set('Cookie', deployerCookie)
      .send({ reason: 'waiting' });
    expect(pause.status).toBe(200);
    const replan = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/replan`)
      .set('Cookie', deployerCookie)
      .send({});
    expect(replan.status).toBe(403);
  });
});

describe('POST /api/gitops/applications/:id/rollout/rollback', () => {
  it('restores the selected generation from the node recovery point', async () => {
    const seeded = seedGitManagedBlueprint();
    await authorizeRollout(seeded);
    insertRecoveryPoint(seeded, seeded.nodeIds[0], seeded.generationId);
    const compensateSpy = vi
      .spyOn(StackUpdateRecoveryService.getInstance(), 'compensateWithCandidate')
      .mockResolvedValue(true);

    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/rollback`)
      .set('Cookie', adminCookie)
      .send({ generationId: seeded.generationId, scope: { kind: 'target', nodeId: seeded.nodeIds[0] } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, results: [{ nodeId: seeded.nodeIds[0], status: 'restored' }] });
    expect(compensateSpy).toHaveBeenCalledTimes(1);

    const store = GitOpsStore.getInstance();
    const target = store.getTarget(seeded.applicationId, seeded.nodeIds[0])!;
    expect(target.applied_generation_id).toBe(seeded.generationId);
    expect(target.recovery_phase).toBe('complete');
    expect(store.getApplication(seeded.applicationId)!.rollout_authorization_ref).toBeNull();
    expect(projectApplication(seeded.applicationId, false).facets?.rollout.status).toBe('rollout_superseded');
    // The strongest evidence for the restored generation is rebound; the
    // acceptance that authorized exactly that generation survives.
    expect(target.expected_artifact_set_id).toBeTruthy();
    expect(target.latest_artifact_set_id).toBe(target.expected_artifact_set_id);
    expect(target.source_acceptance_ref).toBeTruthy();
  });

  it('fails a target that has no recovery point and reports a partial rollback', async () => {
    const seeded = seedGitManagedBlueprint();
    await authorizeRollout(seeded);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/rollback`)
      .set('Cookie', adminCookie)
      .send({ generationId: seeded.generationId, scope: { kind: 'all_changed' } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.results[0].status).toBe('failed');
    expect(projectApplication(seeded.applicationId, false).facets?.rollout.status).toBe('rollback_partial_failed');
  });

  it('restores the matching targets and fails the rest in one scope', async () => {
    const seeded = seedGitManagedBlueprint({ nodeCount: 2 });
    await authorizeRollout(seeded);
    insertRecoveryPoint(seeded, seeded.nodeIds[0], seeded.generationId);
    vi.spyOn(StackUpdateRecoveryService.getInstance(), 'compensateWithCandidate').mockResolvedValue(true);

    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/rollback`)
      .set('Cookie', adminCookie)
      .send({ generationId: seeded.generationId, scope: { kind: 'all_changed' } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.results).toEqual([
      { nodeId: seeded.nodeIds[0], status: 'restored' },
      { nodeId: seeded.nodeIds[1], status: 'failed', error: 'The node holds no recovery point for "' + seeded.stackName + '".' },
    ]);
    const store = GitOpsStore.getInstance();
    expect(store.getTarget(seeded.applicationId, seeded.nodeIds[0])!.recovery_phase).toBe('complete');
    expect(store.getTarget(seeded.applicationId, seeded.nodeIds[1])!.recovery_phase).toBe('failed');
    expect(projectApplication(seeded.applicationId, false).facets?.rollout.status).toBe('rollback_partial_failed');
  });

  it('reports a partial failure when the recovery point names another generation', async () => {
    const seeded = seedGitManagedBlueprint();
    await authorizeRollout(seeded);
    insertRecoveryPoint(seeded, seeded.nodeIds[0], 'gen-someone-else');
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/rollback`)
      .set('Cookie', adminCookie)
      .send({ generationId: seeded.generationId, scope: { kind: 'target', nodeId: seeded.nodeIds[0] } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.results[0]).toMatchObject({ nodeId: seeded.nodeIds[0], status: 'failed' });
    const projection = projectApplication(seeded.applicationId, false);
    expect(projection.facets?.rollout.status).toBe('rollback_partial_failed');
  });

  it('reports a target whose restore completed but could not be recorded', async () => {
    const seeded = seedGitManagedBlueprint();
    await authorizeRollout(seeded);
    insertRecoveryPoint(seeded, seeded.nodeIds[0], seeded.generationId);
    vi.spyOn(StackUpdateRecoveryService.getInstance(), 'compensateWithCandidate').mockResolvedValue(true);
    const { GitOpsTransitions } = await import('../services/gitops/transitions');
    vi.spyOn(GitOpsTransitions.getInstance(), 'rollbackCompleted').mockImplementation(() => {
      throw new Error('db write failed');
    });

    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/rollback`)
      .set('Cookie', adminCookie)
      .send({ generationId: seeded.generationId, scope: { kind: 'all_changed' } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.results[0]).toEqual({
      nodeId: seeded.nodeIds[0],
      status: 'failed',
      error: 'The restore completed but its result could not be recorded.',
    });
    expect(projectApplication(seeded.applicationId, false).facets?.rollout.status).toBe('rollback_partial_failed');
  });

  it('refuses a failed-target scope when nothing failed', async () => {
    const seeded = seedGitManagedBlueprint();
    await authorizeRollout(seeded);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/rollback`)
      .set('Cookie', adminCookie)
      .send({ generationId: seeded.generationId, scope: { kind: 'failed' } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_FAILED_TARGETS');
  });

  it('refuses a generation another application owns', async () => {
    const seeded = seedGitManagedBlueprint();
    await authorizeRollout(seeded);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/rollback`)
      .set('Cookie', adminCookie)
      .send({ generationId: randomUUID(), scope: { kind: 'all_changed' } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ROLLBACK_REFUSED');
  });

  it('refuses a disabled Blueprint before restoring anything', async () => {
    const seeded = seedGitManagedBlueprint();
    await authorizeRollout(seeded);
    DatabaseService.getInstance().updateBlueprint(seeded.blueprintId, { enabled: false });
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/rollback`)
      .set('Cookie', adminCookie)
      .send({ generationId: seeded.generationId, scope: { kind: 'all_changed' } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BLUEPRINT_DISABLED');
  });

  it('exposes the prior rollout generations on the application detail read', async () => {
    const seeded = seedGitManagedBlueprint();
    await authorizeRollout(seeded);
    const store = GitOpsStore.getInstance();
    const priorGenerationId = `gen-prior-${randomUUID().slice(0, 8)}`;
    insertGeneration(priorGenerationId, seeded.applicationId);
    DatabaseService.getInstance().getDb().prepare(
      `UPDATE gitops_rollout_generations SET accepted_generation_id = ?, created_at = 1
       WHERE application_id = ?`,
    ).run(priorGenerationId, seeded.applicationId);
    const currentGenerationId = `gen-current-${randomUUID().slice(0, 8)}`;
    insertGeneration(currentGenerationId, seeded.applicationId);
    DatabaseService.getInstance().getDb().prepare(
      'UPDATE gitops_applications SET accepted_generation_id = ? WHERE id = ?',
    ).run(currentGenerationId, seeded.applicationId);

    const res = await request(app)
      .get(`/api/gitops/applications/bp:${seeded.blueprintId}`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.rollbackCandidates).toEqual([
      expect.objectContaining({ generationId: priorGenerationId }),
    ]);
    expect(store.getApplication(seeded.applicationId)).toBeTruthy();
  });

  it('rejects a caller without stack:deploy', async () => {
    const seeded = seedGitManagedBlueprint();
    await authorizeRollout(seeded);
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/rollback`)
      .set('Cookie', viewerCookie)
      .send({ generationId: seeded.generationId, scope: { kind: 'all_changed' } });
    expect(res.status).toBe(403);
  });

  it('rejects an unparseable scope', async () => {
    const seeded = seedGitManagedBlueprint();
    const res = await request(app)
      .post(`/api/gitops/applications/bp:${seeded.blueprintId}/rollout/rollback`)
      .set('Cookie', adminCookie)
      .send({ generationId: seeded.generationId, scope: { kind: 'everything' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONFIRM_REQUIRED');
  });

  it('refuses an Inline Blueprint application', async () => {
    const blueprint = commitBlueprintCreate({
      name: `bp-inline-lifecycle-${randomUUID().slice(0, 8)}`,
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
      .post(`/api/gitops/applications/bp:${blueprint.id}/rollout/rollback`)
      .set('Cookie', adminCookie)
      .send({ generationId: randomUUID(), scope: { kind: 'all_changed' } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_GIT_MANAGED');
  });
});
