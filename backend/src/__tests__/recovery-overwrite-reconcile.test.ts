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
let operationStore: typeof import('../services/recovery/operations');
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
  operationStore = await import('../services/recovery/operations');
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
  operationId: string;
  storageKey: string;
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
  // What boot reconciliation leaves for a restore whose process died: the operation
  // parked as interrupted, and the storage it held turned stale.
  recoveryDbModule.recoveryDb().prepare("UPDATE recovery_operations SET error_class = 'interrupted' WHERE id = ?").run(operationId);
  recoveryDbModule.recoveryDb().prepare(`INSERT OR IGNORE INTO recovery_locks (scope, resource_key, owner_operation_id, process_epoch, acquired_at, stale_since)
    VALUES ('storage', ?, ?, 'old', 1, 2)`).run(storage.storageKey, operationId);
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
  return { seeded: { intentId: intent.id, pointId: point.id, generationToken, containerId: 'c1', operationId, storageKey: storage.storageKey }, fake };
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

  it('finishes a committed swap whose fence release failed, with the journal already cleaned', async () => {
    const { seeded, fake } = await seed({ phase: 'swapped', createdAt: new Date().toISOString(), fenced: true });
    intents.RestoreIntentStore.getInstance().setFenceState(seeded.intentId, 'release_failed');
    // Cleanup ran and removed the work directory, so the helper answers `absent`.
    const helper = scriptedHelper({ swapAnswers: [{ action: 'status', exitCode: 0, status: 'absent' }] });
    const outcome = await overwrite.reconcileOverwriteIntent(
      deps(fake, helper), intents.RestoreIntentStore.getInstance().get(seeded.intentId)!,
    );
    expect(outcome).toBe('committed');
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('committed');
    expect(fence.RestoreFenceStore.getInstance().isVolumeFenced(VOLUME)).toBe(false);
    expect(fake.containers.get('c1')?.State).toBe('running');
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

  it('removes the work directory before it calls a journal-proven swap committed', async () => {
    const { seeded, fake } = await seed({ phase: 'swapped', createdAt: new Date().toISOString(), fenced: true });
    const helper = answers();
    const result = await overwrite.resolveOverwriteIntent(deps(fake, helper), {
      intentId: seeded.intentId,
      action: 'release_fence',
    });
    expect(result.outcome).toBe('committed');
    expect(helper.runs.filter((run) => run.profile === 'swap').map((run) => run.cmd[2])).toEqual(['status', 'cleanup']);
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('committed');
  });

  it('keeps the intent open when the clean-up cannot run, so a later pass removes the copy', async () => {
    const { seeded, fake } = await seed({ phase: 'swapped', createdAt: new Date().toISOString(), fenced: true });
    const failingHelper = scriptedHelper({
      swapAnswers: [
        { action: 'status', exitCode: 0, status: 'swapped' },
        { action: 'cleanup', exitCode: 1, stderr: 'helper image missing' },
      ],
    });
    const result = await overwrite.resolveOverwriteIntent(deps(fake, failingHelper), {
      intentId: seeded.intentId,
      action: 'release_fence',
    });
    // The operator's choice to release the fence stands.
    expect(result.outcome).toBe('fence_released');
    expect(fence.RestoreFenceStore.getInstance().isVolumeFenced(VOLUME)).toBe(false);
    // The original data is still in the volume, so the intent is not terminal.
    const open = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(open?.phase).toBe('swapped');
    expect(open?.outcomeClass).toBe('cleanup_failed');
    expect(intents.RestoreIntentStore.getInstance().listUnsettled('staged_overwrite').map((i) => i.id)).toContain(seeded.intentId);
    expect(fence.RestoreFenceStore.getInstance().liveIntentForVolume(VOLUME)).toBe(seeded.intentId);

    // The next boot (or a retry) finishes it.
    const retryHelper = answers();
    const settled = await overwrite.resolveOverwriteIntent(deps(fake, retryHelper), {
      intentId: seeded.intentId,
      action: 'retry',
    });
    expect(settled.outcome).toBe('committed');
    expect(retryHelper.runs.filter((run) => run.profile === 'swap').map((run) => run.cmd[2])).toContain('cleanup');
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('committed');
  });

  it('refuses a second release_fence after a failed clean-up and points at retry', async () => {
    const { seeded, fake } = await seed({ phase: 'swapped', createdAt: new Date().toISOString(), fenced: true });
    const failing = scriptedHelper({
      swapAnswers: [
        { action: 'status', exitCode: 0, status: 'swapped' },
        { action: 'cleanup', exitCode: 1, stderr: 'helper image missing' },
      ],
    });
    await overwrite.resolveOverwriteIntent(deps(fake, failing), { intentId: seeded.intentId, action: 'release_fence' });
    await expect(overwrite.resolveOverwriteIntent(deps(fake, failing), {
      intentId: seeded.intentId,
      action: 'release_fence',
    })).rejects.toMatchObject({ errorClass: 'invalid_request', reason: 'fence_released', detail: expect.stringContaining('Retry') });
  });

  it('finishes a failed clean-up at the next boot without touching a container or the volume root', async () => {
    const { seeded, fake } = await seed({ phase: 'swapped', createdAt: new Date().toISOString(), fenced: true });
    const failing = scriptedHelper({
      swapAnswers: [
        { action: 'status', exitCode: 0, status: 'swapped' },
        { action: 'cleanup', exitCode: 1, stderr: 'helper image missing' },
      ],
    });
    await overwrite.resolveOverwriteIntent(deps(fake, failing), { intentId: seeded.intentId, action: 'release_fence' });
    const callsBefore = fake.calls.length;
    const boot = answers();
    const result = await overwrite.reconcileOverwriteIntentsAtStartup(deps(fake, boot));
    expect(result.committed).toBe(1);
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('committed');
    expect(boot.runs.map((run) => run.cmd[2])).not.toContain('rollback');
    expect(fake.calls.slice(callsBefore).filter((call) => call.startsWith('start:') || call.startsWith('stop:'))).toEqual([]);
  });

  it('leaves the originals to a retry when the journal says swapped but the swap had not advanced', async () => {
    const { seeded, fake } = await seed({ phase: 'swapping', createdAt: new Date().toISOString(), fenced: true });
    const helper = answers();
    const result = await overwrite.resolveOverwriteIntent(deps(fake, helper), {
      intentId: seeded.intentId,
      action: 'release_fence',
    });
    // Only a `swapped` intent is cleaned up here; `swapping` is parked for a retry.
    expect(result.outcome).toBe('fence_released');
    expect(helper.runs.filter((run) => run.profile === 'swap').map((run) => run.cmd[2])).toEqual(['status']);
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('completion_unknown');
    const retry = answers();
    const settled = await overwrite.resolveOverwriteIntent(deps(fake, retry), { intentId: seeded.intentId, action: 'retry' });
    expect(settled.outcome).toBe('committed');
    expect(retry.runs.filter((run) => run.profile === 'swap').map((run) => run.cmd[2])).toEqual(['status', 'commit', 'cleanup']);
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

describe('a fence that outlived its intent', () => {
  it('is released at startup even when the intent is terminal', async () => {
    const { seeded, fake } = await seed({ phase: 'swapped', createdAt: new Date().toISOString(), fenced: true });
    intents.RestoreIntentStore.getInstance().advance(seeded.intentId, 'committed');
    // A release that failed after the commit left the fence held.
    intents.RestoreIntentStore.getInstance().setFenceState(seeded.intentId, 'held');
    expect(fence.RestoreFenceStore.getInstance().isVolumeFenced(VOLUME)).toBe(true);
    await overwrite.reconcileOverwriteIntentsAtStartup(deps(fake, answers()));
    expect(fence.RestoreFenceStore.getInstance().isVolumeFenced(VOLUME)).toBe(false);
    expect(fake.containers.get('c1')?.State).toBe('running');
  });

  it('can be released by the resolve route after the intent settled', async () => {
    const { seeded, fake } = await seed({ phase: 'swapped', createdAt: new Date().toISOString(), fenced: true });
    intents.RestoreIntentStore.getInstance().advance(seeded.intentId, 'committed');
    intents.RestoreIntentStore.getInstance().setFenceState(seeded.intentId, 'release_failed');
    const result = await overwrite.resolveOverwriteIntent(deps(fake, answers()), {
      intentId: seeded.intentId,
      action: 'retry',
    });
    expect(result.outcome).toBe('committed');
    expect(fence.RestoreFenceStore.getInstance().isVolumeFenced(VOLUME)).toBe(false);
  });
});

describe('startup reconciliation', () => {
  it('counts a parked restore whose fence it keeps held', async () => {
    const { seeded, fake } = await seed({ phase: 'swapping', createdAt: new Date().toISOString(), fenced: true });
    intents.RestoreIntentStore.getInstance().advance(seeded.intentId, 'completion_unknown', { outcomeClass: 'identity_unknown' });
    const result = await overwrite.reconcileOverwriteIntentsAtStartup(deps(fake, answers()));
    expect(result).toEqual({ rolledBack: 0, committed: 0, unknown: 1 });
    expect(fence.RestoreFenceStore.getInstance().isVolumeFenced(VOLUME)).toBe(true);
    expect(fake.calls).not.toContain('start:c1');
  });

  it('counts a restore it settled but could not release once, as settled', async () => {
    const { seeded, fake } = await seed({ phase: 'fenced', createdAt: new Date().toISOString(), fenced: true });
    fake.failOn = (call) => (call === 'update:c1' ? new Error('daemon refused') : null);
    const result = await overwrite.reconcileOverwriteIntentsAtStartup(deps(fake, answers()));
    const settled = intents.RestoreIntentStore.getInstance().get(seeded.intentId);
    expect(settled?.phase).toBe('rolled_back');
    expect(settled?.outcomeClass).toBe('fence_unavailable');
    expect(result).toEqual({ rolledBack: 1, committed: 0, unknown: 0 });
  });

  it('counts a restore it just parked once, not once per pass', async () => {
    const { seeded, fake } = await seed({ phase: 'swapping', createdAt: new Date().toISOString(), fenced: true });
    const helper = scriptedHelper({ swapAnswers: [{ action: 'status', exitCode: 0, status: 'inconsistent' }] });
    const result = await overwrite.reconcileOverwriteIntentsAtStartup(deps(fake, helper));
    expect(result.unknown).toBe(1);
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('completion_unknown');
    expect(fence.RestoreFenceStore.getInstance().isVolumeFenced(VOLUME)).toBe(true);
  });

  it('settles every unsettled overwrite and reports the counts', async () => {
    const { fake } = await seed({ phase: 'staged_verified', createdAt: new Date().toISOString(), fenced: false });
    const helper = answers();
    const result = await overwrite.reconcileOverwriteIntentsAtStartup(deps(fake, helper));
    expect(result.rolledBack).toBe(1);
    expect(intents.RestoreIntentStore.getInstance().listUnsettled('staged_overwrite')).toHaveLength(0);
  });
});

describe('the operation of a reconciled overwrite', () => {
  const settle = (intentId?: string) => overwrite.settleInterruptedOverwriteOperations(
    intents.RestoreIntentStore.getInstance(), operationStore.RecoveryOperationStore.getInstance(), intentId,
  );
  const operation = (id: string) => operationStore.RecoveryOperationStore.getInstance().get(id);
  const lock = (key: string) => operationStore.RecoveryOperationStore.getInstance().getLock('storage', key);

  it('reads failed/interrupted and frees the storage once startup proves the volume original', async () => {
    const { seeded, fake } = await seed({ phase: 'swapping', createdAt: new Date().toISOString(), fenced: true });
    // The journal says the swap never committed.
    const helper = scriptedHelper({ swapAnswers: [
      { action: 'status', exitCode: 0, status: 'planned' },
      { action: 'rollback', exitCode: 0, status: 'rolled_back' },
    ] });
    await overwrite.reconcileOverwriteIntentsAtStartup(deps(fake, helper));
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('rolled_back');

    expect(settle()).toBe(1);
    expect(operation(seeded.operationId)).toMatchObject({ state: 'failed', errorClass: 'interrupted' });
    expect(lock(seeded.storageKey)).toBeNull();
  });

  it('reads succeeded and frees the storage once startup rolls the swap forward', async () => {
    const { seeded, fake } = await seed({ phase: 'swapping', createdAt: new Date().toISOString(), fenced: true });
    await overwrite.reconcileOverwriteIntentsAtStartup(deps(fake, answers()));
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('committed');

    settle();
    expect(operation(seeded.operationId)).toMatchObject({ state: 'succeeded', errorClass: null });
    expect(lock(seeded.storageKey)).toBeNull();
  });

  it('settles the operation of a committed swap whose journal was already cleaned', async () => {
    const { seeded, fake } = await seed({ phase: 'swapped', createdAt: new Date().toISOString(), fenced: true });
    await overwrite.reconcileOverwriteIntentsAtStartup(deps(fake, scriptedHelper({
      swapAnswers: [{ action: 'status', exitCode: 0, status: 'absent' }],
    })));
    settle();
    expect(operation(seeded.operationId)).toMatchObject({ state: 'succeeded' });
    expect(lock(seeded.storageKey)).toBeNull();
  });

  it('settles the operation of a restore that startup rolled back before the fence', async () => {
    const { seeded, fake } = await seed({ phase: 'staged_verified', createdAt: new Date().toISOString(), fenced: false });
    await overwrite.reconcileOverwriteIntentsAtStartup(deps(fake, answers()));
    settle();
    expect(operation(seeded.operationId)).toMatchObject({ state: 'failed', errorClass: 'interrupted' });
    expect(lock(seeded.storageKey)).toBeNull();
  });

  it('keeps completion_unknown and the stale lock while the volume is not proven', async () => {
    const { seeded, fake } = await seed({ phase: 'swapping', createdAt: new Date().toISOString(), fenced: true });
    await overwrite.reconcileOverwriteIntentsAtStartup(deps(fake, scriptedHelper({
      swapAnswers: [{ action: 'status', exitCode: 0, status: 'inconsistent' }],
    })));
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.phase).toBe('completion_unknown');

    expect(settle()).toBe(0);
    expect(operation(seeded.operationId)).toMatchObject({ state: 'completion_unknown', errorClass: 'interrupted' });
    expect(lock(seeded.storageKey)).toMatchObject({ staleSince: expect.any(Number) });
  });

  it('keeps completion_unknown while a rolled back volume is still fenced, and settles once the fence is released', async () => {
    const { seeded, fake } = await seed({ phase: 'fenced', createdAt: new Date().toISOString(), fenced: true });
    // The workloads cannot be started again, so the restart policies stay pinned.
    fake.failOn = (call) => (call === 'update:c1' ? new Error('daemon refused') : null);
    await overwrite.reconcileOverwriteIntentsAtStartup(deps(fake, answers()));
    expect(intents.RestoreIntentStore.getInstance().get(seeded.intentId)?.outcomeClass).toBe('fence_unavailable');

    expect(settle()).toBe(0);
    expect(operation(seeded.operationId)).toMatchObject({ state: 'completion_unknown' });
    expect(lock(seeded.storageKey)).toMatchObject({ staleSince: expect.any(Number) });

    // The next start releases the fence, and the operation follows.
    fake.failOn = undefined;
    await overwrite.reconcileOverwriteIntentsAtStartup(deps(fake, answers()));
    expect(settle()).toBe(1);
    expect(operation(seeded.operationId)).toMatchObject({ state: 'failed', errorClass: 'interrupted' });
    expect(lock(seeded.storageKey)).toBeNull();
  });

  it('keeps completion_unknown and the stale lock after a release_fence that proves nothing', async () => {
    const { seeded, fake } = await seed({ phase: 'swapping', createdAt: new Date().toISOString(), fenced: true });
    intents.RestoreIntentStore.getInstance().advance(seeded.intentId, 'completion_unknown', { outcomeClass: 'identity_unknown' });
    await overwrite.resolveOverwriteIntent(deps(fake, scriptedHelper({ swapAnswers: [{ action: 'status', exitCode: 1 }] })), {
      intentId: seeded.intentId, action: 'release_fence',
    });
    settle(seeded.intentId);
    expect(operation(seeded.operationId)).toMatchObject({ state: 'completion_unknown' });
    expect(lock(seeded.storageKey)).toMatchObject({ staleSince: expect.any(Number) });
  });

  it('settles it on a retry once the journal proves the swap committed', async () => {
    const { seeded, fake } = await seed({ phase: 'swapping', createdAt: new Date().toISOString(), fenced: true });
    intents.RestoreIntentStore.getInstance().advance(seeded.intentId, 'completion_unknown', { outcomeClass: 'identity_unknown' });
    const result = await overwrite.resolveOverwriteIntent(deps(fake, answers()), { intentId: seeded.intentId, action: 'retry' });
    expect(result.outcome).toBe('committed');
    settle(seeded.intentId);
    expect(operation(seeded.operationId)).toMatchObject({ state: 'succeeded' });
    expect(lock(seeded.storageKey)).toBeNull();
  });

  it('reports partial/cleanup_failed for a committed swap whose originals could not be removed', async () => {
    const { seeded, fake } = await seed({ phase: 'swapped', createdAt: new Date().toISOString(), fenced: true });
    await overwrite.resolveOverwriteIntent(deps(fake, scriptedHelper({ swapAnswers: [
      { action: 'status', exitCode: 0, status: 'swapped' },
      { action: 'cleanup', exitCode: 1, stderr: 'helper image missing' },
    ] })), { intentId: seeded.intentId, action: 'release_fence' });
    settle(seeded.intentId);
    expect(operation(seeded.operationId)).toMatchObject({ state: 'partial', errorClass: 'cleanup_failed' });
    expect(lock(seeded.storageKey)).toBeNull();
  });

  it('never rewrites an ending a live process reported', async () => {
    const { seeded, fake } = await seed({ phase: 'staged_verified', createdAt: new Date().toISOString(), fenced: false });
    await overwrite.reconcileOverwriteIntentsAtStartup(deps(fake, answers()));
    recoveryDbModule.recoveryDb().prepare("UPDATE recovery_operations SET state = 'cancelled', error_class = NULL WHERE id = ?")
      .run(seeded.operationId);
    expect(settle(seeded.intentId)).toBe(0);
    expect(operation(seeded.operationId)).toMatchObject({ state: 'cancelled' });
  });

  it.each([
    ['committed', null, { state: 'succeeded' }],
    ['committed', 'fence_unavailable', { state: 'partial', errorClass: 'fence_unavailable' }],
    ['rolled_back', null, { state: 'failed', errorClass: 'interrupted' }],
    ['rolled_back', 'fence_unavailable', null],
    ['swapped', 'cleanup_failed', { state: 'partial', errorClass: 'cleanup_failed' }],
    ['swapped', 'fence_unavailable', { state: 'partial', errorClass: 'fence_unavailable' }],
    ['swapped', null, null],
    ['swapping', null, null],
    ['completion_unknown', 'identity_unknown', null],
    ['staging', null, null],
  ] as const)('maps a %s intent with class %s to %j', (phase, outcomeClass, ending) => {
    expect(overwrite.overwriteEndingFor({ phase, outcomeClass })).toEqual(ending);
  });

  it('does not stop at an intent whose operation cannot be settled', async () => {
    const first = await seed({ phase: 'staged_verified', createdAt: new Date().toISOString(), fenced: false });
    await overwrite.reconcileOverwriteIntentsAtStartup(deps(first.fake, answers()));
    const second = await seed({ phase: 'staged_verified', createdAt: new Date().toISOString(), fenced: false });
    await overwrite.reconcileOverwriteIntentsAtStartup(deps(second.fake, answers()));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const real = operationStore.RecoveryOperationStore.getInstance();
    let calls = 0;
    const settled = overwrite.settleInterruptedOverwriteOperations(
      intents.RestoreIntentStore.getInstance(),
      { settleReconciled: (id, ending) => { calls += 1; if (calls === 1) throw new Error('database is locked'); return real.settleReconciled(id, ending); } },
    );
    expect(calls).toBe(2);
    expect(settled).toBe(1);
    expect(warn).toHaveBeenCalled();
  });

  it('is idempotent', async () => {
    const { seeded, fake } = await seed({ phase: 'swapping', createdAt: new Date().toISOString(), fenced: true });
    await overwrite.reconcileOverwriteIntentsAtStartup(deps(fake, answers()));
    expect(settle()).toBe(1);
    expect(settle()).toBe(0);
    expect(operation(seeded.operationId)).toMatchObject({ state: 'succeeded' });
  });
});
