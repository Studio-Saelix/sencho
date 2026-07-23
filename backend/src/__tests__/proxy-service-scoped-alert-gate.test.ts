/**
 * Mixed-version gate for POST /api/alerts with a non-empty service_name.
 *
 * Remote-targeted requests skip express.json() so the raw stream stays
 * pipeable. The hub must still buffer that body, reject scoped creates when
 * the remote lacks service-scoped-stack-alert, and forward unscoped JSON
 * intact when allowed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let adminBearer: string;
let capServer: http.Server;
let noCapServer: http.Server;
let capNodeId: number;
let noCapNodeId: number;

const noCapPaths: string[] = [];
const capPaths: string[] = [];
let lastCapBody: Buffer | null = null;
let lastNoCapBody: Buffer | null = null;

function metaServer(
  capabilities: string[],
  seen: string[],
  onBody: (body: Buffer) => void,
): http.Server {
  return http.createServer((req, res) => {
    if (req.url) seen.push(req.url);
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (!req.url?.startsWith('/api/meta')) {
        onBody(Buffer.concat(chunks));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url?.startsWith('/api/meta')) {
        res.end(JSON.stringify({ version: '0.93.0', capabilities }));
      } else {
        res.end(JSON.stringify({ id: 1, ok: true }));
      }
    });
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

  adminBearer = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });

  capServer = metaServer(
    ['cross-node-rbac', 'service-scoped-stack-alert'],
    capPaths,
    (body) => { lastCapBody = body; },
  );
  noCapServer = metaServer(
    ['cross-node-rbac'],
    noCapPaths,
    (body) => { lastNoCapBody = body; },
  );
  const capPort = await listen(capServer);
  const noCapPort = await listen(noCapServer);

  capNodeId = db.addNode({
    name: 'alert-cap-remote', type: 'remote', mode: 'proxy', compose_dir: '/tmp',
    is_default: false, api_url: `http://127.0.0.1:${capPort}`, api_token: 'cap-token',
  });
  noCapNodeId = db.addNode({
    name: 'alert-nocap-remote', type: 'remote', mode: 'proxy', compose_dir: '/tmp',
    is_default: false, api_url: `http://127.0.0.1:${noCapPort}`, api_token: 'nocap-token',
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => capServer.close(() => resolve()));
  await new Promise<void>((resolve) => noCapServer.close(() => resolve()));
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  noCapPaths.length = 0;
  capPaths.length = 0;
  lastNoCapBody = null;
  lastCapBody = null;
});

const scopedPayload = {
  stack_name: 'web',
  service_name: 'api',
  metric: 'cpu_percent',
  operator: '>',
  threshold: 80,
  duration_mins: 5,
  cooldown_mins: 60,
};

const unscopedPayload = {
  stack_name: 'web',
  service_name: null,
  metric: 'cpu_percent',
  operator: '>',
  threshold: 80,
  duration_mins: 5,
  cooldown_mins: 60,
};

describe('remote proxy service-scoped alert gate', () => {
  it('returns 400 for scoped alert create when remote lacks service-scoped-stack-alert', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Authorization', `Bearer ${adminBearer}`)
      .set('x-node-id', String(noCapNodeId))
      .set('Content-Type', 'application/json')
      .send(scopedPayload);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('capability_unavailable');
    expect(noCapPaths.some((p) => p.includes('/api/alerts'))).toBe(false);
    expect(noCapPaths.some((p) => p.startsWith('/api/meta'))).toBe(true);
    expect(lastNoCapBody).toBeNull();
  });

  it('forwards unscoped alert JSON intact when remote lacks the capability', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Authorization', `Bearer ${adminBearer}`)
      .set('x-node-id', String(noCapNodeId))
      .set('Content-Type', 'application/json')
      .send(unscopedPayload);

    expect(res.status).toBe(200);
    expect(noCapPaths.some((p) => p.includes('/api/alerts'))).toBe(true);
    expect(lastNoCapBody).not.toBeNull();
    expect(JSON.parse(lastNoCapBody!.toString('utf-8'))).toEqual(unscopedPayload);
  });

  it('forwards scoped alert JSON intact when remote advertises the capability', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Authorization', `Bearer ${adminBearer}`)
      .set('x-node-id', String(capNodeId))
      .set('Content-Type', 'application/json')
      .send(scopedPayload);

    expect(res.status).toBe(200);
    expect(capPaths.some((p) => p.includes('/api/alerts'))).toBe(true);
    expect(lastCapBody).not.toBeNull();
    expect(JSON.parse(lastCapBody!.toString('utf-8'))).toEqual(scopedPayload);
  });
});
