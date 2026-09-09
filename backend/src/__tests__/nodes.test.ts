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
    expect(res.body.error).toMatch(/not allowed/i);
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

describe('PUT /api/nodes/:id name collision', () => {
  async function createRemoteWithName(name: string): Promise<number> {
    const res = await request(app)
      .post('/api/nodes')
      .set('Authorization', authHeader)
      .send({
        name,
        type: 'remote',
        mode: 'proxy',
        api_url: 'http://192.168.1.77:1852',
        api_token: 'tok-name-collision',
        compose_dir: '/app/compose',
      });
    expect(res.status).toBe(200);
    return res.body.id as number;
  }

  it('rejects a colliding rename with 409 and leaves the row untouched', async () => {
    const aId = await createRemoteWithName(`collide-a-${Date.now()}`);
    const bId = await createRemoteWithName(`collide-b-${Date.now()}`);
    const bName = DatabaseService.getInstance().getNode(bId)!.name;
    const aBefore = DatabaseService.getInstance().getNode(aId)!;

    const res = await request(app)
      .put(`/api/nodes/${aId}`)
      .set('Authorization', authHeader)
      .send({ name: bName });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A node with that name already exists');

    const aAfter = DatabaseService.getInstance().getNode(aId)!;
    expect(aAfter.name).toBe(aBefore.name);
    expect(aAfter.compose_dir).toBe(aBefore.compose_dir);
    expect(aAfter.api_url).toBe(aBefore.api_url);
  });

  it('allows renaming a node to its own current name', async () => {
    const id = await createRemoteWithName(`same-name-${Date.now()}`);
    const name = DatabaseService.getInstance().getNode(id)!.name;
    const res = await request(app)
      .put(`/api/nodes/${id}`)
      .set('Authorization', authHeader)
      .send({ name });
    expect(res.status).toBe(200);
  });

  it('treats names that differ only by case as distinct', async () => {
    const bName = `case-prod-${Date.now()}`;
    await createRemoteWithName(bName);
    const aId = await createRemoteWithName(`other-${Date.now()}`);
    const res = await request(app)
      .put(`/api/nodes/${aId}`)
      .set('Authorization', authHeader)
      .send({ name: bName.toUpperCase() });
    expect(res.status).toBe(200);
  });

  it('rejects a blank name with 400', async () => {
    const id = await createRemoteWithName(`blank-name-${Date.now()}`);
    const res = await request(app)
      .put(`/api/nodes/${id}`)
      .set('Authorization', authHeader)
      .send({ name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Node name is required');
  });

  it('rejects a null name with 400 instead of a raw SQLite 500', async () => {
    const id = await createRemoteWithName(`null-name-${Date.now()}`);
    const res = await request(app)
      .put(`/api/nodes/${id}`)
      .set('Authorization', authHeader)
      .send({ name: null });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Node name is required');
  });

  it('allows saving a whitespace-only name unchanged', async () => {
    // POST accepts whitespace-only names (truthiness check), so a legacy node
    // may carry one; the full-form echo on Save must not 400 it.
    const id = await createRemoteWithName('   ');
    const save = await request(app)
      .put(`/api/nodes/${id}`)
      .set('Authorization', authHeader)
      .send({ name: '   ' });
    expect(save.status).toBe(200);
  });

  it('still updates other fields when name is absent', async () => {
    const id = await createRemoteWithName(`partial-update-${Date.now()}`);
    const res = await request(app)
      .put(`/api/nodes/${id}`)
      .set('Authorization', authHeader)
      .send({ compose_dir: '/tmp/renamed-compose' });
    expect(res.status).toBe(200);
    const node = DatabaseService.getInstance().getNode(id)!;
    expect(node.compose_dir).toBe('/tmp/renamed-compose');
    expect(node.name).toMatch(/^partial-update-/);
  });

  it('remaps a UNIQUE constraint from the DB to a clean 409', async () => {
    const id = await createRemoteWithName(`unique-race-${Date.now()}`);
    const uniqueErr = Object.assign(new Error('UNIQUE constraint failed: nodes.name'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
    const spy = vi.spyOn(DatabaseService.getInstance(), 'updateNode').mockImplementation(() => { throw uniqueErr; });
    try {
      const res = await request(app)
        .put(`/api/nodes/${id}`)
        .set('Authorization', authHeader)
        .send({ name: 'race-rename' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('A node with that name already exists');
      expect(res.body.error).not.toMatch(/UNIQUE/);
    } finally {
      spy.mockRestore();
    }
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

// ---- helpers for singleton tests ----

function getLocalNodeId(): number {
  return DatabaseService.getInstance().getNodes().find(n => n.type === 'local')!.id;
}

async function makeRemoteDefault(token: string): Promise<{ remoteId: number; originalDefaultId: number }> {
  const list = await request(app).get('/api/nodes').set('Authorization', token);
  const originalDefault = (list.body as Array<{ id: number; is_default: boolean }>).find(n => n.is_default)!;
  const remoteId = await createRemoteNode(token);
  await request(app)
    .put(`/api/nodes/${remoteId}`)
    .set('Authorization', token)
    .send({ is_default: true });
  return { remoteId, originalDefaultId: originalDefault.id };
}

async function restoreDefault(token: string, defaultId: number): Promise<void> {
  await request(app)
    .put(`/api/nodes/${defaultId}`)
    .set('Authorization', token)
    .send({ is_default: true });
}

/** Insert a second local node via raw SQL, bypassing the addNode singleton guard. */
function insertLegacyLocal(name: string, isDefault = false): number {
  const db = DatabaseService.getInstance().getDb();
  if (isDefault) {
    db.prepare('UPDATE nodes SET is_default = 0').run();
  }
  const result = db.prepare(
    "INSERT INTO nodes (name, type, compose_dir, is_default, status, created_at) VALUES (?, 'local', ?, ?, 'online', ?)"
  ).run(name, process.env.COMPOSE_DIR ?? '', isDefault ? 1 : 0, Date.now());
  return result.lastInsertRowid as number;
}

// ---- singleton enforcement (HTTP layer) ----

describe('Local node singleton enforcement', () => {
  it('POST rejects a second local node with 409', async () => {
    const res = await request(app)
      .post('/api/nodes')
      .set('Authorization', authHeader)
      .send({ name: 'second-local', type: 'local', compose_dir: '/app/compose' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/a local node already exists/i);
  });

  it('POST local with is_default:true does not clear the existing default when rejected', async () => {
    const listBefore = await request(app).get('/api/nodes').set('Authorization', authHeader);
    const defBefore = (listBefore.body as Array<{ id: number; is_default: boolean }>).find(n => n.is_default)!;

    const res = await request(app)
      .post('/api/nodes')
      .set('Authorization', authHeader)
      .send({ name: 'rejected-local', type: 'local', is_default: true, compose_dir: '/app/compose' });
    expect(res.status).toBe(409);

    const listAfter = await request(app).get('/api/nodes').set('Authorization', authHeader);
    const defAfter = (listAfter.body as Array<{ id: number; is_default: boolean }>).find(n => n.is_default)!;
    expect(defAfter.id).toBe(defBefore.id);
  });

  it('PUT rejects type change from local to remote with 400', async () => {
    const localId = getLocalNodeId();
    const res = await request(app)
      .put(`/api/nodes/${localId}`)
      .set('Authorization', authHeader)
      .send({ type: 'remote' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be changed/i);
  });

  it('PUT rejects type change from remote to local with 400', async () => {
    const remoteId = await createRemoteNode(authHeader);
    const res = await request(app)
      .put(`/api/nodes/${remoteId}`)
      .set('Authorization', authHeader)
      .send({ type: 'local' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be changed/i);
  });

  it('PUT rejects invalid type value with 400', async () => {
    const localId = getLocalNodeId();
    const res = await request(app)
      .put(`/api/nodes/${localId}`)
      .set('Authorization', authHeader)
      .send({ type: 'invalid' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be "local" or "remote"/i);
  });

  it('PUT allows renaming the local node', async () => {
    const localId = getLocalNodeId();
    const originalName = DatabaseService.getInstance().getNode(localId)!.name;
    try {
      const res = await request(app)
        .put(`/api/nodes/${localId}`)
        .set('Authorization', authHeader)
        .send({ name: 'Renamed Local' });
      expect(res.status).toBe(200);
      expect(DatabaseService.getInstance().getNode(localId)!.name).toBe('Renamed Local');
    } finally {
      DatabaseService.getInstance().updateNode(localId, { name: originalName });
    }
  });

  it('PUT allows changing compose_dir on the local node', async () => {
    const localId = getLocalNodeId();
    const originalDir = DatabaseService.getInstance().getNode(localId)!.compose_dir;
    try {
      const res = await request(app)
        .put(`/api/nodes/${localId}`)
        .set('Authorization', authHeader)
        .send({ compose_dir: '/tmp/test-compose' });
      expect(res.status).toBe(200);
      expect(DatabaseService.getInstance().getNode(localId)!.compose_dir).toBe('/tmp/test-compose');
    } finally {
      DatabaseService.getInstance().updateNode(localId, { compose_dir: originalDir });
    }
  });

  it('DELETE rejects the last local node with 400', async () => {
    const { remoteId, originalDefaultId } = await makeRemoteDefault(authHeader);
    try {
      const res = await request(app)
        .delete(`/api/nodes/${originalDefaultId}`)
        .set('Authorization', authHeader);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/only local node/i);
    } finally {
      await restoreDefault(authHeader, originalDefaultId);
      const db = DatabaseService.getInstance();
      if (db.getNode(remoteId)) db.deleteNode(remoteId);
    }
  });

  it('DELETE allows removing an extra local when more than one exists', async () => {
    const extraId = insertLegacyLocal('legacy-extra-local');
    try {
      const remoteId = await createRemoteNode(authHeader);
      await request(app)
        .put(`/api/nodes/${remoteId}`)
        .set('Authorization', authHeader)
        .send({ is_default: true });
      try {
        const res = await request(app)
          .delete(`/api/nodes/${extraId}`)
          .set('Authorization', authHeader);
        expect(res.status).toBe(200);
        expect(DatabaseService.getInstance().getLocalNodeCount()).toBe(1);
      } finally {
        await restoreDefault(authHeader, getLocalNodeId());
        const db = DatabaseService.getInstance();
        if (db.getNode(remoteId)) db.deleteNode(remoteId);
      }
    } finally {
      const db = DatabaseService.getInstance();
      if (db.getNode(extraId)) db.deleteNode(extraId);
    }
  });
});

// ---- DatabaseService direct enforcement ----

describe('DatabaseService direct local-node enforcement', () => {
  it('addNode throws when a second local is inserted directly', () => {
    const db = DatabaseService.getInstance();
    expect(() => db.addNode({
      name: 'direct-second-local',
      type: 'local',
      compose_dir: '/app/compose',
      is_default: false,
      api_url: '',
      api_token: '',
    })).toThrow(/a local node already exists/i);
  });

  it('addNode with is_default:true does not clear existing default when it throws', () => {
    const db = DatabaseService.getInstance();
    const defaultBefore = db.getDefaultNode()!.id;
    expect(() => db.addNode({
      name: 'direct-rejected-local',
      type: 'local',
      compose_dir: '/app/compose',
      is_default: true,
      api_url: '',
      api_token: '',
    })).toThrow(/a local node already exists/i);
    expect(db.getDefaultNode()!.id).toBe(defaultBefore);
  });

  it('updateNode throws when type is changed', () => {
    const db = DatabaseService.getInstance();
    const localId = getLocalNodeId();
    expect(() => db.updateNode(localId, { type: 'remote' as any })).toThrow(/cannot be changed/i);
  });

  it('deleteNode throws when the last local is deleted directly', () => {
    const db = DatabaseService.getInstance();
    const localId = getLocalNodeId();
    const remoteId = db.addNode({
      name: `direct-remote-${Date.now()}`,
      type: 'remote',
      mode: 'proxy',
      compose_dir: '/app/compose',
      is_default: true,
      api_url: 'http://192.168.1.77:1852',
      api_token: 'tok',
    });
    try {
      expect(() => db.deleteNode(localId)).toThrow(/only local node/i);
    } finally {
      db.updateNode(localId, { is_default: true });
      db.deleteNode(remoteId);
    }
  });

  it('addNode auto-assigns is_default when creating a local during zero-local recovery', () => {
    const db = DatabaseService.getInstance();
    const localId = getLocalNodeId();
    const originalType = db.getNode(localId)!.type;
    // Temporarily remove the only local by flipping its type, simulating a
    // legacy DB with remotes only.
    db.getDb().prepare("UPDATE nodes SET type = 'remote' WHERE id = ?").run(localId);
    let newId: number | undefined;
    try {
      newId = db.addNode({
        name: 'recovery-local',
        type: 'local',
        compose_dir: '/app/compose',
        is_default: false,
        api_url: '',
        api_token: '',
      });
      expect(db.getNode(newId)!.is_default).toBe(true);
    } finally {
      // Restore the original local identity. The recovery node was made
      // default; re-assign to the original before cleanup.
      db.getDb().prepare("UPDATE nodes SET type = ? WHERE id = ?").run(originalType, localId);
      if (newId !== undefined && db.getNode(newId)) {
        db.updateNode(localId, { is_default: true });
        db.deleteNode(newId);
      }
    }
  });
});

// ---- startup warnings ----

describe('logLocalNodeWarnings', () => {
  it('warns when there are zero local nodes', () => {
    const db = DatabaseService.getInstance();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const localId = getLocalNodeId();
      const originalType = db.getNode(localId)!.type;
      db.getDb().prepare("UPDATE nodes SET type = 'remote' WHERE id = ?").run(localId);
      try {
        db.logLocalNodeWarnings();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No local node found'));
      } finally {
        db.getDb().prepare('UPDATE nodes SET type = ? WHERE id = ?').run(originalType, localId);
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warns when there are multiple local nodes', () => {
    const db = DatabaseService.getInstance();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const extraId = insertLegacyLocal('warn-extra-local');
    try {
      db.logLocalNodeWarnings();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Found 2 local nodes'));
    } finally {
      warnSpy.mockRestore();
      if (db.getNode(extraId)) db.deleteNode(extraId);
    }
  });

  it('does not warn when exactly one local node exists', () => {
    const db = DatabaseService.getInstance();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      db.logLocalNodeWarnings();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
