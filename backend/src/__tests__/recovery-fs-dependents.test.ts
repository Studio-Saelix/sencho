/**
 * Who depends on a host directory, what a live overwrite of one closes, and
 * which work on an overlapping directory is refused.
 *
 * A directory several stacks share is one protected root, and every stack that
 * declares it, or a path inside it, or a writable ancestor of it, is part of
 * every access check. Sencho's own container mounts the compose base, which is
 * an ancestor of every stack source, so it is never one of them.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Docker from 'dockerode';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import type { FsRootListing, FsRootDeclaration } from '../services/StackFileRootsService';

let roots: typeof import('../services/recovery/fsRoots');
let fence: typeof import('../services/recovery/restoreFence');
let intents: typeof import('../services/recovery/restoreIntents');
let identities: typeof import('../services/recovery/storageIdentity');
let recoveryDbModule: typeof import('../services/recovery/recoveryDb');
let StackFileRoots: typeof import('../services/StackFileRootsService');
let SelfIdentityService: typeof import('../services/SelfIdentityService').default;
let DockerController: typeof import('../services/DockerController').default;
let tmpDir: string;

const ENVIRONMENT = { composeBaseDir: '/srv/compose', ownMounts: null, dockerRoot: '/var/lib/docker' } as const;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  roots = await import('../services/recovery/fsRoots');
  fence = await import('../services/recovery/restoreFence');
  intents = await import('../services/recovery/restoreIntents');
  identities = await import('../services/recovery/storageIdentity');
  recoveryDbModule = await import('../services/recovery/recoveryDb');
  StackFileRoots = await import('../services/StackFileRootsService');
  SelfIdentityService = (await import('../services/SelfIdentityService')).default;
  DockerController = (await import('../services/DockerController')).default;
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  const db = recoveryDbModule.recoveryDb();
  for (const table of ['recovery_restore_fence_members', 'recovery_restore_intents', 'recovery_point_holds',
    'recovery_locks', 'recovery_operations', 'recovery_point_verifications', 'recovery_points',
    'recovery_repositories', 'recovery_storage_dependents', 'recovery_storage_identities']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  vi.restoreAllMocks();
  vi.spyOn(DockerController, 'resolveProjectNameMap').mockResolvedValue(new Map());
});

function bind(senchoPath: string, overrides: Partial<FsRootDeclaration> = {}): FsRootDeclaration {
  return {
    rootId: `bind:${'0'.repeat(16)}`,
    role: 'bind',
    senchoPath,
    declaredSources: [senchoPath],
    mounts: [{ service: 'app', containerPath: '/data', readOnly: false }],
    label: '/data',
    accessible: true,
    isDirectory: true,
    dangerous: false,
    managedSourceOverlap: false,
    readonly: false,
    ...overrides,
  };
}

function source(stackName: string): FsRootDeclaration {
  return bind(`/srv/compose/${stackName}`, { rootId: 'stack-source', role: 'stack_source', declaredSources: [], mounts: [] });
}

/** Each stack's roots, as the roots service would list them. */
function stackRoots(listings: Record<string, FsRootListing>): void {
  vi.spyOn(StackFileRoots.StackFileRootsService.prototype, 'listFsRoots')
    .mockImplementation(async function (this: unknown, stackName: string) {
      return listings[stackName] ?? { outcome: 'absent', roots: [source(stackName)] };
    });
}

function containers(list: Array<{ Id: string; project?: string; service?: string; State?: string; Mounts: Array<{ Source: string; RW?: boolean }> }>) {
  return {
    listContainers: async () => list.map((c) => ({
      Id: c.Id,
      Names: [`/${c.Id}`],
      State: c.State ?? 'running',
      Labels: c.project ? { 'com.docker.compose.project': c.project, 'com.docker.compose.service': c.service ?? 'app' } : {},
      Mounts: c.Mounts.map((m) => ({ Type: 'bind', Source: m.Source, Destination: '/x', RW: m.RW !== false })),
    })),
  } as unknown as Pick<Docker, 'listContainers'>;
}

const DATA = { senchoPath: '/srv/data', hostPath: '/srv/data', aliases: [] as string[] };

async function resolve(options: {
  known: string[];
  docker?: Pick<Docker, 'listContainers'>;
  storageKey?: string | null;
  root?: typeof DATA;
  onlyStacks?: string[];
  cachedOnly?: boolean;
}) {
  return roots.resolveFsRootDependents({
    nodeId: 1,
    storageKey: options.storageKey ?? null,
    knownStackNames: options.known,
    root: options.root ?? DATA,
    render: true,
    onlyStacks: options.onlyStacks,
    cachedOnly: options.cachedOnly,
    docker: options.docker ?? containers([]),
    environment: ENVIRONMENT,
  });
}

describe('dependent stacks', () => {
  it('makes every stack that binds the same directory a dependent', async () => {
    stackRoots({
      web: { outcome: 'rendered', roots: [source('web'), bind('/srv/data')] },
      worker: { outcome: 'rendered', roots: [source('worker'), bind('/srv/data', { readonly: true })] },
      other: { outcome: 'rendered', roots: [source('other'), bind('/srv/elsewhere')] },
    });
    const resolution = await resolve({ known: ['web', 'worker', 'other'] });
    expect(resolution.kind).toBe('resolved');
    expect(resolution.dependents.map((d) => d.stackName).sort()).toEqual(['web', 'worker']);
  });

  it('counts a child declaration and a writable parent declaration, never a read-only parent', async () => {
    stackRoots({
      child: { outcome: 'rendered', roots: [source('child'), bind('/srv/data/db', { readonly: true })] },
      parent: { outcome: 'rendered', roots: [source('parent'), bind('/srv')] },
      reader: { outcome: 'rendered', roots: [source('reader'), bind('/srv', { readonly: true })] },
      sibling: { outcome: 'rendered', roots: [source('sibling'), bind('/srv/database')] },
    });
    const resolution = await resolve({ known: ['child', 'parent', 'reader', 'sibling'] });
    expect(resolution.dependents.map((d) => d.stackName).sort()).toEqual(['child', 'parent']);
  });

  it('makes a stack that declares the directory under a second spelling a dependent, by device and inode', async () => {
    // Sencho reaches one directory through two of its own mounts: the spellings
    // share no prefix, so only the identity ties them together.
    const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsdeps-identity-')));
    try {
      const realStat = await fs.promises.stat(real, { bigint: true });
      const originalStat = fs.promises.stat.bind(fs.promises);
      vi.spyOn(fs.promises, 'stat').mockImplementation((async (target: fs.PathLike, options?: fs.StatOptions) => (
        target === '/mnt/second/data' ? realStat : originalStat(target, options)
      )) as unknown as typeof fs.promises.stat);
      stackRoots({
        web: { outcome: 'rendered', roots: [source('web'), bind('/mnt/second/data')] },
        other: { outcome: 'rendered', roots: [source('other'), bind('/mnt/second/other')] },
      });
      const root = { senchoPath: real, hostPath: real, aliases: [] as string[] };
      const resolution = await resolve({ known: ['web', 'other'], root });
      expect(resolution.dependents.map((d) => d.stackName)).toEqual(['web']);
      const bindOf = (Source: string) => ({ Mounts: [{ Type: 'bind', Source, Destination: '/x', RW: true }] });
      expect((await roots.matchContainerToRoot(bindOf('/mnt/second/data'), root, null)).depends).toBe(true);
      expect((await roots.matchContainerToRoot(bindOf('/mnt/second/other'), root, null)).depends).toBe(false);
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  it('names the stacks that declare the directory when renders finish out of order', async () => {
    const names = Array.from({ length: 9 }, (_, i) => `s${i}`);
    vi.spyOn(StackFileRoots.StackFileRootsService.prototype, 'listFsRoots')
      .mockImplementation(async function (this: unknown, stackName: string) {
        const index = Number(stackName.slice(1));
        // Later stacks answer first.
        await new Promise((resolve) => setTimeout(resolve, (names.length - index) * 3));
        const declares = stackName === 's2' || stackName === 's7';
        return { outcome: 'rendered', roots: [source(stackName), ...(declares ? [bind('/srv/data')] : [bind(`/srv/${stackName}`)])] };
      });
    const resolution = await resolve({ known: names });
    expect(resolution.kind).toBe('resolved');
    expect(resolution.dependents.map((d) => d.stackName).sort()).toEqual(['s2', 's7']);
  });

  it('makes a stack whose model would not render leave the set unknown', async () => {
    stackRoots({
      web: { outcome: 'rendered', roots: [source('web'), bind('/srv/data')] },
      broken: { outcome: 'unrenderable', roots: [source('broken')] },
    });
    const resolution = await resolve({ known: ['web', 'broken'] });
    expect(resolution.kind).toBe('unrenderable');
  });

  it('keeps the recorded dependents of a storage, so a stack that stopped declaring it is still checked', async () => {
    stackRoots({});
    const observed = identities.StorageIdentityStore.getInstance().observe({
      ownerNodeKey: 'docker-engine:a', kind: 'bind_root', locator: '/srv/data', generationToken: 'fs|1|1.000000001',
      dependents: [{ stackName: 'former', serviceName: null }],
    });
    const resolution = await resolve({ known: ['web'], storageKey: observed.storageKey });
    expect(resolution.dependents.map((d) => d.stackName)).toEqual(['former']);
    expect(resolution.current).toEqual([]);
  });

  it('reads only cached roots when asked, and calls a stack with nothing cached unknown', async () => {
    const list = vi.spyOn(StackFileRoots.StackFileRootsService.prototype, 'listFsRoots');
    const resolution = await resolve({ known: ['web'], cachedOnly: true });
    expect(resolution.kind).toBe('unrenderable');
    expect(list).not.toHaveBeenCalled();
  });
});

describe('dependent containers', () => {
  it('maps a container to its stack, makes an unowned one hold the caller to the node-wide check, and lists read-only ancestors as observers', async () => {
    stackRoots({});
    const resolution = await resolve({
      known: ['web'],
      docker: containers([
        { Id: 'web-1', project: 'web', Mounts: [{ Source: '/srv/data' }] },
        { Id: 'manual', Mounts: [{ Source: '/srv/data/cache' }] },
        { Id: 'monitor', Mounts: [{ Source: '/', RW: false }] },
        { Id: 'unrelated', Mounts: [{ Source: '/srv/database' }] },
      ]),
    });
    expect(resolution.dependents.map((d) => d.stackName)).toEqual(['web']);
    expect(resolution.mountedByContainer).toBe(true);
    expect(resolution.unownedContainer).toBe(true);
    expect(resolution.observers).toEqual(['monitor']);
  });

  it('never counts Sencho\'s own container, which mounts the compose base', async () => {
    stackRoots({});
    vi.spyOn(SelfIdentityService.getInstance(), 'isOwnContainer').mockImplementation((id: string) => id === 'sencho');
    const resolution = await resolve({
      known: [],
      root: { senchoPath: '/srv/compose/web', hostPath: '/srv/compose/web', aliases: [] },
      docker: containers([{ Id: 'sencho', Mounts: [{ Source: '/srv/compose' }] }]),
    });
    expect(resolution.mountedByContainer).toBe(false);
    expect(resolution.unownedContainer).toBe(false);
  });

  it('observes only live dependents as in use', async () => {
    const docker = containers([
      { Id: 'stopped', State: 'exited', Mounts: [{ Source: '/srv/data' }] },
      { Id: 'reader', Mounts: [{ Source: '/srv', RW: false }] },
    ]);
    expect(await roots.observeFsRootInUse({ docker, root: DATA, ownMounts: null })).toEqual({ inUse: false, liveContainers: [] });
    const live = containers([{ Id: 'writer', Mounts: [{ Source: '/srv/data/db' }] }]);
    expect(await roots.observeFsRootInUse({ docker: live, root: DATA, ownMounts: null })).toEqual({ inUse: true, liveContainers: ['writer'] });
  });
});

/** A bind-root identity, an operation holding its storage lock, and its key. */
function lockDirectory(locator: string): string {
  const store = identities.StorageIdentityStore.getInstance();
  const observed = store.observe({
    ownerNodeKey: 'docker-engine:a', kind: 'bind_root', locator, generationToken: `fs|${randomUUID()}|1.000000001`, dependents: [],
  });
  const db = recoveryDbModule.recoveryDb();
  const operationId = randomUUID();
  db.prepare(`INSERT INTO recovery_operations (id, idempotency_key, kind, actor, transport, state, process_epoch, created_at, updated_at)
    VALUES (?, ?, 'create_point', 'admin', 'local', 'running', 'e', 1, 1)`).run(operationId, randomUUID());
  db.prepare(`INSERT INTO recovery_locks (scope, resource_key, owner_operation_id, process_epoch, acquired_at)
    VALUES ('storage', ?, ?, 'e', 1)`).run(observed.storageKey, operationId);
  return observed.storageKey;
}

/** A staged overwrite of a host directory, walked to `fenced` with its fence held. */
function fencedDirectory(paths: { senchoPath: string; hostPath: string; aliases?: string[] }, fenceState: 'held' | 'none' = 'held'): string {
  const db = recoveryDbModule.recoveryDb();
  const storage = identities.StorageIdentityStore.getInstance().observe({
    ownerNodeKey: 'docker-engine:a', kind: 'bind_root', locator: paths.hostPath, generationToken: `fs|${randomUUID()}|1.000000001`, dependents: [],
  });
  db.exec(`INSERT OR IGNORE INTO recovery_repositories (id, authority_id, owner_node_key, kind, locator, failure_domain, created_at)
    VALUES ('r1', 'a', 'docker-engine:a', 'local_volume', 'repo', 'same_failure_domain', 1);`);
  const operationId = randomUUID();
  db.prepare(`INSERT INTO recovery_operations (id, idempotency_key, kind, actor, transport, state, process_epoch, created_at, updated_at)
    VALUES (?, ?, 'restore', 'admin', 'local', 'running', 'e', 1, 1)`).run(operationId, randomUUID());
  const pointId = randomUUID();
  db.prepare(`INSERT INTO recovery_points
    (id, schema_version, storage_id, storage_generation, kind, repository_id, snapshot_id, status, consistency,
     capture_json, trigger_kind, actor, source_operation_id, source_node_key, engine_id, capability_version, started_at, completed_at)
    VALUES (?, 3, ?, 1, 'root', 'r1', 'snap', 'succeeded', 'crash_consistent_live',
      '{"fileCount":1,"byteCount":1,"skippedCount":0}', 'manual', 'admin', ?, 'docker-engine:a', 'restic', 1, 1, 2)`)
    .run(pointId, storage.id, operationId);
  const store = intents.RestoreIntentStore.getInstance();
  const intent = store.recordOverwrite({
    operationId,
    pointId,
    targetVolume: roots.fsTargetKey(storage.storageKey),
    targetPaths: { senchoPath: paths.senchoPath, hostPath: paths.hostPath, aliases: paths.aliases ?? [] },
    actor: 'admin',
    processEpoch: 'e',
    stagingVolume: `sencho-recovery-stage-${randomUUID()}`,
    expectedGenerationToken: storage.generationToken,
  });
  for (const step of ['staging', 'staged_verified', 'fenced'] as const) store.advance(intent.id, step);
  if (fenceState === 'held') fence.RestoreFenceStore.getInstance().setFenceState(intent.id, 'held');
  return intent.id;
}

describe('overlapping work', () => {
  it('refuses work on a directory inside, around or equal to one a storage lock holds', () => {
    const held = lockDirectory('/srv/data');
    for (const candidate of ['/srv', '/srv/data', '/srv/data/db']) {
      expect(() => roots.assertNoOverlappingFsWork(candidate, 'another-key'), candidate).toThrow(expect.objectContaining({ errorClass: 'lock_held' }));
    }
    expect(() => roots.assertNoOverlappingFsWork('/srv/database', 'another-key')).not.toThrow();
    // A directory's own lock is the storage lock the admission takes, not an overlap.
    expect(() => roots.assertNoOverlappingFsWork('/srv/data', held)).not.toThrow();
  });

  it('refuses a capture of a parent while an overwrite of a child is live, and the reverse', () => {
    fencedDirectory({ senchoPath: '/srv/data/db', hostPath: '/srv/data/db' }, 'none');
    expect(() => roots.assertNoOverlappingFsWork('/srv/data', 'k')).toThrow(expect.objectContaining({ errorClass: 'lock_held' }));
    expect(() => roots.assertNoOverlappingFsWork('/srv/data/db/inner', 'k')).toThrow(expect.objectContaining({ errorClass: 'lock_held' }));
    expect(() => roots.assertNoOverlappingFsWork('/srv/other', 'k')).not.toThrow();
  });

  it('treats an unsettled directory overwrite whose paths cannot be read as overlapping every directory', () => {
    const intentId = fencedDirectory({ senchoPath: '/srv/data', hostPath: '/srv/data' }, 'none');
    recoveryDbModule.recoveryDb().prepare("UPDATE recovery_restore_intents SET target_paths_json = '{broken' WHERE id = ?").run(intentId);
    expect(() => roots.assertNoOverlappingFsWork('/srv/elsewhere', 'k')).toThrow(expect.objectContaining({ errorClass: 'lock_held' }));
  });

  it('records a host directory intent only with its paths', () => {
    const store = intents.RestoreIntentStore.getInstance();
    expect(() => store.recordOverwrite({
      operationId: 'x', pointId: 'y', targetVolume: 'fs:abc', actor: 'a', processEpoch: 'e',
      stagingVolume: 'sencho-recovery-stage-1', expectedGenerationToken: 't',
    })).toThrow();
  });
});

describe('work directories left inside a directory', () => {
  let base: string;
  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsdeps-leftover-')));
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  function settledChild(child: { senchoPath: string; hostPath: string; aliases?: string[] }): string {
    const intentId = fencedDirectory(child);
    recoveryDbModule.recoveryDb().prepare("UPDATE recovery_restore_intents SET phase = 'completion_unknown', fence_state = 'released' WHERE id = ?").run(intentId);
    return intentId;
  }

  it('finds one left by a restore strictly inside, at any depth, and none for the directory itself or a parent', async () => {
    const parent = { senchoPath: path.join(base, 'data'), hostPath: '/host/data' };
    fs.mkdirSync(path.join(base, 'data/a/b'), { recursive: true });
    const grandchild = settledChild({ senchoPath: path.join(base, 'data/a/b'), hostPath: '/host/data/a/b' });
    fs.mkdirSync(path.join(base, `data/a/b/.sencho-restore-${grandchild}`));
    const self = settledChild({ senchoPath: parent.senchoPath, hostPath: parent.hostPath });
    fs.mkdirSync(path.join(base, `data/.sencho-restore-${self}`));
    const ancestor = settledChild({ senchoPath: base, hostPath: '/host' });
    fs.mkdirSync(path.join(base, `.sencho-restore-${ancestor}`));
    expect(await roots.nestedLeftoverWorkDirs(parent)).toEqual([`a/b/.sencho-restore-${grandchild}`]);
  });

  it('places a child recorded under another host spelling by Sencho\'s own path', async () => {
    const parent = { senchoPath: path.join(base, 'data'), hostPath: '/host/data' };
    fs.mkdirSync(path.join(base, 'data/inner'), { recursive: true });
    const child = settledChild({ senchoPath: path.join(base, 'data/inner'), hostPath: '/other-mount/data/inner' });
    fs.mkdirSync(path.join(base, `data/inner/.sencho-restore-${child}`));
    expect(await roots.nestedLeftoverWorkDirs(parent)).toEqual([`inner/.sencho-restore-${child}`]);
    // And by a declared spelling under the parent's host path.
    const aliased = settledChild({ senchoPath: '/elsewhere/inner2', hostPath: '/other-mount/inner2', aliases: ['/host/data/inner2'] });
    fs.mkdirSync(path.join(base, `data/inner2/.sencho-restore-${aliased}`), { recursive: true });
    expect(await roots.nestedLeftoverWorkDirs(parent)).toContain(`inner2/.sencho-restore-${aliased}`);
  });

  it('counts a work directory it cannot look at as present, and none where the child is no longer a directory', async () => {
    const parent = { senchoPath: path.join(base, 'data'), hostPath: '/host/data' };
    fs.mkdirSync(parent.senchoPath, { recursive: true });
    const replaced = settledChild({ senchoPath: path.join(base, 'data/file'), hostPath: '/host/data/file' });
    fs.writeFileSync(path.join(base, 'data/file'), 'now a file');
    expect(await roots.nestedLeftoverWorkDirs(parent)).toEqual([]);
    const hidden = settledChild({ senchoPath: path.join(base, 'data/locked'), hostPath: '/host/data/locked' });
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (target: fs.PathLike, options?: fs.StatOptions) => {
      if (String(target).includes(`.sencho-restore-${hidden}`)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return originalLstat(target, options);
    }) as unknown as typeof fs.promises.lstat);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await roots.nestedLeftoverWorkDirs(parent)).toEqual([`locked/.sencho-restore-${hidden}`]);
    expect(replaced).toBeTruthy();
  });

  it('skips a restore whose paths cannot be read, and says so once', async () => {
    const intentId = settledChild({ senchoPath: path.join(base, 'data/inner'), hostPath: '/host/data/inner' });
    recoveryDbModule.recoveryDb().prepare("UPDATE recovery_restore_intents SET target_paths_json = '{broken' WHERE id = ?").run(intentId);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const parent = { senchoPath: path.join(base, 'data'), hostPath: '/host/data' };
    expect(await roots.nestedLeftoverWorkDirs(parent)).toEqual([]);
    expect(await roots.nestedLeftoverWorkDirs(parent)).toEqual([]);
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('cannot be read'))).toHaveLength(1);
  });
});

describe('the fence on a host directory', () => {
  function inspectable(mounts: Array<{ Type: string; Source?: string; Name?: string; RW?: boolean }>) {
    return {
      getContainer: () => ({ inspect: async () => ({ Mounts: mounts }) }),
    } as unknown as Pick<Docker, 'getContainer'>;
  }

  it('refuses a container that would write the fenced directory, and starts one that only reads an ancestor', async () => {
    fencedDirectory({ senchoPath: '/srv/data', hostPath: '/srv/data' });
    vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue(null);
    const start = vi.fn(async () => 'started');
    await expect(fence.startContainerUnderFence(inspectable([{ Type: 'bind', Source: '/srv/data/db', RW: true }]), 'c1', start))
      .rejects.toMatchObject({ code: 'data_restore' });
    await expect(fence.startContainerUnderFence(inspectable([{ Type: 'bind', Source: '/srv', RW: true }]), 'c2', start))
      .rejects.toMatchObject({ code: 'data_restore' });
    expect(start).not.toHaveBeenCalled();
    await expect(fence.startContainerUnderFence(inspectable([{ Type: 'bind', Source: '/', RW: false }]), 'c3', start))
      .resolves.toBe('started');
    await expect(fence.startContainerUnderFence(inspectable([{ Type: 'bind', Source: '/srv/database', RW: true }]), 'c4', start))
      .resolves.toBe('started');
  });

  it('refuses a start when a directory is fenced after the match, at the registration itself', async () => {
    fencedDirectory({ senchoPath: '/srv/first', hostPath: '/srv/first' });
    vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockImplementation(async () => {
      // The second fence lands while the container's mounts are being matched.
      fencedDirectory({ senchoPath: '/srv/data', hostPath: '/srv/data' });
      return null;
    });
    const start = vi.fn(async () => 'started');
    // The refusal says the start was caught mid-check, not that the container mounts it.
    await expect(fence.startContainerUnderFence(inspectable([{ Type: 'bind', Source: '/srv/data' }]), 'c1', start))
      .rejects.toMatchObject({ code: 'data_restore', message: expect.stringMatching(/while Sencho was checking what this container mounts/) });
    expect(start).not.toHaveBeenCalled();
  });

  it('names the directory in the refusal a stack file route answers with', async () => {
    fencedDirectory({ senchoPath: '/srv/compose/web/data', hostPath: '/opt/web/data' });
    vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue(null);
    const refusal = (await fence.matchFsWorkToFences('/srv/compose/web')).refusal;
    expect(refusal?.code).toBe('data_restore');
    expect(refusal?.message).toContain('/opt/web/data');
    expect(refusal?.message).toContain('directory');
    expect((await fence.matchFsWorkToFences('/srv/compose/web/data/db')).refusal).not.toBeNull();
    expect((await fence.matchFsWorkToFences('/srv/compose/other')).refusal).toBeNull();
    // Trailing slashes do not change the comparison.
    expect((await fence.matchFsWorkToFences('/srv/compose/web//')).refusal).not.toBeNull();
    expect((await fence.matchFsWorkToFences('/srv/compose/web/dat/')).refusal).toBeNull();
    expect((await fence.matchFsWorkToFences('/srv/compose/other//')).refusal).toBeNull();
  });

  it('closes a fenced directory\'s recorded stacks to a Compose lifecycle like a volume\'s', async () => {
    const intentId = fencedDirectory({ senchoPath: '/srv/data', hostPath: '/srv/data' });
    recoveryDbModule.recoveryDb().prepare('UPDATE recovery_restore_intents SET dependent_stacks_json = ? WHERE id = ?')
      .run(JSON.stringify(['web']), intentId);
    expect(fence.RestoreFenceStore.getInstance().isStackFenced('web')).toBe(true);
    expect(fence.RestoreFenceStore.getInstance().liveFencedFsTargets()).toEqual([
      { senchoPath: '/srv/data', hostPath: '/srv/data', aliases: [] },
    ]);
  });
});

describe('the fence when nothing was fenced at the match', () => {
  it('matches a directory fenced while the container is inspected, when only a volume was fenced before', async () => {
    vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue(null);
    // A volume fence keeps the fast path off; no directory is fenced at the match.
    const docker = {
      getContainer: () => ({
        inspect: async () => {
          fencedDirectory({ senchoPath: '/srv/data', hostPath: '/srv/data' });
          return { Mounts: [{ Type: 'bind', Source: '/srv/data', RW: true }] };
        },
      }),
    } as unknown as Pick<Docker, 'getContainer'>;
    vi.spyOn(fence.RestoreFenceStore.getInstance(), 'liveFencedVolumeNames').mockReturnValue(['some_volume']);
    const start = vi.fn(async () => 'started');
    await expect(fence.startContainerUnderFence(docker, 'c1', start)).rejects.toMatchObject({ code: 'data_restore' });
    expect(start).not.toHaveBeenCalled();
  });

  it('treats a fenced directory whose record cannot be read as fencing every host path', async () => {
    const intentId = fencedDirectory({ senchoPath: '/srv/data', hostPath: '/srv/data' });
    recoveryDbModule.recoveryDb().prepare("UPDATE recovery_restore_intents SET target_paths_json = '{broken' WHERE id = ?").run(intentId);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(fence.RestoreFenceStore.getInstance().liveFencedFsTargets()).toEqual([{ senchoPath: '/', hostPath: '/', aliases: [] }]);
    vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue(null);
    expect((await fence.matchFsWorkToFences('/srv/anything')).refusal).not.toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

/**
 * One host tree that Sencho reaches through two of its own bind destinations.
 * Unit tests cannot make bind mounts, so the second destination is a symlink
 * whose spelling `realpath` is made to keep: the two paths then differ
 * lexically and share a device and inode, which is what two bind destinations
 * of one directory look like.
 */
describe('the fence through another spelling of the fenced directory', () => {
  let tree: string;
  let real: string;
  let second: string;
  let parentLink: string;
  let unrelated: string;

  beforeEach(() => {
    tree = fs.realpathSync(fs.mkdtempSync(path.join(tmpDir, 'spellings-')));
    real = path.join(tree, 'host', 'data');
    fs.mkdirSync(path.join(real, 'db'), { recursive: true });
    second = path.join(tree, 'second-destination');
    fs.symlinkSync(real, second);
    parentLink = path.join(tree, 'parent-destination');
    fs.symlinkSync(path.join(tree, 'host'), parentLink);
    unrelated = path.join(tree, 'elsewhere');
    fs.mkdirSync(unrelated);
    vi.spyOn(fs.promises, 'realpath').mockImplementation((async (target: fs.PathLike) => path.resolve(String(target))) as unknown as typeof fs.promises.realpath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tree, { recursive: true, force: true });
  });

  it('refuses file work on the same directory, a directory inside it, and an ancestor of it, under another spelling', async () => {
    vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue(null);
    fencedDirectory({ senchoPath: real, hostPath: '/srv/host/data' });
    expect((await fence.matchFsWorkToFences(second)).refusal?.code).toBe('data_restore');
    expect((await fence.matchFsWorkToFences(path.join(second, 'db'))).refusal?.code).toBe('data_restore');
    expect((await fence.matchFsWorkToFences(parentLink)).refusal?.code).toBe('data_restore');
    expect((await fence.matchFsWorkToFences(unrelated)).refusal).toBeNull();
  });

  it('refuses an ancestor under another spelling of a fenced child', async () => {
    vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue(null);
    fencedDirectory({ senchoPath: path.join(real, 'db'), hostPath: '/srv/host/data/db' });
    expect((await fence.matchFsWorkToFences(second)).refusal?.code).toBe('data_restore');
  });

  it('matches two own bind destinations of one host tree through the mount table', async () => {
    // Two real, distinct directories stand for two destinations of `/hostroot`.
    const first = path.join(tree, 'first-mount');
    const other = path.join(tree, 'other-mount');
    fs.mkdirSync(path.join(first, 'data'), { recursive: true });
    fs.mkdirSync(path.join(other, 'data', 'db'), { recursive: true });
    vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue([
      { source: '/hostroot', destination: first },
      { source: '/hostroot', destination: other },
    ]);
    fencedDirectory({ senchoPath: path.join(first, 'data'), hostPath: '/hostroot/data' });
    expect((await fence.matchFsWorkToFences(path.join(other, 'data'))).refusal?.code).toBe('data_restore');
    expect((await fence.matchFsWorkToFences(path.join(other, 'data', 'db'))).refusal?.code).toBe('data_restore');
    expect((await fence.matchFsWorkToFences(other)).refusal?.code).toBe('data_restore');
    expect((await fence.matchFsWorkToFences(unrelated)).refusal).toBeNull();
  });

  it('refuses file work it cannot prove clear of a fenced directory when its own mounts cannot be read', async () => {
    vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockRejectedValue(new Error('docker unavailable'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fencedDirectory({ senchoPath: real, hostPath: '/srv/host/data' });
    const refusal = (await fence.matchFsWorkToFences(unrelated)).refusal;
    expect(refusal?.code).toBe('data_restore');
    expect(refusal?.message).toMatch(/cannot prove/);
  });

  describe('a container start', () => {
    function inspectable(mounts: Array<{ Type: string; Source?: string; Name?: string; RW?: boolean }>) {
      return { getContainer: () => ({ inspect: async () => ({ Mounts: mounts }) }) } as unknown as Pick<Docker, 'getContainer'>;
    }
    const affected = () => [
      { label: 'equal', mounts: [{ Type: 'bind', Source: second, RW: true }] },
      { label: 'child', mounts: [{ Type: 'bind', Source: path.join(second, 'db'), RW: true }] },
      { label: 'writable ancestor', mounts: [{ Type: 'bind', Source: parentLink, RW: true }] },
    ];

    it('is refused for an equal, child or writable-ancestor bind through another spelling', async () => {
      vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue(null);
      fencedDirectory({ senchoPath: real, hostPath: real });
      const start = vi.fn(async () => 'started');
      for (const { label, mounts } of affected()) {
        await expect(fence.startContainerUnderFence(inspectable(mounts), label, start), label).rejects.toMatchObject({ code: 'data_restore' });
      }
      expect(start).not.toHaveBeenCalled();
      // A read-only ancestor only observes.
      await expect(fence.startContainerUnderFence(inspectable([{ Type: 'bind', Source: parentLink, RW: false }]), 'ro', start)).resolves.toBe('started');
    });

    it('is refused, never started, when Sencho cannot read its own mounts', async () => {
      vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockRejectedValue(new Error('docker unavailable'));
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      fencedDirectory({ senchoPath: real, hostPath: real });
      const start = vi.fn(async () => 'started');
      for (const { label, mounts } of affected()) {
        await expect(fence.startContainerUnderFence(inspectable(mounts), label, start), label)
          .rejects.toMatchObject({ code: 'data_restore', message: expect.stringMatching(/cannot prove/) });
      }
      expect(start).not.toHaveBeenCalled();
      // A container that binds no host path is not in question.
      await expect(fence.startContainerUnderFence(inspectable([{ Type: 'volume', Name: 'other_volume' }]), 'v', start)).resolves.toBe('started');
    });
  });
});

describe('file work admitted before a directory fence', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpDir, 'fswork-')));
    fs.mkdirSync(path.join(dir, 'data'));
    fs.mkdirSync(path.join(dir, 'other'));
    vi.spyOn(SelfIdentityService.getInstance(), 'getBindMounts').mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function admit(target: string) {
    const lease = fence.admitFsWork(target, new Set());
    if (!('release' in lease)) throw new Error('not admitted');
    return lease;
  }

  it('is waited for by the fence, and refused at its next step', async () => {
    const target = { senchoPath: path.join(dir, 'data'), hostPath: path.join(dir, 'data'), aliases: [] };
    const lease = admit(path.join(dir, 'data', 'db'));
    fencedDirectory(target);
    expect(lease.recheck()?.code).toBe('data_restore');
    let drained: boolean | undefined;
    const waiting = fence.waitForFsWorkOn(target, 5_000).then((result) => { drained = result; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(drained).toBeUndefined();
    lease.release();
    await waiting;
    expect(drained).toBe(true);
    expect(fence.fsWorkInFlightCountForTests()).toBe(0);
  });

  it('refuses the fence when the work does not finish in time', async () => {
    const target = { senchoPath: path.join(dir, 'data'), hostPath: path.join(dir, 'data'), aliases: [] };
    const lease = admit(dir);
    fencedDirectory(target);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await fence.waitForFsWorkOn(target, 30)).toBe(false);
    lease.release();
  });

  it('does not wait for work on an unrelated directory, and lets it carry on', async () => {
    const target = { senchoPath: path.join(dir, 'data'), hostPath: path.join(dir, 'data'), aliases: [] };
    const lease = admit(path.join(dir, 'other'));
    fencedDirectory(target);
    expect(await fence.waitForFsWorkOn(target, 5_000)).toBe(true);
    expect(lease.recheck()).toBeNull();
    lease.release();
  });

  it('cuts off work that can be cut off instead of waiting for it', async () => {
    const target = { senchoPath: path.join(dir, 'data'), hostPath: path.join(dir, 'data'), aliases: [] };
    const abort = vi.fn();
    const lease = fence.admitFsWork(path.join(dir, 'data'), new Set(), abort);
    if (!('release' in lease)) throw new Error('not admitted');
    fencedDirectory(target);
    expect(await fence.waitForFsWorkOn(target, 5_000)).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
    // Once its write is under way it is waited for again.
    lease.setAbort(null);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await fence.waitForFsWorkOn(target, 30)).toBe(false);
    lease.release();
  });

  it('refuses work cleared before a fence was recorded and registered after it', () => {
    fencedDirectory({ senchoPath: path.join(dir, 'data'), hostPath: path.join(dir, 'data') });
    const refused = fence.admitFsWork(path.join(dir, 'other'), new Set());
    expect(refused).toMatchObject({ code: 'data_restore', message: expect.stringMatching(/while this file operation/) });
    expect(fence.fsWorkInFlightCountForTests()).toBe(0);
  });
});
