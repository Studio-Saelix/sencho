/**
 * GET /api/socket/inventory: auth, node:read, node-scoped dispatch, the
 * 503/504 envelopes that keep an unreadable node from looking like empty data,
 * and both remote transports (proxy and Pilot) preserving producer identity.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import http from 'http';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { requestedTimeoutBudgets, resetRequestedTimeoutBudgets } from './helpers/fastTimeouts';

const { loadSocketInventoryMock } = vi.hoisted(() => ({
  loadSocketInventoryMock: vi.fn(),
}));

vi.mock('../services/socket/SocketInventoryService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/socket/SocketInventoryService')>();
  return { ...actual, loadSocketInventory: loadSocketInventoryMock };
});

vi.mock('../utils/withTimeout', async (importOriginal) =>
  (await import('./helpers/fastTimeouts')).withFastTimeouts(await importOriginal()));

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let SocketInventoryUnavailableError: typeof import('../services/socket/SocketInventoryService').SocketInventoryUnavailableError;
let PilotTunnelManager: typeof import('../services/PilotTunnelManager').PilotTunnelManager;
let adminCookie: string;
let viewerCookie: string;
let deployerCookie: string;
let remoteServer: http.Server;
let remoteBase: string;
let remoteNodeId: number;
let pilotNodeId: number;
let deniedNodeId: number;
let legacyNodeId: number;
let unreachableNodeId: number;
const remoteHops: string[] = [];

const inventory = {
  schemaVersion: 1,
  status: 'complete',
  node: { id: 1, name: 'local', type: 'local', mode: 'proxy', instanceIdentity: 'abc' },
  counts: { listedContainers: 0, matchedContainers: 0, proxies: 0, directSocketConsumers: 0, undetermined: 0, inspectFailures: 0 },
  endpoint: { transport: 'unix', detection: 'detected' },
  containers: [],
  errors: [],
  generatedAt: 1,
  durationMs: 1,
  truncated: false,
};

const remoteInventory = {
  ...inventory,
  status: 'partial',
  node: { id: 999, name: 'remote', type: 'remote', mode: 'proxy', instanceIdentity: 'remote-instance' },
  counts: { ...inventory.counts, matchedContainers: 1 },
  containers: [{ id: 'remote-c1', name: 'remote-proxy', role: 'proxy', classification: 'detected' }],
  errors: [{ stage: 'container-metadata', message: 'remote partial evidence' }],
};

async function loginAs(username: string, password: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ username, password });
  const cookies = res.headers['set-cookie'] as string | string[];
  return Array.isArray(cookies) ? cookies[0] : cookies;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ SocketInventoryUnavailableError } = await import('../services/socket/SocketInventoryService'));
  ({ PilotTunnelManager } = await import('../services/PilotTunnelManager'));
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);

  const db = DatabaseService.getInstance();
  for (const [username, role] of [['socket-viewer', 'viewer'], ['socket-deployer', 'deployer']] as const) {
    db.addUser({ username, password_hash: await bcrypt.hash('socketpass', 1), role });
  }
  viewerCookie = await loginAs('socket-viewer', 'socketpass');
  deployerCookie = await loginAs('socket-deployer', 'socketpass');

  remoteServer = http.createServer((req, res) => {
    const path = req.url ?? '';
    remoteHops.push(path);
    res.setHeader('content-type', 'application/json');
    if (path.endsWith('/api/meta')) {
      res.end(JSON.stringify({
        version: '1.0.0',
        capabilities: ['cross-node-rbac', 'scoped-stack-auth-evidence'],
      }));
      return;
    }
    if (path.startsWith('/denied/')) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: 'remote denied' }));
      return;
    }
    if (path.startsWith('/legacy/')) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'API endpoint not found' }));
      return;
    }
    if (path.startsWith('/remote/api/socket/inventory')) {
      res.end(JSON.stringify(remoteInventory));
      return;
    }
    res.end(JSON.stringify({ target: true }));
  });
  await new Promise<void>(resolve => remoteServer.listen(0, '127.0.0.1', resolve));
  const port = (remoteServer.address() as import('net').AddressInfo).port;
  remoteBase = `http://127.0.0.1:${port}`;
  const addRemote = (name: string, mode: 'proxy' | 'pilot_agent' = 'proxy') => db.addNode({
    name, type: 'remote', mode, compose_dir: '/unused', is_default: false,
    api_url: mode === 'proxy' ? `${remoteBase}/${name}` : '', api_token: 'fixture-token',
  });
  remoteNodeId = addRemote('remote');
  deniedNodeId = addRemote('denied');
  legacyNodeId = addRemote('legacy');
  pilotNodeId = addRemote('pilot', 'pilot_agent');
  unreachableNodeId = db.addNode({
    name: 'unreachable', type: 'remote', mode: 'proxy', compose_dir: '/unused', is_default: false,
    api_url: 'http://127.0.0.1:1/unreachable', api_token: 'fixture-token',
  });
});

afterAll(async () => {
  await new Promise<void>(resolve => remoteServer.close(() => resolve()));
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  loadSocketInventoryMock.mockReset();
  loadSocketInventoryMock.mockResolvedValue(inventory);
  resetRequestedTimeoutBudgets();
  remoteHops.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/socket/inventory', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/socket/inventory');
    expect(res.status).toBe(401);
  });

  it('serves a viewer with node:read and passes the request node to discovery', async () => {
    const res = await request(app)
      .get('/api/socket/inventory')
      .set('Cookie', viewerCookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ schemaVersion: 1, status: 'complete' });
    expect(loadSocketInventoryMock).toHaveBeenCalledWith(1);
  });

  it('serves an admin', async () => {
    const res = await request(app)
      .get('/api/socket/inventory')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
  });

  it('refuses a role without node:read', async () => {
    const res = await request(app)
      .get('/api/socket/inventory')
      .set('Cookie', deployerCookie);
    expect(res.status).toBe(403);
    expect(loadSocketInventoryMock).not.toHaveBeenCalled();
  });

  it('bounds the discovery read with the production timeout budget', async () => {
    loadSocketInventoryMock.mockReturnValue(new Promise(() => {}));
    const res = await request(app)
      .get('/api/socket/inventory')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(504);
    expect(res.body.code).toBe('SOCKET_INVENTORY_TIMEOUT');
    expect(requestedTimeoutBudgets()).toContain(15_000);
  });

  it('answers 503, not an empty inventory, when Docker is unavailable', async () => {
    loadSocketInventoryMock.mockRejectedValue(new SocketInventoryUnavailableError('socket refused'));
    const res = await request(app)
      .get('/api/socket/inventory')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'DOCKER_UNAVAILABLE' });
    expect(res.body.containers).toBeUndefined();
  });

  it('answers 500 for an unexpected discovery failure', async () => {
    loadSocketInventoryMock.mockRejectedValue(new Error('unexpected'));
    const res = await request(app)
      .get('/api/socket/inventory')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(500);
  });
});

describe('GET /api/socket/inventory remote transports', () => {
  it('routes a proxy request to that node and preserves its producer identity and partial state', async () => {
    const res = await request(app)
      .get('/api/socket/inventory')
      .set('Cookie', adminCookie)
      .set('x-node-id', String(remoteNodeId));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'partial',
      node: { id: 999, instanceIdentity: 'remote-instance' },
      containers: [{ id: 'remote-c1' }],
      errors: [{ stage: 'container-metadata' }],
    });
    expect(remoteHops).toContain('/remote/api/socket/inventory');
    expect(loadSocketInventoryMock).not.toHaveBeenCalled();
  });

  it('routes a Pilot request through the loopback tunnel target, never local discovery', async () => {
    const tunnel = vi.spyOn(PilotTunnelManager.getInstance(), 'getLoopbackUrl')
      .mockReturnValue(`${remoteBase}/remote`);
    const res = await request(app)
      .get('/api/socket/inventory')
      .set('Cookie', adminCookie)
      .set('x-node-id', String(pilotNodeId));
    expect(tunnel).toHaveBeenCalledWith(pilotNodeId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'partial',
      node: { id: 999, instanceIdentity: 'remote-instance' },
      containers: [{ id: 'remote-c1' }],
      errors: [{ stage: 'container-metadata' }],
    });
    expect(remoteHops).toContain('/remote/api/socket/inventory');
    expect(loadSocketInventoryMock).not.toHaveBeenCalled();
  });

  it('does not fall back to local discovery when the Pilot tunnel is disconnected', async () => {
    const res = await request(app)
      .get('/api/socket/inventory')
      .set('Cookie', adminCookie)
      .set('x-node-id', String(pilotNodeId));
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/pilot tunnel/i);
    expect(loadSocketInventoryMock).not.toHaveBeenCalled();
  });

  it('keeps a remote denial distinct from a clean result', async () => {
    const res = await request(app)
      .get('/api/socket/inventory')
      .set('Cookie', adminCookie)
      .set('x-node-id', String(deniedNodeId));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('remote denied');
    expect(loadSocketInventoryMock).not.toHaveBeenCalled();
  });

  it('keeps an older node without the route from looking like empty discovery', async () => {
    const res = await request(app)
      .get('/api/socket/inventory')
      .set('Cookie', adminCookie)
      .set('x-node-id', String(legacyNodeId));
    expect(res.status).toBe(404);
    expect(res.body.containers).toBeUndefined();
    expect(loadSocketInventoryMock).not.toHaveBeenCalled();
  });

  it('reports an unreachable node as a transport failure, not an empty inventory', async () => {
    const res = await request(app)
      .get('/api/socket/inventory')
      .set('Cookie', adminCookie)
      .set('x-node-id', String(unreachableNodeId));
    expect(res.status).toBe(502);
    expect(res.body.containers).toBeUndefined();
    expect(loadSocketInventoryMock).not.toHaveBeenCalled();
  });
});
