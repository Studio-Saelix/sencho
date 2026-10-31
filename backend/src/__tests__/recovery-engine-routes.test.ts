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

beforeEach(() => {
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
