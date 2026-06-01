/**
 * Tests for the Fleet Actions tab endpoints. Covers auth, tier gating, input
 * validation, and orchestration shape across the two routes.
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

describe('Fleet Actions endpoints require authentication', () => {
  it('POST /api/fleet-actions/labels/bulk-assign returns 401 without auth', async () => {
    const res = await request(app).post('/api/fleet-actions/labels/bulk-assign').send({ assignments: [] });
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

  it('POST /api/fleet-actions/labels/bulk-assign is reachable on community tier for admins', async () => {
    mockTier('community');
    const res = await request(app)
      .post('/api/fleet-actions/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ assignments: [] });
    expect(res.status).toBe(200);
    expect(res.body.code).not.toBe('PAID_REQUIRED');
    expect(res.body.results).toEqual([]);
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

  it('POST /api/fleet-actions/labels/bulk-assign rejects non-array assignments', async () => {
    const res = await request(app)
      .post('/api/fleet-actions/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ assignments: 'oops' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/assignments must be an array/);
  });

  it('POST /api/fleet-actions/labels/bulk-assign rejects oversized payload', async () => {
    const big = Array.from({ length: 1001 }, (_, i) => ({ stackName: `s${i}`, labelIds: [] }));
    const res = await request(app)
      .post('/api/fleet-actions/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ assignments: big });
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

  it('POST /api/fleet-actions/labels/bulk-assign accepts empty assignments and returns empty results', async () => {
    const res = await request(app)
      .post('/api/fleet-actions/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ assignments: [] });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('POST /api/fleet-actions/labels/bulk-assign rejects an entry with bad stack name in-line', async () => {
    const res = await request(app)
      .post('/api/fleet-actions/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ assignments: [{ stackName: 'has spaces!', labelIds: [1] }] });
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ success: false, error: 'Invalid stack name' });
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
    db.createLabel(nodeId, 'no-stacks-label', '#ffffff');
    const res = await request(app)
      .post('/api/fleet-actions/labels/local-stop')
      .set('Authorization', authHeader)
      .send({ labelName: 'no-stacks-label' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ matched: true, results: [] });
  });

  it('reports per-stack lock contention when a bulk action is already running on the node', async () => {
    const label = db.createLabel(nodeId, 'busy-label', '#ffffff');
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
    const composeDir = process.env.COMPOSE_DIR as string;
    fs.mkdirSync(path.join(composeDir, 'dry-stack'), { recursive: true });
    fs.writeFileSync(path.join(composeDir, 'dry-stack', 'docker-compose.yml'), 'services: {}\n');
    const label = db.createLabel(nodeId, 'dry-label', '#ffffff');
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
    const label = db.createLabel(nodeId, 'ghost-label', '#ffffff');
    db.setStackLabels('ghost-stack', nodeId, [label.id]);
    const res = await request(app)
      .post('/api/fleet-actions/labels/local-stop')
      .set('Authorization', authHeader)
      .send({ labelName: 'ghost-label' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ matched: true, results: [] });
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
    const label = db.createLabel(nodeId, 'degrade-label', '#ffffff');
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
