/**
 * Tests for the Fleet Action card preview / estimate endpoints and the dry-run
 * flag added to the existing fleet-stop / fleet-prune routes.
 *
 * Covers:
 *   - POST /api/fleet/labels/match-preview (new): auth, tier, validation, real return shape.
 *   - POST /api/fleet/prune/estimate (new): auth, tier, validation, local + remote fan-out.
 *   - POST /api/fleet/labels/fleet-stop with dryRun: true: rehearses without invoking the destructive leaf.
 *   - POST /api/fleet/labels/fleet-prune with dryRun: true: rehearses without invoking pruneManagedOnly / pruneSystem.
 */
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let mockFsStacks: string[] = [];
const pruneManagedOnly = vi.fn();
const pruneSystem = vi.fn();
const estimateManagedReclaim = vi.fn();
const estimateSystemReclaim = vi.fn();
const getContainersByStack = vi.fn();
const stopContainer = vi.fn();
const restartContainer = vi.fn();
const invalidateNodeCaches = vi.fn();

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: vi.fn(() => ({
      getStacks: vi.fn(async () => mockFsStacks),
    })),
  },
}));

vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: vi.fn(() => ({
      pruneManagedOnly,
      pruneSystem,
      estimateManagedReclaim,
      estimateSystemReclaim,
      getContainersByStack,
      stopContainer,
      restartContainer,
    })),
  },
}));

vi.mock('../helpers/cacheInvalidation', () => ({
  invalidateNodeCaches,
}));

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let db: import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let activeBulkActions: typeof import('../routes/labels').activeBulkActions;
let labelCounter = 0;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ LicenseService } = await import('../services/LicenseService'));
  ({ activeBulkActions } = await import('../routes/labels'));
  const { DatabaseService } = await import('../services/DatabaseService');
  db = DatabaseService.getInstance();
  authHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  // restoreAllMocks resets spies but leaves call history on module-top vi.fn()
  // mocks intact; clearAllMocks zeroes that history so per-test call counts are
  // not polluted by earlier tests.
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  mockFsStacks = ['alpha', 'beta'];
  pruneManagedOnly.mockResolvedValue({ success: true, reclaimedBytes: 0 });
  pruneSystem.mockResolvedValue({ success: true, reclaimedBytes: 0 });
  estimateManagedReclaim.mockResolvedValue({ reclaimableBytes: 0 });
  estimateSystemReclaim.mockResolvedValue({ reclaimableBytes: 0 });
  getContainersByStack.mockResolvedValue([{ Id: 'container-1' }]);
  stopContainer.mockResolvedValue(undefined);
  restartContainer.mockResolvedValue(undefined);
  activeBulkActions.clear();
  db.getDb().prepare('DELETE FROM stack_label_assignments').run();
  db.getDb().prepare('DELETE FROM stack_labels').run();
});

async function createAssignedLabel(name: string, stacks: string[]) {
  const created = await request(app)
    .post('/api/labels')
    .set('Authorization', authHeader)
    .send({ name: `${name}-${++labelCounter}`, color: 'teal' });
  expect(created.status).toBe(201);

  for (const stack of stacks) {
    const assigned = await request(app)
      .put(`/api/stacks/${stack}/labels`)
      .set('Authorization', authHeader)
      .send({ labelIds: [created.body.id] });
    expect(assigned.status).toBe(200);
  }

  return created.body as { id: number; node_id: number; name: string };
}

describe('POST /api/fleet/labels/match-preview', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/fleet/labels/match-preview')
      .send({ labelName: 'x' });
    expect(res.status).toBe(401);
  });

  it('is reachable on community tier for admins (no PAID_REQUIRED)', async () => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    const res = await request(app)
      .post('/api/fleet/labels/match-preview')
      .set('Authorization', authHeader)
      .send({ labelName: 'does-not-exist' });
    expect(res.status).toBe(200);
    expect(res.body.code).not.toBe('PAID_REQUIRED');
    expect(res.body.matchedNodes).toBe(0);
  });

  it('returns 400 when labelName is missing or empty', async () => {
    const a = await request(app)
      .post('/api/fleet/labels/match-preview')
      .set('Authorization', authHeader)
      .send({});
    expect(a.status).toBe(400);
    const b = await request(app)
      .post('/api/fleet/labels/match-preview')
      .set('Authorization', authHeader)
      .send({ labelName: '   ' });
    expect(b.status).toBe(400);
  });

  it('returns matched counts and per-node stack lists for a real label', async () => {
    const label = await createAssignedLabel('preview', ['alpha', 'beta']);
    const res = await request(app)
      .post('/api/fleet/labels/match-preview')
      .set('Authorization', authHeader)
      .send({ labelName: label.name });
    expect(res.status).toBe(200);
    expect(res.body.matchedNodes).toBe(1);
    expect(res.body.matchedStacks).toBe(2);
    expect(res.body.perNode).toHaveLength(1);
    expect(res.body.perNode[0].stackCount).toBe(2);
    expect(res.body.perNode[0].stackNames.sort()).toEqual(['alpha', 'beta']);
  });

  it('returns zero counts for an unknown label without erroring', async () => {
    const res = await request(app)
      .post('/api/fleet/labels/match-preview')
      .set('Authorization', authHeader)
      .send({ labelName: 'does-not-exist' });
    expect(res.status).toBe(200);
    expect(res.body.matchedNodes).toBe(0);
    expect(res.body.matchedStacks).toBe(0);
  });
});

describe('POST /api/fleet/prune/estimate', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/fleet/prune/estimate')
      .send({ targets: ['images'], scope: 'managed' });
    expect(res.status).toBe(401);
  });

  it('is reachable on community tier for admins (no PAID_REQUIRED)', async () => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    const res = await request(app)
      .post('/api/fleet/prune/estimate')
      .set('Authorization', authHeader)
      .send({ targets: ['images'], scope: 'managed' });
    expect(res.status).toBe(200);
    expect(res.body.code).not.toBe('PAID_REQUIRED');
    expect(res.body).toHaveProperty('totalBytes');
  });

  it('returns 400 when targets is empty', async () => {
    const res = await request(app)
      .post('/api/fleet/prune/estimate')
      .set('Authorization', authHeader)
      .send({ targets: [], scope: 'managed' });
    expect(res.status).toBe(400);
  });

  it('aggregates per-node reclaimable bytes from estimateManagedReclaim on the local node', async () => {
    estimateManagedReclaim.mockImplementation(async (target: string) =>
      ({ reclaimableBytes: target === 'images' ? 4096 : 256 }));
    const res = await request(app)
      .post('/api/fleet/prune/estimate')
      .set('Authorization', authHeader)
      .send({ targets: ['images', 'volumes'], scope: 'managed' });
    expect(res.status).toBe(200);
    expect(res.body.totalBytes).toBe(4096 + 256);
    expect(res.body.perNode).toHaveLength(1);
    expect(res.body.perNode[0].reachable).toBe(true);
    expect(res.body.perNode[0].reclaimableBytes).toBe(4096 + 256);
    expect(pruneManagedOnly).not.toHaveBeenCalled();
    expect(pruneSystem).not.toHaveBeenCalled();
  });

  it('uses estimateSystemReclaim when scope is "all"', async () => {
    estimateSystemReclaim.mockResolvedValue({ reclaimableBytes: 1024 });
    const res = await request(app)
      .post('/api/fleet/prune/estimate')
      .set('Authorization', authHeader)
      .send({ targets: ['images'], scope: 'all' });
    expect(res.status).toBe(200);
    expect(estimateManagedReclaim).not.toHaveBeenCalled();
    expect(estimateSystemReclaim).toHaveBeenCalled();
    expect(res.body.perNode[0].reclaimableBytes).toBe(1024);
  });

  it('marks a remote node unreachable when its estimate endpoint is down', async () => {
    const remoteId = db.addNode({
      name: 'remote-est',
      type: 'remote',
      api_url: 'http://remote-est.example:1852',
      api_token: 'tok',
      compose_dir: '/app/compose',
      is_default: false,
    });
    try {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
      const res = await request(app)
        .post('/api/fleet/prune/estimate')
        .set('Authorization', authHeader)
        .send({ targets: ['images'], scope: 'managed' });
      expect(res.status).toBe(200);
      const remote = res.body.perNode.find((n: { nodeId: number }) => n.nodeId === remoteId);
      expect(remote.reachable).toBe(false);
      expect(remote.error).toMatch(/ECONNREFUSED/);
      expect(remote.reclaimableBytes).toBe(0);
    } finally {
      db.deleteNode(remoteId);
    }
  });
});

describe('POST /api/fleet/labels/fleet-stop with dryRun: true', () => {
  it('marks each stack dryRun: true and does not invoke containerActionForStack', async () => {
    const label = await createAssignedLabel('dry-stop', ['alpha', 'beta']);
    const res = await request(app)
      .post('/api/fleet/labels/fleet-stop')
      .set('Authorization', authHeader)
      .send({ labelName: label.name, dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    const node = res.body.results[0];
    expect(node.matched).toBe(true);
    expect(node.stackResults).toHaveLength(2);
    for (const stack of node.stackResults) {
      expect(stack.success).toBe(true);
      expect(stack.dryRun).toBe(true);
    }
    // containerActionForStack walks DockerController.stopContainer / restartContainer
    // internally; if dry-run incorrectly invoked it, those mocks would record calls.
    expect(stopContainer).not.toHaveBeenCalled();
    expect(restartContainer).not.toHaveBeenCalled();
    // Dry run must not bust caches.
    expect(invalidateNodeCaches).not.toHaveBeenCalled();
  });

  it('still runs the real action when dryRun is omitted', async () => {
    const label = await createAssignedLabel('real-stop', ['alpha']);
    const res = await request(app)
      .post('/api/fleet/labels/fleet-stop')
      .set('Authorization', authHeader)
      .send({ labelName: label.name });
    expect(res.status).toBe(200);
    // The destructive path invokes containerActionForStack, which in turn calls
    // DockerController.stopContainer for each container on the matched stack.
    expect(stopContainer).toHaveBeenCalled();
    // The destructive path should also have invalidated the local node's cache.
    expect(invalidateNodeCaches).toHaveBeenCalled();
  });
});

describe('POST /api/fleet/labels/fleet-prune with dryRun: true', () => {
  it('routes to estimateManagedReclaim and marks each target dryRun: true', async () => {
    estimateManagedReclaim.mockResolvedValue({ reclaimableBytes: 2048 });
    const res = await request(app)
      .post('/api/fleet/labels/fleet-prune')
      .set('Authorization', authHeader)
      .send({ targets: ['images', 'volumes'], scope: 'managed', dryRun: true });
    expect(res.status).toBe(200);
    const node = res.body.results[0];
    expect(node.reachable).toBe(true);
    expect(node.targets).toHaveLength(2);
    for (const t of node.targets) {
      expect(t.success).toBe(true);
      expect(t.reclaimedBytes).toBe(2048);
      expect(t.dryRun).toBe(true);
    }
    expect(pruneManagedOnly).not.toHaveBeenCalled();
    expect(pruneSystem).not.toHaveBeenCalled();
    expect(estimateManagedReclaim).toHaveBeenCalledTimes(2);
    expect(invalidateNodeCaches).not.toHaveBeenCalled();
  });

  it('routes to estimateSystemReclaim when scope is "all"', async () => {
    estimateSystemReclaim.mockResolvedValue({ reclaimableBytes: 8192 });
    const res = await request(app)
      .post('/api/fleet/labels/fleet-prune')
      .set('Authorization', authHeader)
      .send({ targets: ['images'], scope: 'all', dryRun: true });
    expect(res.status).toBe(200);
    expect(estimateManagedReclaim).not.toHaveBeenCalled();
    expect(estimateSystemReclaim).toHaveBeenCalled();
    expect(pruneManagedOnly).not.toHaveBeenCalled();
    expect(pruneSystem).not.toHaveBeenCalled();
    expect(res.body.results[0].targets[0].reclaimedBytes).toBe(8192);
  });

  it('still invokes pruneManagedOnly when dryRun is omitted', async () => {
    pruneManagedOnly.mockResolvedValue({ success: true, reclaimedBytes: 512 });
    const res = await request(app)
      .post('/api/fleet/labels/fleet-prune')
      .set('Authorization', authHeader)
      .send({ targets: ['images'], scope: 'managed' });
    expect(res.status).toBe(200);
    expect(pruneManagedOnly).toHaveBeenCalled();
    expect(estimateManagedReclaim).not.toHaveBeenCalled();
    expect(res.body.results[0].targets[0].dryRun).toBeUndefined();
  });
});
