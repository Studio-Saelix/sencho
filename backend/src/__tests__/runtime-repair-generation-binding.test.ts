/**
 * Generation stability of the runtime drift repair path.
 *
 * A Blueprint's Enforce mode restores the identity a target was already
 * authorized for. These tests pin that promise: the repair reads the target's
 * own acknowledged generation, never the application's newest accepted one, and
 * refuses outright when the target's rollout generation has moved on.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import { newGitOpsId } from '../services/gitops/directApplication';
import { emptyTargetRow, GitOpsStore } from '../services/gitops/store';
import {
  encodeArtifactEvidenceJson,
  encodeGitOpsRequiredTargetsJson,
  type ServiceArtifactEvidence,
} from '../services/gitops/json';
import type {
  GitOpsGenerationRow,
  GitOpsRolloutGenerationRow,
} from '../services/gitops/types';
import type { Blueprint, Node } from '../services/DatabaseService';

vi.mock('../services/gitops/artifactResolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/gitops/artifactResolve')>();
  return {
    ...actual,
    resolvePlatformLabelForNode: vi.fn(async () => 'linux/amd64'),
  };
});

const OLD_DIGEST = `sha256:${'a'.repeat(64)}`;
const NEW_DIGEST = `sha256:${'b'.repeat(64)}`;

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let BlueprintService: typeof import('../services/BlueprintService').BlueprintService;
let counter = 0;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ BlueprintService } = await import('../services/BlueprintService'));
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  vi.restoreAllMocks();
  GitOpsStore.resetForTests();
  const db = DatabaseService.getInstance().getDb();
  db.prepare('DELETE FROM blueprint_deployments').run();
  db.prepare('DELETE FROM blueprints').run();
  db.prepare("DELETE FROM nodes WHERE is_default = 0").run();
  counter += 1;
});

function registryService(platformDigest: string, serviceName = 'web'): ServiceArtifactEvidence {
  return {
    serviceName,
    authoredRef: 'nginx:latest',
    source: 'registry',
    platform: 'linux/amd64',
    indexDigest: platformDigest,
    platformDigest,
    platformVariants: [{ platform: 'linux/amd64', digest: platformDigest }],
    localDigests: null,
    buildContextFingerprint: null,
    producedImageId: null,
    failureClass: null,
    resolvedAt: 1,
  };
}

function seedBlueprint(): { bp: Blueprint; node: Node } {
  counter += 1;
  const nodeId = DatabaseService.getInstance().getDb().prepare(
    `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
     VALUES (?, 'local', 'proxy', '/tmp/compose', 0, 'online', ?)`,
  ).run(`gen-bind-${counter}`, Date.now()).lastInsertRowid as number;
  const bp = DatabaseService.getInstance().createBlueprint({
    name: `gen-bind-bp-${counter}`,
    description: null,
    compose_content: 'services:\n  web:\n    image: nginx:latest\n',
    selector: { type: 'nodes', ids: [nodeId] },
    drift_mode: 'enforce',
    classification: 'stateless',
    classification_reasons: [],
    enabled: true,
    created_by: 'tester',
  });
  return { bp, node: DatabaseService.getInstance().getNode(nodeId)! };
}

type SeededGeneration = { generationId: string; artifactSetId: string; compose: string };

/**
 * Insert one accepted generation with its exact artifact set and a real
 * applied materialization on disk, so a repair that reads the wrong generation
 * produces observably different compose bytes rather than an error.
 */
async function seedGeneration(
  appId: string,
  stackName: string,
  platformDigest: string,
  compose: string,
): Promise<SeededGeneration> {
  const store = GitOpsStore.getInstance();
  const generationId = newGitOpsId();
  const artifactSetId = newGitOpsId();
  const appliedDir = `generations/${generationId}-applied`;
  const managedRoot = path.join(
    process.env.DATA_DIR || path.join(process.cwd(), 'data'),
    'git-managed',
    String((await import('../services/NodeRegistry')).NodeRegistry.getInstance().getDefaultNodeId()),
    stackName,
  );
  const appliedAbs = path.resolve(managedRoot, appliedDir);
  await fs.mkdir(appliedAbs, { recursive: true });
  await fs.writeFile(path.join(appliedAbs, 'compose.yaml'), compose, 'utf8');

  const row: GitOpsGenerationRow = {
    id: generationId,
    application_id: appId,
    commit_sha: 'a'.repeat(40),
    repo_url: 'https://github.com/example/repo.git',
    configured_ref: 'main',
    resolved_ref_kind: null,
    repo_identity_json: JSON.stringify({ host: 'github.com', pathname: '/example/repo.git' }),
    manifest_version: 1,
    candidate_dir: `generations/${generationId}`,
    applied_dir: appliedDir,
    expected_invocation_json: '{}',
    materialization_fingerprint: 'a'.repeat(64),
    validation_ok: 1,
    plan_blocked: 0,
    change_plan_fingerprint: null,
    operation_id: `op-${generationId}`,
    trigger: 'test',
    actor: null,
    previous_generation_id: null,
    redacted_limitations_json: '[]',
    portable_manifest_json: null,
    compose_inputs_json: null,
    source_policy_evidence_json: null,
    security_policy_evidence_json: null,
    support_requirements_json: null,
    compatibility_requirements_json: null,
    secret_capability_json: null,
    created_at: Date.now(),
  };
  store.insertGeneration(row);
  store.insertArtifactSet({
    id: artifactSetId,
    generation_id: generationId,
    evidence_version: 1,
    authoritative: 0,
    qualification: 'exact',
    evidence_json: encodeArtifactEvidenceJson({
      kind: 'exact',
      identity: `exact:${platformDigest}`,
      services: [registryService(platformDigest)],
    }),
    created_at: Date.now(),
  });
  return { generationId, artifactSetId, compose };
}

function seedRolloutGeneration(args: {
  appId: string;
  nodeId: number;
  generation: SeededGeneration;
  superseded: boolean;
}): string {
  const rolloutGenerationId = newGitOpsId();
  const row: GitOpsRolloutGenerationRow = {
    id: rolloutGenerationId,
    application_id: args.appId,
    intent_revision_id: newGitOpsId(),
    rollout_candidate_id: newGitOpsId(),
    accepted_generation_id: args.generation.generationId,
    artifact_set_id: args.generation.artifactSetId,
    placement_approval_ref: newGitOpsId(),
    // A generation with no policy snapshot is what one predating the policy
    // contract looks like, and this row is about which generation a target
    // may restore, so null is the honest value rather than a stand-in.
    policy_snapshot_json: null,
    source_acceptance_ref: newGitOpsId(),
    rollout_authorization_ref: newGitOpsId(),
    required_targets_json: encodeGitOpsRequiredTargetsJson([args.nodeId]),
    preflight_fingerprint: null,
    preflight_evidence_json: null,
    rollout_strategy_json: '{}',
    provenance: 'rollout_authorization',
    supersedes_generation_id: null,
    superseded_at: args.superseded ? Date.now() : null,
    operation_id: `op-${rolloutGenerationId}`,
    actor: null,
    trigger: 'test',
    created_at: Date.now(),
  };
  GitOpsStore.getInstance().insertRolloutGeneration(row);
  return rolloutGenerationId;
}

type GitManagedFixture = {
  appId: string;
  stackName: string;
  old: SeededGeneration;
  latest: SeededGeneration;
  oldRolloutGenerationId: string;
  latestRolloutGenerationId: string;
};

const OLD_COMPOSE = 'services:\n  web:\n    image: nginx@sha256:old\n';
const NEW_COMPOSE = 'services:\n  web:\n    image: nginx@sha256:new\n';

/**
 * A Git-managed Blueprint mid-rollout: the application has accepted a newer
 * generation while the target is still acknowledged against the older one.
 * That is the ordinary window between source acceptance and the rollout that
 * will advance the target, and it is the state a repair must not confuse.
 */
async function seedGitManagedMidRollout(bp: Blueprint, node: Node): Promise<GitManagedFixture> {
  const store = GitOpsStore.getInstance();
  const appId = newGitOpsId();
  const stackName = `src-${appId}`;
  store.insertApplication({
    ...directApplicationFixture(appId, stackName),
    target_mode: 'blueprint',
    lifecycle_key: `blueprint:${bp.id}`,
    stack_name: null,
    configured_source_stack_name: stackName,
    blueprint_id: bp.id,
  });
  DatabaseService.getInstance().updateBlueprintContentOrigin(bp.id, 'git', appId);

  const old = await seedGeneration(appId, stackName, OLD_DIGEST, OLD_COMPOSE);
  const oldRolloutGenerationId = seedRolloutGeneration({
    appId, nodeId: node.id, generation: old, superseded: false,
  });
  const latest = await seedGeneration(appId, stackName, NEW_DIGEST, NEW_COMPOSE);
  const latestRolloutGenerationId = seedRolloutGeneration({
    appId, nodeId: node.id, generation: latest, superseded: false,
  });

  const app = store.getApplication(appId)!;
  app.accepted_generation_id = latest.generationId;
  app.artifact_set_id = latest.artifactSetId;
  app.latest_artifact_set_id = latest.artifactSetId;
  app.rollout_generation_id = latestRolloutGenerationId;
  store.writeApplicationPointers(app);
  store.upsertTarget({
    ...emptyTargetRow(appId, node.id, Date.now()),
    desired_generation_id: old.generationId,
    applied_generation_id: old.generationId,
    deployed_generation_id: old.generationId,
    expected_artifact_set_id: old.artifactSetId,
    latest_artifact_set_id: old.artifactSetId,
    lkg_generation_id: old.generationId,
    lkg_artifact_set_id: old.artifactSetId,
    rollout_generation_id: oldRolloutGenerationId,
  });
  return { appId, stackName, old, latest, oldRolloutGenerationId, latestRolloutGenerationId };
}

describe('runtime repair reads the target\'s acknowledged generation', () => {
  it('reapplies the acknowledged generation while the target\'s rollout generation is still live', async () => {
    const { bp, node } = seedBlueprint();
    const fixture = await seedGitManagedMidRollout(bp, node);
    const store = GitOpsStore.getInstance();

    // The application has moved on; the target has not. Asserted up front so a
    // fixture that silently stopped diverging cannot make the assertion below
    // pass for the wrong reason.
    const app = store.getApplication(fixture.appId)!;
    expect(app.accepted_generation_id).toBe(fixture.latest.generationId);
    expect(store.getTarget(fixture.appId, node.id)?.desired_generation_id).toBe(fixture.old.generationId);

    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    const outcome = await BlueprintService.getInstance().reapplyAuthorizedMaterialization(bp, node);

    expect(outcome).toEqual({ status: 'active' });
    expect(deploySpy).toHaveBeenCalledTimes(1);
    expect(
      deploySpy.mock.calls[0]?.[0]?.composeContent,
      'a repair must restore the generation the target acknowledged, not the newest accepted one',
    ).toBe(OLD_COMPOSE);
  });

  it('holds without deploying once the target\'s rollout generation is superseded', async () => {
    const { bp, node } = seedBlueprint();
    const fixture = await seedGitManagedMidRollout(bp, node);
    const store = GitOpsStore.getInstance();
    store.markRolloutGenerationSuperseded(fixture.oldRolloutGenerationId, Date.now());

    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    const outcome = await BlueprintService.getInstance().reapplyAuthorizedMaterialization(bp, node);

    expect(outcome.status).toBe('repair_held');
    expect(outcome.holdReason).toBe('rollout_superseded');
    expect(deploySpy, 'a superseded rollout must not be repaired behind the rollout that replaced it')
      .not.toHaveBeenCalled();
  });

  it('holds rather than falling back to the application\'s newest artifact set', async () => {
    const { bp, node } = seedBlueprint();
    const fixture = await seedGitManagedMidRollout(bp, node);
    const store = GitOpsStore.getInstance();
    const target = store.getTarget(fixture.appId, node.id)!;
    // A target that has never acknowledged a generation: the state a node added
    // after the last rollout is in until the next one advances it. The store
    // forbids an artifact pointer without a desired generation, so both ack
    // pointers go together, and the application still points at the newest.
    store.upsertTarget({
      ...target,
      desired_generation_id: null,
      expected_artifact_set_id: null,
      latest_artifact_set_id: null,
    });

    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    const outcome = await BlueprintService.getInstance().enforceDigestRepair(bp, node);

    expect(outcome.status).toBe('repair_held');
    expect(outcome.holdReason).toBe('evidence_incomplete');
    expect(deploySpy).not.toHaveBeenCalled();
  });

  it('pins the acknowledged artifact set, not the newest one, when both are resolvable', async () => {
    const { bp, node } = seedBlueprint();
    await seedGitManagedMidRollout(bp, node);
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    const outcome = await BlueprintService.getInstance().enforceDigestRepair(bp, node);

    expect(outcome).toEqual({ status: 'active' });
    expect(deploySpy.mock.calls[0]?.[0]?.digestPins).toEqual({ web: `nginx@${OLD_DIGEST}` });
  });

  it('does not hold a target whose recovery already finished', async () => {
    // `recovery_phase` keeps a terminal value for the life of the target and is
    // never reset to null, so testing the column for non-null would hold every
    // target that has ever been rolled back, permanently. Only an in-progress
    // recovery owns the target.
    const { bp, node } = seedBlueprint();
    const fixture = await seedGitManagedMidRollout(bp, node);
    const store = GitOpsStore.getInstance();
    const target = store.getTarget(fixture.appId, node.id)!;
    store.upsertTarget({ ...target, recovery_phase: 'complete' });
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    const outcome = await BlueprintService.getInstance().enforceDigestRepair(bp, node);

    expect(outcome).toEqual({ status: 'active' });
    expect(deploySpy).toHaveBeenCalledTimes(1);
  });

  it('holds while a recovery failed, because an explicit deploy is withheld too', async () => {
    // A failed recovery is terminal but unresolved, and the model already
    // refuses an operator-initiated deploy on it. Auto-repair letting through
    // what the operator cannot do would be the worse of the two errors.
    const { bp, node } = seedBlueprint();
    const fixture = await seedGitManagedMidRollout(bp, node);
    const store = GitOpsStore.getInstance();
    const target = store.getTarget(fixture.appId, node.id)!;
    store.upsertTarget({ ...target, recovery_phase: 'failed' });
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    const outcome = await BlueprintService.getInstance().enforceDigestRepair(bp, node);

    expect(outcome.status).toBe('repair_held');
    expect(outcome.holdReason).toBe('recovery_bound');
    expect(deploySpy).not.toHaveBeenCalled();
  });

  it('proceeds while a recovery failed before it could move anything', async () => {
    // A refused rollback records `failed` on the target so the refusal stays
    // visible, but it moved nothing by construction and deliberately sets no
    // application hold. Auto-repair follows the same distinction.
    const { bp, node } = seedBlueprint();
    const fixture = await seedGitManagedMidRollout(bp, node);
    const store = GitOpsStore.getInstance();
    const target = store.getTarget(fixture.appId, node.id)!;
    store.upsertTarget({
      ...target,
      recovery_phase: 'failed',
      failure_class: 'pre_mutation',
      failure_stage: 'recovery',
    });
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    const outcome = await BlueprintService.getInstance().enforceDigestRepair(bp, node);

    expect(outcome.status).toBe('active');
    expect(deploySpy).toHaveBeenCalledTimes(1);
  });

  it('holds while a recovery is still moving on the target', async () => {
    const { bp, node } = seedBlueprint();
    const fixture = await seedGitManagedMidRollout(bp, node);
    const store = GitOpsStore.getInstance();
    const target = store.getTarget(fixture.appId, node.id)!;
    store.upsertTarget({ ...target, recovery_phase: 'restoring' });
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    const outcome = await BlueprintService.getInstance().enforceDigestRepair(bp, node);

    expect(outcome.status).toBe('repair_held');
    expect(outcome.holdReason).toBe('recovery_bound');
    expect(deploySpy, 'a repair must not fight the recovery that owns the target')
      .not.toHaveBeenCalled();
  });

  it('holds while a rollout is waiting on this target\'s health verdict', async () => {
    const { bp, node } = seedBlueprint();
    const fixture = await seedGitManagedMidRollout(bp, node);
    const store = GitOpsStore.getInstance();
    const target = store.getTarget(fixture.appId, node.id)!;
    store.upsertTarget({ ...target, pending_health_run_id: 'run-1' });
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    const outcome = await BlueprintService.getInstance().enforceDigestRepair(bp, node);

    expect(outcome.status).toBe('repair_held');
    expect(outcome.holdReason).toBe('recovery_bound');
    expect(deploySpy).not.toHaveBeenCalled();
  });
});
