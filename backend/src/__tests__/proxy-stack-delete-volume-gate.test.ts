/**
 * Gateway preflight for DELETE /stacks/:name on remote nodes. See
 * isUnacknowledgedStackDelete in remoteNodeProxy.ts for why this gate exists; this file
 * covers what the gate must get right: block an unacknowledged delete to an unsupported
 * remote (whatever the caller's role, and with or without a trailing slash), accept only
 * the exact string "true" as acknowledgement, and forward without a capability probe once
 * removal is acknowledged or the remote advertises support.
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
      res.end(JSON.stringify({ status: 'deleted' }));
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
  db.addUser({ username: 'delvol-viewer', password_hash: hash, role: 'viewer' });
  const viewer = db.getUserByUsername('delvol-viewer')!;
  viewerBearer = jwt.sign({ username: 'delvol-viewer', role: 'viewer', tv: viewer.token_version }, TEST_JWT_SECRET, { expiresIn: '1m' });
  adminBearer = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });

  capServer = metaServer(['cross-node-rbac', 'stack-delete-prune-volumes'], capPaths);
  noCapServer = metaServer(['cross-node-rbac', 'stack-down-remove-volumes'], noCapPaths);
  const capPort = await listen(capServer);
  const noCapPort = await listen(noCapServer);

  capNodeId = db.addNode({
    name: 'delvol-cap-remote', type: 'remote', mode: 'proxy', compose_dir: '/tmp',
    is_default: false, api_url: `http://127.0.0.1:${capPort}`, api_token: 'cap-token',
  });
  noCapNodeId = db.addNode({
    name: 'delvol-nocap-remote', type: 'remote', mode: 'proxy', compose_dir: '/tmp',
    is_default: false, api_url: `http://127.0.0.1:${noCapPort}`, api_token: 'nocap-token',
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => capServer.close(() => resolve()));
  await new Promise<void>((resolve) => noCapServer.close(() => resolve()));
  cleanupTestDb(tmpDir);
});

describe('remote proxy stack-delete volume gate', () => {
  it('returns 400 for an unacknowledged delete when remote lacks stack-delete-prune-volumes (admin)', async () => {
    noCapPaths.length = 0;
    const res = await request(app)
      .delete('/api/stacks/web')
      .set('Authorization', `Bearer ${adminBearer}`)
      .set('x-node-id', String(noCapNodeId));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('capability_unavailable');
    expect(noCapPaths.some(p => p.includes('/api/stacks/web') && !p.startsWith('/api/meta'))).toBe(false);
    expect(noCapPaths.some(p => p.startsWith('/api/meta'))).toBe(true);
  });

  // A viewer has no stack:delete, so this also pins gate order: the data-safety 400 wins
  // over the permission 403 that the named-stack pre-check would otherwise return.
  it('returns 400, not 403, for an unacknowledged delete by a viewer when remote lacks capability', async () => {
    noCapPaths.length = 0;
    const res = await request(app)
      .delete('/api/stacks/web')
      .set('Authorization', `Bearer ${viewerBearer}`)
      .set('x-node-id', String(noCapNodeId));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('capability_unavailable');
  });

  it('proxies through when the operator explicitly acknowledges volume removal (pruneVolumes=true), even without the capability, and never queries /api/meta', async () => {
    noCapPaths.length = 0;
    const res = await request(app)
      .delete('/api/stacks/web?pruneVolumes=true')
      .set('Authorization', `Bearer ${adminBearer}`)
      .set('x-node-id', String(noCapNodeId));

    expect(res.status).toBe(200);
    expect(noCapPaths.some(p => p.includes('/api/stacks/web?pruneVolumes=true'))).toBe(true);
    expect(noCapPaths.some(p => p.startsWith('/api/meta'))).toBe(false);
  });

  it('treats only the exact string "true" as acknowledgement, blocking loose truthy values like "1"', async () => {
    noCapPaths.length = 0;
    const res = await request(app)
      .delete('/api/stacks/web?pruneVolumes=1')
      .set('Authorization', `Bearer ${adminBearer}`)
      .set('x-node-id', String(noCapNodeId));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('capability_unavailable');
  });

  it('proxies an unacknowledged delete through when the remote advertises stack-delete-prune-volumes', async () => {
    capPaths.length = 0;
    const res = await request(app)
      .delete('/api/stacks/web')
      .set('Authorization', `Bearer ${adminBearer}`)
      .set('x-node-id', String(capNodeId));

    expect(res.status).toBe(200);
    expect(capPaths.some(p => p.includes('/api/stacks/web'))).toBe(true);
  });

  it('still gates an unacknowledged delete with a trailing slash', async () => {
    noCapPaths.length = 0;
    const res = await request(app)
      .delete('/api/stacks/web/')
      .set('Authorization', `Bearer ${adminBearer}`)
      .set('x-node-id', String(noCapNodeId));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('capability_unavailable');
    expect(noCapPaths.some(p => p.includes('/api/stacks/web/') && !p.startsWith('/api/meta'))).toBe(false);
  });
});
