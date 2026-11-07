/**
 * Browsing and downloading a saved recovery point.
 *
 * The engine is a fake here: these cases are about the HTTP contract, the
 * authorization the routes run, the evidence they attach and the streaming
 * behaviour (a body the caller stops, a body that ends short, a file past the
 * bound). The restic adapter's own mapping is in
 * recovery-restic-contents.test.ts, and the real helper round trip is the
 * docker-integration suite.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

vi.mock('../services/ComposeService', () => ({
  ComposeService: {
    getInstance: () => ({
      renderConfig: async (stackName: string) => ({
        rendered: JSON.stringify({ name: stackName, services: {}, networks: {}, volumes: {} }),
        stderr: '',
        timedOut: false,
      }),
    }),
  },
}));

let tmpDir: string;
let app: import('express').Express;
let adminCookie: string;
let engine: typeof import('../services/recovery/operationRunner');
let repositories: typeof import('../services/recovery/repositories');
let points: typeof import('../services/recovery/recoveryPoints');
let identityStore: typeof import('../services/recovery/storageIdentity');
let recoveryDbModule: typeof import('../services/recovery/recoveryDb');
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let nodeId: number;

const SNAPSHOT = 'a'.repeat(64);
const STACK = 'app';
const BIG = 1024 * 1024 * 1024 + 1;

function service() {
  return engine.RecoveryEngineService.getInstance(nodeId);
}

/** A Docker controller with the named volume and no containers or labels. */
async function stubDocker(volumeNames: string[] = ['app_data']): Promise<void> {
  const DockerController = (await import('../services/DockerController')).default;
  const createdAt = new Date().toISOString();
  vi.spyOn(DockerController.prototype, 'getDocker').mockReturnValue({
    info: async () => ({ ID: 'engine-contents' }),
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

function seedRepository(withSecret = true): string {
  const repository = repositories.RecoveryRepositoryStore.getInstance().register({
    ownerNodeKey: 'docker-engine:contents',
    kind: 'local_volume',
    locator: 'sencho-recovery-contents-g1',
    failureDomain: 'same_failure_domain',
  });
  if (withSecret) repositories.RecoveryRepositoryStore.getInstance().storeSecret(repository.id, 'password');
  repositories.RecoveryRepositoryStore.getInstance().setFingerprint(repository.id, 'b'.repeat(32));
  repositories.RecoveryRepositoryStore.getInstance().setActive(repository.id);
  return repository.id;
}

/** A succeeded root point of `app_data`, shared by the stacks in `dependents`. */
function seedPoint(options: {
  withSecret?: boolean;
  dependents?: Array<{ stackName: string; serviceName: string | null }>;
} = {}): string {
  const repositoryId = seedRepository(options.withSecret ?? true);
  const storage = identityStore.StorageIdentityStore.getInstance().observe({
    ownerNodeKey: 'docker-engine:contents',
    kind: 'named_volume',
    locator: 'app_data',
    generationToken: 't1',
    dependents: options.dependents ?? [{ stackName: STACK, serviceName: null }],
  });
  const point = points.RecoveryPointStore.getInstance().begin({
    kind: 'root',
    storageId: storage.id,
    expectedGenerationToken: 't1',
    repositoryId,
    trigger: 'manual',
    actor: 'admin',
    sourceOperationId: 'op-src',
    sourceNodeKey: 'docker-engine:contents',
    engineId: 'restic',
  });
  points.RecoveryPointStore.getInstance().finalize(point.id, {
    status: 'succeeded',
    evidence: {
      snapshotId: SNAPSHOT,
      capture: { fileCount: 2, byteCount: 19, skippedCount: 0 },
      exclusions: [],
      consistency: 'crash_consistent_stopped',
    },
  });
  points.RecoveryPointStore.getInstance().recordVerification(point.id, 'engine_check_metadata', 'verified', null);
  return point.id;
}

interface Entry {
  path: string;
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number | null;
}

function entry(path: string, name: string, type: Entry['type'], size: number | null = null) {
  return { path, name, type, size, permissions: type === 'directory' ? 'drwxr-xr-x' : '-rw-r--r--', mode: 420, uid: 1000, gid: 1000, mtime: Date.parse('2026-11-07T18:58:44.060Z') };
}

/** The point a content read answers, as a fake engine would describe it. */
const TREE: Record<string, { kind: 'directory' | 'file' | 'other'; self: Entry; entries: Entry[] }> = {
  '': {
    kind: 'directory',
    self: entry('', 'data', 'directory'),
    entries: [entry('etc', 'etc', 'directory'), entry('notes.md', 'notes.md', 'file', 7)],
  },
  etc: {
    kind: 'directory',
    self: entry('etc', 'etc', 'directory'),
    entries: [entry('etc/app', 'app', 'directory'), entry('etc/config.txt', 'config.txt', 'file', 12)],
  },
  'etc/app': {
    kind: 'directory',
    self: entry('etc/app', 'app', 'directory'),
    entries: [],
  },
  'etc/config.txt': {
    kind: 'file',
    self: entry('etc/config.txt', 'config.txt', 'file', 12),
    entries: [],
  },
  'notes.md': { kind: 'file', self: entry('notes.md', 'notes.md', 'file', 7), entries: [] },
  'big.bin': { kind: 'file', self: entry('big.bin', 'big.bin', 'file', BIG), entries: [] },
  loop: { kind: 'other', self: entry('loop', 'loop', 'symlink'), entries: [] },
};

const FILE_BODY = Buffer.from('second\n');

function contentEngine(overrides: {
  listContents?: (request: { path: string }) => unknown;
  dumpFile?: (sink: (chunk: Buffer, control: { pause(): void; resume(): void }) => void, ctx: { signal: AbortSignal }) => Promise<unknown>;
} = {}) {
  return {
    engineId: 'fake',
    contractVersion: 1,
    storageKinds: ['named_volume'] as const,
    probe: async () => ({ engineId: 'fake', build: 'test', usable: true }),
    createPoint: async () => ({ ok: false as const, errorClass: 'internal' as const }),
    verifyPoint: async () => ({ ok: false as const, errorClass: 'internal' as const }),
    restore: async () => ({ ok: false as const, errorClass: 'internal' as const }),
    listContents: async (read: { path: string }) => {
      if (overrides.listContents) return overrides.listContents(read);
      const node = TREE[read.path];
      if (!node) return { ok: false as const, errorClass: 'not_found' as const };
      return {
        ok: true as const,
        evidence: {
          path: read.path,
          kind: node.kind,
          entry: read.path === '' ? null : node.self,
          entries: node.entries,
          truncated: false,
        },
      };
    },
    dumpFile: async (
      read: { path: string },
      expected: number,
      sink: (chunk: Buffer, control: { pause(): void; resume(): void }) => void,
      ctx: { signal: AbortSignal },
    ) => {
      if (overrides.dumpFile) return overrides.dumpFile(sink, ctx);
      sink(FILE_BODY, { pause: () => undefined, resume: () => undefined });
      return { ok: true as const, evidence: { bytes: expected } };
    },
  };
}

function useEngine(fake: ReturnType<typeof contentEngine> | null): void {
  engine.RecoveryEngineService.setEngineFactoryForTests(fake ? () => fake as never : null);
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
  recoveryDbModule = await import('../services/recovery/recoveryDb');
  nodeId = DatabaseService.getInstance().getDefaultNode()?.id ?? 1;
  adminCookie = await loginAsTestAdmin(app);
});

afterAll(async () => {
  await service().whenIdleForTests();
  engine.RecoveryEngineService.resetForTests();
  await cleanupTestDb(tmpDir);
});

beforeEach(async () => {
  await service().whenIdleForTests();
  engine.RecoveryEngineService.resetForTests();
  vi.restoreAllMocks();
  const db = recoveryDbModule.recoveryDb();
  for (const table of [
    'recovery_restore_fence_members', 'recovery_restore_intents', 'recovery_repository_checks', 'recovery_locks',
    'recovery_operations', 'recovery_point_verifications', 'recovery_point_holds', 'recovery_points',
    'recovery_repositories', 'recovery_storage_dependents', 'recovery_storage_identities',
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare("DELETE FROM system_state WHERE key = 'recovery_active_repository_id'").run();
});

describe('GET /api/recovery/points/:pointId/contents', () => {
  it('needs a signed-in caller', async () => {
    const res = await request(app).get('/api/recovery/points/anything/contents');
    expect(res.status).toBe(401);
  });

  it('lists the point root with the point\'s evidence and the read bounds', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    useEngine(contentEngine());

    const res = await request(app).get(`/api/recovery/points/${pointId}/contents`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.point).toMatchObject({
      id: pointId,
      kind: 'root',
      status: 'succeeded',
      snapshotId: SNAPSHOT,
      consistency: 'crash_consistent_stopped',
      capture: { fileCount: 2, byteCount: 19, skippedCount: 0 },
      integrity: { result: 'verified', method: 'engine_check_metadata' },
      complete: true,
      storage: { locator: 'app_data', generation: 1, state: 'current' },
    });
    expect(res.body.contents).toMatchObject({ path: '', kind: 'directory', entry: null, truncated: false });
    expect(res.body.contents.entries.map((e: { path: string }) => e.path)).toEqual(['etc', 'notes.md']);
    expect(res.body.limits).toEqual({ maxEntries: 2000, maxDownloadBytes: BIG - 1 });
  });

  it('lists one directory', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    useEngine(contentEngine());

    const res = await request(app).get(`/api/recovery/points/${pointId}/contents?path=/etc`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.contents).toMatchObject({ path: 'etc', kind: 'directory' });
    expect(res.body.contents.entry).toMatchObject({ name: 'etc', type: 'directory', permissions: 'drwxr-xr-x' });
    expect(res.body.contents.entries.map((e: { name: string }) => e.name)).toEqual(['app', 'config.txt']);
  });

  it('answers one file\'s metadata without listing it as a child', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    useEngine(contentEngine());

    const res = await request(app)
      .get(`/api/recovery/points/${pointId}/contents?path=etc/config.txt`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.contents).toMatchObject({ path: 'etc/config.txt', kind: 'file', entries: [], truncated: false });
    expect(res.body.contents.entry).toMatchObject({ name: 'config.txt', type: 'file', size: 12, uid: 1000, gid: 1000 });
  });

  it('reports a partial point as incomplete even when its check verified', async () => {
    const repositoryId = seedRepository();
    const storage = identityStore.StorageIdentityStore.getInstance().observe({
      ownerNodeKey: 'docker-engine:contents', kind: 'named_volume', locator: 'app_data', generationToken: 't1',
      dependents: [{ stackName: STACK, serviceName: null }],
    });
    const point = points.RecoveryPointStore.getInstance().begin({
      kind: 'root', storageId: storage.id, expectedGenerationToken: 't1', repositoryId,
      trigger: 'manual', actor: 'admin', sourceOperationId: 'op-src',
      sourceNodeKey: 'docker-engine:contents', engineId: 'restic',
    });
    points.RecoveryPointStore.getInstance().finalize(point.id, {
      status: 'partial',
      evidence: {
        snapshotId: SNAPSHOT,
        capture: { fileCount: 1, byteCount: 10, skippedCount: 1 },
        exclusions: [{ path: 'var/private', reason: 'permission_denied' }],
        consistency: 'crash_consistent_live',
      },
    });
    points.RecoveryPointStore.getInstance().recordVerification(point.id, 'engine_check_metadata', 'verified', null);
    await stubDocker();
    service().markReadyForTests();
    useEngine(contentEngine());

    const res = await request(app).get(`/api/recovery/points/${point.id}/contents`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.point).toMatchObject({
      status: 'partial',
      complete: false,
      integrity: { result: 'verified' },
      capture: { skippedCount: 1 },
      exclusions: [{ path: 'var/private', reason: 'permission_denied' }],
    });
  });

  it('refuses a path that leaves the point root', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    useEngine(contentEngine());

    for (const path of ['..', '../etc/passwd', 'etc/../../etc/passwd', '/../etc']) {
      const res = await request(app)
        .get(`/api/recovery/points/${pointId}/contents?path=${encodeURIComponent(path)}`)
        .set('Cookie', adminCookie);
      expect(res.status, path).toBe(400);
      expect(res.body.errorClass, path).toBe('invalid_request');
    }
  });

  it('refuses a repeated path parameter instead of picking one', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    useEngine(contentEngine());

    const res = await request(app)
      .get(`/api/recovery/points/${pointId}/contents?path=etc&path=notes.md`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
    expect(res.body.errorClass).toBe('invalid_request');
  });

  it('answers not_found for a point id that names nothing', async () => {
    await stubDocker();
    service().markReadyForTests();
    useEngine(contentEngine());

    const res = await request(app).get('/api/recovery/points/9f0d7c1e/contents').set('Cookie', adminCookie);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errorClass: 'not_found', code: 'NOT_FOUND' });
  });

  it('answers not_found for a path the point does not hold', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    useEngine(contentEngine());

    const res = await request(app).get(`/api/recovery/points/${pointId}/contents?path=missing`).set('Cookie', adminCookie);
    expect(res.status).toBe(404);
    expect(res.body.errorClass).toBe('not_found');
  });

  it('refuses a point with no snapshot, and names the reason', async () => {
    const repositoryId = seedRepository();
    const storage = identityStore.StorageIdentityStore.getInstance().observe({
      ownerNodeKey: 'docker-engine:contents', kind: 'named_volume', locator: 'app_data', generationToken: 't1',
      dependents: [{ stackName: STACK, serviceName: null }],
    });
    const point = points.RecoveryPointStore.getInstance().begin({
      kind: 'root', storageId: storage.id, expectedGenerationToken: 't1', repositoryId,
      trigger: 'manual', actor: 'admin', sourceOperationId: 'op-src',
      sourceNodeKey: 'docker-engine:contents', engineId: 'restic',
    });
    points.RecoveryPointStore.getInstance().finalize(point.id, { status: 'failed', errorClass: 'interrupted' });
    await stubDocker();
    service().markReadyForTests();
    useEngine(contentEngine());

    const res = await request(app).get(`/api/recovery/points/${point.id}/contents`).set('Cookie', adminCookie);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errorClass: 'invalid_request', reason: 'no_snapshot' });
  });

  it('answers engine_starting while the engine is not ready', async () => {
    const pointId = seedPoint();
    await stubDocker();
    useEngine(contentEngine());

    const res = await request(app).get(`/api/recovery/points/${pointId}/contents`).set('Cookie', adminCookie);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ errorClass: 'capability_unavailable', reason: 'engine_starting' });
  });

  it('answers repository_key_unavailable when the stored key is missing, never reading another key', async () => {
    const pointId = seedPoint({ withSecret: false });
    await stubDocker();
    service().markReadyForTests();

    const res = await request(app).get(`/api/recovery/points/${pointId}/contents`).set('Cookie', adminCookie);
    expect(res.status).toBe(503);
    expect(res.body.errorClass).toBe('repository_key_unavailable');
  });

  it('answers capability_unavailable when the node\'s engine cannot read contents', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    engine.RecoveryEngineService.setEngineFactoryForTests(() => ({
      engineId: 'no-reader',
      contractVersion: 1,
      storageKinds: ['named_volume'],
      probe: async () => ({ engineId: 'no-reader', build: 'test', usable: true }),
      createPoint: async () => ({ ok: false as const, errorClass: 'internal' as const }),
      verifyPoint: async () => ({ ok: false as const, errorClass: 'internal' as const }),
      restore: async () => ({ ok: false as const, errorClass: 'internal' as const }),
    }));

    const res = await request(app).get(`/api/recovery/points/${pointId}/contents`).set('Cookie', adminCookie);
    expect(res.status).toBe(503);
    expect(res.body.errorClass).toBe('capability_unavailable');
  });

  it('checks the read authorization before it reads anything', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    let listed = false;
    const fake = contentEngine({
      listContents: () => {
        listed = true;
        return { ok: false as const, errorClass: 'not_found' as const };
      },
    });
    useEngine(fake);

    await expect(service().readPointContents({
      pointId,
      path: '',
      authorize: () => false,
    })).rejects.toMatchObject({ errorClass: 'permission_denied' });
    expect(listed).toBe(false);
  });
});

describe('GET /api/recovery/points/:pointId/contents/download', () => {
  it('streams one regular file with its length and an attachment name', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    useEngine(contentEngine());

    const res = await request(app)
      .get(`/api/recovery/points/${pointId}/contents/download?path=notes.md`)
      .set('Cookie', adminCookie)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-length']).toBe('7');
    expect(res.headers['content-disposition']).toBe('attachment; filename="notes.md"; filename*=UTF-8\'\'notes.md');
    expect(res.headers['cache-control']).toBe('no-store');
    expect((res.body as Buffer).toString()).toBe('second\n');
  });

  it('refuses a symlink instead of following it', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    useEngine(contentEngine());

    const res = await request(app)
      .get(`/api/recovery/points/${pointId}/contents/download?path=loop`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ errorClass: 'invalid_request', reason: 'symlink_not_followed' });
  });

  it('refuses a directory', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    useEngine(contentEngine());

    for (const path of ['', 'etc']) {
      const res = await request(app)
        .get(`/api/recovery/points/${pointId}/contents/download?path=${path}`)
        .set('Cookie', adminCookie);
      expect(res.status, path).toBe(400);
      expect(res.body, path).toMatchObject({ errorClass: 'invalid_request', reason: 'not_a_file' });
    }
  });

  it('refuses a file past the download bound before any byte moves', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    let streamed = false;
    useEngine(contentEngine({
      dumpFile: async (sink: (chunk: Buffer, control: { pause(): void; resume(): void }) => void) => {
        streamed = true;
        sink(Buffer.from('x'), { pause: () => undefined, resume: () => undefined });
        return { ok: true as const, evidence: { bytes: 1 } };
      },
    }));

    const res = await request(app)
      .get(`/api/recovery/points/${pointId}/contents/download?path=big.bin`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      errorClass: 'payload_too_large',
      code: 'PAYLOAD_TOO_LARGE',
      size: BIG,
      maxBytes: BIG - 1,
    });
    expect(streamed).toBe(false);
  });

  it('breaks the connection when the body ends short, so a partial file is never read as whole', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    useEngine(contentEngine({
      dumpFile: async (sink: (chunk: Buffer, control: { pause(): void; resume(): void }) => void) => {
        sink(Buffer.from('sec'), { pause: () => undefined, resume: () => undefined });
        return { ok: false as const, errorClass: 'integrity_mismatch' as const };
      },
    }));

    const outcome = await request(app)
      .get(`/api/recovery/points/${pointId}/contents/download?path=notes.md`)
      .set('Cookie', adminCookie)
      .then(() => 'completed', (err: Error) => err.message);
    expect(outcome).not.toBe('completed');
  });

  it('cancels the helper when the client disconnects mid-download', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    let aborted: (() => void) | null = null;
    const sawAbort = new Promise<void>((resolve) => { aborted = resolve; });
    useEngine(contentEngine({
      dumpFile: async (sink, ctx) => {
        sink(Buffer.from('x'.repeat(4096)), { pause: () => undefined, resume: () => undefined });
        return new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            aborted?.();
            resolve({ ok: false, errorClass: 'interrupted' });
          }, { once: true });
        });
      },
    }));

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as import('net').AddressInfo).port;
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get({
          host: '127.0.0.1',
          port,
          path: `/api/recovery/points/${pointId}/contents/download?path=notes.md`,
          headers: { Cookie: adminCookie },
        }, (res) => {
          res.once('data', () => req.destroy());
          res.on('error', () => undefined);
        });
        req.on('error', () => undefined);
        sawAbort.then(resolve).catch(reject);
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(await Promise.race([
      sawAbort.then(() => 'aborted'),
      new Promise<string>((resolve) => setTimeout(() => resolve('still running'), 2_000)),
    ])).toBe('aborted');
  });
});

describe('a point\'s contents over the node proxy and the Pilot tunnel', () => {
  it('is a slow read for the listing and an unbounded download for the file body', async () => {
    const { remoteReadTimeoutMs, SLOW_REMOTE_READ_TIMEOUT_MS } = await import('../proxy/interactiveRemoteRead');
    expect(remoteReadTimeoutMs('GET', '/recovery/points/p1/contents')).toBe(SLOW_REMOTE_READ_TIMEOUT_MS);
    expect(remoteReadTimeoutMs('GET', '/recovery/points/p1/contents/download')).toBeNull();
  });
});
