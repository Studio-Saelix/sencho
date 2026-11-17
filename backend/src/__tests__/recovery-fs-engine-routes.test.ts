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
import { execFileSync } from 'child_process';
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

/**
 * The link shapes the late-admission matrices cover: a single link, a chain,
 * a chain whose middle hop is spelled through another path to the compose
 * root (`alias`), and a chain whose middle hop is a link outside the compose
 * root that points back into it (`outside`). A check bounded by the configured
 * root's spelling would follow neither of the last two.
 */
const LINK_SHAPES = ['single', 'chained', 'alias', 'outside'] as const;
type LinkShape = typeof LINK_SHAPES[number];

/** A new link outside the compose root that points at `target`, inside it. */
function outsideLinkTo(target: string): string {
  const dir = path.join(shared, `outside-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(dir);
  const link = path.join(dir, path.basename(target));
  fs.symlinkSync(target, link);
  return link;
}

/** A new link outside the compose root that names it: another path to the same directory. */
function composeRootAlias(): string {
  const alias = path.join(shared, `compose-alias-${randomUUID().slice(0, 8)}`);
  fs.symlinkSync(fs.realpathSync(process.env.COMPOSE_DIR as string), alias);
  return alias;
}

/**
 * Hold the next open of `file` for writing (the env sinks open it, then write
 * through the handle) until `held` settles, calling `entered` once it is held.
 */
function holdWriteOpenOf(file: string, entered: () => void, held: Promise<void>) {
  const original = fs.promises.open.bind(fs.promises);
  return vi.spyOn(fs.promises, 'open').mockImplementation((async (...args: Parameters<typeof fs.promises.open>) => {
    const flags = args[1];
    if (String(args[0]) === file && typeof flags === 'number' && (flags & fs.constants.O_WRONLY) !== 0) {
      entered();
      await held;
    }
    return original(...args);
  }) as typeof fs.promises.open);
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

  it('refuses to overwrite a directory beside a container whose bind it cannot prove clear of it', async () => {
    const { pointId, data } = await capturedPoint();
    // Another spelling of a directory that cannot be read: it could be this one.
    const unreadable = path.join(shared, `unreadable-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(unreadable);
    const original = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (target: fs.PathLike, options?: fs.StatOptions) => {
      if (path.resolve(String(target)) === unreadable) throw Object.assign(new Error('input/output error'), { code: 'EIO' });
      return original(target, options);
    }) as typeof fs.promises.stat);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    containers = [{ Id: 'maybe', Names: ['/maybe'], State: 'running', Labels: {}, Mounts: [{ Type: 'bind', Source: unreadable, RW: true }] }];
    const res = await preview(pointId);
    expect(res.status).toBe(409);
    expect(res.body.errorClass).toBe('identity_unknown');
    // Refused before the caller is authorized against its stack, so it names no container.
    expect(JSON.stringify(res.body)).not.toContain('maybe');
    // The same container proven clear of it is no part of the overwrite.
    vi.mocked(fs.promises.stat).mockRestore();
    const clear = await preview(pointId);
    expect(clear.status).toBe(200);
    expect(clear.body.target).toMatchObject({ hostPath: data, eligible: true });
  });

  it('refuses as unknown, not as undeclared, when the only declaration of the directory cannot be placed', async () => {
    const { pointId } = await capturedPoint();
    // The stack now declares the directory only by a spelling whose identity
    // cannot be read: it may be this directory, so "no stack declares it" is not known.
    const unreadable = path.join(shared, `declared-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(unreadable);
    models.byStack.web = [{ source: unreadable, target: '/data' }];
    StackFileRoots.StackFileRootsService.invalidateNode(nodeId);
    const original = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (target: fs.PathLike, options?: fs.StatOptions) => {
      if (path.resolve(String(target)) === unreadable) throw Object.assign(new Error('input/output error'), { code: 'EIO' });
      return original(target, options);
    }) as typeof fs.promises.stat);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await preview(pointId);
    expect(res.status).toBe(409);
    expect(res.body.errorClass).toBe('identity_unknown');
    const admitted = await request(app).post(`/api/recovery/points/${pointId}/overwrite`).set('Cookie', adminCookie)
      .send({ idempotencyKey: randomUUID(), confirmationToken: 'a'.repeat(64), confirmHostPath: '/x' });
    expect(admitted.status).toBe(409);
    expect(admitted.body.errorClass).toBe('identity_unknown');
    // Readable, the same spelling is another directory, and the refusal says no stack declares this one.
    vi.mocked(fs.promises.stat).mockRestore();
    const undeclared = await preview(pointId);
    expect(undeclared.status).toBe(200);
    expect(undeclared.body.target.eligible).toBe(false);
    expect(undeclared.body.target.ineligibleReason).toMatch(/No stack on this node declares this directory/);
  });

  it('keeps a stack source directory\'s own refusal when another stack\'s declaration cannot be placed', async () => {
    stackDir('web');
    const res = await capture('web', 'stack-source');
    await service().whenIdleForTests();
    const point = points.RecoveryPointStore.getInstance().findBySourceOperation(res.body.operation.id)!;
    const unreadable = path.join(shared, `other-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(unreadable);
    stackDir('other');
    models.byStack.other = [{ source: unreadable, target: '/data' }];
    StackFileRoots.StackFileRootsService.invalidateNode(nodeId);
    const original = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (target: fs.PathLike, options?: fs.StatOptions) => {
      if (path.resolve(String(target)) === unreadable) throw Object.assign(new Error('input/output error'), { code: 'EIO' });
      return original(target, options);
    }) as typeof fs.promises.stat);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const previewed = await preview(point.id);
    expect(previewed.status).toBe(200);
    expect(previewed.body.target.eligible).toBe(false);
    const admitted = await request(app).post(`/api/recovery/points/${point.id}/overwrite`).set('Cookie', adminCookie)
      .send({ idempotencyKey: randomUUID(), confirmationToken: 'a'.repeat(64), confirmHostPath: stackDir('web') });
    expect(admitted.status).toBe(400);
    expect(admitted.body.reason).toBe('unsupported_target');
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
  return fencedOverwriteOfPaths({ senchoPath: dir, hostPath: dir, aliases: [] }, dependentStacks);
}

function fencedOverwriteOfPaths(targetPaths: { senchoPath: string; hostPath: string; aliases: string[] }, dependentStacks: string[] = []): string {
  const dir = targetPaths.hostPath;
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
    targetPaths, actor: 'admin', processEpoch: 'old',
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
    // The fence follows the link to the directory it resolves to and refuses
    // first; without a fence the file gateway answers SYMLINK_ESCAPE.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('data_restore');
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

describe('file work already running when a directory is fenced', () => {
  async function gateway() {
    return (await import('../services/FileRootGateway')).FileRootGateway.prototype;
  }
  async function fenceModule() {
    return import('../services/recovery/restoreFence');
  }

  for (const variant of ['bind root', 'stack source'] as const) {
    it(`stops a bulk delete on the ${variant} at the next item once the directory is fenced`, async () => {
      const data = dataDir('web');
      fs.writeFileSync(path.join(data, 'a.txt'), 'a');
      fs.writeFileSync(path.join(data, 'b.txt'), 'b');
      models.byStack.web = [{ source: data, target: '/data' }];
      const query = variant === 'bind root' ? `?rootId=${encodeURIComponent(await rootIdOf('web'))}` : '';
      const paths = variant === 'bind root' ? ['a.txt', 'b.txt'] : ['data/a.txt', 'data/b.txt'];
      const proto = await gateway();
      const original = proto.deletePath;
      let calls = 0;
      vi.spyOn(proto, 'deletePath').mockImplementation(async function (this: unknown, ...args: Parameters<typeof original>) {
        calls += 1;
        // The overwrite fences the directory while the first item is deleted.
        if (calls === 1) fencedOverwriteOf(data, ['web']);
        return original.apply(this, args);
      });
      const res = await request(app).post(`/api/stacks/web/files/bulk-delete${query}`).set('Cookie', adminCookie).send({ paths });
      expect(res.status).toBe(200);
      expect(res.body.deleted).toEqual([paths[0]]);
      expect(res.body.failed).toEqual([{ path: paths[1], error: expect.stringMatching(/data restore/) }]);
      expect(calls).toBe(1);
      expect(fs.existsSync(path.join(data, 'b.txt'))).toBe(true);
    });
  }

  it('stops a bulk move at the next item once the directory is fenced', async () => {
    const data = dataDir('web');
    fs.writeFileSync(path.join(data, 'a.txt'), 'a');
    fs.writeFileSync(path.join(data, 'b.txt'), 'b');
    fs.mkdirSync(path.join(data, 'into'));
    models.byStack.web = [{ source: data, target: '/data' }];
    const bindId = await rootIdOf('web');
    const proto = await gateway();
    const original = proto.rename;
    let calls = 0;
    vi.spyOn(proto, 'rename').mockImplementation(async function (this: unknown, ...args: Parameters<typeof original>) {
      calls += 1;
      if (calls === 1) fencedOverwriteOf(data, ['web']);
      return original.apply(this, args);
    });
    const res = await request(app).post(`/api/stacks/web/files/bulk-move?rootId=${encodeURIComponent(bindId)}`)
      .set('Cookie', adminCookie).send({ from: ['a.txt', 'b.txt'], toDir: 'into' });
    expect(res.status).toBe(200);
    expect(res.body.moved).toEqual(['a.txt']);
    expect(res.body.failed).toEqual([{ path: 'b.txt', error: expect.stringMatching(/data restore/) }]);
    expect(fs.existsSync(path.join(data, 'b.txt'))).toBe(true);
  });

  const routeCases: Array<{
    name: string;
    kind: 'write' | 'read';
    hold: 'writeIfUnchanged' | 'deletePath' | 'mkdir' | 'rename' | 'chmod' | 'listDir' | 'download' | 'getMode' | 'stat';
    send: (root: string) => import('supertest').Test;
  }> = [
    { name: 'PUT files/content', kind: 'write', hold: 'writeIfUnchanged', send: (q) => request(app).put(`/api/stacks/web/files/content?${q}&path=a.txt`).send({ content: 'x' }) },
    { name: 'DELETE files', kind: 'write', hold: 'deletePath', send: (q) => request(app).delete(`/api/stacks/web/files?${q}&path=a.txt`) },
    { name: 'POST files/folder', kind: 'write', hold: 'mkdir', send: (q) => request(app).post(`/api/stacks/web/files/folder?${q}&path=new`) },
    { name: 'PATCH files/rename', kind: 'write', hold: 'rename', send: (q) => request(app).patch(`/api/stacks/web/files/rename?${q}`).send({ from: 'a.txt', to: 'b.txt' }) },
    { name: 'PUT files/permissions', kind: 'write', hold: 'chmod', send: (q) => request(app).put(`/api/stacks/web/files/permissions?${q}&path=a.txt`).send({ mode: 0o644 }) },
    { name: 'GET files', kind: 'read', hold: 'listDir', send: (q) => request(app).get(`/api/stacks/web/files?${q}`) },
    { name: 'GET files/download', kind: 'read', hold: 'download', send: (q) => request(app).get(`/api/stacks/web/files/download?${q}&path=a.txt`) },
    { name: 'GET files/permissions', kind: 'read', hold: 'getMode', send: (q) => request(app).get(`/api/stacks/web/files/permissions?${q}&path=a.txt`) },
    { name: 'GET files/bulk-download', kind: 'read', hold: 'stat', send: (q) => request(app).get(`/api/stacks/web/files/bulk-download?${q}&path=a.txt`) },
  ];

  for (const route of routeCases) {
    it(`${route.kind === 'write' ? 'waits for' : 'cuts off'} ${route.name} already running when the directory is fenced`, async () => {
      const data = dataDir('web');
      fs.writeFileSync(path.join(data, 'a.txt'), 'a');
      models.byStack.web = [{ source: data, target: '/data' }];
      const query = `rootId=${encodeURIComponent(await rootIdOf('web'))}`;
      const proto = await gateway() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const original = proto[route.hold];
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => { entered = resolve; });
      let finish!: () => void;
      const held = new Promise<void>((resolve) => { finish = resolve; });
      vi.spyOn(proto, route.hold).mockImplementation(async function (this: unknown, ...args: unknown[]) {
        entered();
        await held;
        return original.apply(this, args);
      });
      const pending = route.send(query).set('Cookie', adminCookie).then(() => 'answered', () => 'cut off');
      await inside;
      const fence = await fenceModule();
      fencedOverwriteOf(data, ['web']);
      const target = { senchoPath: data, hostPath: data, aliases: [] };
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      if (route.kind === 'write') {
        expect(await fence.waitForFsWorkOn(target, 50)).toBe(false);
        const drained = fence.waitForFsWorkOn(target, 5_000);
        finish();
        expect(await pending).toBe('answered');
        expect(await drained).toBe(true);
      } else {
        expect(await fence.waitForFsWorkOn(target, 5_000)).toBe(true);
        finish();
        expect(await pending).toBe('cut off');
      }
      for (let i = 0; i < 100 && fence.fsWorkInFlightCountForTests() > 0; i += 1) await new Promise((r) => setTimeout(r, 10));
      expect(fence.fsWorkInFlightCountForTests()).toBe(0);
    });
  }

  it('keeps a fence waiting while a copy into the directory is running, and lets it go once the copy has answered', async () => {
    const data = dataDir('web');
    fs.writeFileSync(path.join(data, 'a.txt'), 'a');
    models.byStack.web = [{ source: data, target: '/data' }];
    const bindId = await rootIdOf('web');
    const proto = await gateway();
    const original = proto.copy;
    let entered!: () => void;
    const inCopy = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    vi.spyOn(proto, 'copy').mockImplementation(async function (this: unknown, ...args: Parameters<typeof original>) {
      entered();
      await held;
      return original.apply(this, args);
    });
    const copying = request(app).post(`/api/stacks/web/files/copy?rootId=${encodeURIComponent(bindId)}`)
      .set('Cookie', adminCookie).send({ from: 'a.txt', to: 'b.txt' }).then((r) => r);
    await inCopy;
    const fence = await fenceModule();
    fencedOverwriteOf(data, ['web']);
    const target = { senchoPath: data, hostPath: data, aliases: [] };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The overwrite cannot go ahead under the copy: its drain gives up.
    expect(await fence.waitForFsWorkOn(target, 50)).toBe(false);
    const drained = fence.waitForFsWorkOn(target, 5_000);
    finish();
    expect((await copying).status).toBe(204);
    expect(await drained).toBe(true);
    expect(fence.fsWorkInFlightCountForTests()).toBe(0);
  });

  it('cuts off an upload whose body was still arriving when the directory was fenced, without waiting for it, and writes nothing', async () => {
    const data = dataDir('web');
    models.byStack.web = [{ source: data, target: '/data' }];
    const bindId = await rootIdOf('web');
    const fence = await fenceModule();
    const http = await import('http');
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as import('net').AddressInfo).port;
      const boundary = 'fencetestboundary';
      const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="late.txt"\r\nContent-Type: text/plain\r\n\r\n`;
      const tail = `late bytes\r\n--${boundary}--\r\n`;
      let drained: boolean | undefined;
      const outcome = await new Promise<string>((resolve) => {
        const req = http.request({
          host: '127.0.0.1', port, method: 'POST',
          path: `/api/stacks/web/files/upload?rootId=${encodeURIComponent(bindId)}`,
          headers: {
            Cookie: adminCookie,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': Buffer.byteLength(head) + Buffer.byteLength(tail),
          },
        }, (res) => {
          res.resume();
          res.on('end', () => resolve(`answered ${res.statusCode}`));
          res.on('error', () => resolve('cut off'));
        });
        req.on('error', () => resolve('cut off'));
        req.write(head);
        // The upload has been admitted and is waiting for the rest of its body.
        void (async () => {
          for (let i = 0; i < 100 && fence.fsWorkInFlightCountForTests() === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
          fencedOverwriteOf(data, ['web']);
          // The overwrite does not wait on the slow client.
          drained = await fence.waitForFsWorkOn({ senchoPath: data, hostPath: data, aliases: [] }, 5_000);
          req.end(tail);
        })();
      });
      expect(drained).toBe(true);
      expect(outcome).toBe('cut off');
      expect(fs.existsSync(path.join(data, 'late.txt'))).toBe(false);
      for (let i = 0; i < 100 && fence.fsWorkInFlightCountForTests() > 0; i += 1) await new Promise((r) => setTimeout(r, 10));
      expect(fence.fsWorkInFlightCountForTests()).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('writes nothing for an upload cut off after its whole body was sent but before it was spooled', async () => {
    const data = dataDir('web');
    models.byStack.web = [{ source: data, target: '/data' }];
    const bindId = await rootIdOf('web');
    const fence = await fenceModule();
    // The spool directory is made late, so the body has fully arrived and the
    // write is still to come when the fence cuts the upload off.
    let openSpool!: () => void;
    const spoolHeld = new Promise<void>((resolve) => { openSpool = resolve; });
    let spoolAsked = false;
    const originalMkdir = fs.promises.mkdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'mkdir').mockImplementation((async (target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      if (String(target).includes('upload')) {
        spoolAsked = true;
        await spoolHeld;
      }
      return originalMkdir(target, options);
    }) as unknown as typeof fs.promises.mkdir);
    const http = await import('http');
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as import('net').AddressInfo).port;
      const boundary = 'fencetestboundary';
      const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="late.txt"\r\nContent-Type: text/plain\r\n\r\nlate bytes\r\n--${boundary}--\r\n`;
      const outcome = new Promise<string>((resolve) => {
        const req = http.request({
          host: '127.0.0.1', port, method: 'POST',
          path: `/api/stacks/web/files/upload?rootId=${encodeURIComponent(bindId)}`,
          headers: { Cookie: adminCookie, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': Buffer.byteLength(body) },
        }, (res) => {
          res.resume();
          res.on('end', () => resolve(`answered ${res.statusCode}`));
          res.on('error', () => resolve('cut off'));
        });
        req.on('error', () => resolve('cut off'));
        req.end(body);
      });
      for (let i = 0; i < 200 && !spoolAsked; i += 1) await new Promise((r) => setTimeout(r, 10));
      expect(spoolAsked).toBe(true);
      fencedOverwriteOf(data, ['web']);
      expect(await fence.waitForFsWorkOn({ senchoPath: data, hostPath: data, aliases: [] }, 5_000)).toBe(true);
      expect(await outcome).toBe('cut off');
      openSpool();
      for (let i = 0; i < 100 && fence.fsWorkInFlightCountForTests() > 0; i += 1) await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, 200));
      expect(fs.existsSync(path.join(data, 'late.txt'))).toBe(false);
    } finally {
      openSpool();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('cuts off a read of the directory that is still running when it is fenced, without waiting for it', async () => {
    const data = dataDir('web');
    fs.writeFileSync(path.join(data, 'a.txt'), 'a');
    models.byStack.web = [{ source: data, target: '/data' }];
    const bindId = await rootIdOf('web');
    const proto = await gateway();
    const original = proto.read;
    let entered!: () => void;
    const inRead = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    vi.spyOn(proto, 'read').mockImplementation(async function (this: unknown, ...args: Parameters<typeof original>) {
      entered();
      await held;
      return original.apply(this, args);
    });
    const reading = request(app).get(`/api/stacks/web/files/content?rootId=${encodeURIComponent(bindId)}&path=a.txt`)
      .set('Cookie', adminCookie).then(() => 'answered', () => 'cut off');
    await inRead;
    const fence = await fenceModule();
    fencedOverwriteOf(data, ['web']);
    expect(await fence.waitForFsWorkOn({ senchoPath: data, hostPath: data, aliases: [] }, 5_000)).toBe(true);
    finish();
    expect(await reading).toBe('cut off');
  });

  it('refuses file work on a stack directory reached through a second own bind destination of the fenced tree', async () => {
    const compose = fs.realpathSync(process.env.COMPOSE_DIR as string);
    stackDir('web');
    // The same host tree is also mounted at a second destination, where the
    // overwrite recorded the directory.
    const secondDestination = path.join(shared, `second-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(path.join(secondDestination, 'web', 'data'), { recursive: true });
    const SelfIdentityService = (await import('../services/SelfIdentityService')).default;
    vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue([
      { source: '/hoststacks', destination: compose },
      { source: '/hoststacks', destination: secondDestination },
    ]);
    fencedOverwriteOfPaths({ senchoPath: path.join(secondDestination, 'web', 'data'), hostPath: '/hoststacks/web/data', aliases: [] });
    const read = await request(app).get('/api/stacks/web/files').set('Cookie', adminCookie);
    expect(read.status).toBe(409);
    expect(read.body.code).toBe('data_restore');
    const write = await request(app).put('/api/stacks/web/files/content?path=compose.yaml').set('Cookie', adminCookie).send({ content: 'x' });
    expect(write.status).toBe(409);
    stackDir('other');
    expect((await request(app).get('/api/stacks/other/files').set('Cookie', adminCookie)).status).toBe(200);
  });
});

describe('the Compose and env editors and the Secrets file sinks under a directory fence', () => {
  /** A stack whose env file lives in its `data` bind, the directory a restore overwrites. */
  function envStack(): { dir: string; data: string; envFile: string } {
    // dataDir writes the stack's plain compose file, so the env_file one goes after it.
    const data = dataDir('web');
    const dir = stackDir('web');
    fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  app:\n    image: nginx\n    env_file: data/app.env\n');
    const envFile = path.join(data, 'app.env');
    fs.writeFileSync(envFile, 'A=1\n');
    models.byStack.web = [{ source: data, target: '/data' }];
    return { dir, data, envFile };
  }
  const putEnv = (file: string, query = '', ifMatch?: string) => {
    const req = request(app).put(`/api/stacks/web/env?file=${encodeURIComponent(file)}${query}`).set('Cookie', adminCookie);
    return (ifMatch ? req.set('If-Match', ifMatch) : req).send({ content: 'A=2\n' });
  };

  it('refuses an env read and every kind of env save of a file in the fenced directory, and leaves its bytes alone', async () => {
    const { data, envFile } = envStack();
    const opened = await request(app).get(`/api/stacks/web/env?file=${encodeURIComponent(envFile)}`).set('Cookie', adminCookie);
    expect(opened.status).toBe(200);
    const etag = opened.headers.etag as string;
    fencedOverwriteOf(data, ['web']);
    const variants = {
      read: await request(app).get(`/api/stacks/web/env?file=${encodeURIComponent(envFile)}`).set('Cookie', adminCookie),
      save: await putEnv(envFile),
      conditional: await putEnv(envFile, '', etag),
      forced: await putEnv(envFile, '&create=1&force=1'),
    };
    for (const [name, res] of Object.entries(variants)) {
      expect(res.status, name).toBe(409);
      expect(res.body.code, name).toBe('data_restore');
    }
    expect(fs.readFileSync(envFile, 'utf-8')).toBe('A=1\n');
  });

  it('refuses creating an env file in a fenced directory', async () => {
    const dir = stackDir('web');
    fencedOverwriteOf(dir, ['web']);
    const res = await request(app).put('/api/stacks/web/env?create=1').set('Cookie', adminCookie).send({ content: 'A=1\n' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('data_restore');
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
  });

  it('refuses a Compose read and save through a link into the fenced directory', async () => {
    const { dir, data } = envStack();
    fs.writeFileSync(path.join(data, 'compose.yaml'), 'services:\n  app:\n    image: nginx\n');
    fs.rmSync(path.join(dir, 'compose.yaml'));
    fs.symlinkSync(path.join('data', 'compose.yaml'), path.join(dir, 'compose.yaml'));
    fencedOverwriteOf(data, ['web']);
    const read = await request(app).get('/api/stacks/web').set('Cookie', adminCookie);
    expect(read.status).toBe(409);
    expect(read.body.code).toBe('data_restore');
    const save = await request(app).put('/api/stacks/web').set('Cookie', adminCookie).send({ content: 'services: {}\n' });
    expect(save.status).toBe(409);
    expect(save.body.code).toBe('data_restore');
    expect(fs.readFileSync(path.join(data, 'compose.yaml'), 'utf-8')).toBe('services:\n  app:\n    image: nginx\n');
  });

  it('refuses the local Secrets read and write of an env file in the fenced directory, and an import with the fence\'s reason', async () => {
    const { data, envFile } = envStack();
    fencedOverwriteOf(data, ['web']);
    const { FileSystemService } = await import('../services/FileSystemService');
    const files = FileSystemService.getInstance(nodeId);
    await expect(files.writeFile(envFile, 'A=2\n')).rejects.toMatchObject({ code: 'data_restore' });
    await expect(files.readFile(envFile)).rejects.toMatchObject({ code: 'data_restore' });
    expect(fs.readFileSync(envFile, 'utf-8')).toBe('A=1\n');
    const { SecretsService, SecretSourceRefusedError } = await import('../services/SecretsService');
    await expect(SecretsService.getInstance().readImportOverlay(nodeId, 'web', 'app.env'))
      .rejects.toBeInstanceOf(SecretSourceRefusedError);
  });

  it('refuses deleting a stack whose directory holds the fenced directory, before anything is stopped', async () => {
    const { dir, data } = envStack();
    // A dependent stack is already closed by the restore's stack lock; this one
    // holds the directory without being recorded as one (another stack binds it).
    fencedOverwriteOf(data, ['other']);
    const { ComposeService } = await import('../services/ComposeService');
    const rendering = ComposeService.getInstance();
    const down = vi.fn(async () => undefined);
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      ...rendering,
      evaluateDockerEndpoint: async () => null,
      downStack: down,
    } as unknown as ReturnType<typeof ComposeService.getInstance>);
    const res = await request(app).delete('/api/stacks/web').set('Cookie', adminCookie);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('data_restore');
    expect(down).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, 'compose.yaml'))).toBe(true);
    expect(fs.readFileSync(path.join(data, 'app.env'), 'utf-8')).toBe('A=1\n');
    // The removal is fenced as well, for a fence recorded after that check.
    const { FileSystemService } = await import('../services/FileSystemService');
    await expect(FileSystemService.getInstance(nodeId).deleteStack('web')).rejects.toMatchObject({ code: 'data_restore' });
    expect(fs.existsSync(data)).toBe(true);
  });

  /** `envStack`, with the compose file itself moved into the fenced directory and linked from the stack. */
  function linkedComposeStack(): { dir: string; data: string; envFile: string; compose: string } {
    const stack = envStack();
    const compose = path.join(stack.data, 'compose.yaml');
    fs.renameSync(path.join(stack.dir, 'compose.yaml'), compose);
    fs.symlinkSync(path.join('data', 'compose.yaml'), path.join(stack.dir, 'compose.yaml'));
    return { ...stack, compose };
  }

  it('refuses a Compose save whose opened file is no longer the one resolved, instead of answering with the fenced file', async () => {
    const { data, compose } = linkedComposeStack();
    const before = fs.readFileSync(compose, 'utf-8');
    fencedOverwriteOf(data, ['web']);
    const fence = await import('../services/recovery/restoreFence');
    const res = await request(app).put('/api/stacks/web').set('Cookie', adminCookie)
      .set('X-Compose-File', 'docker-compose.yml').send({ content: 'services: {}\n' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('data_restore');
    expect(res.body.currentContent).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('env_file');
    expect(fs.readFileSync(compose, 'utf-8')).toBe(before);
    expect(fence.fsWorkInFlightCountForTests()).toBe(0);
  });

  it('refuses the conflict read when the compose file changes to a link into the fenced directory during an admitted save', async () => {
    const { dir, data, compose } = linkedComposeStack();
    const before = fs.readFileSync(compose, 'utf-8');
    // A second compose file outside the fence is the one the editor opened.
    const opened = path.join(dir, 'docker-compose.yml');
    fs.writeFileSync(opened, 'services:\n  other:\n    image: nginx\n');
    fencedOverwriteOf(data, ['other']);
    const { FileSystemService } = await import('../services/FileSystemService');
    const proto = FileSystemService.prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const original = proto.resolveComposeFile;
    let calls = 0;
    // The first resolution still names the opened file, so the save is admitted
    // on it; the one inside the admission sees the link into the fence.
    vi.spyOn(proto, 'resolveComposeFile').mockImplementation(async function (this: unknown, ...args: unknown[]) {
      calls += 1;
      if (calls === 1) return { filename: 'docker-compose.yml', absolute: opened };
      return original.apply(this, args);
    });
    const res = await request(app).put('/api/stacks/web').set('Cookie', adminCookie)
      .set('X-Compose-File', 'docker-compose.yml').send({ content: 'services: {}\n' });
    expect(calls).toBe(2);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('data_restore');
    expect(res.body.currentContent).toBeUndefined();
    expect(fs.readFileSync(compose, 'utf-8')).toBe(before);
    expect(fs.readFileSync(opened, 'utf-8')).toBe('services:\n  other:\n    image: nginx\n');
  });

  it('refuses the env file list, the env editor and the env inventory when the compose file is in the fenced directory, and creates no env file', async () => {
    const { dir, data, envFile } = linkedComposeStack();
    const listed = await request(app).get('/api/stacks/web/envs').set('Cookie', adminCookie);
    expect(listed.body.envFiles).toEqual([envFile]);
    fencedOverwriteOf(data, ['web']);
    const variants = {
      list: await request(app).get('/api/stacks/web/envs').set('Cookie', adminCookie),
      read: await request(app).get('/api/stacks/web/env').set('Cookie', adminCookie),
      create: await request(app).put('/api/stacks/web/env?create=1').set('Cookie', adminCookie).send({ content: 'A=9\n' }),
      save: await request(app).put('/api/stacks/web/env').set('Cookie', adminCookie).send({ content: 'A=9\n' }),
      inventory: await request(app).get('/api/stacks/web/env-inventory').set('Cookie', adminCookie),
    };
    for (const [name, res] of Object.entries(variants)) {
      expect(res.status, name).toBe(409);
      expect(res.body.code, name).toBe('data_restore');
    }
    expect(variants.read.headers['x-env-exists']).toBeUndefined();
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
    expect(fs.readFileSync(envFile, 'utf-8')).toBe('A=1\n');
  });

  it('refuses a Secrets import whose env file the fenced compose file declares', async () => {
    const { data } = linkedComposeStack();
    const { SecretsService, SecretSourceRefusedError } = await import('../services/SecretsService');
    const secrets = SecretsService.getInstance();
    fencedOverwriteOf(data, ['web']);
    const refused = secrets.readImportOverlay(nodeId, 'web', 'app.env');
    await expect(refused).rejects.toBeInstanceOf(SecretSourceRefusedError);
    await expect(refused).rejects.toThrow(/data restore is overwriting/);
  });

  it('refuses the env routes when a declared env file is missing from the fenced directory mid-swap, and lists one that is there', async () => {
    const { dir, data, envFile } = envStack();
    fencedOverwriteOf(data, ['web']);
    // Present under the fence, the file is only listed: its bytes are read by the refused editor alone.
    const present = await request(app).get('/api/stacks/web/envs').set('Cookie', adminCookie);
    expect(present.status).toBe(200);
    expect(present.body.envFiles).toEqual([envFile]);
    // Moved aside by the swap, it is not known to be missing.
    fs.renameSync(envFile, `${envFile}.aside`);
    const variants = {
      list: await request(app).get('/api/stacks/web/envs').set('Cookie', adminCookie),
      read: await request(app).get('/api/stacks/web/env').set('Cookie', adminCookie),
      create: await request(app).put('/api/stacks/web/env?create=1').set('Cookie', adminCookie).send({ content: 'A=9\n' }),
    };
    for (const [name, res] of Object.entries(variants)) {
      expect(res.status, name).toBe(409);
      expect(res.body.code, name).toBe('data_restore');
    }
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
  });

  it('refuses the env routes when the compose file links into the fenced directory and is missing from it mid-swap', async () => {
    const { dir, data, compose } = linkedComposeStack();
    fencedOverwriteOf(data, ['web']);
    fs.renameSync(compose, `${compose}.aside`);
    const variants = {
      list: await request(app).get('/api/stacks/web/envs').set('Cookie', adminCookie),
      read: await request(app).get('/api/stacks/web/env').set('Cookie', adminCookie),
      create: await request(app).put('/api/stacks/web/env?create=1').set('Cookie', adminCookie).send({ content: 'A=9\n' }),
    };
    for (const [name, res] of Object.entries(variants)) {
      expect(res.status, name).toBe(409);
      expect(res.body.code, name).toBe('data_restore');
    }
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
  });

  it('answers a stack with no env file and no fence as before', async () => {
    const dir = stackDir('plain');
    const fence = fencedOverwriteOf(dataDir('web'), ['web']);
    expect(fence).toBeTruthy();
    const listed = await request(app).get('/api/stacks/plain/envs').set('Cookie', adminCookie);
    expect(listed.status).toBe(200);
    expect(listed.body.envFiles).toEqual([]);
    const read = await request(app).get('/api/stacks/plain/env').set('Cookie', adminCookie);
    expect(read.status).toBe(200);
    expect(read.headers['x-env-exists']).toBe('false');
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
  });

  /** Every env route a stack's absence answer could come from, asked at once. */
  async function envRoutes(stack = 'web') {
    return {
      list: await request(app).get(`/api/stacks/${stack}/envs`).set('Cookie', adminCookie),
      read: await request(app).get(`/api/stacks/${stack}/env`).set('Cookie', adminCookie),
      create: await request(app).put(`/api/stacks/${stack}/env?create=1`).set('Cookie', adminCookie).send({ content: 'A=9\n' }),
      inventory: await request(app).get(`/api/stacks/${stack}/env-inventory`).set('Cookie', adminCookie),
    };
  }
  /** `envRoutes`, plus the Compose editor's read and a Compose Doctor run, which read or look for the compose file first. */
  async function composeRoutes(stack = 'web') {
    return {
      ...await envRoutes(stack),
      compose: await request(app).get(`/api/stacks/${stack}`).set('Cookie', adminCookie),
      preflight: await request(app).post(`/api/stacks/${stack}/preflight/run`).set('Cookie', adminCookie),
    };
  }
  function expectRefused(variants: Record<string, request.Response>): void {
    for (const [name, res] of Object.entries(variants)) {
      expect(res.status, name).toBe(409);
      expect(res.body.code, name).toBe('data_restore');
      expect(res.headers['x-env-exists'], name).toBeUndefined();
    }
  }

  it('refuses the env routes when an applied Git deploy spec names a compose link that dangles into the fenced directory', async () => {
    const { dir, data, compose } = linkedComposeStack();
    vi.spyOn(DatabaseService.getInstance(), 'getGitSource').mockReturnValue(
      { applied_deploy_spec: { files: ['compose.yaml'] } } as never,
    );
    fencedOverwriteOf(data, ['web']);
    fs.renameSync(compose, `${compose}.aside`);
    expectRefused(await composeRoutes());
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
  });

  it('refuses the env routes when the compose file reaches the fenced directory through a chain of links', async () => {
    const { dir, data, compose } = linkedComposeStack();
    fs.rmSync(path.join(dir, 'compose.yaml'));
    fs.symlinkSync(path.join('data', 'compose.yaml'), path.join(dir, 'middle.yaml'));
    fs.symlinkSync('middle.yaml', path.join(dir, 'compose.yaml'));
    fencedOverwriteOf(data, ['web']);
    fs.renameSync(compose, `${compose}.aside`);
    expectRefused(await composeRoutes());
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
  });

  it('refuses the env routes when a chained compose link names its middle hop through another path to the compose root', async () => {
    const { dir, data, compose } = linkedComposeStack();
    fs.rmSync(path.join(dir, 'compose.yaml'));
    fs.symlinkSync(path.join('data', 'compose.yaml'), path.join(dir, 'middle.yaml'));
    fs.symlinkSync(path.join(composeRootAlias(), 'web', 'middle.yaml'), path.join(dir, 'compose.yaml'));
    fencedOverwriteOf(data, ['web']);
    fs.renameSync(compose, `${compose}.aside`);
    expectRefused(await composeRoutes());
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
  });

  it('refuses the env routes when the compose file reaches the fenced directory through a linked directory', async () => {
    const { dir, data, compose } = linkedComposeStack();
    fs.rmSync(path.join(dir, 'compose.yaml'));
    fs.symlinkSync('data', path.join(dir, 'source'));
    fs.symlinkSync(path.join('source', 'compose.yaml'), path.join(dir, 'compose.yaml'));
    fencedOverwriteOf(data, ['web']);
    fs.renameSync(compose, `${compose}.aside`);
    expectRefused(await composeRoutes());
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
  });

  /**
   * `envStack`, with the declared env file reached through
   * `app.env -> mid.env -> data/app.env`; with `alias`, the first hop names
   * mid.env through another path to the compose root.
   */
  function chainedEnvStack(alias = false): { dir: string; data: string; envFile: string } {
    const stack = envStack();
    fs.writeFileSync(path.join(stack.dir, 'compose.yaml'), 'services:\n  app:\n    image: nginx\n    env_file: app.env\n');
    fs.symlinkSync(path.join('data', 'app.env'), path.join(stack.dir, 'mid.env'));
    fs.symlinkSync(alias ? path.join(composeRootAlias(), 'web', 'mid.env') : 'mid.env', path.join(stack.dir, 'app.env'));
    return stack;
  }

  it('refuses the env routes and a Secrets import when a declared env file reaches the fenced directory through a chain of links', async () => {
    for (const alias of [false, true]) {
      resetStack();
      const { dir, data, envFile } = chainedEnvStack(alias);
      fencedOverwriteOf(data, ['web']);
      fs.renameSync(envFile, `${envFile}.aside`);
      expectRefused(await envRoutes());
      expect(fs.existsSync(path.join(dir, '.env')), String(alias)).toBe(false);
      const { SecretsService, SecretSourceRefusedError } = await import('../services/SecretsService');
      const refused = SecretsService.getInstance().readImportOverlay(nodeId, 'web', 'app.env');
      await expect(refused, String(alias)).rejects.toBeInstanceOf(SecretSourceRefusedError);
      await expect(refused, String(alias)).rejects.toThrow(/data restore is overwriting/);
    }
  });

  it('still answers a chained env link that dangles outside any fence as not there', async () => {
    const { dir, envFile } = chainedEnvStack();
    fencedOverwriteOf(dataDir('other'), ['other']);
    fs.renameSync(envFile, `${envFile}.aside`);
    const listed = await request(app).get('/api/stacks/web/envs').set('Cookie', adminCookie);
    expect(listed.status).toBe(200);
    expect(listed.body.envFiles).toEqual([]);
    const read = await request(app).get('/api/stacks/web/env').set('Cookie', adminCookie);
    expect(read.status).toBe(200);
    expect(read.headers['x-env-exists']).toBe('false');
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
  });

  it('refuses the env routes when the compose file disappears into the fenced directory between discovery and its read', async () => {
    const { dir, data, compose } = linkedComposeStack();
    fencedOverwriteOf(data, ['web']);
    const { FileSystemService } = await import('../services/FileSystemService');
    const proto = FileSystemService.prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const original = proto.access;
    const link = path.join(dir, 'compose.yaml');
    // Found by discovery, then moved aside by the swap before it is read.
    vi.spyOn(proto, 'access').mockImplementation(async function (this: unknown, ...args: unknown[]) {
      const result = await original.apply(this, args);
      if (String(args[0]) === link && fs.existsSync(compose)) fs.renameSync(compose, `${compose}.aside`);
      return result;
    });
    const res = await request(app).get('/api/stacks/web/envs').set('Cookie', adminCookie);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('data_restore');
    fs.renameSync(`${compose}.aside`, compose);
    const created = await request(app).put('/api/stacks/web/env?create=1').set('Cookie', adminCookie).send({ content: 'A=9\n' });
    expect(created.status).toBe(409);
    expect(created.body.code).toBe('data_restore');
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
  });

  it('refuses the env editor\'s read when a fence lands after the env files were resolved and the file is gone by the second check', async () => {
    for (const query of ['', '?file=']) {
      vi.restoreAllMocks();
      const { data, envFile } = chainedEnvStack();
      const { FileSystemService } = await import('../services/FileSystemService');
      const proto = FileSystemService.prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const original = proto.access;
      const link = path.join(path.dirname(data), 'app.env');
      let calls = 0;
      // Resolution finds the file; the fence and the swap land before the route checks it again.
      vi.spyOn(proto, 'access').mockImplementation(async function (this: unknown, ...args: unknown[]) {
        if (String(args[0]) === link && ++calls === 2) {
          fencedOverwriteOf(data, ['web']);
          fs.renameSync(envFile, `${envFile}.aside`);
        }
        return original.apply(this, args);
      });
      const url = `/api/stacks/web/env${query}${query ? encodeURIComponent(link) : ''}`;
      const res = await request(app).get(url).set('Cookie', adminCookie);
      expect(calls, query).toBe(2);
      expect(res.status, query).toBe(409);
      expect(res.body.code, query).toBe('data_restore');
      expect(res.headers['x-env-exists'], query).toBeUndefined();
      fs.rmSync(path.dirname(data), { recursive: true, force: true });
      recoveryDbModule.recoveryDb().prepare('DELETE FROM recovery_restore_intents').run();
    }
  });

  it('refuses an env save whose link dangles into a directory fenced since the env files were resolved', async () => {
    const { dir, data, envFile } = chainedEnvStack();
    const { FileSystemService } = await import('../services/FileSystemService');
    const proto = FileSystemService.prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const original = proto.writeFileIfUnchanged;
    vi.spyOn(proto, 'writeFileIfUnchanged').mockImplementation(async function (this: unknown, ...args: unknown[]) {
      if (!fs.existsSync(`${envFile}.aside`)) {
        fencedOverwriteOf(data, ['web']);
        fs.renameSync(envFile, `${envFile}.aside`);
      }
      return original.apply(this, args);
    });
    // Pinned to the file, and the default file the editor saves without one.
    for (const query of [`?file=${encodeURIComponent(path.join(dir, 'app.env'))}`, '']) {
      const res = await request(app).put(`/api/stacks/web/env${query}`).set('Cookie', adminCookie).send({ content: 'A=9\n' });
      expect(res.status, query).toBe(409);
      expect(res.body.code, query).toBe('data_restore');
      expect(fs.existsSync(envFile), query).toBe(false);
      expect(fs.readFileSync(`${envFile}.aside`, 'utf-8'), query).toBe('A=1\n');
      fs.renameSync(`${envFile}.aside`, envFile);
      recoveryDbModule.recoveryDb().prepare('DELETE FROM recovery_restore_intents').run();
    }
  });

  it('refuses the env editor\'s read when a fence lands between its existence check and its read', async () => {
    for (const query of ['', '?file=']) {
      vi.restoreAllMocks();
      const { data, envFile } = chainedEnvStack();
      const { FileSystemService } = await import('../services/FileSystemService');
      const proto = FileSystemService.prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const original = proto.readFile;
      const link = path.join(path.dirname(data), 'app.env');
      let hooked = false;
      vi.spyOn(proto, 'readFile').mockImplementation(async function (this: unknown, ...args: unknown[]) {
        if (String(args[0]) === link && !hooked) {
          hooked = true;
          fencedOverwriteOf(data, ['web']);
          fs.renameSync(envFile, `${envFile}.aside`);
        }
        return original.apply(this, args);
      });
      const res = await request(app).get(`/api/stacks/web/env${query}${query ? encodeURIComponent(link) : ''}`).set('Cookie', adminCookie);
      expect(hooked, query).toBe(true);
      expect(res.status, query).toBe(409);
      expect(res.body.code, query).toBe('data_restore');
      expect(res.headers['x-env-exists'], query).toBeUndefined();
      fs.rmSync(path.dirname(data), { recursive: true, force: true });
      recoveryDbModule.recoveryDb().prepare('DELETE FROM recovery_restore_intents').run();
    }
  });

  it('answers file work as overlapping when one spelling overlaps the fenced directory and another cannot be placed, in either order', async () => {
    const data = dataDir('web');
    fencedOverwriteOf(data, ['web']);
    const fence = await import('../services/recovery/restoreFence');
    const fsRoots = await import('../services/recovery/fsRoots');
    const unplaceable = path.join(stackDir('web'), 'unplaceable');
    const inside = path.join(data, 'app.env');
    vi.spyOn(fsRoots, 'relateToFencedDirectory').mockImplementation(async (spelling) =>
      (spelling === unplaceable ? 'unknown' : spelling === inside ? 'overlap' : 'unrelated'));
    for (const spellings of [[unplaceable, inside], [inside, unplaceable]]) {
      const match = await fence.matchFsWorkToFences(spellings);
      expect(match.refusal?.message, spellings.join(' ')).toMatch(/overlaps the directory/);
    }
    const unproven = await fence.matchFsWorkToFences([unplaceable, path.join(stackDir('web'), 'elsewhere')]);
    expect(unproven.refusal?.message).toMatch(/cannot prove/);
    const clear = await fence.matchFsWorkToFences([path.join(stackDir('web'), 'elsewhere')]);
    expect(clear.refusal).toBeNull();
  });

  it('ends a link loop instead of following it, and refuses it as unprovable while a fence is held', async () => {
    const { dir } = chainedEnvStack();
    fs.rmSync(path.join(dir, 'app.env'));
    fs.rmSync(path.join(dir, 'mid.env'));
    fs.symlinkSync('mid.env', path.join(dir, 'app.env'));
    fs.symlinkSync('app.env', path.join(dir, 'mid.env'));
    fencedOverwriteOf(dataDir('other'), ['other']);
    const res = await request(app).get('/api/stacks/web/envs').set('Cookie', adminCookie);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('data_restore');
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
  });

  it('still answers a stack with no compose file as not found while another directory is fenced', async () => {
    fencedOverwriteOf(dataDir('other'), ['other']);
    fs.mkdirSync(path.join(process.env.COMPOSE_DIR as string, 'empty'), { recursive: true });
    const res = await request(app).get('/api/stacks/empty/env-inventory').set('Cookie', adminCookie);
    expect(res.status).toBe(404);
    const created = await request(app).put('/api/stacks/empty/env?create=1').set('Cookie', adminCookie).send({ content: 'A=1\n' });
    expect(created.status).toBe(404);
  });

  it('refuses a Secrets read and write whose link dangles into a directory fenced since the env files were resolved', async () => {
    const { data, envFile } = chainedEnvStack();
    const { FileSystemService } = await import('../services/FileSystemService');
    const { SecretsService, SecretSourceRefusedError } = await import('../services/SecretsService');
    const proto = FileSystemService.prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const method of ['readFile', 'writeFile'] as const) {
      vi.restoreAllMocks();
      const original = proto[method];
      vi.spyOn(proto, method).mockImplementation(async function (this: unknown, ...args: unknown[]) {
        if (path.basename(String(args[0])) === 'app.env' && !fs.existsSync(`${envFile}.aside`)) {
          fencedOverwriteOf(data, ['web']);
          fs.renameSync(envFile, `${envFile}.aside`);
        }
        return original.apply(this, args);
      });
      const secrets = SecretsService.getInstance();
      if (method === 'readFile') {
        const refused = secrets.readImportOverlay(nodeId, 'web', 'app.env');
        await expect(refused).rejects.toBeInstanceOf(SecretSourceRefusedError);
        await expect(refused).rejects.toThrow(/data restore is overwriting/);
      } else {
        const { id } = secrets.create({ name: `push-race-${randomUUID().slice(0, 8)}`, kv: { A: '2' }, user: 'admin' });
        const selector = { type: 'nodes' as const, ids: [nodeId] };
        const plan = await secrets.previewPushDiff(id, selector, 'web', 'app.env');
        const result = await secrets.executePush(id, {
          selector, stackName: 'web', envFileBasename: 'app.env', expectedVersion: plan.version,
          expectedTargets: plan.targets.map(({ nodeId: target, fingerprint }) => ({ nodeId: target, fingerprint })),
          user: 'admin',
        });
        expect(result.results[0].status).toBe('failed');
        expect(JSON.stringify(result.results[0])).toMatch(/data restore is overwriting/);
      }
      expect(fs.existsSync(envFile)).toBe(false);
      fs.renameSync(`${envFile}.aside`, envFile);
      recoveryDbModule.recoveryDb().prepare('DELETE FROM recovery_restore_intents').run();
    }
  });

  it('refuses a Secrets push into the fenced directory: as a whole when its preview read the target, per target when it did not', async () => {
    const { data, envFile } = envStack();
    const { SecretsService } = await import('../services/SecretsService');
    const secrets = SecretsService.getInstance();
    const { id } = secrets.create({ name: `push-fenced-${randomUUID().slice(0, 8)}`, kv: { A: '2' }, user: 'admin' });
    const selector = { type: 'nodes' as const, ids: [nodeId] };
    const plan = await secrets.previewPushDiff(id, selector, 'web', 'app.env');
    const expectedTargets = plan.targets.map(({ nodeId: target, fingerprint }) => ({ nodeId: target, fingerprint }));
    expect(expectedTargets[0].fingerprint).not.toBeNull();
    fencedOverwriteOf(data, ['web']);
    await expect(secrets.executePush(id, {
      selector, stackName: 'web', envFileBasename: 'app.env', expectedVersion: plan.version, expectedTargets, user: 'admin',
    })).rejects.toMatchObject({ name: 'PushTargetChangedError', reason: 'unreachable' });
    expect(fs.readFileSync(envFile, 'utf-8')).toBe('A=1\n');
    // Previewed under the fence: nothing was reviewed, so only that target fails.
    const fencedPlan = await secrets.previewPushDiff(id, selector, 'web', 'app.env');
    const result = await secrets.executePush(id, {
      selector, stackName: 'web', envFileBasename: 'app.env', expectedVersion: fencedPlan.version,
      expectedTargets: fencedPlan.targets.map(({ nodeId: target, fingerprint }) => ({ nodeId: target, fingerprint })),
      user: 'admin',
    });
    expect(result.results[0].status).toBe('failed');
    expect(fs.readFileSync(envFile, 'utf-8')).toBe('A=1\n');
  });

  it('refuses a Blueprint withdrawing a stack whose directory holds the fenced directory, before anything is stopped', async () => {
    const { dir, data } = envStack();
    fencedOverwriteOf(data, ['other']);
    const { ComposeService } = await import('../services/ComposeService');
    const rendering = ComposeService.getInstance();
    const down = vi.fn(async () => undefined);
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      ...rendering,
      evaluateDockerEndpoint: async () => null,
      downStack: down,
    } as unknown as ReturnType<typeof ComposeService.getInstance>);
    const res = await request(app).post('/api/blueprints/withdraw-local').set('Cookie', adminCookie)
      .send({ stackName: 'web', blueprintId: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('data_restore');
    expect(down).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, 'compose.yaml'))).toBe(true);
  });

  /** Remove the stack directory and every recorded overwrite, so a loop can build the next shape. */
  function resetStack(stack = 'web'): void {
    fs.rmSync(path.join(process.env.COMPOSE_DIR as string, stack), { recursive: true, force: true });
    recoveryDbModule.recoveryDb().prepare('DELETE FROM recovery_restore_fence_members').run();
    recoveryDbModule.recoveryDb().prepare('DELETE FROM recovery_restore_intents').run();
  }
  /**
   * `linkedComposeStack` with `compose.yaml` reached through a chain:
   * compose.yaml -> mid.yaml -> data/compose.yaml. With `alias`, the first hop
   * names mid.yaml through another path to the compose root.
   */
  function chainedComposeStack(alias = false): { dir: string; data: string; compose: string } {
    const stack = linkedComposeStack();
    fs.rmSync(path.join(stack.dir, 'compose.yaml'));
    fs.symlinkSync(path.join('data', 'compose.yaml'), path.join(stack.dir, 'mid.yaml'));
    fs.symlinkSync(alias ? path.join(composeRootAlias(), 'web', 'mid.yaml') : 'mid.yaml', path.join(stack.dir, 'compose.yaml'));
    return stack;
  }
  /** `linkedComposeStack` with `compose.yaml` reached through a link outside the compose root: compose.yaml -> <outside>/compose.yaml -> data/compose.yaml. */
  function outsideComposeStack(): { dir: string; data: string; compose: string } {
    const stack = linkedComposeStack();
    fs.rmSync(path.join(stack.dir, 'compose.yaml'));
    fs.symlinkSync(outsideLinkTo(stack.compose), path.join(stack.dir, 'compose.yaml'));
    return stack;
  }
  /** The compose stack for one link shape of the late-admission matrices. */
  function composeStackOf(shape: LinkShape): { dir: string; data: string; compose: string } {
    if (shape === 'outside') return outsideComposeStack();
    return shape === 'single' ? linkedComposeStack() : chainedComposeStack(shape === 'alias');
  }

  it('refuses a Compose save through a link that dangles into the fenced directory mid-swap, and creates no file', async () => {
    for (const shape of LINK_SHAPES) {
      resetStack();
      const { dir, data, compose } = composeStackOf(shape);
      const opened = await request(app).get('/api/stacks/web').set('Cookie', adminCookie);
      expect(opened.status, shape).toBe(200);
      fencedOverwriteOf(data, ['web']);
      fs.renameSync(compose, `${compose}.aside`);
      const save = () => request(app).put('/api/stacks/web').set('Cookie', adminCookie);
      const variants = {
        plain: await save().send({ content: 'services: {}\n' }),
        conditional: await save().set('If-Match', opened.headers.etag as string).send({ content: 'services: {}\n' }),
        pinned: await save().set('X-Compose-File', 'compose.yaml').send({ content: 'services: {}\n' }),
        read: await request(app).get('/api/stacks/web').set('Cookie', adminCookie),
      };
      for (const [name, res] of Object.entries(variants)) {
        expect(res.status, `${shape} ${name}`).toBe(409);
        expect(res.body.code, `${shape} ${name}`).toBe('data_restore');
      }
      expect(fs.existsSync(compose), shape).toBe(false);
      expect(fs.lstatSync(path.join(dir, 'compose.yaml')).isSymbolicLink(), shape).toBe(true);
      expect(fs.readFileSync(`${compose}.aside`, 'utf-8'), shape).toBe('services:\n  app:\n    image: nginx\n    env_file: data/app.env\n');
    }
  });

  it('keeps the link answers for a Compose link that dangles outside any fence', async () => {
    const { compose } = chainedComposeStack();
    fencedOverwriteOf(dataDir('other'), ['other']);
    fs.renameSync(compose, `${compose}.aside`);
    const read = await request(app).get('/api/stacks/web').set('Cookie', adminCookie);
    expect(read.status).toBe(409);
    expect(read.body.code).toBeUndefined();
    expect(read.body.error).toMatch(/links outside the stack directory/);
    const save = await request(app).put('/api/stacks/web').set('Cookie', adminCookie).send({ content: 'services: {}\n' });
    expect(save.status).toBe(409);
    expect(save.body.code).toBeUndefined();
    expect(save.body.error).toMatch(/Sencho cannot save it here/);
    const conditional = await request(app).put('/api/stacks/web').set('Cookie', adminCookie).set('If-Match', '"1"').send({ content: 'services: {}\n' });
    expect(conditional.status).toBe(409);
    expect(conditional.body.code).toBeUndefined();
    expect(fs.existsSync(compose)).toBe(false);
  });

  it('answers the services list and the update preview with the fence when the compose file links into the fenced directory mid-swap', async () => {
    const { ImageUpdateService } = await import('../services/ImageUpdateService');
    vi.spyOn(ImageUpdateService, 'isChecksEnabled').mockReturnValue(true);
    const reads = () => ({
      services: request(app).get('/api/stacks/web/services').set('Cookie', adminCookie),
      preview: request(app).get('/api/stacks/web/update-preview').set('Cookie', adminCookie),
      reconcile: request(app).post('/api/stacks/web/update-preview').set('Cookie', adminCookie),
    });
    for (const shape of LINK_SHAPES) {
      resetStack();
      const { data, compose } = composeStackOf(shape);
      const opened = await request(app).get('/api/stacks/web/services').set('Cookie', adminCookie);
      expect(opened.status, shape).toBe(200);
      expect(opened.body, shape).toEqual(['app']);
      fencedOverwriteOf(data, ['web']);
      fs.renameSync(compose, `${compose}.aside`);
      for (const [name, pending] of Object.entries(reads())) {
        const res = await pending;
        expect(res.status, `${shape} ${name}`).toBe(409);
        expect(res.body.code, `${shape} ${name}`).toBe('data_restore');
      }
    }
    // No fence on the link's way: the answer is the read failure it was before.
    resetStack();
    const { compose } = chainedComposeStack();
    fencedOverwriteOf(dataDir('other'), ['other']);
    fs.renameSync(compose, `${compose}.aside`);
    for (const [name, pending] of Object.entries(reads())) {
      const res = await pending;
      expect(res.status, name).toBe(500);
      expect(res.body.code, name).toBeUndefined();
    }
  });

  it('logs a fence check on a missing compose file that fails, and answers it as unproven instead of as a stack that is gone', async () => {
    const { ImageUpdateService } = await import('../services/ImageUpdateService');
    vi.spyOn(ImageUpdateService, 'isChecksEnabled').mockReturnValue(true);
    const dir = stackDir('web');
    fencedOverwriteOf(dataDir('other'), ['other']);
    expect((await request(app).get('/api/stacks').set('Cookie', adminCookie)).body).toContain('web');
    fs.renameSync(path.join(dir, 'compose.yaml'), path.join(dir, 'compose.yaml.aside'));
    const envFileResolution = await import('../helpers/envFileResolution');
    vi.spyOn(envFileResolution, 'refuseIfFencedSource').mockRejectedValue(new Error('fence store unreadable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const listed = await request(app).get('/api/stacks').set('Cookie', adminCookie);
    expect(listed.body).toContain('web');
    const bulk = await request(app).post('/api/stacks/bulk').set('Cookie', adminCookie).send({ action: 'stop', stackNames: ['web'] });
    expect(bulk.body.results[0]).toMatchObject({ stackName: 'web', ok: false, code: 'data_restore' });
    for (const [name, res] of Object.entries({
      read: await request(app).get('/api/stacks/web').set('Cookie', adminCookie),
      services: await request(app).get('/api/stacks/web/services').set('Cookie', adminCookie),
      preview: await request(app).get('/api/stacks/web/update-preview').set('Cookie', adminCookie),
    })) {
      expect(res.status, name).toBe(409);
      expect(res.body.code, name).toBe('data_restore');
      expect(res.body.error, name).toMatch(/cannot prove/);
    }
    expect(warn.mock.calls.some((call) => String(call[0]).includes('answering as unproven') && String(call[2]).includes('fence store unreadable'))).toBe(true);
  });

  it('answers the Compose editor with the fence when the opened file is missing from the fenced stack directory', async () => {
    const dir = stackDir('web');
    fencedOverwriteOf(dir, ['web']);
    fs.renameSync(path.join(dir, 'compose.yaml'), path.join(dir, 'compose.yaml.aside'));
    const read = await request(app).get('/api/stacks/web').set('Cookie', adminCookie);
    const pinned = await request(app).put('/api/stacks/web').set('Cookie', adminCookie)
      .set('X-Compose-File', 'compose.yaml').send({ content: 'services: {}\n' });
    for (const [name, res] of Object.entries({ read, pinned })) {
      expect(res.status, name).toBe(409);
      expect(res.body.code, name).toBe('data_restore');
    }
    expect(fs.existsSync(path.join(dir, 'compose.yaml'))).toBe(false);
  });

  it('refuses an automated Compose write and a Fleet snapshot restore through a link that dangles into the fenced directory', async () => {
    const { compose } = linkedComposeStack();
    fencedOverwriteOf(path.dirname(compose), ['other']);
    fs.renameSync(compose, `${compose}.aside`);
    const { FileSystemService } = await import('../services/FileSystemService');
    await expect(FileSystemService.getInstance(nodeId).saveStackContent('web', 'services: {}\n'))
      .rejects.toMatchObject({ code: 'data_restore' });
    // With and without a compose.yaml to write: the stack is not taken for a new one either way.
    for (const files of [[{ filename: 'compose.yaml', content: 'services: {}\n' }], [{ filename: '.env', content: 'A=1\n' }]]) {
      const applied = await request(app).post('/api/stacks/web/fleet-snapshot-apply').set('Cookie', adminCookie).send({ files });
      expect(applied.status, files[0].filename).toBe(409);
      expect(applied.body.code, files[0].filename).toBe('data_restore');
    }
    expect(fs.existsSync(compose)).toBe(false);
  });

  it('keeps a stack whose compose file is mid-swap in the stack list and its scan history, and answers a bulk action with the fence', async () => {
    stackDir('other');
    const { data, compose } = linkedComposeStack();
    const listedBefore = await request(app).get('/api/stacks').set('Cookie', adminCookie);
    expect(listedBefore.body).toEqual(expect.arrayContaining(['web', 'other']));
    fencedOverwriteOf(data, ['web']);
    fs.renameSync(compose, `${compose}.aside`);
    const listed = await request(app).get('/api/stacks').set('Cookie', adminCookie);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual(expect.arrayContaining(['web', 'other']));
    const bulk = await request(app).post('/api/stacks/bulk').set('Cookie', adminCookie).send({ action: 'stop', stackNames: ['web'] });
    expect(bulk.status).toBe(200);
    expect(bulk.body.results[0]).toMatchObject({ stackName: 'web', ok: false, code: 'data_restore' });
    // The scan reconcile purges the rows of a stack missing from the list.
    const DockerController = (await import('../services/DockerController')).default;
    vi.spyOn(DockerController.prototype, 'getImages').mockResolvedValue([]);
    const { MonitorService } = await import('../services/MonitorService');
    const scans = { getDistinctScanImageRefs: vi.fn().mockReturnValue(['stack:web', 'stack:other', 'stack:gone']), deleteScansByImageRef: vi.fn().mockReturnValue(1) };
    await (MonitorService.getInstance() as unknown as { reconcileOrphanedScans: (db: unknown, s: Record<string, string>) => Promise<void> })
      .reconcileOrphanedScans(scans, { prune_orphaned_scans: '1' });
    expect(scans.deleteScansByImageRef.mock.calls.map((c) => c[1])).toEqual(['stack:gone']);
  });

  it('answers a stack scan and a template deploy onto a stack whose compose file is mid-swap with the fence, and writes nothing', async () => {
    const { dir, data, compose } = linkedComposeStack();
    fencedOverwriteOf(data, ['other']);
    fs.renameSync(compose, `${compose}.aside`);
    const TrivyService = (await import('../services/TrivyService')).default;
    const trivy = TrivyService.getInstance();
    vi.spyOn(trivy, 'isTrivyAvailable').mockReturnValue(true);
    (trivy as unknown as { binaryPath: string | null }).binaryPath = '/usr/bin/trivy-test';
    try {
      const scan = await request(app).post('/api/security/scan/stack').set('Cookie', adminCookie).send({ stackName: 'web' });
      expect(scan.status).toBe(409);
      expect(scan.body.code).toBe('data_restore');
    } finally {
      (trivy as unknown as { binaryPath: string | null }).binaryPath = null;
    }
    const deploy = await request(app).post('/api/templates/deploy').set('Cookie', adminCookie)
      .send({ stackName: 'web', template: { title: 'nginx', image: 'nginx' } });
    expect(deploy.status).toBe(409);
    expect(deploy.body.code).toBe('data_restore');
    expect(fs.lstatSync(path.join(dir, 'compose.yaml')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(compose)).toBe(false);
  });

  it('drops a stack with no compose file from the list and the bulk action as before while only another directory is fenced', async () => {
    stackDir('other');
    const { compose } = linkedComposeStack();
    fencedOverwriteOf(dataDir('third'), ['third']);
    fs.renameSync(compose, `${compose}.aside`);
    const listed = await request(app).get('/api/stacks').set('Cookie', adminCookie);
    expect(listed.body).not.toContain('web');
    expect(listed.body).toContain('other');
    const bulk = await request(app).post('/api/stacks/bulk').set('Cookie', adminCookie).send({ action: 'stop', stackNames: ['web'] });
    expect(bulk.body.results[0]).toMatchObject({ stackName: 'web', ok: false, code: 'not_found' });
    const TrivyService = (await import('../services/TrivyService')).default;
    const trivy = TrivyService.getInstance();
    vi.spyOn(trivy, 'isTrivyAvailable').mockReturnValue(true);
    (trivy as unknown as { binaryPath: string | null }).binaryPath = '/usr/bin/trivy-test';
    try {
      const scan = await request(app).post('/api/security/scan/stack').set('Cookie', adminCookie).send({ stackName: 'web' });
      expect(scan.status).toBe(404);
    } finally {
      (trivy as unknown as { binaryPath: string | null }).binaryPath = null;
    }
  });

  it('keeps listing a mid-swap stack the fence does not name: by its compose link, or because it was listed before the fence', async () => {
    const root = process.env.COMPOSE_DIR as string;
    stackDir('other');
    // Never listed, not named by the fence: its docker-compose.yml link dangles into the fenced directory.
    const linked = `linked-${randomUUID().slice(0, 8)}`;
    const data = path.join(root, linked, 'data');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'docker-compose.yml'), 'services: {}\n');
    fs.symlinkSync(path.join('data', 'docker-compose.yml'), path.join(root, linked, 'docker-compose.yml'));
    fencedOverwriteOf(fs.realpathSync(data), ['other']);
    fs.renameSync(path.join(data, 'docker-compose.yml'), path.join(data, 'docker-compose.yml.aside'));
    // Listed before the fence; then the fence, which names no stack, holds its whole directory and its plain compose file is gone.
    const before = `before-${randomUUID().slice(0, 8)}`;
    const beforeDir = stackDir(before);
    expect((await request(app).get('/api/stacks').set('Cookie', adminCookie)).body).toContain(before);
    fencedOverwriteOf(beforeDir, []);
    fs.rmSync(path.join(beforeDir, 'compose.yaml'));
    const listed = await request(app).get('/api/stacks').set('Cookie', adminCookie);
    expect(listed.body).toEqual(expect.arrayContaining([linked, before, 'other']));
    const bulk = await request(app).post('/api/stacks/bulk').set('Cookie', adminCookie).send({ action: 'stop', stackNames: [linked, before] });
    for (const row of bulk.body.results) expect(row, row.stackName).toMatchObject({ ok: false, code: 'data_restore' });
  });

  it('lists a fenced directory without a compose file only when it was a stack: one the restore recorded, not a bind at the top of the compose root', async () => {
    const root = process.env.COMPOSE_DIR as string;
    const recorded = `recorded-${randomUUID().slice(0, 8)}`;
    const bind = `bind-${randomUUID().slice(0, 8)}`;
    fs.mkdirSync(path.join(root, recorded));
    fs.mkdirSync(path.join(root, bind));
    fencedOverwriteOf(fs.realpathSync(path.join(root, recorded)), [recorded]);
    fencedOverwriteOf(fs.realpathSync(path.join(root, bind)), []);
    const listed = await request(app).get('/api/stacks').set('Cookie', adminCookie);
    expect(listed.body).toContain(recorded);
    expect(listed.body).not.toContain(bind);
  });

  it('refuses the editor\'s confirmed overwrite of an env file whose link dangles into a directory fenced since the env files were resolved', async () => {
    const { dir, data, envFile } = chainedEnvStack();
    const { FileSystemService } = await import('../services/FileSystemService');
    const proto = FileSystemService.prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const original = proto.writeFileIfUnchanged;
    vi.spyOn(proto, 'writeFileIfUnchanged').mockImplementation(async function (this: unknown, ...args: unknown[]) {
      fencedOverwriteOf(data, ['web']);
      fs.renameSync(envFile, `${envFile}.aside`);
      return original.apply(this, args);
    });
    const res = await request(app).put(`/api/stacks/web/env?create=1&force=1&file=${encodeURIComponent(path.join(dir, 'app.env'))}`)
      .set('Cookie', adminCookie).send({ content: 'A=9\n' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('data_restore');
    expect(fs.existsSync(envFile)).toBe(false);
    expect(fs.readFileSync(`${envFile}.aside`, 'utf-8')).toBe('A=1\n');
  });

  it('keeps refusing an env create through a link that dangles outside any fence as a link, not the fence', async () => {
    const dir = stackDir('web');
    dataDir('web');
    fs.symlinkSync(path.join('data', 'real.env'), path.join(dir, '.env'));
    fencedOverwriteOf(dataDir('other'), ['other']);
    const res = await request(app).put('/api/stacks/web/env?create=1').set('Cookie', adminCookie).send({ content: 'A=1\n' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBeUndefined();
  });

  it('refuses the env routes when the compose file reaches the fenced directory through a sibling directory under the compose root', async () => {
    const { data, compose } = linkedComposeStack();
    const sibling = path.join(process.env.COMPOSE_DIR as string, 'shared');
    fs.mkdirSync(sibling);
    fs.symlinkSync(path.join('..', 'web', 'data', 'compose.yaml'), path.join(sibling, 'compose.yaml'));
    const link = path.join(path.dirname(data), 'compose.yaml');
    fs.rmSync(link);
    fs.symlinkSync(path.join('..', 'shared', 'compose.yaml'), link);
    fencedOverwriteOf(data, ['web']);
    fs.renameSync(compose, `${compose}.aside`);
    expectRefused(await composeRoutes());
    expect(fs.existsSync(path.join(path.dirname(data), '.env'))).toBe(false);
  });

  it('refuses the env routes when the linked directory the compose file is reached through is moved aside whole', async () => {
    const { dir, data } = linkedComposeStack();
    fs.rmSync(path.join(dir, 'compose.yaml'));
    fs.symlinkSync('data', path.join(dir, 'source'));
    fs.symlinkSync(path.join('source', 'compose.yaml'), path.join(dir, 'compose.yaml'));
    fencedOverwriteOf(data, ['web']);
    fs.renameSync(data, `${data}.aside`);
    expectRefused(await composeRoutes());
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
  });

  it('follows a chain of more than a few links to the fenced directory', async () => {
    const { dir, compose } = linkedComposeStack();
    fs.rmSync(path.join(dir, 'compose.yaml'));
    fs.symlinkSync(path.join('data', 'compose.yaml'), path.join(dir, 'l6.yaml'));
    for (let i = 5; i >= 1; i -= 1) fs.symlinkSync(`l${i + 1}.yaml`, path.join(dir, `l${i}.yaml`));
    fs.symlinkSync('l1.yaml', path.join(dir, 'compose.yaml'));
    fencedOverwriteOf(path.dirname(compose), ['web']);
    fs.renameSync(compose, `${compose}.aside`);
    expectRefused(await composeRoutes());
  });

  it('pushes a Secrets bundle into a missing env file as new while only another directory is fenced', async () => {
    const dir = stackDir('web');
    fencedOverwriteOf(dataDir('other'), ['other']);
    const { SecretsService } = await import('../services/SecretsService');
    const secrets = SecretsService.getInstance();
    const { id } = secrets.create({ name: `push-absent-${randomUUID().slice(0, 8)}`, kv: { A: '2' }, user: 'admin' });
    const selector = { type: 'nodes' as const, ids: [nodeId] };
    const plan = await secrets.previewPushDiff(id, selector, 'web', '.env');
    const result = await secrets.executePush(id, {
      selector, stackName: 'web', envFileBasename: '.env', expectedVersion: plan.version,
      expectedTargets: plan.targets.map(({ nodeId: target, fingerprint }) => ({ nodeId: target, fingerprint })),
      user: 'admin',
    });
    expect(result.results[0].status).not.toBe('failed');
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf-8')).toMatch(/A=2/);
  });

  it('leaves the editors of a stack clear of the fenced directory alone', async () => {
    const { data } = envStack();
    fencedOverwriteOf(data, ['web']);
    const other = stackDir('other');
    fs.writeFileSync(path.join(other, '.env'), 'B=1\n');
    const res = await request(app).put('/api/stacks/other/env').set('Cookie', adminCookie).send({ content: 'B=2\n' });
    expect(res.status).toBe(200);
    expect((await request(app).put('/api/stacks/other').set('Cookie', adminCookie).send({ content: 'services: {}\n' })).status).toBe(200);
  });

  /**
   * Run `step` once, the next time a file operation is matched against the
   * directory fences: after its own checks have passed and just before its
   * admission, the moment a restore can move a linked target aside.
   */
  async function beforeNextAdmission(step: () => void): Promise<void> {
    const fence = await import('../services/recovery/restoreFence');
    const original = fence.matchFsWorkToFences;
    let pending: (() => void) | null = step;
    vi.spyOn(fence, 'matchFsWorkToFences').mockImplementation(async (paths) => {
      const run = pending;
      pending = null;
      run?.();
      return original(paths);
    });
  }
  /** A stack whose `.env` and `app.env` reach `data/` by a link, directly or through `mid*.env` (named through an alias of the compose root for `alias`). */
  function linkedEnvStack(shape: LinkShape): { dir: string; data: string; files: Record<string, string> } {
    const { dir, data } = envStack();
    const files: Record<string, string> = {};
    for (const name of ['.env', 'app.env']) {
      const target = path.join(data, name);
      fs.writeFileSync(target, 'A=1\n');
      if (shape === 'single') {
        fs.symlinkSync(path.join('data', name), path.join(dir, name));
      } else if (shape === 'outside') {
        fs.symlinkSync(outsideLinkTo(target), path.join(dir, name));
      } else {
        fs.symlinkSync(path.join('data', name), path.join(dir, `mid${name}`));
        fs.symlinkSync(shape === 'alias' ? path.join(composeRootAlias(), 'web', `mid${name}`) : `mid${name}`, path.join(dir, name));
      }
      files[name] = target;
    }
    return { dir, data, files };
  }

  it('refuses an env write through a link whose target climbs out of a linked directory with .., once that target is moved aside', async () => {
    const fence = await import('../services/recovery/restoreFence');
    const { FileSystemService } = await import('../services/FileSystemService');
    const fsService = FileSystemService.getInstance(nodeId);
    resetStack();
    const { dir, data } = envStack();
    fs.mkdirSync(path.join(data, 'inner'));
    const target = path.join(data, 'app.env');
    // <out>/lnk -> data/inner, and app.env -> <out>/x.env -> lnk/../app.env, which is data/app.env.
    const out = path.dirname(outsideLinkTo(path.join(data, 'inner')));
    fs.renameSync(path.join(out, 'inner'), path.join(out, 'lnk'));
    fs.symlinkSync(`lnk${path.sep}..${path.sep}app.env`, path.join(out, 'x.env'));
    fs.rmSync(path.join(dir, 'app.env'), { force: true });
    fs.symlinkSync(path.join(out, 'x.env'), path.join(dir, 'app.env'));
    fencedOverwriteOf(data, ['web']);
    await beforeNextAdmission(() => fs.renameSync(target, `${target}.aside`));
    await expect(fsService.writeFile(path.join(dir, 'app.env'), 'A=2\n')).rejects.toMatchObject({ code: 'data_restore' });
    vi.mocked(fence.matchFsWorkToFences).mockRestore();
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(`${target}.aside`, 'utf-8')).toBe('A=1\n');
    expect(fence.fsWorkInFlightCountForTests()).toBe(0);
  });

  it('refuses a declared env file behind a link chain too long to place promptly, while a fence is held', async () => {
    const { dir } = envStack();
    fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  app:\n    image: nginx\n    env_file: grow.env\n');
    // grow.env -> grow.env/grow.env/.../x: every hop makes the path longer.
    fs.symlinkSync(Array.from({ length: 200 }, () => 'grow.env').join(path.sep), path.join(dir, 'grow.env'));
    fencedOverwriteOf(dataDir('other'), ['other']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const started = Date.now();
    const res = await request(app).get('/api/stacks/web/envs').set('Cookie', adminCookie);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('data_restore');
    expect(warn.mock.calls.length).toBeLessThan(100);
  });

  it('refuses every env and Compose write whose link target is moved aside just before admission, and changes nothing', async () => {
    const fence = await import('../services/recovery/restoreFence');
    const { FileSystemService } = await import('../services/FileSystemService');
    const fsService = FileSystemService.getInstance(nodeId);
    for (const shape of LINK_SHAPES) {
      // Env writes: direct (the forced editor save and the Secrets write),
      // plain, conditional, the project .env save, and the exclusive create.
      resetStack();
      const env = linkedEnvStack(shape);
      fencedOverwriteOf(env.data, ['web']);
      const app = path.join(env.dir, 'app.env');
      const mtime = fs.statSync(env.files['app.env']).mtimeMs;
      const envWrites: Record<string, [string, () => Promise<unknown>]> = {
        direct: [env.files['app.env'], () => fsService.writeFile(app, 'A=2\n')],
        plain: [env.files['app.env'], () => fsService.writeFileIfUnchanged('web', app, 'A=2\n', null)],
        conditional: [env.files['app.env'], () => fsService.writeFileIfUnchanged('web', app, 'A=2\n', mtime)],
        project: [env.files['.env'], () => fsService.saveEnvContent('web', 'A=2\n')],
        exclusive: [env.files['app.env'], () => fsService.createFileExclusive(app, 'A=2\n')],
        read: [env.files['app.env'], () => fsService.readFile(app)],
      };
      for (const [name, [target, write]] of Object.entries(envWrites)) {
        const label = `${shape} env ${name}`;
        await beforeNextAdmission(() => fs.renameSync(target, `${target}.aside`));
        await expect(write(), label).rejects.toMatchObject({ code: 'data_restore' });
        vi.mocked(fence.matchFsWorkToFences).mockRestore();
        expect(fs.existsSync(target), label).toBe(false);
        expect(fs.readFileSync(`${target}.aside`, 'utf-8'), label).toBe('A=1\n');
        expect(fs.lstatSync(path.join(env.dir, path.basename(target))).isSymbolicLink(), label).toBe(true);
        expect(fence.fsWorkInFlightCountForTests(), label).toBe(0);
        fs.renameSync(`${target}.aside`, target);
      }

      // Compose writes: the automated save, and the editor's plain, If-Match,
      // filename-pinned and pinned-with-If-Match saves.
      resetStack();
      const { dir, data, compose } = composeStackOf(shape);
      const before = fs.readFileSync(compose, 'utf-8');
      fencedOverwriteOf(data, ['web']);
      const composeMtime = fs.statSync(compose).mtimeMs;
      const composeWrites: Record<string, () => Promise<unknown>> = {
        automated: () => fsService.saveStackContent('web', 'services: {}\n'),
        plain: () => fsService.saveStackContentIfUnchanged('web', 'services: {}\n', null),
        ifMatch: () => fsService.saveStackContentIfUnchanged('web', 'services: {}\n', composeMtime),
        pinned: () => fsService.saveStackContentIfUnchanged('web', 'services: {}\n', null, 'compose.yaml'),
        pinnedIfMatch: () => fsService.saveStackContentIfUnchanged('web', 'services: {}\n', composeMtime, 'compose.yaml'),
        read: () => fsService.getStackContent('web'),
        readWithMtime: () => fsService.getStackContentWithMtime('web'),
      };
      for (const [name, write] of Object.entries(composeWrites)) {
        const label = `${shape} compose ${name}`;
        await beforeNextAdmission(() => fs.renameSync(compose, `${compose}.aside`));
        await expect(write(), label).rejects.toMatchObject({ code: 'data_restore' });
        vi.mocked(fence.matchFsWorkToFences).mockRestore();
        expect(fs.existsSync(compose), label).toBe(false);
        expect(fs.readFileSync(`${compose}.aside`, 'utf-8'), label).toBe(before);
        expect(fs.lstatSync(path.join(dir, 'compose.yaml')).isSymbolicLink(), label).toBe(true);
        expect(fence.fsWorkInFlightCountForTests(), label).toBe(0);
        fs.renameSync(`${compose}.aside`, compose);
      }
    }
  });

  it('still writes through links into a directory no fence holds while another directory is fenced', async () => {
    const fence = await import('../services/recovery/restoreFence');
    const { FileSystemService } = await import('../services/FileSystemService');
    const fsService = FileSystemService.getInstance(nodeId);
    for (const shape of LINK_SHAPES) {
      resetStack();
      const env = linkedEnvStack(shape);
      fencedOverwriteOf(dataDir('other'), ['other']);
      const app = path.join(env.dir, 'app.env');
      await fsService.writeFile(app, 'A=2\n');
      expect(await fsService.writeFileIfUnchanged('web', app, 'A=3\n', null), shape).toMatchObject({ ok: true });
      await fsService.saveEnvContent('web', 'B=1\n');
      expect(fs.readFileSync(env.files['app.env'], 'utf-8'), shape).toBe('A=3\n');
      expect(fs.readFileSync(env.files['.env'], 'utf-8'), shape).toBe('B=1\n');
      for (const name of ['.env', 'app.env']) {
        expect(fs.lstatSync(path.join(env.dir, name)).isSymbolicLink(), `${shape} ${name}`).toBe(true);
      }
      expect(fence.fsWorkInFlightCountForTests(), shape).toBe(0);
      resetStack();
      const { dir, compose } = composeStackOf(shape);
      fencedOverwriteOf(dataDir('other'), ['other']);
      expect(await fsService.getStackContent('web'), shape).toContain('image: nginx');
      expect(await fsService.saveStackContentIfUnchanged('web', 'services: {}\n', null, 'compose.yaml'), shape).toMatchObject({ ok: true });
      await fsService.saveStackContent('web', 'services:\n  b: {}\n');
      expect(fs.readFileSync(compose, 'utf-8'), shape).toBe('services:\n  b: {}\n');
      expect(fs.lstatSync(path.join(dir, 'compose.yaml')).isSymbolicLink(), shape).toBe(true);
      expect(fence.fsWorkInFlightCountForTests(), shape).toBe(0);
    }
  });

  it('makes a fence wait for a write through a link admitted before it, even once the link\'s target is moved aside', async () => {
    const fence = await import('../services/recovery/restoreFence');
    const { FileSystemService } = await import('../services/FileSystemService');
    for (const shape of LINK_SHAPES) {
      resetStack();
      const env = linkedEnvStack(shape);
      const app = path.join(env.dir, 'app.env');
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => { entered = resolve; });
      let finish!: () => void;
      const held = new Promise<void>((resolve) => { finish = resolve; });
      const spy = holdWriteOpenOf(app, entered, held);
      // Admitted with nothing fenced, so registered by its spellings alone.
      const writing = FileSystemService.getInstance(nodeId).writeFile(app, 'A=2\n');
      await inside;
      // The link now dangles: by its own path it is unrelated to the directory.
      fs.renameSync(env.files['app.env'], `${env.files['app.env']}.aside`);
      fencedOverwriteOf(env.data, ['web']);
      const target = { senchoPath: env.data, hostPath: env.data, aliases: [] };
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(await fence.waitForFsWorkOn(target, 50), shape).toBe(false);
      const drained = fence.waitForFsWorkOn(target, 5_000);
      finish();
      await writing;
      expect(await drained, shape).toBe(true);
      expect(fence.fsWorkInFlightCountForTests(), shape).toBe(0);
      spy.mockRestore();
    }
  });

  it('fails a compose read promptly when a FIFO replaces the file after it was resolved, and leaves no work registered', async () => {
    const fence = await import('../services/recovery/restoreFence');
    const { FileSystemService } = await import('../services/FileSystemService');
    const fsService = FileSystemService.getInstance(nodeId);
    for (const [name, read] of [
      ['content', () => fsService.getStackContent('web')],
      ['withMtime', () => fsService.getStackContentWithMtime('web')],
    ] as const) {
      resetStack();
      // Another directory is fenced, so the read is admitted and registered.
      fencedOverwriteOf(dataDir('other'), ['other']);
      const compose = path.join(stackDir('web'), 'compose.yaml');
      await beforeNextAdmission(() => {
        fs.rmSync(compose);
        execFileSync('mkfifo', [compose]);
      });
      const timedOut = Symbol('timed out');
      try {
        const outcome = await Promise.race([
          read().then(() => 'read', (err: unknown) => err),
          new Promise((resolve) => setTimeout(() => resolve(timedOut), 3_000)),
        ]);
        expect(outcome, name).not.toBe(timedOut);
        expect(outcome, name).toBeInstanceOf(Error);
        expect(fence.fsWorkInFlightCountForTests(), name).toBe(0);
      } finally {
        vi.mocked(fence.matchFsWorkToFences).mockRestore();
        // Release a blocking open, should one be waiting for a writer.
        try { fs.closeSync(fs.openSync(compose, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)); } catch { /* no reader */ }
      }
    }
  });

  it('fails a conditional save and the conflict read promptly when a FIFO replaces the compose file after it was resolved, and a plain save replaces it', async () => {
    const fence = await import('../services/recovery/restoreFence');
    const { FileSystemService } = await import('../services/FileSystemService');
    const fsService = FileSystemService.getInstance(nodeId);
    for (const [name, save, fails] of [
      // An expected mtime makes the save open and stat the file it replaces.
      ['conditional', () => fsService.saveStackContentIfUnchanged('web', 'services: {}\n', 1, null), true],
      // A different expected filename answers with the current file's content.
      ['conflict', () => fsService.saveStackContentIfUnchanged('web', 'services: {}\n', null, 'docker-compose.yml'), true],
      // A plain save never opens the file it replaces: it renames over it.
      ['plain', () => fsService.saveStackContentIfUnchanged('web', 'services: {}\n', null, null), false],
    ] as const) {
      resetStack();
      // Another directory is fenced, so the work is admitted and registered.
      fencedOverwriteOf(dataDir('other'), ['other']);
      const compose = path.join(stackDir('web'), 'compose.yaml');
      await beforeNextAdmission(() => {
        fs.rmSync(compose);
        execFileSync('mkfifo', [compose]);
      });
      const timedOut = Symbol('timed out');
      try {
        const outcome = await Promise.race([
          save().then(() => 'saved', (err: unknown) => err),
          new Promise((resolve) => setTimeout(() => resolve(timedOut), 3_000)),
        ]);
        expect(outcome, name).not.toBe(timedOut);
        if (fails) {
          expect(outcome, name).toMatchObject({ code: 'NOT_A_FILE' });
        } else {
          expect(outcome, name).toBe('saved');
          expect(fs.readFileSync(compose, 'utf-8'), name).toBe('services: {}\n');
        }
        expect(fence.fsWorkInFlightCountForTests(), name).toBe(0);
      } finally {
        vi.mocked(fence.matchFsWorkToFences).mockRestore();
        // Release a blocking open, should one be waiting for a writer.
        try { fs.closeSync(fs.openSync(compose, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)); } catch { /* no reader */ }
      }
    }
  });

  it('fails every env read and write promptly when a FIFO replaces the env file after it was resolved, and leaves no work registered', async () => {
    const fence = await import('../services/recovery/restoreFence');
    const { FileSystemService } = await import('../services/FileSystemService');
    const fsService = FileSystemService.getInstance(nodeId);
    const sinks: Array<[string, (dir: string) => Promise<unknown>]> = [
      ['conditional', (dir) => fsService.writeFileIfUnchanged('web', path.join(dir, '.env'), 'B=2\n', 1)],
      ['unconditional', (dir) => fsService.writeFileIfUnchanged('web', path.join(dir, '.env'), 'B=2\n', null)],
      ['write', (dir) => fsService.writeFile(path.join(dir, '.env'), 'B=2\n')],
      ['read', (dir) => fsService.readFile(path.join(dir, '.env'))],
      ['project', () => fsService.saveEnvContent('web', 'B=2\n')],
      // A FIFO at the target makes the exclusive create read it as the conflict.
      ['create', (dir) => fsService.createFileExclusive(path.join(dir, '.env'), 'B=2\n')],
    ];
    for (const [name, sink] of sinks) {
      resetStack();
      // Another directory is fenced, so the work is admitted and registered.
      fencedOverwriteOf(dataDir('other'), ['other']);
      const dir = stackDir('web');
      const env = path.join(dir, '.env');
      fs.writeFileSync(env, 'B=1\n');
      await beforeNextAdmission(() => {
        fs.rmSync(env);
        execFileSync('mkfifo', [env]);
      });
      const timedOut = Symbol('timed out');
      try {
        const outcome = await Promise.race([
          sink(dir).then(() => 'done', (err: unknown) => err),
          new Promise((resolve) => setTimeout(() => resolve(timedOut), 3_000)),
        ]);
        expect(outcome, name).not.toBe(timedOut);
        expect(outcome, name).toBeInstanceOf(Error);
        if (name !== 'project') expect(outcome, name).toMatchObject({ code: 'NOT_A_FILE' });
        expect(fs.lstatSync(env).isFIFO(), name).toBe(true);
        expect(fence.fsWorkInFlightCountForTests(), name).toBe(0);
      } finally {
        vi.mocked(fence.matchFsWorkToFences).mockRestore();
        // Release a blocking open, should one be waiting for the other end.
        for (const flags of [fs.constants.O_WRONLY, fs.constants.O_RDONLY]) {
          try { fs.closeSync(fs.openSync(env, flags | fs.constants.O_NONBLOCK)); } catch { /* no other end */ }
        }
      }
    }
    // The env editor answers a FIFO that took the file's place as a conflict, not a server fault.
    resetStack();
    fencedOverwriteOf(dataDir('other'), ['other']);
    const env = path.join(stackDir('web'), '.env');
    fs.writeFileSync(env, 'B=1\n');
    const opened = await request(app).get('/api/stacks/web/env').set('Cookie', adminCookie);
    expect(opened.status).toBe(200);
    await beforeNextAdmission(() => {
      fs.rmSync(env);
      execFileSync('mkfifo', [env]);
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const saved = await request(app).put('/api/stacks/web/env').set('Cookie', adminCookie)
      .set('If-Match', opened.headers.etag as string).send({ content: 'B=2\n' });
    vi.mocked(fence.matchFsWorkToFences).mockRestore();
    expect(saved.status).toBe(409);
    expect(saved.body.error).toContain('not a regular file');
    // A Secrets import refuses it as a source, not as a server fault.
    resetStack();
    fencedOverwriteOf(dataDir('other'), ['other']);
    stackDir('web');
    fs.writeFileSync(env, 'B=1\n');
    await beforeNextAdmission(() => {
      fs.rmSync(env);
      execFileSync('mkfifo', [env]);
    });
    const { SecretsService, SecretSourceRefusedError } = await import('../services/SecretsService');
    const imported = SecretsService.getInstance().readImportOverlay(nodeId, 'web', '.env');
    await expect(imported).rejects.toBeInstanceOf(SecretSourceRefusedError);
    await expect(imported).rejects.toThrow('not a regular file');
    vi.mocked(fence.matchFsWorkToFences).mockRestore();
    // A directory in the env file's place keeps the editor's answer for a directory.
    resetStack();
    fs.mkdirSync(path.join(stackDir('web'), '.env'));
    const dirCreate = await request(app).put('/api/stacks/web/env?create=1').set('Cookie', adminCookie).send({ content: 'B=2\n' });
    expect(dirCreate.status).toBe(409);
    expect(dirCreate.body.error).toContain('is a directory');
  });

  it('writes an env file whose link climbs out of a linked directory with .. to where the kernel puts it, not into a fenced directory its text collapses to', async () => {
    const fence = await import('../services/recovery/restoreFence');
    const { FileSystemService } = await import('../services/FileSystemService');
    const fsService = FileSystemService.getInstance(nodeId);
    resetStack();
    const { dir, data } = envStack();
    // web/jump -> other/deep/j, so jump/../data/note.env is other/deep/data/note.env;
    // its text alone collapses to web/data/note.env, inside the fenced directory.
    const deep = path.join(stackDir('other'), 'deep');
    fs.mkdirSync(path.join(deep, 'j'), { recursive: true });
    fs.mkdirSync(path.join(deep, 'data'));
    fs.writeFileSync(path.join(deep, 'data', 'note.env'), 'N=0\n');
    fs.symlinkSync(path.join(deep, 'j'), path.join(dir, 'jump'));
    fs.symlinkSync(['jump', '..', 'data', 'note.env'].join(path.sep), path.join(dir, 'note.env'));
    fencedOverwriteOf(data, ['web']);
    await fsService.writeFile(path.join(dir, 'note.env'), 'N=1\n');
    expect(fs.readFileSync(path.join(deep, 'data', 'note.env'), 'utf-8')).toBe('N=1\n');
    expect(fs.existsSync(path.join(data, 'note.env'))).toBe(false);
    expect(fence.fsWorkInFlightCountForTests()).toBe(0);
  });

  it('answers a compose read that fails after its admission with the fence recorded meanwhile, not as a failed read', async () => {
    const { FileSystemService } = await import('../services/FileSystemService');
    const fsService = FileSystemService.getInstance(nodeId);
    for (const [name, method, read] of [
      ['content', 'open', () => fsService.getStackContent('web')],
      ['withMtime', 'open', () => fsService.getStackContentWithMtime('web')],
    ] as const) {
      resetStack();
      const { data } = linkedComposeStack();
      const original = (fs.promises[method] as (...a: unknown[]) => Promise<unknown>).bind(fs.promises);
      const spy = vi.spyOn(fs.promises, method).mockImplementation((async (...args: unknown[]) => {
        if (String(args[0]).endsWith(`${path.sep}compose.yaml`)) {
          // The fence lands while the admitted read runs, and the read fails.
          fencedOverwriteOf(data, ['web']);
          throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        }
        return original(...args);
      }) as never);
      await expect(read(), name).rejects.toMatchObject({ code: 'data_restore' });
      spy.mockRestore();
    }
  });

  it('answers an image pull, a stack update and a Compose Doctor run with the fence when the compose file links into the fenced directory', async () => {
    // The update policy renders Compose, which this suite cannot; allow it so
    // the routes reach the compose read the fence answers.
    const updatePolicy = await import('../services/updatePolicy');
    const { resolveSenchoLabels } = await import('../helpers/senchoLabels');
    vi.spyOn(updatePolicy, 'resolveUpdatePolicy').mockImplementation(async (_nodeId, request) =>
      updatePolicy.evaluateUpdatePolicy(resolveSenchoLabels({ services: { app: { image: 'nginx:1' } } }), request));
    // This suite stands in for ComposeService and the update orchestrator, so
    // each is given the real compose read its own pull or update starts with.
    const { loadStackBuildServices } = await import('../services/ImageUpdateService');
    const { ComposeService } = await import('../services/ComposeService');
    const rendering = ComposeService.getInstance();
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      ...rendering,
      evaluateDockerEndpoint: async () => null,
      pullStackImages: async (stack: string) => ({ skippedBuildBacked: await loadStackBuildServices(nodeId, stack) }),
    } as unknown as ReturnType<typeof ComposeService.getInstance>);
    const { StackUpdateOrchestrator } = await import('../services/StackUpdateOrchestrator');
    vi.spyOn(StackUpdateOrchestrator.getInstance(), 'execute').mockImplementation(async (request) => {
      await loadStackBuildServices(nodeId, request.stackName);
      throw new Error('reached past the compose read');
    });
    for (const shape of LINK_SHAPES) {
      resetStack();
      const { data, compose } = composeStackOf(shape);
      const before = fs.readFileSync(compose, 'utf-8');
      // No recorded dependent stack, so the lifecycle routes take the stack lock
      // and reach the compose read; the fence on the directory alone answers.
      fencedOverwriteOf(data);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      for (const [name, pending] of Object.entries({
        pull: request(app).post('/api/stacks/web/pull-images').set('Cookie', adminCookie),
        update: request(app).post('/api/stacks/web/update').set('Cookie', adminCookie),
        doctor: request(app).post('/api/stacks/web/preflight/run').set('Cookie', adminCookie),
      })) {
        const res = await pending;
        expect(res.status, `${shape} ${name}`).toBe(409);
        expect(res.body.code, `${shape} ${name}`).toBe('data_restore');
      }
      expect(fs.readFileSync(compose, 'utf-8'), shape).toBe(before);
    }
  });

  it('answers the drift view and its re-check with the fence, and reconciles nothing, when the compose file links into the fenced directory', async () => {
    const drift = await import('../services/DriftDetectionService');
    vi.spyOn(drift, 'buildStackDriftReport').mockResolvedValue({ stackName: 'web', findings: [] } as never);
    const { DriftLedgerService } = await import('../services/DriftLedgerService');
    const reconcile = vi.spyOn(DriftLedgerService.getInstance(), 'reconcile');
    for (const shape of LINK_SHAPES) {
      resetStack();
      const { data } = composeStackOf(shape);
      fencedOverwriteOf(data, ['web']);
      for (const [name, pending] of Object.entries({
        view: request(app).get('/api/stacks/web/drift').set('Cookie', adminCookie),
        recheck: request(app).post('/api/stacks/web/drift/recheck').set('Cookie', adminCookie),
      })) {
        const res = await pending;
        expect(res.status, `${shape} ${name}`).toBe(409);
        expect(res.body.code, `${shape} ${name}`).toBe('data_restore');
      }
    }
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('refuses a manual update, a bulk update row and an automatic update of a compose file in the fenced directory before the gate runs or a checked observation is spent', async () => {
    const updatePolicy = await import('../services/updatePolicy');
    const { resolveSenchoLabels } = await import('../helpers/senchoLabels');
    vi.spyOn(updatePolicy, 'resolveUpdatePolicy').mockImplementation(async (_nodeId, request) =>
      updatePolicy.evaluateUpdatePolicy(resolveSenchoLabels({ services: { app: { image: 'nginx:1' } } }), request));
    const { ComposeService } = await import('../services/ComposeService');
    const rendering = ComposeService.getInstance();
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      ...rendering, evaluateDockerEndpoint: async () => null,
    } as unknown as ReturnType<typeof ComposeService.getInstance>);
    const enforcement = await import('../services/PolicyEnforcement');
    const gate = vi.spyOn(enforcement, 'enforcePolicyPreDeploy');
    const { StackUpdateOrchestrator } = await import('../services/StackUpdateOrchestrator');
    const execute = vi.spyOn(StackUpdateOrchestrator.getInstance(), 'execute');
    const { applyAutomaticStackUpdate } = await import('../services/automaticStackUpdate');
    for (const shape of LINK_SHAPES) {
      resetStack();
      const { data } = composeStackOf(shape);
      fencedOverwriteOf(data);
      const res = await request(app).post('/api/stacks/web/update').set('Cookie', adminCookie);
      expect(res.status, shape).toBe(409);
      expect(res.body.code, shape).toBe('data_restore');
      const bulk = await request(app).post('/api/stacks/bulk').set('Cookie', adminCookie).send({ action: 'update', stackNames: ['web'] });
      expect(bulk.status, `${shape} bulk`).toBe(200);
      expect(bulk.body.results[0], `${shape} bulk`).toMatchObject({ stackName: 'web', ok: false, code: 'data_restore' });
      const verify = vi.fn();
      const consume = vi.fn();
      await expect(applyAutomaticStackUpdate({
        nodeId, stackName: 'web', updatedImages: ['nginx:1'], policyOptions: { bypass: false, actor: 'auto-update:test' },
        verificationOwner: 'hub_authority', observation: { verify, consume },
      }), shape).rejects.toMatchObject({ code: 'data_restore' });
      expect(verify, shape).not.toHaveBeenCalled();
      expect(consume, shape).not.toHaveBeenCalled();
    }
    expect(gate).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a single-service update and a local webhook pull of a compose file in the fenced directory before the gate, the capture or Compose', async () => {
    const updatePolicy = await import('../services/updatePolicy');
    const { resolveSenchoLabels } = await import('../helpers/senchoLabels');
    vi.spyOn(updatePolicy, 'resolveUpdatePolicy').mockImplementation(async (_nodeId, request) =>
      updatePolicy.evaluateUpdatePolicy(resolveSenchoLabels({ services: { app: { image: 'nginx:1' } } }), request));
    const { ComposeService } = await import('../services/ComposeService');
    const rendering = ComposeService.getInstance();
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      ...rendering, evaluateDockerEndpoint: async () => null,
    } as unknown as ReturnType<typeof ComposeService.getInstance>);
    // The webhook pull gates through assertPolicyGateAllows before execute; the
    // service update gates inside execute, along with the rollback capture and
    // Docker Compose, so execute never running covers all three there.
    const enforcement = await import('../services/PolicyEnforcement');
    const gate = vi.spyOn(enforcement, 'enforcePolicyPreDeploy');
    const policyGate = await import('../helpers/policyGate');
    const webhookGate = vi.spyOn(policyGate, 'assertPolicyGateAllows');
    const { StackUpdateOrchestrator } = await import('../services/StackUpdateOrchestrator');
    const execute = vi.spyOn(StackUpdateOrchestrator.getInstance(), 'execute');
    const { WebhookService } = await import('../services/WebhookService');
    const db = DatabaseService.getInstance();
    for (const shape of LINK_SHAPES) {
      resetStack();
      const { data } = composeStackOf(shape);
      fencedOverwriteOf(data);
      const res = await request(app).post('/api/stacks/web/services/app/update').set('Cookie', adminCookie);
      expect(res.status, shape).toBe(409);
      expect(res.body, shape).toMatchObject({ code: 'data_restore', serviceName: 'app' });
      const webhookId = db.addWebhook({
        node_id: nodeId, name: `fenced-pull-${shape}`, stack_name: 'web', action: 'pull',
        secret: WebhookService.getInstance().generateSecret(), enabled: true,
      });
      const outcome = await WebhookService.getInstance().execute(db.getWebhook(webhookId)!, 'pull', 'test');
      expect(outcome, shape).toMatchObject({ success: false });
      expect(outcome.error, shape).toContain('which a data restore is overwriting');
      const runs = db.getWebhookExecutions(webhookId);
      expect(runs, shape).toHaveLength(1);
      expect(runs[0], shape).toMatchObject({ status: 'failure' });
      expect(runs[0].error, shape).toContain('which a data restore is overwriting');
    }
    expect(gate).not.toHaveBeenCalled();
    expect(webhookGate).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a service restore of a compose file in the fenced directory before the render, the gate, the claim or the recreate', async () => {
    const { ComposeService } = await import('../services/ComposeService');
    const rendering = ComposeService.getInstance();
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      ...rendering, evaluateDockerEndpoint: async () => null,
    } as unknown as ReturnType<typeof ComposeService.getInstance>);
    // The service path's own gate, inside restore.
    const enforcement = await import('../services/PolicyEnforcement');
    const gate = vi.spyOn(enforcement, 'enforcePolicyForImageRefs');
    const { StackUpdateOrchestrator } = await import('../services/StackUpdateOrchestrator');
    const orchestrator = StackUpdateOrchestrator.getInstance();
    const loadSpec = vi.spyOn(orchestrator as unknown as { loadServiceSpec: () => Promise<unknown> }, 'loadServiceSpec');
    const { ServiceUpdateRecoveryService } = await import('../services/ServiceUpdateRecoveryService');
    const recoveries = ServiceUpdateRecoveryService.getInstance();
    // A readable link, and one moved aside mid-swap.
    for (const [shape, dangling] of LINK_SHAPES.flatMap((s) => [[s, false], [s, true]] as const)) {
      resetStack();
      const { data, compose } = composeStackOf(shape);
      const recoveryId = randomUUID();
      const now = Date.now();
      DatabaseService.getInstance().insertServiceUpdateRecovery({
        id: recoveryId, node_id: nodeId, stack_name: 'web', service_name: 'app',
        replicas_json: JSON.stringify([{ imageId: 'sha256:aaaa', repoDigest: null }]),
        majority_image_id: 'sha256:aaaa', declared_image_ref: 'nginx:1', weak_floating_tag: 0,
        health_gate_id: null, status: 'active', expires_at: now + 3_600_000, claim_expires_at: null,
        created_at: now, created_by: 'test',
      });
      fencedOverwriteOf(data);
      if (dangling) fs.renameSync(compose, `${compose}.aside`);
      const restoreCall = vi.spyOn(orchestrator, 'restore');
      const res = await request(app).post('/api/stacks/web/services/app/restore').set('Cookie', adminCookie).send({ recoveryId });
      expect(res.status, shape).toBe(409);
      // A dangling link is already refused when the route asks whether the stack exists.
      expect(res.body, shape).toMatchObject(dangling ? { code: 'data_restore' } : { code: 'data_restore', serviceName: 'app' });
      expect(restoreCall, shape).not.toHaveBeenCalled();
      restoreCall.mockRestore();
      // A caller that reaches restore directly is refused by restore itself.
      await expect(orchestrator.restore(
        { nodeId, stackName: 'web', target: { scope: 'service', serviceName: 'app' }, trigger: 'manual', actor: 'test' },
        { policyOptions: { bypass: false, actor: 'test' }, terminalWs: null, recoveryId },
      ), shape).rejects.toMatchObject({ code: 'data_restore' });
      // Nothing claimed: the snapshot can still be restored once the fence is gone.
      expect(recoveries.get(recoveryId)?.status, shape).toBe('active');
    }
    expect(loadSpec).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
  });

  it('answers an update whose compose file cannot be rendered with the fence, not the update policy, on every entry point, while the fence holds the file', async () => {
    const updatePolicy = await import('../services/updatePolicy');
    // Docker Compose could not render the file: a block for a manual trigger, a skip otherwise.
    vi.spyOn(updatePolicy, 'resolveUpdatePolicy').mockImplementation(async (_nodeId, request) =>
      updatePolicy.evaluateUpdatePolicy({ renderable: false }, request));
    const recorded = vi.spyOn(updatePolicy, 'recordUpdatePolicyDecision');
    const { ComposeService } = await import('../services/ComposeService');
    const rendering = ComposeService.getInstance();
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      ...rendering, evaluateDockerEndpoint: async () => null,
    } as unknown as ReturnType<typeof ComposeService.getInstance>);
    const enforcement = await import('../services/PolicyEnforcement');
    const gate = vi.spyOn(enforcement, 'enforcePolicyPreDeploy');
    const imageGate = vi.spyOn(enforcement, 'enforcePolicyForImageRefs');
    const policyGate = await import('../helpers/policyGate');
    const webhookGate = vi.spyOn(policyGate, 'assertPolicyGateAllows');
    const { StackUpdateOrchestrator } = await import('../services/StackUpdateOrchestrator');
    const execute = vi.spyOn(StackUpdateOrchestrator.getInstance(), 'execute');
    const { WebhookService } = await import('../services/WebhookService');
    const { applyAutomaticStackUpdate } = await import('../services/automaticStackUpdate');
    const db = DatabaseService.getInstance();
    // A readable link the render still failed on, and a link moved aside mid-swap.
    for (const dangling of [false, true]) {
      for (const shape of LINK_SHAPES) {
        const label = `${shape}${dangling ? ' dangling' : ''}`;
        resetStack();
        const { data, compose } = composeStackOf(shape);
        fencedOverwriteOf(data);
        if (dangling) fs.renameSync(compose, `${compose}.aside`);
        const service = await request(app).post('/api/stacks/web/services/app/update').set('Cookie', adminCookie);
        expect(service.status, label).toBe(409);
        expect(service.body, label).toMatchObject({ code: 'data_restore' });
        for (const [name, pending] of Object.entries({
          update: request(app).post('/api/stacks/web/update').set('Cookie', adminCookie),
          pull: request(app).post('/api/stacks/web/pull-images').set('Cookie', adminCookie),
        })) {
          const res = await pending;
          expect(res.status, `${label} ${name}`).toBe(409);
          expect(res.body.code, `${label} ${name}`).toBe('data_restore');
        }
        const bulk = await request(app).post('/api/stacks/bulk').set('Cookie', adminCookie).send({ action: 'update', stackNames: ['web'] });
        expect(bulk.body.results[0], `${label} bulk`).toMatchObject({ stackName: 'web', ok: false, code: 'data_restore' });
        const verify = vi.fn();
        await expect(applyAutomaticStackUpdate({
          nodeId, stackName: 'web', updatedImages: ['nginx:1'], policyOptions: { bypass: false, actor: 'auto-update:test' },
          verificationOwner: 'hub_authority', observation: { verify, consume: vi.fn() },
        }), label).rejects.toMatchObject({ code: 'data_restore' });
        expect(verify, label).not.toHaveBeenCalled();
        const webhookId = db.addWebhook({
          node_id: nodeId, name: `unrendered-pull-${label}`, stack_name: 'web', action: 'pull',
          secret: WebhookService.getInstance().generateSecret(), enabled: true,
        });
        const outcome = await WebhookService.getInstance().execute(db.getWebhook(webhookId)!, 'pull', 'test');
        expect(outcome, label).toMatchObject({ success: false });
        const runs = db.getWebhookExecutions(webhookId);
        expect(runs, label).toHaveLength(1);
        expect(runs[0], label).toMatchObject({ status: 'failure' });
        expect(runs[0].error, label).toContain('which a data restore is overwriting');
      }
    }
    expect(recorded).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
    expect(imageGate).not.toHaveBeenCalled();
    expect(webhookGate).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('answers a Docker endpoint refusal of a compose file it could not render with the fence when a data restore holds the file, and as the refusal otherwise', async () => {
    const updatePolicy = await import('../services/updatePolicy');
    const { resolveSenchoLabels } = await import('../helpers/senchoLabels');
    vi.spyOn(updatePolicy, 'resolveUpdatePolicy').mockImplementation(async (_nodeId, request) =>
      updatePolicy.evaluateUpdatePolicy(resolveSenchoLabels({ services: { app: { image: 'nginx:1' }, db: { image: 'postgres:16' } } }), request));
    const unrendered = { reason: 'unresolved' as const, service: null, message: 'could not render', renderFailed: true as const };
    const { ComposeService } = await import('../services/ComposeService');
    const rendering = ComposeService.getInstance();
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      ...rendering,
      evaluateDockerEndpoint: async () => unrendered,
      // Two services, so a service update reaches its endpoint check.
      renderConfig: async () => ({
        rendered: JSON.stringify({ name: 'web', services: { app: { image: 'nginx:1' }, db: { image: 'postgres:16' } }, networks: {}, volumes: {} }),
        stderr: '', code: 0, timedOut: false,
      }),
    } as unknown as ReturnType<typeof ComposeService.getInstance>);
    const enforcement = await import('../services/PolicyEnforcement');
    const gate = vi.spyOn(enforcement, 'enforcePolicyPreDeploy');
    const imageGate = vi.spyOn(enforcement, 'enforcePolicyForImageRefs');
    const { StackUpdateOrchestrator } = await import('../services/StackUpdateOrchestrator');
    const orchestrator = StackUpdateOrchestrator.getInstance();
    const { applyAutomaticStackUpdate } = await import('../services/automaticStackUpdate');
    for (const fenced of [true, false]) {
      for (const [shape, dangling] of LINK_SHAPES.flatMap((s) => [[s, false], [s, true]] as const)) {
        // The unfenced control needs a file that can be read: a dangling link is refused as missing.
        if (!fenced && dangling) continue;
        const label = `${fenced ? 'fenced' : 'clear'} ${shape}${dangling ? ' dangling' : ''}`;
        resetStack();
        const { data, compose } = composeStackOf(shape);
        if (fenced) fencedOverwriteOf(data);
        else fencedOverwriteOf(dataDir('other'), ['other']);
        if (dangling) fs.renameSync(compose, `${compose}.aside`);
        const expected = fenced ? 'data_restore' : 'docker_endpoint_protected';
        for (const [name, pending] of Object.entries({
          update: request(app).post('/api/stacks/web/update').set('Cookie', adminCookie),
          service: request(app).post('/api/stacks/web/services/app/update').set('Cookie', adminCookie),
          restore: request(app).post('/api/stacks/web/services/app/restore').set('Cookie', adminCookie).send({ recoveryId: 'rec-1' }),
        })) {
          const res = await pending;
          expect(res.status, `${label} ${name}`).toBe(409);
          expect(res.body.code, `${label} ${name}`).toBe(expected);
        }
        const bulk = await request(app).post('/api/stacks/bulk').set('Cookie', adminCookie).send({ action: 'update', stackNames: ['web'] });
        expect(bulk.body.results[0], `${label} bulk`).toMatchObject({ stackName: 'web', ok: false, code: expected });
        // A rollback a hub runs through this node is refused before anything moved, and says so.
        const rollback = await request(app).post('/api/stacks/web/rollback').set('Cookie', adminCookie);
        expect(rollback.status, `${label} rollback`).toBe(409);
        expect(rollback.body, `${label} rollback`).toMatchObject(fenced
          ? { code: 'data_restore', failureClass: 'pre_mutation' }
          : { code: 'docker_endpoint_protected' });
        if (dangling) continue;
        // The checks inside the operations, reached by a caller past the route's.
        const verify = vi.fn();
        const automatic = applyAutomaticStackUpdate({
          nodeId, stackName: 'web', updatedImages: ['nginx:1'], policyOptions: { bypass: false, actor: 'auto-update:test' },
          verificationOwner: 'hub_authority', observation: { verify: async () => { verify(); }, consume: vi.fn() },
        });
        if (fenced) await expect(automatic, label).rejects.toMatchObject({ code: 'data_restore' });
        else await expect(automatic, label).resolves.toMatchObject({ result: 'rejected', endpointRefusal: 'could not render' });
        const policy = await updatePolicy.resolveUpdatePolicy(nodeId, { stack: 'web', target: { scope: 'service', serviceName: 'app' }, trigger: 'manual' });
        const serviceUpdate = orchestrator.execute(
          { nodeId, stackName: 'web', target: { scope: 'service', serviceName: 'app' }, trigger: 'manual', actor: 'test', policy },
          { policyOptions: { bypass: false, actor: 'test' }, terminalWs: null },
        );
        if (fenced) await expect(serviceUpdate, label).rejects.toMatchObject({ code: 'data_restore' });
        else await expect(serviceUpdate, label).resolves.toMatchObject({ kind: 'service_failed', code: 'docker_endpoint_protected' });
      }
      // Fenced runs come first and reach no gate; an unfenced automatic update gates before its endpoint check.
      if (fenced) {
        expect(gate).not.toHaveBeenCalled();
        expect(imageGate).not.toHaveBeenCalled();
      }
    }
    // A fence recorded after an automatic update's own pre-check is still the
    // answer at its endpoint check, with the observation left unspent.
    resetStack();
    const { data } = composeStackOf('single');
    fencedOverwriteOf(data);
    const { FileSystemService } = await import('../services/FileSystemService');
    vi.spyOn(FileSystemService.prototype, 'refuseIfComposeFenced').mockImplementationOnce(async () => undefined);
    const consume = vi.fn();
    await expect(applyAutomaticStackUpdate({
      nodeId, stackName: 'web', updatedImages: ['nginx:1'], policyOptions: { bypass: false, actor: 'auto-update:test' },
      verificationOwner: 'hub_authority', observation: { verify: async () => undefined, consume },
    })).rejects.toMatchObject({ code: 'data_restore' });
    expect(consume).not.toHaveBeenCalled();
  });

  it('keeps the update policy answer for a compose file that is not fenced but cannot be rendered, and for a rendered file whose policy refuses while it is fenced', async () => {
    const updatePolicy = await import('../services/updatePolicy');
    const { resolveSenchoLabels } = await import('../helpers/senchoLabels');
    let renderable = false;
    vi.spyOn(updatePolicy, 'resolveUpdatePolicy').mockImplementation(async (_nodeId, request) =>
      updatePolicy.evaluateUpdatePolicy(renderable
        ? resolveSenchoLabels({ services: { app: { image: 'nginx:1', labels: { 'io.sencho.update': 'disabled' } } } })
        : { renderable: false }, request));
    const { ComposeService } = await import('../services/ComposeService');
    const rendering = ComposeService.getInstance();
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      ...rendering, evaluateDockerEndpoint: async () => null,
    } as unknown as ReturnType<typeof ComposeService.getInstance>);
    const enforcement = await import('../services/PolicyEnforcement');
    const gate = vi.spyOn(enforcement, 'enforcePolicyPreDeploy');
    const { StackUpdateOrchestrator } = await import('../services/StackUpdateOrchestrator');
    const execute = vi.spyOn(StackUpdateOrchestrator.getInstance(), 'execute');
    const { WebhookService } = await import('../services/WebhookService');
    const { applyAutomaticStackUpdate } = await import('../services/automaticStackUpdate');
    const db = DatabaseService.getInstance();
    for (const fenced of [false, true]) {
      renderable = fenced;
      resetStack();
      const { data } = composeStackOf('single');
      // Unfenced: another directory holds the fence, so the check runs and finds this file clear.
      if (fenced) fencedOverwriteOf(data);
      else fencedOverwriteOf(dataDir('other'), ['other']);
      const service = await request(app).post('/api/stacks/web/services/app/update').set('Cookie', adminCookie);
      expect(service.status, String(fenced)).toBe(409);
      expect(service.body.code, String(fenced)).toBe('update_policy_blocked');
      const webhookId = db.addWebhook({
        node_id: nodeId, name: `policy-pull-${fenced}`, stack_name: 'web', action: 'pull',
        secret: WebhookService.getInstance().generateSecret(), enabled: true,
      });
      const outcome = await WebhookService.getInstance().execute(db.getWebhook(webhookId)!, 'pull', 'test');
      expect(outcome, String(fenced)).toMatchObject({ success: true });
      const runs = db.getWebhookExecutions(webhookId);
      expect(runs[0], String(fenced)).toMatchObject({ status: 'success' });
      expect(runs[0].error, String(fenced)).toMatch(fenced ? /disabled/ : /render/i);
      const verify = vi.fn();
      const automatic = await applyAutomaticStackUpdate({
        nodeId, stackName: 'web', updatedImages: ['nginx:1'], policyOptions: { bypass: false, actor: 'auto-update:test' },
        verificationOwner: 'hub_authority', observation: { verify, consume: vi.fn() },
      });
      expect(automatic, String(fenced)).toMatchObject({ result: 'update_policy_skipped', applied: false });
      expect(verify, String(fenced)).not.toHaveBeenCalled();
    }
    expect(gate).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('leaves a compose read failure that is not the fence to the update and the drift view, unlogged by the pre-check', async () => {
    const { FileSystemService } = await import('../services/FileSystemService');
    const fsService = FileSystemService.getInstance(nodeId);
    const drift = await import('../services/DriftDetectionService');
    vi.spyOn(drift, 'buildStackDriftReport').mockResolvedValue({ stackName: 'web', findings: [] } as never);
    resetStack();
    const compose = path.join(stackDir('web'), 'compose.yaml');
    fs.rmSync(compose);
    execFileSync('mkfifo', [compose]);
    // Another directory is fenced, so the fence is asked and finds nothing.
    fencedOverwriteOf(dataDir('other'), ['other']);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(fsService.refuseIfComposeFenced('web')).resolves.toBeUndefined();
    expect(errors).not.toHaveBeenCalled();
    const view = await request(app).get('/api/stacks/web/drift').set('Cookie', adminCookie);
    expect(view.status).toBe(200);
    expect(view.body.temporal).toMatchObject({ hasBaseline: false });
  });

  it('admits the services list and update preview read of a compose file in the fenced directory under the fence, by any timing', async () => {
    const { ImageUpdateService } = await import('../services/ImageUpdateService');
    vi.spyOn(ImageUpdateService, 'isChecksEnabled').mockReturnValue(true);
    const fence = await import('../services/recovery/restoreFence');
    const { FileSystemService } = await import('../services/FileSystemService');
    const fsService = FileSystemService.getInstance(nodeId);
    const routes = () => ({
      services: request(app).get('/api/stacks/web/services').set('Cookie', adminCookie),
      preview: request(app).get('/api/stacks/web/update-preview').set('Cookie', adminCookie),
      reconcile: request(app).post('/api/stacks/web/update-preview').set('Cookie', adminCookie),
    });
    for (const shape of LINK_SHAPES) {
      // The file is there and the directory is already fenced.
      resetStack();
      const { data } = composeStackOf(shape);
      fencedOverwriteOf(data, ['web']);
      await expect(fsService.getStackContent('web'), shape).rejects.toMatchObject({ code: 'data_restore' });
      for (const [name, pending] of Object.entries(routes())) {
        const res = await pending;
        expect(res.status, `${shape} ${name}`).toBe(409);
        expect(res.body.code, `${shape} ${name}`).toBe('data_restore');
      }
      // The fence lands after the compose file was resolved.
      resetStack();
      const late = composeStackOf(shape);
      await beforeNextAdmission(() => { fencedOverwriteOf(late.data, ['web']); });
      await expect(fsService.getStackContent('web'), `${shape} late fence`).rejects.toMatchObject({ code: 'data_restore' });
      vi.mocked(fence.matchFsWorkToFences).mockRestore();
      expect(fence.fsWorkInFlightCountForTests(), shape).toBe(0);
      // The file is moved aside between its resolution and its read.
      for (const [name, pending] of Object.entries(routes())) {
        await beforeNextAdmission(() => {
          if (fs.existsSync(late.compose)) fs.renameSync(late.compose, `${late.compose}.aside`);
        });
        const res = await pending;
        vi.mocked(fence.matchFsWorkToFences).mockRestore();
        expect(fs.existsSync(`${late.compose}.aside`), `${shape} ${name} moved`).toBe(true);
        expect(res.status, `${shape} ${name} moved`).toBe(409);
        expect(res.body.code, `${shape} ${name} moved`).toBe('data_restore');
        if (fs.existsSync(`${late.compose}.aside`)) fs.renameSync(`${late.compose}.aside`, late.compose);
      }
    }
    // No fence on the link's way: the read answers as before.
    resetStack();
    linkedComposeStack();
    fencedOverwriteOf(dataDir('other'), ['other']);
    expect(await fsService.getStackContent('web')).toContain('image: nginx');
    const services = await request(app).get('/api/stacks/web/services').set('Cookie', adminCookie);
    expect(services.status).toBe(200);
    expect(services.body).toEqual(['app']);
  });

  it('makes a fence recorded while an env save is writing wait for it', async () => {
    const { data, envFile } = envStack();
    const fence = await import('../services/recovery/restoreFence');
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    holdWriteOpenOf(envFile, entered, held);
    const saving = putEnv(envFile).then((res) => res.status);
    await inside;
    fencedOverwriteOf(data, ['web']);
    const target = { senchoPath: data, hostPath: data, aliases: [] };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await fence.waitForFsWorkOn(target, 50)).toBe(false);
    const drained = fence.waitForFsWorkOn(target, 5_000);
    finish();
    expect(await saving).toBe(200);
    expect(await drained).toBe(true);
    expect(fence.fsWorkInFlightCountForTests()).toBe(0);
  });
});

describe('a download whose response a directory fence cut off before its source was open', () => {
  async function gatewayProto() {
    return (await import('../services/FileRootGateway')).FileRootGateway.prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  }

  /** Hold `method` on its way in until the test lets it go, keeping what it returned. */
  function holdOn(proto: Record<string, (...args: unknown[]) => Promise<unknown>>, method: string) {
    const original = proto[method];
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const returned: unknown[] = [];
    let calls = 0;
    vi.spyOn(proto, method).mockImplementation(async function (this: unknown, ...args: unknown[]) {
      calls += 1;
      entered();
      await held;
      const result = await original.apply(this, args);
      returned.push(result);
      return result;
    });
    return { inside, finish, returned, calls: () => calls };
  }

  async function settled(fence: typeof import('../services/recovery/restoreFence')): Promise<void> {
    for (let i = 0; i < 200 && fence.fsWorkInFlightCountForTests() > 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(fence.fsWorkInFlightCountForTests()).toBe(0);
  }

  function bigFile(data: string): void {
    fs.writeFileSync(path.join(data, 'big.bin'), Buffer.alloc(8 * 1024 * 1024, 7));
  }

  it('closes the file a single download opened after the cut-off, and lets the fence go', async () => {
    const data = dataDir('web');
    bigFile(data);
    models.byStack.web = [{ source: data, target: '/data' }];
    const query = `rootId=${encodeURIComponent(await rootIdOf('web'))}`;
    const hold = holdOn(await gatewayProto(), 'download');
    const pending = request(app).get(`/api/stacks/web/files/download?${query}&path=big.bin`).set('Cookie', adminCookie)
      .then(() => 'answered', () => 'cut off');
    await hold.inside;
    const fence = await import('../services/recovery/restoreFence');
    fencedOverwriteOf(data, ['web']);
    expect(await fence.waitForFsWorkOn({ senchoPath: data, hostPath: data, aliases: [] }, 5_000)).toBe(true);
    hold.finish();
    expect(await pending).toBe('cut off');
    await settled(fence);
    const opened = hold.returned[0] as { kind: string; stream: import('stream').Readable };
    expect(opened.kind).not.toBe('buffer');
    for (let i = 0; i < 100 && !opened.stream.destroyed; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(opened.stream.destroyed).toBe(true);
  });

  it('closes the file a bulk download opened after the cut-off, and finishes its handler', async () => {
    const data = dataDir('web');
    bigFile(data);
    models.byStack.web = [{ source: data, target: '/data' }];
    const query = `rootId=${encodeURIComponent(await rootIdOf('web'))}`;
    const hold = holdOn(await gatewayProto(), 'download');
    const pending = request(app).get(`/api/stacks/web/files/bulk-download?${query}&path=big.bin`).set('Cookie', adminCookie)
      .then(() => 'answered', () => 'cut off');
    await hold.inside;
    const fence = await import('../services/recovery/restoreFence');
    fencedOverwriteOf(data, ['web']);
    expect(await fence.waitForFsWorkOn({ senchoPath: data, hostPath: data, aliases: [] }, 5_000)).toBe(true);
    hold.finish();
    expect(await pending).toBe('cut off');
    await settled(fence);
    const opened = hold.returned[0] as { kind: string; stream: import('stream').Readable };
    for (let i = 0; i < 100 && !opened.stream.destroyed; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(opened.stream.destroyed).toBe(true);
  });

  it('closes the file a bulk download is streaming when the fence cuts it off, and finishes its handler', async () => {
    const data = dataDir('web');
    bigFile(data);
    models.byStack.web = [{ source: data, target: '/data' }];
    const query = `rootId=${encodeURIComponent(await rootIdOf('web'))}`;
    const proto = await gatewayProto();
    const original = proto.download;
    const { PassThrough } = await import('stream');
    // The entry streams one chunk and then waits for more, as a slow read would.
    const streaming = new PassThrough();
    let started!: () => void;
    const flowing = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(proto, 'download').mockImplementation(async function (this: unknown, ...args: unknown[]) {
      const opened = await original.apply(this, args) as { kind: string; stream?: import('stream').Readable; size: number };
      opened.stream?.destroy();
      streaming.write(Buffer.alloc(64 * 1024, 7));
      started();
      return { ...opened, kind: 'stream', stream: streaming };
    });
    const pending = request(app).get(`/api/stacks/web/files/bulk-download?${query}&path=big.bin`).set('Cookie', adminCookie)
      .then(() => 'answered', () => 'cut off');
    await flowing;
    await new Promise((r) => setTimeout(r, 50));
    const fence = await import('../services/recovery/restoreFence');
    fencedOverwriteOf(data, ['web']);
    expect(await fence.waitForFsWorkOn({ senchoPath: data, hostPath: data, aliases: [] }, 5_000)).toBe(true);
    expect(await pending).toBe('cut off');
    await settled(fence);
    expect(streaming.destroyed).toBe(true);
  });

  it('opens nothing for a bulk download cut off during its prewalk', async () => {
    const data = dataDir('web');
    bigFile(data);
    models.byStack.web = [{ source: data, target: '/data' }];
    const query = `rootId=${encodeURIComponent(await rootIdOf('web'))}`;
    const proto = await gatewayProto();
    const hold = holdOn(proto, 'stat');
    const download = vi.spyOn(proto, 'download');
    const pending = request(app).get(`/api/stacks/web/files/bulk-download?${query}&path=big.bin`).set('Cookie', adminCookie)
      .then(() => 'answered', () => 'cut off');
    await hold.inside;
    const fence = await import('../services/recovery/restoreFence');
    fencedOverwriteOf(data, ['web']);
    expect(await fence.waitForFsWorkOn({ senchoPath: data, hostPath: data, aliases: [] }, 5_000)).toBe(true);
    hold.finish();
    expect(await pending).toBe('cut off');
    await settled(fence);
    expect(download).not.toHaveBeenCalled();
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
