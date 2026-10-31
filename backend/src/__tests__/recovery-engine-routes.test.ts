/**
 * The recovery HTTP surface: who may see what, the error contract, and the
 * admission refusals that have to happen before an answer.
 *
 * The engine is closed here (boot has not finished), so the mutating routes are
 * exercised for their gates rather than for a capture; the capture flows are in
 * the operation-runner tests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

vi.mock('../services/ComposeService', () => ({
  ComposeService: {
    getInstance: () => ({
      renderConfig: async (stackName: string) => ({
        rendered: JSON.stringify({
          name: stackName,
          services: { web: { name: 'web', image: 'nginx', storageMounts: [] } },
          networks: {},
          volumes: {},
        }),
        stderr: '',
        timedOut: false,
      }),
    }),
  },
}));

let tmpDir: string;
let app: import('express').Express;
let adminCookie: string;
let viewerCookie: string;
let engine: typeof import('../services/recovery/operationRunner');
let repositories: typeof import('../services/recovery/repositories');
let points: typeof import('../services/recovery/recoveryPoints');
let identityStore: typeof import('../services/recovery/storageIdentity');
let operations: typeof import('../services/recovery/operations');
let recoveryDbModule: typeof import('../services/recovery/recoveryDb');
let capability: typeof import('../services/recovery/capability');
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let nodeId: number;

const VIEWER = 'viewer-recovery';
const VIEWER_PASS = 'viewer-pass-123';

function service() {
  return engine.RecoveryEngineService.getInstance(nodeId);
}

/**
 * The route reads its descriptor through the capability registry, which is what
 * production registers at startup. Registering here keeps the projection tests
 * about the route rather than about startup.
 */
async function registerEngine(): Promise<void> {
  const instance = service();
  capability.registerBackupEngine({
    engineId: 'test',
    contractVersion: 1,
    storageKinds: ['named_volume'],
    probe: async () => ({ engineId: 'test', build: 'test', usable: true }),
    createPoint: async () => ({ ok: false, errorClass: 'internal' }),
    verifyPoint: async () => ({ ok: false, errorClass: 'internal' }),
    restore: async () => ({ ok: false, errorClass: 'internal' }),
  } as never, () => instance.health());
}

/** A Docker controller with the named volumes and no containers. */
async function stubDocker(volumeNames: string[] = []): Promise<void> {
  const DockerController = (await import('../services/DockerController')).default;
  const createdAt = new Date().toISOString();
  vi.spyOn(DockerController.prototype, 'getDocker').mockReturnValue({
    info: async () => ({ ID: 'engine-routes' }),
    listVolumes: async () => ({
      Volumes: volumeNames.map((Name) => ({ Name, Driver: 'local', Labels: {}, CreatedAt: createdAt })),
    }),
    listContainers: async () => [],
    getVolume: (name: string) => ({
      inspect: async () => {
        if (!volumeNames.includes(name)) {
          throw Object.assign(new Error('no such volume'), { statusCode: 404 });
        }
        return { Name: name, Driver: 'local', Labels: {}, CreatedAt: createdAt };
      },
    }),
    getImage: () => ({ inspect: async () => ({ Id: 'sha256:helper' }) }),
  } as unknown as import('dockerode'));
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  const index = await import('../index');
  app = index.app;
  DatabaseService = (await import('../services/DatabaseService')).DatabaseService;
  engine = await import('../services/recovery/operationRunner');
  repositories = await import('../services/recovery/repositories');
  points = await import('../services/recovery/recoveryPoints');
  identityStore = await import('../services/recovery/storageIdentity');
  operations = await import('../services/recovery/operations');
  recoveryDbModule = await import('../services/recovery/recoveryDb');
  capability = await import('../services/recovery/capability');
  nodeId = DatabaseService.getInstance().getDefaultNode()?.id ?? 1;
  adminCookie = await loginAsTestAdmin(app);
  const bcrypt = (await import('bcrypt')).default;
  DatabaseService.getInstance().addUser({
    username: VIEWER, password_hash: await bcrypt.hash(VIEWER_PASS, 1), role: 'viewer',
  });
  const login = await request(app).post('/api/auth/login').send({ username: VIEWER, password: VIEWER_PASS });
  expect(login.status).toBe(200);
  const cookies = login.headers['set-cookie'];
  viewerCookie = Array.isArray(cookies) ? cookies.join('; ') : String(cookies ?? '');
});

afterAll(async () => {
  await cleanupTestDb(tmpDir);
});

beforeEach(async () => {
  // A previous case's admitted operation may still be running; settle it before
  // the tables it reads are cleared.
  await engine.RecoveryEngineService.getInstance(nodeId).whenIdleForTests();
  engine.RecoveryEngineService.resetForTests();
  capability.resetBackupEnginesForTests();
  vi.restoreAllMocks();
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

function seedRepository(): string {
  const repository = repositories.RecoveryRepositoryStore.getInstance().register({
    ownerNodeKey: 'docker-engine:routes',
    kind: 'local_volume',
    locator: 'sencho-recovery-routes-g1',
    failureDomain: 'same_failure_domain',
  });
  repositories.RecoveryRepositoryStore.getInstance().storeSecret(repository.id, 'password');
  repositories.RecoveryRepositoryStore.getInstance().setFingerprint(repository.id, 'a'.repeat(32));
  repositories.RecoveryRepositoryStore.getInstance().setActive(repository.id);
  return repository.id;
}

describe('GET /api/recovery/node', () => {
  it('needs a signed-in caller', async () => {
    expect((await request(app).get('/api/recovery/node')).status).toBe(401);
  });
});

describe('GET /api/recovery/repository', () => {
  it('gives a stack reader the verdict but not the repository identity', async () => {
    seedRepository();
    service().markReadyForTests();
    await registerEngine();
    const res = await request(app).get('/api/recovery/repository').set('Cookie', viewerCookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      health: 'available',
      failureDomain: 'same_failure_domain',
      initialized: true,
    });
    expect(typeof res.body.warning).toBe('string');
    expect(res.body.warning).toContain('not an off-host copy');
    // Configuration facts are for system:settings only.
    expect(res.body.repository).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('sencho-recovery-routes-g1');
    expect(JSON.stringify(res.body)).not.toContain('password');
  });

  it('gives an administrator the locator, the fingerprint and the last check', async () => {
    const repositoryId = seedRepository();
    service().markReadyForTests();
    await registerEngine();
    points.RecoveryPointStore.getInstance().recordVerificationForRepository(
      repositoryId, 'engine_check_metadata', 'verified', null,
    );
    const res = await request(app).get('/api/recovery/repository').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.repository).toMatchObject({
      locator: 'sencho-recovery-routes-g1',
      fingerprint: 'a'.repeat(32),
      secretState: 'stored',
      lastCheck: { result: 'verified' },
    });
    expect(JSON.stringify(res.body)).not.toContain('enc:');
  });
});

describe('POST /api/recovery/repository', () => {
  it('needs system:settings', async () => {
    const res = await request(app).post('/api/recovery/repository').set('Cookie', viewerCookie)
      .send({ idempotencyKey: randomUUID() });
    expect(res.status).toBe(403);
  });

  it('answers 503 with the boot reason while the engine is still starting', async () => {
    const res = await request(app).post('/api/recovery/repository').set('Cookie', adminCookie)
      .send({ idempotencyKey: randomUUID() });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      errorClass: 'capability_unavailable',
      code: 'CAPABILITY_UNAVAILABLE',
      reason: 'engine_starting',
    });
  });

  it('rejects a body without an idempotency key', async () => {
    service().markReadyForTests();
    const res = await request(app).post('/api/recovery/repository').set('Cookie', adminCookie).send({});
    expect(res.status).toBe(400);
    expect(res.body.errorClass).toBe('invalid_request');
  });
});

describe('POST /api/recovery/storage/points', () => {
  it('needs protect access, so a viewer is refused', async () => {
    seedRepository();
    service().markReadyForTests();
    await stubDocker(['app_data']);
    const res = await request(app).post('/api/recovery/storage/points').set('Cookie', viewerCookie)
      .send({ volumeName: 'app_data', idempotencyKey: randomUUID() });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
    // A denial never names a stack.
    expect(JSON.stringify(res.body)).not.toContain('stack');
  });

  it('admits a capture with the failure domain and the warning sentence', async () => {
    seedRepository();
    service().markReadyForTests();
    await stubDocker(['app_data']);
    await registerEngine();
    service().setHelperRunnerForTests({
      run: async (spec: { profile: string; onStdoutLine?: (line: string) => void }) => {
        if (spec.profile === 'probe' && spec.onStdoutLine) {
          spec.onStdoutLine(JSON.stringify({ dev: 1, ino: 2, uid: 0, gid: 0, mode: 16877 }));
          return { exitCode: 0, stderrTail: '', aborted: false, killed: false };
        }
        return { exitCode: 1, stderrTail: '', aborted: false, killed: false };
      },
      removeForeignEpochHelpers: async () => 0,
    } as never);
    engine.RecoveryEngineService.setEngineFactoryForTests(() => ({
      engineId: 'fake',
      contractVersion: 1,
      storageKinds: ['named_volume'],
      probe: async () => ({ engineId: 'fake', build: 'test', usable: true }),
      createPoint: async () => ({
        ok: true as const,
        evidence: {
          snapshotId: 'snap-route',
          capture: { fileCount: 1, byteCount: 1, skippedCount: 0 },
          exclusions: [],
          consistency: 'crash_consistent_stopped',
        },
      }),
      verifyPoint: async () => ({ ok: true as const, evidence: { result: 'verified' } }),
      restore: async () => ({ ok: false as const, errorClass: 'internal' }),
    }) as never);

    const res = await request(app).post('/api/recovery/storage/points').set('Cookie', adminCookie)
      .send({ volumeName: 'app_data', idempotencyKey: randomUUID() });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      failureDomain: 'same_failure_domain',
      warning: expect.stringContaining('not an off-host copy'),
    });
    expect(res.body.operation.kind).toBe('create_point');
    await service().whenIdleForTests();
    const polled = await request(app).get(`/api/recovery/operations/${res.body.operation.id}`)
      .set('Cookie', adminCookie);
    expect(polled.body.operation.state).toBe('succeeded');
    expect(polled.body.result.point.status).toBe('succeeded');
  });

  it('answers 503 before boot finishes, even for an administrator', async () => {
    const res = await request(app).post('/api/recovery/storage/points').set('Cookie', adminCookie)
      .send({ volumeName: 'app_data', idempotencyKey: randomUUID() });
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe('engine_starting');
  });
});

describe('POST /api/recovery/points/:id/restore', () => {
  async function seedPoint(): Promise<string> {
    const repositoryId = seedRepository();
    const storage = identityStore.StorageIdentityStore.getInstance().observe({
      ownerNodeKey: 'docker-engine:routes',
      kind: 'named_volume',
      locator: 'app_data',
      generationToken: 't1',
      dependents: [],
    });
    const point = points.RecoveryPointStore.getInstance().begin({
      kind: 'root',
      storageId: storage.id,
      expectedGenerationToken: 't1',
      repositoryId,
      trigger: 'manual',
      actor: 'admin',
      sourceOperationId: 'op-src',
      sourceNodeKey: 'docker-engine:routes',
      engineId: 'restic',
    });
    points.RecoveryPointStore.getInstance().finalize(point.id, {
      status: 'succeeded',
      evidence: { snapshotId: 'snap', capture: { fileCount: 1, byteCount: 1, skippedCount: 0 }, exclusions: [], consistency: 'unknown' },
    });
    return point.id;
  }

  it('refuses a target name Sencho reserves', async () => {
    service().markReadyForTests();
    const pointId = await seedPoint();
    const res = await request(app).post(`/api/recovery/points/${pointId}/restore`).set('Cookie', adminCookie)
      .send({ targetVolumeName: 'sencho-recovery-abc-g1', idempotencyKey: randomUUID() });
    expect(res.status).toBe(400);
    expect(res.body.errorClass).toBe('invalid_request');
  });

  it('refuses a mode this release does not implement', async () => {
    service().markReadyForTests();
    const pointId = await seedPoint();
    for (const targetMode of ['new_path', 'staged_overwrite'] as const) {
      const res = await request(app).post(`/api/recovery/points/${pointId}/restore`).set('Cookie', adminCookie)
        .send({ targetVolumeName: 'fresh_target', targetMode, idempotencyKey: randomUUID() });
      expect(res.status, targetMode).toBe(400);
      expect(res.body.errorClass, targetMode).toBe('invalid_request');
    }
  });

  it('refuses a target that already exists, leaving it untouched', async () => {
    service().markReadyForTests();
    const pointId = await seedPoint();
    const DockerController = (await import('../services/DockerController')).default;
    vi.spyOn(DockerController.prototype, 'getDocker').mockReturnValue({
      getVolume: () => ({
        inspect: async () => ({ Name: 'existing', Driver: 'local', Labels: {}, CreatedAt: new Date().toISOString() }),
      }),
    } as unknown as import('dockerode'));
    const res = await request(app).post(`/api/recovery/points/${pointId}/restore`).set('Cookie', adminCookie)
      .send({ targetVolumeName: 'existing', idempotencyKey: randomUUID() });
    expect(res.status).toBe(400);
    expect(res.body.errorClass).toBe('invalid_request');
  });
});

describe('restore replay', () => {
  it('returns the operation an earlier request made, even after it created the target', async () => {
    seedRepository();
    service().markReadyForTests();
    await stubDocker(['app_data']);
    await registerEngine();
    service().setHelperRunnerForTests({
      run: async (spec: { profile: string; onStdoutLine?: (line: string) => void }) => {
        if (spec.profile === 'probe' && spec.onStdoutLine) {
          spec.onStdoutLine(JSON.stringify({ dev: 1, ino: 2, uid: 0, gid: 0, mode: 16877 }));
        }
        return { exitCode: 0, stderrTail: '', aborted: false, killed: false };
      },
      removeForeignEpochHelpers: async () => 0,
    } as never);
    engine.RecoveryEngineService.setEngineFactoryForTests(() => ({
      engineId: 'fake',
      contractVersion: 1,
      storageKinds: ['named_volume'],
      probe: async () => ({ engineId: 'fake', build: 'test', usable: true }),
      createPoint: async () => ({ ok: false as const, errorClass: 'internal' }),
      verifyPoint: async () => ({ ok: false as const, errorClass: 'internal' }),
      restore: async () => ({
        ok: true as const,
        evidence: { filesRestored: 1, bytesRestored: 1, verified: true },
      }),
    }) as never);

    const storage = identityStore.StorageIdentityStore.getInstance().observe({
      ownerNodeKey: 'docker-engine:engine-routes',
      kind: 'named_volume',
      locator: 'app_data',
      generationToken: 'tok',
      dependents: [],
    });
    const point = points.RecoveryPointStore.getInstance().begin({
      kind: 'root',
      storageId: storage.id,
      expectedGenerationToken: 'tok',
      repositoryId: repositories.RecoveryRepositoryStore.getInstance().getActive()?.id ?? '',
      trigger: 'manual',
      actor: 'admin',
      sourceOperationId: 'op-src',
      sourceNodeKey: 'docker-engine:engine-routes',
      engineId: 'restic',
    });
    points.RecoveryPointStore.getInstance().finalize(point.id, {
      status: 'succeeded',
      evidence: { snapshotId: 'snap', capture: { fileCount: 1, byteCount: 1, skippedCount: 0 }, exclusions: [], consistency: 'unknown' },
    });

    const key = randomUUID();
    const first = await request(app).post(`/api/recovery/points/${point.id}/restore`).set('Cookie', adminCookie)
      .send({ targetVolumeName: 'fresh_target', idempotencyKey: key });
    expect(first.status).toBe(202);

    // The retry happens after the first attempt created the volume, which is
    // exactly when the target-existence check would otherwise answer 400.
    const replay = await request(app).post(`/api/recovery/points/${point.id}/restore`).set('Cookie', adminCookie)
      .send({ targetVolumeName: 'fresh_target', idempotencyKey: key });
    expect(replay.status).toBe(200);
    expect(replay.body.operation.id).toBe(first.body.operation.id);
    await service().whenIdleForTests();
  });
});

describe('GET /api/recovery/operations/:id', () => {
  it('keeps a repository_init operation on system:settings', async () => {
    const operation = operations.RecoveryOperationStore.getInstance().start({
      idempotencyKey: randomUUID(),
      kind: 'repository_init',
      actor: 'admin',
      transport: 'local',
      requestDigest: engine.sha256Digest(['repository_init', 'provision']),
    });
    const viewer = await request(app).get(`/api/recovery/operations/${operation.operation.id}`).set('Cookie', viewerCookie);
    expect(viewer.status).toBe(403);
    const admin = await request(app).get(`/api/recovery/operations/${operation.operation.id}`).set('Cookie', adminCookie);
    expect(admin.status).toBe(200);
    expect(admin.body.operation.kind).toBe('repository_init');
  });

  it('answers invalid_request for an operation that does not exist', async () => {
    const res = await request(app).get(`/api/recovery/operations/${randomUUID()}`).set('Cookie', adminCookie);
    expect(res.status).toBe(400);
  });

  it('refuses to cancel a repository_init operation', async () => {
    const operation = operations.RecoveryOperationStore.getInstance().start({
      idempotencyKey: randomUUID(),
      kind: 'repository_init',
      actor: 'admin',
      transport: 'local',
      requestDigest: engine.sha256Digest(['repository_init', 'provision']),
    });
    const res = await request(app).post(`/api/recovery/operations/${operation.operation.id}/cancel`).set('Cookie', adminCookie);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe('not_cancellable');
  });
});

describe('POST /api/recovery/locks/release', () => {
  it('refuses a live lock, which belongs to its owner', async () => {
    const operation = operations.RecoveryOperationStore.getInstance().start({
      idempotencyKey: randomUUID(),
      kind: 'create_point',
      actor: 'admin',
      transport: 'local',
      requestDigest: engine.sha256Digest(['create_point', 'v']),
    });
    operations.RecoveryOperationStore.getInstance().markRunning(operation.operation.id);
    const repositoryId = seedRepository();
    operations.RecoveryOperationStore.getInstance().acquireLock('repository', repositoryId, operation.operation.id);
    const res = await request(app).post('/api/recovery/locks/release').set('Cookie', adminCookie)
      .send({ scope: 'repository', resourceKey: repositoryId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LOCK_HELD');
  });

  it('releases a stale lock after review', async () => {
    const operation = operations.RecoveryOperationStore.getInstance().start({
      idempotencyKey: randomUUID(),
      kind: 'create_point',
      actor: 'admin',
      transport: 'local',
      requestDigest: engine.sha256Digest(['create_point', 'v']),
    });
    operations.RecoveryOperationStore.getInstance().markRunning(operation.operation.id);
    const repositoryId = seedRepository();
    operations.RecoveryOperationStore.getInstance().acquireLock('repository', repositoryId, operation.operation.id);
    operations.RecoveryOperationStore.getInstance().finish(operation.operation.id, { state: 'completion_unknown' });
    const res = await request(app).post('/api/recovery/locks/release').set('Cookie', adminCookie)
      .send({ scope: 'repository', resourceKey: repositoryId });
    expect(res.status).toBe(200);
    expect(res.body.released).toMatchObject({ scope: 'repository', resourceKey: repositoryId });
    expect(operations.RecoveryOperationStore.getInstance().getLock('repository', repositoryId)).toBeNull();
  });

  it('needs system:settings for a repository lock', async () => {
    const res = await request(app).post('/api/recovery/locks/release').set('Cookie', viewerCookie)
      .send({ scope: 'repository', resourceKey: 'whatever' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/recovery/storage', () => {
  it('answers with the verdict and no roots on a node with no volumes', async () => {
    service().markReadyForTests();
    await registerEngine();
    await stubDocker();
    const res = await request(app).get('/api/recovery/storage').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('verdict');
    expect(res.body.roots).toEqual([]);
    expect(res.body.verdict.reason).toBe('no_qualifying_storage');
  });

  it('counts only points from the active repository', async () => {
    service().markReadyForTests();
    await registerEngine();
    await stubDocker(['app_data']);
    const authorityId = (await import('../services/recovery/recoveryDb')).getRecoveryAuthorityId();
    void authorityId;
    // Two repositories: one active, one left behind by a replace.
    const active = repositories.RecoveryRepositoryStore.getInstance().register({
      ownerNodeKey: 'docker-engine:routes', kind: 'local_volume', locator: 'active-repo', failureDomain: 'same_failure_domain',
    });
    repositories.RecoveryRepositoryStore.getInstance().storeSecret(active.id, 'pw');
    repositories.RecoveryRepositoryStore.getInstance().setFingerprint(active.id, 'b'.repeat(32));
    repositories.RecoveryRepositoryStore.getInstance().setActive(active.id);
    const old = repositories.RecoveryRepositoryStore.getInstance().register({
      ownerNodeKey: 'docker-engine:old', kind: 'local_volume', locator: 'old-repo', failureDomain: 'same_failure_domain',
    });
    repositories.RecoveryRepositoryStore.getInstance().storeSecret(old.id, 'pw');
    repositories.RecoveryRepositoryStore.getInstance().setFingerprint(old.id, 'c'.repeat(32));

    const storage = (await import('../services/recovery/storageIdentity')).StorageIdentityStore.getInstance().observe({
      ownerNodeKey: 'docker-engine:engine-routes',
      kind: 'named_volume',
      locator: 'app_data',
      generationToken: 'tok',
      dependents: [],
    });
    const makePoint = (repositoryId: string, kind: 'root' | 'path') => {
      const point = points.RecoveryPointStore.getInstance().begin({
        kind,
        ...(kind === 'path' ? { pathScope: 'sub' } : {}),
        storageId: storage.id,
        expectedGenerationToken: 'tok',
        repositoryId,
        trigger: 'manual',
        actor: 'admin',
        sourceOperationId: `op-${repositoryId}-${kind}`,
        sourceNodeKey: 'docker-engine:routes',
        engineId: 'restic',
      } as never);
      points.RecoveryPointStore.getInstance().finalize(point.id, {
        status: 'succeeded',
        evidence: { snapshotId: `snap-${kind}`, capture: { fileCount: 1, byteCount: 1, skippedCount: 0 }, exclusions: [], consistency: 'unknown' },
      });
      points.RecoveryPointStore.getInstance().recordVerificationForRepository(
        repositoryId, 'engine_check_metadata', 'verified', null,
      );
      return point;
    };
    makePoint(old.id, 'root');
    makePoint(active.id, 'path');

    const stale = await request(app).get('/api/recovery/storage').set('Cookie', adminCookie);
    const staleRoot = (stale.body.roots as Array<{ volumeName?: string; coverage?: string }>)
      .find((root) => root.volumeName === 'app_data');
    // The old repository point and the active repository path point both fail to cover.
    expect(staleRoot?.coverage).toBe('no_point');

    makePoint(active.id, 'root');
    const fresh = await request(app).get('/api/recovery/storage').set('Cookie', adminCookie);
    const freshRoot = (fresh.body.roots as Array<{ volumeName?: string; coverage?: string }>)
      .find((root) => root.volumeName === 'app_data');
    expect(freshRoot?.coverage).toBe('covered');
  });

  it('checks the stack permission before listing a named stack', async () => {
    service().markReadyForTests();
    await stubDocker();
    const res = await request(app).get('/api/recovery/storage?stack=no-such-stack').set('Cookie', viewerCookie);
    // The viewer holds stack:read, so the read is allowed and simply finds nothing.
    expect(res.status).toBe(200);
    await stubDocker();
    const { ROLE_PERMISSIONS } = await import('../middleware/permissions');
    const original = [...ROLE_PERMISSIONS.viewer];
    ROLE_PERMISSIONS.viewer.splice(0, ROLE_PERMISSIONS.viewer.length, ...original.filter((a) => a !== 'stack:read'));
    try {
      const denied = await request(app).get('/api/recovery/storage?stack=no-such-stack').set('Cookie', viewerCookie);
      expect(denied.status).toBe(403);
    } finally {
      ROLE_PERMISSIONS.viewer.splice(0, ROLE_PERMISSIONS.viewer.length, ...original);
    }
  });
});

describe('input the daemon would reject', () => {
  async function operationRows(): Promise<number> {
    return (recoveryDbModule.recoveryDb().prepare('SELECT COUNT(*) AS n FROM recovery_operations').get() as { n: number }).n;
  }

  const BAD_NAMES = ['a b;rm -rf', 'x/../y', '../../etc', 'with\u0000nul', 'café_data', '.hidden', 'a'];

  it('answers 400 for a volume name Docker rejects, before an operation row exists', async () => {
    seedRepository();
    service().markReadyForTests();
    await stubDocker(['app_data']);
    for (const volumeName of BAD_NAMES) {
      const res = await request(app).post('/api/recovery/storage/points').set('Cookie', adminCookie)
        .send({ volumeName, idempotencyKey: randomUUID() });
      expect(res.status, volumeName).toBe(400);
      expect(res.body.errorClass, volumeName).toBe('invalid_request');
    }
    expect(await operationRows()).toBe(0);
  });

  it('answers 400 for a restore target Docker rejects, before an operation row exists', async () => {
    const repositoryId = seedRepository();
    service().markReadyForTests();
    await stubDocker([]);
    const storage = identityStore.StorageIdentityStore.getInstance().observe({
      ownerNodeKey: 'docker-engine:routes', kind: 'named_volume', locator: 'app_data',
      generationToken: 't1', dependents: [],
    });
    const point = points.RecoveryPointStore.getInstance().begin({
      kind: 'root', storageId: storage.id, expectedGenerationToken: 't1', repositoryId, trigger: 'manual',
      actor: 'admin', sourceOperationId: 'op-names', sourceNodeKey: 'docker-engine:routes', engineId: 'restic',
    });
    points.RecoveryPointStore.getInstance().finalize(point.id, {
      status: 'succeeded',
      evidence: { snapshotId: 'snap', capture: { fileCount: 1, byteCount: 1, skippedCount: 0 }, exclusions: [], consistency: 'unknown' },
    });
    for (const targetVolumeName of BAD_NAMES) {
      const res = await request(app).post(`/api/recovery/points/${point.id}/restore`).set('Cookie', adminCookie)
        .send({ targetVolumeName, idempotencyKey: randomUUID() });
      expect(res.status, targetVolumeName).toBe(400);
      expect(res.body.errorClass, targetVolumeName).toBe('invalid_request');
    }
    expect(await operationRows()).toBe(0);
    expect(recoveryDbModule.recoveryDb().prepare('SELECT COUNT(*) AS n FROM recovery_restore_intents').get())
      .toEqual({ n: 0 });
  });

  it('answers an unknown stack with an empty listing and a malformed one with 400', async () => {
    service().markReadyForTests();
    await registerEngine();
    await stubDocker(['app_data']);
    const unknown = await request(app).get('/api/recovery/storage?stack=nonexistent-stack').set('Cookie', adminCookie);
    expect(unknown.status).toBe(200);
    expect(unknown.body.roots).toEqual([]);
    for (const query of ['stack=../x', 'stack=a&stack=b', 'stack=a%00b', 'stack=a%2Fb']) {
      const res = await request(app).get(`/api/recovery/storage?${query}`).set('Cookie', adminCookie);
      expect(res.status, query).toBe(400);
      expect(res.body.errorClass, query).toBe('invalid_request');
    }
  });
});

describe('a point whose volume was removed', () => {
  async function seedOrphan(): Promise<{ storageId: string; storageKey: string; pointId: string; repositoryId: string }> {
    const repositoryId = seedRepository();
    const storage = identityStore.StorageIdentityStore.getInstance().observe({
      ownerNodeKey: 'docker-engine:engine-routes', kind: 'named_volume', locator: 'gone_data',
      generationToken: 'created|1:2', dependents: [],
    });
    const point = points.RecoveryPointStore.getInstance().begin({
      kind: 'root', storageId: storage.id, expectedGenerationToken: 'created|1:2', repositoryId,
      trigger: 'manual', actor: 'admin', sourceOperationId: 'op-gone',
      sourceNodeKey: 'docker-engine:engine-routes', engineId: 'restic',
    });
    points.RecoveryPointStore.getInstance().finalize(point.id, {
      status: 'succeeded',
      evidence: { snapshotId: 'snap', capture: { fileCount: 1, byteCount: 1, skippedCount: 0 }, exclusions: [], consistency: 'unknown' },
    });
    return { storageId: storage.id, storageKey: storage.storageKey, pointId: point.id, repositoryId };
  }

  it('still lists its points', async () => {
    const { storageId, pointId } = await seedOrphan();
    service().markReadyForTests();
    await stubDocker([]);
    const res = await request(app).get(`/api/recovery/storage/${storageId}/points`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.storage.locator).toBe('gone_data');
    expect(res.body.points.map((entry: { point: { id: string } }) => entry.point.id)).toEqual([pointId]);
  });

  it('still restores to a new name', async () => {
    const { pointId } = await seedOrphan();
    service().markReadyForTests();
    await stubDocker([]);
    await registerEngine();
    engine.RecoveryEngineService.setEngineFactoryForTests(() => ({
      engineId: 'fake', contractVersion: 1, storageKinds: ['named_volume'],
      probe: async () => ({ engineId: 'fake', build: 'test', usable: true }),
      createPoint: async () => ({ ok: false as const, errorClass: 'internal' }),
      verifyPoint: async () => ({ ok: true as const, evidence: { result: 'verified' } }),
      restore: async () => ({ ok: true as const, evidence: { filesRestored: 1, bytesRestored: 1, verified: true } }),
    }) as never);
    // The source volume is gone; the target is created by the background restore.
    const DockerController = (await import('../services/DockerController')).default;
    const createdAt = new Date().toISOString();
    const volumes = new Map<string, Record<string, string>>();
    vi.spyOn(DockerController.prototype, 'getDocker').mockReturnValue({
      info: async () => ({ ID: 'engine-routes' }),
      listVolumes: async () => ({ Volumes: [] }),
      listContainers: async () => [],
      createVolume: async (spec: { Name: string; Labels?: Record<string, string> }) => {
        volumes.set(spec.Name, spec.Labels ?? {});
        return { Name: spec.Name };
      },
      getVolume: (name: string) => ({
        inspect: async () => {
          const labels = volumes.get(name);
          if (!labels) throw Object.assign(new Error('no such volume'), { statusCode: 404 });
          return { Name: name, Driver: 'local', Labels: labels, CreatedAt: createdAt };
        },
      }),
    } as unknown as import('dockerode'));
    const res = await request(app).post(`/api/recovery/points/${pointId}/restore`).set('Cookie', adminCookie)
      .send({ targetVolumeName: 'rescued_data', idempotencyKey: randomUUID() });
    expect(res.status).toBe(202);
    await service().whenIdleForTests();
    const polled = await request(app).get(`/api/recovery/operations/${res.body.operation.id}`).set('Cookie', adminCookie);
    expect(polled.body.operation.state).toBe('succeeded');
    expect(volumes.has('rescued_data')).toBe(true);
  });

  it('still verifies', async () => {
    const { pointId } = await seedOrphan();
    service().markReadyForTests();
    await stubDocker([]);
    await registerEngine();
    engine.RecoveryEngineService.setEngineFactoryForTests(() => ({
      engineId: 'fake', contractVersion: 1, storageKinds: ['named_volume'],
      probe: async () => ({ engineId: 'fake', build: 'test', usable: true }),
      createPoint: async () => ({ ok: false as const, errorClass: 'internal' }),
      verifyPoint: async () => ({ ok: true as const, evidence: { result: 'verified' } }),
      restore: async () => ({ ok: false as const, errorClass: 'internal' }),
    }) as never);
    const res = await request(app).post(`/api/recovery/points/${pointId}/verify`).set('Cookie', adminCookie)
      .send({ idempotencyKey: randomUUID() });
    expect(res.status).toBe(202);
    await service().whenIdleForTests();
  });

  it('still releases its stale storage lock', async () => {
    const { storageKey, repositoryId } = await seedOrphan();
    service().markReadyForTests();
    await stubDocker([]);
    const store = operations.RecoveryOperationStore.getInstance();
    const stuck = store.start({
      idempotencyKey: randomUUID(), kind: 'create_point', actor: 'admin', transport: 'local',
      requestDigest: engine.sha256Digest(['create_point', 'gone_data']),
    }).operation;
    store.markRunning(stuck.id);
    store.acquireLock('storage', storageKey, stuck.id);
    store.finish(stuck.id, { state: 'completion_unknown' });
    const res = await request(app).post('/api/recovery/locks/release').set('Cookie', adminCookie)
      .send({ scope: 'storage', resourceKey: storageKey });
    expect(res.status).toBe(200);
    expect(store.getLock('storage', storageKey)).toBeNull();
    expect(repositoryId).toBeTruthy();
  });
});

describe('coverage of a volume that was recreated', () => {
  it('stops counting the old point as soon as Docker reports a new volume, without a capture', async () => {
    const repositoryId = seedRepository();
    service().markReadyForTests();
    await registerEngine();
    const storage = identityStore.StorageIdentityStore.getInstance().observe({
      ownerNodeKey: 'docker-engine:engine-routes', kind: 'named_volume', locator: 'app_data',
      generationToken: '2026-10-31T10:00:00Z|63:42', dependents: [],
    });
    const point = points.RecoveryPointStore.getInstance().begin({
      kind: 'root', storageId: storage.id, expectedGenerationToken: '2026-10-31T10:00:00Z|63:42',
      repositoryId, trigger: 'manual', actor: 'admin', sourceOperationId: 'op-covered',
      sourceNodeKey: 'docker-engine:engine-routes', engineId: 'restic',
    });
    points.RecoveryPointStore.getInstance().finalize(point.id, {
      status: 'succeeded',
      evidence: { snapshotId: 'snap', capture: { fileCount: 1, byteCount: 1, skippedCount: 0 }, exclusions: [], consistency: 'unknown' },
    });
    points.RecoveryPointStore.getInstance().recordVerificationForRepository(
      repositoryId, 'engine_check_metadata', 'verified', null,
    );

    const DockerController = (await import('../services/DockerController')).default;
    const dockerAt = (createdAt: string) => ({
      info: async () => ({ ID: 'engine-routes' }),
      listVolumes: async () => ({
        Volumes: [{ Name: 'app_data', Driver: 'local', Labels: {}, CreatedAt: createdAt }],
      }),
      listContainers: async () => [],
      getVolume: () => ({
        inspect: async () => ({ Name: 'app_data', Driver: 'local', Labels: {}, CreatedAt: createdAt }),
      }),
    } as unknown as import('dockerode'));
    const rootOf = async (url: string) => {
      const res = await request(app).get(url).set('Cookie', adminCookie);
      expect(res.status).toBe(200);
      return (res.body.roots as Array<{ volumeName?: string; coverage?: string; coveringPointId?: string | null }>)
        .find((root) => root.volumeName === 'app_data');
    };

    vi.spyOn(DockerController.prototype, 'getDocker').mockReturnValue(dockerAt('2026-10-31T10:00:00Z'));
    expect((await rootOf('/api/recovery/storage'))?.coverage).toBe('covered');

    // `down -v` then `up`: same name, new volume, new creation time.
    vi.spyOn(DockerController.prototype, 'getDocker').mockReturnValue(dockerAt('2026-10-31T11:30:00Z'));
    const recreated = await rootOf('/api/recovery/storage');
    expect(recreated?.coverage).toBe('older_generation');
    expect(recreated?.coveringPointId).toBeNull();
    const verdict = await request(app).get('/api/recovery/storage').set('Cookie', adminCookie);
    expect(verdict.body.verdict.state).toBe('unprotected');
  });
});

describe('a refused request can be sent again', () => {
  it('runs the same capture key after the lock that refused it is released', async () => {
    const repositoryId = seedRepository();
    service().markReadyForTests();
    await stubDocker(['app_data']);
    await registerEngine();
    service().setHelperRunnerForTests({
      run: async (spec: { profile: string; onStdoutLine?: (line: string) => void }) => {
        if (spec.profile === 'probe' && spec.onStdoutLine) {
          spec.onStdoutLine(JSON.stringify({ dev: 1, ino: 2, uid: 0, gid: 0, mode: 16877 }));
        }
        return { exitCode: 0, stderrTail: '', aborted: false, killed: false };
      },
      removeForeignEpochHelpers: async () => 0,
    } as never);
    engine.RecoveryEngineService.setEngineFactoryForTests(() => ({
      engineId: 'fake', contractVersion: 1, storageKinds: ['named_volume'],
      probe: async () => ({ engineId: 'fake', build: 'test', usable: true }),
      createPoint: async () => ({
        ok: true as const,
        evidence: { snapshotId: 'snap-retry', capture: { fileCount: 1, byteCount: 1, skippedCount: 0 }, exclusions: [], consistency: 'crash_consistent_stopped' },
      }),
      verifyPoint: async () => ({ ok: true as const, evidence: { result: 'verified' } }),
      restore: async () => ({ ok: false as const, errorClass: 'internal' }),
    }) as never);

    const store = operations.RecoveryOperationStore.getInstance();
    const holder = store.start({
      idempotencyKey: randomUUID(), kind: 'verify_point', actor: 'admin', transport: 'local',
      requestDigest: engine.sha256Digest(['holder']),
    }).operation;
    store.markRunning(holder.id);
    store.acquireLock('repository', repositoryId, holder.id);

    const key = randomUUID();
    const refused = await request(app).post('/api/recovery/storage/points').set('Cookie', adminCookie)
      .send({ volumeName: 'app_data', idempotencyKey: key });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ errorClass: 'lock_held', code: 'LOCK_HELD' });
    expect(refused.body.error).toContain('on this node');

    store.finish(holder.id, { state: 'succeeded' });
    const retried = await request(app).post('/api/recovery/storage/points').set('Cookie', adminCookie)
      .send({ volumeName: 'app_data', idempotencyKey: key });
    // 202, not a 200 replay of a failed operation that never ran.
    expect(retried.status).toBe(202);
    await service().whenIdleForTests();
    const polled = await request(app).get(`/api/recovery/operations/${retried.body.operation.id}`)
      .set('Cookie', adminCookie);
    expect(polled.body.operation.state).toBe('succeeded');
  });
});

describe('one error shape', () => {
  it('answers a refused permission with errorClass and code, on every route that checks one', async () => {
    seedRepository();
    service().markReadyForTests();
    await stubDocker([]);
    const refusals = [
      await request(app).post('/api/recovery/repository').set('Cookie', viewerCookie).send({ idempotencyKey: randomUUID() }),
      await request(app).post('/api/recovery/locks/release').set('Cookie', viewerCookie)
        .send({ scope: 'repository', resourceKey: 'x' }),
    ];
    for (const res of refusals) {
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ errorClass: 'permission_denied', code: 'PERMISSION_DENIED' });
      expect(typeof res.body.error).toBe('string');
    }
  });

  it('answers a capture with no repository as not provisioned', async () => {
    service().markReadyForTests();
    await stubDocker(['app_data']);
    const res = await request(app).post('/api/recovery/storage/points').set('Cookie', adminCookie)
      .send({ volumeName: 'app_data', idempotencyKey: randomUUID() });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      errorClass: 'capability_unavailable',
      reason: 'repository_not_initialized',
    });
    expect(res.body.error).toContain('no recovery repository');
  });
});

describe('audit summaries', () => {
  it('names each recovery action without naming any captured data', async () => {
    const { getAuditSummary } = await import('../utils/audit-summaries');
    expect(getAuditSummary('POST', 'recovery/repository')).toBe('Provisioned recovery repository');
    expect(getAuditSummary('POST', 'recovery/storage/points')).toBe('Created a recovery point');
    expect(getAuditSummary('POST', 'recovery/points/abc/verify')).toBe('Verified recovery point: abc');
    expect(getAuditSummary('POST', 'recovery/points/abc/restore')).toBe('Restored recovery point: abc');
    expect(getAuditSummary('POST', 'recovery/locks/release')).toBe('Released a stale recovery lock');
  });
});
