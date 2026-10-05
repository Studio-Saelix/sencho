/**
 * Git-managed materialization and artifact freeze: promote the accepted
 * generation's staged candidate into its applied directory and resolve the
 * expected artifact set from that materialization, so a second source commit
 * can be authorized instead of stranding the rollout.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { directApplicationFixture } from './helpers/gitopsFixtures';
import type { GitOpsApplicationRow, GitOpsGenerationRow } from '../services/gitops/types';

let tmpDir: string;
let GitOpsStore: typeof import('../services/gitops/store').GitOpsStore;
let emptyTargetRow: typeof import('../services/gitops/store').emptyTargetRow;
let GitOpsTransitions: typeof import('../services/gitops/transitions').GitOpsTransitions;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let materializeAcceptedGeneration: typeof import('../services/gitops/gitManagedMaterialization').materializeAcceptedGeneration;
let freezeGitManagedArtifactSet: typeof import('../services/gitops/gitManagedMaterialization').freezeGitManagedArtifactSet;
let prepareAcceptedGitManagedGeneration: typeof import('../services/gitops/gitManagedMaterialization').prepareAcceptedGitManagedGeneration;
let stackManagedRoot: typeof import('../services/gitops/directApplication').stackManagedRoot;
let projectApplication: typeof import('../services/gitops/derive').projectApplication;
let CANDIDATE_COMPLETE_MARKER: typeof import('../services/GitProjectManifestService').CANDIDATE_COMPLETE_MARKER;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ GitOpsStore, emptyTargetRow } = await import('../services/gitops/store'));
  ({ GitOpsTransitions } = await import('../services/gitops/transitions'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({
    materializeAcceptedGeneration,
    freezeGitManagedArtifactSet,
    prepareAcceptedGitManagedGeneration,
  } = await import('../services/gitops/gitManagedMaterialization'));
  ({ stackManagedRoot } = await import('../services/gitops/directApplication'));
  ({ projectApplication } = await import('../services/gitops/derive'));
  ({ CANDIDATE_COMPLETE_MARKER } = await import('../services/GitProjectManifestService'));
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  vi.restoreAllMocks();
  GitOpsStore.resetForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Seeded {
  applicationId: string;
  generationId: string;
  stackName: string;
  nodeId: number;
  generation: GitOpsGenerationRow;
}

function seedBlueprintApp(): Seeded {
  const store = GitOpsStore.getInstance();
  const nodeId = DatabaseService.getInstance().getDb().prepare(
    `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
     VALUES (?, 'local', 'proxy', '/tmp/compose', 0, 'online', ?)`,
  ).run(`gmm-node-${randomUUID().slice(0, 8)}`, Date.now()).lastInsertRowid as number;

  const applicationId = `app-${randomUUID().slice(0, 8)}`;
  const generationId = `gen-${randomUUID().slice(0, 8)}`;
  const stackName = `src-${applicationId}`;
  const blueprintId = DatabaseService.getInstance().createBlueprint({
    name: `bp-${applicationId}`,
    description: null,
    compose_content: 'services:\n  snapshot:\n    image: nginx:stale\n',
    selector: { type: 'nodes', ids: [nodeId] },
    drift_mode: 'suggest',
    classification: 'stateless',
    classification_reasons: [],
    enabled: true,
    created_by: 'tester',
  }).id;
  DatabaseService.getInstance().updateBlueprintContentOrigin(blueprintId, 'git', applicationId);
  const sha = randomUUID().replace(/-/g, '').padEnd(40, 'a').slice(0, 40);
  const generation: GitOpsGenerationRow = {
    id: generationId,
    application_id: applicationId,
    commit_sha: sha,
    repo_url: 'https://github.com/example/repo.git',
    configured_ref: 'main',
    resolved_ref_kind: 'branch',
    repo_identity_json: '{"host":"github.com","pathname":"/example/repo.git"}',
    manifest_version: 1,
    candidate_dir: `generations/candidate-${sha}`,
    applied_dir: `generations/applied-${sha}-1`,
    expected_invocation_json: '{}',
    materialization_fingerprint: 'b'.repeat(64),
    validation_ok: 1,
    plan_blocked: 0,
    change_plan_fingerprint: null,
    operation_id: `op-${generationId}`,
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
  const app: GitOpsApplicationRow = {
    ...directApplicationFixture(applicationId, stackName),
    target_mode: 'blueprint',
    lifecycle_key: `blueprint:${blueprintId}`,
    stack_name: null,
    configured_source_stack_name: stackName,
    blueprint_id: blueprintId,
    accepted_generation_id: generationId,
  };
  store.insertApplication(app);
  store.insertGeneration(generation);
  store.upsertTarget(emptyTargetRow(applicationId, nodeId, 1));
  return { applicationId, generationId, stackName, nodeId, generation };
}

async function writeCandidate(
  stackName: string,
  generation: GitOpsGenerationRow,
  content: string,
  complete = true,
): Promise<string> {
  const dir = path.join(stackManagedRoot(stackName), generation.candidate_dir);
  await fsPromises.mkdir(dir, { recursive: true });
  await fsPromises.writeFile(path.join(dir, 'compose.yaml'), content, 'utf8');
  if (complete) {
    await fsPromises.writeFile(path.join(dir, CANDIDATE_COMPLETE_MARKER), generation.commit_sha, 'utf8');
  }
  return dir;
}

describe('Git-managed materialization', () => {
  it('promotes the staged candidate into the applied directory and is idempotent', async () => {
    const seeded = seedBlueprintApp();
    const candidateDir = await writeCandidate(
      seeded.stackName,
      seeded.generation,
      'services:\n  web:\n    image: alpine:3.20\n',
    );

    const first = await materializeAcceptedGeneration(seeded.applicationId, seeded.generationId);
    expect(first.status).toBe('materialized');
    if (first.status !== 'missing') {
      expect(first.composeContent).toContain('alpine:3.20');
    }
    await expect(fsPromises.access(candidateDir)).rejects.toBeTruthy();
    await expect(
      fsPromises.access(path.join(stackManagedRoot(seeded.stackName), seeded.generation.applied_dir, 'compose.yaml')),
    ).resolves.toBeUndefined();

    const second = await materializeAcceptedGeneration(seeded.applicationId, seeded.generationId);
    expect(second.status).toBe('already_materialized');
  });

  it('refuses an incomplete candidate and leaves no applied directory', async () => {
    const seeded = seedBlueprintApp();
    await writeCandidate(seeded.stackName, seeded.generation, 'services:\n  web:\n    image: alpine:3.20\n', false);

    const outcome = await materializeAcceptedGeneration(seeded.applicationId, seeded.generationId);
    expect(outcome.status).toBe('missing');
    if (outcome.status === 'missing') {
      expect(outcome.reason).toMatch(/incomplete/i);
    }
    await expect(
      fsPromises.access(path.join(stackManagedRoot(seeded.stackName), seeded.generation.applied_dir)),
    ).rejects.toBeTruthy();
  });

  it('refuses a generation that is not the accepted one', async () => {
    const seeded = seedBlueprintApp();
    await writeCandidate(seeded.stackName, seeded.generation, 'services:\n  web:\n    image: alpine:3.20\n');
    DatabaseService.getInstance().getDb().prepare(
      'UPDATE gitops_applications SET accepted_generation_id = ? WHERE id = ?',
    ).run('someone-else', seeded.applicationId);

    const outcome = await materializeAcceptedGeneration(seeded.applicationId, seeded.generationId);
    expect(outcome.status).toBe('missing');
    if (outcome.status === 'missing') {
      expect(outcome.reason).toMatch(/not the accepted one/i);
    }
  });
});

describe('Git-managed artifact freeze', () => {
  it('resolves the accepted generation from its materialization through the approved-content parser', async () => {
    const seeded = seedBlueprintApp();
    await writeCandidate(seeded.stackName, seeded.generation, 'services:\n  web:\n    image: alpine:3.20\n');
    await materializeAcceptedGeneration(seeded.applicationId, seeded.generationId);

    const resolveSpy = vi.spyOn(
      await import('../services/gitops/artifactResolve'),
      'resolveAndRecordArtifactSet',
    ).mockResolvedValue(undefined);

    const outcome = await freezeGitManagedArtifactSet({
      applicationId: seeded.applicationId,
      generationId: seeded.generationId,
      actor: 'tester',
      trigger: 'test',
      nodeId: seeded.nodeId,
    });

    // The mocked resolver moves no pointer, so the honest outcome is "nothing
    // moved"; the wiring is what this asserts.
    expect(outcome.status).toBe('none');
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    const call = resolveSpy.mock.calls[0][0];
    expect(call.generationId).toBe(seeded.generationId);
    expect(call.nodeId).toBe(seeded.nodeId);
    expect(call.approvedServices?.map((spec) => spec.name)).toEqual(['web']);
    expect(call.approvedServices?.[0]?.declaredImage).toBe('alpine:3.20');
  });

  it('reports resolved and advances the application set when the resolver records evidence', async () => {
    const seeded = seedBlueprintApp();
    await writeCandidate(seeded.stackName, seeded.generation, 'services:\n  web:\n    image: alpine:3.20\n');
    await materializeAcceptedGeneration(seeded.applicationId, seeded.generationId);
    const encodeArtifactEvidenceJson = (await import('../services/gitops/json')).encodeArtifactEvidenceJson;
    vi.spyOn(
      await import('../services/gitops/artifactResolve'),
      'resolveAndRecordArtifactSet',
    ).mockImplementation(async (call) => {
      GitOpsTransitions.getInstance().recordArtifactEvidence({
        applicationId: call.applicationId,
        generationId: call.generationId,
        artifactSetId: 'resolved-artifact-set',
        evidenceVersion: 1,
        qualification: 'exact',
        evidenceJson: encodeArtifactEvidenceJson({ kind: 'exact', identity: 'sha256:deadbeef' }),
        authoritative: 0,
        envelope: { operationId: 'op-test', actor: 'tester', trigger: 'test', at: Date.now() },
      });
    });

    const outcome = await freezeGitManagedArtifactSet({
      applicationId: seeded.applicationId,
      generationId: seeded.generationId,
      actor: 'tester',
      trigger: 'test',
      nodeId: seeded.nodeId,
    });

    expect(outcome.status).toBe('resolved');
    expect(GitOpsStore.getInstance().getApplication(seeded.applicationId)?.artifact_set_id)
      .toBe('resolved-artifact-set');
  });

  it('refuses a generation that materializes more than one compose file', async () => {
    const seeded = seedBlueprintApp();
    await writeCandidate(seeded.stackName, seeded.generation, 'services:\n  web:\n    image: alpine:3.20\n');
    await materializeAcceptedGeneration(seeded.applicationId, seeded.generationId);
    DatabaseService.getInstance().getDb().prepare(
      'UPDATE gitops_generations SET compose_inputs_json = ? WHERE id = ?',
    ).run('{"composeFileOrder":["compose.yaml","override.yaml"]}', seeded.generationId);
    const resolveSpy = vi.spyOn(
      await import('../services/gitops/artifactResolve'),
      'resolveAndRecordArtifactSet',
    ).mockResolvedValue(undefined);

    const outcome = await freezeGitManagedArtifactSet({
      applicationId: seeded.applicationId,
      generationId: seeded.generationId,
      actor: 'tester',
      trigger: 'test',
      nodeId: seeded.nodeId,
    });

    expect(outcome.status).toBe('refused');
    expect(outcome.reason).toMatch(/2 compose files/);
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('refuses unmodellable compose rather than resolving a best-effort parse', async () => {
    const seeded = seedBlueprintApp();
    await writeCandidate(
      seeded.stackName,
      seeded.generation,
      'include:\n  - other.yaml\nservices:\n  web:\n    image: alpine:3.20\n',
    );
    await materializeAcceptedGeneration(seeded.applicationId, seeded.generationId);
    const resolveSpy = vi.spyOn(
      await import('../services/gitops/artifactResolve'),
      'resolveAndRecordArtifactSet',
    ).mockResolvedValue(undefined);

    const outcome = await freezeGitManagedArtifactSet({
      applicationId: seeded.applicationId,
      generationId: seeded.generationId,
      actor: 'tester',
      trigger: 'test',
      nodeId: seeded.nodeId,
    });

    expect(outcome.status).toBe('refused');
    expect(resolveSpy).not.toHaveBeenCalled();

    // The refusal is a permanent statement about this generation's content, so
    // it is persisted where the projection can name the cause instead of
    // leaving only the generic unresolved-artifact refusal on the surface.
    const decode = (await import('../services/gitops/json')).decodeGitOpsEvidenceLimitations;
    const store = GitOpsStore.getInstance();
    const persisted = decode(store.getApplication(seeded.applicationId)!.evidence_limitations_json);
    const entry = persisted.find((item) => item.code === 'git_managed_artifact_unmodellable');
    expect(entry?.detail).toMatch(/include/);
    const projection = projectApplication(seeded.applicationId, false);
    expect(projection.limitations.some((item) => item.code === 'git_managed_artifact_unmodellable')).toBe(true);

    // The same generation re-read with a modellable compose resolves, and the
    // stale reason goes with it.
    await fsPromises.writeFile(
      path.join(stackManagedRoot(seeded.stackName), seeded.generation.applied_dir, 'compose.yaml'),
      'services:\n  web:\n    image: alpine:3.21\n',
      'utf8',
    );
    const encodeArtifactEvidenceJson = (await import('../services/gitops/json')).encodeArtifactEvidenceJson;
    resolveSpy.mockImplementation(async (call) => {
      GitOpsTransitions.getInstance().recordArtifactEvidence({
        applicationId: call.applicationId,
        generationId: call.generationId,
        artifactSetId: 'resolved-after-refusal',
        evidenceVersion: 1,
        qualification: 'exact',
        evidenceJson: encodeArtifactEvidenceJson({ kind: 'exact', identity: 'sha256:deadbeef' }),
        authoritative: 0,
        envelope: { operationId: randomUUID(), actor: 'tester', trigger: 'test', at: Date.now() },
      });
    });
    const resolved = await freezeGitManagedArtifactSet({
      applicationId: seeded.applicationId,
      generationId: seeded.generationId,
      actor: 'tester',
      trigger: 'test',
      nodeId: seeded.nodeId,
    });
    expect(resolved.status).toBe('resolved');
    const cleared = decode(store.getApplication(seeded.applicationId)!.evidence_limitations_json);
    expect(cleared.find((item) => item.code === 'git_managed_artifact_unmodellable')).toBeUndefined();
  });

  it('refuses a candidate path that is not a candidate generation path', async () => {
    const seeded = seedBlueprintApp();
    DatabaseService.getInstance().getDb().prepare(
      'UPDATE gitops_generations SET candidate_dir = ? WHERE id = ?',
    ).run('generations/applied-someone-else-1', seeded.generationId);

    const outcome = await materializeAcceptedGeneration(seeded.applicationId, seeded.generationId);

    expect(outcome.status).toBe('missing');
    if (outcome.status === 'missing') {
      expect(outcome.reason).toMatch(/candidate/);
    }
  });

  it('prepares an accepted generation in one call', async () => {
    const seeded = seedBlueprintApp();
    await writeCandidate(seeded.stackName, seeded.generation, 'services:\n  web:\n    image: alpine:3.20\n');
    const resolveSpy = vi.spyOn(
      await import('../services/gitops/artifactResolve'),
      'resolveAndRecordArtifactSet',
    ).mockResolvedValue(undefined);

    const prepared = await prepareAcceptedGitManagedGeneration({
      applicationId: seeded.applicationId,
      generationId: seeded.generationId,
      actor: 'tester',
      trigger: 'manual',
    });

    expect(prepared.materialized).toBe(true);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });

  it('reports a note instead of throwing when there is nothing to materialize', async () => {
    const seeded = seedBlueprintApp();

    const prepared = await prepareAcceptedGitManagedGeneration({
      applicationId: seeded.applicationId,
      generationId: seeded.generationId,
      actor: 'tester',
      trigger: 'manual',
    });

    expect(prepared.materialized).toBe(false);
    expect(prepared.note).toMatch(/absent or incomplete/i);
  });
});
