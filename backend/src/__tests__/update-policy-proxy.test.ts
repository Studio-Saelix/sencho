/**
 * A bulk image update through the remote proxy.
 *
 * Bulk update treats every selected stack as an unattended update, so the node
 * must evaluate `io.sencho.update` itself: the hub cannot know whether those
 * stacks declare `disabled`. The refusal is tri-state, so a node that merely did
 * not answer is reported as unreachable instead of as too old.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let adminBearer: string;
let capableNodeId: number;
let olderNodeId: number;
let downNodeId: number;
const capableCalls: Array<{ method: string; url: string; body: string }> = [];
const olderCalls: Array<{ method: string; url: string }> = [];
let capableServer: http.Server;
let olderServer: http.Server;

function nodeServer(capabilities: string[], seen: typeof capableCalls): http.Server {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += String(chunk); });
    req.on('end', () => {
      if (req.url?.startsWith('/api/meta')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: '0.99.0', capabilities }));
        return;
      }
      seen.push({ method: req.method ?? '', url: req.url ?? '', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ action: 'update', results: [] }));
    });
  });
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as import('net').AddressInfo).port;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  const { DatabaseService } = await import('../services/DatabaseService');
  const db = DatabaseService.getInstance();

  adminBearer = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });

  capableServer = nodeServer(
    ['cross-node-rbac', 'remote-image-inspect-v1', 'sencho-label-policy-v1'],
    capableCalls,
  );
  olderServer = nodeServer(['cross-node-rbac', 'remote-image-inspect-v1'], olderCalls as typeof capableCalls);
  const capablePort = await listen(capableServer);
  const olderPort = await listen(olderServer);

  capableNodeId = db.addNode({
    name: 'policy-capable-remote', type: 'remote', mode: 'proxy', compose_dir: '/tmp',
    is_default: false, api_url: `http://127.0.0.1:${capablePort}`, api_token: 'capable-token',
  });
  olderNodeId = db.addNode({
    name: 'policy-older-remote', type: 'remote', mode: 'proxy', compose_dir: '/tmp',
    is_default: false, api_url: `http://127.0.0.1:${olderPort}`, api_token: 'older-token',
  });

  const downServer = http.createServer();
  const downPort = await listen(downServer);
  await new Promise<void>(resolve => downServer.close(() => resolve()));
  downNodeId = db.addNode({
    name: 'policy-down-remote', type: 'remote', mode: 'proxy', compose_dir: '/tmp',
    is_default: false, api_url: `http://127.0.0.1:${downPort}`, api_token: 'down-token',
  });
});

afterAll(async () => {
  await new Promise<void>(resolve => capableServer.close(() => resolve()));
  await new Promise<void>(resolve => olderServer.close(() => resolve()));
  cleanupTestDb(tmpDir);
});

describe('bulk update through the proxy', () => {
  it('forwards the bulk update to a node that evaluates the label, body intact', async () => {
    capableCalls.length = 0;
    const resp = await request(app)
      .post('/api/stacks/bulk')
      .set('Authorization', `Bearer ${adminBearer}`)
      .set('x-node-id', String(capableNodeId))
      .send({ action: 'update', stackNames: ['web', 'api'] });

    expect(resp.status).toBe(200);
    const forwarded = capableCalls.find(call => call.url.includes('/api/stacks/bulk'));
    expect(forwarded).toBeDefined();
    expect(JSON.parse(forwarded!.body)).toEqual({ action: 'update', stackNames: ['web', 'api'] });
  });

  it('refuses a bulk update to a node that does not evaluate the label', async () => {
    olderCalls.length = 0;
    const resp = await request(app)
      .post('/api/stacks/bulk')
      .set('Authorization', `Bearer ${adminBearer}`)
      .set('x-node-id', String(olderNodeId))
      .send({ action: 'update', stackNames: ['web'] });

    expect(resp.status).toBe(400);
    expect(resp.body.code).toBe('capability_unavailable');
    expect(resp.body.error).toContain('io.sencho.update');
    expect(olderCalls.filter(call => call.url.includes('/api/stacks/bulk'))).toEqual([]);
  });

  it('leaves a bulk stop alone on a node that does not evaluate the label', async () => {
    olderCalls.length = 0;
    const resp = await request(app)
      .post('/api/stacks/bulk')
      .set('Authorization', `Bearer ${adminBearer}`)
      .set('x-node-id', String(olderNodeId))
      .send({ action: 'stop', stackNames: ['web'] });

    expect(resp.status).toBe(200);
    const forwarded = olderCalls.find(call => call.url.includes('/api/stacks/bulk'));
    expect(forwarded).toBeDefined();
  });

  it('reports an unreachable node as unreachable, never as too old', async () => {
    const resp = await request(app)
      .post('/api/stacks/bulk')
      .set('Authorization', `Bearer ${adminBearer}`)
      .set('x-node-id', String(downNodeId))
      .send({ action: 'update', stackNames: ['web'] });

    expect(resp.status).toBe(503);
    expect(resp.body.code).toBe('node_unreachable');
    expect(resp.body.error).not.toMatch(/upgrade/i);
  });
});
