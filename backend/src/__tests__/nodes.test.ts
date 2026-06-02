/**
 * Tests for node management API - focusing on api_url validation (SSRF fix C2).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { disableCapability, enableCapability } from '../services/CapabilityRegistry';
import { NodeRegistry } from '../services/NodeRegistry';
import { CacheService } from '../services/CacheService';
import { DatabaseService } from '../services/DatabaseService';
import { nodeContextMiddleware } from '../middleware/nodeContext';

/** Mint a Bearer for a non-admin user, creating the row if needed so
 *  authMiddleware (which resolves the role from the DB) sees the real role. */
function tokenForRole(username: string, role: 'viewer' | 'deployer'): string {
  const db = DatabaseService.getInstance();
  if (!db.getUserByUsername(username)) {
    db.addUser({ username, password_hash: 'x', role });
  }
  return `Bearer ${jwt.sign({ username }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;
}

async function createRemoteNode(token: string): Promise<number> {
  const res = await request(app)
    .post('/api/nodes')
    .set('Authorization', token)
    .send({
      name: `remote-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: 'remote',
      mode: 'proxy',
      api_url: 'http://192.168.1.77:1852',
      api_token: 'tok-original',
      compose_dir: '/app/compose',
    });
  expect(res.status).toBe(200);
  return res.body.id as number;
}

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
  authHeader = `Bearer ${token}`;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('POST /api/nodes - api_url SSRF validation (C2 fix)', () => {
  it('rejects localhost api_url', async () => {
    const res = await request(app)
      .post('/api/nodes')
      .set('Authorization', authHeader)
      .send({ name: 'bad-node', type: 'remote', api_url: 'http://localhost:6379' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/loopback/i);
  });

  it('rejects 127.0.0.1 api_url', async () => {
    const res = await request(app)
      .post('/api/nodes')
      .set('Authorization', authHeader)
      .send({ name: 'bad-node-2', type: 'remote', api_url: 'http://127.0.0.1:5432' });
    expect(res.status).toBe(400);
  });

  it('rejects non-http scheme', async () => {
    const res = await request(app)
      .post('/api/nodes')
      .set('Authorization', authHeader)
      .send({ name: 'bad-node-3', type: 'remote', api_url: 'ftp://example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/http/i);
  });

  it('rejects malformed URL', async () => {
    const res = await request(app)
      .post('/api/nodes')
      .set('Authorization', authHeader)
      .send({ name: 'bad-node-4', type: 'remote', api_url: 'not-a-url' });
    expect(res.status).toBe(400);
  });

  it('accepts valid LAN IP', async () => {
    const res = await request(app)
      .post('/api/nodes')
      .set('Authorization', authHeader)
      .send({
        name: 'lan-node',
        type: 'remote',
        api_url: 'http://192.168.1.50:1852',
        api_token: 'sometoken',
      });
    // Should succeed (201 or 200) - not a validation error
    expect(res.status).not.toBe(400);
  });

  it('requires api_url for remote nodes', async () => {
    const res = await request(app)
      .post('/api/nodes')
      .set('Authorization', authHeader)
      .send({ name: 'missing-url', type: 'remote' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/nodes/:id/meta - local meta honors runtime-disabled capabilities', () => {
  it('omits a capability that has been disabled at runtime', async () => {
    const list = await request(app).get('/api/nodes').set('Authorization', authHeader);
    const local = (list.body as Array<{ id: number; type: string }>).find((n) => n.type === 'local');
    expect(local).toBeTruthy();

    disableCapability('vulnerability-scanning');
    try {
      const res = await request(app)
        .get(`/api/nodes/${local!.id}/meta`)
        .set('Authorization', authHeader);
      expect(res.status).toBe(200);
      expect(res.body.capabilities).toContain('stacks');
      expect(res.body.capabilities).not.toContain('vulnerability-scanning');
    } finally {
      enableCapability('vulnerability-scanning');
    }
  });
});

describe('POST /api/nodes/:id/test - invalidates remote-meta cache', () => {
  it('drops the cached meta so the next read rebuilds version and capabilities live', async () => {
    const testSpy = vi
      .spyOn(NodeRegistry.getInstance(), 'testConnection')
      .mockResolvedValue({ success: true });
    const invalidateSpy = vi.spyOn(CacheService.getInstance(), 'invalidate');
    try {
      const res = await request(app).post('/api/nodes/7/test').set('Authorization', authHeader);
      expect(res.status).toBe(200);
      expect(testSpy).toHaveBeenCalledWith(7);
      expect(invalidateSpy).toHaveBeenCalledWith('remote-meta:7');
    } finally {
      testSpy.mockRestore();
      invalidateSpy.mockRestore();
    }
  });
});

describe('Stack name validation on GET routes (H3 fix)', () => {
  it('rejects path traversal in GET /api/stacks/:stackName', async () => {
    const res = await request(app)
      .get('/api/stacks/..%2F..%2Fetc%2Fpasswd')
      .set('Authorization', authHeader);
    expect(res.status).toBe(400);
  });

  it('rejects dots in stack name', async () => {
    const res = await request(app)
      .get('/api/stacks/.hidden')
      .set('Authorization', authHeader);
    expect(res.status).toBe(400);
  });
});

describe('Node read endpoints never leak the api_token (C-1)', () => {
  it('GET /api/nodes omits api_token and exposes has_token instead', async () => {
    const id = await createRemoteNode(authHeader);
    const res = await request(app).get('/api/nodes').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    const nodes = res.body as Array<Record<string, unknown>>;
    for (const n of nodes) {
      expect(Object.prototype.hasOwnProperty.call(n, 'api_token')).toBe(false);
      expect(typeof n.has_token).toBe('boolean');
    }
    const created = nodes.find((n) => n.id === id)!;
    expect(created.has_token).toBe(true);
    const local = nodes.find((n) => n.type === 'local')!;
    expect(local.has_token).toBe(false);
  });

  it('GET /api/nodes/:id omits api_token and exposes has_token', async () => {
    const id = await createRemoteNode(authHeader);
    const res = await request(app).get(`/api/nodes/${id}`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(Object.prototype.hasOwnProperty.call(res.body, 'api_token')).toBe(false);
    expect(res.body.has_token).toBe(true);
    // The decrypted secret still lives server-side for the proxy / test paths.
    expect(DatabaseService.getInstance().getNode(id)?.api_token).toBe('tok-original');
  });
});

describe('PUT /api/nodes/:id preserves the token unless a new one is supplied (H-1)', () => {
  it('keeps the stored token when api_token is omitted', async () => {
    const id = await createRemoteNode(authHeader);
    const res = await request(app)
      .put(`/api/nodes/${id}`)
      .set('Authorization', authHeader)
      .send({ name: 'renamed-keep', api_url: 'http://192.168.1.77:1852', compose_dir: '/app/compose' });
    expect(res.status).toBe(200);
    expect(DatabaseService.getInstance().getNode(id)?.api_token).toBe('tok-original');
  });

  it('keeps the stored token when api_token is an empty string', async () => {
    const id = await createRemoteNode(authHeader);
    const res = await request(app)
      .put(`/api/nodes/${id}`)
      .set('Authorization', authHeader)
      .send({ name: 'renamed-blank', api_token: '', api_url: 'http://192.168.1.77:1852', compose_dir: '/app/compose' });
    expect(res.status).toBe(200);
    expect(DatabaseService.getInstance().getNode(id)?.api_token).toBe('tok-original');
  });

  it('rotates the token when a non-empty api_token is supplied', async () => {
    const id = await createRemoteNode(authHeader);
    const res = await request(app)
      .put(`/api/nodes/${id}`)
      .set('Authorization', authHeader)
      .send({ name: 'renamed-rotate', api_token: 'tok-new', api_url: 'http://192.168.1.77:1852', compose_dir: '/app/compose' });
    expect(res.status).toBe(200);
    expect(DatabaseService.getInstance().getNode(id)?.api_token).toBe('tok-new');
  });
});

describe('POST /api/nodes/:id/test authorization (H-3)', () => {
  it('403s a non-admin (viewer) with PERMISSION_DENIED', async () => {
    const id = await createRemoteNode(authHeader);
    const res = await request(app)
      .post(`/api/nodes/${id}/test`)
      .set('Authorization', tokenForRole('node-test-viewer', 'viewer'));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('403s a full-admin API token with SCOPE_DENIED', async () => {
    const id = await createRemoteNode(authHeader);
    const mint = await request(app)
      .post('/api/api-tokens')
      .set('Authorization', authHeader)
      .send({ name: `node-test-reject-${Date.now()}`, scope: 'full-admin' });
    const apiToken = mint.body.token as string;
    expect(apiToken).toBeTruthy();
    const res = await request(app)
      .post(`/api/nodes/${id}/test`)
      .set('Authorization', `Bearer ${apiToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SCOPE_DENIED');
  });
});

describe('nodeContextMiddleware nodeId validation (M-2)', () => {
  type MiddlewareReq = { headers: Record<string, string>; query: Record<string, string>; path: string; nodeId?: number };

  function run(req: MiddlewareReq): { status: number; nextCalled: boolean } {
    let status = 0;
    let nextCalled = false;
    const res = { status: (c: number) => { status = c; return { json: () => undefined }; } };
    nodeContextMiddleware(req as never, res as never, (() => { nextCalled = true; }) as never);
    return { status, nextCalled };
  }

  it('falls back to the default node for a malformed x-node-id instead of 404', () => {
    const req: MiddlewareReq = { headers: { 'x-node-id': 'abc' }, query: {}, path: '/api/stats' };
    const { status, nextCalled } = run(req);
    expect(nextCalled).toBe(true);
    expect(status).toBe(0);
    expect(req.nodeId).toBe(NodeRegistry.getInstance().getDefaultNodeId());
  });

  it('still 404s a well-formed but non-existent node id', () => {
    const req: MiddlewareReq = { headers: { 'x-node-id': '999999' }, query: {}, path: '/api/stats' };
    const { status, nextCalled } = run(req);
    expect(status).toBe(404);
    expect(nextCalled).toBe(false);
  });
});

describe('DELETE /api/nodes/:id default-node guard (M-4)', () => {
  it('400s when deleting the default node', async () => {
    const list = await request(app).get('/api/nodes').set('Authorization', authHeader);
    const def = (list.body as Array<{ id: number; is_default: boolean }>).find((n) => n.is_default)!;
    const res = await request(app).delete(`/api/nodes/${def.id}`).set('Authorization', authHeader);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/default node/i);
  });
});
