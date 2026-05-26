/**
 * Confirms Stack Labels CRUD + per-stack assignment is reachable on the
 * Community tier. The per-label bulk-action endpoint stays Skipper+ and is
 * exercised here too to guard against an accidental gate removal in the
 * future.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let viewerAuthHeader: string;
let nodeAdminAuthHeader: string;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ LicenseService } = await import('../services/LicenseService'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  DatabaseService.getInstance().addUser({ username: 'labels-viewer', password_hash: 'hash', role: 'viewer' });
  DatabaseService.getInstance().addUser({ username: 'labels-node-admin', password_hash: 'hash', role: 'node-admin' });
  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
  const viewerToken = jwt.sign({ username: 'labels-viewer' }, TEST_JWT_SECRET, { expiresIn: '1m' });
  const nodeAdminToken = jwt.sign({ username: 'labels-node-admin' }, TEST_JWT_SECRET, { expiresIn: '1m' });
  authHeader = `Bearer ${token}`;
  viewerAuthHeader = `Bearer ${viewerToken}`;
  nodeAdminAuthHeader = `Bearer ${nodeAdminToken}`;
});

afterAll(() => cleanupTestDb(tmpDir));

// Tests in this file accumulate labels in the shared DB; clear them between
// runs so later tests do not bump into MAX_LABELS_PER_NODE.
afterEach(() => {
  const db = DatabaseService.getInstance().getDb();
  db.prepare('DELETE FROM stack_label_assignments').run();
  db.prepare('DELETE FROM stack_labels').run();
});

function mockTier(tier: 'paid' | 'community') {
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue(tier);
}

describe('Stack Labels on Community tier', () => {
  afterEach(() => vi.restoreAllMocks());

  it('GET /api/labels returns 200 (empty array) on community', async () => {
    mockTier('community');
    const res = await request(app).get('/api/labels').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/labels creates a label on community', async () => {
    mockTier('community');
    const res = await request(app)
      .post('/api/labels')
      .set('Authorization', authHeader)
      .send({ name: 'production', color: 'teal' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'production', color: 'teal' });
    expect(typeof res.body.id).toBe('number');
  });

  it('GET /api/labels/assignments returns 200 on community', async () => {
    mockTier('community');
    const res = await request(app).get('/api/labels/assignments').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
  });

  it('PUT /api/labels/:id updates a label on community', async () => {
    mockTier('community');
    const created = await request(app)
      .post('/api/labels')
      .set('Authorization', authHeader)
      .send({ name: 'staging', color: 'blue' });
    expect(created.status).toBe(201);

    const res = await request(app)
      .put(`/api/labels/${created.body.id}`)
      .set('Authorization', authHeader)
      .send({ color: 'rose' });
    expect(res.status).toBe(200);
    expect(res.body.color).toBe('rose');
  });

  it('DELETE /api/labels/:id removes a label on community', async () => {
    mockTier('community');
    const created = await request(app)
      .post('/api/labels')
      .set('Authorization', authHeader)
      .send({ name: 'temp', color: 'amber' });
    expect(created.status).toBe(201);

    const res = await request(app)
      .delete(`/api/labels/${created.body.id}`)
      .set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('allows node-admins to create labels through the stack edit permission', async () => {
    mockTier('community');
    const res = await request(app)
      .post('/api/labels')
      .set('Authorization', nodeAdminAuthHeader)
      .send({ name: 'node-admin-label', color: 'green' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'node-admin-label', color: 'green' });
  });

  it('PUT /api/stacks/:stackName/labels accepts an empty assignment on community', async () => {
    mockTier('community');
    const res = await request(app)
      .put('/api/stacks/some-stack/labels')
      .set('Authorization', authHeader)
      .send({ labelIds: [] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('rejects path traversal stack names before assigning labels', async () => {
    mockTier('community');
    const res = await request(app)
      .put(`/api/stacks/${encodeURIComponent('../secret')}/labels`)
      .set('Authorization', authHeader)
      .send({ labelIds: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid stack name');
  });

  it('rejects labelIds arrays over the per-node cap', async () => {
    mockTier('community');
    const oversized = Array.from({ length: 51 }, (_, i) => i + 1);
    const res = await request(app)
      .put('/api/stacks/cap-stack/labels')
      .set('Authorization', authHeader)
      .send({ labelIds: oversized });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('may not exceed');
  });

  it('accepts labelIds at exactly the per-node cap', async () => {
    mockTier('community');
    // Seed 50 labels directly so the FK check on assignment passes without
    // running 50 HTTP round trips per test. The route resolves nodeId via
    // nodeContextMiddleware (default node when no x-node-id header), so the
    // seeded rows must use the same nodeId the request will look up.
    const { NodeRegistry } = await import('../services/NodeRegistry');
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const db = DatabaseService.getInstance().getDb();
    const insert = db.prepare('INSERT INTO stack_labels (node_id, name, color) VALUES (?, ?, ?)');
    const ids: number[] = [];
    for (let i = 0; i < 50; i++) {
      const r = insert.run(nodeId, `cap-edge-${i}`, 'teal');
      ids.push(r.lastInsertRowid as number);
    }
    const res = await request(app)
      .put('/api/stacks/cap-edge-stack/labels')
      .set('Authorization', authHeader)
      .send({ labelIds: ids });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('Stack Labels RBAC', () => {
  afterEach(() => vi.restoreAllMocks());

  it('allows viewers to read labels but denies label creation', async () => {
    mockTier('community');
    const list = await request(app).get('/api/labels').set('Authorization', viewerAuthHeader);
    expect(list.status).toBe(200);

    const create = await request(app)
      .post('/api/labels')
      .set('Authorization', viewerAuthHeader)
      .send({ name: 'viewer-create', color: 'teal' });
    expect(create.status).toBe(403);
    expect(create.body.code).toBe('PERMISSION_DENIED');
  });

  it('denies viewers label update, delete, and stack assignment', async () => {
    mockTier('community');
    const created = await request(app)
      .post('/api/labels')
      .set('Authorization', authHeader)
      .send({ name: 'rbac-target', color: 'blue' });
    expect(created.status).toBe(201);

    const update = await request(app)
      .put(`/api/labels/${created.body.id}`)
      .set('Authorization', viewerAuthHeader)
      .send({ color: 'rose' });
    expect(update.status).toBe(403);
    expect(update.body.code).toBe('PERMISSION_DENIED');

    const assign = await request(app)
      .put('/api/stacks/rbac-stack/labels')
      .set('Authorization', viewerAuthHeader)
      .send({ labelIds: [created.body.id] });
    expect(assign.status).toBe(403);
    expect(assign.body.code).toBe('PERMISSION_DENIED');

    const remove = await request(app)
      .delete(`/api/labels/${created.body.id}`)
      .set('Authorization', viewerAuthHeader);
    expect(remove.status).toBe(403);
    expect(remove.body.code).toBe('PERMISSION_DENIED');
  });
});

describe('Stack Labels Developer Mode logging', () => {
  afterEach(() => vi.restoreAllMocks());

  it('only emits label debug logs when Developer Mode is enabled', async () => {
    mockTier('community');
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const db = DatabaseService.getInstance();

    db.updateGlobalSetting('developer_mode', '0');
    const quiet = await request(app).get('/api/labels').set('Authorization', authHeader);
    expect(quiet.status).toBe(200);
    expect(debugSpy).not.toHaveBeenCalled();

    db.updateGlobalSetting('developer_mode', '1');
    const noisy = await request(app).get('/api/labels').set('Authorization', authHeader);
    expect(noisy.status).toBe(200);
    expect(debugSpy).toHaveBeenCalledWith(
      '[Labels:debug] List labels: nodeId=',
      expect.any(Number),
      'count=',
      expect.any(Number),
    );
  });
});

describe('Stack Labels bulk-action endpoint stays Skipper+', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POST /api/labels/:id/action returns 403 on community', async () => {
    mockTier('community');
    const res = await request(app)
      .post('/api/labels/1/action')
      .set('Authorization', authHeader)
      .send({ action: 'deploy' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PAID_REQUIRED');
  });
});
