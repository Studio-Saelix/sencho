/**
 * A Blueprint target whose approved image identity could not be resolved at
 * freeze time, and the drift check as the only thing that recovers it.
 *
 * The freeze mints an unresolved expected set and then resolves it. When the
 * registry is unreachable at that moment the target has no approved identity to
 * compare against, and it reports unverified until something else happens to
 * deploy the same revision again. These cover the recovery the drift check
 * makes instead, the throttle that keeps it from asking a dead registry every
 * tick, and the guarantee that uncertainty never becomes convergence.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { newGitOpsId } from '../services/gitops/directApplication';
import { emptyTargetRow, GitOpsStore } from '../services/gitops/store';
import { blankInlineApplication } from '../services/gitops/blueprintProducers';
import { freezeInlineRevisionAfterDeploy } from '../services/gitops/blueprintDeploymentProducers';
import { GitOpsTransitionError } from '../services/gitops/transitions';
import { projectApplication } from '../services/gitops/derive';
import { encodeArtifactEvidenceJson, type ServiceArtifactEvidence } from '../services/gitops/json';
import type { GitOpsGenerationRow } from '../services/gitops/types';
import type { Blueprint, Node } from '../services/DatabaseService';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;

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
  db.prepare('DELETE FROM nodes WHERE is_default = 0').run();
  // Settings live in the shared per-file database, so a test that changes the
  // retry interval would otherwise decide the throttle for every test after it.
  // Reset through the service rather than a DELETE, because it owns the read
  // cache the reader consults.
  DatabaseService.getInstance().updateGlobalSetting('gitops_artifact_retry_interval_mins', '5');
  counter += 1;
});

function seedNode(): Node {
  counter += 1;
  const nodeId = DatabaseService.getInstance().getDb().prepare(
    `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
     VALUES (?, 'local', 'proxy', '/tmp/compose', 0, 'online', ?)`,
  ).run(`freeze-${counter}`, Date.now()).lastInsertRowid as number;
  return DatabaseService.getInstance().getNode(nodeId)!;
}

function seedBlueprint(node: Node): Blueprint {
  counter += 1;
  return DatabaseService.getInstance().createBlueprint({
    name: `freeze-bp-${counter}`,
    description: null,
    compose_content: 'services:\n  web:\n    image: nginx:latest\n',
    selector: { type: 'nodes', ids: [node.id] },
    drift_mode: 'observe',
    classification: 'stateless',
    classification_reasons: [],
    enabled: true,
    created_by: 'tester',
  });
}

function serviceEvidence(digest: string): ServiceArtifactEvidence {
  return {
    serviceName: 'web',
    authoredRef: 'nginx:latest',
    source: 'registry',
    platform: 'linux/amd64',
    indexDigest: digest,
    platformDigest: digest,
    platformVariants: null,
    localDigests: null,
    buildContextFingerprint: null,
    producedImageId: null,
    failureClass: null,
    resolvedAt: 1,
  };
}

function inlineGeneration(
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

/**
 * An Inline Blueprint frozen against a generation whose expected set carries
 * `qualification`, which is the state a failed resolve leaves behind.
 *
 * The deployment row is active and the marker, containers, and observation all
 * read clean, so the only thing standing between this target and a comparison is
 * the identity it was never able to prove.
 */
function seedInlineWithUnresolvedFreeze(args: {
  blueprint: Blueprint;
  node: Node;
  qualification: 'unresolved' | 'unavailable' | 'stale' | 'exact';
  /** Age of the expected set in minutes, which is what the throttle reads. */
  ageMinutes?: number;
  observedDigest?: string;
}): { appId: string; generationId: string; artifactSetId: string } {
  const { blueprint, node } = args;
  const store = GitOpsStore.getInstance();
  const appId = newGitOpsId();
  store.insertApplication(blankInlineApplication(appId, blueprint.id, Date.now()));

  const generationId = newGitOpsId();
  const artifactSetId = newGitOpsId();
  store.insertGeneration(inlineGeneration(appId, blueprint.id, generationId));

  const resolvable = args.qualification === 'exact' || args.qualification === 'stale';
  const evidence = resolvable
    ? { kind: args.qualification as 'exact' | 'stale', identity: `exact:${DIGEST}`, services: [serviceEvidence(DIGEST)] }
    : { kind: args.qualification as 'unresolved' | 'unavailable', services: [] };
  store.insertArtifactSet({
    id: artifactSetId,
    generation_id: generationId,
    evidence_version: 1,
    authoritative: 0,
    qualification: args.qualification,
    evidence_json: encodeArtifactEvidenceJson(evidence),
    created_at: Date.now() - (args.ageMinutes ?? 60) * 60_000,
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
  });
  DatabaseService.getInstance().upsertDeployment({
    blueprint_id: blueprint.id,
    node_id: node.id,
    status: 'active',
    applied_revision: blueprint.revision,
    last_deployed_at: Date.now(),
  });
  stubCleanRuntime(blueprint, args.observedDigest ?? DIGEST);
  return { appId, generationId, artifactSetId };
}

/** Containers up, marker current, the given digest observed. */
function stubCleanRuntime(blueprint: Blueprint, observedDigest: string): void {
  const svc = BlueprintService.getInstance() as unknown as {
    containerHealth: () => Promise<{ kind: 'running' }>;
    observeRuntimeIdentity: () => Promise<import('../services/gitops/json').ObservedArtifactIdentity>;
  };
  vi.spyOn(BlueprintService.getInstance(), 'readMarker').mockResolvedValue({
    blueprintId: blueprint.id,
    revision: blueprint.revision,
    lastApplied: Date.now(),
  });
  vi.spyOn(svc, 'containerHealth').mockResolvedValue({ kind: 'running' });
  vi.spyOn(svc, 'observeRuntimeIdentity').mockResolvedValue({
    kind: 'exact',
    identity: `exact:${observedDigest}`,
    observedAt: Date.now(),
    services: [{
      serviceName: 'web',
      authoredRef: 'nginx:latest',
      source: 'registry',
      platform: 'linux/amd64',
      indexDigest: null,
      platformDigest: observedDigest,
      platformVariants: null,
      localDigests: [observedDigest],
      buildContextFingerprint: null,
      producedImageId: 'img-1',
      failureClass: null,
      resolvedAt: 2,
    }],
  });
}

describe('unresolved artifact freeze', () => {
  it('recovers on the drift check, with no redeploy, and then compares', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node);
    const seeded = seedInlineWithUnresolvedFreeze({ blueprint, node, qualification: 'unresolved' });
    // The registry answers this time, so the recorded set advances the target.
    vi.spyOn(
      await import('../services/gitops/artifactResolve'),
      'resolveAndRecordArtifactSet',
    ).mockImplementation(async (args) => {
      const store = GitOpsStore.getInstance();
      const nextId = newGitOpsId();
      store.insertArtifactSet({
        id: nextId,
        generation_id: args.generationId,
        evidence_version: 2,
        authoritative: 0,
        qualification: 'exact',
        evidence_json: encodeArtifactEvidenceJson({
          kind: 'exact',
          identity: `exact:${DIGEST}`,
          services: [serviceEvidence(DIGEST)],
        }),
        created_at: Date.now(),
      });
      const target = store.getTarget(args.applicationId, args.nodeId)!;
      target.expected_artifact_set_id = nextId;
      target.latest_artifact_set_id = nextId;
      store.upsertTarget(target);
    });

    const result = await BlueprintService.getInstance().checkForDrift(blueprint, node);

    expect(result.kind, 'a resolved expectation that matches is convergence').toBe('matched');
    expect(
      GitOpsStore.getInstance().getTarget(seeded.appId, node.id)?.expected_artifact_set_id,
      'and the target now points at the resolved set',
    ).not.toBe(seeded.artifactSetId);
  });

  it('re-resolves the generation that is already frozen, never minting a new one', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node);
    const seeded = seedInlineWithUnresolvedFreeze({ blueprint, node, qualification: 'unresolved' });
    const resolveSpy = vi.spyOn(
      await import('../services/gitops/artifactResolve'),
      'resolveAndRecordArtifactSet',
    ).mockResolvedValue(undefined);

    await BlueprintService.getInstance().checkForDrift(blueprint, node);

    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy.mock.calls[0][0].generationId).toBe(seeded.generationId);
    expect(
      GitOpsStore.getInstance().getApplication(seeded.appId)?.accepted_generation_id,
      'the accepted generation is the one the retry was given',
    ).toBe(seeded.generationId);
  });

  it('stays unverified, and says so, when the retry cannot resolve either', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node);
    seedInlineWithUnresolvedFreeze({ blueprint, node, qualification: 'unresolved' });
    const resolveSpy = vi.spyOn(
      await import('../services/gitops/artifactResolve'),
      'resolveAndRecordArtifactSet',
    ).mockResolvedValue(undefined);

    const result = await BlueprintService.getInstance().checkForDrift(blueprint, node);

    expect(result.kind).toBe('unverified');
    expect(resolveSpy, 'it did try').toHaveBeenCalledTimes(1);
    expect(
      result.kind === 'unverified' ? result.reason : '',
      'and it names the comparison it could not make',
    ).toContain('not comparable');
  });

  it('reports unverified rather than failing the check when the retry throws', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node);
    seedInlineWithUnresolvedFreeze({ blueprint, node, qualification: 'unresolved' });
    vi.spyOn(
      await import('../services/gitops/artifactResolve'),
      'resolveAndRecordArtifactSet',
    ).mockRejectedValue(new Error('registry exploded'));

    const result = await BlueprintService.getInstance().checkForDrift(blueprint, node);

    expect(result.kind, 'a failed retry leaves exactly the state it found').toBe('unverified');
  });

  it('waits out the configured window before asking the registry again', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node);
    // Recorded a minute ago against a five-minute default, so the window is open.
    const seeded = seedInlineWithUnresolvedFreeze({ blueprint, node, qualification: 'unresolved', ageMinutes: 1 });
    const resolveSpy = vi.spyOn(
      await import('../services/gitops/artifactResolve'),
      'resolveAndRecordArtifactSet',
    ).mockResolvedValue(undefined);

    await BlueprintService.getInstance().checkForDrift(blueprint, node);

    expect(
      resolveSpy,
      'the reconciler runs this every 60s, so a just-failed resolve is not retried at once',
    ).not.toHaveBeenCalled();
    expect(seeded.appId).toBeTruthy();
  });

  it('does not retry while a deploy holds the target', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node);
    seedInlineWithUnresolvedFreeze({ blueprint, node, qualification: 'unresolved' });
    // A deploy resolves the freeze itself and takes this lock, so a concurrent
    // retry would only contend for the same artifact rows.
    expect(BlueprintService.getInstance().tryAcquireAuthorizedDeployLock(blueprint.id, node.id)).toBe(true);
    const resolveSpy = vi.spyOn(
      await import('../services/gitops/artifactResolve'),
      'resolveAndRecordArtifactSet',
    ).mockResolvedValue(undefined);

    const result = await BlueprintService.getInstance().checkForDrift(blueprint, node);

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(result.kind).toBe('unverified');
  });

  it('releases the target lock after retrying, so a later deploy is not locked out', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node);
    seedInlineWithUnresolvedFreeze({ blueprint, node, qualification: 'unresolved' });
    const resolveSpy = vi.spyOn(
      await import('../services/gitops/artifactResolve'),
      'resolveAndRecordArtifactSet',
    ).mockResolvedValue(undefined);

    await BlueprintService.getInstance().checkForDrift(blueprint, node);

    // Asserted first, because a silently skipped retry would leave the lock free
    // and make the assertion below pass for the wrong reason.
    expect(resolveSpy, 'the retry actually ran').toHaveBeenCalledTimes(1);
    expect(
      BlueprintService.getInstance().tryAcquireAuthorizedDeployLock(blueprint.id, node.id),
      'and it must not leave the lock held against the next deploy',
    ).toBe(true);
  });

  it('releases the target lock when the retry throws', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node);
    seedInlineWithUnresolvedFreeze({ blueprint, node, qualification: 'unresolved' });
    vi.spyOn(
      await import('../services/gitops/artifactResolve'),
      'resolveAndRecordArtifactSet',
    ).mockRejectedValue(new Error('registry exploded'));

    await BlueprintService.getInstance().checkForDrift(blueprint, node);

    expect(
      BlueprintService.getInstance().tryAcquireAuthorizedDeployLock(blueprint.id, node.id),
      'a failed retry must not strand the lock either',
    ).toBe(true);
  });

  it('leaves a deploy that already applied alone when the evidence write races', async () => {
    // A freeze whose resolve loses the evidence write race used to record
    // `unavailable` and report success. `resolveAndRecordArtifactSet` now
    // rethrows the transition error so a caller can tell a write race from a
    // failed resolve, and the freeze must not let that escape: the workload is
    // already applied and the generation is already frozen, so a rejected
    // evidence row must not report the deploy as failed.
    const node = seedNode();
    const blueprint = seedBlueprint(node);
    const store = GitOpsStore.getInstance();
    store.insertApplication(blankInlineApplication(newGitOpsId(), blueprint.id, Date.now()));
    vi.spyOn(
      await import('../services/gitops/artifactResolve'),
      'resolveAndRecordArtifactSet',
    ).mockRejectedValue(new GitOpsTransitionError('evidenceVersion must be max+1'));

    await expect(freezeInlineRevisionAfterDeploy({
      blueprintId: blueprint.id,
      nodeId: node.id,
      actor: null,
    })).resolves.toBeUndefined();
  });

  it('still propagates a real resolve failure out of the freeze', async () => {
    // The catch is narrow on purpose: a genuine resolve failure is not a race,
    // and swallowing it would hide a real defect behind a logged line.
    const node = seedNode();
    const blueprint = seedBlueprint(node);
    const store = GitOpsStore.getInstance();
    store.insertApplication(blankInlineApplication(newGitOpsId(), blueprint.id, Date.now()));
    vi.spyOn(
      await import('../services/gitops/artifactResolve'),
      'resolveAndRecordArtifactSet',
    ).mockRejectedValue(new Error('compose render exploded'));

    await expect(freezeInlineRevisionAfterDeploy({
      blueprintId: blueprint.id,
      nodeId: node.id,
      actor: null,
    })).rejects.toThrow('compose render exploded');
  });

  it('re-throttles after a retry that failed, rather than retrying every tick', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node);
    const seeded = seedInlineWithUnresolvedFreeze({ blueprint, node, qualification: 'unresolved', ageMinutes: 60 });
    const store = GitOpsStore.getInstance();

    // A retry that cannot resolve records a fresh non-advancing evidence row.
    // The expected pointer stays on the original freeze, so dating the window
    // from it would leave the gate permanently open and every tick after the
    // first would ask the registry again.
    vi.spyOn(
      await import('../services/gitops/artifactResolve'),
      'resolveAndRecordArtifactSet',
    ).mockImplementation(async (args) => {
      const nextId = newGitOpsId();
      store.insertArtifactSet({
        id: nextId,
        generation_id: args.generationId,
        evidence_version: 2,
        authoritative: 0,
        qualification: 'unavailable',
        evidence_json: encodeArtifactEvidenceJson({ kind: 'unavailable' }),
        created_at: Date.now(),
      });
      const target = store.getTarget(args.applicationId, args.nodeId)!;
      target.latest_artifact_set_id = nextId;
      store.upsertTarget(target);
    });

    const resolveSpy = vi.spyOn(
      await import('../services/gitops/artifactResolve'),
      'resolveAndRecordArtifactSet',
    );

    await BlueprintService.getInstance().checkForDrift(blueprint, node);
    expect(resolveSpy, 'the first attempt is due after the interval').toHaveBeenCalledTimes(1);

    await BlueprintService.getInstance().checkForDrift(blueprint, node);
    expect(
      resolveSpy,
      'and the next tick must not ask again just because the expected pointer did not move',
    ).toHaveBeenCalledTimes(1);

    // The expected pointer is the original freeze throughout, which is exactly
    // the trap this test exists for.
    expect(store.getTarget(seeded.appId, node.id)?.expected_artifact_set_id).toBe(seeded.artifactSetId);
  });

  it('honours a longer interval the operator set', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node);
    DatabaseService.getInstance().updateGlobalSetting('gitops_artifact_retry_interval_mins', '120');
    // Ninety minutes old: past the five-minute default, inside the two hours now set.
    seedInlineWithUnresolvedFreeze({ blueprint, node, qualification: 'unresolved', ageMinutes: 90 });
    const resolveSpy = vi.spyOn(
      await import('../services/gitops/artifactResolve'),
      'resolveAndRecordArtifactSet',
    ).mockResolvedValue(undefined);

    await BlueprintService.getInstance().checkForDrift(blueprint, node);

    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('retries a set the registry could not reach, not only one that never resolved', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node);
    seedInlineWithUnresolvedFreeze({ blueprint, node, qualification: 'unavailable' });
    const resolveSpy = vi.spyOn(
      await import('../services/gitops/artifactResolve'),
      'resolveAndRecordArtifactSet',
    ).mockResolvedValue(undefined);

    await BlueprintService.getInstance().checkForDrift(blueprint, node);

    expect(resolveSpy, 'an unreachable registry is the same transient failure').toHaveBeenCalledTimes(1);
  });

  it('does not re-resolve a stale set, because that would accept a moved tag', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node);
    seedInlineWithUnresolvedFreeze({ blueprint, node, qualification: 'stale' });
    const resolveSpy = vi.spyOn(
      await import('../services/gitops/artifactResolve'),
      'resolveAndRecordArtifactSet',
    ).mockResolvedValue(undefined);

    const result = await BlueprintService.getInstance().checkForDrift(blueprint, node);

    // A stale expectation is not comparable either, so the check cannot make
    // the comparison and says so. What matters here is that it does not go and
    // resolve the moved tag: that resolution is the acceptance a retry must
    // never perform on its own.
    expect(result.kind).toBe('unverified');
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('does not re-resolve an expectation that is already proven', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node);
    seedInlineWithUnresolvedFreeze({ blueprint, node, qualification: 'exact' });
    const resolveSpy = vi.spyOn(
      await import('../services/gitops/artifactResolve'),
      'resolveAndRecordArtifactSet',
    ).mockResolvedValue(undefined);

    const result = await BlueprintService.getInstance().checkForDrift(blueprint, node);

    expect(result.kind).toBe('matched');
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('surfaces the unresolved expectation as a caveat, and drops it once resolved', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node);
    const seeded = seedInlineWithUnresolvedFreeze({ blueprint, node, qualification: 'unresolved' });
    const store = GitOpsStore.getInstance();

    const unresolved = projectApplication(seeded.appId, false);
    expect(
      unresolved.limitations.map((l) => l.code),
      'an operator is told why identity is unverified',
    ).toContain('artifact_expectation_unresolved');

    // A resolve that lands advances the target's expectation, which is the
    // only thing the caveat was reporting.
    const nextId = newGitOpsId();
    store.insertArtifactSet({
      id: nextId,
      generation_id: seeded.generationId,
      evidence_version: 2,
      authoritative: 0,
      qualification: 'exact',
      evidence_json: encodeArtifactEvidenceJson({
        kind: 'exact',
        identity: `exact:${DIGEST}`,
        services: [serviceEvidence(DIGEST)],
      }),
      created_at: Date.now(),
    });
    // Both pointers, because that is what recording evidence does: the
    // application-level expectation and the target's own both advance, and the
    // projection derives a facet for each.
    const target = store.getTarget(seeded.appId, node.id)!;
    target.expected_artifact_set_id = nextId;
    store.upsertTarget(target);
    const app = store.getApplication(seeded.appId)!;
    app.artifact_set_id = nextId;
    store.writeApplicationPointers(app);

    const resolved = projectApplication(seeded.appId, false);
    expect(
      resolved.limitations.map((l) => l.code),
      'and it is gone once the identity is provable, with no write-time clear',
    ).not.toContain('artifact_expectation_unresolved');
  });

  it('keeps a proven expectation that no longer matches as drift, not convergence', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node);
    seedInlineWithUnresolvedFreeze({ blueprint, node, qualification: 'exact', observedDigest: OTHER_DIGEST });

    const result = await BlueprintService.getInstance().checkForDrift(blueprint, node);

    // The counterpart to the unresolved cases above: a target whose identity is
    // proven and disagrees is a real divergence, and the retry path above must
    // not have made this target look healthy by resolving toward what it runs.
    expect(result.kind).toBe('drifted');
    expect(result.kind === 'drifted' ? result.cause : '').toBe('digest');
  });
});

describe('artifact retry interval setting', () => {
  it('defaults to five minutes on a fresh install', () => {
    expect(DatabaseService.getInstance().getGitOpsArtifactRetryIntervalMins()).toBe(5);
  });

  it('reads back what was written', () => {
    DatabaseService.getInstance().updateGlobalSetting('gitops_artifact_retry_interval_mins', '45');
    expect(DatabaseService.getInstance().getGitOpsArtifactRetryIntervalMins()).toBe(45);
  });

  it('falls back to the default rather than to zero, so a broken read still retries', () => {
    // 0 would mean "every tick" here, and the drift check is what recovers a
    // stuck target, so a value that cannot be read has to keep it recoverable.
    DatabaseService.getInstance().updateGlobalSetting('gitops_artifact_retry_interval_mins', '0');
    expect(DatabaseService.getInstance().getGitOpsArtifactRetryIntervalMins()).toBe(5);
  });

  it('treats a future evidence stamp as a recent attempt rather than retrying at once', async () => {
    const node = seedNode();
    const blueprint = seedBlueprint(node);
    const seeded = seedInlineWithUnresolvedFreeze({ blueprint, node, qualification: 'unresolved' });
    const store = GitOpsStore.getInstance();
    // A clock step backwards, or a database restored from a host whose clock ran
    // ahead, leaves the evidence dated in the future. The age is then negative,
    // which fails the window comparison, so the retry waits rather than firing
    // on every tick. That is the direction to be wrong in: a stamp wrongly read
    // as old delays a retry by one interval, one wrongly read as recent cannot
    // hammer a registry that is already struggling.
    const futureId = newGitOpsId();
    store.insertArtifactSet({
      id: futureId,
      generation_id: seeded.generationId,
      evidence_version: 2,
      authoritative: 0,
      qualification: 'unavailable',
      evidence_json: encodeArtifactEvidenceJson({ kind: 'unavailable' }),
      created_at: Date.now() + 60 * 60_000,
    });
    const target = store.getTarget(seeded.appId, node.id)!;
    target.latest_artifact_set_id = futureId;
    store.upsertTarget(target);

    const resolveSpy = vi.spyOn(
      await import('../services/gitops/artifactResolve'),
      'resolveAndRecordArtifactSet',
    ).mockResolvedValue(undefined);
    await BlueprintService.getInstance().checkForDrift(blueprint, node);
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('caps a stored value above the ceiling', () => {
    DatabaseService.getInstance().updateGlobalSetting('gitops_artifact_retry_interval_mins', '99999');
    expect(DatabaseService.getInstance().getGitOpsArtifactRetryIntervalMins()).toBe(1440);
  });
});
