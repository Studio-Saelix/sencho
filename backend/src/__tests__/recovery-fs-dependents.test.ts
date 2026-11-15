/**
 * Who depends on a host directory, what a live overwrite of one closes, and
 * which work on an overlapping directory is refused.
 *
 * A directory several stacks share is one protected root, and every stack that
 * declares it, or a path inside it, or a writable ancestor of it, is part of
 * every access check. Sencho's own container mounts the compose base, which is
 * an ancestor of every stack source, so it is never one of them.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
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

  it('records a host directory intent only with its paths', () => {
    const store = intents.RestoreIntentStore.getInstance();
    expect(() => store.recordOverwrite({
      operationId: 'x', pointId: 'y', targetVolume: 'fs:abc', actor: 'a', processEpoch: 'e',
      stagingVolume: 'sencho-recovery-stage-1', expectedGenerationToken: 't',
    })).toThrow();
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
    await expect(fence.startContainerUnderFence(inspectable([{ Type: 'bind', Source: '/srv/data' }]), 'c1', start))
      .rejects.toMatchObject({ code: 'data_restore' });
    expect(start).not.toHaveBeenCalled();
  });

  it('names the directory in the refusal a stack file route answers with', () => {
    fencedDirectory({ senchoPath: '/srv/compose/web/data', hostPath: '/opt/web/data' });
    const refusal = fence.fsFenceRefusalFor('/srv/compose/web');
    expect(refusal?.code).toBe('data_restore');
    expect(refusal?.message).toContain('/opt/web/data');
    expect(refusal?.message).toContain('directory');
    expect(fence.fsFenceRefusalFor('/srv/compose/web/data/db')).not.toBeNull();
    expect(fence.fsFenceRefusalFor('/srv/compose/other')).toBeNull();
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
