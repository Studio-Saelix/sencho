/**
 * Tests for the fleet-wide Docker prune endpoint. Covers auth, tier gating,
 * input validation, local node orchestration with mocked DockerController,
 * remote-node fan-out with mocked fetch, lock contention, and partial failures.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let DockerController: typeof import('../services/DockerController').default;
let FileSystemService: typeof import('../services/FileSystemService').FileSystemService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let activeBulkActions: typeof import('../routes/labels').activeBulkActions;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ LicenseService } = await import('../services/LicenseService'));
  ({ default: DockerController } = await import('../services/DockerController'));
  ({ FileSystemService } = await import('../services/FileSystemService'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ activeBulkActions } = await import('../routes/labels'));
  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
  authHeader = `Bearer ${token}`;
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => {
  vi.restoreAllMocks();
  activeBulkActions.clear();
});

function mockTier(tier: 'paid' | 'community') {
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue(tier);
}

function mockLocalPrune(opts: { managedBytes?: Partial<Record<string, number>>; allBytes?: Partial<Record<string, number>>; throwOn?: string } = {}) {
  const fake = {
    pruneManagedOnly: vi.fn(async (target: string) => {
      if (opts.throwOn === target) throw new Error(`mock pruneManagedOnly threw for ${target}`);
      return { success: true, reclaimedBytes: opts.managedBytes?.[target] ?? 0 };
    }),
    pruneSystem: vi.fn(async (target: string) => {
      if (opts.throwOn === target) throw new Error(`mock pruneSystem threw for ${target}`);
      return { success: true, reclaimedBytes: opts.allBytes?.[target] ?? 0 };
    }),
  };
  vi.spyOn(DockerController, 'getInstance').mockReturnValue(fake as unknown as ReturnType<typeof DockerController.getInstance>);
  // Spy on the prototype so the mock applies to whichever FileSystemService
  // instance the route creates for the local node id, not a throwaway one.
  vi.spyOn(FileSystemService.prototype, 'getStacks').mockResolvedValue(['stack-a', 'stack-b']);
  return fake;
}

describe('POST /api/fleet/labels/fleet-prune', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/fleet/labels/fleet-prune')
      .send({ targets: ['images'], scope: 'managed' });
    expect(res.status).toBe(401);
  });

  it('is reachable on community tier for admins (no PAID_REQUIRED)', async () => {
    mockTier('community');
    mockLocalPrune({ managedBytes: { images: 128 } });
    const res = await request(app)
      .post('/api/fleet/labels/fleet-prune')
      .set('Authorization', authHeader)
      .send({ targets: ['images'], scope: 'managed' });
    expect(res.status).toBe(200);
    expect(res.body.code).not.toBe('PAID_REQUIRED');
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  it('returns 400 when body is missing', async () => {
    const res = await request(app)
      .post('/api/fleet/labels/fleet-prune')
      .set('Authorization', authHeader)
      .send();
    expect(res.status).toBe(400);
  });

  it('returns 400 when targets is empty', async () => {
    const res = await request(app)
      .post('/api/fleet/labels/fleet-prune')
      .set('Authorization', authHeader)
      .send({ targets: [], scope: 'managed' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-empty/);
  });

  it('returns 400 when a target is unrecognized', async () => {
    const res = await request(app)
      .post('/api/fleet/labels/fleet-prune')
      .set('Authorization', authHeader)
      .send({ targets: ['images', 'containers'], scope: 'managed' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid target/);
  });

  it('runs pruneManagedOnly per target on the local node and returns aggregated bytes', async () => {
    const fake = mockLocalPrune({ managedBytes: { images: 1500, volumes: 320 } });
    const res = await request(app)
      .post('/api/fleet/labels/fleet-prune')
      .set('Authorization', authHeader)
      .send({ targets: ['images', 'volumes'], scope: 'managed' });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    const node = res.body.results[0];
    expect(node.reachable).toBe(true);
    expect(node.targets).toEqual([
      { target: 'images', success: true, reclaimedBytes: 1500 },
      { target: 'volumes', success: true, reclaimedBytes: 320 },
    ]);
    expect(fake.pruneManagedOnly).toHaveBeenCalledTimes(2);
    expect(fake.pruneSystem).not.toHaveBeenCalled();
  });

  it('runs pruneSystem when scope is "all" and dedupes targets', async () => {
    const fake = mockLocalPrune({ allBytes: { networks: 0, images: 2048 } });
    const res = await request(app)
      .post('/api/fleet/labels/fleet-prune')
      .set('Authorization', authHeader)
      .send({ targets: ['images', 'networks', 'images'], scope: 'all' });
    expect(res.status).toBe(200);
    expect(fake.pruneManagedOnly).not.toHaveBeenCalled();
    expect(fake.pruneSystem).toHaveBeenCalledTimes(2);
    const node = res.body.results[0];
    expect(node.targets.map((t: { target: string }) => t.target).sort()).toEqual(['images', 'networks']);
  });

  it('records per-target failure when DockerController throws but continues remaining targets', async () => {
    mockLocalPrune({ managedBytes: { images: 100 }, throwOn: 'volumes' });
    const res = await request(app)
      .post('/api/fleet/labels/fleet-prune')
      .set('Authorization', authHeader)
      .send({ targets: ['images', 'volumes'], scope: 'managed' });
    expect(res.status).toBe(200);
    const node = res.body.results[0];
    expect(node.targets.find((t: { target: string }) => t.target === 'images').success).toBe(true);
    const volumes = node.targets.find((t: { target: string }) => t.target === 'volumes');
    expect(volumes.success).toBe(false);
    expect(volumes.reclaimedBytes).toBe(0);
    expect(volumes.error).toMatch(/pruneManagedOnly threw/);
  });

  it('reports lock contention when bulk-prune lock is already held', async () => {
    mockLocalPrune();
    const db = DatabaseService.getInstance();
    const localId = db.getNodes().find(n => n.type === 'local')!.id;
    activeBulkActions.add(`bulk-prune:${localId}`);
    const res = await request(app)
      .post('/api/fleet/labels/fleet-prune')
      .set('Authorization', authHeader)
      .send({ targets: ['images'], scope: 'managed' });
    expect(res.status).toBe(200);
    const node = res.body.results.find((n: { nodeId: number }) => n.nodeId === localId);
    expect(node.targets[0].success).toBe(false);
    expect(node.targets[0].error).toMatch(/already running/);
  });

  it('marks a remote node unreachable when fetch throws and short-circuits later targets', async () => {
    mockLocalPrune();
    const db = DatabaseService.getInstance();
    const remoteId = db.addNode({
      name: 'remote-test',
      type: 'remote',
      api_url: 'http://remote.example:1852',
      api_token: 'tok',
      compose_dir: '/app/compose',
      is_default: false,
    });
    try {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
      const res = await request(app)
        .post('/api/fleet/labels/fleet-prune')
        .set('Authorization', authHeader)
        .send({ targets: ['images', 'volumes', 'networks'], scope: 'managed' });
      expect(res.status).toBe(200);
      const remote = res.body.results.find((n: { nodeId: number }) => n.nodeId === remoteId);
      expect(remote.reachable).toBe(false);
      expect(remote.error).toMatch(/ECONNREFUSED/);
      expect(remote.targets).toHaveLength(3);
      for (const t of remote.targets) expect(t.success).toBe(false);
      // Only the first target attempts the fetch; the rest short-circuit.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      db.deleteNode(remoteId);
    }
  });

  it('parses remote node responses into per-target reclaimed bytes', async () => {
    mockLocalPrune();
    const db = DatabaseService.getInstance();
    const remoteId = db.addNode({
      name: 'remote-ok',
      type: 'remote',
      api_url: 'http://remote-ok.example:1852/',
      api_token: 'tok',
      compose_dir: '/app/compose',
      is_default: false,
    });
    try {
      const responses = new Map<string, number>([['images', 4096], ['volumes', 512]]);
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const body = JSON.parse((init?.body as string) ?? '{}') as { target: string };
        const reclaimedBytes = responses.get(body.target) ?? 0;
        return new Response(JSON.stringify({ message: 'ok', success: true, reclaimedBytes }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      });
      const res = await request(app)
        .post('/api/fleet/labels/fleet-prune')
        .set('Authorization', authHeader)
        .send({ targets: ['images', 'volumes'], scope: 'all' });
      expect(res.status).toBe(200);
      const remote = res.body.results.find((n: { nodeId: number }) => n.nodeId === remoteId);
      expect(remote.reachable).toBe(true);
      expect(remote.targets).toEqual([
        { target: 'images', success: true, reclaimedBytes: 4096 },
        { target: 'volumes', success: true, reclaimedBytes: 512 },
      ]);
    } finally {
      db.deleteNode(remoteId);
    }
  });
});
