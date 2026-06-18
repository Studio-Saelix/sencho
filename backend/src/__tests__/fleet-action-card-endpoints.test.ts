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
  // Suggestion tests seed node labels to prove they are excluded; clear them so
  // those rows do not leak into later assertions.
  db.getDb().prepare('DELETE FROM node_labels').run();
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

// Fresh 200 JSON Response per call: the authoritative label summary issues two
// parallel fetches per remote (/api/labels and /api/labels/assignments) and a
// Response body can be read only once.
function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
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

describe('GET /api/fleet/labels/suggestions', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/fleet/labels/suggestions');
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin (viewer) user', async () => {
    const viewerName = `viewer-sugg-${++labelCounter}`;
    db.addUser({ username: viewerName, password_hash: 'x', role: 'viewer' });
    const viewerAuth = `Bearer ${jwt.sign({ username: viewerName }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;
    const res = await request(app)
      .get('/api/fleet/labels/suggestions')
      .set('Authorization', viewerAuth);
    expect(res.status).toBe(403);
  });

  it('is reachable on community tier for admins (no PAID_REQUIRED)', async () => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    const res = await request(app)
      .get('/api/fleet/labels/suggestions')
      .set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.code).not.toBe('PAID_REQUIRED');
    expect(Array.isArray(res.body.suggestions)).toBe(true);
  });

  it('aggregates stack labels across nodes, includes unassigned ones, and excludes node labels', async () => {
    const localId = db.getNodes().find(n => n.is_default)!.id;
    const remoteId = db.addNode({
      name: 'sugg-remote', type: 'remote', api_url: 'http://sugg.example:1852',
      api_token: 'tok', compose_dir: '/app/compose', is_default: false,
    });
    try {
      // Local node: one assigned stack label and one unassigned (the picker
      // still lists labels with no assignments).
      const local = db.createLabel(localId, 'shared-prod', 'teal');
      db.setStackLabels('alpha', localId, [local.id]);
      db.createLabel(localId, 'unused-stack-label', 'slate');
      // The remote is queried authoritatively: it carries the same-named stack
      // label (assigned to one stack). Its node-only label is never returned by
      // /api/labels, proving node labels can't surface as stop targets.
      db.addNodeLabel(remoteId, 'edge-only');
      vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
        const u = String(url);
        if (u.endsWith('/api/labels/assignments')) return Promise.resolve(okJson({ beta: [{ id: 1, node_id: remoteId, name: 'shared-prod', color: 'teal' }] }));
        if (u.endsWith('/api/labels')) return Promise.resolve(okJson([{ id: 1, node_id: remoteId, name: 'shared-prod', color: 'teal' }]));
        return Promise.resolve(okJson({}));
      });

      const res = await request(app)
        .get('/api/fleet/labels/suggestions')
        .set('Authorization', authHeader);
      expect(res.status).toBe(200);

      const names = res.body.suggestions.map((s: { name: string }) => s.name);
      expect(names).toContain('shared-prod');
      expect(names).toContain('unused-stack-label');
      expect(names).not.toContain('edge-only');
      // Sorted by name.
      expect(names).toEqual([...names].sort((a: string, b: string) => a.localeCompare(b)));

      const shared = res.body.suggestions.find((s: { name: string }) => s.name === 'shared-prod');
      expect(shared.scope).toBe('stack');
      expect(shared.nodeCount).toBe(2);
      expect(shared.stackCount).toBe(2);

      const unused = res.body.suggestions.find((s: { name: string }) => s.name === 'unused-stack-label');
      expect(unused.nodeCount).toBe(1);
      expect(unused.stackCount).toBe(0);
    } finally {
      db.deleteNode(remoteId);
    }
  });

  it('counts only the stack-label side when a node label shares the name', async () => {
    const localId = db.getNodes().find(n => n.is_default)!.id;
    const remoteId = db.addNode({
      name: 'collision-remote', type: 'remote', api_url: 'http://collision.example:1852',
      api_token: 'tok', compose_dir: '/app/compose', is_default: false,
    });
    try {
      // A stack label 'prod' lives on the local node only...
      const stackLabel = db.createLabel(localId, 'prod', 'teal');
      db.setStackLabels('alpha', localId, [stackLabel.id]);
      // ...while a node label of the same name lives on the remote node. The
      // remote's authoritative /api/labels returns stack labels only (none here),
      // so the node label cannot inflate the stack-label counts.
      db.addNodeLabel(remoteId, 'prod');
      vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
        const u = String(url);
        if (u.endsWith('/api/labels/assignments')) return Promise.resolve(okJson({}));
        if (u.endsWith('/api/labels')) return Promise.resolve(okJson([]));
        return Promise.resolve(okJson({}));
      });

      const res = await request(app)
        .get('/api/fleet/labels/suggestions')
        .set('Authorization', authHeader);
      expect(res.status).toBe(200);

      const prod = res.body.suggestions.find((s: { name: string }) => s.name === 'prod');
      // The node label must not inflate the counts: only the local stack label counts.
      expect(prod.nodeCount).toBe(1);
      expect(prod.stackCount).toBe(1);
    } finally {
      db.deleteNode(remoteId);
    }
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

describe('POST /api/fleet/labels/fleet-stop remote leg', () => {
  // Guards the C-1 fix: the remote fan-out must target the admin-only
  // /api/fleet-actions/labels/local-stop receiver (reachable on every license),
  // never the paid /api/labels/:id/action it used to call, which 403'd on
  // Community remotes.
  it('fans out to the admin-only local-stop receiver, never the paid per-label action route', async () => {
    const remoteId = db.addNode({
      name: 'remote-stop',
      type: 'remote',
      api_url: 'http://remote-stop.example:1852',
      api_token: 'tok',
      compose_dir: '/app/compose',
      is_default: false,
    });
    try {
      const label = db.createLabel(remoteId, `remote-c1-${++labelCounter}`, 'teal');
      db.setStackLabels('alpha', remoteId, [label.id]);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ matched: true, results: [{ stackName: 'alpha', success: true }] }),
      } as unknown as Response);

      const res = await request(app)
        .post('/api/fleet/labels/fleet-stop')
        .set('Authorization', authHeader)
        .send({ labelName: label.name });

      expect(res.status).toBe(200);
      const urls = fetchSpy.mock.calls.map(c => String(c[0]));
      expect(urls.some(u => u.endsWith('/api/fleet-actions/labels/local-stop'))).toBe(true);
      expect(urls.some(u => u.includes('/api/labels/'))).toBe(false);

      const call = fetchSpy.mock.calls.find(c => String(c[0]).endsWith('/api/fleet-actions/labels/local-stop'));
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ labelName: label.name, dryRun: false });

      const remoteRow = res.body.results.find((r: { nodeId: number }) => r.nodeId === remoteId);
      expect(remoteRow.stackResults).toEqual([{ stackName: 'alpha', success: true }]);
    } finally {
      db.deleteNode(remoteId);
    }
  });

  it('honors the remote matched:false flag over the control mirror (mirror skew)', async () => {
    const remoteId = db.addNode({
      name: 'remote-skew', type: 'remote', api_url: 'http://remote-skew.example:1852',
      api_token: 'tok', compose_dir: '/app/compose', is_default: false,
    });
    try {
      // The control mirror believes the remote carries this label + stack...
      const label = db.createLabel(remoteId, `remote-skew-${++labelCounter}`, 'teal');
      db.setStackLabels('alpha', remoteId, [label.id]);
      // ...but the remote authoritatively reports it has no such label.
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true, status: 200, json: async () => ({ matched: false, results: [] }),
      } as unknown as Response);

      const res = await request(app)
        .post('/api/fleet/labels/fleet-stop')
        .set('Authorization', authHeader)
        .send({ labelName: label.name });

      expect(res.status).toBe(200);
      const remoteRow = res.body.results.find((r: { nodeId: number }) => r.nodeId === remoteId);
      expect(remoteRow.matched).toBe(false);
      expect(remoteRow.stackResults).toEqual([]);
    } finally {
      db.deleteNode(remoteId);
    }
  });

  it('reports a malformed 200 body (non-array results) as a per-node failure', async () => {
    const remoteId = db.addNode({
      name: 'remote-malformed', type: 'remote', api_url: 'http://remote-malformed.example:1852',
      api_token: 'tok', compose_dir: '/app/compose', is_default: false,
    });
    try {
      const label = db.createLabel(remoteId, `remote-malformed-${++labelCounter}`, 'teal');
      db.setStackLabels('alpha', remoteId, [label.id]);
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true, status: 200, json: async () => ({ matched: true, results: 'not-an-array' }),
      } as unknown as Response);

      const res = await request(app)
        .post('/api/fleet/labels/fleet-stop')
        .set('Authorization', authHeader)
        .send({ labelName: label.name });

      expect(res.status).toBe(200);
      const remoteRow = res.body.results.find((r: { nodeId: number }) => r.nodeId === remoteId);
      expect(remoteRow.reachable).toBe(false);
      expect(remoteRow.error).toMatch(/malformed/);
      // Best-effort attribution from the control mirror (alpha was assigned above).
      expect(remoteRow.stackResults).toEqual([{ stackName: 'alpha', success: false, error: 'Remote returned a malformed response' }]);
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
