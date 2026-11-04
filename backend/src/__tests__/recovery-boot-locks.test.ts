/**
 * What boot does with the locks a dead process left.
 *
 * Every recovery operation takes the repository lock, so a stale one left by an
 * interrupted capture would otherwise close every volume on the node until an
 * administrator released it. Boot has already removed the dead process's helpers
 * and cleared restic's own locks by then, so an interrupted capture, check or
 * restore leaves nothing in the repository to review, and its repository lock is
 * released. A provisioning operation and every storage lock keep waiting for a
 * person, and nothing is released when restic's locks could not be cleared.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type Docker from 'dockerode';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { scriptedHelper } from './__helpers__/overwriteFixture';

let tmpDir: string;
let runner: typeof import('../services/recovery/operationRunner');
let operations: typeof import('../services/recovery/operations');
let repositoryStore: typeof import('../services/recovery/repositories');
let identityStore: typeof import('../services/recovery/storageIdentity');
let recoveryDbModule: typeof import('../services/recovery/recoveryDb');
let pointsModule: typeof import('../services/recovery/recoveryPoints');
let intentsModule: typeof import('../services/recovery/restoreIntents');
let DockerController: typeof import('../services/DockerController').default;
let nodeId: number;

// Matches the engine id the fake daemon reports, so a stored volume and a live one share a key.
const ENGINE_KEY = 'docker-engine:engine-1';
const OTHER_VOLUME = 'untouched_data';
const HELPER_ENV = 'SENCHO_RECOVERY_HELPER_IMAGE';
let previousHelperEnv: string | undefined;

function fakeDocker(volumes: string[]): Docker {
  const createdAt = new Date().toISOString();
  return {
    info: async () => ({ ID: 'engine-1' }),
    listVolumes: async () => ({ Volumes: volumes.map((Name) => ({ Name, Driver: 'local', Labels: {}, CreatedAt: createdAt })) }),
    getVolume: (name: string) => ({
      inspect: async () => {
        if (!volumes.includes(name)) throw Object.assign(new Error('no such volume'), { statusCode: 404 });
        return { Name: name, Driver: 'local', Labels: {}, CreatedAt: createdAt };
      },
    }),
    listContainers: async () => [],
    getImage: () => ({ inspect: async () => ({ Id: 'sha256:helper' }) }),
  } as unknown as Docker;
}

/** A helper runner whose unlock answers the given exit code and whose probe answers a report. */
function helper(unlockExit: number, remainingHelpers = 0) {
  const unlocks: string[] = [];
  const instance = {
    run: async (spec: { profile: string; onStdoutLine?: (line: string) => void }) => {
      if (spec.profile === 'unlock') {
        unlocks.push(spec.profile);
        return { exitCode: unlockExit, stderrTail: unlockExit === 0 ? '' : 'unlock failed', aborted: false, killed: false };
      }
      if (spec.profile === 'probe' && spec.onStdoutLine) {
        spec.onStdoutLine(JSON.stringify({ dev: 1, ino: 2, uid: 0, gid: 0, mode: 16877 }));
        return { exitCode: 0, stderrTail: '', aborted: false, killed: false };
      }
      return { exitCode: 0, stderrTail: '', aborted: false, killed: false };
    },
    removeForeignEpochHelpers: async () => 0,
    countForeignEpochHelpers: async () => remainingHelpers,
  } as unknown as import('../services/recovery/restic/helperRunner').RecoveryHelperRunner;
  return { instance, unlocks };
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  runner = await import('../services/recovery/operationRunner');
  operations = await import('../services/recovery/operations');
  repositoryStore = await import('../services/recovery/repositories');
  identityStore = await import('../services/recovery/storageIdentity');
  recoveryDbModule = await import('../services/recovery/recoveryDb');
  pointsModule = await import('../services/recovery/recoveryPoints');
  intentsModule = await import('../services/recovery/restoreIntents');
  DockerController = (await import('../services/DockerController')).default;
  nodeId = (await import('../services/DatabaseService')).DatabaseService.getInstance().getDefaultNode()?.id ?? 1;
  const fs = await import('fs');
  const path = await import('path');
  fs.mkdirSync(path.join(process.env.COMPOSE_DIR as string, 'stack-dir'), { recursive: true });
  fs.writeFileSync(
    path.join(process.env.COMPOSE_DIR as string, 'stack-dir', 'docker-compose.yml'),
    'services:\n  web:\n    image: nginx\n',
  );
  previousHelperEnv = process.env[HELPER_ENV];
  process.env[HELPER_ENV] = `sha256:${'a'.repeat(64)}`;
});

afterAll(async () => {
  if (previousHelperEnv === undefined) delete process.env[HELPER_ENV];
  else process.env[HELPER_ENV] = previousHelperEnv;
  await cleanupTestDb(tmpDir);
});

beforeEach(() => {
  runner.RecoveryEngineService.resetForTests();
  // Reconciliation runs once per process; each case plays a fresh boot.
  (operations.RecoveryOperationStore.getInstance() as unknown as { reconciled: boolean }).reconciled = false;
  const db = recoveryDbModule.recoveryDb();
  for (const table of [
    'recovery_restore_fence_members', 'recovery_restore_intents', 'recovery_repository_checks', 'recovery_locks', 'recovery_operations',
    'recovery_point_verifications', 'recovery_points', 'recovery_repositories',
    'recovery_storage_dependents', 'recovery_storage_identities',
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare("DELETE FROM system_state WHERE key = 'recovery_active_repository_id'").run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** An active repository, a stored volume, and an operation of `kind` a dead process left holding locks. */
function seedInterrupted(kind: 'create_point' | 'verify_point' | 'restore' | 'repository_init', options: { storageLock?: boolean } = {}): {
  repositoryId: string;
  storageKey: string;
  storageId: string;
  operationId: string;
} {
  const repository = repositoryStore.RecoveryRepositoryStore.getInstance().register({
    ownerNodeKey: ENGINE_KEY, kind: 'local_volume', locator: 'sencho-recovery-boot-g1', failureDomain: 'same_failure_domain',
  });
  repositoryStore.RecoveryRepositoryStore.getInstance().storeSecret(repository.id, 'password-1');
  repositoryStore.RecoveryRepositoryStore.getInstance().setFingerprint(repository.id, 'f'.repeat(32));
  repositoryStore.RecoveryRepositoryStore.getInstance().setActive(repository.id);
  const storage = identityStore.StorageIdentityStore.getInstance().observe({
    ownerNodeKey: ENGINE_KEY, kind: 'named_volume', locator: 'interrupted_data',
    generationToken: 't1', dependents: [{ stackName: 'stack-dir', serviceName: null }],
  });
  const store = operations.RecoveryOperationStore.getInstance();
  const operation = store.start({
    idempotencyKey: `interrupted-${kind}`, kind,
    storageId: kind === 'repository_init' ? null : storage.id,
    actor: 'admin', transport: 'local', requestDigest: 'a'.repeat(64),
  }).operation;
  store.markRunning(operation.id);
  store.acquireLock('repository', repository.id, operation.id);
  if (kind === 'create_point' || options.storageLock) store.acquireLock('storage', storage.storageKey, operation.id);
  // The process that owned them is gone: the rows carry another epoch.
  const db = recoveryDbModule.recoveryDb();
  db.prepare("UPDATE recovery_operations SET process_epoch = 'dead-epoch' WHERE id = ?").run(operation.id);
  db.prepare("UPDATE recovery_locks SET process_epoch = 'dead-epoch' WHERE owner_operation_id = ?").run(operation.id);
  return { repositoryId: repository.id, storageKey: storage.storageKey, storageId: storage.id, operationId: operation.id };
}

async function boot(unlockExit: number, remainingHelpers = 0): Promise<{ unlocks: string[] }> {
  vi.spyOn(DockerController.prototype, 'getDocker').mockReturnValue(fakeDocker([OTHER_VOLUME, 'interrupted_data']));
  const service = runner.RecoveryEngineService.getInstance(nodeId);
  const fake = helper(unlockExit, remainingHelpers);
  service.setHelperRunnerForTests(fake.instance);
  await service.runBootSequence();
  expect(service.isReady()).toBe(true);
  return { unlocks: fake.unlocks };
}

async function captureOtherVolume() {
  const service = runner.RecoveryEngineService.getInstance(nodeId);
  runner.RecoveryEngineService.setEngineFactoryForTests(() => ({
    engineId: 'fake', contractVersion: 1 as const, storageKinds: ['named_volume'] as const,
    probe: async () => ({ engineId: 'fake', build: 'test', usable: true }),
    createPoint: async () => ({
      ok: true as const,
      evidence: { snapshotId: 'snap', capture: { fileCount: 1, byteCount: 1, skippedCount: 0 }, exclusions: [], consistency: 'crash_consistent_stopped' },
    }),
    verifyPoint: async () => ({ ok: true as const, evidence: { result: 'verified' } }),
    restore: async () => ({ ok: false as const, errorClass: 'internal' }),
  }) as never);
  return service.admitCreatePoint({
    nodeId, volumeName: OTHER_VOLUME, actor: 'alice', idempotencyKey: `capture-${Math.random()}`,
    requestDigest: runner.sha256Digest(['create_point', OTHER_VOLUME]), transport: 'local', authorize: () => true,
  });
}

describe('boot with an interrupted capture', () => {
  it('releases its repository lock once restic is unlocked, so an unrelated volume can be captured', async () => {
    const { repositoryId, storageKey, operationId } = seedInterrupted('create_point');
    const { unlocks } = await boot(0);

    expect(unlocks).toHaveLength(1);
    const store = operations.RecoveryOperationStore.getInstance();
    expect(store.get(operationId)).toMatchObject({ state: 'completion_unknown', errorClass: 'interrupted' });
    expect(store.getLock('repository', repositoryId)).toBeNull();
    // The interrupted volume itself still waits for a reviewed release.
    expect(store.getLock('storage', storageKey)?.staleSince).not.toBeNull();

    const admitted = await captureOtherVolume();
    expect(admitted.replayed).toBe(false);
    await runner.RecoveryEngineService.getInstance(nodeId).whenIdleForTests();
    expect(store.get(admitted.operation.id)?.state).toBe('succeeded');
  });

  it('keeps the lock when restic could not be unlocked, and the next capture says so', async () => {
    const { repositoryId } = seedInterrupted('create_point');
    await boot(1);

    const store = operations.RecoveryOperationStore.getInstance();
    expect(store.getLock('repository', repositoryId)?.staleSince).not.toBeNull();
    await expect(captureOtherVolume()).rejects.toMatchObject({ errorClass: 'lock_stale' });
  });

  it('keeps the lock while a helper of the dead process is still there, because it may still be writing', async () => {
    const { repositoryId } = seedInterrupted('create_point');
    await boot(0, 1);

    expect(operations.RecoveryOperationStore.getInstance().getLock('repository', repositoryId)?.staleSince).not.toBeNull();
    await expect(captureOtherVolume()).rejects.toMatchObject({ errorClass: 'lock_stale' });
  });

  it('releases only the active repository\'s lock, not the one of a replaced repository', async () => {
    const { repositoryId } = seedInterrupted('create_point');
    const store = operations.RecoveryOperationStore.getInstance();
    const other = repositoryStore.RecoveryRepositoryStore.getInstance().register({
      ownerNodeKey: ENGINE_KEY, kind: 'local_volume', locator: 'sencho-recovery-boot-g0', failureDomain: 'same_failure_domain',
    });
    const operation = store.start({
      idempotencyKey: 'old-repo-verify', kind: 'verify_point', storageId: null,
      actor: 'admin', transport: 'local', requestDigest: 'b'.repeat(64),
    }).operation;
    store.markRunning(operation.id);
    store.acquireLock('repository', other.id, operation.id);
    const db = recoveryDbModule.recoveryDb();
    db.prepare("UPDATE recovery_operations SET process_epoch = 'dead-epoch' WHERE id = ?").run(operation.id);
    db.prepare("UPDATE recovery_locks SET process_epoch = 'dead-epoch' WHERE owner_operation_id = ?").run(operation.id);

    await boot(0);

    expect(store.getLock('repository', repositoryId)).toBeNull();
    expect(store.getLock('repository', other.id)?.staleSince).not.toBeNull();
  });

  it('keeps the storage lock of the interrupted volume closed to a new capture', async () => {
    seedInterrupted('create_point');
    await boot(0);
    const service = runner.RecoveryEngineService.getInstance(nodeId);
    await expect(service.admitCreatePoint({
      nodeId, volumeName: 'interrupted_data', actor: 'alice', idempotencyKey: 'same-volume',
      requestDigest: runner.sha256Digest(['create_point', 'interrupted_data']), transport: 'local', authorize: () => true,
    })).rejects.toMatchObject({ errorClass: 'lock_stale' });
  });
});

describe('the storage lock of an interrupted overwrite', () => {
  /** A staged overwrite the dead process left in `phase`, on the operation `seedInterrupted` made. */
  function seedOverwriteIntent(seeded: ReturnType<typeof seedInterrupted>, phase: 'staging' | 'completion_unknown'): string {
    const pointStore = pointsModule.RecoveryPointStore.getInstance();
    const point = pointStore.begin({
      kind: 'root', storageId: seeded.storageId, expectedGenerationToken: 't1', repositoryId: seeded.repositoryId,
      trigger: 'manual', actor: 'admin', sourceOperationId: 'op-src', sourceNodeKey: ENGINE_KEY, engineId: 'restic',
    });
    pointStore.finalize(point.id, {
      status: 'succeeded',
      evidence: {
        snapshotId: 'snap-1', capture: { fileCount: 1, byteCount: 1, skippedCount: 0 },
        exclusions: [], consistency: 'crash_consistent_live',
      },
    });
    const intents = intentsModule.RestoreIntentStore.getInstance();
    const intent = intents.recordOverwrite({
      operationId: seeded.operationId, pointId: point.id, targetVolume: 'interrupted_data', actor: 'admin',
      processEpoch: 'dead-epoch', expectedGenerationToken: 't1',
      stagingVolume: `sencho-recovery-staging-${seeded.operationId}`,
    });
    if (phase === 'completion_unknown') intents.advance(intent.id, 'completion_unknown', { outcomeClass: 'identity_unknown' });
    return intent.id;
  }

  it('reads failed/interrupted and frees the storage once boot rolled the restore back', async () => {
    const seeded = seedInterrupted('restore', { storageLock: true });
    const intentId = seedOverwriteIntent(seeded, 'staging');
    await boot(0);

    expect(intentsModule.RestoreIntentStore.getInstance().get(intentId)?.phase).toBe('rolled_back');
    const store = operations.RecoveryOperationStore.getInstance();
    expect(store.get(seeded.operationId)).toMatchObject({ state: 'failed', errorClass: 'interrupted' });
    expect(store.getLock('storage', seeded.storageKey)).toBeNull();

    // The volume is usable again: a capture of it is admitted, not refused as stale.
    runner.RecoveryEngineService.setEngineFactoryForTests(() => ({
      engineId: 'fake', contractVersion: 1 as const, storageKinds: ['named_volume'] as const,
      probe: async () => ({ engineId: 'fake', build: 'test', usable: true }),
      createPoint: async () => ({
        ok: true as const,
        evidence: { snapshotId: 'snap', capture: { fileCount: 1, byteCount: 1, skippedCount: 0 }, exclusions: [], consistency: 'crash_consistent_stopped' },
      }),
      verifyPoint: async () => ({ ok: true as const, evidence: { result: 'verified' } }),
      restore: async () => ({ ok: false as const, errorClass: 'internal' }),
    }) as never);
    const admitted = await runner.RecoveryEngineService.getInstance(nodeId).admitCreatePoint({
      nodeId, volumeName: 'interrupted_data', actor: 'alice', idempotencyKey: 'after-boot',
      requestDigest: runner.sha256Digest(['create_point', 'interrupted_data']), transport: 'local', authorize: () => true,
    });
    expect(admitted.replayed).toBe(false);
  });

  it('keeps completion_unknown and the stale lock for a restore boot could not prove', async () => {
    const seeded = seedInterrupted('restore', { storageLock: true });
    const intentId = seedOverwriteIntent(seeded, 'completion_unknown');
    await boot(0);

    expect(intentsModule.RestoreIntentStore.getInstance().get(intentId)?.phase).toBe('completion_unknown');
    const store = operations.RecoveryOperationStore.getInstance();
    expect(store.get(seeded.operationId)).toMatchObject({ state: 'completion_unknown', errorClass: 'interrupted' });
    expect(store.getLock('storage', seeded.storageKey)?.staleSince).not.toBeNull();
  });

  it('settles the operation and frees the storage when a retry proves the swap committed', async () => {
    const seeded = seedInterrupted('restore', { storageLock: true });
    const intentId = seedOverwriteIntent(seeded, 'completion_unknown');
    await boot(0);
    const store = operations.RecoveryOperationStore.getInstance();
    expect(store.getLock('storage', seeded.storageKey)?.staleSince).not.toBeNull();

    const service = runner.RecoveryEngineService.getInstance(nodeId);
    service.setHelperRunnerForTests(scriptedHelper({ swapAnswers: [
      { action: 'status', exitCode: 0, status: 'swapped' },
      { action: 'commit', exitCode: 0, status: 'swapped' },
      { action: 'cleanup', exitCode: 0, status: 'cleaned' },
    ] }).helper);
    const resolved = await service.resolveOverwrite({
      intentId, action: 'retry', actor: 'admin', authorizeStack: () => true, authorizeGlobal: () => true,
    });

    expect(resolved).toEqual({ outcome: 'committed' });
    expect(store.get(seeded.operationId)).toMatchObject({ state: 'succeeded', errorClass: null });
    expect(store.getLock('storage', seeded.storageKey)).toBeNull();
  });

  it('keeps the lock of an interrupted restore that has no overwrite intent, until a reviewed release', async () => {
    const { storageKey, storageId } = seedInterrupted('restore', { storageLock: true });
    await boot(0);
    const store = operations.RecoveryOperationStore.getInstance();
    expect(store.getLock('storage', storageKey)?.staleSince).not.toBeNull();

    const next = store.start({
      idempotencyKey: 'next-overwrite', kind: 'restore', storageId,
      actor: 'admin', transport: 'local', requestDigest: 'b'.repeat(64),
    }).operation;
    let refusal: unknown;
    try {
      store.acquireLock('storage', storageKey, next.id);
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toMatchObject({ errorClass: 'lock_stale' });

    store.releaseStaleLock('storage', storageKey, 'admin');
    expect(store.getLock('storage', storageKey)).toBeNull();
    expect(() => store.acquireLock('storage', storageKey, next.id)).not.toThrow();
  });
});

describe('which interrupted work releases its repository lock', () => {
  it.each(['verify_point', 'restore'] as const)('releases the lock of an interrupted %s', async (kind) => {
    const { repositoryId } = seedInterrupted(kind);
    await boot(0);
    expect(operations.RecoveryOperationStore.getInstance().getLock('repository', repositoryId)).toBeNull();
  });

  it('releases the lock of an interrupted provisioning, which the next provision request continues', async () => {
    const { repositoryId } = seedInterrupted('repository_init');
    await boot(0);
    expect(operations.RecoveryOperationStore.getInstance().getLock('repository', repositoryId)).toBeNull();
  });

  it('releases an interrupted first provisioning even though there is no active repository to unlock', async () => {
    const { repositoryId } = seedInterrupted('repository_init');
    recoveryDbModule.recoveryDb().prepare("DELETE FROM system_state WHERE key = 'recovery_active_repository_id'").run();
    const { unlocks } = await boot(0);
    expect(unlocks).toHaveLength(0);
    expect(operations.RecoveryOperationStore.getInstance().getLock('repository', repositoryId)).toBeNull();
  });

  it('keeps an interrupted provisioning locked while a helper of the dead process remains', async () => {
    const { repositoryId } = seedInterrupted('repository_init');
    await boot(0, 1);
    expect(operations.RecoveryOperationStore.getInstance().getLock('repository', repositoryId)?.staleSince)
      .not.toBeNull();
  });
});
