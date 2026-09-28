/**
 * The runtime drift policy's decision surface: which states hold a repair, and
 * the guarantee that only a repairable drift in Enforce mode ever mutates.
 *
 * These exercise the reconciler end to end through a real drift check, because
 * the point of each case is what the policy does with a drifted target, not what
 * a helper returns in isolation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import { newGitOpsId } from '../services/gitops/directApplication';
import { emptyTargetRow, GitOpsStore } from '../services/gitops/store';
import { blankInlineApplication } from '../services/gitops/blueprintProducers';
import { projectApplication } from '../services/gitops/derive';
import {
  encodeArtifactEvidenceJson,
  encodeGitOpsRequiredTargetsJson,
  type ServiceArtifactEvidence,
} from '../services/gitops/json';
import { NodeRegistry } from '../services/NodeRegistry';
import type {
  GitOpsGenerationRow,
  GitOpsRolloutGenerationRow,
} from '../services/gitops/types';
import type { Blueprint, BlueprintClassification, Node } from '../services/DatabaseService';

vi.mock('../services/gitops/artifactResolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/gitops/artifactResolve')>();
  return {
    ...actual,
    resolvePlatformLabelForNode: vi.fn(async () => 'linux/amd64'),
  };
});

const DIGEST = `sha256:${'a'.repeat(64)}`;
const MOVED_DIGEST = `sha256:${'b'.repeat(64)}`;

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let BlueprintService: typeof import('../services/BlueprintService').BlueprintService;
let BlueprintReconciler: typeof import('../services/BlueprintReconciler').BlueprintReconciler;
let counter = 0;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ BlueprintService } = await import('../services/BlueprintService'));
  ({ BlueprintReconciler } = await import('../services/BlueprintReconciler'));
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  vi.restoreAllMocks();
  GitOpsStore.resetForTests();
  const db = DatabaseService.getInstance().getDb();
  db.prepare('DELETE FROM blueprint_deployments').run();
  db.prepare('DELETE FROM blueprints').run();
  db.prepare('DELETE FROM nodes WHERE is_default = 0').run();
  counter += 1;
});

function seedNode(): Node {
  counter += 1;
  const nodeId = DatabaseService.getInstance().getDb().prepare(
    `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
     VALUES (?, 'local', 'proxy', '/tmp/compose', 0, 'online', ?)`,
  ).run(`hold-${counter}`, Date.now()).lastInsertRowid as number;
  return DatabaseService.getInstance().getNode(nodeId)!;
}

/** A remote node with a proxy target, so the remote dispatch seam is reachable. */
function seedRemoteNode(): Node {
  counter += 1;
  const nodeId = DatabaseService.getInstance().getDb().prepare(
    `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
     VALUES (?, 'remote', 'proxy', '/tmp/compose', 0, 'online', ?)`,
  ).run(`hold-remote-${counter}`, Date.now()).lastInsertRowid as number;
  vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({
    nodeId,
    apiUrl: 'https://leaf.example.test:1852',
    apiToken: 'test-token',
    trustedLoopback: false,
  } as unknown as ReturnType<NodeRegistry['getProxyTarget']>);
  return DatabaseService.getInstance().getNode(nodeId)!;
}

function seedBlueprint(node: Node, driftMode: 'observe' | 'suggest' | 'enforce', classification: BlueprintClassification = 'stateless'): Blueprint {
  counter += 1;
  return DatabaseService.getInstance().createBlueprint({
    name: `hold-bp-${counter}`,
    description: null,
    compose_content: 'services:\n  web:\n    image: nginx:latest\n',
    selector: { type: 'nodes', ids: [node.id] },
    drift_mode: driftMode,
    classification,
    classification_reasons: [],
    enabled: true,
    created_by: 'tester',
  });
}

/** A generation row for Inline content, which materializes without a Git remote. */
function inlineGenerationFixture(
  applicationId: string,
  blueprintId: number,
  generationId: string,
): GitOpsGenerationRow {
  return {
    id: generationId,
    application_id: applicationId,
    commit_sha: 'a'.repeat(40),
    repo_url: `inline://blueprint/${blueprintId}`,
    configured_ref: 'inline',
    resolved_ref_kind: null,
    repo_identity_json: JSON.stringify({ host: 'inline', pathname: `/blueprint/${blueprintId}` }),
    manifest_version: 1,
    candidate_dir: `generations/inline-${generationId}`,
    applied_dir: `generations/inline-${generationId}-applied`,
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
}

function service(digest: string): ServiceArtifactEvidence {
  return {
    serviceName: 'web',
    authoredRef: 'nginx:latest',
    source: 'registry',
    platform: 'linux/amd64',
    indexDigest: digest,
    platformDigest: digest,
    platformVariants: [{ platform: 'linux/amd64', digest }],
    localDigests: null,
    buildContextFingerprint: null,
    producedImageId: null,
    failureClass: null,
    resolvedAt: 1,
  };
}

/**
 * A Git-managed Blueprint whose one target has acknowledged a generation and
 * its exact artifact set, with a live rollout generation freezing the pair and
 * an on-disk materialization the repair would redeploy.
 */
async function seedDeployedGitManaged(args: {
  blueprint: Blueprint;
  node: Node;
  compose: string;
  /** Freeze a qualified set instead of an exact one, so the pin builder refuses. */
  qualified?: boolean;
  /** Extra nodes to freeze into the rollout's required target set. */
  alsoRequired?: Node[];
}): Promise<{ appId: string; generationId: string; artifactSetId: string; rolloutGenerationId: string }> {
  const { blueprint, node } = args;
  const store = GitOpsStore.getInstance();
  const appId = newGitOpsId();
  const stackName = `src-${appId}`;
  store.insertApplication({
    ...directApplicationFixture(appId, stackName),
    target_mode: 'blueprint',
    lifecycle_key: `blueprint:${blueprint.id}`,
    stack_name: null,
    configured_source_stack_name: stackName,
    blueprint_id: blueprint.id,
  });
  DatabaseService.getInstance().updateBlueprintContentOrigin(blueprint.id, 'git', appId);

  const generationId = newGitOpsId();
  const artifactSetId = newGitOpsId();
  const appliedDir = `generations/${generationId}-applied`;
  const managedRoot = path.join(
    process.env.DATA_DIR || path.join(process.cwd(), 'data'),
    'git-managed',
    String(NodeRegistry.getInstance().getDefaultNodeId()),
    stackName,
  );
  const appliedAbs = path.resolve(managedRoot, appliedDir);
  await fs.mkdir(appliedAbs, { recursive: true });
  await fs.writeFile(path.join(appliedAbs, 'compose.yaml'), args.compose, 'utf8');

  const generation: GitOpsGenerationRow = {
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
  store.insertGeneration(generation);
  store.insertArtifactSet({
    id: artifactSetId,
    generation_id: generationId,
    evidence_version: 1,
    authoritative: 0,
    qualification: args.qualified ? 'qualified' : 'exact',
    evidence_json: encodeArtifactEvidenceJson({
      kind: args.qualified ? 'qualified' : 'exact',
      identity: `exact:${DIGEST}`,
      services: args.qualified
        ? [{ ...service(DIGEST), platformDigest: null, platformVariants: null, indexDigest: null }]
        : [service(DIGEST)],
    }),
    created_at: Date.now(),
  });

  const rolloutGenerationId = newGitOpsId();
  const rollout: GitOpsRolloutGenerationRow = {
    id: rolloutGenerationId,
    application_id: appId,
    intent_revision_id: newGitOpsId(),
    rollout_candidate_id: newGitOpsId(),
    accepted_generation_id: generationId,
    artifact_set_id: artifactSetId,
    placement_approval_ref: newGitOpsId(),
    source_acceptance_ref: newGitOpsId(),
    rollout_authorization_ref: newGitOpsId(),
    required_targets_json: encodeGitOpsRequiredTargetsJson([
      node.id,
      ...(args.alsoRequired ?? []).map((n) => n.id),
    ]),
    preflight_fingerprint: null,
    preflight_evidence_json: null,
    rollout_strategy_json: '{}',
    provenance: 'rollout_authorization',
    supersedes_generation_id: null,
    superseded_at: null,
    operation_id: `op-${rolloutGenerationId}`,
    actor: null,
    trigger: 'test',
    created_at: Date.now(),
  };
  store.insertRolloutGeneration(rollout);

  const app = store.getApplication(appId)!;
  app.accepted_generation_id = generationId;
  app.artifact_set_id = artifactSetId;
  app.latest_artifact_set_id = artifactSetId;
  app.rollout_generation_id = rolloutGenerationId;
  store.writeApplicationPointers(app);
  // The live rollout pointer is written by the authorization transition, not by
  // the pointer writer above, so a fixture that only calls the writer leaves the
  // application looking like it was never authorized. Placement invalidation
  // short-circuits on this column, so without it a test cannot see a supersede
  // that production really does perform.
  DatabaseService.getInstance().getDb()
    .prepare('UPDATE gitops_applications SET rollout_generation_id = ? WHERE id = ?')
    .run(rolloutGenerationId, appId);
  store.upsertTarget({
    ...emptyTargetRow(appId, node.id, Date.now()),
    target_status: 'active',
    desired_generation_id: generationId,
    applied_generation_id: generationId,
    deployed_generation_id: generationId,
    expected_artifact_set_id: artifactSetId,
    latest_artifact_set_id: artifactSetId,
    rollout_generation_id: rolloutGenerationId,
  });
  return { appId, generationId, artifactSetId, rolloutGenerationId };
}

const COMPOSE = 'services:\n  web:\n    image: nginx@sha256:approved\n';

/** Make the node look drifted: containers up, marker current, digest moved. */
function stubDriftedRuntime(blueprint: Blueprint, generationId: string, artifactSetId: string, rolloutGenerationId: string): void {
  const svc = BlueprintService.getInstance() as unknown as {
    containerHealth: () => Promise<{ kind: 'running' }>;
    observeRuntimeIdentity: () => Promise<import('../services/gitops/json').ObservedArtifactIdentity>;
  };
  vi.spyOn(BlueprintService.getInstance(), 'readMarker').mockResolvedValue({
    blueprintId: blueprint.id,
    revision: blueprint.revision,
    lastApplied: Date.now(),
    applicationId: store_app(blueprint),
    generationId,
    artifactSetId,
    rolloutGenerationId,
  });
  vi.spyOn(svc, 'containerHealth').mockResolvedValue({ kind: 'running' });
  vi.spyOn(svc, 'observeRuntimeIdentity').mockResolvedValue({
    kind: 'exact',
    identity: `exact:${MOVED_DIGEST}`,
    observedAt: Date.now(),
    services: [{
      serviceName: 'web',
      authoredRef: 'nginx:latest',
      source: 'registry',
      platform: 'linux/amd64',
      indexDigest: null,
      platformDigest: MOVED_DIGEST,
      platformVariants: null,
      localDigests: [MOVED_DIGEST],
      buildContextFingerprint: null,
      producedImageId: 'img-1',
      failureClass: null,
      resolvedAt: 2,
    }],
  });
}

function store_app(blueprint: Blueprint): string {
  return GitOpsStore.getInstance().getLiveBlueprintApplication(blueprint.id)!.id;
}

/**
 * Make the node look converged: containers up, marker current, and the approved
 * digest actually running. The counterpart to `stubDriftedRuntime`, for the
 * case where a hold clears because the workload is right rather than because
 * there is something to repair.
 */
function stubMatchedRuntime(blueprint: Blueprint, generationId: string, artifactSetId: string, rolloutGenerationId: string): void {
  const svc = BlueprintService.getInstance() as unknown as {
    containerHealth: () => Promise<{ kind: 'running' }>;
    observeRuntimeIdentity: () => Promise<import('../services/gitops/json').ObservedArtifactIdentity>;
  };
  vi.spyOn(BlueprintService.getInstance(), 'readMarker').mockResolvedValue({
    blueprintId: blueprint.id,
    revision: blueprint.revision,
    lastApplied: Date.now(),
    applicationId: store_app(blueprint),
    generationId,
    artifactSetId,
    rolloutGenerationId,
  });
  vi.spyOn(svc, 'containerHealth').mockResolvedValue({ kind: 'running' });
  vi.spyOn(svc, 'observeRuntimeIdentity').mockResolvedValue({
    kind: 'exact',
    identity: `exact:${DIGEST}`,
    observedAt: Date.now(),
    services: [{
      serviceName: 'web',
      authoredRef: 'nginx:latest',
      source: 'registry',
      platform: 'linux/amd64',
      indexDigest: null,
      platformDigest: DIGEST,
      platformVariants: null,
      localDigests: [DIGEST],
      buildContextFingerprint: null,
      producedImageId: 'img-1',
      failureClass: null,
      resolvedAt: 2,
    }],
  });
}

/** Drive the reconciler tick for one Blueprint, re-reading it first. */
async function tick(blueprint: Blueprint, node: Node): Promise<void> {
  // Re-read: binding this Blueprint to Git changes its content origin, and the
  // reconciler routes on the stored row rather than on the object the test
  // happened to be holding.
  const current = DatabaseService.getInstance().getBlueprint(blueprint.id)!;
  await (BlueprintReconciler.getInstance() as unknown as {
    reconcileBlueprint: (b: Blueprint, n: Node[]) => Promise<void>;
  }).reconcileBlueprint(current, [node]);
}

function deploymentOf(blueprint: Blueprint, node: Node) {
  return DatabaseService.getInstance().getDeployment(blueprint.id, node.id);
}

describe('the runtime drift policy holds what it must not repair', () => {
  it('holds a stateful Blueprint instead of auto-fixing it', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node, 'enforce', 'stateful');
    const seeded = await seedDeployedGitManaged({ blueprint, node, compose: COMPOSE });
    DatabaseService.getInstance().upsertDeployment({
      blueprint_id: blueprint.id,
      node_id: node.id,
      status: 'active',
      applied_revision: blueprint.revision,
      last_deployed_at: Date.now(),
    });
    stubDriftedRuntime(blueprint, seeded.generationId, seeded.artifactSetId, seeded.rolloutGenerationId);
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    await tick(blueprint, node);

    expect(deploySpy, 'a stateful workload is never auto-repaired').not.toHaveBeenCalled();
    const deployment = deploymentOf(blueprint, node);
    expect(deployment?.status).toBe('repair_held');
    expect(deployment?.drift_summary).toMatch(/stateful/i);
  });

  it('holds an unclassifiable Blueprint, whose volumes Sencho cannot reason about', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node, 'enforce', 'unknown');
    const seeded = await seedDeployedGitManaged({ blueprint, node, compose: COMPOSE });
    DatabaseService.getInstance().upsertDeployment({
      blueprint_id: blueprint.id,
      node_id: node.id,
      status: 'active',
      applied_revision: blueprint.revision,
      last_deployed_at: Date.now(),
    });
    stubDriftedRuntime(blueprint, seeded.generationId, seeded.artifactSetId, seeded.rolloutGenerationId);
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    await tick(blueprint, node);

    expect(deploySpy).not.toHaveBeenCalled();
    expect(deploymentOf(blueprint, node)?.status).toBe('repair_held');
  });

  it('holds when the target is unreachable rather than writing to it', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node, 'enforce');
    const seeded = await seedDeployedGitManaged({ blueprint, node, compose: COMPOSE });
    DatabaseService.getInstance().upsertDeployment({
      blueprint_id: blueprint.id,
      node_id: node.id,
      status: 'active',
      applied_revision: blueprint.revision,
      last_deployed_at: Date.now(),
    });
    stubDriftedRuntime(blueprint, seeded.generationId, seeded.artifactSetId, seeded.rolloutGenerationId);
    const store = GitOpsStore.getInstance();
    store.upsertTarget({
      ...store.getTarget(seeded.appId, node.id)!,
      connectivity: 'unreachable',
    });
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    await tick(blueprint, node);

    expect(deploySpy).not.toHaveBeenCalled();
    expect(deploymentOf(blueprint, node)?.status).toBe('repair_held');
  });

  it('holds an interrupted target, whose running state is not known', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node, 'enforce');
    const seeded = await seedDeployedGitManaged({ blueprint, node, compose: COMPOSE });
    DatabaseService.getInstance().upsertDeployment({
      blueprint_id: blueprint.id,
      node_id: node.id,
      status: 'active',
      applied_revision: blueprint.revision,
      last_deployed_at: Date.now(),
    });
    stubDriftedRuntime(blueprint, seeded.generationId, seeded.artifactSetId, seeded.rolloutGenerationId);
    const store = GitOpsStore.getInstance();
    const target = store.getTarget(seeded.appId, node.id)!;
    store.upsertTarget({
      ...target,
      interruption_stage: 'deploy_started',
      interruption_intent_revision_id: target.intent_revision_id,
      interruption_operation_id: 'op-interrupted',
    });
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    await tick(blueprint, node);

    expect(deploySpy).not.toHaveBeenCalled();
    expect(deploymentOf(blueprint, node)?.status).toBe('repair_held');
  });

  it('holds a target an unfinished rollback owns', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node, 'enforce');
    const seeded = await seedDeployedGitManaged({ blueprint, node, compose: COMPOSE });
    DatabaseService.getInstance().upsertDeployment({
      blueprint_id: blueprint.id,
      node_id: node.id,
      status: 'active',
      applied_revision: blueprint.revision,
      last_deployed_at: Date.now(),
    });
    stubDriftedRuntime(blueprint, seeded.generationId, seeded.artifactSetId, seeded.rolloutGenerationId);
    const store = GitOpsStore.getInstance();
    store.upsertTarget({
      ...store.getTarget(seeded.appId, node.id)!,
      health_stop_reason: 'rollback_pending',
    });
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    await tick(blueprint, node);

    expect(deploySpy).not.toHaveBeenCalled();
    expect(deploymentOf(blueprint, node)?.status).toBe('repair_held');
  });

  it('leaves a legacy-marker target alone when there is no drift', async () => {
    // A marker written before the generation fields existed proves nothing about
    // which generation installed it, so Enforce may not repair from it. It does
    // not mean the workload is unhealthy: a target with no drift has to stay
    // active, or an upgrade marks the whole fleet as needing attention.
    const node = seedNode();
    const blueprint = seedBlueprint(node, 'enforce');
    const seeded = await seedDeployedGitManaged({ blueprint, node, compose: COMPOSE });
    DatabaseService.getInstance().upsertDeployment({
      blueprint_id: blueprint.id,
      node_id: node.id,
      status: 'active',
      applied_revision: blueprint.revision,
      last_deployed_at: Date.now(),
    });
    // The matched-runtime stub stamps a current marker; overriding it afterwards
    // is what makes this a legacy marker while leaving the healthy observation.
    stubMatchedRuntime(blueprint, seeded.generationId, seeded.artifactSetId, seeded.rolloutGenerationId);
    vi.spyOn(BlueprintService.getInstance(), 'readMarker').mockResolvedValue({
      blueprintId: blueprint.id,
      revision: blueprint.revision,
      lastApplied: Date.now(),
    });
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    await tick(blueprint, node);

    expect(deploySpy, 'nothing drifted, so nothing to repair').not.toHaveBeenCalled();
    expect(deploymentOf(blueprint, node)?.status, 'a healthy target must not read as needing repair')
      .toBe('active');
    expect(GitOpsStore.getInstance().getTarget(seeded.appId, node.id)?.latest_stage)
      .not.toBe('blueprint_repair_held');
  });

  it('still reports container drift on a legacy-marker target, and holds the repair', async () => {
    // The other half of the same trap. Blocking the repair must not blind the
    // detection: a stopped container is the drift an operator most needs to see,
    // and returning the hold before the container check hid it on every
    // Git-managed target in the fleet.
    const node = seedNode();
    const blueprint = seedBlueprint(node, 'enforce');
    await seedDeployedGitManaged({ blueprint, node, compose: COMPOSE });
    DatabaseService.getInstance().upsertDeployment({
      blueprint_id: blueprint.id,
      node_id: node.id,
      status: 'active',
      applied_revision: blueprint.revision,
      last_deployed_at: Date.now(),
    });
    vi.spyOn(BlueprintService.getInstance(), 'readMarker').mockResolvedValue({
      blueprintId: blueprint.id,
      revision: blueprint.revision,
      lastApplied: Date.now(),
    });
    const svc = BlueprintService.getInstance() as unknown as {
      containerHealth: () => Promise<unknown>;
      observeRuntimeIdentity: () => Promise<import('../services/gitops/json').ObservedArtifactIdentity>;
    };
    vi.spyOn(svc, 'containerHealth').mockResolvedValue({ kind: 'not_running', detail: 'no containers running for this blueprint' });
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    const result = await BlueprintService.getInstance().checkForDrift(blueprint, node);

    expect(result.kind, 'a stopped container is drift, whatever the marker says').toBe('drifted');
    if (result.kind === 'drifted') {
      expect(result.cause).toBe('container');
      expect(result.repairBlock?.reason, 'but the repair is still not permitted').toBe('evidence_incomplete');
    }
    await tick(blueprint, node);
    expect(deploySpy, 'the repair must not be attempted').not.toHaveBeenCalled();
    expect(deploymentOf(blueprint, node)?.status).toBe('repair_held');
  });

  it('records the hold once and does not repeat it on the next tick', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node, 'enforce', 'stateful');
    const seeded = await seedDeployedGitManaged({ blueprint, node, compose: COMPOSE });
    DatabaseService.getInstance().upsertDeployment({
      blueprint_id: blueprint.id,
      node_id: node.id,
      status: 'active',
      applied_revision: blueprint.revision,
      last_deployed_at: Date.now(),
    });
    stubDriftedRuntime(blueprint, seeded.generationId, seeded.artifactSetId, seeded.rolloutGenerationId);
    const db = DatabaseService.getInstance().getDb();
    const countHolds = (): number => {
      const row = db.prepare(
        `SELECT COUNT(*) AS n FROM gitops_history WHERE application_id = ? AND stage = 'blueprint_repair_held'`,
      ).get(seeded.appId) as { n: number };
      return row.n;
    };

    await tick(blueprint, node);
    expect(countHolds()).toBe(1);
    await tick(blueprint, node);
    await tick(blueprint, node);
    expect(countHolds(), 'a hold that has not changed is not new news').toBe(1);
  });

  it('lets Enforce repair after a drift-mode-only edit, without a new approval', async () => {
    // The whole point of Enforce is that it can act, and the edit that turns it on
    // used to be the one edit guaranteed to stop it: changing the mode opened a
    // rollout candidate, which invalidated the placement approval and superseded
    // the live rollout generation, which held every target with nothing left to
    // advance it. The mode is a policy choice, so it must not mint an intent.
    const node = seedNode();
    const blueprint = seedBlueprint(node, 'suggest');
    const seeded = await seedDeployedGitManaged({ blueprint, node, compose: COMPOSE });
    DatabaseService.getInstance().upsertDeployment({
      blueprint_id: blueprint.id,
      node_id: node.id,
      status: 'active',
      applied_revision: blueprint.revision,
      last_deployed_at: Date.now(),
    });
    const store = GitOpsStore.getInstance();

    const { commitBlueprintUpdate } = await import('../services/gitops/blueprintProducers');
    commitBlueprintUpdate(blueprint.id, { drift_mode: 'enforce' }, 'tester', () => [node.id]);

    // What decides whether Enforce can act is the target's own rollout pointer
    // and that rollout generation still being live. (The application's pointer is
    // written by the authorization transition, not by the update path, so it is
    // not what a mode change can disturb.)
    expect(store.getTarget(seeded.appId, node.id)?.rollout_generation_id)
      .toBe(seeded.rolloutGenerationId);
    expect(
      store.getRolloutGeneration(seeded.rolloutGenerationId)?.superseded_at,
      'a mode change must not supersede the rollout that owns the target',
    ).toBeNull();
    expect(DatabaseService.getInstance().getBlueprint(blueprint.id)?.drift_mode).toBe('enforce');

    // And the mode now works: the drift is repaired on the next tick.
    stubDriftedRuntime(blueprint, seeded.generationId, seeded.artifactSetId, seeded.rolloutGenerationId);
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });
    const current = DatabaseService.getInstance().getBlueprint(blueprint.id)!;

    await tick(current, node);

    expect(deploySpy, 'Enforce repairs once it is switched on').toHaveBeenCalledTimes(1);
    expect(deploymentOf(current, node)?.status).not.toBe('repair_held');
  });

  it('re-checks a held target, so clearing the hold lets a later tick repair it', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node, 'enforce');
    const seeded = await seedDeployedGitManaged({ blueprint, node, compose: COMPOSE });
    DatabaseService.getInstance().upsertDeployment({
      blueprint_id: blueprint.id,
      node_id: node.id,
      status: 'active',
      applied_revision: blueprint.revision,
      last_deployed_at: Date.now(),
    });
    stubDriftedRuntime(blueprint, seeded.generationId, seeded.artifactSetId, seeded.rolloutGenerationId);
    const store = GitOpsStore.getInstance();
    store.upsertTarget({
      ...store.getTarget(seeded.appId, node.id)!,
      connectivity: 'unreachable',
    });
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    await tick(blueprint, node);
    expect(deploySpy).not.toHaveBeenCalled();
    expect(deploymentOf(blueprint, node)?.status).toBe('repair_held');

    // The node comes back. The hold is a state, not a latch.
    store.upsertTarget({
      ...store.getTarget(seeded.appId, node.id)!,
      connectivity: 'reachable',
    });
    await tick(blueprint, node);

    expect(deploySpy, 'a reachable, repairable drift is repaired once the hold clears').toHaveBeenCalledTimes(1);
    // The deploy is mocked, so it does not write the terminal row itself. What
    // matters here is that the target left the held state and entered a repair.
    expect(deploymentOf(blueprint, node)?.status).not.toBe('repair_held');
  });

  it('advances the projection when a hold clears without a repair', async () => {
    // The other way a hold clears: the node comes back and the workload is
    // already correct, so there is nothing to repair. The deployment row must
    // return to active AND the GitOps projection must stop reporting the hold,
    // because the projection reads the latest observation stage. A row that went
    // active while the stage still said "repair held" would leave the Drift
    // surface and the attention queue contradicting the deployment table.
    const node = seedNode();
    const blueprint = seedBlueprint(node, 'enforce');
    const seeded = await seedDeployedGitManaged({ blueprint, node, compose: COMPOSE });
    DatabaseService.getInstance().upsertDeployment({
      blueprint_id: blueprint.id,
      node_id: node.id,
      status: 'active',
      applied_revision: blueprint.revision,
      last_deployed_at: Date.now(),
    });
    stubMatchedRuntime(blueprint, seeded.generationId, seeded.artifactSetId, seeded.rolloutGenerationId);
    const store = GitOpsStore.getInstance();
    store.upsertTarget({
      ...store.getTarget(seeded.appId, node.id)!,
      connectivity: 'unreachable',
    });

    await tick(blueprint, node);
    expect(deploymentOf(blueprint, node)?.status).toBe('repair_held');
    expect(store.getTarget(seeded.appId, node.id)?.latest_stage).toBe('blueprint_repair_held');

    store.upsertTarget({
      ...store.getTarget(seeded.appId, node.id)!,
      connectivity: 'reachable',
    });
    await tick(blueprint, node);

    expect(deploymentOf(blueprint, node)?.status).toBe('active');
    const projected = projectApplication(seeded.appId, false);
    const target = 'targets' in projected ? projected.targets[0] : undefined;
    // Asserted against a literal, and the target is required to exist: an
    // optional chain here would make the whole case pass on a missing target,
    // which is the failure this test exists to catch.
    expect(target, 'the target must be projected, or this case proves nothing').toBeDefined();
    // Asserted on the stage, not only the derived status: the same check also
    // records the observed artifact, which advances the stage on its own, so the
    // derived status alone is identical with and without the clearing
    // observation. The stage is what this commit is actually about.
    expect(store.getTarget(seeded.appId, node.id)?.latest_stage).toBe('blueprint_drift_cleared');
    // A matched drift check is not a health verdict, so it must not read as
    // synced-and-healthy. It reads as deployed with no health claim instead.
    expect(target?.runtime.status).toBe('fully_deployed_health_pending');
  });

  it('alerts and records drift in Suggest mode even when the Blueprint is stateful', async () => {
    // The classification hold is a decision about auto-repair. Suggest is the
    // mode whose whole point is to tell the operator about drift and let them
    // decide, so a stateful Blueprint used to be silently downgraded to a hold
    // that fired no alert at all, which is the opposite of what was asked for.
    const { NotificationService } = await import('../services/NotificationService');
    const alertSpy = vi
      .spyOn(NotificationService.getInstance(), 'dispatchAlert')
      .mockResolvedValue({ persisted: true });
    const node = seedNode();
    const blueprint = seedBlueprint(node, 'suggest', 'stateful');
    const seeded = await seedDeployedGitManaged({ blueprint, node, compose: COMPOSE });
    DatabaseService.getInstance().upsertDeployment({
      blueprint_id: blueprint.id,
      node_id: node.id,
      status: 'active',
      applied_revision: blueprint.revision,
      last_deployed_at: Date.now(),
    });
    stubDriftedRuntime(blueprint, seeded.generationId, seeded.artifactSetId, seeded.rolloutGenerationId);
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    await tick(blueprint, node);

    expect(deploySpy, 'Suggest never auto-fixes').not.toHaveBeenCalled();
    expect(deploymentOf(blueprint, node)?.status, 'the drift is reported, not held').toBe('drifted');
    expect(alertSpy).toHaveBeenCalledWith(
      'warning',
      'blueprint_drift_detected',
      expect.stringContaining('drifted'),
      expect.anything(),
    );
  });

  it('records drift in Observe mode without claiming auto-fix was declined', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node, 'observe', 'stateful');
    const seeded = await seedDeployedGitManaged({ blueprint, node, compose: COMPOSE });
    DatabaseService.getInstance().upsertDeployment({
      blueprint_id: blueprint.id,
      node_id: node.id,
      status: 'active',
      applied_revision: blueprint.revision,
      last_deployed_at: Date.now(),
    });
    stubDriftedRuntime(blueprint, seeded.generationId, seeded.artifactSetId, seeded.rolloutGenerationId);

    await tick(blueprint, node);

    expect(deploymentOf(blueprint, node)?.status).toBe('drifted');
    expect(deploymentOf(blueprint, node)?.drift_summary ?? '').not.toMatch(/auto-fix is declined/i);
  });

  it('never mutates in Observe mode', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node, 'observe');
    const seeded = await seedDeployedGitManaged({ blueprint, node, compose: COMPOSE });
    DatabaseService.getInstance().upsertDeployment({
      blueprint_id: blueprint.id,
      node_id: node.id,
      status: 'active',
      applied_revision: blueprint.revision,
      last_deployed_at: Date.now(),
    });
    stubDriftedRuntime(blueprint, seeded.generationId, seeded.artifactSetId, seeded.rolloutGenerationId);
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    await tick(blueprint, node);

    expect(deploySpy).not.toHaveBeenCalled();
    expect(deploymentOf(blueprint, node)?.status).toBe('drifted');
  });

  it('never mutates in Suggest mode', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node, 'suggest');
    const seeded = await seedDeployedGitManaged({ blueprint, node, compose: COMPOSE });
    DatabaseService.getInstance().upsertDeployment({
      blueprint_id: blueprint.id,
      node_id: node.id,
      status: 'active',
      applied_revision: blueprint.revision,
      last_deployed_at: Date.now(),
    });
    stubDriftedRuntime(blueprint, seeded.generationId, seeded.artifactSetId, seeded.rolloutGenerationId);
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    await tick(blueprint, node);

    expect(deploySpy).not.toHaveBeenCalled();
    expect(deploymentOf(blueprint, node)?.status).toBe('drifted');
  });

  it('keeps the target usable after a restart, because the binding is read from rows', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node, 'enforce');
    const seeded = await seedDeployedGitManaged({ blueprint, node, compose: COMPOSE });
    DatabaseService.getInstance().upsertDeployment({
      blueprint_id: blueprint.id,
      node_id: node.id,
      status: 'active',
      applied_revision: blueprint.revision,
      last_deployed_at: Date.now(),
    });
    stubDriftedRuntime(blueprint, seeded.generationId, seeded.artifactSetId, seeded.rolloutGenerationId);
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    // A restart drops every in-memory cache and rebuilds the singletons from
    // the database. The repair decision has to survive that, because it is
    // derived from persisted rows rather than from process state.
    GitOpsStore.resetForTests();
    await tick(blueprint, node);

    expect(deploySpy).toHaveBeenCalledTimes(1);
    expect(deploySpy.mock.calls[0]?.[0]?.composeContent).toBe(COMPOSE);
  });
});

describe('artifact uncertainty blocks a repair', () => {
  it('holds when the observation is not a comparable identity', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node, 'enforce');
    const seeded = await seedDeployedGitManaged({ blueprint, node, compose: COMPOSE });
    DatabaseService.getInstance().upsertDeployment({
      blueprint_id: blueprint.id,
      node_id: node.id,
      status: 'active',
      applied_revision: blueprint.revision,
      last_deployed_at: Date.now(),
    });
    stubDriftedRuntime(blueprint, seeded.generationId, seeded.artifactSetId, seeded.rolloutGenerationId);
    const svc = BlueprintService.getInstance() as unknown as {
      observeRuntimeIdentity: () => Promise<import('../services/gitops/json').ObservedArtifactIdentity>;
    };
    vi.spyOn(svc, 'observeRuntimeIdentity').mockResolvedValue({
      kind: 'local_build_unverified',
      identity: 'local:img-1',
      observedAt: Date.now(),
    });
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    await tick(blueprint, node);

    expect(deploySpy, 'an unverified local build is uncertainty, not a digest to restore').not.toHaveBeenCalled();
    // Uncertainty is not drift. The row is left as it was rather than marked
    // drifted, because Sencho has not established that anything diverged.
    const deployment = deploymentOf(blueprint, node);
    expect(deployment?.status).not.toBe('drifted');
    expect(deployment?.status).not.toBe('repair_held');
  });

  it('holds when the target\'s expectation no longer matches what the rollout authorized', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node, 'enforce');
    const seeded = await seedDeployedGitManaged({ blueprint, node, compose: COMPOSE });
    const store = GitOpsStore.getInstance();
    // A newer evidence version of the same generation that could not prove every
    // platform. The target now expects it while the rollout still froze the
    // original, so the two disagree and neither can be called current.
    const qualifiedSetId = newGitOpsId();
    store.insertArtifactSet({
      id: qualifiedSetId,
      generation_id: seeded.generationId,
      evidence_version: 2,
      authoritative: 0,
      qualification: 'qualified',
      evidence_json: encodeArtifactEvidenceJson({
        kind: 'qualified',
        identity: `exact:${DIGEST}`,
        services: [{
          ...service(DIGEST),
          platformDigest: null,
          platformVariants: null,
          indexDigest: null,
        }],
      }),
      created_at: Date.now(),
    });
    store.upsertTarget({
      ...store.getTarget(seeded.appId, node.id)!,
      expected_artifact_set_id: qualifiedSetId,
    });
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    const outcome = await BlueprintService.getInstance().enforceDigestRepair(blueprint, node);

    expect(outcome.status).toBe('repair_held');
    expect(outcome.holdReason).toBe('binding_incoherent');
    expect(deploySpy).not.toHaveBeenCalled();
  });

  it('refuses to deploy from an authorized set that has no approved platform digest', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node, 'enforce');
    // The rollout itself froze a qualified set, so the binding is coherent and
    // the refusal has to come from the pin builder rather than from the binding.
    const seeded = await seedDeployedGitManaged({ blueprint, node, compose: COMPOSE, qualified: true });
    expect(seeded.artifactSetId).not.toBeNull();
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    const outcome = await BlueprintService.getInstance().enforceDigestRepair(blueprint, node);

    expect(outcome.status).toBe('failed');
    expect(deploySpy, 'a qualified set has no approved pin for every service, so nothing is deployed').not.toHaveBeenCalled();
  });
});

describe('local and remote targets reach the same decision', () => {
  it('holds both identically, and sends nothing to either', async () => {
    const localNode = seedNode();
    const remoteNode = seedRemoteNode();
    const blueprint = seedBlueprint(localNode, 'enforce');
    const seeded = await seedDeployedGitManaged({
      blueprint, node: localNode, compose: COMPOSE, alsoRequired: [remoteNode],
    });
    const store = GitOpsStore.getInstance();
    // The remote target is in the same frozen rollout and the same held state.
    store.upsertTarget({
      ...emptyTargetRow(seeded.appId, remoteNode.id, Date.now()),
      target_status: 'active',
      desired_generation_id: seeded.generationId,
      applied_generation_id: seeded.generationId,
      expected_artifact_set_id: seeded.artifactSetId,
      latest_artifact_set_id: seeded.artifactSetId,
      rollout_generation_id: seeded.rolloutGenerationId,
      connectivity: 'unreachable',
    });
    store.upsertTarget({
      ...store.getTarget(seeded.appId, localNode.id)!,
      connectivity: 'unreachable',
    });
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    const localOutcome = await BlueprintService.getInstance().enforceDigestRepair(blueprint, localNode);
    const remoteOutcome = await BlueprintService.getInstance().enforceDigestRepair(blueprint, remoteNode);

    expect(localOutcome).toEqual(remoteOutcome);
    expect(localOutcome.status).toBe('repair_held');
    expect(deploySpy, 'a held target is never dispatched, local or remote').not.toHaveBeenCalled();
  });

  it('stamps the same generation evidence into the marker on either transport', async () => {
    const localNode = seedNode();
    const remoteNode = seedRemoteNode();
    const blueprint = seedBlueprint(localNode, 'enforce');
    const seeded = await seedDeployedGitManaged({
      blueprint, node: localNode, compose: COMPOSE, alsoRequired: [remoteNode],
    });
    const store = GitOpsStore.getInstance();
    store.upsertTarget({
      ...emptyTargetRow(seeded.appId, remoteNode.id, Date.now()),
      target_status: 'active',
      desired_generation_id: seeded.generationId,
      applied_generation_id: seeded.generationId,
      expected_artifact_set_id: seeded.artifactSetId,
      latest_artifact_set_id: seeded.artifactSetId,
      rollout_generation_id: seeded.rolloutGenerationId,
    });
    // Capture the serialised marker at each transport seam rather than mocking
    // the decision, so the assertion is about what each target is actually told.
    const localMarkers: string[] = [];
    const remoteMarkers: string[] = [];
    const svc = BlueprintService.getInstance() as unknown as {
      applyLocalUnderLock: (...args: unknown[]) => Promise<{ ran: boolean }>;
      deployRemoteMaterialization: (
        b: Blueprint, n: Node, compose: string, marker: string, pins?: unknown,
      ) => Promise<void>;
    };
    vi.spyOn(svc, 'applyLocalUnderLock').mockImplementation(async (...args: unknown[]) => {
      localMarkers.push(args[3] as string);
      return { ran: true };
    });
    const captureRemoteMarker = async (
      _blueprint: Blueprint,
      _node: Node,
      _compose: string,
      marker: string,
    ): Promise<void> => {
      remoteMarkers.push(marker);
    };
    vi.spyOn(svc, 'deployRemoteMaterialization').mockImplementation(captureRemoteMarker);
    // Two pre-existing gates stand between here and the leaf: the name-conflict
    // ownership probe and the digest-pin capability probe. Both are settled so
    // this test isolates marker parity rather than re-testing them.
    vi.spyOn(BlueprintService.getInstance(), 'hasNameConflict').mockResolvedValue(false);
    vi.spyOn(NodeRegistry.getInstance(), 'probeRemoteMeta').mockReturnValue({
      kind: 'ok',
      meta: { version: '0.98.0', capabilities: ['blueprint-digest-pins-v1'] },
    } as unknown as ReturnType<NodeRegistry['probeRemoteMeta']>);

    const local = await BlueprintService.getInstance().enforceDigestRepair(blueprint, localNode);
    const remote = await BlueprintService.getInstance().enforceDigestRepair(blueprint, remoteNode);

    expect(local.status, `local failed: ${local.error ?? ''}`).toBe('active');
    expect(remote.status, `remote failed: ${remote.error ?? ''}`).toBe('active');
    expect(localMarkers).toHaveLength(1);
    expect(remoteMarkers).toHaveLength(1);
    // The same authority travels to a remote leaf as is written locally, so a
    // drift check on that leaf compares against what the hub resolved. Only the
    // apply timestamp may differ, because the two deploys are separate events.
    const localMarker = JSON.parse(localMarkers[0]) as Record<string, string>;
    const remoteMarker = JSON.parse(remoteMarkers[0]) as Record<string, string>;
    expect({ ...remoteMarker, lastApplied: '' }).toEqual({ ...localMarker, lastApplied: '' });
    expect(localMarker.generationId).toBe(seeded.generationId);
    expect(localMarker.artifactSetId).toBe(seeded.artifactSetId);
    expect(localMarker.rolloutGenerationId).toBe(seeded.rolloutGenerationId);
  });
});

describe('the Inline content path', () => {
  it('holds an Inline Blueprint whose target never acknowledged a generation', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node, 'enforce');
    const store = GitOpsStore.getInstance();
    const appId = newGitOpsId();
    store.insertApplication(blankInlineApplication(appId, blueprint.id, Date.now()));
    store.upsertTarget(emptyTargetRow(appId, node.id, Date.now()));
    const deploySpy = vi
      .spyOn(BlueprintService.getInstance(), 'deployAuthorizedMaterialization')
      .mockResolvedValue({ status: 'active' });

    const outcome = await BlueprintService.getInstance().enforceDigestRepair(blueprint, node);

    expect(outcome.status).toBe('repair_held');
    expect(outcome.holdReason).toBe('evidence_incomplete');
    expect(deploySpy).not.toHaveBeenCalled();
  });

  it('still classifies drift when an Inline target carries a disagreeing rollout generation', async () => {
    // An Inline target can carry a rollout_generation_id that was never the
    // authority for its acknowledged pair, because Inline freezes its own
    // generation per acceptance. Treating the pointer's presence as proof that a
    // rollout governs the target held every such target, and a held target
    // reported no drift at all, so a replaced image on an Inline Blueprint was
    // invisible in every surface.
    const node = seedNode();
    const blueprint = seedBlueprint(node, 'observe');
    const store = GitOpsStore.getInstance();
    const appId = newGitOpsId();
    store.insertApplication(blankInlineApplication(appId, blueprint.id, Date.now()));

    const generationId = newGitOpsId();
    const artifactSetId = newGitOpsId();
    store.insertGeneration({
      ...inlineGenerationFixture(appId, blueprint.id, generationId),
    });
    store.insertArtifactSet({
      id: artifactSetId,
      generation_id: generationId,
      evidence_version: 1,
      authoritative: 0,
      qualification: 'exact',
      evidence_json: encodeArtifactEvidenceJson({
        kind: 'exact',
        identity: `exact:${DIGEST}`,
        services: [service(DIGEST)],
      }),
      created_at: Date.now(),
    });

    // A rollout row naming a different pair entirely, which is the state that
    // used to hold this target.
    const staleRolloutId = newGitOpsId();
    store.insertRolloutGeneration({
      id: staleRolloutId,
      application_id: appId,
      intent_revision_id: newGitOpsId(),
      rollout_candidate_id: newGitOpsId(),
      accepted_generation_id: newGitOpsId(),
      artifact_set_id: newGitOpsId(),
      placement_approval_ref: newGitOpsId(),
      source_acceptance_ref: newGitOpsId(),
      rollout_authorization_ref: newGitOpsId(),
      required_targets_json: encodeGitOpsRequiredTargetsJson([node.id]),
      preflight_fingerprint: null,
      preflight_evidence_json: null,
      rollout_strategy_json: '{}',
      provenance: 'rollout_authorization',
      supersedes_generation_id: null,
      superseded_at: null,
      operation_id: `op-${staleRolloutId}`,
      actor: null,
      trigger: 'test',
      created_at: Date.now(),
    });

    const app = store.getApplication(appId)!;
    app.accepted_generation_id = generationId;
    app.artifact_set_id = artifactSetId;
    app.latest_artifact_set_id = artifactSetId;
    store.writeApplicationPointers(app);
    store.upsertTarget({
      ...emptyTargetRow(appId, node.id, Date.now()),
      target_status: 'active',
      desired_generation_id: generationId,
      applied_generation_id: generationId,
      deployed_generation_id: generationId,
      expected_artifact_set_id: artifactSetId,
      latest_artifact_set_id: artifactSetId,
      rollout_generation_id: staleRolloutId,
    });
    DatabaseService.getInstance().upsertDeployment({
      blueprint_id: blueprint.id,
      node_id: node.id,
      status: 'active',
      applied_revision: blueprint.revision,
      last_deployed_at: Date.now(),
    });
    stubDriftedRuntime(blueprint, generationId, artifactSetId, staleRolloutId);

    const result = await BlueprintService.getInstance().checkForDrift(blueprint, node);

    expect(result.kind, `an Inline target with a stale rollout pointer reported ${result.kind}`).toBe('drifted');
  });

  it('records the running identity even when the repair is held', async () => {
    // A hold refuses to mutate, not to observe. What the node is actually running
    // is the evidence an operator needs when a hold blocks the repair, and it is
    // what the drift surfaces read, so withholding it left the one target that
    // most needs explaining reporting nothing.
    const node = seedNode();
    const blueprint = seedBlueprint(node, 'enforce');
    const seeded = await seedDeployedGitManaged({ blueprint, node, compose: COMPOSE });
    DatabaseService.getInstance().upsertDeployment({
      blueprint_id: blueprint.id,
      node_id: node.id,
      status: 'active',
      applied_revision: blueprint.revision,
      last_deployed_at: Date.now(),
    });
    stubDriftedRuntime(blueprint, seeded.generationId, seeded.artifactSetId, seeded.rolloutGenerationId);
    const store = GitOpsStore.getInstance();
    // Supersede the rollout, which holds the repair, without touching the stub.
    store.markRolloutGenerationSuperseded(seeded.rolloutGenerationId, Date.now());

    const result = await BlueprintService.getInstance().checkForDrift(blueprint, node);

    // A superseded rollout leaves no authority to compare against, so the check
    // cannot classify the artifact question. It is unverified, carrying the
    // block, and the observation it did take is still recorded.
    expect(result.kind).toBe('unverified');
    if (result.kind === 'unverified') {
      expect(result.repairBlock?.reason).toBe('rollout_superseded');
    }
    const observed = store.getTarget(seeded.appId, node.id)?.observed_artifact_identity_json ?? null;
    expect(observed, 'a held target must still report what it is running').not.toBeNull();
    expect(observed).toContain(MOVED_DIGEST);
  });
});
