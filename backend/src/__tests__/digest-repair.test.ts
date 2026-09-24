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
import {
  decodeArtifactEvidenceJson,
  decodeObservedArtifactIdentity,
  encodeArtifactEvidenceJson,
  encodeObservedArtifactIdentity,
  type ObservedArtifactIdentity,
  type ServiceArtifactEvidence,
} from '../services/gitops/json';
import { buildDigestPinsFromArtifactSet } from '../services/gitops/digestPins';
import { comparableObservationMatches } from '../services/gitops/artifactIdentity';
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
// A different content digest, standing in for a tag that has been moved to
// something new since the approved set was frozen.
const MOVED_DIGEST = `sha256:${'c'.repeat(64)}`;
// The index digest the same moved tag would resolve to. Distinct from INDEX so
// the fixture cannot pass by leaving the index behind.
const MOVED_INDEX = `sha256:${'2'.repeat(64)}`;

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

/**
 * A runtime observation shaped the way the observer builds one: a registry
 * source with the running platform digest, and no platform variants, because
 * production observations never carry them.
 */
function runtimeObservation(platformDigest: string, observedAt: number): ServiceArtifactEvidence {
  return {
    serviceName: 'web',
    authoredRef: 'nginx:latest',
    source: 'registry',
    platform: 'linux/amd64',
    indexDigest: null,
    platformDigest,
    // Production observations never carry platform variants, and record the
    // local repo digests sorted, with the running digest as the candidate.
    platformVariants: null,
    localDigests: [platformDigest],
    buildContextFingerprint: null,
    producedImageId: 'img-1',
    failureClass: null,
    resolvedAt: observedAt,
  };
}

type ObservedWithServices = Extract<
  ObservedArtifactIdentity,
  { kind: 'exact' | 'qualified' | 'stale' | 'local_build_unverified' }
>;

/**
 * The stored observation, narrowed to the kinds that carry per-service evidence.
 * The other kinds mean Sencho could not read an identity at all, which is not
 * the state this test sets up.
 */
function decodeObservedIdentity(raw: string | null): ObservedWithServices | null {
  if (raw === null) return null;
  const observed = decodeObservedArtifactIdentity(raw);
  if (observed.kind === 'unknown' || observed.kind === 'missing' || observed.kind === 'unavailable') {
    return null;
  }
  return observed;
}

/** The per-service evidence the approved artifact set actually stored. */
function approvedServicesOf(artifactSetId: string | null): ServiceArtifactEvidence[] {
  if (artifactSetId === null) throw new Error('the fixture has no approved artifact set');
  const row = GitOpsStore.getInstance().getArtifactSet(artifactSetId);
  if (!row) throw new Error(`artifact set ${artifactSetId} is missing`);
  return decodeArtifactEvidenceJson(row.evidence_json).services ?? [];
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
  vi.restoreAllMocks();
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
  /**
   * A newer candidate set carrying different content, pointed at by
   * latest_artifact_set_id while the approved pointers stay on the original.
   * This is what makes "repair used the approved set" distinguishable from
   * "repair used whatever was resolved most recently".
   */
  newerCandidateServices?: ServiceArtifactEvidence[];
}): { artifactSetId: string | null; generationId: string; newerCandidateSetId: string | null } {
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
  let newerCandidateSetId: string | null = null;
  if (opts.newerCandidateServices) {
    newerCandidateSetId = newGitOpsId();
    store.insertArtifactSet({
      id: newerCandidateSetId,
      generation_id: generationId,
      // A later evidence version of the same generation: the set is unique per
      // generation and evidence version, and re-resolving an unchanged tag is
      // exactly how a moved tag produces a newer candidate.
      evidence_version: 2,
      authoritative: 0,
      qualification: 'exact',
      evidence_json: encodeArtifactEvidenceJson({
        kind: 'exact',
        identity: `exact:${'c'.repeat(64)}`,
        services: opts.newerCandidateServices,
      }),
      created_at: Date.now(),
    });
  }
  const app = store.getApplication(appId)!;
  app.accepted_generation_id = generationId;
  app.artifact_set_id = artifactSetId;
  app.latest_artifact_set_id = newerCandidateSetId ?? artifactSetId;
  store.writeApplicationPointers(app);
  store.upsertTarget({
    ...emptyTargetRow(appId, node.id, Date.now()),
    desired_generation_id: generationId,
    applied_generation_id: generationId,
    deployed_generation_id: generationId,
    expected_artifact_set_id: artifactSetId,
    latest_artifact_set_id: newerCandidateSetId ?? artifactSetId,
    lkg_generation_id: generationId,
    lkg_artifact_set_id: artifactSetId,
  });
  return { artifactSetId, generationId, newerCandidateSetId };
}

/**
 * Record what is actually running on the target, so the test starts from a
 * genuinely drifted state rather than an assumed one.
 */
function seedMovedObservation(appId: string, nodeId: number): void {
  const store = GitOpsStore.getInstance();
  const target = store.getTarget(appId, nodeId)!;
  store.upsertTarget({
    ...target,
    observed_artifact_identity_json: encodeObservedArtifactIdentity({
      kind: 'exact',
      identity: `exact:${MOVED_DIGEST}`,
      observedAt: 2,
      services: [runtimeObservation(MOVED_DIGEST, 2)],
    }),
  });
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
  it('re-pins the approved digest for the node platform and converges on it, never the moved tag', async () => {
    const { bp, node } = seedBlueprint();
    const seeded = seedApp(bp, node, {
      qualification: 'exact',
      services: [registryService()],
      // A newer candidate exists and carries the moved digest. Repair must
      // ignore it: the approved set is the only thing it may restore.
      // The variants move with the digest, because the platform child is what
      // the pin builder reads. A candidate that only changed platformDigest
      // would be indistinguishable from the approved one.
      newerCandidateServices: [
        registryService({
          // A tag that moved changes the index digest too, not only the child.
          indexDigest: MOVED_INDEX,
          platformDigest: MOVED_DIGEST,
          platformVariants: [
            { platform: 'linux/amd64', digest: MOVED_DIGEST },
            { platform: 'linux/arm64', digest: DIGEST_B },
          ],
        }),
      ],
    });
    seedMovedObservation(
      GitOpsStore.getInstance().getLiveBlueprintApplication(bp.id)!.id,
      node.id,
    );
    const service = BlueprintService.getInstance();
    const deploySpy = vi.spyOn(service, 'deployAuthorizedMaterialization').mockResolvedValue({ status: 'active' });

    // The starting state is asserted before repair runs, not only after, so a
    // fixture that quietly stopped seeding the newer candidate or the moved
    // observation cannot pass by leaving the post-state accidentally correct.
    const store = GitOpsStore.getInstance();
    const app = store.getLiveBlueprintApplication(bp.id)!;
    expect(seeded.newerCandidateSetId, 'the fixture has a newer candidate to get wrong').not.toBeNull();
    expect(app.latest_artifact_set_id).toBe(seeded.newerCandidateSetId);
    const targetBefore = store.getTarget(app.id, node.id);
    expect(targetBefore?.latest_artifact_set_id).toBe(seeded.newerCandidateSetId);
    const observedBefore = decodeObservedIdentity(targetBefore?.observed_artifact_identity_json ?? null);
    if (observedBefore === null) throw new Error('the fixture did not record an observation to compare');
    expect(observedBefore.services?.[0]?.platformDigest).toBe(MOVED_DIGEST);
    expect(
      comparableObservationMatches(approvedServicesOf(seeded.artifactSetId), observedBefore),
      'the target must be genuinely drifted before repair, or repair proves nothing',
    ).toBe(false);

    const repaired = await service.enforceDigestRepair(bp, node);

    expect(repaired).toEqual({ status: 'active' });
    expect(deploySpy).toHaveBeenCalledTimes(1);
    // The repair target is the approved child for the platform this node runs,
    // taken from the accepted artifact set. Nothing about the running image can
    // reach this decision, which is what makes a moved tag a drift rather than
    // a new expectation.
    expect(deploySpy.mock.calls[0]?.[0]?.digestPins).toEqual({ web: `nginx@${DIGEST_A}` });

    // Repair restores a state; it does not authorize one. The accepted
    // generation and the artifact set it was qualified against are untouched,
    // so a repaired target still means the generation that was approved, and the
    // pointer that names the most recent resolution still names the newer
    // candidate rather than becoming the approved set.
    const target = store.getTarget(app.id, node.id);
    expect(app.accepted_generation_id).toBe(seeded.generationId);
    expect(app.artifact_set_id).toBe(seeded.artifactSetId);
    expect(app.latest_artifact_set_id).toBe(seeded.newerCandidateSetId);
    expect(target?.expected_artifact_set_id).toBe(seeded.artifactSetId);
    expect(target?.lkg_artifact_set_id).toBe(seeded.artifactSetId);
    expect(target?.latest_artifact_set_id).toBe(seeded.newerCandidateSetId);

    // The target really was drifted when repair ran, and it stays recorded as
    // drifted afterwards. Repair changes what runs, not what was approved, and it
    // does not rewrite the observation into agreement.
    const observedAfter = decodeObservedIdentity(target?.observed_artifact_identity_json ?? null);
    if (observedAfter === null) throw new Error('the fixture did not record an observation to compare');
    expect(observedAfter.services?.[0]?.platformDigest).toBe(MOVED_DIGEST);
    expect(
      comparableObservationMatches(approvedServicesOf(seeded.artifactSetId), observedAfter),
      'a node running the moved digest is drifted, which is why repair ran',
    ).toBe(false);

    // The state repair pins is the one that converges. Once the node runs what was
    // approved, the production comparator the reconciler uses reports matched
    // against the same stored expectation repair left in place.
    expect(
      comparableObservationMatches(approvedServicesOf(seeded.artifactSetId), {
        kind: 'exact',
        identity: 'exact',
        observedAt: 3,
        services: [runtimeObservation(DIGEST_A, 3)],
      }),
      'a node running the approved digest is matched',
    ).toBe(true);
  });

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
