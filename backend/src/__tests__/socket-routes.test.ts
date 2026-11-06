/**
 * GET /api/socket/inventory: auth, node:read, node-scoped dispatch, and the
 * 503/504 envelopes that keep an unreadable node from looking like empty data.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
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
let adminCookie: string;
let viewerCookie: string;
let deployerCookie: string;

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

async function loginAs(username: string, password: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ username, password });
  const cookies = res.headers['set-cookie'] as string | string[];
  return Array.isArray(cookies) ? cookies[0] : cookies;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ SocketInventoryUnavailableError } = await import('../services/socket/SocketInventoryService'));
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);

  const db = DatabaseService.getInstance();
  for (const [username, role] of [['socket-viewer', 'viewer'], ['socket-deployer', 'deployer']] as const) {
    db.addUser({ username, password_hash: await bcrypt.hash('socketpass', 1), role });
  }
  viewerCookie = await loginAs('socket-viewer', 'socketpass');
  deployerCookie = await loginAs('socket-deployer', 'socketpass');
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  loadSocketInventoryMock.mockReset();
  loadSocketInventoryMock.mockResolvedValue(inventory);
  resetRequestedTimeoutBudgets();
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
