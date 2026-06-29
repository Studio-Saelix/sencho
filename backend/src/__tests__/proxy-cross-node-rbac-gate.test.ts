/**
 * Mixed-version HTTP proxy gate. A remote that does not advertise the
 * cross-node-rbac capability ignores the forwarded actor role and runs a
 * proxied request as admin, so the hub must refuse to proxy a non-admin user's
 * request to such a remote. Admins are unaffected. Each remote is a small
 * loopback server that answers /api/meta with or without the capability.
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

const PROXIED_PATH = '/api/stacks';

function metaServer(capabilities: string[], seen?: string[]): http.Server {
  return http.createServer((req, res) => {
    if (seen && req.url) seen.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url?.startsWith('/api/meta')) {
      res.end(JSON.stringify({ version: '0.93.0', capabilities }));
    } else {
      // Any proxied request that clears the gate lands here.
      res.end('[]');
    }
  });
}

const noCapPaths: string[] = [];

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
  db.addUser({ username: 'gate-viewer', password_hash: hash, role: 'viewer' });
  const viewer = db.getUserByUsername('gate-viewer')!;
  viewerBearer = jwt.sign({ username: 'gate-viewer', role: 'viewer', tv: viewer.token_version }, TEST_JWT_SECRET, { expiresIn: '1m' });
  adminBearer = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });

  capServer = metaServer(['cross-node-rbac']);
  noCapServer = metaServer(['fleet'], noCapPaths); // older remote: no cross-node-rbac
  const capPort = await listen(capServer);
  const noCapPort = await listen(noCapServer);

  capNodeId = db.addNode({
    name: 'cap-remote', type: 'remote', mode: 'proxy', compose_dir: '/tmp',
    is_default: false, api_url: `http://127.0.0.1:${capPort}`, api_token: 'cap-token',
  });
  noCapNodeId = db.addNode({
    name: 'nocap-remote', type: 'remote', mode: 'proxy', compose_dir: '/tmp',
    is_default: false, api_url: `http://127.0.0.1:${noCapPort}`, api_token: 'nocap-token',
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => capServer.close(() => resolve()));
  await new Promise<void>((resolve) => noCapServer.close(() => resolve()));
  cleanupTestDb(tmpDir);
});

describe('remote proxy cross-node-rbac gate', () => {
  it('denies a non-admin proxied request to a remote that lacks cross-node-rbac', async () => {
    const res = await request(app)
      .get(PROXIED_PATH)
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(noCapNodeId));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/upgrade/i);
  });

  it('allows a non-admin proxied request to a remote that advertises cross-node-rbac', async () => {
    const res = await request(app)
      .get(PROXIED_PATH)
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(capNodeId));
    // Forwarded to the capability-advertising remote, which answers 200.
    expect(res.status).not.toBe(403);
  });

  it('does not gate an admin proxied request even to a remote lacking cross-node-rbac', async () => {
    const res = await request(app)
      .get(PROXIED_PATH)
      .set('Authorization', `Bearer ${adminBearer}`)
      .set('x-node-id', String(noCapNodeId));
    expect(res.status).not.toBe(403);
  });

  it('refuses a real stop to a remote lacking cross-node-rbac via the live probe, never contacting its local-stop receiver', async () => {
    // Exercises the fleet-stop gate end to end through the REAL capability
    // helper (not a mock): the live /api/meta probe of the no-cap remote returns
    // no capability, so the stop is refused and the destructive receiver on that
    // remote is never contacted.
    noCapPaths.length = 0;
    const res = await request(app)
      .post('/api/fleet/labels/fleet-stop')
      .set('Authorization', `Bearer ${adminBearer}`)
      .send({ labelName: 'any-label', targets: [{ nodeId: noCapNodeId, stackNames: ['x'] }] });
    expect(res.status).toBe(200);
    const node = res.body.results.find((r: { nodeId: number }) => r.nodeId === noCapNodeId);
    expect(node.reachable).toBe(false);
    expect(node.error).toMatch(/upgrade/i);
    expect(noCapPaths.some(p => p.startsWith('/api/meta'))).toBe(true);
    expect(noCapPaths.some(p => p.includes('/api/fleet-actions/labels/local-stop'))).toBe(false);
  });
});
