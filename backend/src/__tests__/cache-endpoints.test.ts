/**
 * Integration tests for cached HTTP endpoints:
 *   - /api/stats (2s TTL, invalidated on writes)
 *   - /api/system/stats (3s TTL, no write invalidation)
 *   - /api/stacks/statuses (3s TTL, invalidated on writes)
 *   - /api/system/cache-stats (admin observability)
 *
 * Verifies cache hit behavior (second call does not re-invoke the
 * underlying Docker / si / FileSystem work), write-path invalidation
 * (POST /api/stacks resets the cache), and that the admin endpoint
 * reports per-namespace counters.
 *
 * The tests mock DockerController / FileSystemService at the service
 * layer rather than hitting the real Docker socket, so they run in CI
 * without requiring any external daemon.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_PASSWORD } from './helpers/setupTestDb';
import { installArcstatsFsMock, arcstatsBody, DEFAULT_ARC_PATH, type ArcstatsFsMock } from './helpers/arcstatsFsMock';
import { GitSourceService } from '../services/GitSourceService';
import type { PublicGitSource } from '../services/GitSourceService';
import { DatabaseService } from '../services/DatabaseService';
import * as selfStackGuard from '../helpers/selfStackGuard';

// ── Hoisted mocks (must come before importing the app) ─────────────────

const {
  mockGetAllContainers,
  mockGetBulkStackStatuses,
  mockGetStacks,
  mockCurrentLoad,
  mockMem,
  mockFsSize,
} = vi.hoisted(() => ({
  mockGetAllContainers: vi.fn(),
  mockGetBulkStackStatuses: vi.fn(),
  mockGetStacks: vi.fn(),
  mockCurrentLoad: vi.fn(),
  mockMem: vi.fn(),
  mockFsSize: vi.fn(),
}));

vi.mock('../services/DockerController', async () => {
  const actual = await vi.importActual<typeof import('../services/DockerController')>('../services/DockerController');
  return {
    ...actual,
    default: {
      ...actual.default,
      getInstance: () => ({
        getAllContainers: mockGetAllContainers,
        getBulkStackStatuses: mockGetBulkStackStatuses,
      }),
    },
    globalDockerNetwork: { rxSec: 0, txSec: 0 },
  };
});

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: () => ({
      getStacks: mockGetStacks,
      createStack: vi.fn().mockResolvedValue(undefined),
      getBaseDir: () => '/tmp/compose',
    }),
  },
}));

vi.mock('systeminformation', () => ({
  default: {
    currentLoad: (...args: unknown[]) => mockCurrentLoad(...args),
    mem: (...args: unknown[]) => mockMem(...args),
    fsSize: (...args: unknown[]) => mockFsSize(...args),
  },
  currentLoad: (...args: unknown[]) => mockCurrentLoad(...args),
  mem: (...args: unknown[]) => mockMem(...args),
  fsSize: (...args: unknown[]) => mockFsSize(...args),
}));

// ── Setup ──────────────────────────────────────────────────────────────

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;
let CacheService: typeof import('../services/CacheService').CacheService;
let arcFs: ArcstatsFsMock;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  // Host memory reads ZFS ARC stats; intercept those reads so results do not
  // depend on whether the CI host is itself ZFS. Default: no ARC present.
  arcFs = installArcstatsFsMock();
  ({ app } = await import('../index'));
  ({ CacheService } = await import('../services/CacheService'));

  const login = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USERNAME, password: TEST_PASSWORD });
  authCookie = (login.headers['set-cookie'] as unknown as string[])[0];
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  CacheService.getInstance().flush();
  arcFs.clear();

  mockGetAllContainers.mockReset();
  mockGetBulkStackStatuses.mockReset();
  mockGetStacks.mockReset();
  mockCurrentLoad.mockReset();
  mockMem.mockReset();
  mockFsSize.mockReset();

  mockGetAllContainers.mockResolvedValue([
    { State: 'running', Labels: { 'com.docker.compose.project.working_dir': '/tmp/compose/a' } },
    { State: 'exited', Labels: {} },
  ]);
  mockGetBulkStackStatuses.mockResolvedValue({});
  mockGetStacks.mockResolvedValue([]);
  mockCurrentLoad.mockResolvedValue({ currentLoad: 42.5, cpus: [{}, {}] });
  // active/available exclude reclaimable cache; used/free include it. The route
  // reports the cache-excluded figures, so the mock supplies the full shape:
  // active(400) + available(600) = total; used(500) = active + 100 cache.
  mockMem.mockResolvedValue({ total: 1000, used: 500, active: 400, free: 500, available: 600, buffcache: 100 });
  mockFsSize.mockResolvedValue([{ fs: '/dev/sda1', mount: '/', size: 1000, used: 500, available: 500, use: 50 }]);
});

// ── /api/stats ─────────────────────────────────────────────────────────

describe('GET /api/stats caching', () => {
  it('returns shape { active, managed, unmanaged, exited, total }', async () => {
    const res = await request(app).get('/api/stats').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('active');
    expect(res.body).toHaveProperty('managed');
    expect(res.body).toHaveProperty('unmanaged');
    expect(res.body).toHaveProperty('exited');
    expect(res.body).toHaveProperty('total');
  });

  it('serves the second call from cache without re-invoking Docker', async () => {
    await request(app).get('/api/stats').set('Cookie', authCookie);
    await request(app).get('/api/stats').set('Cookie', authCookie);
    expect(mockGetAllContainers).toHaveBeenCalledTimes(1);
  });

  it('invalidates on POST /api/stacks', async () => {
    await request(app).get('/api/stats').set('Cookie', authCookie);
    expect(mockGetAllContainers).toHaveBeenCalledTimes(1);

    const create = await request(app)
      .post('/api/stacks')
      .set('Cookie', authCookie)
      .send({ stackName: 'new-stack' });
    expect(create.status).toBe(200);

    await request(app).get('/api/stats').set('Cookie', authCookie);
    expect(mockGetAllContainers).toHaveBeenCalledTimes(2);
  });
});

// ── /api/system/stats ──────────────────────────────────────────────────

describe('GET /api/system/stats caching', () => {
  it('collapses concurrent calls so si.currentLoad() runs once', async () => {
    // Two back-to-back requests, the second should hit the cache.
    await request(app).get('/api/system/stats').set('Cookie', authCookie);
    await request(app).get('/api/system/stats').set('Cookie', authCookie);
    expect(mockCurrentLoad).toHaveBeenCalledTimes(1);
    expect(mockMem).toHaveBeenCalledTimes(1);
    expect(mockFsSize).toHaveBeenCalledTimes(1);
  });

  it('response includes network block that is read per-request outside the cache', async () => {
    const res1 = await request(app).get('/api/system/stats').set('Cookie', authCookie);
    const res2 = await request(app).get('/api/system/stats').set('Cookie', authCookie);
    expect(res1.body).toHaveProperty('network');
    expect(res2.body).toHaveProperty('network');
    // CPU/mem/disk sample is cached; network is fresh per request.
    expect(mockCurrentLoad).toHaveBeenCalledTimes(1);
  });

  it('reports memory from the active working set, excluding reclaimable cache', async () => {
    const res = await request(app).get('/api/system/stats').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    // With no ARC present, effective used is total - available (which equals
    // mem.active), not the cache-inclusive mem.used / mem.free, so a busy host
    // does not read ~100%.
    expect(res.body.memory).toMatchObject({
      total: 1000,
      used: 400,            // mem.active, not mem.used (500)
      free: 600,            // mem.available, not mem.free (500)
      usagePercent: '40.0', // 400 / 1000, not 500 / 1000
    });
  });

  it('adds reclaimable ZFS ARC back into available memory', async () => {
    arcFs.setRead(DEFAULT_ARC_PATH, arcstatsBody(300, 100)); // reclaimable 200
    const res = await request(app).get('/api/system/stats').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    // available 600 + 200 reclaimable ARC = 800 effective free; used drops to 200.
    expect(res.body.memory).toMatchObject({
      total: 1000,
      used: 200,
      free: 800,
      usagePercent: '20.0',
    });
  });
});

// ── /api/fleet/overview (local node) ───────────────────────────────────

describe('GET /api/fleet/overview local-node memory', () => {
  it('reports ARC-adjusted memory for the local node', async () => {
    arcFs.setRead(DEFAULT_ARC_PATH, arcstatsBody(300, 100)); // reclaimable 200
    const res = await request(app).get('/api/fleet/overview').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    const local = res.body.find((n: { type: string }) => n.type === 'local');
    expect(local?.systemStats?.memory).toMatchObject({
      total: 1000,
      used: 200,
      free: 800,
      usagePercent: '20.0',
    });
  });
});

// ── /api/stacks/statuses ───────────────────────────────────────────────

describe('GET /api/stacks/statuses caching', () => {
  // A healthy identity by default so computed results persist in the cache;
  // a degraded resolution would intentionally drop the entry after the call.
  // Tests that need a different identity override the mock on the shared spy.
  let identitySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    identitySpy = vi
      .spyOn(selfStackGuard, 'resolveSelfStackIdentity')
      .mockResolvedValue({ projectName: 'sencho', labels: null, degraded: false });
  });

  afterEach(() => {
    identitySpy.mockRestore();
    // The git-link test seeds a 'web' source row; drop it even when that
    // test fails mid-way so later tests never see it. Delete is a no-op when
    // the row is absent.
    DatabaseService.getInstance().deleteGitSource('web');
  });

  it('serves repeat calls from cache without re-invoking the filesystem', async () => {
    mockGetStacks.mockResolvedValue(['web', 'db']);
    mockGetBulkStackStatuses.mockResolvedValue({
      web: { status: 'running' },
      db: { status: 'running' },
    });

    const first = await request(app).get('/api/stacks/statuses').set('Cookie', authCookie);
    const second = await request(app).get('/api/stacks/statuses').set('Cookie', authCookie);

    expect(mockGetStacks).toHaveBeenCalledTimes(1);
    expect(mockGetBulkStackStatuses).toHaveBeenCalledTimes(1);
    expect(second.body).toEqual(first.body);
  });

  it('invalidates on POST /api/stacks', async () => {
    mockGetStacks.mockResolvedValue(['web']);
    mockGetBulkStackStatuses.mockResolvedValue({ web: { status: 'running' } });

    await request(app).get('/api/stacks/statuses').set('Cookie', authCookie);
    expect(mockGetStacks).toHaveBeenCalledTimes(1);

    await request(app)
      .post('/api/stacks')
      .set('Cookie', authCookie)
      .send({ stackName: 'fresh-stack' });

    await request(app).get('/api/stacks/statuses').set('Cookie', authCookie);
    expect(mockGetStacks).toHaveBeenCalledTimes(2);
  });

  it('labels each stack with its git/local source, served from the cache', async () => {
    mockGetStacks.mockResolvedValue(['web.yml', 'db.yml']);
    mockGetBulkStackStatuses.mockResolvedValue({
      web: { status: 'running' },
      db: { status: 'running' },
    });
    // Only `web` is linked to a Git source.
    const listSpy = vi
      .spyOn(GitSourceService.getInstance(), 'list')
      .mockReturnValue([{ stack_name: 'web' } as PublicGitSource]);

    const first = await request(app).get('/api/stacks/statuses').set('Cookie', authCookie);
    expect(first.body['web.yml'].source).toBe('git');
    expect(first.body['db.yml'].source).toBe('local');

    // The source label is part of the cached payload: the second request is a
    // cache hit and does not re-scan the git-source table. Link/unlink keep
    // the label fresh by invalidating the cache (git-source routes).
    const second = await request(app).get('/api/stacks/statuses').set('Cookie', authCookie);
    expect(second.body['web.yml'].source).toBe('git');
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(mockGetBulkStackStatuses).toHaveBeenCalledTimes(1);

    listSpy.mockRestore();
  });

  it('resolves self-stack identity on cache miss only and serves hits from the cached payload', async () => {
    mockGetStacks.mockResolvedValue(['sencho.yml', 'web.yml']);
    mockGetBulkStackStatuses.mockResolvedValue({
      sencho: { status: 'running' },
      web: { status: 'running' },
    });

    const first = await request(app).get('/api/stacks/statuses').set('Cookie', authCookie);
    const second = await request(app).get('/api/stacks/statuses').set('Cookie', authCookie);

    // Identity resolves once per computed fetch; the second request is a
    // cache hit and inherits the enriched isSelf flags.
    expect(identitySpy).toHaveBeenCalledTimes(1);
    for (const res of [first, second]) {
      expect(res.body['sencho.yml'].isSelf).toBe(true);
      expect(res.body['web.yml'].isSelf).toBe(false);
    }
  });

  it('reflects a Git link on the next statuses request without waiting for the TTL', async () => {
    mockGetStacks.mockResolvedValue(['web']);
    mockGetBulkStackStatuses.mockResolvedValue({ web: { status: 'running' } });
    // Stub upsert so the link does not clone the repository over the network.
    const upsertSpy = vi
      .spyOn(GitSourceService.getInstance(), 'upsert')
      .mockResolvedValue({ stack_name: 'web' } as Awaited<ReturnType<typeof GitSourceService.prototype.upsert>>);

    const before = await request(app).get('/api/stacks/statuses').set('Cookie', authCookie);
    expect(before.body.web.source).toBe('local');

    await request(app)
      .put('/api/stacks/web/git-source')
      .set('Cookie', authCookie)
      .send({
        repo_url: 'https://github.com/example/web.git',
        branch: 'main',
        compose_path: 'compose.yaml',
        auth_type: 'none',
      });
    // The stub skipped persistence; seed the row so the recompute sees it,
    // standing in for what a real upsert would have stored.
    DatabaseService.getInstance().upsertGitSource({
      stack_name: 'web',
      repo_url: 'https://github.com/example/web.git',
      branch: 'main',
      compose_path: 'compose.yaml',
      compose_paths: ['compose.yaml'],
      context_dir: null,
      sync_env: false,
      env_path: null,
      auth_type: 'none',
      encrypted_token: null, encrypted_deploy_key: null, ssh_known_hosts_entry: null, ssh_host_key_fingerprint: null,
            encrypted_ca_bundle: null,
      auto_apply_on_webhook: false,
      auto_deploy_on_apply: false,
      last_applied_commit_sha: null,
      last_applied_content_hash: null,
      pending_commit_sha: null,
      pending_compose_content: null,
      pending_env_content: null,
      pending_fetched_at: null,
      last_debounce_at: null,
    });

    // Linking invalidated the statuses cache, so the next request recomputes
    // with the fresh label instead of serving the stale cached 'local'.
    const after = await request(app).get('/api/stacks/statuses').set('Cookie', authCookie);
    expect(after.body.web.source).toBe('git');
    expect(mockGetBulkStackStatuses).toHaveBeenCalledTimes(2);

    upsertSpy.mockRestore();
  });

  it('skips identity resolution entirely when the node has no stacks', async () => {
    mockGetStacks.mockResolvedValue([]);
    mockGetBulkStackStatuses.mockResolvedValue({});

    const res = await request(app).get('/api/stacks/statuses').set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect(identitySpy).not.toHaveBeenCalled();
  });

  it('serves 200 with isSelf false everywhere when identity resolution degrades, and does not cache the degraded payload', async () => {
    mockGetStacks.mockResolvedValue(['web.yml', 'db.yml']);
    mockGetBulkStackStatuses.mockResolvedValue({
      web: { status: 'running' },
      db: { status: 'running' },
    });
    identitySpy.mockResolvedValue({ projectName: null, labels: null, degraded: true });

    const first = await request(app).get('/api/stacks/statuses').set('Cookie', authCookie);

    expect(first.status).toBe(200);
    expect(first.body['web.yml'].isSelf).toBe(false);
    expect(first.body['db.yml'].isSelf).toBe(false);

    // A degraded resolution reports every stack as not-self, which would
    // un-gate destructive UI affordances on the Sencho stack itself, so it
    // must not persist: the next request recomputes and re-resolves instead
    // of serving a cached isSelf: false for a full TTL.
    const second = await request(app).get('/api/stacks/statuses').set('Cookie', authCookie);
    expect(second.status).toBe(200);
    expect(identitySpy).toHaveBeenCalledTimes(2);
    expect(mockGetBulkStackStatuses).toHaveBeenCalledTimes(2);
  });

  it('falls back to local labels (200, not 500) when the git-source lookup throws, and does not cache the fallback', async () => {
    mockGetStacks.mockResolvedValue(['web.yml']);
    mockGetBulkStackStatuses.mockResolvedValue({ web: { status: 'running' } });
    // The default healthy identity keeps the git-source scan as the only
    // degradation source.
    const listSpy = vi
      .spyOn(GitSourceService.getInstance(), 'list')
      .mockImplementation(() => { throw new Error('db locked'); });

    const first = await request(app).get('/api/stacks/statuses').set('Cookie', authCookie);
    expect(first.status).toBe(200);
    expect(first.body['web.yml'].source).toBe('local');

    // The 'local' fallback must not persist: the next request recomputes and
    // re-reads the git sources instead of serving the mislabel for a full TTL.
    const second = await request(app).get('/api/stacks/statuses').set('Cookie', authCookie);
    expect(second.status).toBe(200);
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(mockGetBulkStackStatuses).toHaveBeenCalledTimes(2);

    listSpy.mockRestore();
  });
});

// ── /api/system/cache-stats ────────────────────────────────────────────

describe('GET /api/system/cache-stats', () => {
  it('requires admin auth', async () => {
    const res = await request(app).get('/api/system/cache-stats');
    expect(res.status).toBe(401);
  });

  it('returns per-namespace hit/miss/stale counters', async () => {
    // Generate some cache traffic first.
    await request(app).get('/api/stats').set('Cookie', authCookie); // miss
    await request(app).get('/api/stats').set('Cookie', authCookie); // hit
    await request(app).get('/api/system/stats').set('Cookie', authCookie); // miss

    const res = await request(app).get('/api/system/cache-stats').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.stats).toBeDefined();
    expect(res.body.stats.hits).toBeGreaterThanOrEqual(1);
    expect(res.body.stats.misses).toBeGreaterThanOrEqual(1);
    expect(res.body['system-stats']).toBeDefined();
  });
});
