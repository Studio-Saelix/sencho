/**
 * Confirms the node-label routes (list, distinct, per-node read, add, remove)
 * are reachable on the Community tier. Node labels drive fleet grouping and are
 * a free organizational primitive; only the admin role is required for writes.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let viewerAuthHeader: string;
let nodeId: number;
let LicenseService: typeof import('../services/LicenseService').LicenseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ LicenseService } = await import('../services/LicenseService'));
  const { NodeRegistry } = await import('../services/NodeRegistry');
  const { DatabaseService } = await import('../services/DatabaseService');
  nodeId = NodeRegistry.getInstance().getDefaultNodeId();
  DatabaseService.getInstance().addUser({ username: 'node-labels-viewer', password_hash: 'hash', role: 'viewer' });
  authHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;
  viewerAuthHeader = `Bearer ${jwt.sign({ username: 'node-labels-viewer' }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

function mockTier(tier: 'paid' | 'community') {
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue(tier);
}

describe('Node labels on Community tier', () => {
  afterEach(() => vi.restoreAllMocks());

  it('GET /api/node-labels returns 200 on community', async () => {
    mockTier('community');
    const res = await request(app).get('/api/node-labels').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
  });

  it('GET /api/node-labels/all returns 200 on community', async () => {
    mockTier('community');
    const res = await request(app).get('/api/node-labels/all').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.labels)).toBe(true);
  });

  it('POST then DELETE a node label as a Community admin', async () => {
    mockTier('community');
    const add = await request(app)
      .post(`/api/node-labels/${nodeId}`)
      .set('Authorization', authHeader)
      .send({ label: 'community-edge' });
    expect(add.status).toBe(201);
    expect(add.body.label).toBe('community-edge');

    const read = await request(app)
      .get(`/api/node-labels/${nodeId}`)
      .set('Authorization', authHeader);
    expect(read.status).toBe(200);
    expect(read.body.labels).toContain('community-edge');

    const remove = await request(app)
      .delete(`/api/node-labels/${nodeId}/community-edge`)
      .set('Authorization', authHeader);
    expect(remove.status).toBe(204);
  });

  it('denies a non-admin (viewer) the write routes with 403', async () => {
    mockTier('community');
    const add = await request(app)
      .post(`/api/node-labels/${nodeId}`)
      .set('Authorization', viewerAuthHeader)
      .send({ label: 'viewer-denied' });
    expect(add.status).toBe(403);

    const remove = await request(app)
      .delete(`/api/node-labels/${nodeId}/viewer-denied`)
      .set('Authorization', viewerAuthHeader);
    expect(remove.status).toBe(403);
  });
});
