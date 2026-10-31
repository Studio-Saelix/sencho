/**
 * The operation runner: admission happens before the answer, and the work ends
 * the point before the operation.
 *
 * The engine is substituted here, so these tests are about the runner's own
 * decisions: which class an outcome gets, whether a repository-wide check result
 * reaches every point, whether a cancelled capture leaves a failed point and a
 * cancelled operation, and whether a restore only ever writes into the volume
 * this intent created.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type Docker from 'dockerode';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

vi.mock('../services/ComposeService', () => ({
  ComposeService: {
    getInstance: () => ({
      renderConfig: async (stackName: string) => ({
        rendered: JSON.stringify({
          name: stackName,
          services: { web: { name: 'web', image: 'nginx', storageMounts: [] } },
          networks: {},
          volumes: { data: { name: 'app_data', external: false, internal: false } },
        }),
        stderr: '',
        timedOut: false,
      }),
    }),
  },
}));

let tmpDir: string;
let runner: typeof import('../services/recovery/operationRunner');
let operations: typeof import('../services/recovery/operations');
let points: typeof import('../services/recovery/recoveryPoints');
let repositoryStore: typeof import('../services/recovery/repositories');
let identityStore: typeof import('../services/recovery/storageIdentity');
let intents: typeof import('../services/recovery/restoreIntents');
let recoveryDbModule: typeof import('../services/recovery/recoveryDb');
let DockerController: typeof import('../services/DockerController').default;
let nodeId: number;

const ENGINE_KEY = 'docker-engine:runner-test';
const VOLUME = 'app_data';

interface FakeVolumeState {
  name: string;
  labels: Record<string, string>;
}

function fakeDocker(options: {
  volumes?: FakeVolumeState[];
  containers?: Array<{ Mounts?: Array<{ Type: string; Name: string }>; State?: string }>;
  createNoop?: boolean;
} = {}) {
  // Docker reports a stable CreatedAt for a volume; the generation token depends
  // on that stability, so the fake must not mint a new one per inspect.
  const createdAt = new Date().toISOString();
  const volumes = new Map((options.volumes ?? []).map((v) => [v.name, v]));
  const createdAtOf = new Map<string, string>();
  const removed: string[] = [];
  const created: string[] = [];
  const docker = {
    info: async () => ({ ID: 'engine-1' }),
    listVolumes: async () => ({
      Volumes: [...volumes.values()].map((v) => ({
        Name: v.name, Driver: 'local', Labels: v.labels, CreatedAt: createdAt,
      })),
    }),
    getVolume: (name: string) => ({
      inspect: async () => {
        const found = volumes.get(name);
        if (!found) throw Object.assign(new Error('no such volume'), { statusCode: 404 });
        return { Name: found.name, Driver: 'local', Labels: found.labels, CreatedAt: createdAtOf.get(name) ?? createdAt };
      },
      remove: async () => {
        if (!volumes.has(name)) throw Object.assign(new Error('no such volume'), { statusCode: 404 });
        volumes.delete(name);
        removed.push(name);
      },
    }),
    createVolume: async (spec: { Name: string; Labels?: Record<string, string> }) => {
      if (!options.createNoop && !volumes.has(spec.Name)) {
        created.push(spec.Name);
        volumes.set(spec.Name, { name: spec.Name, labels: spec.Labels ?? {} });
        // A volume made during the test is made now, however long the test has run:
        // a restore refuses a target older than its own intent.
        createdAtOf.set(spec.Name, new Date().toISOString());
      }
      return { Name: spec.Name };
    },
    listContainers: async () => options.containers ?? [],
    getImage: () => ({ inspect: async () => ({ Id: 'sha256:helper' }) }),
  } as unknown as Docker;
  return { docker, volumes, removed, created };
}

/** A helper runner that answers the generation probe and refuses anything else. */
function probeRunner(dev = 63, ino = 42) {
  return {
    run: async (spec: { profile: string; onStdoutLine?: (line: string) => void }) => {
      if (spec.profile === 'probe' && spec.onStdoutLine) {
        spec.onStdoutLine(JSON.stringify({ dev, ino, uid: 0, gid: 0, mode: 16877 }));
        return { exitCode: 0, stderrTail: '', aborted: false, killed: false };
      }
      return { exitCode: 1, stderrTail: 'unexpected helper run', aborted: false, killed: false };
    },
    removeForeignEpochHelpers: async () => 0,
    countForeignEpochHelpers: async () => 0,
  } as unknown as import('../services/recovery/restic/helperRunner').RecoveryHelperRunner;
}

function engineReturning(overrides: Partial<{
  createPoint: () => Promise<{ ok: true; evidence: unknown } | { ok: false; errorClass: string }>;
  verifyPoint: () => Promise<{ ok: true; evidence: { result: string } } | { ok: false; errorClass: string }>;
  restore: () => Promise<{ ok: true; evidence: unknown } | { ok: false; errorClass: string }>;
}>) {
  return {
    engineId: 'fake',
    contractVersion: 1 as const,
    storageKinds: ['named_volume'] as const,
    probe: async () => ({ engineId: 'fake', build: 'test', usable: true }),
    createPoint: overrides.createPoint ?? (async () => ({ ok: true as const, evidence: { snapshotId: 'snap-1', capture: { fileCount: 3, byteCount: 300, skippedCount: 0 }, exclusions: [], consistency: 'crash_consistent_stopped' } })),
    verifyPoint: overrides.verifyPoint ?? (async () => ({ ok: true as const, evidence: { result: 'verified' } })),
    restore: overrides.restore ?? (async () => ({ ok: true as const, evidence: { filesRestored: 4, bytesRestored: 400, verified: true } })),
  };
}

async function seedProtectableVolume(): Promise<{ storage: import('../services/recovery/types').StorageIdentity; repositoryId: string }> {
  const repository = repositoryStore.RecoveryRepositoryStore.getInstance().register({
    ownerNodeKey: ENGINE_KEY,
    kind: 'local_volume',
    locator: 'sencho-recovery-test-g1',
    failureDomain: 'same_failure_domain',
  });
  repositoryStore.RecoveryRepositoryStore.getInstance().storeSecret(repository.id, 'password-1');
  repositoryStore.RecoveryRepositoryStore.getInstance().setFingerprint(repository.id, 'f'.repeat(32));
  repositoryStore.RecoveryRepositoryStore.getInstance().setActive(repository.id);
  const storage = identityStore.StorageIdentityStore.getInstance().observe({
    ownerNodeKey: ENGINE_KEY,
    kind: 'named_volume',
    locator: VOLUME,
    generationToken: 'token-1',
    dependents: [{ stackName: 'stack-dir', serviceName: null }],
  });
  return { storage, repositoryId: repository.id };
}

function service() {
  const instance = runner.RecoveryEngineService.getInstance(nodeId);
  instance.setHelperRunnerForTests(probeRunner());
  return instance;
}

const allowAll = () => true;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  runner = await import('../services/recovery/operationRunner');
  operations = await import('../services/recovery/operations');
  points = await import('../services/recovery/recoveryPoints');
  repositoryStore = await import('../services/recovery/repositories');
  identityStore = await import('../services/recovery/storageIdentity');
  intents = await import('../services/recovery/restoreIntents');
  recoveryDbModule = await import('../services/recovery/recoveryDb');
  DockerController = (await import('../services/DockerController')).default;
  const db = (await import('../services/DatabaseService')).DatabaseService.getInstance();
  nodeId = db.getDefaultNode()?.id ?? 1;
  // A stack directory exists so the dependent resolution has a name to check.
  const fs = await import('fs');
  const path = await import('path');
  fs.mkdirSync(path.join(process.env.COMPOSE_DIR as string, 'stack-dir'), { recursive: true });
  fs.writeFileSync(
    path.join(process.env.COMPOSE_DIR as string, 'stack-dir', 'docker-compose.yml'),
    'services:\n  web:\n    image: nginx\n',
  );
});

afterAll(async () => {
  await cleanupTestDb(tmpDir);
});

beforeEach(async () => {
  // Let the previous case's background work finish before the tables are cleared:
  // a leaked operation would otherwise write into this case's rows.
  await runner.RecoveryEngineService.getInstance(nodeId).whenIdleForTests();
  runner.RecoveryEngineService.resetForTests();
  const db = recoveryDbModule.recoveryDb();
  for (const table of [
    'recovery_restore_intents', 'recovery_repository_checks', 'recovery_locks', 'recovery_operations',
    'recovery_point_verifications', 'recovery_points', 'recovery_repositories',
    'recovery_storage_dependents', 'recovery_storage_identities',
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare("DELETE FROM system_state WHERE key = 'recovery_active_repository_id'").run();
});

function stubDocker(fake: ReturnType<typeof fakeDocker>) {
  // DockerController.getInstance() builds a new wrapper on every call, so the
  // stub has to live on the prototype to reach every caller.
  vi.spyOn(DockerController.prototype, 'getDocker').mockReturnValue(fake.docker);
  return fake;
}

describe('create point', () => {
  it('records a complete capture as succeeded and verifies the repository', async () => {
    const fake = stubDocker(fakeDocker({ volumes: [{ name: VOLUME, labels: {} }] }));
    await seedProtectableVolume();
    runner.RecoveryEngineService.setEngineFactoryForTests(() => engineReturning({}) as never);
    service().markReadyForTests();

    const admitted = await service().admitCreatePoint({
      nodeId,
      volumeName: VOLUME,
      actor: 'alice',
      idempotencyKey: 'key-1',
      requestDigest: runner.sha256Digest(['create_point', VOLUME]),
      transport: 'local',
      authorize: allowAll,
    });
    expect(admitted.replayed).toBe(false);
    expect(admitted.operation.kind).toBe('create_point');
    expect(admitted.operation.actor).toBe('alice');

    await service().whenIdleForTests();

    const operation = operations.RecoveryOperationStore.getInstance().get(admitted.operation.id);
    expect(operation?.state).toBe('succeeded');
    const point = points.RecoveryPointStore.getInstance().findBySourceOperation(admitted.operation.id);
    expect(point).toMatchObject({ status: 'succeeded', consistency: 'crash_consistent_stopped' });
    expect(points.RecoveryPointStore.getInstance().listVerifications(point?.id ?? '')).toHaveLength(1);
    expect(fake.volumes.has(VOLUME)).toBe(true);
  });

  it('records a capture with skipped data as partial, and the operation with it', async () => {
    stubDocker(fakeDocker({ volumes: [{ name: VOLUME, labels: {} }] }));
    await seedProtectableVolume();
    runner.RecoveryEngineService.setEngineFactoryForTests(() => engineReturning({
      createPoint: async () => ({
        ok: true as const,
        evidence: {
          snapshotId: 'snap-2',
          capture: { fileCount: 2, byteCount: 20, skippedCount: 1 },
          exclusions: [{ path: 'secret', reason: 'permission_denied' }],
          consistency: 'crash_consistent_live',
        },
      }),
    }) as never);
    service().markReadyForTests();

    const admitted = await service().admitCreatePoint({
      nodeId, volumeName: VOLUME, actor: 'alice', idempotencyKey: 'key-2',
      requestDigest: runner.sha256Digest(['create_point', VOLUME]), transport: 'local', authorize: allowAll,
    });
    await service().whenIdleForTests();

    const point = points.RecoveryPointStore.getInstance().findBySourceOperation(admitted.operation.id);
    expect(point?.status).toBe('partial');
    expect(operations.RecoveryOperationStore.getInstance().get(admitted.operation.id)?.state).toBe('partial');
  });

  it('settles a cancelled capture as a failed point and a cancelled operation', async () => {
    stubDocker(fakeDocker({ volumes: [{ name: VOLUME, labels: {} }] }));
    await seedProtectableVolume();
    runner.RecoveryEngineService.setEngineFactoryForTests(() => engineReturning({
      createPoint: async () => ({ ok: false as const, errorClass: 'interrupted' }),
    }) as never);
    service().markReadyForTests();

    const admitted = await service().admitCreatePoint({
      nodeId, volumeName: VOLUME, actor: 'alice', idempotencyKey: 'key-3',
      requestDigest: runner.sha256Digest(['create_point', VOLUME]), transport: 'local', authorize: allowAll,
    });
    await service().whenIdleForTests();

    const point = points.RecoveryPointStore.getInstance().findBySourceOperation(admitted.operation.id);
    expect(point).toMatchObject({ status: 'failed', failureClass: 'interrupted' });
    expect(operations.RecoveryOperationStore.getInstance().get(admitted.operation.id)?.state).toBe('cancelled');
    // The locks are released: nothing is left for a reviewer to release.
    expect(operations.RecoveryOperationStore.getInstance().getLock('repository', repositoryStore.RecoveryRepositoryStore.getInstance().getActive()?.id ?? '')).toBeNull();
  });

  it('fails the point when the storage generation changed during the capture', async () => {
    stubDocker(fakeDocker({ volumes: [{ name: VOLUME, labels: {} }] }));
    await seedProtectableVolume();
    runner.RecoveryEngineService.setEngineFactoryForTests(() => engineReturning({
      createPoint: async () => ({ ok: false as const, errorClass: 'identity_unknown' }),
    }) as never);
    service().markReadyForTests();

    const admitted = await service().admitCreatePoint({
      nodeId, volumeName: VOLUME, actor: 'alice', idempotencyKey: 'key-4',
      requestDigest: runner.sha256Digest(['create_point', VOLUME]), transport: 'local', authorize: allowAll,
    });
    await service().whenIdleForTests();

    expect(points.RecoveryPointStore.getInstance().findBySourceOperation(admitted.operation.id))
      .toMatchObject({ status: 'failed', failureClass: 'identity_unknown' });
    expect(operations.RecoveryOperationStore.getInstance().get(admitted.operation.id))
      .toMatchObject({ state: 'failed', errorClass: 'identity_unknown' });
  });

  it('refuses a second request while the storage lock is held, before answering 202', async () => {
    stubDocker(fakeDocker({ volumes: [{ name: VOLUME, labels: {} }] }));
    const seeded = await seedProtectableVolume();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    runner.RecoveryEngineService.setEngineFactoryForTests(() => engineReturning({
      // Held open until the test lets go, so the storage lock stays taken.
      createPoint: async () => {
        await held;
        return { ok: false as const, errorClass: 'interrupted' };
      },
    }) as never);
    service().markReadyForTests();

    const first = await service().admitCreatePoint({
      nodeId, volumeName: VOLUME, actor: 'alice', idempotencyKey: 'key-5',
      requestDigest: runner.sha256Digest(['create_point', VOLUME]), transport: 'local', authorize: allowAll,
    });
    expect(first.operation.state).toBe('running');

    await expect(service().admitCreatePoint({
      nodeId, volumeName: VOLUME, actor: 'bob', idempotencyKey: 'key-6',
      requestDigest: runner.sha256Digest(['create_point', VOLUME]), transport: 'local', authorize: allowAll,
    })).rejects.toMatchObject({ errorClass: 'lock_held' });

    // A refused request leaves nothing behind: no operation row, so its key is
    // still free, and no lock the refused attempt took before the one that failed.
    const refusedRows = recoveryDbModule.recoveryDb()
      .prepare("SELECT COUNT(*) AS n FROM recovery_operations WHERE idempotency_key = 'key-6'")
      .get() as { n: number };
    expect(refusedRows.n).toBe(0);
    const heldLocks = recoveryDbModule.recoveryDb()
      .prepare('SELECT COUNT(*) AS n FROM recovery_locks WHERE owner_operation_id <> ?')
      .get(first.operation.id) as { n: number };
    expect(heldLocks.n).toBe(0);
    service().cancel(first.operation.id);
    release();
    await service().whenIdleForTests();
    expect(seeded.repositoryId).toBeTruthy();

    // The same key, sent again once the lock is free, runs. It is not answered
    // with a failure that never ran.
    runner.RecoveryEngineService.setEngineFactoryForTests(() => engineReturning({}) as never);
    const retried = await service().admitCreatePoint({
      nodeId, volumeName: VOLUME, actor: 'bob', idempotencyKey: 'key-6',
      requestDigest: runner.sha256Digest(['create_point', VOLUME]), transport: 'local', authorize: allowAll,
    });
    expect(retried.replayed).toBe(false);
    await service().whenIdleForTests();
    expect(operations.RecoveryOperationStore.getInstance().get(retried.operation.id)?.state).toBe('succeeded');
  });

  it('refuses a capture on a repository lock a verify holds, and the retry of the same key runs', async () => {
    // The capture's storage lock is free, so the refusal comes from the second
    // lock it asks for. The first lock it took must not survive the refusal.
    stubDocker(fakeDocker({ volumes: [{ name: VOLUME, labels: {} }] }));
    const seeded = await seedProtectableVolume();
    const store = operations.RecoveryOperationStore.getInstance();
    const holder = store.start({
      idempotencyKey: 'holder', kind: 'verify_point', actor: 'alice', transport: 'local',
      requestDigest: runner.sha256Digest(['holder']),
    }).operation;
    store.markRunning(holder.id);
    store.acquireLock('repository', seeded.repositoryId, holder.id);
    runner.RecoveryEngineService.setEngineFactoryForTests(() => engineReturning({}) as never);
    service().markReadyForTests();

    const request = {
      nodeId, volumeName: VOLUME, actor: 'alice', idempotencyKey: 'key-two-locks',
      requestDigest: runner.sha256Digest(['create_point', VOLUME]), transport: 'local' as const, authorize: allowAll,
    };
    await expect(service().admitCreatePoint(request)).rejects.toMatchObject({ errorClass: 'lock_held' });
    expect(store.getLock('storage', seeded.storage.storageKey)).toBeNull();
    expect(recoveryDbModule.recoveryDb().prepare('SELECT COUNT(*) AS n FROM recovery_points').get())
      .toEqual({ n: 0 });

    store.finish(holder.id, { state: 'succeeded' });
    const retried = await service().admitCreatePoint(request);
    expect(retried.replayed).toBe(false);
    await service().whenIdleForTests();
    expect(store.get(retried.operation.id)?.state).toBe('succeeded');
  });

  it('treats a replay with the same digest as the same operation and a different one as invalid', async () => {
    stubDocker(fakeDocker({ volumes: [{ name: VOLUME, labels: {} }] }));
    await seedProtectableVolume();
    runner.RecoveryEngineService.setEngineFactoryForTests(() => engineReturning({}) as never);
    service().markReadyForTests();

    const digest = runner.sha256Digest(['create_point', VOLUME]);
    const first = await service().admitCreatePoint({
      nodeId, volumeName: VOLUME, actor: 'alice', idempotencyKey: 'key-7',
      requestDigest: digest, transport: 'local', authorize: allowAll,
    });
    await service().whenIdleForTests();

    const replay = await service().admitCreatePoint({
      nodeId, volumeName: VOLUME, actor: 'alice', idempotencyKey: 'key-7',
      requestDigest: digest, transport: 'local', authorize: allowAll,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.operation.id).toBe(first.operation.id);

    await expect(service().admitCreatePoint({
      nodeId, volumeName: VOLUME, actor: 'alice', idempotencyKey: 'key-7',
      requestDigest: runner.sha256Digest(['create_point', 'other_volume']), transport: 'local', authorize: allowAll,
    })).rejects.toMatchObject({ errorClass: 'invalid_request' });
  });
});

describe('repository provisioning', () => {
  it('a repeated request keeps the working repository instead of replacing it', async () => {
    stubDocker(fakeDocker({ volumes: [{ name: VOLUME, labels: {} }] }));
    const seeded = await seedProtectableVolume();
    service().markReadyForTests();

    const again = await service().admitRepositoryInit({
      actor: 'alice',
      idempotencyKey: 'provision-again',
      replace: false,
      transport: 'local',
    });
    await service().whenIdleForTests();

    expect(operations.RecoveryOperationStore.getInstance().get(again.operation.id)?.state).toBe('succeeded');
    // The pointer did not move, and no second repository row was registered: a
    // new generation here would strand every point the old one holds.
    expect(repositoryStore.RecoveryRepositoryStore.getInstance().getActive()?.id).toBe(seeded.repositoryId);
    const rows = recoveryDbModule.recoveryDb().prepare('SELECT id FROM recovery_repositories').all();
    expect(rows).toHaveLength(1);
  });

  it('names the generation it resumes, and only a replacement moves past it', async () => {
    const { generationOfLocator, repositoryVolumeName } = await import('../services/recovery/localRepository');
    const name = repositoryVolumeName('authority', 'docker-engine:x', 3);
    expect(generationOfLocator(name)).toBe(3);
    expect(generationOfLocator('some-other-volume')).toBeNull();
  });
});

describe('verify', () => {
  it('records a repository-wide result on every point of the repository', async () => {
    stubDocker(fakeDocker({ volumes: [{ name: VOLUME, labels: {} }] }));
    const seeded = await seedProtectableVolume();
    const store = points.RecoveryPointStore.getInstance();
    const makePoint = (id: string): void => {
      const point = store.begin({
        kind: 'root',
        storageId: seeded.storage.id,
        expectedGenerationToken: 'token-1',
        repositoryId: seeded.repositoryId,
        trigger: 'manual',
        actor: 'alice',
        sourceOperationId: `op-${id}`,
        sourceNodeKey: ENGINE_KEY,
        engineId: 'restic',
      });
      store.finalize(point.id, {
        status: 'succeeded',
        evidence: { snapshotId: id, capture: { fileCount: 1, byteCount: 1, skippedCount: 0 }, exclusions: [], consistency: 'unknown' },
      });
    };
    makePoint('snap-a');
    makePoint('snap-b');
    const target = store.listForStorage(seeded.storage.id)[0];

    runner.RecoveryEngineService.setEngineFactoryForTests(() => engineReturning({
      verifyPoint: async () => ({ ok: true as const, evidence: { result: 'mismatch' } }),
    }) as never);
    service().markReadyForTests();

    const admitted = await service().admitVerify({
      nodeId,
      pointId: target.id,
      actor: 'alice',
      idempotencyKey: 'verify-1',
      requestDigest: runner.sha256Digest(['verify_point', target.id]),
      transport: 'local',
      method: 'engine_check_metadata',
      authorize: allowAll,
    });
    await service().whenIdleForTests();

    // The check ran; what it found is "not intact", and the operation says so.
    expect(operations.RecoveryOperationStore.getInstance().get(admitted.operation.id))
      .toMatchObject({ state: 'failed', errorClass: 'integrity_mismatch' });
    // Both points carry the mismatch, not just the one the operation named.
    for (const point of store.listForStorage(seeded.storage.id)) {
      expect(store.listVerifications(point.id).map((v) => v.result)).toEqual(['mismatch']);
    }
    expect(store.latestRepositoryCheck(seeded.repositoryId)).toMatchObject({ result: 'mismatch' });
  });
});

describe('restore', () => {
  async function seedPoint(): Promise<{ pointId: string; repositoryId: string }> {
    const seeded = await seedProtectableVolume();
    const store = points.RecoveryPointStore.getInstance();
    const point = store.begin({
      kind: 'root',
      storageId: seeded.storage.id,
      expectedGenerationToken: 'token-1',
      repositoryId: seeded.repositoryId,
      trigger: 'manual',
      actor: 'alice',
      sourceOperationId: 'op-source',
      sourceNodeKey: ENGINE_KEY,
      engineId: 'restic',
    });
    store.finalize(point.id, {
      status: 'succeeded',
      evidence: { snapshotId: 'snap-r', capture: { fileCount: 1, byteCount: 1, skippedCount: 0 }, exclusions: [], consistency: 'unknown' },
    });
    return { pointId: point.id, repositoryId: seeded.repositoryId };
  }

  it('writes only into the volume this intent created, and commits it', async () => {
    const fake = stubDocker(fakeDocker({ volumes: [{ name: VOLUME, labels: {} }] }));
    const { pointId } = await seedPoint();
    let intentAtEngineCall: string | null = null;
    let createdBeforeEngine = false;
    runner.RecoveryEngineService.setEngineFactoryForTests(({ operationId }) => engineReturning({
      restore: async () => {
        const intent = intents.RestoreIntentStore.getInstance().getByOperation(operationId);
        intentAtEngineCall = intent?.phase ?? null;
        createdBeforeEngine = [...fake.volumes.keys()].includes('restored_data');
        return { ok: true as const, evidence: { filesRestored: 4, bytesRestored: 400, verified: true } };
      },
    }) as never);
    service().markReadyForTests();

    const admitted = await service().admitRestore({
      nodeId,
      pointId,
      targetVolumeName: 'restored_data',
      actor: 'alice',
      idempotencyKey: 'restore-1',
      requestDigest: runner.sha256Digest(['restore', pointId, 'restored_data', 'new_volume']),
      transport: 'local',
      authorize: allowAll,
      authorizeCrossStack: allowAll,
    });
    await service().whenIdleForTests();

    // The intent existed, and was staging, before the engine moved a byte; and the
    // target volume existed with this intent's label.
    expect(intentAtEngineCall).toBe('staging');
    expect(createdBeforeEngine).toBe(true);
    expect(fake.volumes.get('restored_data')?.labels).toEqual({
      'dev.sencho.recovery.restore-intent': intents.RestoreIntentStore.getInstance().getByOperation(admitted.operation.id)?.id,
    });
    expect(intents.RestoreIntentStore.getInstance().getByOperation(admitted.operation.id))
      .toMatchObject({ phase: 'committed', verified: true, filesRestored: 4 });
    expect(operations.RecoveryOperationStore.getInstance().get(admitted.operation.id)?.state).toBe('succeeded');
  });

  it('requires the target stack\'s access for a name that matches its Compose project', async () => {
    stubDocker(fakeDocker({ volumes: [{ name: VOLUME, labels: {} }] }));
    const { pointId } = await seedPoint();
    // The stack directory is `stack-dir`, but Compose names its volumes after the
    // project, so a target called `stack-dir_data` is still that stack's namespace.
    const fs = await import('fs');
    const path = await import('path');
    fs.mkdirSync(path.join(process.env.COMPOSE_DIR as string, 'renamed'), { recursive: true });
    fs.writeFileSync(
      path.join(process.env.COMPOSE_DIR as string, 'renamed', 'docker-compose.yml'),
      'name: stack-dir\nservices:\n  web:\n    image: nginx\n',
    );
    runner.RecoveryEngineService.setEngineFactoryForTests(() => engineReturning({}) as never);
    service().markReadyForTests();

    await expect(service().admitRestore({
      nodeId,
      pointId,
      targetVolumeName: 'stack-dir_data',
      actor: 'mallory',
      idempotencyKey: 'restore-cross',
      requestDigest: runner.sha256Digest(['restore', pointId, 'stack-dir_data', 'new_volume']),
      transport: 'local',
      authorize: allowAll,
      authorizeCrossStack: () => false,
    })).rejects.toMatchObject({ errorClass: 'permission_denied' });
  });

  it('aborts without touching a target it did not create', async () => {
    // createVolume is a no-op, so the name belongs to a volume with no label.
    const fake = stubDocker(fakeDocker({
      volumes: [{ name: VOLUME, labels: {} }, { name: 'someone_elses', labels: {} }],
      createNoop: true,
    }));
    const { pointId } = await seedPoint();
    runner.RecoveryEngineService.setEngineFactoryForTests(() => engineReturning({}) as never);
    service().markReadyForTests();

    const admitted = await service().admitRestore({
      nodeId,
      pointId,
      targetVolumeName: 'someone_elses',
      actor: 'alice',
      idempotencyKey: 'restore-2',
      requestDigest: runner.sha256Digest(['restore', pointId, 'someone_elses', 'new_volume']),
      transport: 'local',
      authorize: allowAll,
      authorizeCrossStack: allowAll,
    });
    await service().whenIdleForTests();

    expect(fake.removed).toEqual([]);
    expect(fake.volumes.has('someone_elses')).toBe(true);
    expect(intents.RestoreIntentStore.getInstance().getByOperation(admitted.operation.id)?.phase).toBe('rolled_back');
    expect(operations.RecoveryOperationStore.getInstance().get(admitted.operation.id)?.state).toBe('failed');
  });

  it('removes its own target after a failed restore, and only when nothing uses it', async () => {
    const fake = stubDocker(fakeDocker({ volumes: [{ name: VOLUME, labels: {} }] }));
    const { pointId } = await seedPoint();
    runner.RecoveryEngineService.setEngineFactoryForTests(() => engineReturning({
      restore: async () => ({ ok: false as const, errorClass: 'node_error' }),
    }) as never);
    service().markReadyForTests();

    const admitted = await service().admitRestore({
      nodeId,
      pointId,
      targetVolumeName: 'failed_target',
      actor: 'alice',
      idempotencyKey: 'restore-3',
      requestDigest: runner.sha256Digest(['restore', pointId, 'failed_target', 'new_volume']),
      transport: 'local',
      authorize: allowAll,
      authorizeCrossStack: allowAll,
    });
    await service().whenIdleForTests();

    expect(fake.removed).toEqual(['failed_target']);
    expect(intents.RestoreIntentStore.getInstance().getByOperation(admitted.operation.id)?.phase).toBe('rolled_back');
    expect(operations.RecoveryOperationStore.getInstance().get(admitted.operation.id))
      .toMatchObject({ state: 'failed', errorClass: 'node_error' });
  });

  it('reports an extended-attribute-only restore as partial and keeps the volume', async () => {
    const fake = stubDocker(fakeDocker({ volumes: [{ name: VOLUME, labels: {} }] }));
    const { pointId } = await seedPoint();
    runner.RecoveryEngineService.setEngineFactoryForTests(() => engineReturning({
      restore: async () => ({
        ok: true as const,
        evidence: { filesRestored: 2, bytesRestored: 20, verified: false, xattrWarnings: 3 },
      }),
    }) as never);
    service().markReadyForTests();

    const admitted = await service().admitRestore({
      nodeId,
      pointId,
      targetVolumeName: 'partial_target',
      actor: 'alice',
      idempotencyKey: 'restore-4',
      requestDigest: runner.sha256Digest(['restore', pointId, 'partial_target', 'new_volume']),
      transport: 'local',
      authorize: allowAll,
      authorizeCrossStack: allowAll,
    });
    await service().whenIdleForTests();

    expect(fake.removed).toEqual([]);
    expect(fake.volumes.has('partial_target')).toBe(true);
    expect(intents.RestoreIntentStore.getInstance().getByOperation(admitted.operation.id))
      .toMatchObject({ phase: 'committed', xattrWarnings: 3 });
    expect(operations.RecoveryOperationStore.getInstance().get(admitted.operation.id))
      .toMatchObject({ state: 'partial', errorClass: 'attributes_not_restored' });
  });
});

describe('a point whose volume no longer exists', () => {
  // `docker compose down -v` and a prune remove the volume; the point is what is
  // left, and every action on it has to work without the live volume.
  async function seedOrphanPoint(): Promise<{ pointId: string; storage: import('../services/recovery/types').StorageIdentity; repositoryId: string }> {
    const seeded = await seedProtectableVolume();
    const store = points.RecoveryPointStore.getInstance();
    const point = store.begin({
      kind: 'root',
      storageId: seeded.storage.id,
      expectedGenerationToken: 'token-1',
      repositoryId: seeded.repositoryId,
      trigger: 'manual',
      actor: 'alice',
      sourceOperationId: 'op-orphan',
      sourceNodeKey: ENGINE_KEY,
      engineId: 'restic',
    });
    store.finalize(point.id, {
      status: 'succeeded',
      evidence: { snapshotId: 'snap-o', capture: { fileCount: 1, byteCount: 1, skippedCount: 0 }, exclusions: [], consistency: 'unknown' },
    });
    return { pointId: point.id, storage: seeded.storage, repositoryId: seeded.repositoryId };
  }

  it('restores to a new volume', async () => {
    const fake = stubDocker(fakeDocker({ volumes: [] }));
    const { pointId } = await seedOrphanPoint();
    runner.RecoveryEngineService.setEngineFactoryForTests(() => engineReturning({}) as never);
    service().markReadyForTests();

    const admitted = await service().admitRestore({
      nodeId, pointId, targetVolumeName: 'rescued_data', actor: 'alice', idempotencyKey: 'orphan-restore',
      requestDigest: runner.sha256Digest(['restore', pointId, 'rescued_data', 'new_volume']),
      transport: 'local', authorize: allowAll, authorizeCrossStack: allowAll,
    });
    await service().whenIdleForTests();

    expect(operations.RecoveryOperationStore.getInstance().get(admitted.operation.id)?.state).toBe('succeeded');
    expect(fake.volumes.has('rescued_data')).toBe(true);
  });

  it('verifies', async () => {
    stubDocker(fakeDocker({ volumes: [] }));
    const { pointId } = await seedOrphanPoint();
    runner.RecoveryEngineService.setEngineFactoryForTests(() => engineReturning({}) as never);
    service().markReadyForTests();

    const admitted = await service().admitVerify({
      nodeId, pointId, actor: 'alice', idempotencyKey: 'orphan-verify',
      requestDigest: runner.sha256Digest(['verify_point', pointId, 'engine_check_metadata']),
      transport: 'local', method: 'engine_check_metadata', authorize: allowAll,
    });
    await service().whenIdleForTests();

    expect(operations.RecoveryOperationStore.getInstance().get(admitted.operation.id)?.state).toBe('succeeded');
  });

  it('still checks access against the stacks recorded for the volume', async () => {
    stubDocker(fakeDocker({ volumes: [] }));
    const { pointId, storage } = await seedOrphanPoint();
    runner.RecoveryEngineService.setEngineFactoryForTests(() => engineReturning({}) as never);
    service().markReadyForTests();
    const seen: Array<{ storageKey: string | null; stacks: string[] }> = [];

    await expect(service().admitRestore({
      nodeId, pointId, targetVolumeName: 'rescued_data', actor: 'mallory', idempotencyKey: 'orphan-denied',
      requestDigest: runner.sha256Digest(['restore', pointId, 'rescued_data', 'new_volume']),
      transport: 'local',
      authorize: (context) => {
        seen.push({ storageKey: context.storageKey, stacks: context.dependents.map((d) => d.stackName) });
        return false;
      },
      authorizeCrossStack: allowAll,
    })).rejects.toMatchObject({ errorClass: 'permission_denied' });
    // The recorded dependent is part of the decision even though no container or
    // volume label names it any more.
    expect(seen).toHaveLength(1);
    expect(seen[0].storageKey).toBe(storage.storageKey);
    expect(seen[0].stacks).toContain('stack-dir');
    expect(recoveryDbModule.recoveryDb().prepare('SELECT COUNT(*) AS n FROM recovery_operations').get())
      .toEqual({ n: 0 });
  });
});

describe('refused admissions can be retried with the same key', () => {
  async function seedVerifiablePoint(): Promise<{ pointId: string; repositoryId: string }> {
    const seeded = await seedProtectableVolume();
    const store = points.RecoveryPointStore.getInstance();
    const point = store.begin({
      kind: 'root', storageId: seeded.storage.id, expectedGenerationToken: 'token-1',
      repositoryId: seeded.repositoryId, trigger: 'manual', actor: 'alice', sourceOperationId: 'op-retry',
      sourceNodeKey: ENGINE_KEY, engineId: 'restic',
    });
    store.finalize(point.id, {
      status: 'succeeded',
      evidence: { snapshotId: 'snap-retry', capture: { fileCount: 1, byteCount: 1, skippedCount: 0 }, exclusions: [], consistency: 'unknown' },
    });
    return { pointId: point.id, repositoryId: seeded.repositoryId };
  }

  function holdRepository(repositoryId: string): () => void {
    const store = operations.RecoveryOperationStore.getInstance();
    const holder = store.start({
      idempotencyKey: `holder-${repositoryId}`, kind: 'verify_point', actor: 'alice', transport: 'local',
      requestDigest: runner.sha256Digest(['holder']),
    }).operation;
    store.markRunning(holder.id);
    store.acquireLock('repository', repositoryId, holder.id);
    return () => { store.finish(holder.id, { state: 'succeeded' }); };
  }

  it('for a verify', async () => {
    stubDocker(fakeDocker({ volumes: [{ name: VOLUME, labels: {} }] }));
    const { pointId, repositoryId } = await seedVerifiablePoint();
    runner.RecoveryEngineService.setEngineFactoryForTests(() => engineReturning({}) as never);
    service().markReadyForTests();
    const release = holdRepository(repositoryId);
    const request = {
      nodeId, pointId, actor: 'alice', idempotencyKey: 'verify-retry',
      requestDigest: runner.sha256Digest(['verify_point', pointId, 'engine_check_metadata']),
      transport: 'local' as const, method: 'engine_check_metadata' as const, authorize: allowAll,
    };

    await expect(service().admitVerify(request)).rejects.toMatchObject({ errorClass: 'lock_held' });
    expect(operations.RecoveryOperationStore.getInstance().findReplay({
      idempotencyKey: 'verify-retry', kind: 'verify_point', actor: 'alice', transport: 'local',
      requestDigest: request.requestDigest, pointId,
    })).toBeNull();

    release();
    const retried = await service().admitVerify(request);
    expect(retried.replayed).toBe(false);
    await service().whenIdleForTests();
    expect(operations.RecoveryOperationStore.getInstance().get(retried.operation.id)?.state).toBe('succeeded');
  });

  it('for a restore', async () => {
    const fake = stubDocker(fakeDocker({ volumes: [{ name: VOLUME, labels: {} }] }));
    const { pointId, repositoryId } = await seedVerifiablePoint();
    runner.RecoveryEngineService.setEngineFactoryForTests(() => engineReturning({}) as never);
    service().markReadyForTests();
    const release = holdRepository(repositoryId);
    const request = {
      nodeId, pointId, targetVolumeName: 'retry_target', actor: 'alice', idempotencyKey: 'restore-retry',
      requestDigest: runner.sha256Digest(['restore', pointId, 'retry_target', 'new_volume']),
      transport: 'local' as const, authorize: allowAll, authorizeCrossStack: allowAll,
    };

    await expect(service().admitRestore(request)).rejects.toMatchObject({ errorClass: 'lock_held' });
    // No intent was left behind to block the retry as a second live restore into
    // the same target, and no target volume was created.
    expect(recoveryDbModule.recoveryDb().prepare('SELECT COUNT(*) AS n FROM recovery_restore_intents').get())
      .toEqual({ n: 0 });
    expect(fake.created).toEqual([]);

    release();
    const retried = await service().admitRestore(request);
    expect(retried.replayed).toBe(false);
    await service().whenIdleForTests();
    expect(operations.RecoveryOperationStore.getInstance().get(retried.operation.id)?.state).toBe('succeeded');
    expect(fake.volumes.has('retry_target')).toBe(true);
  });
});

describe('restore target creation', () => {
  // A name the daemon rejects is the caller's; a socket proxy forbidding volume
  // creation is a missing capability; anything else is the node failing.
  it.each([
    [400, 'invalid_request'],
    [403, 'capability_unavailable'],
    [404, 'capability_unavailable'],
    [500, 'node_error'],
    [undefined, 'node_error'],
  ] as const)('reads a daemon answer of %s when creating the target as %s', async (statusCode, errorClass) => {
    const fake = stubDocker(fakeDocker({ volumes: [{ name: VOLUME, labels: {} }] }));
    fake.docker.createVolume = (async () => {
      throw Object.assign(new Error('create failed'), statusCode === undefined ? {} : { statusCode });
    }) as never;
    const seeded = await seedProtectableVolume();
    const store = points.RecoveryPointStore.getInstance();
    const point = store.begin({
      kind: 'root', storageId: seeded.storage.id, expectedGenerationToken: 'token-1',
      repositoryId: seeded.repositoryId, trigger: 'manual', actor: 'alice', sourceOperationId: 'op-name',
      sourceNodeKey: ENGINE_KEY, engineId: 'restic',
    });
    store.finalize(point.id, {
      status: 'succeeded',
      evidence: { snapshotId: 'snap-name', capture: { fileCount: 1, byteCount: 1, skippedCount: 0 }, exclusions: [], consistency: 'unknown' },
    });
    runner.RecoveryEngineService.setEngineFactoryForTests(() => engineReturning({}) as never);
    service().markReadyForTests();

    const admitted = await service().admitRestore({
      nodeId, pointId: point.id, targetVolumeName: 'name_the_daemon_rejects', actor: 'alice', idempotencyKey: 'restore-name',
      requestDigest: runner.sha256Digest(['restore', point.id, 'name_the_daemon_rejects', 'new_volume']),
      transport: 'local', authorize: allowAll, authorizeCrossStack: allowAll,
    });
    await service().whenIdleForTests();

    expect(operations.RecoveryOperationStore.getInstance().get(admitted.operation.id))
      .toMatchObject({ state: 'failed', errorClass });
  });
});

describe('admission refusals that say what is missing', () => {
  it('answers a capture on a node with no repository as not provisioned, not unreachable', async () => {
    stubDocker(fakeDocker({ volumes: [{ name: VOLUME, labels: {} }] }));
    service().markReadyForTests();

    await expect(service().admitCreatePoint({
      nodeId, volumeName: VOLUME, actor: 'alice', idempotencyKey: 'key-none',
      requestDigest: runner.sha256Digest(['create_point', VOLUME]), transport: 'local', authorize: allowAll,
    })).rejects.toMatchObject({
      errorClass: 'capability_unavailable',
      reason: 'repository_not_initialized',
    });
  });

  it('answers a restore of a point in a replaced repository as replaced, not unreachable', async () => {
    stubDocker(fakeDocker({ volumes: [{ name: VOLUME, labels: {} }] }));
    const seeded = await seedProtectableVolume();
    const store = points.RecoveryPointStore.getInstance();
    const point = store.begin({
      kind: 'root', storageId: seeded.storage.id, expectedGenerationToken: 'token-1',
      repositoryId: seeded.repositoryId, trigger: 'manual', actor: 'alice', sourceOperationId: 'op-old',
      sourceNodeKey: ENGINE_KEY, engineId: 'restic',
    });
    store.finalize(point.id, {
      status: 'succeeded',
      evidence: { snapshotId: 'snap-old', capture: { fileCount: 1, byteCount: 1, skippedCount: 0 }, exclusions: [], consistency: 'unknown' },
    });
    const repositories = repositoryStore.RecoveryRepositoryStore.getInstance();
    const replacement = repositories.register({
      ownerNodeKey: ENGINE_KEY, kind: 'local_volume', locator: 'sencho-recovery-test-g2',
      failureDomain: 'same_failure_domain',
    });
    repositories.storeSecret(replacement.id, 'password-2');
    repositories.setFingerprint(replacement.id, 'e'.repeat(32));
    repositories.setActive(replacement.id);
    service().markReadyForTests();

    await expect(service().admitRestore({
      nodeId, pointId: point.id, targetVolumeName: 'from_old', actor: 'alice', idempotencyKey: 'restore-old',
      requestDigest: runner.sha256Digest(['restore', point.id, 'from_old', 'new_volume']),
      transport: 'local', authorize: allowAll, authorizeCrossStack: allowAll,
    })).rejects.toMatchObject({ errorClass: 'repository_unavailable', reason: 'repository_replaced' });
  });
});

describe('readiness', () => {
  it('refuses work while boot has not finished', async () => {
    stubDocker(fakeDocker());
    await expect(service().admitCreatePoint({
      nodeId, volumeName: VOLUME, actor: 'alice', idempotencyKey: 'key-boot',
      requestDigest: runner.sha256Digest(['create_point', VOLUME]), transport: 'local', authorize: allowAll,
    })).rejects.toMatchObject({ errorClass: 'capability_unavailable', reason: 'engine_starting' });
  });
});
