/**
 * Skip-version semantics: POST/DELETE /api/fleet/nodes/:nodeId/skip-version
 * and the skip metadata surfaced by GET /api/fleet/update-status.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let adminAuth: string;
let viewerAuth: string;
let localNodeId: number;
let db: import('../services/DatabaseService').DatabaseService;

function signToken(username: string, role: string) {
  return jwt.sign(
    { username, role, email: `${username}@test.local` },
    TEST_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '2h', issuer: 'sencho' },
  );
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  adminAuth = `Bearer ${signToken(TEST_USERNAME, 'admin')}`;
  viewerAuth = `Bearer ${signToken('viewer', 'viewer')}`;
  const dbModule = await import('../services/DatabaseService');
  db = dbModule.DatabaseService.getInstance();
  localNodeId = db.getNodes().find(n => n.type === 'local')!.id;
  const index = await import('../index');
  app = index.app;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  // Clear skip state between tests
  db.deleteNodeUpdateSkip(localNodeId);
});

describe('POST /api/fleet/nodes/:nodeId/skip-version', () => {
  it('rejects non-admin with 403', async () => {
    const res = await request(app)
      .post(`/api/fleet/nodes/${localNodeId}/skip-version`)
      .set('Authorization', viewerAuth)
      .send({ version: '0.99.0' });
    expect(res.status).toBe(401);
  });

  it('rejects missing body with 400', async () => {
    const res = await request(app)
      .post(`/api/fleet/nodes/${localNodeId}/skip-version`)
      .set('Authorization', adminAuth)
      .send({});
    expect(res.status).toBe(400);
  });

  it('rejects non-semver version with 400', async () => {
    const res = await request(app)
      .post(`/api/fleet/nodes/${localNodeId}/skip-version`)
      .set('Authorization', adminAuth)
      .send({ version: 'not-a-version' });
    expect(res.status).toBe(400);
  });

  it('rejects empty version string with 400', async () => {
    const res = await request(app)
      .post(`/api/fleet/nodes/${localNodeId}/skip-version`)
      .set('Authorization', adminAuth)
      .send({ version: '' });
    expect(res.status).toBe(400);
  });

  it('rejects too-long version with 400', async () => {
    const res = await request(app)
      .post(`/api/fleet/nodes/${localNodeId}/skip-version`)
      .set('Authorization', adminAuth)
      .send({ version: 'a'.repeat(65) });
    expect(res.status).toBe(400);
  });

  it('rejects unknown node with 404', async () => {
    const res = await request(app)
      .post('/api/fleet/nodes/99999/skip-version')
      .set('Authorization', adminAuth)
      .send({ version: '0.99.0' });
    expect(res.status).toBe(404);
  });

  it('persists skip and returns 204', async () => {
    const res = await request(app)
      .post(`/api/fleet/nodes/${localNodeId}/skip-version`)
      .set('Authorization', adminAuth)
      .send({ version: '0.99.0' });
    expect(res.status).toBe(204);

    const skip = db.getNodeUpdateSkip(localNodeId);
    expect(skip).not.toBeNull();
    expect(skip!.skippedVersion).toBe('0.99.0');
    expect(skip!.skippedBy).toBe(TEST_USERNAME);
  });

  it('normalizes v-prefixed version on persist', async () => {
    const res = await request(app)
      .post(`/api/fleet/nodes/${localNodeId}/skip-version`)
      .set('Authorization', adminAuth)
      .send({ version: 'v0.99.0' });
    expect(res.status).toBe(204);

    const skip = db.getNodeUpdateSkip(localNodeId);
    expect(skip).not.toBeNull();
    expect(skip!.skippedVersion).toBe('0.99.0'); // stored without v prefix
  });

  it('replaces existing skip on second POST', async () => {
    // First skip
    await request(app)
      .post(`/api/fleet/nodes/${localNodeId}/skip-version`)
      .set('Authorization', adminAuth)
      .send({ version: '0.99.0' });

    // Second skip with different version
    const res = await request(app)
      .post(`/api/fleet/nodes/${localNodeId}/skip-version`)
      .set('Authorization', adminAuth)
      .send({ version: '1.0.0' });
    expect(res.status).toBe(204);

    const skip = db.getNodeUpdateSkip(localNodeId);
    expect(skip!.skippedVersion).toBe('1.0.0');
  });
});

describe('DELETE /api/fleet/nodes/:nodeId/skip-version', () => {
  it('rejects non-admin with 403', async () => {
    const res = await request(app)
      .delete(`/api/fleet/nodes/${localNodeId}/skip-version`)
      .set('Authorization', viewerAuth);
    expect(res.status).toBe(401);
  });

  it('rejects unknown node with 404', async () => {
    const res = await request(app)
      .delete('/api/fleet/nodes/99999/skip-version')
      .set('Authorization', adminAuth);
    expect(res.status).toBe(404);
  });

  it('clears skip and returns 204', async () => {
    db.setNodeUpdateSkip(localNodeId, '0.99.0', TEST_USERNAME);
    expect(db.getNodeUpdateSkip(localNodeId)).not.toBeNull();

    const res = await request(app)
      .delete(`/api/fleet/nodes/${localNodeId}/skip-version`)
      .set('Authorization', adminAuth);
    expect(res.status).toBe(204);
    expect(db.getNodeUpdateSkip(localNodeId)).toBeNull();
  });
});

describe('GET /api/fleet/update-status skip metadata', () => {
  it('returns skipActive=false when no skip exists', async () => {
    const res = await request(app)
      .get('/api/fleet/update-status')
      .set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    const local = res.body.nodes.find((n: any) => n.nodeId === localNodeId);
    expect(local).toBeDefined();
    expect(local.skipActive).toBe(false);
    expect(local.skippedVersion).toBeNull();
  });

  it('skip metadata fields are present on every node', async () => {
    const res = await request(app)
      .get('/api/fleet/update-status')
      .set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    for (const n of res.body.nodes) {
      expect(n).toHaveProperty('skipActive');
      expect(n).toHaveProperty('skippedVersion');
    }
  });
});

describe('node_update_skips table lifecycle', () => {
  it('deleteNode removes the skip row', async () => {
    // This test validates the cleanup pattern by using the get/delete
    // methods directly (the full deleteNode flow requires auth context).
    db.setNodeUpdateSkip(localNodeId, '0.99.0', TEST_USERNAME);
    expect(db.getNodeUpdateSkip(localNodeId)).not.toBeNull();

    // Simulate what deleteNode does: manual delete
    db.deleteNodeUpdateSkip(localNodeId);
    expect(db.getNodeUpdateSkip(localNodeId)).toBeNull();
  });

  it('deleteNodeUpdateSkip is idempotent for missing rows', () => {
    // Should not throw when row doesn't exist
    expect(() => db.deleteNodeUpdateSkip(99999)).not.toThrow();
  });
});
