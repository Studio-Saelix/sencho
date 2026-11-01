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

let tmpDir: string;
let app: import('express').Express;
let viewerBearer: string;
let adminBearer: string;
let capServer: http.Server;
let noCapServer: http.Server;
let capNodeId: number;
let noCapNodeId: number;

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
  noCapNodeId = db.addNode({
    name: 'obs-nocap-remote', type: 'remote', mode: 'proxy', compose_dir: '/tmp',
    is_default: false, api_url: `http://127.0.0.1:${noCapPort}`, api_token: 'nocap-token',
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => capServer.close(() => resolve()));
  await new Promise<void>((resolve) => noCapServer.close(() => resolve()));
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
