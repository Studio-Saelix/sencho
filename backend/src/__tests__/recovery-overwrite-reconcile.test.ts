/**
 * What a restart settles for a staged overwrite.
 *
 * The direction is decided by the swap journal, never by the phase name alone.
 * A workload restarts only when the volume is proven to hold either the original
 * entries or the complete swapped set; anything the helper cannot prove keeps the
 * fence held and reports `completion_unknown`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { container, fakeDocker, scriptedHelper } from './__helpers__/overwriteFixture';

let recoveryDbModule: typeof import('../services/recovery/recoveryDb');
let identityStore: typeof import('../services/recovery/storageIdentity');
let repositories: typeof import('../services/recovery/repositories');
let points: typeof import('../services/recovery/recoveryPoints');
let intents: typeof import('../services/recovery/restoreIntents');
let fence: typeof import('../services/recovery/restoreFence');
let overwrite: typeof import('../services/recovery/overwriteRestore');
let DockerController: typeof import('../services/DockerController').default;

let tmpDir: string;
const ENGINE = 'docker-engine:overwrite-reconcile';
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
  DockerController = (await import('../services/DockerController')).default;
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
  vi.restoreAllMocks();
  vi.spyOn(DockerController, 'resolveProjectNameMap').mockResolvedValue(new Map());
});

const PHASE_PATH = [
  'staging', 'staged_verified', 'fenced', 'protecting', 'materializing', 'swapping', 'swapped',
] as const;

interface Seeded {
  intentId: string;
  pointId: string;
  generationToken: string;
  containerId: string;
}

async function seed(input: {
  phase: typeof PHASE_PATH[number];
  createdAt: string;
  fenced: boolean;
}): Promise<{ seeded: Seeded; fake: ReturnType<typeof fakeDocker> }> {
  const repository = repositories.RecoveryRepositoryStore.getInstance().register({
    ownerNodeKey: ENGINE,
    kind: 'local_volume',
    locator: 'repo',
    failureDomain: 'same_failure_domain',
  });
  repositories.RecoveryRepositoryStore.getInstance().setActive(repository.id);
  const generationToken = `${input.createdAt}|63:42`;
  const storage = identityStore.StorageIdentityStore.getInstance().observe({
    ownerNodeKey: ENGINE,
    kind: 'named_volume',
    locator: VOLUME,
    generationToken,
    dependents: [],
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
  const member = container({ Id: 'c1', State: 'running', Mounts: [{ Type: 'volume', Name: VOLUME }] });
  const fake = fakeDocker({ volumes: [{ name: VOLUME }], containers: [member] });
  const operationId = randomUUID();
  recoveryDbModule.recoveryDb().prepare(`INSERT INTO recovery_operations (id, idempotency_key, kind, storage_id, point_id, actor, transport, state, process_epoch, created_at, updated_at)
    VALUES (?, ?, 'restore', ?, ?, 'admin', 'local', 'completion_unknown', 'old', 1, 1)`)
    .run(operationId, randomUUID(), storage.id, point.id);
  const intent = intents.RestoreIntentStore.getInstance().recordOverwrite({
    operationId,
    pointId: point.id,
    targetVolume: VOLUME,
    actor: 'admin',
    processEpoch: 'old',
    stagingVolume: overwrite.stagingVolumeFor(randomUUID()),
    expectedGenerationToken: generationToken,
  });
  const staging = overwrite.stagingVolumeFor(intent.id);
  recoveryDbModule.recoveryDb().prepare('UPDATE recovery_restore_intents SET staging_volume = ? WHERE id = ?')
    .run(staging, intent.id);
  fake.volumes.set(staging, { labels: { 'dev.sencho.recovery.restore-intent': intent.id }, createdAt: input.createdAt });
  points.RecoveryPointStore.getInstance().addHold({ pointId: point.id, holderKind: 'restore_intent', holderRef: intent.id });
  fence.RestoreFenceStore.getInstance().recordMembers(intent.id, [{
    containerId: 'c1',
    containerName: 'stack-dir-db-1',
    stackName: 'stack-dir',
    projectName: 'stack-dir',
    restartPolicy: { Name: 'always' },
    wasRunning: true,
  }]);
  if (input.fenced) {
    await fence.applyRestoreFence(intent.id, fake.docker, fence.RestoreFenceStore.getInstance().listMembers(intent.id));
  }
  const store = intents.RestoreIntentStore.getInstance();
  for (const step of PHASE_PATH) {
    store.advance(intent.id, step);
    if (step === input.phase) break;
  }
  return { seeded: { intentId: intent.id, pointId: point.id, generationToken, containerId: 'c1' }, fake };
}

function deps(fake: ReturnType<typeof fakeDocker>, helper: ReturnType<typeof scriptedHelper>) {
  return {
    nodeId: 1,
    nodeName: 'node-one',
    transport: 'local',
    docker: fake.docker,
    runner: () => helper.helper,
    points: points.RecoveryPointStore.getInstance(),
    repositories: repositories.RecoveryRepositoryStore.getInstance(),
    intents: intents.RestoreIntentStore.getInstance(),
    fence: fence.RestoreFenceStore.getInstance(),
    ownerNodeKey: ENGINE,
    knownStackNames: [],
    actor: 'system:restore-reconcile',
    authorizeStack: () => true,
    authorizeGlobal: () => true,
  };
}

const answers = (overrides: Array<{ action: string; exitCode: number; status?: string }> = []) => scriptedHelper({
  swapAnswers: [
    { action: 'rollback', exitCode: 0, status: 'rolled_back' },
    { action: 'status', exitCode: 0, status: 'swapped' },
    { action: 'commit', exitCode: 0, status: 'swapped' },
    { action: 'cleanup', exitCode: 0, status: 'cleaned' },
    ...overrides,
  ],
});

describe('reconciliation before the swap', () => {
  for (const phase of ['staging', 'staged_verified'] as const) {
    it(`rolls ${phase} back without touching a container`, async () => {
      const { seeded, fake } = await seed({ phase, createdAt: new Date().toISOString(), fenced: false });
      const helper = answers();
      const outcome = await overwrite.reconcileOverwriteIntent(
        deps(fake, helper), intents.RestoreIntentStore.getInstance().get(seeded.intentId)!,
      );
      expect(outcome).toBe('rolled_back');
      expect(fake.calls.filter((call) => call.startsWith('stop:') || call.startsWith('update:'))).toEqual([]);
      expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('rolled_back');
      expect(points.RecoveryPointStore.getInstance().listHolds(seeded.pointId)).toEqual([]);
    });
  }

  for (const phase of ['fenced', 'protecting', 'materializing'] as const) {
    it(`rolls ${phase} back, releases the fence and restarts the workload`, async () => {
      const { seeded, fake } = await seed({ phase, createdAt: new Date().toISOString(), fenced: true });
      const helper = answers();
      const outcome = await overwrite.reconcileOverwriteIntent(
        deps(fake, helper), intents.RestoreIntentStore.getInstance().get(seeded.intentId)!,
      );
      expect(outcome).toBe('rolled_back');
      expect(fake.containers.get('c1')?.State).toBe('running');
      expect(fake.containers.get('c1')?.HostConfig.RestartPolicy).toEqual({ Name: 'always' });
      expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.fenceState).toBe('released');
    });
  }
});

describe('reconciliation at the journal', () => {
  for (const status of ['planned', 'moving_originals', 'moving_incoming'] as const) {
    it(`rolls back when the journal says ${status}`, async () => {
      const { seeded, fake } = await seed({ phase: 'swapping', createdAt: new Date().toISOString(), fenced: true });
      // The status answer comes first in this script.
      const helper = scriptedHelper({
        swapAnswers: [
          { action: 'status', exitCode: 0, status },
          { action: 'rollback', exitCode: 0, status: 'rolled_back' },
        ],
      });
      const outcome = await overwrite.reconcileOverwriteIntent(
        deps(fake, helper), intents.RestoreIntentStore.getInstance().get(seeded.intentId)!,
      );
      expect(outcome).toBe('rolled_back');
      expect(fake.containers.get('c1')?.State).toBe('running');
    });
  }

  it('rolls forward when the journal says the swap committed', async () => {
    for (const phase of ['swapping', 'swapped'] as const) {
      const { seeded, fake } = await seed({ phase, createdAt: new Date().toISOString(), fenced: true });
      const helper = answers();
      const outcome = await overwrite.reconcileOverwriteIntent(
        deps(fake, helper), intents.RestoreIntentStore.getInstance().get(seeded.intentId)!,
      );
      expect(outcome).toBe('committed');
      const intent = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
      expect(intent?.phase).toBe('committed');
      expect(intent?.fenceState).toBe('released');
      expect(points.RecoveryPointStore.getInstance().listHolds(seeded.pointId)).toEqual([]);
      expect(fake.containers.get('c1')?.State).toBe('running');
    }
  });

  it('is idempotent: a second run changes nothing', async () => {
    const { seeded, fake } = await seed({ phase: 'swapping', createdAt: new Date().toISOString(), fenced: true });
    const helper = answers();
    const first = await overwrite.reconcileOverwriteIntent(
      deps(fake, helper), intents.RestoreIntentStore.getInstance().get(seeded.intentId)!,
    );
    const callsAfterFirst = [...fake.calls];
    const second = await overwrite.reconcileOverwriteIntent(
      deps(fake, helper), intents.RestoreIntentStore.getInstance().get(seeded.intentId)!,
    );
    expect(first).toBe('committed');
    expect(second).toBe('committed');
    expect(fake.calls).toEqual(callsAfterFirst);
  });

  it('keeps the fence held and reports unknown when the journal is inconsistent', async () => {
    const { seeded, fake } = await seed({ phase: 'swapping', createdAt: new Date().toISOString(), fenced: true });
    const helper = scriptedHelper({
      swapAnswers: [{ action: 'status', exitCode: 0, status: 'inconsistent' }],
    });
    const outcome = await overwrite.reconcileOverwriteIntent(
      deps(fake, helper), intents.RestoreIntentStore.getInstance().get(seeded.intentId)!,
    );
    expect(outcome).toBe('unknown');
    const intent = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(intent?.phase).toBe('completion_unknown');
    expect(intent?.fenceState).toBe('held');
    expect(fence.RestoreFenceStore.getInstance().isVolumeFenced(VOLUME)).toBe(true);
    expect(fake.calls).not.toContain('start:c1');
    expect(points.RecoveryPointStore.getInstance().listHolds(seeded.pointId)).toHaveLength(1);
  });

  it('keeps the fence held when the helper cannot answer at all', async () => {
    const { seeded, fake } = await seed({ phase: 'swapping', createdAt: new Date().toISOString(), fenced: true });
    const helper = scriptedHelper({ swapAnswers: [] });
    const outcome = await overwrite.reconcileOverwriteIntent(
      deps(fake, helper), intents.RestoreIntentStore.getInstance().get(seeded.intentId)!,
    );
    expect(outcome).toBe('unknown');
    expect(fake.calls).not.toContain('start:c1');
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('completion_unknown');
  });
});

describe('the resolve route decisions', () => {
  it('retries the reconciler and reaches the same answer', async () => {
    const { seeded, fake } = await seed({ phase: 'fenced', createdAt: new Date().toISOString(), fenced: true });
    const helper = answers();
    const result = await overwrite.resolveOverwriteIntent(deps(fake, helper), {
      intentId: seeded.intentId,
      action: 'retry',
    });
    expect(result.outcome).toBe('rolled_back');
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('rolled_back');
  });

  it('releases the fence without starting anything, and leaves the state unknown', async () => {
    const { seeded, fake } = await seed({ phase: 'swapping', createdAt: new Date().toISOString(), fenced: true });
    intents.RestoreIntentStore.getInstance().advance(seeded.intentId, 'completion_unknown', { outcomeClass: 'identity_unknown' });
    const helper = scriptedHelper({ swapAnswers: [{ action: 'status', exitCode: 1 }] });
    const result = await overwrite.resolveOverwriteIntent(deps(fake, helper), {
      intentId: seeded.intentId,
      action: 'release_fence',
    });
    expect(result.outcome).toBe('fence_released');
    expect(fake.calls).not.toContain('start:c1');
    expect(fake.containers.get('c1')?.HostConfig.RestartPolicy).toEqual({ Name: 'always' });
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('completion_unknown');
    // The workloads may be started by the operator, so the fence must not block them.
    expect(fence.RestoreFenceStore.getInstance().isVolumeFenced(VOLUME)).toBe(false);
    expect(fake.containers.get('c1')?.State).toBe('exited');
  });

  it('refuses to resolve a committed intent', async () => {
    const { seeded, fake } = await seed({ phase: 'swapped', createdAt: new Date().toISOString(), fenced: true });
    intents.RestoreIntentStore.getInstance().advance(seeded.intentId, 'committed');
    await expect(overwrite.resolveOverwriteIntent(deps(fake, answers()), {
      intentId: seeded.intentId,
      action: 'release_fence',
    })).rejects.toMatchObject({ errorClass: 'invalid_request' });
  });
});

describe('startup reconciliation', () => {
  it('settles every unsettled overwrite and reports the counts', async () => {
    const { fake } = await seed({ phase: 'staged_verified', createdAt: new Date().toISOString(), fenced: false });
    const helper = answers();
    const result = await overwrite.reconcileOverwriteIntentsAtStartup(deps(fake, helper));
    expect(result.rolledBack).toBe(1);
    expect(intents.RestoreIntentStore.getInstance().listUnsettled('staged_overwrite')).toHaveLength(0);
  });
});
