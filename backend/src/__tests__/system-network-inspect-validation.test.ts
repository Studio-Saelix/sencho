/**
 * Legacy Resources network inspect route and its Networking counterpart:
 * reference syntax is validated before Docker is touched, IDs and names are
 * both accepted, and both routes share one predicate.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import DockerController from '../services/DockerController';
import { systemMaintenanceRouter } from '../routes/systemMaintenance';

let tmpDir: string;
let app: import('express').Express;
let adminHeader: string;
let viewerHeader: string;
let deployerHeader: string;

const NET_ID_12 = 'abcdefabcdef';
const NET_ID_64 = 'a'.repeat(64);
const RAW_INSPECT = {
  Id: NET_ID_12,
  Name: 'app_default',
  Driver: 'bridge',
  Scope: 'local',
  Labels: { 'com.example.key': 'secret-value' },
  Containers: { c1: {} },
};
const MALFORMED_REFERENCES = [
  'bad!name',
  'with%20space',
  '..%2Fetc%2Fpasswd',
  '.%2e%2Fetc',
  'bad%2Fname',
  '-leading',
  '%2Fetc%2Fpasswd',
];
const VALID_NAMES = ['bridge', 'app_default', 'my.network-1'];
const MALFORMED_ERROR = 'Invalid network ID or name format';

function token(username: string, role: string): string {
  return `Bearer ${jwt.sign({ username, role }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
}

function stubDocker(overrides: {
  inspectNetwork?: ReturnType<typeof vi.fn>;
  getDependencySnapshot?: ReturnType<typeof vi.fn>;
} = {}) {
  const fake = {
    inspectNetwork: overrides.inspectNetwork
      ?? vi.fn().mockImplementation(async (id: string) => ({ ...RAW_INSPECT, Id: id })),
    getDependencySnapshot: overrides.getDependencySnapshot ?? vi.fn().mockResolvedValue({
      containers: [],
      networks: [{
        id: NET_ID_12,
        name: 'app_default',
        driver: 'bridge',
        scope: 'local',
        isSystem: false,
        composeProject: null,
        stack: null,
      }],
      volumes: [],
    }),
  };
  const getInstance = vi.spyOn(DockerController, 'getInstance')
    .mockReturnValue(fake as unknown as DockerController);
  return { fake, getInstance };
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  const { DatabaseService } = await import('../services/DatabaseService');
  const db = DatabaseService.getInstance();
  db.addUser({ username: 'net-inspect-viewer', password_hash: 'x', role: 'viewer' });
  db.addUser({ username: 'net-inspect-deployer', password_hash: 'x', role: 'deployer' });
  adminHeader = token(TEST_USERNAME, 'admin');
  viewerHeader = token('net-inspect-viewer', 'viewer');
  deployerHeader = token('net-inspect-deployer', 'deployer');
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/system/networks/:id', () => {
  it('rejects malformed references with 400 before any Docker call', async () => {
    const { fake, getInstance } = stubDocker();

    for (const reference of MALFORMED_REFERENCES) {
      const res = await request(app)
        .get(`/api/system/networks/${reference}`)
        .set('Authorization', adminHeader);
      expect(res.status, reference).toBe(400);
      expect(res.body.error, reference).toBe(MALFORMED_ERROR);
    }
    expect(getInstance).not.toHaveBeenCalled();
    expect(fake.inspectNetwork).not.toHaveBeenCalled();
    expect(fake.getDependencySnapshot).not.toHaveBeenCalled();
  });

  it('accepts 12-character abbreviated and 64-character full hex IDs', async () => {
    for (const id of [NET_ID_12, NET_ID_64]) {
      const { fake } = stubDocker();
      const res = await request(app)
        .get(`/api/system/networks/${id}`)
        .set('Authorization', adminHeader);

      expect(res.status).toBe(200);
      expect(fake.inspectNetwork).toHaveBeenCalledWith(id);
      // The legacy route keeps returning the raw Docker inspect payload.
      expect(res.body.Id).toBe(id);
      expect(res.body.Labels['com.example.key']).toBe('secret-value');
      expect(res.body.Containers.c1).toBeDefined();
      expect(res.body.schemaVersion).toBeUndefined();
    }
  });

  it('accepts network names so names are not rejected as malformed IDs', async () => {
    for (const name of VALID_NAMES) {
      const { fake } = stubDocker();
      const res = await request(app)
        .get(`/api/system/networks/${name}`)
        .set('Authorization', adminHeader);

      expect(res.status).toBe(200);
      expect(fake.inspectNetwork).toHaveBeenCalledWith(name);
    }
  });

  it('keeps HTTP 404 for a well-formed but nonexistent reference', async () => {
    const notFound = Object.assign(new Error('(HTTP code 404) no such network'), { statusCode: 404 });
    stubDocker({ inspectNetwork: vi.fn().mockRejectedValue(notFound) });

    const res = await request(app)
      .get('/api/system/networks/does_not_exist')
      .set('Authorization', adminHeader);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Network not found');
  });

  it('keeps HTTP 500 for unexpected Docker failures', async () => {
    stubDocker({ inspectNetwork: vi.fn().mockRejectedValue(new Error('daemon exploded')) });

    const res = await request(app)
      .get(`/api/system/networks/${NET_ID_12}`)
      .set('Authorization', adminHeader);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to inspect network');
  });

  it('requires authentication and node:read', async () => {
    const { fake } = stubDocker();

    expect((await request(app).get(`/api/system/networks/${NET_ID_12}`)).status).toBe(401);
    expect((await request(app).get('/api/system/networks/bad!name')).status).toBe(401);

    const deployer = await request(app)
      .get(`/api/system/networks/${NET_ID_12}`)
      .set('Authorization', deployerHeader);
    expect(deployer.status).toBe(403);

    const viewer = await request(app)
      .get(`/api/system/networks/${NET_ID_12}`)
      .set('Authorization', viewerHeader);
    expect(viewer.status).toBe(200);
    expect(fake.inspectNetwork).toHaveBeenCalledWith(NET_ID_12);
  });

  it('inspects through the node selected on the request, not the default node', async () => {
    const { getInstance } = stubDocker();
    const unitApp = express();
    unitApp.use((req, _res, next) => {
      req.nodeId = 42;
      req.user = { username: 'admin', role: 'admin', userId: 1 } as typeof req.user;
      next();
    });
    unitApp.use('/api/system', systemMaintenanceRouter);

    const res = await request(unitApp).get(`/api/system/networks/${NET_ID_12}`);

    expect(res.status).toBe(200);
    expect(getInstance).toHaveBeenCalledWith(42);
  });
});

describe('GET /api/networking/networks/:id parity', () => {
  it('rejects the same malformed references with 400 before any Docker call', async () => {
    const { fake, getInstance } = stubDocker();

    for (const reference of MALFORMED_REFERENCES) {
      const res = await request(app)
        .get(`/api/networking/networks/${reference}`)
        .set('Authorization', adminHeader);
      expect(res.status, reference).toBe(400);
      expect(res.body.error, reference).toBe(MALFORMED_ERROR);
    }
    expect(getInstance).not.toHaveBeenCalled();
    expect(fake.inspectNetwork).not.toHaveBeenCalled();
    expect(fake.getDependencySnapshot).not.toHaveBeenCalled();
  });

  it('still accepts names and returns the sanitized envelope', async () => {
    const { fake } = stubDocker();

    const res = await request(app)
      .get('/api/networking/networks/app_default')
      .set('Authorization', adminHeader);

    expect(res.status).toBe(200);
    expect(res.body.schemaVersion).toBe(3);
    expect(res.body.runtimeAvailable).toBe(true);
    expect(res.body.network.name).toBe('app_default');
    expect(res.body.network.labelKeys).toEqual(['com.example.key']);
    expect(JSON.stringify(res.body)).not.toContain('secret-value');
    expect(fake.inspectNetwork).toHaveBeenCalledWith(NET_ID_12);
  });

  it('keeps the unavailable-runtime envelope when Docker cannot be reached', async () => {
    const { fake } = stubDocker({
      getDependencySnapshot: vi.fn().mockRejectedValue(new Error('runtime unavailable')),
    });

    const res = await request(app)
      .get('/api/networking/networks/app_default')
      .set('Authorization', adminHeader);

    expect(res.status).toBe(503);
    expect(res.body.schemaVersion).toBe(3);
    expect(res.body.runtimeAvailable).toBe(false);
    expect(res.body.code).toBe('runtime-unavailable');
    expect(fake.inspectNetwork).not.toHaveBeenCalled();
  });
});
