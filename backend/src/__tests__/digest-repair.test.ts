/**
 * Fail-closed digest-repair path: pin map construction, missing/non-comparable
 * sets, and LKG pointer preservation. Positive overlay argument assembly lives
 * in compose-service.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { blankInlineApplication } from '../services/gitops/blueprintProducers';
import { newGitOpsId } from '../services/gitops/directApplication';
import { emptyTargetRow, GitOpsStore } from '../services/gitops/store';
import { encodeArtifactEvidenceJson, type ServiceArtifactEvidence } from '../services/gitops/json';
import { buildDigestPinsFromArtifactSet } from '../services/gitops/digestPins';
import type { Blueprint, Node } from '../services/DatabaseService';

vi.mock('../services/gitops/artifactResolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/gitops/artifactResolve')>();
  return {
    ...actual,
    resolvePlatformLabelForNode: vi.fn(async () => 'linux/amd64'),
  };
});

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const INDEX = `sha256:${'1'.repeat(64)}`;

function registryService(partial: Partial<ServiceArtifactEvidence> = {}): ServiceArtifactEvidence {
  return {
    serviceName: 'web',
    authoredRef: 'nginx:latest',
    source: 'registry',
    platform: 'linux/amd64',
    indexDigest: INDEX,
    platformDigest: DIGEST_A,
    platformVariants: [
      { platform: 'linux/amd64', digest: DIGEST_A },
      { platform: 'linux/arm64', digest: DIGEST_B },
    ],
    localDigests: null,
    buildContextFingerprint: null,
    producedImageId: null,
    failureClass: null,
    resolvedAt: 1,
    ...partial,
  };
}

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
  GitOpsStore.resetForTests();
  const db = DatabaseService.getInstance().getDb();
  db.prepare('DELETE FROM blueprint_deployments').run();
  db.prepare('DELETE FROM blueprints').run();
  db.prepare("DELETE FROM nodes WHERE is_default = 0").run();
  counter += 1;
});

function seedBlueprint(): { bp: Blueprint; node: Node } {
  counter += 1;
  const nodeId = DatabaseService.getInstance().getDb().prepare(
    `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
     VALUES (?, 'local', 'proxy', '/tmp/compose', 0, 'online', ?)`,
  ).run(`digest-repair-${counter}`, Date.now()).lastInsertRowid as number;
  const bp = DatabaseService.getInstance().createBlueprint({
    name: `digest-repair-bp-${counter}`,
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

function seedApp(bp: Blueprint, node: Node, opts: {
  qualification: 'exact' | 'qualified' | 'unresolved' | 'local_build_unverified';
  services?: ServiceArtifactEvidence[];
  omitSet?: boolean;
}): { artifactSetId: string | null; generationId: string } {
  const store = GitOpsStore.getInstance();
  const appId = newGitOpsId();
  const generationId = newGitOpsId();
  const artifactSetId = opts.omitSet ? null : newGitOpsId();
  store.insertApplication(blankInlineApplication(appId, bp.id, Date.now()));
  store.insertGeneration({
    id: generationId,
    application_id: appId,
    commit_sha: 'a'.repeat(40),
    repo_url: `inline://blueprint/${bp.id}`,
    configured_ref: 'inline',
    resolved_ref_kind: null,
    repo_identity_json: JSON.stringify({ host: 'inline', pathname: `/blueprint/${bp.id}` }),
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
  });
  if (artifactSetId) {
    let evidence: string;
    if (opts.qualification === 'exact' || opts.qualification === 'qualified') {
      evidence = encodeArtifactEvidenceJson({
        kind: opts.qualification,
        identity: `exact:${'a'.repeat(64)}`,
        services: opts.services,
      });
    } else if (opts.qualification === 'local_build_unverified') {
      evidence = encodeArtifactEvidenceJson({
        kind: 'local_build_unverified',
        identity: null,
        services: opts.services,
      });
    } else {
      evidence = encodeArtifactEvidenceJson({ kind: 'unresolved', services: opts.services });
    }
    store.insertArtifactSet({
      id: artifactSetId,
      generation_id: generationId,
      evidence_version: 1,
      authoritative: 0,
      qualification: opts.qualification,
      evidence_json: evidence,
      created_at: Date.now(),
    });
  }
  const app = store.getApplication(appId)!;
  app.accepted_generation_id = generationId;
  app.artifact_set_id = artifactSetId;
  app.latest_artifact_set_id = artifactSetId;
  store.writeApplicationPointers(app);
  store.upsertTarget({
    ...emptyTargetRow(appId, node.id, Date.now()),
    desired_generation_id: generationId,
    applied_generation_id: generationId,
    deployed_generation_id: generationId,
    expected_artifact_set_id: artifactSetId,
    latest_artifact_set_id: artifactSetId,
    lkg_generation_id: generationId,
    lkg_artifact_set_id: artifactSetId,
  });
  return { artifactSetId, generationId };
}

describe('buildDigestPinsFromArtifactSet', () => {
  it('pins the repaired target\'s platform child', () => {
    const { bp, node } = seedBlueprint();
    const exact = seedApp(bp, node, { qualification: 'exact', services: [registryService()] });
    expect(buildDigestPinsFromArtifactSet(exact.artifactSetId!, 'linux/arm64')).toEqual({
      web: `nginx@${DIGEST_B}`,
    });
    expect(buildDigestPinsFromArtifactSet(exact.artifactSetId!, 'linux/amd64')).toEqual({
      web: `nginx@${DIGEST_A}`,
    });
    expect(buildDigestPinsFromArtifactSet(exact.artifactSetId!)).toBeNull();
    expect(buildDigestPinsFromArtifactSet(exact.artifactSetId!, 'linux/s390x')).toBeNull();
  });

  it('returns null when the set is missing', () => {
    expect(buildDigestPinsFromArtifactSet('missing-set', 'linux/amd64')).toBeNull();
  });

  it('returns null when the set is not exact or qualified', () => {
    const { bp, node } = seedBlueprint();
    const unresolved = seedApp(bp, node, { qualification: 'unresolved' });
    expect(buildDigestPinsFromArtifactSet(unresolved.artifactSetId!, 'linux/amd64')).toBeNull();
  });

  it('returns null when a service has no platform digest', () => {
    const { bp, node } = seedBlueprint();
    const buildOnly = seedApp(bp, node, {
      qualification: 'local_build_unverified',
      services: [{
        ...registryService({
          source: 'build',
          authoredRef: null,
          platformDigest: null,
          indexDigest: null,
          platformVariants: null,
        }),
        serviceName: 'app',
      }],
    });
    expect(buildDigestPinsFromArtifactSet(buildOnly.artifactSetId!, 'linux/amd64')).toBeNull();
  });
});

describe('enforceDigestRepair', () => {
  it('fails closed without mutating LKG pointers when the set is missing or not comparable', async () => {
    const { bp, node } = seedBlueprint();
    seedApp(bp, node, { omitSet: true, qualification: 'unresolved' });
    const deploySpy = vi.spyOn(BlueprintService.getInstance() as unknown as {
      deployAuthorizedMaterialization: () => Promise<unknown>;
    }, 'deployAuthorizedMaterialization');

    const missing = await BlueprintService.getInstance().enforceDigestRepair(bp, node);
    expect(missing).toEqual({ status: 'failed', error: 'no expected artifact set for digest repair' });

    const { bp: bp2, node: node2 } = seedBlueprint();
    const nonComparable = seedApp(bp2, node2, { qualification: 'unresolved' });
    const failed = await BlueprintService.getInstance().enforceDigestRepair(bp2, node2);
    expect(failed).toEqual({ status: 'failed', error: 'approved digest unavailable for digest repair' });
    expect(deploySpy).not.toHaveBeenCalled();

    const target = GitOpsStore.getInstance().getTarget(
      GitOpsStore.getInstance().getLiveBlueprintApplication(bp2.id)!.id,
      node2.id,
    );
    expect(target?.lkg_generation_id).toBe(nonComparable.generationId);
    expect(target?.lkg_artifact_set_id).toBe(nonComparable.artifactSetId);
  });
});
