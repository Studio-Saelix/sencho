/**
 * Browsing and downloading a saved recovery point over HTTP.
 *
 * The engine is a fake here: these cases are about the HTTP contract, the
 * authorization the routes run (including the floor for storage no stack uses
 * now), the evidence they attach, the read slots, and the streaming behaviour
 * (a body the caller stops, a body that ends short, a body that stalls). The
 * restic adapter's own mapping is in recovery-restic-contents*.test.ts, and the
 * real helper round trip is the docker-integration suite.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { PROXY_ROLE_HEADER } from '../services/license-headers';
import type { PointEntry } from '../services/recovery/types';

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
let viewerCookie: string;
let engine: typeof import('../services/recovery/operationRunner');
let repositories: typeof import('../services/recovery/repositories');
let points: typeof import('../services/recovery/recoveryPoints');
let identityStore: typeof import('../services/recovery/storageIdentity');
let recoveryDbModule: typeof import('../services/recovery/recoveryDb');
let slots: typeof import('../services/recovery/pointContents');
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let nodeId: number;

const SNAPSHOT = 'a'.repeat(64);
const STACK = 'app';
const NO_CONTROL = { pause: () => undefined, resume: () => undefined };
const FILE_BODY = Buffer.from('second\n');

function service() {
  return engine.RecoveryEngineService.getInstance(nodeId);
}

/**
 * Docker with the `app_data` volume. `inUse` adds a container of the `app`
 * stack mounting it, which is what makes the stack a current dependent; without
 * it the storage is detached (only its recorded rows name a stack).
 */
async function stubDocker(options: { inUse?: boolean } = {}): Promise<void> {
  const DockerController = (await import('../services/DockerController')).default;
  const { FileSystemService } = await import('../services/FileSystemService');
  vi.spyOn(FileSystemService.prototype, 'getStacks').mockResolvedValue([STACK, 'other']);
  vi.spyOn(DockerController, 'resolveProjectNameMap').mockResolvedValue(new Map([[STACK, STACK]]));
  const createdAt = new Date().toISOString();
  const containers = options.inUse === false ? [] : [{
    Id: 'c1',
    Labels: { 'com.docker.compose.project': STACK, 'com.docker.compose.service': 'db' },
    Mounts: [{ Type: 'volume', Name: 'app_data' }],
  }];
  vi.spyOn(DockerController.prototype, 'getDocker').mockReturnValue({
    info: async () => ({ ID: 'engine-contents' }),
    listVolumes: async () => ({ Volumes: [{ Name: 'app_data', Driver: 'local', Labels: {}, CreatedAt: createdAt }] }),
    listContainers: async () => containers,
    getVolume: () => ({ inspect: async () => ({ Name: 'app_data', Driver: 'local', Labels: {}, CreatedAt: createdAt }) }),
    getImage: () => ({ inspect: async () => ({ Id: 'sha256:helper' }) }),
  } as unknown as import('dockerode'));
}

function seedRepository(withSecret = true, locator = 'sencho-recovery-contents-g1'): string {
  const store = repositories.RecoveryRepositoryStore.getInstance();
  const repository = store.register({
    ownerNodeKey: 'docker-engine:contents',
    kind: 'local_volume',
    locator,
    failureDomain: 'same_failure_domain',
  });
  if (withSecret) store.storeSecret(repository.id, 'password');
  store.setFingerprint(repository.id, 'b'.repeat(32));
  store.setActive(repository.id);
  return repository.id;
}

/** A root point of `app_data`, recorded as used by `app`. */
function seedPoint(options: {
  withSecret?: boolean;
  status?: 'succeeded' | 'partial' | 'failed' | 'pending';
  verified?: boolean;
} = {}): string {
  const repositoryId = seedRepository(options.withSecret ?? true);
  const storage = identityStore.StorageIdentityStore.getInstance().observe({
    ownerNodeKey: 'docker-engine:contents',
    kind: 'named_volume',
    locator: 'app_data',
    generationToken: 't1',
    dependents: [{ stackName: STACK, serviceName: null }],
  });
  const store = points.RecoveryPointStore.getInstance();
  const point = store.begin({
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
  const status = options.status ?? 'succeeded';
  if (status === 'pending') return point.id;
  if (status === 'failed') {
    store.finalize(point.id, { status: 'failed', errorClass: 'internal' });
    return point.id;
  }
  const partial = status === 'partial';
  store.finalize(point.id, {
    status,
    evidence: {
      snapshotId: SNAPSHOT,
      capture: { fileCount: 2, byteCount: 19, skippedCount: partial ? 1 : 0 },
      exclusions: partial ? [{ path: 'etc/secret.key', reason: 'permission_denied' }] : [],
      consistency: 'crash_consistent_stopped',
    },
  });
  if (options.verified ?? true) store.recordVerification(point.id, 'engine_check_metadata', 'verified', null);
  return point.id;
}

function entry(path: string, type: PointEntry['type'], size: number | null = null): PointEntry {
  const name = path === '/' ? 'data' : path.slice(path.lastIndexOf('/') + 1);
  return {
    name, path, type, size, mode: type === 'directory' ? '0755' : '0644',
    mtime: '2026-11-07T18:58:44.060Z', uid: 1000, gid: 1000, downloadable: type === 'file' && size !== null,
  };
}

/** The point a content read answers, as a fake engine describes it. */
const TREE: Record<string, { self: PointEntry; children: PointEntry[] }> = {
  '/': { self: entry('/', 'directory'), children: [entry('/etc', 'directory'), entry('/notes.md', 'file', 7)] },
  '/etc': {
    self: entry('/etc', 'directory'),
    children: [entry('/etc/app', 'directory'), entry('/etc/config.txt', 'file', 12), entry('/etc/loop', 'symlink')],
  },
  '/etc/app': { self: entry('/etc/app', 'directory'), children: [] },
  '/etc/config.txt': { self: entry('/etc/config.txt', 'file', 12), children: [] },
  '/etc/loop': { self: entry('/etc/loop', 'symlink'), children: [] },
  '/notes.md': { self: entry('/notes.md', 'file', FILE_BODY.length), children: [] },
  '/empty.txt': { self: entry('/empty.txt', 'file', 0), children: [] },
  '/sizeless': { self: entry('/sizeless', 'file', null), children: [] },
  '/café résumé.txt': { self: entry('/café résumé.txt', 'file', FILE_BODY.length), children: [] },
};

type Sink = (chunk: Buffer, control: { pause(): void; resume(): void }) => void;

function contentEngine(overrides: {
  readDirectory?: () => unknown;
  dumpFile?: (sink: Sink, ctx: { signal: AbortSignal }) => Promise<unknown>;
} = {}) {
  const calls = { reads: [] as Array<{ path: string; offset: number; pageSize: number }>, dumps: 0 };
  const fake = {
    engineId: 'fake',
    contractVersion: 1,
    storageKinds: ['named_volume'] as const,
    probe: async () => ({ engineId: 'fake', build: 'test', usable: true }),
    createPoint: async () => ({ ok: false as const, errorClass: 'internal' as const }),
    verifyPoint: async () => ({ ok: false as const, errorClass: 'internal' as const }),
    restore: async () => ({ ok: false as const, errorClass: 'internal' as const }),
    readDirectory: async (read: { path: string }, page: { offset: number; pageSize: number }) => {
      calls.reads.push({ path: read.path, ...page });
      if (overrides.readDirectory) return overrides.readDirectory();
      const node = TREE[read.path];
      if (!node) return { ok: true as const, evidence: { found: false as const } };
      const entries = node.children.slice(page.offset, page.offset + page.pageSize);
      const more = node.children.length > page.offset + page.pageSize && page.pageSize > 0;
      return {
        ok: true as const,
        evidence: { found: true as const, self: node.self, entries, nextOffset: more ? page.offset + page.pageSize : null },
      };
    },
    dumpFile: async (_read: { path: string }, expected: number, sink: Sink, ctx: { signal: AbortSignal }) => {
      calls.dumps += 1;
      if (overrides.dumpFile) return overrides.dumpFile(sink, ctx);
      if (expected > 0) sink(FILE_BODY, NO_CONTROL);
      return { ok: true as const, evidence: { bytes: expected } };
    },
  };
  engine.RecoveryEngineService.setEngineFactoryForTests(() => fake as never);
  return calls;
}

/** A bearer for a hub hop, as the control instance forwards one. */
function hop(scope: 'node_proxy' | 'pilot_tunnel', role: 'viewer' | 'admin' = 'viewer') {
  const token = jwt.sign({ scope }, TEST_JWT_SECRET, { expiresIn: '5m' });
  return { Authorization: `Bearer ${token}`, [PROXY_ROLE_HEADER]: role } as Record<string, string>;
}

function binary(req: request.Test): request.Test {
  return req.buffer(true).parse((response, callback) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('end', () => callback(null, Buffer.concat(chunks)));
  });
}

/** Resolves once `signal` aborts, or answers 'still running' after two seconds. */
function abortedWithin(seen: Promise<void>): Promise<string> {
  return Promise.race([
    seen.then(() => 'aborted'),
    new Promise<string>((resolve) => setTimeout(() => resolve('still running'), 2_000)),
  ]);
}

/** A dump that writes one chunk and then waits for the read to be aborted. */
function stallingDump(size: number) {
  let sawAbort: () => void = () => undefined;
  const seen = new Promise<void>((resolve) => { sawAbort = resolve; });
  const dumpFile = async (sink: Sink, ctx: { signal: AbortSignal }) => {
    sink(Buffer.alloc(size, 'x'), NO_CONTROL);
    return new Promise((resolve) => {
      ctx.signal.addEventListener('abort', () => {
        sawAbort();
        resolve({ ok: false, errorClass: 'interrupted' });
      }, { once: true });
    });
  };
  return { dumpFile, seen };
}

const browse = (pointId: string, query = '') => `/api/recovery/points/${pointId}/browse${query}`;
const download = (pointId: string, path: string) =>
  `/api/recovery/points/${pointId}/download?path=${encodeURIComponent(path)}`;

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
  slots = await import('../services/recovery/pointContents');
  nodeId = DatabaseService.getInstance().getDefaultNode()?.id ?? 1;
  adminCookie = await loginAsTestAdmin(app);
  const bcrypt = (await import('bcrypt')).default;
  DatabaseService.getInstance().addUser({
    username: 'contents-viewer', password_hash: await bcrypt.hash('viewer-pass-1', 1), role: 'viewer',
  });
  const login = await request(app).post('/api/auth/login').send({ username: 'contents-viewer', password: 'viewer-pass-1' });
  expect(login.status).toBe(200);
  const cookies = login.headers['set-cookie'];
  viewerCookie = Array.isArray(cookies) ? cookies.join('; ') : String(cookies ?? '');
});

afterAll(async () => {
  await service().whenIdleForTests();
  engine.RecoveryEngineService.resetForTests();
  await cleanupTestDb(tmpDir);
});

beforeEach(async () => {
  const { setDownloadIdleMsForTests } = await import('../routes/recovery');
  setDownloadIdleMsForTests(null);
  await service().whenIdleForTests();
  engine.RecoveryEngineService.resetForTests();
  slots.resetPointReadSlotsForTests();
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

describe('GET /api/recovery/points/:pointId/browse', () => {
  it('needs a signed-in caller', async () => {
    expect((await request(app).get(browse('anything'))).status).toBe(401);
  });

  it('lists the point root with the point\'s evidence and the read bounds', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    contentEngine();

    const res = await request(app).get(browse(pointId)).set('Cookie', viewerCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      point: {
        id: pointId,
        status: 'succeeded',
        snapshotId: SNAPSHOT,
        storage: { id: expect.any(String), locator: 'app_data', generation: 1, state: 'current' },
        consistency: 'crash_consistent_stopped',
        capture: { fileCount: 2, byteCount: 19, skippedCount: 0 },
        complete: true,
        integrity: { state: 'verified', method: 'engine_check_metadata', verifiedAt: expect.any(Number) },
        completedAt: expect.any(Number),
      },
      path: '/',
      entries: TREE['/'].children,
      skipped: [],
      offset: 0,
      nextOffset: null,
      limits: { pageSize: 500, concurrentReads: 4 },
    });
  });

  it('pages a directory with the offset and asks the engine for one page', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    const calls = contentEngine();

    const res = await request(app).get(browse(pointId, '?path=/etc&offset=1')).set('Cookie', viewerCookie);
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: PointEntry) => e.path)).toEqual(['/etc/config.txt', '/etc/loop']);
    expect(res.body.offset).toBe(1);
    expect(calls.reads).toEqual([{ path: '/etc', offset: 1, pageSize: 500 }]);
  });

  it('shows a partial point as incomplete with what it skipped, in the directory it skipped it from', async () => {
    const pointId = seedPoint({ status: 'partial' });
    await stubDocker();
    service().markReadyForTests();
    contentEngine();

    const root = await request(app).get(browse(pointId)).set('Cookie', viewerCookie);
    expect(root.body.point).toMatchObject({ status: 'partial', complete: false, integrity: { state: 'verified' } });
    expect(root.body.skipped).toEqual([]);
    const etc = await request(app).get(browse(pointId, '?path=/etc')).set('Cookie', viewerCookie);
    expect(etc.body.skipped).toEqual([{ name: 'secret.key', reason: 'permission_denied' }]);
  });

  it('reports a point with no recorded check as unverified', async () => {
    const pointId = seedPoint({ verified: false });
    await stubDocker();
    service().markReadyForTests();
    contentEngine();
    const res = await request(app).get(browse(pointId)).set('Cookie', viewerCookie);
    expect(res.body.point.integrity).toEqual({ state: 'unverified', method: null, verifiedAt: null });
  });

  it('refuses a malformed path, a repeated parameter and a bad offset before anything runs', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    const calls = contentEngine();
    for (const query of ['?path=../etc', '?path=/etc/..', '?path=etc', '?path=/etc/', '?path=%2e%2e', '?path=/a%00b',
      '?path=/a&path=/b', '?offset=-1', '?offset=1.5', '?offset=x']) {
      const res = await request(app).get(browse(pointId, query)).set('Cookie', viewerCookie);
      expect(res.status, query).toBe(400);
      expect(res.body.errorClass, query).toBe('invalid_request');
    }
    expect(calls.reads).toEqual([]);
  });

  it('answers path_not_found and not_a_directory', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    contentEngine();
    const missing = await request(app).get(browse(pointId, '?path=/nope')).set('Cookie', viewerCookie);
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ errorClass: 'invalid_request', reason: 'path_not_found' });
    const file = await request(app).get(browse(pointId, '?path=/notes.md')).set('Cookie', viewerCookie);
    expect(file.status).toBe(400);
    expect(file.body).toMatchObject({ errorClass: 'invalid_request', reason: 'not_a_directory' });
  });

  it('answers point_not_readable for a point that holds no snapshot', async () => {
    for (const status of ['pending', 'failed'] as const) {
      const pointId = seedPoint({ status });
      await stubDocker();
      service().markReadyForTests();
      const calls = contentEngine();
      const res = await request(app).get(browse(pointId)).set('Cookie', adminCookie);
      expect(res.status, status).toBe(400);
      expect(res.body, status).toMatchObject({ errorClass: 'invalid_request', reason: 'point_not_readable' });
      expect(calls.reads, status).toEqual([]);
    }
  });

  it('answers engine_starting while the engine is not ready', async () => {
    const pointId = seedPoint();
    await stubDocker();
    contentEngine();
    const res = await request(app).get(browse(pointId)).set('Cookie', viewerCookie);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ errorClass: 'capability_unavailable', reason: 'engine_starting' });
  });

  it('answers repository_replaced for a point in a repository that is no longer active', async () => {
    const pointId = seedPoint();
    seedRepository(true, 'sencho-recovery-contents-g2');
    await stubDocker();
    service().markReadyForTests();
    const calls = contentEngine();
    const res = await request(app).get(browse(pointId)).set('Cookie', viewerCookie);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ errorClass: 'repository_unavailable', reason: 'repository_replaced' });
    expect(calls.reads).toEqual([]);
  });

  it('answers repository_key_unavailable when the stored key is missing, never reading another key', async () => {
    const pointId = seedPoint({ withSecret: false });
    await stubDocker();
    service().markReadyForTests();
    engine.RecoveryEngineService.setEngineFactoryForTests(null);
    const res = await request(app).get(browse(pointId)).set('Cookie', viewerCookie);
    expect(res.status).toBe(503);
    expect(res.body.errorClass).toBe('repository_key_unavailable');
  });

  it('answers read_capacity with a retry hint once the node runs its bound of reads', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    const calls = contentEngine();
    const held = Array.from({ length: 4 }, () => slots.acquirePointReadSlot('elsewhere'));
    try {
      const res = await request(app).get(browse(pointId)).set('Cookie', viewerCookie);
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.body).toMatchObject({ errorClass: 'capability_unavailable', reason: 'read_capacity' });
      expect(calls.reads).toEqual([]);
    } finally {
      for (const release of held) release?.();
    }
    expect((await request(app).get(browse(pointId)).set('Cookie', viewerCookie)).status).toBe(200);
  });
});

describe('who may read a point', () => {
  it('answers an unknown id as a denial unless the caller may know ids', async () => {
    seedRepository();
    await stubDocker();
    service().markReadyForTests();
    contentEngine();
    const viewer = await request(app).get(browse('no-such-point')).set('Cookie', viewerCookie);
    expect(viewer.status).toBe(403);
    expect(viewer.body.errorClass).toBe('permission_denied');
    const admin = await request(app).get(browse('no-such-point')).set('Cookie', adminCookie);
    expect(admin.status).toBe(400);
    expect(admin.body.errorClass).toBe('invalid_request');
    const download = await request(app).get('/api/recovery/points/no-such-point/download?path=/x').set('Cookie', viewerCookie);
    expect(download.status).toBe(403);
  });

  it('holds a point no stack uses now to an administrator, on both routes and every transport', async () => {
    // The recorded rows still name `app`, but no container mounts the volume and
    // no model declares it: the stack is gone.
    const pointId = seedPoint();
    await stubDocker({ inUse: false });
    service().markReadyForTests();
    const calls = contentEngine();

    const denials = [
      await request(app).get(browse(pointId)).set('Cookie', viewerCookie),
      await request(app).get(download(pointId, '/notes.md')).set('Cookie', viewerCookie),
      await request(app).get(browse(pointId)).set(hop('node_proxy')),
      await request(app).get(browse(pointId)).set(hop('pilot_tunnel')),
      await request(app).get(download(pointId, '/notes.md')).set(hop('pilot_tunnel')),
    ];
    for (const res of denials) {
      expect(res.status).toBe(403);
      // Byte-identical to every other denial: no stack, no detached state.
      expect(res.text).toBe(denials[0].text);
    }
    expect(denials[0].text).not.toMatch(/app|detached|no stack/i);
    expect(calls.reads).toEqual([]);

    expect((await request(app).get(browse(pointId)).set('Cookie', adminCookie)).status).toBe(200);
    expect((await request(app).get(browse(pointId)).set(hop('node_proxy', 'admin'))).status).toBe(200);
  });

  it('checks access before it reads anything, even while the engine is starting', async () => {
    const pointId = seedPoint();
    await stubDocker({ inUse: false });
    const calls = contentEngine();
    const res = await request(app).get(browse(pointId)).set('Cookie', viewerCookie);
    expect(res.status).toBe(403);
    expect(calls.reads).toEqual([]);
  });

  it('answers a denial with the same body whatever the reason', async () => {
    const pointId = seedPoint();
    await stubDocker({ inUse: false });
    service().markReadyForTests();
    contentEngine();
    const detached = await request(app).get(browse(pointId)).set('Cookie', viewerCookie);
    const unknown = await request(app).get(browse('no-such-point')).set('Cookie', viewerCookie);
    expect(detached.text).toBe(unknown.text);
  });
});

describe('GET /api/recovery/points/:pointId/download', () => {
  it('streams one regular file with its length, an attachment name and no caching', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    const calls = contentEngine();

    const res = await binary(request(app).get(download(pointId, '/notes.md')).set('Cookie', viewerCookie));
    expect(res.status).toBe(200);
    expect((res.body as Buffer).equals(FILE_BODY)).toBe(true);
    expect(res.headers).toMatchObject({
      'content-type': 'application/octet-stream',
      'content-length': String(FILE_BODY.length),
      'content-disposition': 'attachment; filename="notes.md"; filename*=UTF-8\'\'notes.md',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'none',
    });
    expect(calls.reads).toEqual([{ path: '/notes.md', offset: 0, pageSize: 0 }]);
  });

  it('serves an empty file', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    contentEngine();
    const res = await binary(request(app).get(download(pointId, '/empty.txt')).set('Cookie', viewerCookie));
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe('0');
    expect((res.body as Buffer).length).toBe(0);
  });

  it('answers a HEAD with the headers and runs no dump', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    const calls = contentEngine();
    const res = await request(app).head(download(pointId, '/notes.md')).set('Cookie', viewerCookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe(String(FILE_BODY.length));
    expect(calls.dumps).toBe(0);
  });

  it('refuses a directory, a symlink, a sizeless file and a missing path before any byte moves', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    const calls = contentEngine();
    for (const path of ['/', '/etc', '/etc/loop', '/sizeless']) {
      const res = await request(app).get(download(pointId, path)).set('Cookie', viewerCookie);
      expect(res.status, path).toBe(400);
      expect(res.body, path).toMatchObject({ errorClass: 'invalid_request', reason: 'unsupported_entry_type' });
      expect(res.headers['content-disposition'], path).toBeUndefined();
    }
    const missing = await request(app).get(download(pointId, '/nope')).set('Cookie', viewerCookie);
    expect(missing.body).toMatchObject({ reason: 'path_not_found' });
    const noPath = await request(app).get(`/api/recovery/points/${pointId}/download`).set('Cookie', viewerCookie);
    expect(noPath.status).toBe(400);
    const traversal = await request(app).get(download(pointId, '/../etc/passwd')).set('Cookie', viewerCookie);
    expect(traversal.status).toBe(400);
    expect(calls.dumps).toBe(0);
  });

  it('answers a dump that fails before its first byte as its own JSON error, not as an attachment', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    contentEngine({ dumpFile: async () => ({ ok: false, errorClass: 'integrity_mismatch' }) });
    const res = await request(app).get(download(pointId, '/notes.md')).set('Cookie', viewerCookie);
    expect(res.status).toBe(409);
    expect(res.body.errorClass).toBe('integrity_mismatch');
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('breaks the connection when the body fails after its first byte', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    contentEngine({
      dumpFile: async (sink) => {
        sink(Buffer.from('sec'), NO_CONTROL);
        return { ok: false, errorClass: 'integrity_mismatch' };
      },
    });
    const outcome = await request(app).get(download(pointId, '/notes.md')).set('Cookie', viewerCookie)
      .then(() => 'completed', (err: Error) => err.message);
    expect(outcome).not.toBe('completed');
  });

  it('keeps a non-ASCII and hostile name out of the raw header', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    contentEngine();
    const res = await binary(request(app).get(download(pointId, '/café résumé.txt')).set('Cookie', viewerCookie));
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition'])
      .toBe(`attachment; filename="caf_ r_sum_.txt"; filename*=UTF-8''${encodeURIComponent('café résumé.txt')}`);
  });

  it('stops a body that stops moving, so a stalled read cannot hold a helper', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    const { setDownloadIdleMsForTests } = await import('../routes/recovery');
    setDownloadIdleMsForTests(50);
    const stall = stallingDump(1024);
    contentEngine({ dumpFile: stall.dumpFile });
    const outcome = await request(app).get(download(pointId, '/notes.md')).set('Cookie', viewerCookie)
      .then(() => 'completed', (err: Error) => err.message);
    expect(outcome).not.toBe('completed');
    expect(await abortedWithin(stall.seen)).toBe('aborted');
  });

  it('cancels the helper when the client disconnects mid-download, and frees its slot', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    const stall = stallingDump(4096);
    contentEngine({ dumpFile: stall.dumpFile });
    const repositoryId = repositories.RecoveryRepositoryStore.getInstance().getActive()?.id ?? '';

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as import('net').AddressInfo).port;
    let inFlight = -1;
    try {
      const req = http.get({
        host: '127.0.0.1', port, path: download(pointId, '/notes.md'), headers: { Cookie: viewerCookie },
      }, (res) => {
        res.once('data', () => {
          inFlight = slots.activeReadCount(repositoryId);
          req.destroy();
        });
        res.on('error', () => undefined);
      });
      req.on('error', () => undefined);
      expect(await abortedWithin(stall.seen)).toBe('aborted');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(inFlight).toBe(1);
    await vi.waitFor(() => expect(slots.activeReadCount(repositoryId)).toBe(0));
  });
});

describe('what a read leaves behind', () => {
  it('writes no operation, lock or audit row, and frees its slot on success and failure', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    contentEngine();
    const repositoryId = repositories.RecoveryRepositoryStore.getInstance().getActive()?.id ?? '';
    const auditBefore = DatabaseService.getInstance().getDb().prepare('SELECT COUNT(*) AS n FROM audit_log').get();

    await request(app).get(browse(pointId)).set('Cookie', viewerCookie).expect(200);
    await binary(request(app).get(download(pointId, '/notes.md')).set('Cookie', viewerCookie)).expect(200);
    await request(app).get(browse(pointId, '?path=/nope')).set('Cookie', viewerCookie).expect(400);
    await request(app).get(download(pointId, '/etc')).set('Cookie', viewerCookie).expect(400);

    const db = recoveryDbModule.recoveryDb();
    expect(db.prepare('SELECT COUNT(*) AS n FROM recovery_operations').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM recovery_locks').get()).toEqual({ n: 0 });
    expect(DatabaseService.getInstance().getDb().prepare('SELECT COUNT(*) AS n FROM audit_log').get()).toEqual(auditBefore);
    expect(slots.activeReadCount(repositoryId)).toBe(0);
  });
});

describe('a point\'s contents over the node proxy and the Pilot tunnel', () => {
  it('gives the listing the slow-read budget and the download the long-lived one', async () => {
    const { remoteReadTimeoutMs, SLOW_REMOTE_READ_TIMEOUT_MS } = await import('../proxy/interactiveRemoteRead');
    expect(remoteReadTimeoutMs('GET', '/recovery/points/p1/browse')).toBe(SLOW_REMOTE_READ_TIMEOUT_MS);
    expect(remoteReadTimeoutMs('GET', '/recovery/points/p1/browse?path=/etc&offset=500')).toBe(SLOW_REMOTE_READ_TIMEOUT_MS);
    expect(remoteReadTimeoutMs('GET', '/recovery/points/p1/download')).toBeNull();
    expect(remoteReadTimeoutMs('GET', '/recovery/points/p1/download?path=/x.bin')).toBeNull();
  });

  it('names the point read each route needs, and nothing else', async () => {
    const { requiredPointReadFor } = await import('../proxy/remoteNodeProxy');
    expect(requiredPointReadFor('GET', '/recovery/points/p1/browse')).toBe('list');
    expect(requiredPointReadFor('GET', '/recovery/points/p1/browse?path=/etc')).toBe('list');
    expect(requiredPointReadFor('GET', '/recovery/points/p1/download?path=/x')).toBe('download');
    expect(requiredPointReadFor('HEAD', '/recovery/points/p1/download?path=/x')).toBe('download');
    expect(requiredPointReadFor('POST', '/recovery/points/p1/browse')).toBeUndefined();
    expect(requiredPointReadFor('GET', '/recovery/points/p1/restore')).toBeUndefined();
    expect(requiredPointReadFor('GET', '/recovery/points/p1/browse/extra')).toBeUndefined();
    expect(requiredPointReadFor('GET', '/recovery/storage/s1/points')).toBeUndefined();
  });

  it('answers the same for a local session and for a hop over either transport', async () => {
    const pointId = seedPoint();
    await stubDocker();
    service().markReadyForTests();
    contentEngine();

    const listing = browse(pointId, '?path=/etc');
    const local = await request(app).get(listing).set('Cookie', viewerCookie);
    expect(local.status).toBe(200);
    const localBody = await binary(request(app).get(download(pointId, '/notes.md')).set('Cookie', viewerCookie));
    const localMissing = await request(app).get(browse(pointId, '?path=/nope')).set('Cookie', viewerCookie);

    for (const scope of ['node_proxy', 'pilot_tunnel'] as const) {
      const relayed = await request(app).get(listing).set(hop(scope));
      expect(relayed.status, scope).toBe(200);
      expect(relayed.body, scope).toEqual(local.body);
      const relayedBody = await binary(request(app).get(download(pointId, '/notes.md')).set(hop(scope)));
      expect(relayedBody.status, scope).toBe(200);
      expect((relayedBody.body as Buffer).equals(localBody.body as Buffer), scope).toBe(true);
      expect(relayedBody.headers['content-length'], scope).toBe(localBody.headers['content-length']);
      expect(relayedBody.headers['content-disposition'], scope).toBe(localBody.headers['content-disposition']);
      const relayedMissing = await request(app).get(browse(pointId, '?path=/nope')).set(hop(scope));
      expect(relayedMissing.status, scope).toBe(localMissing.status);
      expect(relayedMissing.body, scope).toEqual(localMissing.body);
    }
  });
});
