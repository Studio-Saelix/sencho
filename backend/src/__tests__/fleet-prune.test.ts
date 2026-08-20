import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { cleanupTestDb, setupTestDb, TEST_JWT_SECRET, TEST_USERNAME } from './helpers/setupTestDb';
import type { PruneItemOutcome, PrunePlan, PrunePlanItem } from '../services/prunePlan';
import { CacheService } from '../services/CacheService';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let DockerController: typeof import('../services/DockerController').default;
let FileSystemService: typeof import('../services/FileSystemService').FileSystemService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let activeBulkActions: typeof import('../routes/labels').activeBulkActions;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ default: DockerController } = await import('../services/DockerController'));
  ({ FileSystemService } = await import('../services/FileSystemService'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ activeBulkActions } = await import('../routes/labels'));
  authHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '10m' })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => {
  vi.restoreAllMocks();
  activeBulkActions.clear();
});

function item(overrides: Partial<PrunePlanItem> = {}): PrunePlanItem {
  return {
    target: 'images',
    id: 'sha256:image',
    name: 'example/app:latest',
    sizeBytes: 256,
    managed: true,
    reason: 'Image is not used by any container',
    stackName: 'app',
    image: { references: ['example/app:latest'] },
    ...overrides,
  } as PrunePlanItem;
}

function plan(nodeId: number, fingerprint = `fingerprint-${nodeId}`, items: PrunePlanItem[] = [item()]): PrunePlan {
  return {
    nodeId,
    scope: 'managed',
    targets: ['images'],
    items,
    reclaimableBytes: items.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0),
    fingerprint,
    createdAt: 1,
  };
}

function mockLocal(planFactory: (nodeId: number) => PrunePlan = (nodeId) => plan(nodeId)) {
  const fake = {
    buildPrunePlan: vi.fn(async (_targets, _scope, _stacks, nodeId: number) => planFactory(nodeId)),
    executePrunePlan: vi.fn(async (reviewedPlan: PrunePlan): Promise<{
      success: boolean;
      reclaimedBytes: number;
      outcomes: PruneItemOutcome[];
      mutated: boolean;
    }> => ({
      success: true,
      reclaimedBytes: reviewedPlan.reclaimableBytes,
      mutated: reviewedPlan.items.length > 0,
      outcomes: reviewedPlan.items.map((entry) => ({
        id: entry.id,
        target: entry.target,
        status: 'removed' as const,
        sizeBytes: entry.sizeBytes,
      })),
    })),
  };
  vi.spyOn(DockerController, 'getInstance').mockReturnValue(fake as unknown as ReturnType<typeof DockerController.getInstance>);
  vi.spyOn(FileSystemService.prototype, 'getStacks').mockResolvedValue(['app']);
  return fake;
}

function localReview(fingerprint: string) {
  const local = DatabaseService.getInstance().getNodes().find((node) => node.type === 'local')!;
  return {
    local,
    body: {
      targets: ['images'],
      scope: 'managed',
      dryRun: false,
      reviewedNodes: [{ nodeId: local.id, reachable: true }],
      plans: [{ nodeId: local.id, fingerprint }],
    },
  };
}

function addRemote(name: string): number {
  return DatabaseService.getInstance().addNode({
    name,
    type: 'remote',
    api_url: `http://${name}.example:1852`,
    api_token: 'token',
    compose_dir: '/app/compose',
    is_default: false,
  });
}

describe('POST /api/fleet/labels/fleet-prune', () => {
  it('requires authentication and validates the request', async () => {
    expect((await request(app).post('/api/fleet/labels/fleet-prune').send({})).status).toBe(401);
    const invalid = await request(app)
      .post('/api/fleet/labels/fleet-prune')
      .set('Authorization', authHeader)
      .send({ targets: ['containers'], dryRun: true });
    expect(invalid.status).toBe(400);
    for (const scope of [undefined, 'everything', 1]) {
      const response = await request(app)
        .post('/api/fleet/labels/fleet-prune')
        .set('Authorization', authHeader)
        .send({ targets: ['images'], scope, dryRun: true });
      expect(response.status).toBe(400);
    }
  });

  it('rejects malformed remote plan contracts', async () => {
    mockLocal();
    const remoteId = addRemote('remote-malformed-plan');
    const base = plan(remoteId);
    const malformedPlans = [
      { ...base, targets: ['images', 'images'] },
      { ...base, items: [item(), item()], reclaimableBytes: 512 },
      { ...base, reclaimableBytes: -1 },
      { ...base, nodeId: 'remote' },
      { ...base, createdAt: Number.NaN },
    ];
    try {
      for (const malformed of malformedPlans) {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(malformed), { status: 200 }));
        const response = await request(app)
          .post('/api/fleet/labels/fleet-prune')
          .set('Authorization', authHeader)
          .send({ targets: ['images', 'volumes'], scope: 'managed', dryRun: true });
        const remote = response.body.results.find((result: { nodeId: number }) => result.nodeId === remoteId);
        expect(remote).toMatchObject({ reachable: true, code: 'REMOTE_PLAN_INVALID' });
        expect(remote.fingerprint).toBeUndefined();
        vi.restoreAllMocks();
        mockLocal();
      }
    } finally {
      DatabaseService.getInstance().deleteNode(remoteId);
    }
  });

  it('returns itemized dry-run plans without taking the destructive lock', async () => {
    const fake = mockLocal();
    const response = await request(app)
      .post('/api/fleet/labels/fleet-prune')
      .set('Authorization', authHeader)
      .send({ targets: ['images'], scope: 'managed', dryRun: true });

    expect(response.status).toBe(200);
    expect(response.body.results[0]).toMatchObject({
      reachable: true,
      fingerprint: expect.stringMatching(/^fingerprint-/),
      reclaimableBytes: 256,
      items: [expect.objectContaining({ name: 'example/app:latest', managed: true, stackName: 'app' })],
      targets: [{ target: 'images', success: true, reclaimedBytes: 256, dryRun: true }],
    });
    expect(fake.executePrunePlan).not.toHaveBeenCalled();
    expect(activeBulkActions.size).toBe(0);
  });

  it('loads known stacks for All unused attribution', async () => {
    mockLocal();
    const stackSpy = vi.spyOn(FileSystemService.prototype, 'getStacks');
    await request(app)
      .post('/api/fleet/labels/fleet-prune')
      .set('Authorization', authHeader)
      .send({ targets: ['images'], scope: 'all', dryRun: true });
    expect(stackSpy).toHaveBeenCalled();
  });

  it('rejects missing, duplicate, and malformed reviewed entries', async () => {
    mockLocal();
    const { local } = localReview(`fingerprint-${DatabaseService.getInstance().getNodes()[0].id}`);
    const cases = [
      { reviewedNodes: [{ nodeId: local.id, reachable: true }], plans: [] },
      { reviewedNodes: [{ nodeId: local.id, reachable: true }, { nodeId: local.id, reachable: true }], plans: [] },
      { reviewedNodes: [{ nodeId: local.id, reachable: true }], plans: [{ nodeId: local.id, fingerprint: '' }] },
    ];
    for (const testCase of cases) {
      const response = await request(app)
        .post('/api/fleet/labels/fleet-prune')
        .set('Authorization', authHeader)
        .send({ targets: ['images'], scope: 'managed', dryRun: false, ...testCase });
      expect([400, 409]).toContain(response.status);
    }
  });

  it('executes a valid empty plan and releases the lock', async () => {
    const fake = mockLocal((nodeId) => plan(nodeId, `empty-${nodeId}`, []));
    const local = DatabaseService.getInstance().getNodes().find((node) => node.type === 'local')!;
    const response = await request(app)
      .post('/api/fleet/labels/fleet-prune')
      .set('Authorization', authHeader)
      .send({
        targets: ['images'], scope: 'managed', dryRun: false,
        reviewedNodes: [{ nodeId: local.id, reachable: true }],
        plans: [{ nodeId: local.id, fingerprint: `empty-${local.id}` }],
      });
    expect(response.status).toBe(200);
    expect(fake.executePrunePlan).toHaveBeenCalledTimes(1);
    expect(response.body.results[0].outcomes).toEqual([]);
    expect(activeBulkActions.size).toBe(0);
  });

  it('invalidates local node caches when a failed image outcome is mutated', async () => {
    const fake = mockLocal();
    fake.executePrunePlan.mockResolvedValue({
      success: false,
      reclaimedBytes: 0,
      mutated: true,
      outcomes: [{ target: 'images', id: 'sha256:image', status: 'failed', error: 'tags remain' }],
    });
    const invalidate = vi.spyOn(CacheService.getInstance(), 'invalidate');
    const local = DatabaseService.getInstance().getNodes().find((node) => node.type === 'local')!;
    const response = await request(app)
      .post('/api/fleet/labels/fleet-prune')
      .set('Authorization', authHeader)
      .send({
        targets: ['images'], scope: 'managed', dryRun: false,
        reviewedNodes: [{ nodeId: local.id, reachable: true }],
        plans: [{ nodeId: local.id, fingerprint: `fingerprint-${local.id}` }],
      });
    expect(response.status).toBe(200);
    expect(response.body.results[0].outcomes[0].status).toBe('failed');
    expect(invalidate).toHaveBeenCalledWith(`stats:${local.id}`);
    expect(invalidate).toHaveBeenCalledWith(`stack-statuses:${local.id}`);
  });

  it('fails closed when a local prune lock is active', async () => {
    const fake = mockLocal();
    const { local, body } = localReview(`fingerprint-${DatabaseService.getInstance().getNodes()[0].id}`);
    const remoteId = addRemote('remote-lock-check');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const lockKey = `bulk-prune:${local.id}`;
    activeBulkActions.add(lockKey);
    try {
      const response = await request(app)
        .post('/api/fleet/labels/fleet-prune')
        .set('Authorization', authHeader)
        .send({
          ...body,
          reviewedNodes: [...body.reviewedNodes, { nodeId: remoteId, reachable: true }],
          plans: [...body.plans, { nodeId: remoteId, fingerprint: 'remote-plan' }],
        });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('PRUNE_ALREADY_RUNNING');
      expect(fake.buildPrunePlan).not.toHaveBeenCalled();
      expect(fake.executePrunePlan).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(activeBulkActions.has(lockKey)).toBe(true);
    } finally {
      activeBulkActions.delete(lockKey);
      DatabaseService.getInstance().deleteNode(remoteId);
    }
  });

  it('returns a node failure when local execution setup fails after preflight', async () => {
    const fake = mockLocal();
    vi.spyOn(FileSystemService.prototype, 'getStacks')
      .mockResolvedValueOnce(['app'])
      .mockRejectedValueOnce(new Error('stack inventory unavailable'));
    const { body } = localReview(`fingerprint-${DatabaseService.getInstance().getNodes()[0].id}`);
    const response = await request(app)
      .post('/api/fleet/labels/fleet-prune')
      .set('Authorization', authHeader)
      .send(body);

    expect(response.status).toBe(200);
    expect(response.body.results[0]).toMatchObject({
      code: 'PRUNE_EXECUTE_FAILED',
      error: 'stack inventory unavailable',
      targets: [{ success: false }],
    });
    expect(fake.executePrunePlan).not.toHaveBeenCalled();
  });

  it('prevents every destructive call when one node plan is stale', async () => {
    const fake = mockLocal();
    const remoteId = addRemote('remote-stale');
    try {
      const local = DatabaseService.getInstance().getNodes().find((node) => node.type === 'local')!;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
        JSON.stringify(plan(99, 'remote-new')),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
      const response = await request(app)
        .post('/api/fleet/labels/fleet-prune')
        .set('Authorization', authHeader)
        .send({
          targets: ['images'], scope: 'managed', dryRun: false,
          reviewedNodes: [{ nodeId: local.id, reachable: true }, { nodeId: remoteId, reachable: true }],
          plans: [
            { nodeId: local.id, fingerprint: `fingerprint-${local.id}` },
            { nodeId: remoteId, fingerprint: 'remote-old' },
          ],
        });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('PRUNE_PLAN_STALE');
      expect(fake.executePrunePlan).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/system/prune/plan');
    } finally {
      DatabaseService.getInstance().deleteNode(remoteId);
    }
  });

  it('rejects a reviewed-unreachable node that becomes reachable', async () => {
    const fake = mockLocal();
    const remoteId = addRemote('remote-newly-reachable');
    try {
      const local = DatabaseService.getInstance().getNodes().find((node) => node.type === 'local')!;
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(plan(99)), { status: 200 }));
      const response = await request(app)
        .post('/api/fleet/labels/fleet-prune')
        .set('Authorization', authHeader)
        .send({
          targets: ['images'], scope: 'managed', dryRun: false,
          reviewedNodes: [{ nodeId: local.id, reachable: true }, { nodeId: remoteId, reachable: false }],
          plans: [{ nodeId: local.id, fingerprint: `fingerprint-${local.id}` }],
        });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('PRUNE_NODE_REACHABILITY_CHANGED');
      expect(fake.executePrunePlan).not.toHaveBeenCalled();
    } finally {
      DatabaseService.getInstance().deleteNode(remoteId);
    }
  });

  it('rejects a reviewed-reachable node that becomes unreachable', async () => {
    const fake = mockLocal();
    const remoteId = addRemote('remote-now-offline');
    try {
      const local = DatabaseService.getInstance().getNodes().find((node) => node.type === 'local')!;
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
      const response = await request(app)
        .post('/api/fleet/labels/fleet-prune')
        .set('Authorization', authHeader)
        .send({
          targets: ['images'], scope: 'managed', dryRun: false,
          reviewedNodes: [{ nodeId: local.id, reachable: true }, { nodeId: remoteId, reachable: true }],
          plans: [
            { nodeId: local.id, fingerprint: `fingerprint-${local.id}` },
            { nodeId: remoteId, fingerprint: 'remote-plan' },
          ],
        });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('PRUNE_NODE_REACHABILITY_CHANGED');
      expect(fake.executePrunePlan).not.toHaveBeenCalled();
    } finally {
      DatabaseService.getInstance().deleteNode(remoteId);
    }
  });

  it('rejects a changed configured-node roster before preflight', async () => {
    const fake = mockLocal();
    const remoteId = addRemote('remote-added-after-review');
    try {
      const local = DatabaseService.getInstance().getNodes().find((node) => node.type === 'local')!;
      const response = await request(app)
        .post('/api/fleet/labels/fleet-prune')
        .set('Authorization', authHeader)
        .send({
          targets: ['images'], scope: 'managed', dryRun: false,
          reviewedNodes: [{ nodeId: local.id, reachable: true }],
          plans: [{ nodeId: local.id, fingerprint: `fingerprint-${local.id}` }],
        });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('PRUNE_NODE_ROSTER_CHANGED');
      expect(fake.buildPrunePlan).not.toHaveBeenCalled();
      expect(fake.executePrunePlan).not.toHaveBeenCalled();
    } finally {
      DatabaseService.getInstance().deleteNode(remoteId);
    }
  });

  it('rejects a present but incomplete remote outcome list', async () => {
    const fake = mockLocal();
    const remoteId = addRemote('remote-bad-outcomes');
    try {
      const local = DatabaseService.getInstance().getNodes().find((node) => node.type === 'local')!;
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(plan(remoteId, 'remote-reviewed')), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          success: true,
          reclaimedBytes: 256,
          outcomes: [],
        }), { status: 200 }));
      const response = await request(app)
        .post('/api/fleet/labels/fleet-prune')
        .set('Authorization', authHeader)
        .send({
          targets: ['images'], scope: 'managed', dryRun: false,
          reviewedNodes: [{ nodeId: local.id, reachable: true }, { nodeId: remoteId, reachable: true }],
          plans: [
            { nodeId: local.id, fingerprint: `fingerprint-${local.id}` },
            { nodeId: remoteId, fingerprint: 'remote-reviewed' },
          ],
        });

      expect(response.status).toBe(200);
      expect(fake.executePrunePlan).toHaveBeenCalledTimes(1);
      expect(response.body.results.find((result: { nodeId: number }) => result.nodeId === remoteId)).toMatchObject({
        code: 'REMOTE_PRUNE_INVALID',
        error: 'Remote returned malformed or incomplete prune outcomes',
      });
    } finally {
      DatabaseService.getInstance().deleteNode(remoteId);
    }
  });

  it('rejects malformed numeric and success fields in remote execute results', async () => {
    mockLocal();
    const remoteId = addRemote('remote-bad-result-fields');
    const local = DatabaseService.getInstance().getNodes().find((node) => node.type === 'local')!;
    const remotePlan = plan(remoteId, 'remote-fields');
    const malformedResults = [
      { success: 'yes', reclaimedBytes: 256 },
      { success: true, reclaimedBytes: -1 },
      {
        success: true, reclaimedBytes: 0,
        outcomes: [{ target: 'images', id: 'sha256:image', status: 'removed', sizeBytes: -1 }],
      },
    ];
    try {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      for (const malformed of malformedResults) {
        fetchSpy
          .mockResolvedValueOnce(new Response(JSON.stringify(remotePlan), { status: 200 }))
          .mockResolvedValueOnce(new Response(JSON.stringify(malformed), { status: 200 }));
        const response = await request(app)
          .post('/api/fleet/labels/fleet-prune')
          .set('Authorization', authHeader)
          .send({
            targets: ['images'], scope: 'managed', dryRun: false,
            reviewedNodes: [{ nodeId: local.id, reachable: true }, { nodeId: remoteId, reachable: true }],
            plans: [{ nodeId: local.id, fingerprint: `fingerprint-${local.id}` }, { nodeId: remoteId, fingerprint: 'remote-fields' }],
          });
        expect(response.body.results.find((result: { nodeId: number }) => result.nodeId === remoteId)).toMatchObject({
          code: 'REMOTE_PRUNE_INVALID',
        });
      }
    } finally {
      DatabaseService.getInstance().deleteNode(remoteId);
    }
  });

  it('projects mixed local outcomes and accepts a legacy remote total', async () => {
    const items = [
      item({ id: 'removed', sizeBytes: 100 }),
      item({ id: 'skipped', sizeBytes: 200 }),
      item({ id: 'failed', sizeBytes: 300 }),
    ];
    const fake = mockLocal((nodeId) => plan(nodeId, `mixed-${nodeId}`, items));
    fake.executePrunePlan.mockResolvedValue({
      success: false,
      reclaimedBytes: 100,
      mutated: true,
      outcomes: [
        { target: 'images', id: 'removed', status: 'removed', sizeBytes: 100 },
        { target: 'images', id: 'skipped', status: 'skipped', reason: 'became active' },
        { target: 'images', id: 'failed', status: 'failed', error: 'remove failed' },
      ],
    });
    const remoteId = addRemote('remote-legacy-total');
    const remotePlan = plan(remoteId, 'legacy-plan', []);
    try {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(remotePlan), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, reclaimedBytes: 999 }), { status: 200 }));
      const local = DatabaseService.getInstance().getNodes().find((node) => node.type === 'local')!;
      const response = await request(app)
        .post('/api/fleet/labels/fleet-prune')
        .set('Authorization', authHeader)
        .send({
          targets: ['images'], scope: 'managed', dryRun: false,
          reviewedNodes: [{ nodeId: local.id, reachable: true }, { nodeId: remoteId, reachable: true }],
          plans: [{ nodeId: local.id, fingerprint: `mixed-${local.id}` }, { nodeId: remoteId, fingerprint: 'legacy-plan' }],
        });
      const localResult = response.body.results.find((result: { nodeId: number }) => result.nodeId === local.id);
      expect(localResult.targets[0]).toMatchObject({
        success: false, reclaimedBytes: 100, removed: 1, skipped: 1, failed: 1,
      });
      const remoteResult = response.body.results.find((result: { nodeId: number }) => result.nodeId === remoteId);
      expect(remoteResult.reclaimedBytes).toBe(999);
      expect(remoteResult.outcomes).toBeUndefined();
      expect(remoteResult.targets[0]).toMatchObject({ success: true, reclaimedBytes: 0 });
    } finally {
      DatabaseService.getInstance().deleteNode(remoteId);
    }
  });
});
