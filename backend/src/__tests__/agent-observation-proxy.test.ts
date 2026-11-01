/**
 * The observation surface through the remote proxy.
 *
 * Three properties matter here. The capability gate runs before the
 * mixed-version RBAC gate, so an older node reads as `unsupported` (a 400 with a
 * code) rather than as a permission problem. The gate runs for every caller,
 * not only non-admins, because it is about the node's version. And the paths it
 * matches are the same ones the local routers serve, trailing slash included.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { createTestApiToken } from './helpers/apiTokenTestHelper';

let tmpDir: string;
let app: import('express').Express;
let viewerBearer: string;
let adminBearer: string;
let capServer: http.Server;
let noCapServer: http.Server;
let capNodeId: number;
let noCapNodeId: number;
let downNodeId: number;
let metaErrorServer: http.Server;
let metaErrorNodeId: number;
let metaMalformedServer: http.Server;
let metaMalformedNodeId: number;
let pilotNodeId: number;
let rejectingServer: http.Server;
let rejectingNodeId: number;

const capPaths: string[] = [];
const noCapPaths: string[] = [];

function metaServer(capabilities: string[], seen: string[]): http.Server {
  return http.createServer((req, res) => {
    if (req.url) seen.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url?.startsWith('/api/meta')) {
      res.end(JSON.stringify({ version: '0.99.0', capabilities }));
    } else {
      res.end(JSON.stringify({ schemaVersion: 1, generatedAt: 1, data: { remote: true } }));
    }
  });
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as import('net').AddressInfo).port;
}

function observationCalls(seen: string[]): string[] {
  return seen.filter((p) => p.startsWith('/api/meta') === false);
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  const { DatabaseService } = await import('../services/DatabaseService');
  const db = DatabaseService.getInstance();

  const hash = await (await import('bcrypt')).default.hash('password123', 1);
  db.addUser({ username: 'obs-viewer', password_hash: hash, role: 'viewer' });
  const viewer = db.getUserByUsername('obs-viewer')!;
  viewerBearer = jwt.sign(
    { username: 'obs-viewer', role: 'viewer', tv: viewer.token_version },
    TEST_JWT_SECRET,
    { expiresIn: '1m' },
  );
  adminBearer = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });

  capServer = metaServer(['cross-node-rbac', 'agent-observation-v1'], capPaths);
  noCapServer = metaServer(['cross-node-rbac'], noCapPaths);
  const capPort = await listen(capServer);
  const noCapPort = await listen(noCapServer);

  capNodeId = db.addNode({
    name: 'obs-cap-remote', type: 'remote', mode: 'proxy', compose_dir: '/tmp',
    is_default: false, api_url: `http://127.0.0.1:${capPort}`, api_token: 'cap-token',
  });
  // A port nothing listens on: bind a server, learn its port, close it.
  const downServer = http.createServer();
  const downPort = await listen(downServer);
  await new Promise<void>((resolve) => downServer.close(() => resolve()));
  downNodeId = db.addNode({
    name: 'obs-down-remote', type: 'remote', mode: 'proxy', compose_dir: '/tmp',
    is_default: false, api_url: `http://127.0.0.1:${downPort}`, api_token: 'down-token',
  });
  // A remote whose /api/meta answers 500, and one whose /api/meta is not Sencho's shape.
  metaErrorServer = http.createServer((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  metaMalformedServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>not sencho</html>');
  });
  const metaErrorPort = await listen(metaErrorServer);
  const metaMalformedPort = await listen(metaMalformedServer);
  metaErrorNodeId = db.addNode({
    name: 'obs-meta-error-remote', type: 'remote', mode: 'proxy', compose_dir: '/tmp',
    is_default: false, api_url: `http://127.0.0.1:${metaErrorPort}`, api_token: 'err-token',
  });
  metaMalformedNodeId = db.addNode({
    name: 'obs-meta-malformed-remote', type: 'remote', mode: 'proxy', compose_dir: '/tmp',
    is_default: false, api_url: `http://127.0.0.1:${metaMalformedPort}`, api_token: 'mal-token',
  });
  // Pilot node with no tunnel connected.
  pilotNodeId = db.addNode({
    name: 'obs-pilot-remote', type: 'remote', mode: 'pilot_agent', compose_dir: '/tmp', is_default: false,
  });
  // A remote whose /api/meta is public (answers 200 whatever the bearer) but whose
  // authenticated routes reject the stored token, as a node does after its token
  // was regenerated.
  rejectingServer = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/meta')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '0.99.0', capabilities: ['cross-node-rbac', 'agent-observation-v1'] }));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or expired token' }));
    }
  });
  const rejectingPort = await listen(rejectingServer);
  rejectingNodeId = db.addNode({
    name: 'obs-rejecting-remote', type: 'remote', mode: 'proxy', compose_dir: '/tmp',
    is_default: false, api_url: `http://127.0.0.1:${rejectingPort}`, api_token: 'stale-token',
  });
  noCapNodeId = db.addNode({
    name: 'obs-nocap-remote', type: 'remote', mode: 'proxy', compose_dir: '/tmp',
    is_default: false, api_url: `http://127.0.0.1:${noCapPort}`, api_token: 'nocap-token',
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => capServer.close(() => resolve()));
  await new Promise<void>((resolve) => noCapServer.close(() => resolve()));
  await new Promise<void>((resolve) => metaErrorServer.close(() => resolve()));
  await new Promise<void>((resolve) => metaMalformedServer.close(() => resolve()));
  await new Promise<void>((resolve) => rejectingServer.close(() => resolve()));
  cleanupTestDb(tmpDir);
});

describe('remote capability gate', () => {
  it('answers 400 capability_unavailable when the remote lacks agent-observation-v1', async () => {
    noCapPaths.length = 0;
    const res = await request(app)
      .get('/api/stacks/web/observation/status')
      .set('Authorization', `Bearer ${adminBearer}`)
      .set('x-node-id', String(noCapNodeId));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('capability_unavailable');
    expect(observationCalls(noCapPaths)).toEqual([]);
    expect(noCapPaths.some((p) => p.startsWith('/api/meta'))).toBe(true);
  });

  it('answers 400, not 403, for a non-admin viewer on an older node', async () => {
    noCapPaths.length = 0;
    const res = await request(app)
      .get('/api/stacks/web/observation/readiness')
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(noCapNodeId));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('capability_unavailable');
  });

  it('gates the collapsed stack list path too, trailing slash included', async () => {
    noCapPaths.length = 0;
    const res = await request(app)
      .get('/api/stacks/platform/observation/')
      .set('Authorization', `Bearer ${adminBearer}`)
      .set('x-node-id', String(noCapNodeId));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('capability_unavailable');
  });

  it.each([
    ['/api/stacks/web/observation/status'],
    ['/api/stacks/web/observation/readiness'],
    ['/api/stacks/platform/observation'],
    ['/api/stacks/platform/observation/'],
  ])('answers 503 node_unreachable, not "upgrade it", when the remote is down: %s', async (path) => {
    for (const bearer of [adminBearer, viewerBearer]) {
      const res = await request(app)
        .get(path)
        .set('Authorization', `Bearer ${bearer}`)
        .set('x-node-id', String(downNodeId));

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('node_unreachable');
      expect(res.body.error).not.toMatch(/upgrade/i);
    }
  });

  it.each([
    ['a meta endpoint that answers HTTP 500', () => metaErrorNodeId],
    ['a meta endpoint that is not Sencho\'s', () => metaMalformedNodeId],
  ])('answers 503 node_unreachable for %s, never "upgrade it"', async (_label, nodeId) => {
    const res = await request(app)
      .get('/api/stacks/web/observation/status')
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(nodeId()));
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('node_unreachable');
  });

  it.each([
    ['/api/stacks/web/observation/status'],
    ['/api/stacks/web/observation/readiness'],
    ['/api/stacks/platform/observation'],
    ['/api/stacks/platform/observation/'],
  ])('passes the node\'s own 401 through, uncoded, when it rejects the stored token: %s', async (path) => {
    // The capability check cannot see a rejected credential (/api/meta is public),
    // so a node that answers but rejects the stored token is the one failure here
    // that comes back as the node's own 401 instead of node_unreachable.
    // The docs and OpenAPI say so; this pins the behavior they describe.
    // The hub's own auth gate answers a bad bearer with the same body, so the
    // proxy's sentinel header is what proves the 401 came from the node.
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    const name = `obs-proxy-observe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const observeToken = createTestApiToken({
      db: DatabaseService, scope: 'read-only', userId: db.getUserByUsername(TEST_USERNAME)!.id, name,
    });
    db.getDb().prepare('UPDATE api_tokens SET scope = ? WHERE name = ?').run('observe-only', name);

    // The Observe Only scope allows the five exact paths, so it takes no trailing slash.
    const bearers = path.endsWith('/') ? [adminBearer, viewerBearer] : [adminBearer, viewerBearer, observeToken];
    for (const bearer of bearers) {
      const res = await request(app)
        .get(path)
        .set('Authorization', `Bearer ${bearer}`)
        .set('x-node-id', String(rejectingNodeId));

      expect(res.status).toBe(401);
      expect(res.headers['x-sencho-proxy']).toBe('1');
      expect(res.body.error).toBe('Invalid or expired token');
      expect(res.body.code).toBeUndefined();
    }
  });

  it.each([
    ['/api/stacks/platform/observation'],
    ['/api/stacks/platform/observation/'],
  ])('passes the node\'s own 401 through for HEAD on the node list path, which Express routes like GET: %s', async (path) => {
    // Same rule as the GET cases above, on the HEAD form. HEAD on the named-stack
    // paths is not asserted here: the hub's suffix table lists those under GET only,
    // so the proxy denies it before any node is reached.
    const res = await request(app)
      .head(path)
      .set('Authorization', `Bearer ${adminBearer}`)
      .set('x-node-id', String(rejectingNodeId));
    expect(res.status).toBe(401);
    expect(res.headers['x-sencho-proxy']).toBe('1');
  });

  it('keeps the 503 text to what the check can know: online and reachable, not "settings are valid"', async () => {
    const res = await request(app)
      .get('/api/stacks/web/observation/status')
      .set('Authorization', `Bearer ${adminBearer}`)
      .set('x-node-id', String(downNodeId));

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/online and reachable, then try again/);
    expect(res.body.error).not.toMatch(/settings are valid|credential|token/i);
  });

  it('answers 503 for a Pilot node with no tunnel, without ever claiming it is too old', async () => {
    for (const path of [
      '/api/stacks/web/observation/status',
      '/api/stacks/web/observation/readiness',
      '/api/stacks/platform/observation',
    ]) {
      const res = await request(app)
        .get(path)
        .set('Authorization', `Bearer ${viewerBearer}`)
        .set('x-node-id', String(pilotNodeId));
      expect(res.status).toBe(503);
      expect(res.body.code).not.toBe('capability_unavailable');
      expect(res.body.error).not.toMatch(/upgrade/i);
    }
  });

  it('gates the case-variant and HEAD forms that Express would still route', async () => {
    for (const [method, path] of [
      ['get', '/api/stacks/web/OBSERVATION/Status'],
      ['get', '/api/stacks/platform/Observation'],
      ['head', '/api/stacks/web/observation/status'],
    ] as const) {
      noCapPaths.length = 0;
      const res = await request(app)[method](path)
        .set('Authorization', `Bearer ${adminBearer}`)
        .set('x-node-id', String(noCapNodeId));
      expect(res.status, `${method} ${path}`).toBe(400);
      expect(observationCalls(noCapPaths)).toEqual([]);
    }
  });

  it('forwards a stack name longer than 128 characters unchanged', async () => {
    capPaths.length = 0;
    const long = 'q'.repeat(130);
    const res = await request(app)
      .get(`/api/stacks/${long}/observation/status`)
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(capNodeId));
    expect(res.status).toBe(200);
    expect(observationCalls(capPaths)).toContain(`/api/stacks/${long}/observation/status`);
  });

  it('forwards to a supported remote and returns its projection', async () => {
    capPaths.length = 0;
    const res = await request(app)
      .get('/api/stacks/web/observation/status')
      .set('Authorization', `Bearer ${adminBearer}`)
      .set('x-node-id', String(capNodeId));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ remote: true });
    expect(observationCalls(capPaths).some((p) => p.startsWith('/api/stacks/web/observation/status'))).toBe(true);
  });

  it('forwards a non-admin viewer once the node supports observation', async () => {
    capPaths.length = 0;
    const res = await request(app)
      .get('/api/stacks/web/observation/status')
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(capNodeId));

    expect(res.status).toBe(200);
    expect(observationCalls(capPaths)).toContain('/api/stacks/web/observation/status');
  });

  it('does not probe the capability for an unrelated stack read', async () => {
    capPaths.length = 0;
    const res = await request(app)
      .get('/api/stacks/web/containers')
      .set('Authorization', `Bearer ${adminBearer}`)
      .set('x-node-id', String(capNodeId));

    expect(res.status).toBe(200);
    expect(capPaths.some((p) => p.startsWith('/api/meta'))).toBe(false);
  });
});
