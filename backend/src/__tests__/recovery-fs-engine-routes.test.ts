/**
 * The recovery HTTP surface for host directories: listing, capture, path
 * restore, history, operation access, lock release and the overwrite admission.
 *
 * Stacks are real directories under the test compose base and their models are
 * rendered by a mocked Compose. The helper is a fake that answers a probe the
 * way the daemon would, from the directory the host path names (through
 * `daemonView` when a test wants the daemon to see a different directory), so
 * the identity proof compares real devices and inodes. The engine is replaced
 * for the background work: these cases are about what is admitted.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import type { HelperRunSpec } from '../services/recovery/restic/helperRunner';

const models = vi.hoisted(() => ({ byStack: {} as Record<string, Array<{ source: string; target: string; read_only?: boolean }>> }));

vi.mock('../services/ComposeService', () => ({
  ComposeService: {
    getInstance: () => ({
      renderConfig: async (stackName: string) => {
        if (stackName === 'broken') return { rendered: null, stderr: 'yaml: line 3: bad', timedOut: false };
        const binds = models.byStack[stackName] ?? [];
        return {
          rendered: JSON.stringify({
            name: stackName,
            services: {
              app: {
                image: 'nginx',
                volumes: binds.map((b) => ({ type: 'bind', source: b.source, target: b.target, read_only: b.read_only === true })),
              },
            },
            networks: {},
            volumes: {},
          }),
          stderr: '',
          timedOut: false,
        };
      },
    }),
  },
}));

let tmpDir: string;
let shared: string;
let app: import('express').Express;
let adminCookie: string;
let engine: typeof import('../services/recovery/operationRunner');
let repositories: typeof import('../services/recovery/repositories');
let points: typeof import('../services/recovery/recoveryPoints');
let identityStore: typeof import('../services/recovery/storageIdentity');
let recoveryDbModule: typeof import('../services/recovery/recoveryDb');
let capability: typeof import('../services/recovery/capability');
let StackFileRoots: typeof import('../services/StackFileRootsService');
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let nodeId: number;

/** Host path -> the directory the daemon resolves it to. */
let daemonView: Record<string, string> = {};
/** Mounts reported below a root by the nested-mount probe. */
let nestedMounts: string[] = [];
let helperRuns: HelperRunSpec[] = [];
let containers: Array<Record<string, unknown>> = [];
/** Names the work-directory probe reports at a root's top level. */
let topWorkDirs: string[] = [];
/** What the daemon says its data root is; undefined when it does not say. */
let dockerRootDir: string | undefined = '/var/lib/docker';

function fakeHelper() {
  return {
    run: async (spec: HelperRunSpec) => {
      helperRuns.push(spec);
      const source = spec.mounts.source;
      const hostPath = typeof source === 'object' && source !== null ? source.hostPath : '';
      const real = daemonView[hostPath] ?? hostPath;
      let stat: fs.BigIntStats;
      try {
        stat = fs.statSync(real, { bigint: true });
      } catch {
        spec.onStdoutLine?.(JSON.stringify({ error: 'no such file or directory' }));
        return { exitCode: 1, stderrTail: '', aborted: false, killed: false };
      }
      const report: Record<string, unknown> = {
        dev: 1, ino: 1, uid: 0, gid: 0, mode: 16877, free: 10 ** 9,
        dev_s: stat.dev.toString(), ino_s: stat.ino.toString(), btime: '1700000000.000000001',
      };
      if (spec.cmd.includes('--mounts')) report.mounts = nestedMounts;
      if (spec.cmd.includes('--work-dirs')) report.work_dirs = topWorkDirs;
      spec.onStdoutLine?.(JSON.stringify(report));
      return { exitCode: 0, stderrTail: '', aborted: false, killed: false };
    },
    removeForeignEpochHelpers: async () => 0,
    countForeignEpochHelpers: async () => 0,
  } as unknown as import('../services/recovery/restic/helperRunner').RecoveryHelperRunner;
}

const readerEngine = {
  engineId: 'fake',
  contractVersion: 1 as const,
  storageKinds: ['named_volume', 'bind_root'] as const,
  probe: async () => ({ engineId: 'fake', build: 'test', usable: true }),
  createPoint: async () => ({
    ok: true as const,
    evidence: { snapshotId: 'snap-1', capture: { fileCount: 1, byteCount: 1, skippedCount: 0 }, exclusions: [], consistency: 'crash_consistent_stopped' },
  }),
  verifyPoint: async () => ({ ok: true as const, evidence: { result: 'verified' } }),
  restore: async () => ({ ok: false as const, errorClass: 'interrupted' }),
  readDirectory: async (req: { path: string }) => ({
    ok: true as const,
    evidence: req.path === '/db.sqlite'
      ? { found: true, self: { name: 'db.sqlite', path: '/db.sqlite', type: 'file', size: 1, mode: '0644', mtime: null, uid: 0, gid: 0, downloadable: true }, entries: [], nextOffset: null }
      : { found: false },
  }),
  dumpFile: async () => ({ ok: true as const, evidence: { bytes: 0 } }),
};

function service() {
  const instance = engine.RecoveryEngineService.getInstance(nodeId);
  instance.setHelperRunnerForTests(fakeHelper());
  return instance;
}

async function stubDocker(): Promise<void> {
  const DockerController = (await import('../services/DockerController')).default;
  vi.spyOn(DockerController.prototype, 'getDocker').mockReturnValue({
    info: async () => ({ ID: 'engine-fs', ...(dockerRootDir === undefined ? {} : { DockerRootDir: dockerRootDir }) }),
    listVolumes: async () => ({ Volumes: [] }),
    listContainers: async () => containers,
    getVolume: () => ({ inspect: async () => { throw Object.assign(new Error('no such volume'), { statusCode: 404 }); } }),
    getContainer: (id: string) => ({
      inspect: async () => ({ Name: `/${id}`, State: { Running: true, StartedAt: '2026-01-01T00:00:00Z' }, HostConfig: { RestartPolicy: { Name: 'no' } } }),
    }),
    createVolume: async () => { throw Object.assign(new Error('forbidden'), { statusCode: 403 }); },
    getImage: () => ({ inspect: async () => ({ Id: 'sha256:helper' }) }),
  } as unknown as import('dockerode'));
  vi.spyOn(DockerController, 'resolveProjectNameMap').mockResolvedValue(new Map());
}

function stackDir(name: string): string {
  const dir = path.join(process.env.COMPOSE_DIR as string, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  app:\n    image: nginx\n');
  return fs.realpathSync(dir);
}

function dataDir(stack: string, name = 'data'): string {
  const dir = path.join(stackDir(stack), name);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

function seedRepository(): string {
  const repository = repositories.RecoveryRepositoryStore.getInstance().register({
    ownerNodeKey: 'docker-engine:engine-fs', kind: 'local_volume', locator: 'sencho-recovery-fs-g1', failureDomain: 'same_failure_domain',
  });
  repositories.RecoveryRepositoryStore.getInstance().storeSecret(repository.id, 'password');
  repositories.RecoveryRepositoryStore.getInstance().setFingerprint(repository.id, 'b'.repeat(32));
  repositories.RecoveryRepositoryStore.getInstance().setActive(repository.id);
  return repository.id;
}

async function listing(stack: string, cookie = adminCookie) {
  const res = await request(app).get(`/api/recovery/storage?stack=${stack}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body as { roots: Array<Record<string, unknown>>; verdict: unknown };
}

async function rootIdOf(stack: string, role: 'bind' | 'stack_source' = 'bind'): Promise<string> {
  const body = await listing(stack);
  const root = body.roots.find((r) => r.kind === 'bind_root' && r.role === role);
  return root?.rootId as string;
}

function capture(stackName: string, rootId: string, cookie = adminCookie, idempotencyKey = randomUUID()) {
  return request(app).post('/api/recovery/storage/roots/points').set('Cookie', cookie).send({ stackName, rootId, idempotencyKey });
}

async function loginNewUser(username: string): Promise<{ cookie: string; userId: number }> {
  const bcrypt = (await import('bcrypt')).default;
  const db = DatabaseService.getInstance();
  db.addUser({ username, password_hash: await bcrypt.hash('scoped-pass-123', 1), role: 'viewer' });
  const login = await request(app).post('/api/auth/login').send({ username, password: 'scoped-pass-123' });
  expect(login.status).toBe(200);
  const cookies = login.headers['set-cookie'];
  return { cookie: Array.isArray(cookies) ? cookies.join('; ') : String(cookies ?? ''), userId: db.getUserByUsername(username)!.id };
}

/** A viewer who may also edit the named stacks, and nothing else. */
async function editorOf(...stacks: string[]): Promise<string> {
  const user = await loginNewUser(`editor-${randomUUID().slice(0, 8)}`);
  for (const stack of stacks) {
    DatabaseService.getInstance().addRoleAssignment({
      user_id: user.userId, role: 'node-admin', resource_type: 'stack', resource_id: stack, node_id: nodeId,
    });
  }
  return user.cookie;
}

/**
 * Run `fn` with the viewer role reading no stack by itself, so a scoped editor
 * reads only the stacks it was assigned. Every built-in role reads every stack,
 * so a read gate is only observable this way.
 */
async function withoutGlobalRead(fn: () => Promise<void>): Promise<void> {
  const { ROLE_PERMISSIONS } = await import('../middleware/permissions');
  const original = [...ROLE_PERMISSIONS.viewer];
  ROLE_PERMISSIONS.viewer.splice(0, ROLE_PERMISSIONS.viewer.length, ...original.filter((a) => a !== 'stack:read'));
  try {
    await fn();
  } finally {
    ROLE_PERMISSIONS.viewer.splice(0, ROLE_PERMISSIONS.viewer.length, ...original);
  }
}

function operationCount(): number {
  return (recoveryDbModule.recoveryDb().prepare('SELECT COUNT(*) AS n FROM recovery_operations').get() as { n: number }).n;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  // The test compose base lives under the OS temp root, which the explorer
  // treats as managed. A directory shared by two stacks is put outside it.
  shared = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(tmpDir), 'fsroutes-shared-')));
  const index = await import('../index');
  app = index.app;
  DatabaseService = (await import('../services/DatabaseService')).DatabaseService;
  engine = await import('../services/recovery/operationRunner');
  repositories = await import('../services/recovery/repositories');
  points = await import('../services/recovery/recoveryPoints');
  identityStore = await import('../services/recovery/storageIdentity');
  recoveryDbModule = await import('../services/recovery/recoveryDb');
  capability = await import('../services/recovery/capability');
  StackFileRoots = await import('../services/StackFileRootsService');
  intentsModule = await import('../services/recovery/restoreIntents');
  nodeId = DatabaseService.getInstance().getDefaultNode()?.id ?? 1;
  adminCookie = await loginAsTestAdmin(app);
});

afterAll(async () => {
  fs.rmSync(shared, { recursive: true, force: true });
  await cleanupTestDb(tmpDir);
});

beforeEach(async () => {
  await engine.RecoveryEngineService.getInstance(nodeId).whenIdleForTests();
  engine.RecoveryEngineService.resetForTests();
  capability.resetBackupEnginesForTests();
  vi.restoreAllMocks();
  StackFileRoots.StackFileRootsService.invalidateNode(nodeId);
  const db = recoveryDbModule.recoveryDb();
  for (const table of [
    'recovery_restore_fence_members', 'recovery_restore_intents', 'recovery_repository_checks', 'recovery_locks',
    'recovery_operations', 'recovery_point_verifications', 'recovery_point_holds', 'recovery_points',
    'recovery_repositories', 'recovery_storage_dependents', 'recovery_storage_identities',
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare("DELETE FROM system_state WHERE key = 'recovery_active_repository_id'").run();
  fs.rmSync(process.env.COMPOSE_DIR as string, { recursive: true, force: true });
  fs.mkdirSync(process.env.COMPOSE_DIR as string, { recursive: true });
  models.byStack = {};
  daemonView = {};
  nestedMounts = [];
  helperRuns = [];
  containers = [];
  topWorkDirs = [];
  dockerRootDir = '/var/lib/docker';
  await stubDocker();
  const SelfIdentityService = (await import('../services/SelfIdentityService')).default;
  vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue(null);
  // The shared directory sits outside the compose base; the OS temp root, which
  // the explorer treats as managed, is moved out of its way.
  vi.spyOn(os, 'tmpdir').mockReturnValue('/nonexistent-recovery-tmp');
  engine.RecoveryEngineService.setEngineFactoryForTests(() => readerEngine as never);
  service().markReadyForTests();
  seedRepository();
});

describe('listing host directories', () => {
  it('lists a stack\'s source and bind directories with a kind, and a refused one with its reason', async () => {
    const data = dataDir('web');
    fs.writeFileSync(path.join(stackDir('web'), 'single.conf'), 'x');
    models.byStack.web = [
      { source: data, target: '/data' },
      { source: '/etc', target: '/host-etc', read_only: true },
      { source: path.join(stackDir('web'), 'single.conf'), target: '/etc/app.conf' },
    ];
    const body = await listing('web');
    const fsRoots = body.roots.filter((r) => r.kind === 'bind_root');
    expect(fsRoots.find((r) => r.role === 'stack_source')).toMatchObject({ eligible: true, coverage: 'no_point', storageId: null });
    expect(fsRoots.find((r) => r.hostPath === data)).toMatchObject({ role: 'bind', eligible: true, coverage: 'no_point' });
    expect(fsRoots.find((r) => r.ineligibleReason === 'protected_host_path')).toMatchObject({ eligible: false, coverage: 'unsupported' });
    expect(fsRoots.find((r) => r.ineligibleReason === 'not_a_directory')).toMatchObject({ eligible: false });
    // A refused directory keeps the stack from reading Protected.
    expect(body.verdict).toMatchObject({ state: expect.not.stringMatching(/^protected$/) });
  });

  it('lists an unrenderable stack\'s binds as unknown, so its source directory alone never reads Protected', async () => {
    stackDir('broken');
    const body = await listing('broken');
    const unknown = body.roots.find((r) => r.kind === 'bind_root' && r.coverage === 'identity_unknown');
    expect(unknown).toMatchObject({ role: 'bind', stackName: 'broken', eligible: false });
    expect(body.verdict).toMatchObject({ state: expect.not.stringMatching(/^protected$/) });
  });

  it('withholds the path of a directory the caller may not read, and still counts it', async () => {
    const dir = path.join(shared, 'listing');
    fs.mkdirSync(dir, { recursive: true });
    stackDir('web');
    stackDir('worker');
    models.byStack.web = [{ source: dir, target: '/data' }];
    models.byStack.worker = [{ source: dir, target: '/data' }];
    const rootId = await rootIdOf('web');
    expect((await capture('web', rootId)).status).toBe(202);
    await service().whenIdleForTests();
    // Recorded dependents now name both stacks; an editor of web alone may not read it.
    const cookie = await editorOf('web');
    await withoutGlobalRead(async () => {
      const body = await listing('web', cookie);
      const hidden = body.roots.find((r) => r.kind === 'bind_root' && r.access === 'inaccessible');
      expect(hidden).toBeDefined();
      expect(hidden).not.toHaveProperty('hostPath');
      // The stack's own source directory is web's alone, so it stays readable.
      expect(body.roots.find((r) => r.kind === 'bind_root' && r.role === 'stack_source')).toBeDefined();
    });
  });

  it('lists only recorded directories node-wide, says so, and renders no stack to do it', async () => {
    const data = dataDir('web');
    models.byStack.web = [{ source: data, target: '/data' }];
    const rootId = await rootIdOf('web');
    expect((await capture('web', rootId)).status).toBe(202);
    await service().whenIdleForTests();
    const render = vi.spyOn(StackFileRoots.StackFileRootsService.prototype, 'listFsRoots');
    StackFileRoots.StackFileRootsService.invalidateNode(nodeId);
    const admin = await request(app).get('/api/recovery/storage').set('Cookie', adminCookie);
    expect(admin.body.fsRootsScope).toBe('recorded_only');
    expect(admin.body.roots.find((r: Record<string, unknown>) => r.kind === 'bind_root')).toMatchObject({ hostPath: data });
    expect(render).not.toHaveBeenCalled();
    // The node-wide listing needs the read node-wide, as it does for volumes.
    const scoped = await editorOf('web');
    await withoutGlobalRead(async () => {
      expect((await request(app).get('/api/recovery/storage').set('Cookie', scoped)).status).toBe(403);
    });
  });
});

describe('capturing a host directory', () => {
  it('admits a capture by root id after proving the host path, and records the directory once', async () => {
    const data = dataDir('web');
    models.byStack.web = [{ source: data, target: '/data' }];
    const rootId = await rootIdOf('web');
    const res = await capture('web', rootId);
    expect(res.status).toBe(202);
    expect(res.body.operation.kind).toBe('create_point');
    const storage = identityStore.StorageIdentityStore.getInstance().getById(res.body.operation.storageId)!;
    expect(storage).toMatchObject({ kind: 'bind_root', locator: data });
    expect(identityStore.StorageIdentityStore.getInstance().listDependents(storage.storageKey).map((d) => d.stackName)).toEqual(['web']);
    const stat = fs.statSync(data, { bigint: true });
    expect(storage.generationToken).toBe(`fs|${stat.ino}|1700000000.000000001`);
    // The proof bound the unproven path, through the probe profile only.
    expect(helperRuns[0]).toMatchObject({ profile: 'probe' });
  });

  it('captures a stack source directory', async () => {
    stackDir('web');
    const rootId = await rootIdOf('web', 'stack_source');
    expect(rootId).toBe('stack-source');
    expect((await capture('web', rootId)).status).toBe(202);
  });

  it('refuses a forged root id or an unknown stack, and reports either only to a caller who may know', async () => {
    dataDir('web');
    const forged = await capture('web', `bind:${'f'.repeat(16)}`);
    expect(forged.status).toBe(400);
    const unknownStack = await capture('ghost', 'stack-source');
    expect(unknownStack.status).toBe(400);
    const outsider = await editorOf('other');
    expect((await capture('web', `bind:${'f'.repeat(16)}`, outsider)).status).toBe(403);
    expect((await capture('ghost', 'stack-source', outsider)).status).toBe(403);
    // A path, a traversal and an absolute id are refused by the grammar, before a render.
    for (const rootId of ['/etc', '../x', 'bind:..', 'volume:abc']) {
      const res = await capture('web', rootId);
      expect(res.status, rootId).toBe(400);
    }
    expect(operationCount()).toBe(0);
  });

  it('authorizes against every stack that declares the directory before saying anything about it', async () => {
    const dir = path.join(shared, 'shared-auth');
    fs.mkdirSync(dir, { recursive: true });
    stackDir('web');
    stackDir('worker');
    models.byStack.web = [{ source: dir, target: '/data' }];
    models.byStack.worker = [{ source: dir, target: '/data' }];
    const rootId = await rootIdOf('web');
    expect((await capture('web', rootId, await editorOf('web'))).status).toBe(403);
    expect((await capture('web', rootId, await editorOf('web', 'worker'))).status).toBe(202);
  });

  it('holds the caller to the node-wide check when a stack cannot be rendered', async () => {
    const data = dataDir('web');
    models.byStack.web = [{ source: data, target: '/data' }];
    stackDir('broken');
    const rootId = await rootIdOf('web');
    expect((await capture('web', rootId, await editorOf('web'))).status).toBe(403);
    expect((await capture('web', rootId)).status).toBe(202);
  });

  it('refuses a directory the daemon resolves elsewhere and records nothing', async () => {
    const data = dataDir('web');
    const elsewhere = path.join(shared, 'not-the-same');
    fs.mkdirSync(elsewhere, { recursive: true });
    daemonView[data] = elsewhere;
    models.byStack.web = [{ source: data, target: '/data' }];
    const res = await capture('web', await rootIdOf('web'));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ errorClass: 'identity_unknown', reason: 'path_mapping_unproven' });
    expect(operationCount()).toBe(0);
    expect(identityStore.StorageIdentityStore.getInstance().listCurrent('docker-engine:engine-fs', 'bind_root')).toEqual([]);
  });

  it('refuses a declared spelling that the daemon resolves to a different directory', async () => {
    const data = dataDir('web');
    const linkParent = path.join(shared, 'links');
    fs.mkdirSync(linkParent, { recursive: true });
    const link = path.join(linkParent, 'data-link');
    fs.symlinkSync(data, link);
    const other = path.join(shared, 'other');
    fs.mkdirSync(other, { recursive: true });
    models.byStack.web = [{ source: link, target: '/data' }];
    // Sencho resolves the symlink to the stack's data; the daemon follows it elsewhere.
    daemonView[link] = other;
    const res = await capture('web', await rootIdOf('web'));
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('path_mapping_unproven');
    // The same declaration the daemon resolves to the same directory is proven and captured.
    daemonView = {};
    expect((await capture('web', await rootIdOf('web'))).status).toBe(202);
  });

  it('refuses an ineligible directory with its reason after authorization', async () => {
    stackDir('web');
    models.byStack.web = [{ source: '/etc', target: '/host-etc' }];
    const rootId = (await listing('web')).roots.find((r) => r.ineligibleReason === 'protected_host_path')?.rootId as string;
    const res = await capture('web', rootId);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/protected host path/);
    expect(helperRuns).toHaveLength(0);
  });

  it('puts a second host spelling of the same directory on the identity the first created, once it proves', async () => {
    const data = dataDir('web');
    models.byStack.web = [{ source: data, target: '/data' }];
    const stat = fs.statSync(data, { bigint: true });
    // A host symlink is another spelling of the same directory.
    const spelling = path.join(shared, `spelling-${randomUUID().slice(0, 8)}`);
    fs.symlinkSync(data, spelling);
    const existing = identityStore.StorageIdentityStore.getInstance().observe({
      ownerNodeKey: 'docker-engine:engine-fs', kind: 'bind_root', locator: spelling,
      generationToken: `fs|${stat.ino}|1700000000.000000001`, dependents: [{ stackName: 'web', serviceName: null }],
    });
    const res = await capture('web', await rootIdOf('web'));
    expect(res.status).toBe(202);
    expect(res.body.operation.storageId).toBe(existing.id);
  });

  it('does not merge onto a recorded spelling that no longer proves to this directory', async () => {
    const data = dataDir('web');
    models.byStack.web = [{ source: data, target: '/data' }];
    const stat = fs.statSync(data, { bigint: true });
    // The directory was moved: its old path keeps the token but is gone.
    const moved = identityStore.StorageIdentityStore.getInstance().observe({
      ownerNodeKey: 'docker-engine:engine-fs', kind: 'bind_root', locator: path.join(shared, 'moved-away'),
      generationToken: `fs|${stat.ino}|1700000000.000000001`, dependents: [],
    });
    const res = await capture('web', await rootIdOf('web'));
    expect(res.status).toBe(202);
    expect(res.body.operation.storageId).not.toBe(moved.id);
    expect(identityStore.StorageIdentityStore.getInstance().getById(res.body.operation.storageId)?.locator).toBe(data);
  });

  it('merges onto a later recorded spelling when the oldest one with the same token no longer proves', async () => {
    const data = dataDir('web');
    models.byStack.web = [{ source: data, target: '/data' }];
    const stat = fs.statSync(data, { bigint: true });
    const token = `fs|${stat.ino}|1700000000.000000001`;
    const store = identityStore.StorageIdentityStore.getInstance();
    const gone = store.observe({
      ownerNodeKey: 'docker-engine:engine-fs', kind: 'bind_root', locator: path.join(shared, 'gone-away'), generationToken: token, dependents: [],
    });
    const spelling = path.join(shared, `spelling-${randomUUID().slice(0, 8)}`);
    fs.symlinkSync(data, spelling);
    const later = store.observe({
      ownerNodeKey: 'docker-engine:engine-fs', kind: 'bind_root', locator: spelling, generationToken: token, dependents: [],
    });
    // The unprovable spelling is the oldest, so it is the one looked at first.
    recoveryDbModule.recoveryDb().prepare('UPDATE recovery_storage_identities SET first_seen_at = 1 WHERE id = ?').run(gone.id);
    const res = await capture('web', await rootIdOf('web'));
    expect(res.status).toBe(202);
    expect(res.body.operation.storageId).toBe(later.id);
  });

  it('keeps a spelling\'s own identity when an older spelling of the same directory also proves', async () => {
    const data = dataDir('web');
    models.byStack.web = [{ source: data, target: '/data' }];
    const stat = fs.statSync(data, { bigint: true });
    const token = `fs|${stat.ino}|1700000000.000000001`;
    const store = identityStore.StorageIdentityStore.getInstance();
    const spelling = path.join(shared, `older-${randomUUID().slice(0, 8)}`);
    fs.symlinkSync(data, spelling);
    const older = store.observe({
      ownerNodeKey: 'docker-engine:engine-fs', kind: 'bind_root', locator: spelling, generationToken: token, dependents: [],
    });
    recoveryDbModule.recoveryDb().prepare('UPDATE recovery_storage_identities SET first_seen_at = 1 WHERE id = ?').run(older.id);
    const own = store.observe({
      ownerNodeKey: 'docker-engine:engine-fs', kind: 'bind_root', locator: data, generationToken: token, dependents: [],
    });
    const res = await capture('web', await rootIdOf('web'));
    expect(res.status).toBe(202);
    expect(res.body.operation.storageId).toBe(own.id);
  });

  it('answers a capture as retryable while Docker does not say where its data root is', async () => {
    dataDir('web');
    models.byStack.web = [{ source: path.join(stackDir('web'), 'data'), target: '/data' }];
    dockerRootDir = undefined;
    const rootId = (await listing('web')).roots.find((r) => r.ineligibleReason === 'docker_root_unknown')?.rootId as string;
    expect(rootId).toBeTruthy();
    const res = await capture('web', rootId);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ errorClass: 'identity_unknown', reason: 'path_mapping_unproven' });
    expect(res.body.error).toMatch(/data root/);
    expect(operationCount()).toBe(0);
  });

  it('answers a replay with the same operation and refuses the key for a different request', async () => {
    const data = dataDir('web');
    models.byStack.web = [{ source: data, target: '/data' }];
    const rootId = await rootIdOf('web');
    const key = randomUUID();
    const first = await capture('web', rootId, adminCookie, key);
    expect(first.status).toBe(202);
    const replay = await capture('web', rootId, adminCookie, key);
    expect(replay.status).toBe(200);
    expect(replay.body.operation.id).toBe(first.body.operation.id);
    const other = await capture('web', 'stack-source', adminCookie, key);
    expect(other.status).not.toBe(202);
    expect(operationCount()).toBe(1);
  });

  it('refuses a capture of a directory inside one another operation holds', async () => {
    const data = dataDir('web');
    const inner = path.join(data, 'inner');
    fs.mkdirSync(inner);
    models.byStack.web = [{ source: data, target: '/data' }, { source: inner, target: '/inner' }];
    const roots = (await listing('web')).roots.filter((r) => r.kind === 'bind_root' && r.role === 'bind');
    const outer = roots.find((r) => r.hostPath === data)!.rootId as string;
    const nested = roots.find((r) => r.hostPath === inner)!.rootId as string;
    // The engine never finishes, so the outer capture keeps its storage lock.
    let release: () => void = () => undefined;
    engine.RecoveryEngineService.setEngineFactoryForTests(() => ({
      ...readerEngine,
      createPoint: () => new Promise((resolve) => {
        release = () => resolve({ ok: false, errorClass: 'interrupted' } as never);
      }),
    }) as never);
    expect((await capture('web', outer)).status).toBe(202);
    const refused = await capture('web', nested);
    expect(refused.status).toBe(409);
    expect(refused.body.errorClass).toBe('lock_held');
    release();
  });
});

/** A finished point of a host directory, captured through the route. */
async function capturedPoint(stack = 'web'): Promise<{ pointId: string; storageId: string; data: string }> {
  const data = dataDir(stack);
  models.byStack[stack] = [...(models.byStack[stack] ?? []), { source: data, target: '/data' }];
  const res = await capture(stack, await rootIdOf(stack));
  expect(res.status).toBe(202);
  await service().whenIdleForTests();
  const point = points.RecoveryPointStore.getInstance().findBySourceOperation(res.body.operation.id)!;
  expect(point.status).toBe('succeeded');
  return { pointId: point.id, storageId: res.body.operation.storageId, data };
}

describe('reading and restoring a host directory\'s points', () => {
  it('lists a directory\'s history only for a caller who may read every stack that declares it', async () => {
    const dir = path.join(shared, 'history');
    fs.mkdirSync(dir, { recursive: true });
    stackDir('web');
    stackDir('worker');
    models.byStack.web = [{ source: dir, target: '/data' }];
    models.byStack.worker = [{ source: dir, target: '/data' }];
    const res = await capture('web', await rootIdOf('web'));
    await service().whenIdleForTests();
    const storageId = res.body.operation.storageId as string;
    const ok = await request(app).get(`/api/recovery/storage/${storageId}/points`).set('Cookie', adminCookie);
    expect(ok.status).toBe(200);
    expect(ok.body.storage.kind).toBe('bind_root');
    const webOnly = await editorOf('web');
    const both = await editorOf('web', 'worker');
    await withoutGlobalRead(async () => {
      expect((await request(app).get(`/api/recovery/storage/${storageId}/points`).set('Cookie', webOnly)).status).toBe(403);
      expect((await request(app).get(`/api/recovery/operations/${res.body.operation.id}`).set('Cookie', webOnly)).status).toBe(403);
      expect((await request(app).get(`/api/recovery/storage/${storageId}/points`).set('Cookie', both)).status).toBe(200);
      expect((await request(app).get(`/api/recovery/operations/${res.body.operation.id}`).set('Cookie', both)).status).toBe(200);
    });
  });

  it('restores one path of a point into a new volume, and refuses a path the point does not hold', async () => {
    const { pointId } = await capturedPoint();
    const send = (pointPath: string) => request(app).post(`/api/recovery/points/${pointId}/restore/path`).set('Cookie', adminCookie)
      .send({ idempotencyKey: randomUUID(), targetVolumeName: 'restored_db', path: pointPath });
    const ok = await send('/db.sqlite');
    expect(ok.status).toBe(202);
    const intent = recoveryDbModule.recoveryDb().prepare('SELECT path_scope, target_volume FROM recovery_restore_intents WHERE operation_id = ?')
      .get(ok.body.operation.id) as { path_scope: string; target_volume: string };
    expect(intent).toEqual({ path_scope: 'db.sqlite', target_volume: 'restored_db' });
    const missing = await send('/missing');
    expect(missing.status).toBe(400);
    expect(missing.body.reason).toBe('path_not_found');
    expect((await send('/')).status).toBe(400);
    expect((await send('../etc/passwd')).status).toBe(400);
    expect((await send('/a/../../etc')).status).toBe(400);
  });

  it('releases a stale lock of a directory only for a caller who may restore every stack that declares it', async () => {
    const dir = path.join(shared, 'lock');
    fs.mkdirSync(dir, { recursive: true });
    stackDir('web');
    stackDir('worker');
    models.byStack.web = [{ source: dir, target: '/data' }];
    models.byStack.worker = [{ source: dir, target: '/data' }];
    const res = await capture('web', await rootIdOf('web'));
    await service().whenIdleForTests();
    const storage = identityStore.StorageIdentityStore.getInstance().getById(res.body.operation.storageId)!;
    const send = (cookie: string) => request(app).post('/api/recovery/locks/release').set('Cookie', cookie)
      .send({ scope: 'storage', resourceKey: storage.storageKey });
    expect((await send(await editorOf('web'))).status).toBe(403);
    expect((await send(await editorOf('web', 'worker'))).status).not.toBe(403);
  });
});

describe('overwriting a host directory', () => {
  async function preview(pointId: string, cookie = adminCookie) {
    return request(app).post(`/api/recovery/points/${pointId}/overwrite/preview`).set('Cookie', cookie).send({});
  }

  it('previews a bind directory with its host path, observers and nested mounts, and admits the typed path', async () => {
    const { pointId, data } = await capturedPoint();
    containers = [{ Id: 'monitor', Names: ['/monitor'], State: 'running', Labels: {}, Mounts: [{ Type: 'bind', Source: '/', RW: false }] }];
    const res = await preview(pointId);
    expect(res.status).toBe(200);
    expect(res.body.target).toMatchObject({ kind: 'bind_root', hostPath: data, volumeName: null, eligible: true });
    expect(res.body.dependents.observers).toEqual(['monitor']);
    expect(res.body.nestedMounts).toEqual([]);
    expect(res.body.confirmation.token).toMatch(/^[0-9a-f]{64}$/);
    // The confirmation types back the host path, never a volume name.
    const wrong = await request(app).post(`/api/recovery/points/${pointId}/overwrite`).set('Cookie', adminCookie)
      .send({ idempotencyKey: randomUUID(), confirmationToken: res.body.confirmation.token, confirmHostPath: `${data}/x` });
    expect(wrong.status).toBe(400);
    const asVolume = await request(app).post(`/api/recovery/points/${pointId}/overwrite`).set('Cookie', adminCookie)
      .send({ idempotencyKey: randomUUID(), confirmationToken: res.body.confirmation.token, confirmVolumeName: 'data' });
    expect(asVolume.status).toBe(400);
    expect(recoveryDbModule.recoveryDb().prepare('SELECT COUNT(*) AS n FROM recovery_restore_intents').get()).toEqual({ n: 0 });
    const admitted = await request(app).post(`/api/recovery/points/${pointId}/overwrite`).set('Cookie', adminCookie)
      .send({ idempotencyKey: randomUUID(), confirmationToken: res.body.confirmation.token, confirmHostPath: data });
    expect(admitted.status).toBe(202);
    const intent = recoveryDbModule.recoveryDb().prepare('SELECT target_volume, target_paths_json FROM recovery_restore_intents WHERE operation_id = ?')
      .get(admitted.body.operation.id) as { target_volume: string; target_paths_json: string };
    expect(intent.target_volume).toMatch(/^fs:[0-9a-f]{64}$/);
    expect(JSON.parse(intent.target_paths_json)).toEqual({ senchoPath: data, hostPath: data, aliases: [] });
    await service().whenIdleForTests();
    const operation = await request(app).get(`/api/recovery/operations/${admitted.body.operation.id}`).set('Cookie', adminCookie);
    expect(operation.body.result.intent.target).toEqual({ kind: 'bind_root', hostPath: data });
    expect(operation.body.result.intent.targetVolume).toBeNull();
  });

  it('refuses to overwrite a stack source directory', async () => {
    stackDir('web');
    const res = await capture('web', 'stack-source');
    await service().whenIdleForTests();
    const point = points.RecoveryPointStore.getInstance().findBySourceOperation(res.body.operation.id)!;
    const previewed = await preview(point.id);
    expect(previewed.body.target.eligible).toBe(false);
    expect(previewed.body.confirmation.token).toBeNull();
    const admitted = await request(app).post(`/api/recovery/points/${point.id}/overwrite`).set('Cookie', adminCookie)
      .send({ idempotencyKey: randomUUID(), confirmationToken: 'a'.repeat(64), confirmHostPath: stackDir('web') });
    expect(admitted.status).toBe(400);
    expect(admitted.body.reason).toBe('unsupported_target');
  });

  it('refuses a directory with a mount below it, and one no stack declares any more', async () => {
    const { pointId } = await capturedPoint();
    nestedMounts = ['cache'];
    const nested = await preview(pointId);
    expect(nested.body.target.eligible).toBe(false);
    expect(nested.body.nestedMounts).toEqual(['cache']);
    nestedMounts = [];
    models.byStack.web = [];
    StackFileRoots.StackFileRootsService.invalidateNode(nodeId);
    const undeclared = await request(app).post(`/api/recovery/points/${pointId}/overwrite`).set('Cookie', adminCookie)
      .send({ idempotencyKey: randomUUID(), confirmationToken: 'a'.repeat(64), confirmHostPath: '/x' });
    // A stack that stopped declaring the directory is a state that moved since the preview.
    expect(undeclared.status).toBe(409);
    expect(undeclared.body).toMatchObject({ errorClass: 'precondition_failed', reason: 'root_not_authorized' });
  });

  it('refuses a directory with a work directory left at its top level, worded for a directory', async () => {
    const { pointId } = await capturedPoint();
    topWorkDirs = ['.sencho-restore-4f3a2b1c-0d9e-4a8b-9c7d-6e5f4a3b2c1d'];
    const res = await preview(pointId);
    expect(res.body.target.eligible).toBe(false);
    expect(res.body.target.ineligibleReason).toMatch(/left a work directory \(\.sencho-restore-4f3a2b1c-0d9e-4a8b-9c7d-6e5f4a3b2c1d\) in this directory/);
    expect(res.body.confirmation.token).toBeNull();
  });

  it('refuses a parent while a directory inside it keeps the work directory of a restore whose fence was released', async () => {
    const { pointId, data } = await capturedPoint();
    const inner = path.join(data, 'inner');
    fs.mkdirSync(inner);
    const intentId = fencedOverwriteOf(fs.realpathSync(inner));
    // Settled by release_fence: no longer an overlap, but its work directory stays.
    recoveryDbModule.recoveryDb().prepare("UPDATE recovery_restore_intents SET phase = 'completion_unknown', fence_state = 'released' WHERE id = ?").run(intentId);
    const workDir = path.join(inner, `.sencho-restore-${intentId}`);
    fs.mkdirSync(path.join(workDir, 'original'), { recursive: true });
    const refused = await preview(pointId);
    expect(refused.body.target.eligible).toBe(false);
    expect(refused.body.target.ineligibleReason).toContain(`inner/.sencho-restore-${intentId}`);
    const confirmed = await request(app).post(`/api/recovery/points/${pointId}/overwrite`).set('Cookie', adminCookie)
      .send({ idempotencyKey: randomUUID(), confirmationToken: 'a'.repeat(64), confirmHostPath: data });
    expect(confirmed.status).toBe(400);
    expect(recoveryDbModule.recoveryDb().prepare('SELECT COUNT(*) AS n FROM recovery_restore_intents').get()).toEqual({ n: 1 });
    fs.rmSync(workDir, { recursive: true });
    expect((await preview(pointId)).body.target.eligible).toBe(true);
  });

  it('says a directory made again since the point was captured, and that Docker\'s unknown data root is a question to ask again', async () => {
    const { pointId, data } = await capturedPoint();
    dockerRootDir = undefined;
    const unknownRoot = await preview(pointId);
    expect(unknownRoot.body.target.eligible).toBe(false);
    expect(unknownRoot.body.target.ineligibleReason).toMatch(/data root/);
    const unknownConfirm = await request(app).post(`/api/recovery/points/${pointId}/overwrite`).set('Cookie', adminCookie)
      .send({ idempotencyKey: randomUUID(), confirmationToken: 'a'.repeat(64), confirmHostPath: data });
    expect(unknownConfirm.body).toMatchObject({ errorClass: 'precondition_failed', reason: 'path_mapping_unproven' });
    dockerRootDir = '/var/lib/docker';
    const replacement = path.join(shared, `remade-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(replacement);
    fs.rmSync(data, { recursive: true });
    fs.renameSync(replacement, data);
    const remade = await preview(pointId);
    expect(remade.body.target.eligible).toBe(false);
    expect(remade.body.target.ineligibleReason).toMatch(/removed and made again after this point was captured/);
  });

  it('answers precondition_failed when another stack starts declaring the directory after the preview', async () => {
    const dir = path.join(shared, 'grows');
    fs.mkdirSync(dir, { recursive: true });
    stackDir('web');
    models.byStack.web = [{ source: dir, target: '/data' }];
    const res = await capture('web', await rootIdOf('web'));
    await service().whenIdleForTests();
    const point = points.RecoveryPointStore.getInstance().findBySourceOperation(res.body.operation.id)!;
    const previewed = await preview(point.id);
    expect(previewed.body.target.eligible).toBe(true);
    stackDir('worker');
    models.byStack.worker = [{ source: dir, target: '/data' }];
    StackFileRoots.StackFileRootsService.invalidateNode(nodeId);
    const admitted = await request(app).post(`/api/recovery/points/${point.id}/overwrite`).set('Cookie', adminCookie)
      .send({ idempotencyKey: randomUUID(), confirmationToken: previewed.body.confirmation.token, confirmHostPath: dir });
    expect(admitted.status).toBe(409);
    expect(admitted.body.errorClass).toBe('precondition_failed');
    expect(recoveryDbModule.recoveryDb().prepare('SELECT COUNT(*) AS n FROM recovery_restore_intents').get()).toEqual({ n: 0 });
    // A caller who may not restore the stack that now depends on it is refused outright.
    const fresh = await preview(point.id, await editorOf('web'));
    expect(fresh.status).toBe(403);
  });
});

/**
 * A staged overwrite of `dir` whose operation has already ended and whose
 * storage lock is gone, with its fence held: the state only the intent records.
 */
function fencedOverwriteOf(dir: string, dependentStacks: string[] = []): string {
  const db = recoveryDbModule.recoveryDb();
  const storage = identityStore.StorageIdentityStore.getInstance().observe({
    ownerNodeKey: 'docker-engine:engine-fs', kind: 'bind_root', locator: dir,
    generationToken: `fs|${randomUUID()}|1700000000.000000001`, dependents: [],
  });
  const repositoryId = repositories.RecoveryRepositoryStore.getInstance().getActive()!.id;
  const operationId = randomUUID();
  db.prepare(`INSERT INTO recovery_operations (id, idempotency_key, kind, storage_id, actor, transport, state, error_class, process_epoch, created_at, updated_at)
    VALUES (?, ?, 'restore', ?, 'admin', 'local', 'completion_unknown', 'interrupted', 'old', 1, 1)`).run(operationId, randomUUID(), storage.id);
  const point = points.RecoveryPointStore.getInstance().begin({
    kind: 'root', storageId: storage.id, expectedGenerationToken: storage.generationToken, repositoryId,
    trigger: 'manual', actor: 'admin', sourceOperationId: operationId, sourceNodeKey: 'docker-engine:engine-fs', engineId: 'restic',
  });
  points.RecoveryPointStore.getInstance().finalize(point.id, {
    status: 'succeeded',
    evidence: { snapshotId: 's', capture: { fileCount: 1, byteCount: 1, skippedCount: 0 }, exclusions: [], consistency: 'unknown' },
  });
  const store = intentsStore();
  const intent = store.recordOverwrite({
    operationId, pointId: point.id, targetVolume: `fs:${storage.storageKey}`,
    targetPaths: { senchoPath: dir, hostPath: dir, aliases: [] }, actor: 'admin', processEpoch: 'old',
    stagingVolume: `sencho-recovery-stage-${randomUUID()}`, expectedGenerationToken: storage.generationToken,
    dependentStacks,
  });
  for (const step of ['staging', 'staged_verified', 'fenced'] as const) store.advance(intent.id, step);
  store.setFenceState(intent.id, 'held');
  return intent.id;
}

let intentsModule: typeof import('../services/recovery/restoreIntents') | null = null;
function intentsStore() {
  return intentsModule!.RestoreIntentStore.getInstance();
}

describe('the fence on a host directory, at the routes', () => {
  it('refuses file reads and writes that overlap a fenced directory, for the stack source and a bind root', async () => {
    const data = dataDir('web');
    fs.writeFileSync(path.join(data, 'a.txt'), 'x');
    models.byStack.web = [{ source: data, target: '/data' }];
    const bindId = await rootIdOf('web');
    fencedOverwriteOf(data, ['web']);
    const source = await request(app).get('/api/stacks/web/files').set('Cookie', adminCookie);
    expect(source.status).toBe(409);
    expect(source.body.code).toBe('data_restore');
    const bindRead = await request(app).get(`/api/stacks/web/files?rootId=${encodeURIComponent(bindId)}`).set('Cookie', adminCookie);
    expect(bindRead.status).toBe(409);
    expect(bindRead.body.code).toBe('data_restore');
    const bindWrite = await request(app).delete(`/api/stacks/web/files?rootId=${encodeURIComponent(bindId)}&path=a.txt`).set('Cookie', adminCookie);
    expect(bindWrite.status).toBe(409);
    expect(fs.existsSync(path.join(data, 'a.txt'))).toBe(true);
    // A stack whose directories do not overlap the fenced one is untouched.
    stackDir('other');
    expect((await request(app).get('/api/stacks/other/files').set('Cookie', adminCookie)).status).toBe(200);
  });

  it('compares a symlinked stack directory by the directory it resolves to', async () => {
    const real = path.join(shared, `web-real-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(path.join(real, 'data'), { recursive: true });
    fs.writeFileSync(path.join(real, 'compose.yaml'), 'services:\n  app:\n    image: nginx\n');
    fs.symlinkSync(real, path.join(process.env.COMPOSE_DIR as string, 'web'));
    fencedOverwriteOf(fs.realpathSync(path.join(real, 'data')), ['web']);
    const res = await request(app).get('/api/stacks/web/files').set('Cookie', adminCookie);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('data_restore');
  });

  it('does not read a bind root through a listing cached before its directory was swapped for a link into a fenced one', async () => {
    const swapped = path.join(shared, `swapped-${randomUUID().slice(0, 8)}`);
    const fenced = path.join(shared, `fenced-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(swapped);
    fs.mkdirSync(fenced);
    fs.writeFileSync(path.join(fenced, 'secret.txt'), 'mid-restore');
    stackDir('web');
    models.byStack.web = [{ source: swapped, target: '/data' }];
    const listed = await request(app).get('/api/stacks/web/file-roots').set('Cookie', adminCookie);
    const bindId = (listed.body as Array<{ id: string; kind: string }>).find((r) => r.kind === 'bind')?.id as string;
    expect(bindId).toBeTruthy();
    // The explorer's listing above is cached; the directory is then replaced by a link.
    fs.rmSync(swapped, { recursive: true });
    fs.symlinkSync(fenced, swapped);
    fencedOverwriteOf(fs.realpathSync(fenced), ['web']);
    const res = await request(app).get(`/api/stacks/web/files?rootId=${encodeURIComponent(bindId)}`).set('Cookie', adminCookie);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SYMLINK_ESCAPE');
    expect(JSON.stringify(res.body)).not.toContain('secret.txt');
  });

  it('refuses a Compose lifecycle on a stack the fenced directory recorded', async () => {
    const data = dataDir('web');
    fencedOverwriteOf(data, ['web']);
    const res = await request(app).post('/api/stacks/web/start').set('Cookie', adminCookie).send({});
    expect(res.status).toBe(409);
  });

  it('refuses a capture of a parent directory while a child overwrite still holds its fence, with no lock left', async () => {
    const data = dataDir('web');
    const inner = path.join(data, 'inner');
    fs.mkdirSync(inner);
    models.byStack.web = [{ source: data, target: '/data' }];
    const outer = await rootIdOf('web');
    fencedOverwriteOf(fs.realpathSync(inner));
    // The repository lock is free: only the overlap check can refuse this.
    expect(recoveryDbModule.recoveryDb().prepare('SELECT COUNT(*) AS n FROM recovery_locks').get()).toEqual({ n: 0 });
    const res = await capture('web', outer);
    expect(res.status).toBe(409);
    expect(res.body.errorClass).toBe('lock_held');
    expect(res.body.error).toMatch(/contains this one or is inside it/);
  });
});

describe('a directory overwrite confirmed against a state that moved', () => {
  async function previewed() {
    const { pointId, data } = await capturedPoint();
    const res = await request(app).post(`/api/recovery/points/${pointId}/overwrite/preview`).set('Cookie', adminCookie).send({});
    expect(res.body.target.eligible).toBe(true);
    return { pointId, data, token: res.body.confirmation.token as string };
  }
  const confirm = (pointId: string, token: string, hostPath: string) => request(app)
    .post(`/api/recovery/points/${pointId}/overwrite`).set('Cookie', adminCookie)
    .send({ idempotencyKey: randomUUID(), confirmationToken: token, confirmHostPath: hostPath });
  const intentCount = () => recoveryDbModule.recoveryDb().prepare('SELECT COUNT(*) AS n FROM recovery_restore_intents').get();

  it('answers precondition_failed when a mount appears below it', async () => {
    const { pointId, data, token } = await previewed();
    nestedMounts = ['cache'];
    const res = await confirm(pointId, token, data);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ errorClass: 'precondition_failed', reason: 'nested_mount' });
    expect(intentCount()).toEqual({ n: 0 });
  });

  it('answers precondition_failed when a container starts depending on it', async () => {
    const { pointId, data, token } = await previewed();
    containers = [{ Id: 'late', Names: ['/late'], State: 'running', Labels: {}, Mounts: [{ Type: 'bind', Source: data, RW: true }] }];
    const res = await confirm(pointId, token, data);
    expect(res.status).toBe(409);
    expect(res.body.errorClass).toBe('precondition_failed');
    expect(intentCount()).toEqual({ n: 0 });
  });

  it('gives the sentence of the reason it answers with when the directory was made again and a mount appeared', async () => {
    const { pointId, data, token } = await previewed();
    nestedMounts = ['cache'];
    const replacement = path.join(shared, `replacement-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(replacement);
    fs.rmSync(data, { recursive: true });
    fs.renameSync(replacement, data);
    const res = await confirm(pointId, token, data);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ errorClass: 'precondition_failed', reason: 'generation_changed' });
    expect(res.body.error).toMatch(/removed and made again/);
    expect(intentCount()).toEqual({ n: 0 });
  });

  it('answers precondition_failed when the directory was made again', async () => {
    const { pointId, data, token } = await previewed();
    const replacement = path.join(shared, `replacement-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(replacement);
    fs.rmSync(data, { recursive: true });
    fs.renameSync(replacement, data);
    const res = await confirm(pointId, token, data);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ errorClass: 'precondition_failed', reason: 'generation_changed' });
    expect(intentCount()).toEqual({ n: 0 });
  });
});

describe('reading a directory\'s points', () => {
  it('browses a point of a declared directory under the stack read, and one no stack declares only as an administrator', async () => {
    const { pointId } = await capturedPoint();
    const browse = (cookie: string) => request(app).get(`/api/recovery/points/${pointId}/browse?path=/db.sqlite`).set('Cookie', cookie);
    // The fake engine answers the path as a file, so a browse of it is a not-a-directory refusal: it reached the read.
    const admin = await browse(adminCookie);
    expect(admin.status).toBe(400);
    expect(admin.body.reason).toBe('not_a_directory');
    // A HEAD answers the download's headers and reads no bytes.
    const download = await request(app).head(`/api/recovery/points/${pointId}/download?path=/db.sqlite`).set('Cookie', adminCookie);
    expect(download.status).toBe(200);
    expect(download.headers['content-length']).toBe('1');
    // The stack is deleted: no stack declares the directory or holds it in its
    // source directory now, so its points are detached. (While the stack exists,
    // its writable source directory is an ancestor of ./data and keeps it a dependent.)
    fs.rmSync(path.join(process.env.COMPOSE_DIR as string, 'web'), { recursive: true, force: true });
    models.byStack.web = [];
    StackFileRoots.StackFileRootsService.invalidateNode(nodeId);
    const viewer = await editorOf('web');
    expect((await browse(viewer)).status).toBe(403);
    expect((await browse(adminCookie)).status).toBe(400);
  });
});
