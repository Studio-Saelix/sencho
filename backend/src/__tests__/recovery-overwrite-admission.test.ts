/**
 * The overwrite confirmation.
 *
 * The destructive route is only as safe as its admission: the preview must
 * describe the exact state, the token must be bound to it, and every refusal
 * must write no row so the same request can be sent again after a new preview.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { container, fakeDocker, intentLabels, scriptedHelper } from './__helpers__/overwriteFixture';
import { HELPER_LABEL_REPOSITORY } from '../services/recovery/restic/helperRunner';

let recoveryDbModule: typeof import('../services/recovery/recoveryDb');
let identityStore: typeof import('../services/recovery/storageIdentity');
let repositories: typeof import('../services/recovery/repositories');
let points: typeof import('../services/recovery/recoveryPoints');
let intents: typeof import('../services/recovery/restoreIntents');
let fence: typeof import('../services/recovery/restoreFence');
let overwrite: typeof import('../services/recovery/overwriteRestore');

let tmpDir: string;
const ENGINE = 'docker-engine:overwrite-admission';
const VOLUME = 'app_data';

beforeAll(async () => {
  tmpDir = await setupTestDb();
  recoveryDbModule = await import('../services/recovery/recoveryDb');
  identityStore = await import('../services/recovery/storageIdentity');
  repositories = await import('../services/recovery/repositories');
  points = await import('../services/recovery/recoveryPoints');
  intents = await import('../services/recovery/restoreIntents');
  fence = await import('../services/recovery/restoreFence');
  overwrite = await import('../services/recovery/overwriteRestore');
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  const db = recoveryDbModule.recoveryDb();
  for (const table of ['recovery_restore_fence_members', 'recovery_restore_intents', 'recovery_locks',
    'recovery_operations', 'recovery_point_verifications', 'recovery_point_holds', 'recovery_points',
    'recovery_repositories', 'recovery_storage_dependents', 'recovery_storage_identities']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  fence.resetRestoreFenceWarningForTests();
});

interface Seeded {
  pointId: string;
  storageId: string;
  repositoryId: string;
  generationToken: string;
}

/** A current storage, a repository and a complete point of it. */
function seed(input: { volumeName?: string; createdAt: string; token?: { dev: number; ino: number } }): Seeded {
  const volumeName = input.volumeName ?? VOLUME;
  const repository = repositories.RecoveryRepositoryStore.getInstance().register({
    ownerNodeKey: ENGINE,
    kind: 'local_volume',
    locator: 'repo',
    failureDomain: 'same_failure_domain',
  });
  repositories.RecoveryRepositoryStore.getInstance().setActive(repository.id);
  const generationToken = input.token
    ? `${input.createdAt}|${input.token.dev}:${input.token.ino}`
    : `${input.createdAt}|63:42`;
  const storage = identityStore.StorageIdentityStore.getInstance().observe({
    ownerNodeKey: ENGINE,
    kind: 'named_volume',
    locator: volumeName,
    generationToken,
    dependents: [{ stackName: 'stack-dir', serviceName: 'db' }],
  });
  const point = points.RecoveryPointStore.getInstance().begin({
    kind: 'root',
    storageId: storage.id,
    expectedGenerationToken: generationToken,
    repositoryId: repository.id,
    trigger: 'manual',
    actor: 'admin',
    sourceOperationId: 'op-src',
    sourceNodeKey: ENGINE,
    engineId: 'restic',
  });
  points.RecoveryPointStore.getInstance().finalize(point.id, {
    status: 'succeeded',
    evidence: {
      snapshotId: 'snap-1',
      capture: { fileCount: 3, byteCount: 300, skippedCount: 0 },
      exclusions: [],
      consistency: 'crash_consistent_live',
    },
  });
  return { pointId: point.id, storageId: storage.id, repositoryId: repository.id, generationToken };
}

function deps(
  docker: ReturnType<typeof fakeDocker>['docker'],
  helper: ReturnType<typeof scriptedHelper>,
  authorize: { stack?: (name: string) => boolean; global?: () => boolean } = {},
) {
  return {
    nodeId: 1,
    nodeName: 'node-one',
    transport: 'local',
    docker,
    runner: () => helper.helper,
    points: points.RecoveryPointStore.getInstance(),
    repositories: repositories.RecoveryRepositoryStore.getInstance(),
    intents: intents.RestoreIntentStore.getInstance(),
    fence: fence.RestoreFenceStore.getInstance(),
    ownerNodeKey: ENGINE,
    knownStackNames: ['stack-dir'],
    actor: 'admin',
    authorizeStack: authorize.stack ?? (() => true),
    authorizeGlobal: authorize.global ?? (() => true),
  };
}

function mountingContainer(id = 'c1', overrides: Partial<Parameters<typeof container>[0]> = {}) {
  return container({
    Id: id,
    State: 'running',
    Labels: { 'com.docker.compose.project': 'stack-dir', 'com.docker.compose.service': 'db' },
    Mounts: [{ Type: 'volume', Name: VOLUME }],
    ...overrides,
  });
}

describe('preview', () => {
  it('answers every fact and writes nothing', async () => {
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [mountingContainer()] });
    const createdAt = fake.volumes.get(VOLUME)?.createdAt ?? '';
    const seeded = seed({ createdAt });
    const helper = scriptedHelper();
    const preview = await overwrite.previewOverwrite(deps(fake.docker, helper), seeded.pointId);

    expect(preview.point.id).toBe(seeded.pointId);
    expect(preview.node).toEqual({ id: 1, name: 'node-one', transport: 'local' });
    expect(preview.target).toMatchObject({
      volumeName: VOLUME,
      eligible: true,
      ineligibleReason: null,
      generationToken: seeded.generationToken,
    });
    expect(preview.dependents.stacks).toEqual(['stack-dir']);
    expect(preview.dependents.containers).toHaveLength(1);
    expect(preview.dependents.containers[0]).toMatchObject({
      id: 'c1', stack: 'stack-dir', running: true, restartPolicy: { Name: 'always' },
    });
    expect(preview.inUse).toBe(true);
    expect(preview.swap).toMatchObject({ method: 'fenced_rename', atomic: false, supported: true });
    expect(preview.space).toMatchObject({ requiredBytes: 300, freeBytes: 10_000_000, sufficient: true });
    expect(preview.preRestorePoint).toEqual({ required: true, consistency: 'crash_consistent_stopped' });
    expect(preview.warnings.length).toBeGreaterThan(4);
    expect(preview.confirmation.token).toMatch(/^[0-9a-f]{64}$/);

    // No row, no mutation: only the read-only probe ran.
    expect(helper.runs.every((run) => run.profile === 'probe')).toBe(true);
    expect(fake.calls).toEqual([]);
    expect(intents.RestoreIntentStore.getInstance().listUnsettled()).toHaveLength(0);
  });

  it('refuses a caller who may not edit every dependent stack', async () => {
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [mountingContainer()] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '' });
    await expect(overwrite.previewOverwrite(
      deps(fake.docker, scriptedHelper(), { stack: () => false }),
      seeded.pointId,
    )).rejects.toMatchObject({ errorClass: 'permission_denied' });
  });

  it('holds a container no stack owns to the node-wide check', async () => {
    const fake = fakeDocker({
      volumes: [{ name: VOLUME }],
      containers: [mountingContainer('c1', { Labels: {} })],
    });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '' });
    await expect(overwrite.previewOverwrite(
      deps(fake.docker, scriptedHelper(), { global: () => false }),
      seeded.pointId,
    )).rejects.toMatchObject({ errorClass: 'permission_denied' });
  });

  it('reports an ineligible target instead of pretending it can overwrite it', async () => {
    const fake = fakeDocker({
      volumes: [{ name: VOLUME, labels: intentLabels('someone-else') }],
      containers: [mountingContainer()],
    });
    fake.volumes.get(VOLUME)!.labels = { [HELPER_LABEL_REPOSITORY]: 'r1' };
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '' });
    const preview = await overwrite.previewOverwrite(deps(fake.docker, scriptedHelper()), seeded.pointId);
    expect(preview.target.eligible).toBe(false);
    expect(preview.swap.supported).toBe(false);
    expect(preview.swap.reason).toBeTruthy();
  });

  it('reports a volume recreated since the point as a different generation', async () => {
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [mountingContainer()] });
    const seeded = seed({ createdAt: '2020-01-01T00:00:00.000Z' });
    const preview = await overwrite.previewOverwrite(deps(fake.docker, scriptedHelper()), seeded.pointId);
    expect(preview.point.isCurrentGeneration).toBe(false);
  });
});

describe('admission', () => {
  async function confirm(fake: ReturnType<typeof fakeDocker>, pointId: string, overrides: {
    token?: string;
    volumeName?: string;
  } = {}) {
    const helper = scriptedHelper();
    const base = deps(fake.docker, helper);
    const preview = await overwrite.previewOverwrite(base, pointId);
    return overwrite.prepareOverwriteAdmission(base, {
      pointId,
      confirmationToken: overrides.token ?? preview.confirmation.token,
      confirmVolumeName: overrides.volumeName ?? VOLUME,
    });
  }

  it('admits the state the preview described', async () => {
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [mountingContainer()] });
    const createdAt = fake.volumes.get(VOLUME)?.createdAt ?? '';
    const seeded = seed({ createdAt });
    const admitted = await confirm(fake, seeded.pointId);
    expect(admitted.storageKey).toMatch(/^[0-9a-f]{64}$/);
    expect(admitted.fenceMembers).toEqual([expect.objectContaining({ containerId: 'c1', stackName: 'stack-dir' })]);
    expect(admitted.liveGenerationToken).toBe(seeded.generationToken);
    expect(fake.calls).toEqual([]);
  });

  it('refuses a token that does not match the current state, writing nothing', async () => {
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [mountingContainer()] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '' });
    await expect(confirm(fake, seeded.pointId, { token: 'f'.repeat(64) }))
      .rejects.toMatchObject({ errorClass: 'precondition_failed', reason: 'dependents_changed' });
    expect(intents.RestoreIntentStore.getInstance().listUnsettled()).toHaveLength(0);
  });

  it('refuses a token minted before a container appeared', async () => {
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [mountingContainer()] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '' });
    const helper = scriptedHelper();
    const base = deps(fake.docker, helper);
    const preview = await overwrite.previewOverwrite(base, seeded.pointId);
    fake.containers.set('c2', mountingContainer('c2'));
    await expect(overwrite.prepareOverwriteAdmission(base, {
      pointId: seeded.pointId,
      confirmationToken: preview.confirmation.token,
      confirmVolumeName: VOLUME,
    })).rejects.toMatchObject({ errorClass: 'precondition_failed', reason: 'dependents_changed' });
  });

  it('refuses a typed name that is not the target', async () => {
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [mountingContainer()] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '' });
    await expect(confirm(fake, seeded.pointId, { volumeName: 'other_data' }))
      .rejects.toMatchObject({ errorClass: 'invalid_request' });
  });

  it('refuses when free space cannot hold the point', async () => {
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [mountingContainer()] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '' });
    const helper = scriptedHelper({ free: 10 });
    const base = deps(fake.docker, helper);
    const preview = await overwrite.previewOverwrite(base, seeded.pointId);
    expect(preview.space.sufficient).toBe(false);
    await expect(overwrite.prepareOverwriteAdmission(base, {
      pointId: seeded.pointId,
      confirmationToken: preview.confirmation.token,
      confirmVolumeName: VOLUME,
    })).rejects.toMatchObject({ errorClass: 'insufficient_space' });
  });

  it('refuses while another overwrite holds the volume', async () => {
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [mountingContainer()] });
    const createdAt = fake.volumes.get(VOLUME)?.createdAt ?? '';
    const seeded = seed({ createdAt });
    const helper = scriptedHelper();
    const base = deps(fake.docker, helper);
    const preview = await overwrite.previewOverwrite(base, seeded.pointId);
    // A live overwrite intent for the same volume.
    const db = recoveryDbModule.recoveryDb();
    const operationId = randomUUID();
    db.prepare(`INSERT INTO recovery_operations (id, idempotency_key, kind, storage_id, point_id, actor, transport, state, process_epoch, created_at, updated_at)
      VALUES (?, ?, 'restore', ?, ?, 'admin', 'local', 'running', 'e', 1, 1)`)
      .run(operationId, randomUUID(), seeded.storageId, seeded.pointId);
    const intent = intents.RestoreIntentStore.getInstance().recordOverwrite({
      operationId,
      pointId: seeded.pointId,
      targetVolume: VOLUME,
      actor: 'admin',
      processEpoch: 'e',
      stagingVolume: 'sencho-recovery-stage-x',
      expectedGenerationToken: seeded.generationToken,
    });
    intents.RestoreIntentStore.getInstance().advance(intent.id, 'staging');
    intents.RestoreIntentStore.getInstance().advance(intent.id, 'staged_verified');
    intents.RestoreIntentStore.getInstance().advance(intent.id, 'fenced');
    fence.RestoreFenceStore.getInstance().recordMembers(intent.id, [{
      containerId: 'c1', containerName: 'c1', stackName: 'stack-dir', projectName: 'stack-dir',
      restartPolicy: { Name: 'always' }, wasRunning: true,
    }]);
    fence.RestoreFenceStore.getInstance().setFenceState(intent.id, 'held');
    await expect(overwrite.prepareOverwriteAdmission(base, {
      pointId: seeded.pointId,
      confirmationToken: preview.confirmation.token,
      confirmVolumeName: VOLUME,
    })).rejects.toMatchObject({ errorClass: 'lock_held' });
  });

  it('refuses while a settled overwrite still holds its fence', async () => {
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [mountingContainer()] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '' });
    const base = deps(fake.docker, scriptedHelper());
    const preview = await overwrite.previewOverwrite(base, seeded.pointId);
    const db = recoveryDbModule.recoveryDb();
    const operationId = randomUUID();
    db.prepare(`INSERT INTO recovery_operations (id, idempotency_key, kind, storage_id, point_id, actor, transport, state, process_epoch, created_at, updated_at)
      VALUES (?, ?, 'restore', ?, ?, 'admin', 'local', 'partial', 'e', 1, 1)`)
      .run(operationId, randomUUID(), seeded.storageId, seeded.pointId);
    const store = intents.RestoreIntentStore.getInstance();
    const intent = store.recordOverwrite({
      operationId,
      pointId: seeded.pointId,
      targetVolume: VOLUME,
      actor: 'admin',
      processEpoch: 'e',
      stagingVolume: 'sencho-recovery-stage-y',
      expectedGenerationToken: seeded.generationToken,
    });
    for (const phase of ['staging', 'staged_verified', 'fenced', 'protecting', 'materializing', 'swapping', 'swapped', 'committed'] as const) {
      store.advance(intent.id, phase);
    }
    // Committed, but the release failed: the containers are still stopped with
    // their restart policy pinned to `no`.
    store.setFenceState(intent.id, 'release_failed');
    const attempt = () => overwrite.prepareOverwriteAdmission(base, {
      pointId: seeded.pointId,
      confirmationToken: preview.confirmation.token,
      confirmVolumeName: VOLUME,
    });
    await expect(attempt()).rejects.toMatchObject({ errorClass: 'lock_held' });

    // Once the fence is released the volume is free again.
    store.setFenceState(intent.id, 'released');
    await expect(attempt()).resolves.toMatchObject({ storageKey: expect.any(String) });
  });

  it('records the intent, the source hold and the exact fence set together', async () => {
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [mountingContainer()] });
    const createdAt = fake.volumes.get(VOLUME)?.createdAt ?? '';
    const seeded = seed({ createdAt });
    const base = deps(fake.docker, scriptedHelper());
    const admitted = await confirm(fake, seeded.pointId);
    recoveryDbModule.recoveryDb().prepare(`INSERT INTO recovery_operations
      (id, idempotency_key, kind, storage_id, point_id, actor, transport, state, process_epoch, created_at, updated_at)
      VALUES ('op-overwrite', 'key-overwrite', 'restore', ?, ?, 'admin', 'local', 'running', 'e', 1, 1)`)
      .run(seeded.storageId, seeded.pointId);
    const intentId = randomUUID();
    const intent = overwrite.recordOverwriteIntent(base, {
      intentId,
      operationId: 'op-overwrite',
      pointId: admitted.point.id,
      targetVolume: admitted.storage.locator,
      actor: 'admin',
      processEpoch: 'e',
      expectedGenerationToken: admitted.liveGenerationToken,
      fenceMembers: admitted.fenceMembers,
    });
    expect(intent.id).toBe(intentId);
    expect(intent.targetMode).toBe('staged_overwrite');
    expect(intent.stagingVolume).toBe(overwrite.stagingVolumeFor(intentId));
    expect(fence.RestoreFenceStore.getInstance().listMembers(intentId)).toEqual([
      expect.objectContaining({ containerId: 'c1', stackName: 'stack-dir', wasRunning: true }),
    ]);
    expect(points.RecoveryPointStore.getInstance().listHolds(seeded.pointId)).toEqual([
      expect.objectContaining({ holderKind: 'restore_intent', holderRef: intentId }),
    ]);
  });

  it('binds the token to the running state and restart policy the preview showed', async () => {
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [mountingContainer()] });
    const seeded = seed({ createdAt: fake.volumes.get(VOLUME)?.createdAt ?? '' });
    const helper = scriptedHelper();
    const base = deps(fake.docker, helper);
    const preview = await overwrite.previewOverwrite(base, seeded.pointId);
    // The same container stops after the preview: same ids and stack, different
    // promised behavior, so the confirmation must be refused.
    fake.containers.get('c1')!.State = 'exited';
    await expect(overwrite.prepareOverwriteAdmission(base, {
      pointId: seeded.pointId,
      confirmationToken: preview.confirmation.token,
      confirmVolumeName: VOLUME,
    })).rejects.toMatchObject({ errorClass: 'precondition_failed', reason: 'dependents_changed' });
  });

  it('refuses a volume recreated after the point was taken', async () => {
    const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [mountingContainer()] });
    const seeded = seed({ createdAt: '2020-01-01T00:00:00.000Z' });
    await expect(confirm(fake, seeded.pointId))
      .rejects.toMatchObject({ errorClass: 'precondition_failed', reason: 'generation_changed' });
  });
});
