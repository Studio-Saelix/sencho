import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let adminAuth: string;
let viewerAuth: string;
let db: import('../services/DatabaseService').DatabaseService;
let remoteNodeId: number;

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
  remoteNodeId = db.addNode({
    name: 'seal-route-remote',
    type: 'remote',
    compose_dir: '/app/compose',
    is_default: false,
    api_url: 'http://192.168.1.60:1852',
    api_token: 'token',
    mode: 'proxy',
  });
  const index = await import('../index');
  app = index.app;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('DELETE /api/nodes/:id/sealing-key', () => {
  it('rejects viewers with 401/403', async () => {
    const res = await request(app)
      .delete(`/api/nodes/${remoteNodeId}/sealing-key`)
      .set('Authorization', viewerAuth);
    expect([401, 403]).toContain(res.status);
  });

  it('clears the pin and returns 204 for node:manage', async () => {
    db.pinNodeSealingKey(remoteNodeId, 'pubkey-z', 'fp-z');
    const res = await request(app)
      .delete(`/api/nodes/${remoteNodeId}/sealing-key`)
      .set('Authorization', adminAuth);
    expect(res.status).toBe(204);
    expect(db.getNodeSealingKey(remoteNodeId)).toBeNull();
  });

  it('surfaces the fingerprint on GET /api/nodes/:id', async () => {
    db.pinNodeSealingKey(remoteNodeId, 'pubkey-y', 'fp-y');
    const res = await request(app)
      .get(`/api/nodes/${remoteNodeId}`)
      .set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.sealingKeyFingerprint).toBe('fp-y');
    expect(res.body.api_token).toBeUndefined();
  });
});
