/**
 * The Observe Only scope: the narrowest credential Sencho issues.
 *
 * These cases own the boundary an AI client is handed. The scope may reach
 * exactly five read-only projection GETs; everything else behind the scope gate,
 * the two auth introspection routes mounted ahead of it, creation-time
 * validation, and unknown scope values are pinned here so a future scope change
 * cannot widen the credential silently.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import http from 'http';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { createTestApiToken } from './helpers/apiTokenTestHelper';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let authCookie: string;
let server: http.Server;
let serverPort: number;

/**
 * Mint a token through the shared fixture, then set its stored scope.
 *
 * The scope column is free TEXT, so writing it directly is how a value no build
 * issues is reached. Going through the fixture keeps the hashing in one place
 * instead of repeating it per test file.
 */
function createToken(scope: string, expiresAt: number | null = Date.now() + 60_000): string {
  const db = DatabaseService.getInstance();
  const name = `obs-test-${scope || 'empty'}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const raw = createTestApiToken({
    db: DatabaseService,
    scope: 'read-only',
    userId: db.getUserByUsername('testadmin')!.id,
    name,
    expiresAt,
  });
  db.getDb().prepare('UPDATE api_tokens SET scope = ? WHERE name = ?').run(scope, name);
  return raw;
}

function get(path: string, token?: string) {
  const req = request(app).get(path);
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  const mod = await import('../index');
  app = mod.app;
  server = mod.server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  serverPort = (server.address() as import('net').AddressInfo).port;
  authCookie = await loginAsTestAdmin(app);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanupTestDb(tmpDir);
});

/**
 * Send a path the URL parser would rewrite.
 *
 * Supertest normalizes `..` and `%2e%2e` before the request leaves, so a
 * traversal case has to go over a raw socket to reach the server in the form an
 * attacker would send. Express does not normalize dot segments; the allowlist
 * therefore sees the literal path and refuses it.
 */
function rawGet(path: string, token: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: serverPort,
      path,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Observe Only scope: the allowlist', () => {
  it('reaches the five projection GETs', async () => {
    const token = createToken('observe-only');

    const nodes = await get('/api/fleet/observation/nodes', token);
    expect(nodes.status).toBe(200);
    expect(nodes.body.schemaVersion).toBe(1);

    const health = await get('/api/fleet/observation/health', token);
    expect(health.status).toBe(200);
    expect(health.body.data.domains).not.toContain('control');
    expect(health.body.data.domainsOmitted).toContain('control');

    const list = await get('/api/stacks/platform/observation', token);
    expect(list.status).toBe(200);
    expect(list.body.data.stacks).toEqual([]);

    // Both named routes pass the scope gate and land on the route's own 404,
    // which is the distinction that matters: the credential was allowed in.
    const status = await get('/api/stacks/obs-missing/observation/status', token);
    expect(status.status).toBe(404);
    expect(status.body.code).toBe('STACK_NOT_FOUND');

    const readiness = await get('/api/stacks/obs-missing/observation/readiness', token);
    expect(readiness.status).toBe(404);
    expect(readiness.body.code).toBe('STACK_NOT_FOUND');
  });

  it.each([
    '/api/stacks',
    '/api/stacks/statuses',
    '/api/stacks/readiness-summary',
    '/api/stacks/web/env',
    '/api/stacks/web/envs',
    '/api/stacks/web/files/content',
    '/api/stacks/web/logs',
    '/api/stacks/web/health-observation',
    '/api/stacks/web/observation',
    '/api/stacks/web/observation/status/extra',
    '/api/stacks/web/observation/readiness/extra',
    '/api/nodes',
    '/api/fleet/readiness',
    '/api/fleet/observation',
    '/api/fleet/observation/nodes/extra',
    '/api/fleet/observation/health/extra',
    '/api/settings',
  ])('denies %s', async (path) => {
    const token = createToken('observe-only');
    const res = await get(path, token);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SCOPE_DENIED');
  });

  it.each([
    '/api/stacks/platform/observation/',
    '/api/stacks/web/observation/status/',
    '/api/stacks//platform/observation',
    '/api/stacks/platform%2Fobservation',
    '/api/stacks/web%2Fobservation%2Fstatus',
    '/api/stacks/web/%6fbservation/status',
    '/api/STACKS/platform/observation',
    '/api/stacks/platform/OBSERVATION',
    '/api/stacks/%252e%252e/stacks/platform/observation',
    '/api/fleet/observation/%252e%252e/observation/nodes',
  ])('fails closed on the variant %s', async (path) => {
    const token = createToken('observe-only');
    const res = await get(path, token);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SCOPE_DENIED');
  });

  it.each([
    '/api/stacks/../stacks/platform/observation',
    '/api/stacks/web/observation/../observation/status',
    '/api/fleet/observation/../observation/nodes',
  ])('fails closed on the literal traversal %s over a raw socket', async (path) => {
    // Supertest normalizes dot segments before the request leaves, so a
    // traversal case has to go over a raw socket to reach the server in the
    // form an attacker would send. Express does not normalize them either; the
    // allowlist sees the literal path and refuses it.
    expect(await rawGet(path, createToken('observe-only'))).toBe(403);
  });

  it('denies every write method on an allowed path', async () => {
    const token = createToken('observe-only');
    const path = '/api/fleet/observation/nodes';
    for (const res of [
      await request(app).post(path).set('Authorization', `Bearer ${token}`),
      await request(app).put(path).set('Authorization', `Bearer ${token}`),
      await request(app).patch(path).set('Authorization', `Bearer ${token}`),
      await request(app).delete(path).set('Authorization', `Bearer ${token}`),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SCOPE_DENIED');
    }
  });

  it('lets CORS answer OPTIONS as a bodyless preflight, before any route', async () => {
    // The cors middleware runs at step 4, long before the scope gate, and
    // answers a preflight with 204 and no body for every credential. There is
    // no data to expose, so the assertion is that the response carries none.
    const token = createToken('observe-only');
    const res = await request(app)
      .options('/api/fleet/observation/nodes')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);
    expect(res.text || '').toBe('');
  });

  it('denies HEAD on an allowed path', async () => {
    const token = createToken('observe-only');
    const res = await request(app)
      .head('/api/fleet/observation/nodes')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it.each(['legacy-observer', ''])('refuses a stored scope %j at authentication', async (scope) => {
    // The scope column is free TEXT. A value no build issues (including an
    // empty string, which a truthiness check would read as "not an API token")
    // must fail closed before either gate sees it, with the same uniform 401 as
    // an unknown token.
    const token = createToken(scope);
    for (const path of [
      '/api/fleet/observation/nodes',
      '/api/stacks',
      '/api/auth/check',
      '/api/auth/mfa/status',
    ]) {
      expect((await get(path, token)).status).toBe(401);
    }
  });
});

describe('Observe Only scope: the pre-gate auth routes', () => {
  it('refuses GET /api/auth/check', async () => {
    const token = createToken('observe-only');
    const res = await get('/api/auth/check', token);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SCOPE_DENIED');
  });

  it('refuses GET /api/auth/mfa/status', async () => {
    const token = createToken('observe-only');
    const res = await get('/api/auth/mfa/status', token);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SCOPE_DENIED');
  });

  it('leaves Read Only unchanged on those routes', async () => {
    const token = createToken('read-only');
    expect((await get('/api/auth/check', token)).status).toBe(200);
    expect((await get('/api/auth/mfa/status', token)).status).toBe(200);
  });
});

describe('Observe Only scope: authentication and the rest of the matrix', () => {
  it('makes an authenticated Read Only token able to read the projections', async () => {
    const token = createToken('read-only');
    const res = await get('/api/fleet/observation/nodes', token);
    expect(res.status).toBe(200);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await get('/api/fleet/observation/nodes');
    expect(res.status).toBe(401);
  });

  it('rejects a revoked token with the same 401 as an unknown one', async () => {
    const token = createToken('observe-only');
    const db = DatabaseService.getInstance();
    const row = db.getApiTokensByUser(db.getUserByUsername('testadmin')!.id)
      .find((t) => t.name.startsWith('obs-test-observe-only'))!;
    db.revokeApiToken(row.id);
    const res = await get('/api/fleet/observation/nodes', token);
    expect(res.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const token = createToken('observe-only', Date.now() - 1_000);
    const res = await get('/api/fleet/observation/nodes', token);
    expect(res.status).toBe(401);
  });

  it('names an unknown node with NODE_NOT_FOUND', async () => {
    const token = createToken('observe-only');
    const res = await request(app)
      .get('/api/stacks/platform/observation')
      .set('Authorization', `Bearer ${token}`)
      .set('x-node-id', '99999');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NODE_NOT_FOUND');
  });
});

describe('Creating an Observe Only token', () => {
  // The scope-gate cases above mint one row per case, which is more than the
  // per-user active cap; free the budget so creation is what is under test.
  function revokeAllAdminTokens(): void {
    const db = DatabaseService.getInstance();
    const admin = db.getUserByUsername('testadmin')!;
    for (const token of db.getApiTokensByUser(admin.id)) db.revokeApiToken(token.id);
  }

  it('requires an expiry', async () => {
    revokeAllAdminTokens();
    const res = await request(app)
      .post('/api/api-tokens')
      .set('Cookie', authCookie)
      .send({ name: 'agent-no-expiry', scope: 'observe-only', expires_in: null });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must expire/);
  });

  it('creates the token with a 90-day expiry', async () => {
    const res = await request(app)
      .post('/api/api-tokens')
      .set('Cookie', authCookie)
      .send({ name: 'agent-ninety', scope: 'observe-only', expires_in: 90 });
    expect(res.status).toBe(201);
    expect(typeof res.body.token).toBe('string');

    const listed = await request(app).get('/api/api-tokens').set('Cookie', authCookie);
    const created = listed.body.find((t: { name: string }) => t.name === 'agent-ninety');
    expect(created.scope).toBe('observe-only');
    expect(created.expires_at).toBeGreaterThan(Date.now() + 80 * 24 * 60 * 60 * 1000);
  });

  it('rejects an unknown scope', async () => {
    const res = await request(app)
      .post('/api/api-tokens')
      .set('Cookie', authCookie)
      .send({ name: 'agent-bad-scope', scope: 'observer', expires_in: 30 });
    expect(res.status).toBe(400);
  });
});
