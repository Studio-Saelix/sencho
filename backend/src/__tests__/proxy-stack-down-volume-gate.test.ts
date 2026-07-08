/**
 * Gateway preflight for POST /stacks/:name/down?removeVolumes=true on remote nodes.
 * Unsupported remotes must return 400 before the proxy forwards the request.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import bcrypt from 'bcrypt';
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

const noCapPaths: string[] = [];
const capPaths: string[] = [];

function metaServer(capabilities: string[], seen: string[]): http.Server {
  return http.createServer((req, res) => {
    if (req.url) seen.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url?.startsWith('/api/meta')) {
      res.end(JSON.stringify({ version: '0.93.0', capabilities }));
    } else {
      res.end(JSON.stringify({ status: 'Command started' }));
    }
  });
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as import('net').AddressInfo).port;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  const { DatabaseService } = await import('../services/DatabaseService');
  const db = DatabaseService.getInstance();

  const hash = await bcrypt.hash('password123', 1);
  db.addUser({ username: 'vol-viewer', password_hash: hash, role: 'viewer' });
  const viewer = db.getUserByUsername('vol-viewer')!;
  viewerBearer = jwt.sign({ username: 'vol-viewer', role: 'viewer', tv: viewer.token_version }, TEST_JWT_SECRET, { expiresIn: '1m' });
  adminBearer = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });

  capServer = metaServer(['cross-node-rbac', 'stack-down-remove-volumes'], capPaths);
  noCapServer = metaServer(['cross-node-rbac'], noCapPaths);
  const capPort = await listen(capServer);
  const noCapPort = await listen(noCapServer);

  capNodeId = db.addNode({
    name: 'vol-cap-remote', type: 'remote', mode: 'proxy', compose_dir: '/tmp',
    is_default: false, api_url: `http://127.0.0.1:${capPort}`, api_token: 'cap-token',
  });
  noCapNodeId = db.addNode({
    name: 'vol-nocap-remote', type: 'remote', mode: 'proxy', compose_dir: '/tmp',
    is_default: false, api_url: `http://127.0.0.1:${noCapPort}`, api_token: 'nocap-token',
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => capServer.close(() => resolve()));
  await new Promise<void>((resolve) => noCapServer.close(() => resolve()));
  cleanupTestDb(tmpDir);
});

describe('remote proxy stack-down volume gate', () => {
  it('returns 400 for removeVolumes=true when remote lacks stack-down-remove-volumes (admin)', async () => {
    noCapPaths.length = 0;
    const res = await request(app)
      .post('/api/stacks/web/down?removeVolumes=true')
      .set('Authorization', `Bearer ${adminBearer}`)
      .set('x-node-id', String(noCapNodeId));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not supported/i);
    expect(noCapPaths.some(p => p.includes('/api/stacks/web/down'))).toBe(false);
    expect(noCapPaths.some(p => p.startsWith('/api/meta'))).toBe(true);
  });

  it('returns 400 for removeVolumes=true when remote lacks capability (non-admin)', async () => {
    noCapPaths.length = 0;
    const res = await request(app)
      .post('/api/stacks/web/down?removeVolumes=true')
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(noCapNodeId));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not supported/i);
    expect(noCapPaths.some(p => p.includes('/api/stacks/web/down'))).toBe(false);
  });

  it('proxies removeVolumes=true when remote advertises stack-down-remove-volumes', async () => {
    capPaths.length = 0;
    const res = await request(app)
      .post('/api/stacks/web/down?removeVolumes=true')
      .set('Authorization', `Bearer ${adminBearer}`)
      .set('x-node-id', String(capNodeId));

    expect(res.status).toBe(200);
    expect(capPaths.some(p => p.includes('/api/stacks/web/down'))).toBe(true);
  });

  it('does not preflight plain down without removeVolumes', async () => {
    noCapPaths.length = 0;
    const res = await request(app)
      .post('/api/stacks/web/down')
      .set('Authorization', `Bearer ${adminBearer}`)
      .set('x-node-id', String(noCapNodeId));

    expect(res.status).toBe(200);
    expect(noCapPaths.some(p => p.includes('/api/stacks/web/down'))).toBe(true);
    expect(noCapPaths.some(p => p.startsWith('/api/meta'))).toBe(false);
  });
});
