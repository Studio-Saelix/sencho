/**
 * Tests for the Fleet Actions tab endpoints. Covers auth, tier gating, input
 * validation, and cross-node orchestration shape across the fleet label routes:
 * the authoritative discovery reads (suggestions / match-preview / fleet-stop),
 * the bulk-assign orchestrator, and the per-node local-stop / local-assign
 * receivers.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let LicenseService: typeof import('../services/LicenseService').LicenseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ LicenseService } = await import('../services/LicenseService'));
  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
  authHeader = `Bearer ${token}`;
});

afterAll(() => cleanupTestDb(tmpDir));

function mockTier(tier: 'paid' | 'community') {
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue(tier);
}

function makeStack(name: string): void {
  const composeDir = process.env.COMPOSE_DIR as string;
  fs.mkdirSync(path.join(composeDir, name), { recursive: true });
  fs.writeFileSync(path.join(composeDir, name, 'docker-compose.yml'), 'services: {}\n');
}

// Fresh 200 JSON Response per call (a Response body can be read only once, so
// remote fan-outs that issue parallel fetches need a new instance each time).
function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('Fleet Actions endpoints require authentication', () => {
  it('POST /api/fleet/labels/bulk-assign returns 401 without auth', async () => {
    const res = await request(app).post('/api/fleet/labels/bulk-assign').send({ label: { name: 'x', color: 'teal' }, targets: [] });
    expect(res.status).toBe(401);
  });

  it('POST /api/fleet-actions/labels/local-assign returns 401 without auth', async () => {
    const res = await request(app).post('/api/fleet-actions/labels/local-assign').send({ label: { name: 'x', color: 'teal' }, stackNames: [] });
    expect(res.status).toBe(401);
  });

  it('POST /api/fleet/labels/fleet-stop returns 401 without auth', async () => {
    const res = await request(app).post('/api/fleet/labels/fleet-stop').send({ labelName: 'prod' });
    expect(res.status).toBe(401);
  });
});

describe('Fleet Actions tier gating (Community + admin)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POST /api/fleet/labels/fleet-stop is reachable on community tier for admins', async () => {
    mockTier('community');
    const res = await request(app)
      .post('/api/fleet/labels/fleet-stop')
      .set('Authorization', authHeader)
      .send({ labelName: 'this-label-does-not-exist' });
    expect(res.status).toBe(200);
    expect(res.body.code).not.toBe('PAID_REQUIRED');
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  it('POST /api/fleet/labels/bulk-assign is reachable on community tier for admins', async () => {
    mockTier('community');
    const res = await request(app)
      .post('/api/fleet/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'community-ok', color: 'teal' }, targets: [{ nodeId: 999999, stackNames: ['nope'] }] });
    expect(res.status).toBe(200);
    expect(res.body.code).not.toBe('PAID_REQUIRED');
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  it('POST /api/fleet-actions/labels/local-assign is reachable on community tier for admins', async () => {
    mockTier('community');
    const res = await request(app)
      .post('/api/fleet-actions/labels/local-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'community-recv', color: 'teal' }, stackNames: [] });
    expect(res.status).toBe(200);
    expect(res.body.code).not.toBe('PAID_REQUIRED');
    expect(res.body).toEqual({ created: expect.any(Boolean), results: [] });
  });
});

describe('Fleet Actions input validation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POST /api/fleet/labels/fleet-stop rejects missing labelName', async () => {
    const res = await request(app)
      .post('/api/fleet/labels/fleet-stop')
      .set('Authorization', authHeader)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/labelName/);
  });

  it('POST /api/fleet/labels/fleet-stop rejects whitespace-only labelName', async () => {
    const res = await request(app)
      .post('/api/fleet/labels/fleet-stop')
      .set('Authorization', authHeader)
      .send({ labelName: '   ' });
    expect(res.status).toBe(400);
  });

  it('POST /api/fleet/labels/bulk-assign rejects an invalid label color', async () => {
    const res = await request(app)
      .post('/api/fleet/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'media', color: 'not-a-color' }, targets: [{ nodeId: 0, stackNames: ['x'] }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/color/);
  });

  it('POST /api/fleet/labels/bulk-assign rejects a missing label name', async () => {
    const res = await request(app)
      .post('/api/fleet/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ label: { color: 'teal' }, targets: [{ nodeId: 0, stackNames: ['x'] }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/label\.name/);
  });

  it('POST /api/fleet/labels/bulk-assign rejects empty targets', async () => {
    const res = await request(app)
      .post('/api/fleet/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'media', color: 'teal' }, targets: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/targets/);
  });

  it('POST /api/fleet/labels/bulk-assign rejects a non-integer nodeId', async () => {
    const res = await request(app)
      .post('/api/fleet/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'media', color: 'teal' }, targets: [{ nodeId: 'abc', stackNames: ['x'] }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nodeId/);
  });

  it('POST /api/fleet/labels/bulk-assign rejects when all target groups are empty', async () => {
    const res = await request(app)
      .post('/api/fleet/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'media', color: 'teal' }, targets: [{ nodeId: 0, stackNames: [] }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no target stacks/);
  });

  it('POST /api/fleet/labels/bulk-assign rejects an oversized total', async () => {
    const big = Array.from({ length: 1001 }, (_, i) => `s${i}`);
    const res = await request(app)
      .post('/api/fleet/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'media', color: 'teal' }, targets: [{ nodeId: 0, stackNames: big }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/may not exceed/);
  });

  it('POST /api/fleet-actions/labels/local-assign rejects non-array stackNames', async () => {
    const res = await request(app)
      .post('/api/fleet-actions/labels/local-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'media', color: 'teal' }, stackNames: 'oops' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/stackNames must be an array/);
  });

  it('POST /api/fleet-actions/labels/local-assign rejects an oversized payload', async () => {
    const big = Array.from({ length: 1001 }, (_, i) => `s${i}`);
    const res = await request(app)
      .post('/api/fleet-actions/labels/local-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'media', color: 'teal' }, stackNames: big });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/may not exceed/);
  });
});

describe('Fleet Actions orchestration shape', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POST /api/fleet/labels/fleet-stop with unknown label returns matched:false per node', async () => {
    const res = await request(app)
      .post('/api/fleet/labels/fleet-stop')
      .set('Authorization', authHeader)
      .send({ labelName: 'this-label-does-not-exist' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.results)).toBe(true);
    for (const row of res.body.results) {
      expect(row.matched).toBe(false);
      expect(row.stackResults).toEqual([]);
    }
  });

  it('POST /api/fleet/labels/bulk-assign reports an unknown node per-node without failing the request', async () => {
    const res = await request(app)
      .post('/api/fleet/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'media', color: 'teal' }, targets: [{ nodeId: 999999, stackNames: ['a', 'b'] }] });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    const row = res.body.results[0];
    expect(row.reachable).toBe(false);
    expect(row.error).toBe('Unknown node');
    expect(row.stackResults).toEqual([
      { stackName: 'a', success: false, error: 'Unknown node' },
      { stackName: 'b', success: false, error: 'Unknown node' },
    ]);
  });
});

// The per-node local-stop receiver is what a control instance calls on each
// remote during a fleet-wide stop. It must be reachable on every license (only
// admin-gated): the original fleet-stop fan-out hit the paid /api/labels/:id/action
// and 403'd on Community remotes. These tests lock that behavior in.
describe('local-stop receiver auth + tier', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POST /api/fleet-actions/labels/local-stop returns 401 without auth', async () => {
    const res = await request(app).post('/api/fleet-actions/labels/local-stop').send({ labelName: 'prod' });
    expect(res.status).toBe(401);
  });

  it('is reachable on community tier for admins and never returns PAID_REQUIRED', async () => {
    mockTier('community');
    const res = await request(app)
      .post('/api/fleet-actions/labels/local-stop')
      .set('Authorization', authHeader)
      .send({ labelName: 'this-label-does-not-exist' });
    expect(res.status).toBe(200);
    expect(res.body.code).not.toBe('PAID_REQUIRED');
    expect(res.body).toEqual({ matched: false, results: [] });
  });

  it('rejects missing labelName', async () => {
    const res = await request(app)
      .post('/api/fleet-actions/labels/local-stop')
      .set('Authorization', authHeader)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/labelName/);
  });

  it('rejects whitespace-only labelName', async () => {
    const res = await request(app)
      .post('/api/fleet-actions/labels/local-stop')
      .set('Authorization', authHeader)
      .send({ labelName: '   ' });
    expect(res.status).toBe(400);
  });
});

describe('local-stop behavior', () => {
  let db: import('../services/DatabaseService').DatabaseService;
  let nodeId: number;

  beforeAll(async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const { NodeRegistry } = await import('../services/NodeRegistry');
    db = DatabaseService.getInstance();
    nodeId = NodeRegistry.getInstance().getDefaultNodeId();
  });

  afterEach(() => vi.restoreAllMocks());

  it('matched:true with empty results when the label exists but has no stacks', async () => {
    db.createLabel(nodeId, 'no-stacks-label', 'slate');
    const res = await request(app)
      .post('/api/fleet-actions/labels/local-stop')
      .set('Authorization', authHeader)
      .send({ labelName: 'no-stacks-label' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ matched: true, results: [] });
  });

  it('reports per-stack lock contention when a bulk action is already running on the node', async () => {
    const label = db.createLabel(nodeId, 'busy-label', 'slate');
    db.setStackLabels('busy-stack', nodeId, [label.id]);
    const { activeBulkActions } = await import('../routes/labels');
    activeBulkActions.add(`bulk:${nodeId}`);
    try {
      const res = await request(app)
        .post('/api/fleet-actions/labels/local-stop')
        .set('Authorization', authHeader)
        .send({ labelName: 'busy-label' });
      expect(res.status).toBe(200);
      expect(res.body.matched).toBe(true);
      expect(res.body.results).toEqual([
        { stackName: 'busy-stack', success: false, error: 'A bulk action is already running on this node' },
      ]);
    } finally {
      activeBulkActions.delete(`bulk:${nodeId}`);
    }
  });

  it('dry run returns dryRun:true per on-disk stack without touching Docker', async () => {
    makeStack('dry-stack');
    const label = db.createLabel(nodeId, 'dry-label', 'slate');
    db.setStackLabels('dry-stack', nodeId, [label.id]);
    const res = await request(app)
      .post('/api/fleet-actions/labels/local-stop')
      .set('Authorization', authHeader)
      .send({ labelName: 'dry-label', dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.matched).toBe(true);
    expect(res.body.results).toEqual([{ stackName: 'dry-stack', success: true, dryRun: true }]);
  });

  it('filters out assigned stacks that are not present on disk', async () => {
    const label = db.createLabel(nodeId, 'ghost-label', 'slate');
    db.setStackLabels('ghost-stack', nodeId, [label.id]);
    const res = await request(app)
      .post('/api/fleet-actions/labels/local-stop')
      .set('Authorization', authHeader)
      .send({ labelName: 'ghost-label' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ matched: true, results: [] });
  });
});

describe('local-assign receiver behavior', () => {
  let db: import('../services/DatabaseService').DatabaseService;
  let nodeId: number;

  beforeAll(async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const { NodeRegistry } = await import('../services/NodeRegistry');
    db = DatabaseService.getInstance();
    nodeId = NodeRegistry.getInstance().getDefaultNodeId();
  });

  afterEach(() => vi.restoreAllMocks());

  it('creates the label when missing and assigns it to the stack', async () => {
    makeStack('recv-create');
    const res = await request(app)
      .post('/api/fleet-actions/labels/local-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'recv-created', color: 'blue' }, stackNames: ['recv-create'] });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(true);
    expect(res.body.results).toEqual([{ stackName: 'recv-create', success: true }]);
    const created = db.getLabels(nodeId).find(l => l.name === 'recv-created');
    expect(created).toBeTruthy();
    expect(db.getLabelsForStacks(nodeId)['recv-create'].map(l => l.name)).toContain('recv-created');
  });

  it('reuses an existing label (created:false) and preserves existing assignments', async () => {
    makeStack('recv-reuse');
    const existing = db.createLabel(nodeId, 'recv-existing', 'green');
    db.setStackLabels('recv-reuse', nodeId, [existing.id]);
    db.createLabel(nodeId, 'recv-reused', 'purple');
    const res = await request(app)
      .post('/api/fleet-actions/labels/local-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'recv-reused', color: 'purple' }, stackNames: ['recv-reuse'] });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    const names = db.getLabelsForStacks(nodeId)['recv-reuse'].map(l => l.name).sort();
    expect(names).toEqual(['recv-existing', 'recv-reused']);
  });

  it('reports a per-stack error for a stack that is not on disk', async () => {
    const res = await request(app)
      .post('/api/fleet-actions/labels/local-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'recv-ghost', color: 'rose' }, stackNames: ['recv-not-on-disk'] });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ stackName: 'recv-not-on-disk', success: false, error: 'Stack not found' }]);
  });

  it('fails all stacks with the cap message when the node is at the label limit', async () => {
    makeStack('recv-cap');
    vi.spyOn(db, 'getLabelCount').mockReturnValue(50);
    const res = await request(app)
      .post('/api/fleet-actions/labels/local-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'recv-over-cap', color: 'teal' }, stackNames: ['recv-cap'] });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    expect(res.body.results[0]).toMatchObject({ stackName: 'recv-cap', success: false });
    expect(res.body.results[0].error).toMatch(/Maximum of 50/);
  });

  it('reuses an existing label after a concurrent-create unique violation', async () => {
    makeStack('recv-race');
    // First read sees no label (so a create is attempted); create throws a unique
    // violation as if another request won the race; the re-fetch then finds it.
    const raced = { id: 9991, node_id: nodeId, name: 'recv-raced', color: 'teal' as const };
    vi.spyOn(db, 'getLabels').mockReturnValueOnce([]).mockReturnValue([raced]);
    const uniqueErr = Object.assign(new Error('UNIQUE constraint failed'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
    vi.spyOn(db, 'createLabel').mockImplementation(() => { throw uniqueErr; });
    const addSpy = vi.spyOn(db, 'addStackLabels').mockImplementation(() => {});
    const res = await request(app)
      .post('/api/fleet-actions/labels/local-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'recv-raced', color: 'teal' }, stackNames: ['recv-race'] });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    expect(res.body.results).toEqual([{ stackName: 'recv-race', success: true }]);
    expect(addSpy).toHaveBeenCalledWith('recv-race', nodeId, [9991]);
  });
});

describe('DatabaseService.addStackLabels', () => {
  let db: import('../services/DatabaseService').DatabaseService;
  let nodeId: number;

  beforeAll(async () => {
    db = (await import('../services/DatabaseService')).DatabaseService.getInstance();
    nodeId = (await import('../services/NodeRegistry')).NodeRegistry.getInstance().getDefaultNodeId();
  });

  it('adds labels while preserving existing assignments', () => {
    const a = db.createLabel(nodeId, 'add-pre-a', 'teal');
    const b = db.createLabel(nodeId, 'add-pre-b', 'blue');
    db.setStackLabels('add-pre-stack', nodeId, [a.id]);
    db.addStackLabels('add-pre-stack', nodeId, [b.id]);
    const names = db.getLabelsForStacks(nodeId)['add-pre-stack'].map(l => l.name).sort();
    expect(names).toEqual(['add-pre-a', 'add-pre-b']);
  });

  it('is idempotent on re-add (no duplicate row, no throw)', () => {
    const a = db.createLabel(nodeId, 'idem-a', 'teal');
    db.addStackLabels('idem-stack', nodeId, [a.id]);
    db.addStackLabels('idem-stack', nodeId, [a.id]);
    expect(db.getLabelsForStacks(nodeId)['idem-stack'].filter(l => l.name === 'idem-a')).toHaveLength(1);
  });

  it('throws when a label id does not belong to the node', () => {
    expect(() => db.addStackLabels('bad-id-stack', nodeId, [999999])).toThrow(/invalid for this node/);
  });

  it('no-ops on an empty id list', () => {
    expect(() => db.addStackLabels('empty-id-stack', nodeId, [])).not.toThrow();
    expect(db.getLabelsForStacks(nodeId)['empty-id-stack']).toBeUndefined();
  });
});

describe('bulk-assign orchestrator: local node', () => {
  let db: import('../services/DatabaseService').DatabaseService;
  let nodeId: number;

  beforeAll(async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const { NodeRegistry } = await import('../services/NodeRegistry');
    db = DatabaseService.getInstance();
    nodeId = NodeRegistry.getInstance().getDefaultNodeId();
  });

  afterEach(() => vi.restoreAllMocks());

  it('creates the label on the local node and assigns it, preserving existing labels', async () => {
    makeStack('orch-local');
    const existing = db.createLabel(nodeId, 'orch-existing', 'amber');
    db.setStackLabels('orch-local', nodeId, [existing.id]);
    const res = await request(app)
      .post('/api/fleet/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'orch-media', color: 'teal' }, targets: [{ nodeId, stackNames: ['orch-local'] }] });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    const row = res.body.results[0];
    expect(row.reachable).toBe(true);
    expect(row.created).toBe(true);
    expect(row.stackResults).toEqual([{ stackName: 'orch-local', success: true }]);
    const names = db.getLabelsForStacks(nodeId)['orch-local'].map(l => l.name).sort();
    expect(names).toEqual(['orch-existing', 'orch-media']);
  });

  it('reuses an existing local label (created:false)', async () => {
    makeStack('orch-reuse');
    db.createLabel(nodeId, 'orch-reused', 'cyan');
    const res = await request(app)
      .post('/api/fleet/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'orch-reused', color: 'cyan' }, targets: [{ nodeId, stackNames: ['orch-reuse'] }] });
    expect(res.status).toBe(200);
    expect(res.body.results[0].created).toBe(false);
    expect(res.body.results[0].stackResults).toEqual([{ stackName: 'orch-reuse', success: true }]);
  });

  it('dedupes repeated stack names within a target', async () => {
    makeStack('orch-dedupe');
    const res = await request(app)
      .post('/api/fleet/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'orch-dd', color: 'pink' }, targets: [{ nodeId, stackNames: ['orch-dedupe', 'orch-dedupe'] }] });
    expect(res.status).toBe(200);
    expect(res.body.results[0].stackResults).toEqual([{ stackName: 'orch-dedupe', success: true }]);
  });
});

describe('bulk-assign orchestrator: remote fan-out', () => {
  let db: import('../services/DatabaseService').DatabaseService;
  let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;

  beforeAll(async () => {
    db = (await import('../services/DatabaseService')).DatabaseService.getInstance();
    ({ NodeRegistry } = await import('../services/NodeRegistry'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const n of db.getNodes().filter(n => n.type === 'remote')) db.deleteNode(n.id);
  });

  function addRemote(name: string, mode: 'proxy' | 'pilot_agent' = 'proxy'): number {
    return db.addNode({
      name, type: 'remote', mode,
      compose_dir: '/tmp', is_default: false,
      api_url: mode === 'proxy' ? 'https://remote.example.com:1852' : '',
      api_token: mode === 'proxy' ? 'remote-tok' : '',
    });
  }

  it('fans out to the remote local-assign receiver with Bearer auth and the template body', async () => {
    const remoteId = addRemote('assign-remote-ok');
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({ apiUrl: 'https://remote.example.com:1852', apiToken: 'remote-tok' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ created: true, results: [{ stackName: 'r1', success: true }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const res = await request(app)
      .post('/api/fleet/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'media', color: 'teal' }, targets: [{ nodeId: remoteId, stackNames: ['r1'] }] });

    expect(res.status).toBe(200);
    const row = res.body.results.find((r: { nodeId: number }) => r.nodeId === remoteId);
    expect(row.reachable).toBe(true);
    expect(row.created).toBe(true);
    expect(row.stackResults).toEqual([{ stackName: 'r1', success: true }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toBe('https://remote.example.com:1852/api/fleet-actions/labels/local-assign');
    const init = call[1] as { method: string; headers: Record<string, string>; body: string };
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer remote-tok');
    expect(JSON.parse(init.body)).toEqual({ label: { name: 'media', color: 'teal' }, stackNames: ['r1'] });
  });

  it('omits the Authorization header for a pilot-agent remote with an empty token', async () => {
    const remoteId = addRemote('assign-remote-pilot', 'pilot_agent');
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({ apiUrl: 'http://127.0.0.1:9', apiToken: '' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ created: false, results: [{ stackName: 'p1', success: true }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const res = await request(app)
      .post('/api/fleet/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'media', color: 'teal' }, targets: [{ nodeId: remoteId, stackNames: ['p1'] }] });

    expect(res.status).toBe(200);
    const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  it('reports no-proxy-target as a per-node failure without blocking the request', async () => {
    const remoteId = addRemote('assign-remote-down', 'pilot_agent');
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue(null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await request(app)
      .post('/api/fleet/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'media', color: 'teal' }, targets: [{ nodeId: remoteId, stackNames: ['r1'] }] });

    expect(res.status).toBe(200);
    const row = res.body.results.find((r: { nodeId: number }) => r.nodeId === remoteId);
    expect(row.reachable).toBe(false);
    expect(row.error).toBeTruthy();
    expect(row.stackResults).toEqual([{ stackName: 'r1', success: false, error: row.error }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('treats a mixed-version remote (404 on local-assign) as a per-node failure', async () => {
    const remoteId = addRemote('assign-remote-404');
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({ apiUrl: 'https://remote.example.com:1852', apiToken: 'remote-tok' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Not Found', { status: 404 }));

    const res = await request(app)
      .post('/api/fleet/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'media', color: 'teal' }, targets: [{ nodeId: remoteId, stackNames: ['r1'] }] });

    expect(res.status).toBe(200);
    const row = res.body.results.find((r: { nodeId: number }) => r.nodeId === remoteId);
    expect(row.reachable).toBe(false);
    expect(row.error).toMatch(/404/);
    expect(row.stackResults[0]).toMatchObject({ stackName: 'r1', success: false });
  });

  it('reports a transport failure as a per-node failure', async () => {
    const remoteId = addRemote('assign-remote-transport');
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({ apiUrl: 'https://remote.example.com:1852', apiToken: 'remote-tok' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await request(app)
      .post('/api/fleet/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'media', color: 'teal' }, targets: [{ nodeId: remoteId, stackNames: ['r1'] }] });

    expect(res.status).toBe(200);
    const row = res.body.results.find((r: { nodeId: number }) => r.nodeId === remoteId);
    expect(row.reachable).toBe(false);
    expect(row.stackResults[0]).toMatchObject({ stackName: 'r1', success: false });
  });

  it('reports a malformed 200 body as a per-node failure', async () => {
    const remoteId = addRemote('assign-remote-malformed');
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({ apiUrl: 'https://remote.example.com:1852', apiToken: 'remote-tok' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ created: true, results: 'not-an-array' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const res = await request(app)
      .post('/api/fleet/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ label: { name: 'media', color: 'teal' }, targets: [{ nodeId: remoteId, stackNames: ['r1'] }] });

    expect(res.status).toBe(200);
    const row = res.body.results.find((r: { nodeId: number }) => r.nodeId === remoteId);
    expect(row.reachable).toBe(false);
    expect(row.error).toMatch(/malformed/);
    expect(row.stackResults).toEqual([{ stackName: 'r1', success: false, error: 'Remote returned a malformed response' }]);
  });
});

describe('authoritative fleet label discovery (remote fan-out)', () => {
  let db: import('../services/DatabaseService').DatabaseService;
  let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;

  beforeAll(async () => {
    db = (await import('../services/DatabaseService')).DatabaseService.getInstance();
    ({ NodeRegistry } = await import('../services/NodeRegistry'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const n of db.getNodes().filter(n => n.type === 'remote')) db.deleteNode(n.id);
  });

  function addProxyRemote(name: string): number {
    return db.addNode({
      name, type: 'remote', mode: 'proxy',
      compose_dir: '/tmp', is_default: false,
      api_url: 'https://remote.example.com:1852', api_token: 'remote-tok',
    });
  }

  // The authoritative summary fans out to BOTH /api/labels (all labels) and
  // /api/labels/assignments per remote, so the mock must return a fresh Response
  // per call (a Response body can be read only once) and key off the URL.
  function mockRemoteLabels(labels: unknown, assignments: unknown): void {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = String(url);
      if (u.endsWith('/api/labels/assignments')) return Promise.resolve(okJson(assignments));
      if (u.endsWith('/api/labels')) return Promise.resolve(okJson(labels));
      return Promise.resolve(okJson({}));
    });
  }

  it('suggestions includes a remote-only stack label queried live', async () => {
    const remoteId = addProxyRemote('disc-remote-suggest');
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({ apiUrl: 'https://remote.example.com:1852', apiToken: 'remote-tok' });
    mockRemoteLabels(
      [{ id: 1, node_id: remoteId, name: 'remote-only', color: 'cyan' }],
      { rstack: [{ id: 1, node_id: remoteId, name: 'remote-only', color: 'cyan' }] },
    );

    const res = await request(app).get('/api/fleet/labels/suggestions').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    const found = res.body.suggestions.find((s: { name: string }) => s.name === 'remote-only');
    expect(found).toMatchObject({ name: 'remote-only', scope: 'stack', color: 'cyan', nodeCount: 1, stackCount: 1 });
  });

  it('match-preview resolves remote stacks live and flags unreachable nodes', async () => {
    const remoteId = addProxyRemote('disc-remote-preview');
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({ apiUrl: 'https://remote.example.com:1852', apiToken: 'remote-tok' });
    mockRemoteLabels(
      [{ id: 1, node_id: remoteId, name: 'preview-label', color: 'teal' }],
      { rstack: [{ id: 1, node_id: remoteId, name: 'preview-label', color: 'teal' }] },
    );

    const res = await request(app)
      .post('/api/fleet/labels/match-preview')
      .set('Authorization', authHeader)
      .send({ labelName: 'preview-label' });
    expect(res.status).toBe(200);
    const remoteRow = res.body.perNode.find((n: { nodeId: number }) => n.nodeId === remoteId);
    expect(remoteRow).toMatchObject({ reachable: true, stackCount: 1, stackNames: ['rstack'] });
  });

  it('match-preview marks a remote with no proxy target unreachable', async () => {
    const remoteId = addProxyRemote('disc-remote-unreachable');
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue(null);

    const res = await request(app)
      .post('/api/fleet/labels/match-preview')
      .set('Authorization', authHeader)
      .send({ labelName: 'anything' });
    expect(res.status).toBe(200);
    const remoteRow = res.body.perNode.find((n: { nodeId: number }) => n.nodeId === remoteId);
    expect(remoteRow.reachable).toBe(false);
    expect(remoteRow.error).toBeTruthy();
  });

  it('suggestions excludes a remote that errors and still returns 200', async () => {
    addProxyRemote('disc-remote-500');
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({ apiUrl: 'https://remote.example.com:1852', apiToken: 'remote-tok' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('err', { status: 500 }));

    const res = await request(app).get('/api/fleet/labels/suggestions').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.suggestions)).toBe(true);
  });

  it('match-preview marks a remote that returns a 200 with an unreadable body unreachable', async () => {
    const remoteId = addProxyRemote('disc-remote-garbage');
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({ apiUrl: 'https://remote.example.com:1852', apiToken: 'remote-tok' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }));

    const res = await request(app)
      .post('/api/fleet/labels/match-preview')
      .set('Authorization', authHeader)
      .send({ labelName: 'anything' });
    expect(res.status).toBe(200);
    const remoteRow = res.body.perNode.find((n: { nodeId: number }) => n.nodeId === remoteId);
    expect(remoteRow.reachable).toBe(false);
    expect(remoteRow.error).toBeTruthy();
  });

  it('match-preview marks a remote that returns a 200 with a wrong-shaped body unreachable', async () => {
    const remoteId = addProxyRemote('disc-remote-wrongshape');
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({ apiUrl: 'https://remote.example.com:1852', apiToken: 'remote-tok' });
    // Valid JSON, but /api/labels must be an array; an object is malformed.
    mockRemoteLabels({ not: 'an array' }, {});

    const res = await request(app)
      .post('/api/fleet/labels/match-preview')
      .set('Authorization', authHeader)
      .send({ labelName: 'anything' });
    expect(res.status).toBe(200);
    const remoteRow = res.body.perNode.find((n: { nodeId: number }) => n.nodeId === remoteId);
    expect(remoteRow.reachable).toBe(false);
    expect(remoteRow.error).toMatch(/shape/);
  });

  it('fleet-stop calls the remote local-stop even when the control DB has no label for the remote', async () => {
    const remoteId = addProxyRemote('disc-remote-stop');
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({ apiUrl: 'https://remote.example.com:1852', apiToken: 'remote-tok' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ matched: true, results: [{ stackName: 'rstack', success: true }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const res = await request(app)
      .post('/api/fleet/labels/fleet-stop')
      .set('Authorization', authHeader)
      .send({ labelName: 'remote-mirror-missing' });

    expect(res.status).toBe(200);
    const localStopCall = fetchMock.mock.calls.find(c => String(c[0]).endsWith('/api/fleet-actions/labels/local-stop'));
    expect(localStopCall).toBeTruthy();
    const remoteRow = res.body.results.find((r: { nodeId: number }) => r.nodeId === remoteId);
    expect(remoteRow.matched).toBe(true);
    expect(remoteRow.stackResults).toEqual([{ stackName: 'rstack', success: true }]);
  });

  it('fleet-stop reports an unreachable remote without blocking reachable nodes', async () => {
    const remoteId = addProxyRemote('disc-remote-stop-down');
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue(null);

    const res = await request(app)
      .post('/api/fleet/labels/fleet-stop')
      .set('Authorization', authHeader)
      .send({ labelName: 'whatever' });

    expect(res.status).toBe(200);
    const remoteRow = res.body.results.find((r: { nodeId: number }) => r.nodeId === remoteId);
    expect(remoteRow.reachable).toBe(false);
    expect(remoteRow.error).toBeTruthy();
    // The local node is still present in the results (fan-out not blocked).
    expect(res.body.results.length).toBeGreaterThanOrEqual(2);
  });
});

describe('fleet-stop degrades the local leg per-node instead of failing the whole fan-out', () => {
  let db: import('../services/DatabaseService').DatabaseService;
  let nodeId: number;

  beforeAll(async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const { NodeRegistry } = await import('../services/NodeRegistry');
    db = DatabaseService.getInstance();
    nodeId = NodeRegistry.getInstance().getDefaultNodeId();
  });

  afterEach(() => vi.restoreAllMocks());

  it('returns 200 with per-stack errors when the control filesystem read throws', async () => {
    const label = db.createLabel(nodeId, 'degrade-label', 'slate');
    db.setStackLabels('degrade-stack', nodeId, [label.id]);
    const { FileSystemService } = await import('../services/FileSystemService');
    vi.spyOn(FileSystemService.prototype, 'getStacks').mockRejectedValue(new Error('compose dir unreadable'));

    const res = await request(app)
      .post('/api/fleet/labels/fleet-stop')
      .set('Authorization', authHeader)
      .send({ labelName: 'degrade-label' });

    expect(res.status).toBe(200);
    const localRow = res.body.results.find((r: { nodeId: number }) => r.nodeId === nodeId);
    expect(localRow.matched).toBe(true);
    expect(localRow.stackResults).toEqual([
      { stackName: 'degrade-stack', success: false, error: 'compose dir unreadable' },
    ]);
  });
});
