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
let mockFsStacksError: Error | null = null;
const pruneManagedOnly = vi.fn();
const pruneSystem = vi.fn();
const estimateManagedReclaim = vi.fn();
const estimateSystemReclaim = vi.fn();
const getContainersByStack = vi.fn();
const stopContainer = vi.fn();
const restartContainer = vi.fn();
const invalidateNodeCaches = vi.fn();
const remoteSupportsCrossNodeRbac = vi.fn();

vi.mock('../helpers/remoteCapabilities', () => ({
  remoteSupportsCrossNodeRbac,
}));

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: vi.fn(() => ({
      getStacks: vi.fn(async () => {
        if (mockFsStacksError) throw mockFsStacksError;
        return mockFsStacks;
      }),
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
  mockFsStacksError = null;
  pruneManagedOnly.mockResolvedValue({ success: true, reclaimedBytes: 0 });
  pruneSystem.mockResolvedValue({ success: true, reclaimedBytes: 0 });
  estimateManagedReclaim.mockResolvedValue({ reclaimableBytes: 0 });
  estimateSystemReclaim.mockResolvedValue({ reclaimableBytes: 0 });
  getContainersByStack.mockResolvedValue([{ Id: 'container-1' }]);
  stopContainer.mockResolvedValue(undefined);
  restartContainer.mockResolvedValue(undefined);
  // Default: remotes are upgraded and honor the exact-stack allowlist. The
  // mixed-version cases below flip this to false to exercise the gate.
  remoteSupportsCrossNodeRbac.mockResolvedValue(true);
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

// Stub the control's server-side fan-out to a remote node. The remote's
// authoritative stack-label state is read live via /api/labels +
// /api/labels/assignments; this returns canned bodies for those two URLs and
// passes any other URL (e.g. the fleet-stop local-stop receiver) to `other`.
function mockRemoteLabelFetch(opts: {
  labels: { name: string; color?: string }[];
  assignments: Record<string, string[]>; // stackName -> label names
  other?: (url: string) => Response;
}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.endsWith('/api/labels')) {
      const body = opts.labels.map((l, i) => ({ id: i + 1, node_id: 9, name: l.name, color: l.color ?? 'teal' }));
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/api/labels/assignments')) {
      const body: Record<string, { name: string; color: string }[]> = {};
      for (const [stack, names] of Object.entries(opts.assignments)) {
        body[stack] = names.map(n => ({ name: n, color: 'teal' }));
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return opts.other ? opts.other(url) : new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
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

  it('includes remote stacks grouped per node, drops stale local stacks, and flags reachability', async () => {
    const localId = db.getNodes().find(n => n.is_default)!.id;
    const local = db.createLabel(localId, 'media', 'teal');
    db.setStackLabels('alpha', localId, [local.id]);
    // A stale local assignment to a stack that no longer exists on disk
    // (not in mockFsStacks) must be filtered out, not counted.
    db.setStackLabels('media-ghost', localId, [local.id]);
    const remoteId = db.addNode({
      name: 'media-remote', type: 'remote', api_url: 'http://media.example:1852',
      api_token: 'tok', compose_dir: '/app/compose', is_default: false,
    });
    try {
      // The control DB holds no 'media' row for the remote; its stacks come live.
      mockRemoteLabelFetch({ labels: [{ name: 'media' }], assignments: { sonarr: ['media'], radarr: ['media'] } });
      const res = await request(app)
        .post('/api/fleet/labels/match-preview')
        .set('Authorization', authHeader)
        .send({ labelName: 'media' });
      expect(res.status).toBe(200);
      // 1 live local stack (the ghost is dropped) + 2 remote stacks.
      expect(res.body.matchedStacks).toBe(3);
      expect(res.body.matchedNodes).toBe(2);
      expect(res.body.unreachableNodes).toBe(0);
      const localRow = res.body.perNode.find((n: { nodeId: number }) => n.nodeId === localId);
      expect(localRow.stackCount).toBe(1);
      expect(localRow.stackNames).toEqual(['alpha']);
      const remote = res.body.perNode.find((n: { nodeId: number }) => n.nodeId === remoteId);
      expect(remote.reachable).toBe(true);
      expect(remote.labelExists).toBe(true);
      expect(remote.stackNames.sort()).toEqual(['radarr', 'sonarr']);
    } finally {
      db.deleteNode(remoteId);
    }
  });

  it('distinguishes label-exists-no-stacks from an unreachable remote', async () => {
    const localId = db.getNodes().find(n => n.is_default)!.id;
    // Local carries the label but assigns no stacks to it.
    db.createLabel(localId, 'empty-label', 'teal');
    const remoteId = db.addNode({
      name: 'unreach-remote', type: 'remote', api_url: 'http://unreach.example:1852',
      api_token: 'tok', compose_dir: '/app/compose', is_default: false,
    });
    try {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
      const res = await request(app)
        .post('/api/fleet/labels/match-preview')
        .set('Authorization', authHeader)
        .send({ labelName: 'empty-label' });
      expect(res.status).toBe(200);
      expect(res.body.unreachableNodes).toBe(1);
      const localRow = res.body.perNode.find((n: { nodeId: number }) => n.nodeId === localId);
      expect(localRow.reachable).toBe(true);
      expect(localRow.labelExists).toBe(true);
      expect(localRow.stackCount).toBe(0);
      const remoteRow = res.body.perNode.find((n: { nodeId: number }) => n.nodeId === remoteId);
      expect(remoteRow.reachable).toBe(false);
      expect(remoteRow.error).toMatch(/ECONNREFUSED|reach/i);
    } finally {
      db.deleteNode(remoteId);
    }
  });

  it('surfaces the remote error body when it serves labels but rejects assignments', async () => {
    const localId = db.getNodes().find(n => n.is_default)!.id;
    db.setStackLabels('alpha', localId, [db.createLabel(localId, 'ok-label', 'teal').id]);
    const remoteId = db.addNode({
      name: 'split-remote', type: 'remote', api_url: 'http://split.example:1852',
      api_token: 'tok', compose_dir: '/app/compose', is_default: false,
    });
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.endsWith('/api/labels')) {
          return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        // /api/labels/assignments rejects with a real error body.
        return new Response(JSON.stringify({ error: 'token expired' }), { status: 403, headers: { 'content-type': 'application/json' } });
      });
      const res = await request(app)
        .post('/api/fleet/labels/match-preview')
        .set('Authorization', authHeader)
        .send({ labelName: 'ok-label' });
      expect(res.status).toBe(200);
      const remoteRow = res.body.perNode.find((n: { nodeId: number }) => n.nodeId === remoteId);
      expect(remoteRow.reachable).toBe(false);
      // The remote's own message is surfaced, not a bare status number.
      expect(remoteRow.error).toBe('token expired');
    } finally {
      db.deleteNode(remoteId);
    }
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

  it('surfaces remote-only stack labels and aggregates shared names across nodes', async () => {
    const localNode = db.getNodes().find(n => n.is_default)!;
    const remoteId = db.addNode({
      name: 'sugg-remote', type: 'remote', api_url: 'http://sugg.example:1852',
      api_token: 'tok', compose_dir: '/app/compose', is_default: false,
    });
    try {
      // Local node: 'shared-prod' on stack 'alpha' (alpha is in mockFsStacks).
      const local = db.createLabel(localNode.id, 'shared-prod', 'teal');
      db.setStackLabels('alpha', localNode.id, [local.id]);
      // Remote node: queried live. It carries 'shared-prod' on TWO stacks plus a
      // remote-only 'edge'. NONE of this is mirrored in the control DB. The
      // asymmetric remote count (2) makes a sum-vs-concatenate bug observable.
      mockRemoteLabelFetch({
        labels: [{ name: 'shared-prod' }, { name: 'edge' }],
        assignments: { sonarr: ['shared-prod'], lidarr: ['shared-prod'], radarr: ['edge'] },
      });

      const res = await request(app)
        .get('/api/fleet/labels/suggestions')
        .set('Authorization', authHeader);
      expect(res.status).toBe(200);

      const names = res.body.suggestions.map((s: { name: string }) => s.name);
      expect(names).toContain('shared-prod');
      // Remote-only label is visible despite no control-DB row.
      expect(names).toContain('edge');
      // Sorted by name.
      expect(names).toEqual([...names].sort((a: string, b: string) => a.localeCompare(b)));
      expect(res.body.partial).toBe(false);
      expect(res.body.unreachableNodes).toBe(0);

      const shared = res.body.suggestions.find((s: { name: string }) => s.name === 'shared-prod');
      expect(shared.scope).toBe('stack');
      expect(shared.nodeCount).toBe(2);
      // 1 local stack + 2 remote stacks, summed (not deduped to the node count).
      expect(shared.stackCount).toBe(3);
      expect([...shared.nodes].sort()).toEqual([localNode.name, 'sugg-remote'].sort());

      const edge = res.body.suggestions.find((s: { name: string }) => s.name === 'edge');
      expect(edge.nodeCount).toBe(1);
      expect(edge.stackCount).toBe(1);
    } finally {
      db.deleteNode(remoteId);
    }
  });

  it('never folds node labels into the picker even when one shares a stack-label name', async () => {
    const localId = db.getNodes().find(n => n.is_default)!.id;
    const remoteId = db.addNode({
      name: 'collision-remote', type: 'remote', api_url: 'http://collision.example:1852',
      api_token: 'tok', compose_dir: '/app/compose', is_default: false,
    });
    try {
      // A stack label 'prod' lives on the local node...
      const stackLabel = db.createLabel(localId, 'prod', 'teal');
      db.setStackLabels('alpha', localId, [stackLabel.id]);
      // ...while a node label of the same name lives on the remote node. The
      // remote's stack-label endpoint (/api/labels) never returns node labels.
      db.addNodeLabel(remoteId, 'prod');
      mockRemoteLabelFetch({ labels: [], assignments: {} });

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

  it('excludes labels whose only assigned stacks no longer exist on disk', async () => {
    const localId = db.getNodes().find(n => n.is_default)!.id;
    const ghost = db.createLabel(localId, 'ghost-only', 'teal');
    // 'vanished-stack' is not in mockFsStacks, so the fs-present filter drops it,
    // leaving the label with zero matching stacks fleet-wide.
    db.setStackLabels('vanished-stack', localId, [ghost.id]);

    const res = await request(app)
      .get('/api/fleet/labels/suggestions')
      .set('Authorization', authHeader);
    expect(res.status).toBe(200);
    const names = res.body.suggestions.map((s: { name: string }) => s.name);
    expect(names).not.toContain('ghost-only');
  });

  it('reports unreachable remotes as partial without dropping reachable suggestions', async () => {
    const localId = db.getNodes().find(n => n.is_default)!.id;
    const local = db.createLabel(localId, 'live-label', 'teal');
    db.setStackLabels('alpha', localId, [local.id]);
    const remoteId = db.addNode({
      name: 'down-remote', type: 'remote', api_url: 'http://down.example:1852',
      api_token: 'tok', compose_dir: '/app/compose', is_default: false,
    });
    try {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
      const res = await request(app)
        .get('/api/fleet/labels/suggestions')
        .set('Authorization', authHeader);
      expect(res.status).toBe(200);
      expect(res.body.partial).toBe(true);
      expect(res.body.unreachableNodes).toBe(1);
      const names = res.body.suggestions.map((s: { name: string }) => s.name);
      expect(names).toContain('live-label');
    } finally {
      db.deleteNode(remoteId);
    }
  });

  it('fails closed: a remote returning a malformed label body is marked unreachable', async () => {
    const localId = db.getNodes().find(n => n.is_default)!.id;
    const local = db.createLabel(localId, 'safe-label', 'teal');
    db.setStackLabels('alpha', localId, [local.id]);
    const remoteId = db.addNode({
      name: 'garbage-remote', type: 'remote', api_url: 'http://garbage.example:1852',
      api_token: 'tok', compose_dir: '/app/compose', is_default: false,
    });
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.endsWith('/api/labels')) {
          // Not an array: the fail-closed parser must reject the whole node.
          return new Response(JSON.stringify({ not: 'an array' }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
      });
      const res = await request(app)
        .get('/api/fleet/labels/suggestions')
        .set('Authorization', authHeader);
      expect(res.status).toBe(200);
      expect(res.body.partial).toBe(true);
      expect(res.body.unreachableNodes).toBe(1);
      // The garbage remote contributes nothing; the local label still surfaces.
      const names = res.body.suggestions.map((s: { name: string }) => s.name);
      expect(names).toContain('safe-label');
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

  it('accepts a legitimate empty stop (matched:true, results:[]) without flagging it malformed', async () => {
    const remoteId = db.addNode({
      name: 'remote-empty', type: 'remote', api_url: 'http://remote-empty.example:1852',
      api_token: 'tok', compose_dir: '/app/compose', is_default: false,
    });
    try {
      const label = db.createLabel(remoteId, `remote-empty-${++labelCounter}`, 'teal');
      db.setStackLabels('alpha', remoteId, [label.id]);
      // The local-stop receiver emits exactly this when the label exists with no
      // assigned stacks. The guard must let it through, not over-reject it.
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true, status: 200, json: async () => ({ matched: true, results: [] }),
      } as unknown as Response);

      const res = await request(app)
        .post('/api/fleet/labels/fleet-stop')
        .set('Authorization', authHeader)
        .send({ labelName: label.name });

      expect(res.status).toBe(200);
      const remoteRow = res.body.results.find((r: { nodeId: number }) => r.nodeId === remoteId);
      expect(remoteRow.reachable).toBe(true);
      expect(remoteRow.matched).toBe(true);
      expect(remoteRow.stackResults).toEqual([]);
      expect(remoteRow.error).toBeUndefined();
    } finally {
      db.deleteNode(remoteId);
    }
  });

  it('fails a node whose 200 body has a non-array results, never rendering it as zero-stack success', async () => {
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
      // A malformed contract is a node failure: reachable:false + error, not the
      // matched:true/empty-results shape the UI reads as a successful no-op.
      expect(remoteRow.reachable).toBe(false);
      expect(remoteRow.matched).toBe(false);
      expect(remoteRow.stackResults).toEqual([]);
      expect(remoteRow.error).toMatch(/malformed/i);
    } finally {
      db.deleteNode(remoteId);
    }
  });

  it('fails a node whose 200 body omits the matched flag instead of defaulting it to true', async () => {
    const remoteId = db.addNode({
      name: 'remote-no-matched', type: 'remote', api_url: 'http://remote-no-matched.example:1852',
      api_token: 'tok', compose_dir: '/app/compose', is_default: false,
    });
    try {
      const label = db.createLabel(remoteId, `remote-no-matched-${++labelCounter}`, 'teal');
      db.setStackLabels('alpha', remoteId, [label.id]);
      // The previous default (`matched: remote.matched ?? true`) turned this body
      // into a matched:true/zero-stack success; the guard must fail the node.
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true, status: 200, json: async () => ({ results: [] }),
      } as unknown as Response);

      const res = await request(app)
        .post('/api/fleet/labels/fleet-stop')
        .set('Authorization', authHeader)
        .send({ labelName: label.name });

      expect(res.status).toBe(200);
      const remoteRow = res.body.results.find((r: { nodeId: number }) => r.nodeId === remoteId);
      expect(remoteRow.reachable).toBe(false);
      expect(remoteRow.matched).toBe(false);
      expect(remoteRow.error).toMatch(/malformed/i);
    } finally {
      db.deleteNode(remoteId);
    }
  });

  it('calls the remote local-stop even when the control DB has no remote label row', async () => {
    const remoteId = db.addNode({
      name: 'remote-nomirror', type: 'remote', api_url: 'http://remote-nomirror.example:1852',
      api_token: 'tok', compose_dir: '/app/compose', is_default: false,
    });
    try {
      // Deliberately seed NO label/assignment for the remote in the control DB.
      // The old mirror pre-check would have skipped this node entirely.
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true, status: 200,
        json: async () => ({ matched: true, results: [{ stackName: 'remote-stack', success: true }] }),
      } as unknown as Response);

      const res = await request(app)
        .post('/api/fleet/labels/fleet-stop')
        .set('Authorization', authHeader)
        .send({ labelName: 'remote-only-label' });

      expect(res.status).toBe(200);
      const urls = fetchSpy.mock.calls.map(c => String(c[0]));
      expect(urls.some(u => u.endsWith('/api/fleet-actions/labels/local-stop'))).toBe(true);
      const remoteRow = res.body.results.find((r: { nodeId: number }) => r.nodeId === remoteId);
      expect(remoteRow.reachable).toBe(true);
      expect(remoteRow.matched).toBe(true);
      expect(remoteRow.stackResults).toEqual([{ stackName: 'remote-stack', success: true }]);
    } finally {
      db.deleteNode(remoteId);
    }
  });

  it('reports an unreachable remote at the node level without blocking the local stop', async () => {
    const localLabel = await createAssignedLabel('local-live', ['alpha']);
    const remoteId = db.addNode({
      name: 'remote-down', type: 'remote', api_url: 'http://remote-down.example:1852',
      api_token: 'tok', compose_dir: '/app/compose', is_default: false,
    });
    try {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
      const res = await request(app)
        .post('/api/fleet/labels/fleet-stop')
        .set('Authorization', authHeader)
        .send({ labelName: localLabel.name });

      expect(res.status).toBe(200);
      const localResult = res.body.results.find((r: { nodeId: number }) => r.nodeId === localLabel.node_id);
      expect(localResult.reachable).toBe(true);
      expect(localResult.matched).toBe(true);
      expect(localResult.stackResults).toEqual([{ stackName: 'alpha', success: true }]);
      const remoteRow = res.body.results.find((r: { nodeId: number }) => r.nodeId === remoteId);
      expect(remoteRow.reachable).toBe(false);
      expect(remoteRow.matched).toBe(false);
      expect(remoteRow.stackResults).toEqual([]);
      expect(remoteRow.error).toMatch(/ECONNREFUSED|reach/i);
    } finally {
      db.deleteNode(remoteId);
    }
  });
});

describe('POST /api/fleet/labels/fleet-stop confirmed-target allowlist', () => {
  // Guards the drift fix: the real stop carries the exact node + stack list the
  // operator confirmed in the preview. A node that was unreachable then and
  // reconnects cannot enter the fan-out, and a stack labelled after the preview
  // is not stopped (the per-node receiver intersects against the sent stacks).
  it('contacts a confirmed remote and forwards its confirmed stacks, excluding the unconfirmed local node', async () => {
    const remoteId = db.addNode({
      name: 'confirmed-remote', type: 'remote', api_url: 'http://confirmed.example:1852',
      api_token: 'tok', compose_dir: '/app/compose', is_default: false,
    });
    try {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true, status: 200, json: async () => ({ matched: true, results: [{ stackName: 'alpha', success: true }] }),
      } as unknown as Response);
      const res = await request(app)
        .post('/api/fleet/labels/fleet-stop')
        .set('Authorization', authHeader)
        .send({ labelName: 'any-label', targets: [{ nodeId: remoteId, stackNames: ['alpha'] }] });
      expect(res.status).toBe(200);
      // Only the confirmed remote is in the fan-out: its local-stop receiver is
      // contacted and the unconfirmed local node is absent from the results.
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0].nodeId).toBe(remoteId);
      const stopCall = fetchSpy.mock.calls.find(c => String(c[0]).endsWith('/api/fleet-actions/labels/local-stop'));
      expect(stopCall).toBeTruthy();
      // The confirmed stacks are forwarded so the remote binds its stop to them.
      expect(JSON.parse((stopCall![1] as RequestInit).body as string)).toMatchObject({ labelName: 'any-label', stackNames: ['alpha'] });
    } finally {
      db.deleteNode(remoteId);
    }
  });

  it('excludes an otherwise-reachable remote that is not in the allowlist', async () => {
    const label = await createAssignedLabel('confirmed-only', ['alpha']);
    const localId = label.node_id;
    const remoteId = db.addNode({
      name: 'excluded-remote', type: 'remote', api_url: 'http://excluded.example:1852',
      api_token: 'tok', compose_dir: '/app/compose', is_default: false,
    });
    try {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const res = await request(app)
        .post('/api/fleet/labels/fleet-stop')
        .set('Authorization', authHeader)
        .send({ labelName: label.name, targets: [{ nodeId: localId, stackNames: ['alpha'] }] });
      expect(res.status).toBe(200);
      // The excluded remote has a proxy target and would otherwise be contacted;
      // the allowlist keeps it out of execution entirely.
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0].nodeId).toBe(localId);
      expect(res.body.results.some((r: { nodeId: number }) => r.nodeId === remoteId)).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      db.deleteNode(remoteId);
    }
  });

  it('treats empty targets as zero target nodes, stopping nothing', async () => {
    const label = await createAssignedLabel('empty-allow', ['alpha']);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await request(app)
      .post('/api/fleet/labels/fleet-stop')
      .set('Authorization', authHeader)
      .send({ labelName: label.name, targets: [] });
    expect(res.status).toBe(200);
    // Empty targets filter to no nodes: a fail-safe no-op rather than a
    // full-fleet stop. The local node is not acted on and no remote is contacted.
    expect(res.body.results).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a non-array targets with 400', async () => {
    const res = await request(app)
      .post('/api/fleet/labels/fleet-stop')
      .set('Authorization', authHeader)
      .send({ labelName: 'whatever', targets: 'oops' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/targets/);
  });

  it('rejects a non-integer target.nodeId with 400', async () => {
    const res = await request(app)
      .post('/api/fleet/labels/fleet-stop')
      .set('Authorization', authHeader)
      .send({ labelName: 'whatever', targets: [{ nodeId: 2.5, stackNames: ['x'] }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nodeId/);
  });

  it('refuses a real stop to a remote lacking cross-node-rbac and reports it as needing upgrade', async () => {
    remoteSupportsCrossNodeRbac.mockResolvedValue(false);
    const remoteId = db.addNode({
      name: 'old-remote', type: 'remote', api_url: 'http://old.example:1852',
      api_token: 'tok', compose_dir: '/app/compose', is_default: false,
    });
    try {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const res = await request(app)
        .post('/api/fleet/labels/fleet-stop')
        .set('Authorization', authHeader)
        .send({ labelName: 'any-label', targets: [{ nodeId: remoteId, stackNames: ['alpha'] }] });
      expect(res.status).toBe(200);
      const node = res.body.results.find((r: { nodeId: number }) => r.nodeId === remoteId);
      expect(node.reachable).toBe(false);
      expect(node.error).toMatch(/upgrade/i);
      expect(node.stackResults).toEqual([{ stackName: 'alpha', success: false, error: 'Node must be upgraded to honor an exact-stack stop' }]);
      // The destructive local-stop receiver is never contacted on an old remote.
      expect(fetchSpy.mock.calls.some(c => String(c[0]).endsWith('/api/fleet-actions/labels/local-stop'))).toBe(false);
    } finally {
      db.deleteNode(remoteId);
    }
  });

  it('fails a node whose stop results include a stack outside the confirmed set', async () => {
    remoteSupportsCrossNodeRbac.mockResolvedValue(true);
    const remoteId = db.addNode({
      name: 'lying-remote', type: 'remote', api_url: 'http://lying.example:1852',
      api_token: 'tok', compose_dir: '/app/compose', is_default: false,
    });
    try {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true, status: 200,
        json: async () => ({
          matched: true,
          results: [
            { stackName: 'alpha', success: true },
            { stackName: 'unconfirmed-extra', success: true },
          ],
        }),
      } as unknown as Response);
      const res = await request(app)
        .post('/api/fleet/labels/fleet-stop')
        .set('Authorization', authHeader)
        .send({ labelName: 'any-label', targets: [{ nodeId: remoteId, stackNames: ['alpha'] }] });
      expect(res.status).toBe(200);
      const node = res.body.results.find((r: { nodeId: number }) => r.nodeId === remoteId);
      expect(node.reachable).toBe(false);
      expect(node.error).toMatch(/exactly the confirmed stacks/i);
    } finally {
      db.deleteNode(remoteId);
    }
  });

  it('fails a node whose stop results omit a confirmed stack (partial result)', async () => {
    remoteSupportsCrossNodeRbac.mockResolvedValue(true);
    const remoteId = db.addNode({
      name: 'dropping-remote', type: 'remote', api_url: 'http://dropping.example:1852',
      api_token: 'tok', compose_dir: '/app/compose', is_default: false,
    });
    try {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true, status: 200,
        // Two stacks confirmed, but the remote reports only one.
        json: async () => ({ matched: true, results: [{ stackName: 'alpha', success: true }] }),
      } as unknown as Response);
      const res = await request(app)
        .post('/api/fleet/labels/fleet-stop')
        .set('Authorization', authHeader)
        .send({ labelName: 'any-label', targets: [{ nodeId: remoteId, stackNames: ['alpha', 'beta'] }] });
      expect(res.status).toBe(200);
      const node = res.body.results.find((r: { nodeId: number }) => r.nodeId === remoteId);
      expect(node.reachable).toBe(false);
      expect(node.error).toMatch(/exactly the confirmed stacks/i);
    } finally {
      db.deleteNode(remoteId);
    }
  });

  it('local exception path reports every confirmed stack, including one that lost its label', async () => {
    // runLocalLabelStop throws (filesystem read fails) after the label is
    // resolved; the catch must report the full confirmed set, not the current
    // assignment, so a confirmed stack that lost its label still surfaces.
    const localNodeId = db.getNodes().find(n => n.type === 'local')!.id;
    const label = await createAssignedLabel('local-throw', ['alpha']); // only alpha is still assigned
    expect(label.node_id).toBe(localNodeId);
    mockFsStacksError = new Error('compose dir unreadable');
    const res = await request(app)
      .post('/api/fleet/labels/fleet-stop')
      .set('Authorization', authHeader)
      .send({ labelName: label.name, targets: [{ nodeId: localNodeId, stackNames: ['alpha', 'lost-label-stack'] }] });
    expect(res.status).toBe(200);
    const node = res.body.results.find((r: { nodeId: number }) => r.nodeId === localNodeId);
    const byName = Object.fromEntries(node.stackResults.map((s: { stackName: string }) => [s.stackName, s]));
    // Both confirmed stacks are failed; the one that lost its label is not dropped.
    expect(byName['alpha']).toMatchObject({ success: false });
    expect(byName['lost-label-stack']).toMatchObject({ success: false });
    expect(node.stackResults).toHaveLength(2);
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
