/**
 * Legacy Resources network inspect route: reference syntax is validated before
 * Docker is touched, valid IDs and names both reach inspection, and the route
 * stays aligned with the Networking endpoint on the accepted forms.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import DockerController from '../services/DockerController';

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
  Containers: {},
};

function token(username: string, role: string): string {
  return `Bearer ${jwt.sign({ username, role }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
}

function stubDocker(overrides: {
  inspectNetwork?: ReturnType<typeof vi.fn>;
  getDependencySnapshot?: ReturnType<typeof vi.fn>;
} = {}) {
  const fake = {
    inspectNetwork: overrides.inspectNetwork ?? vi.fn().mockResolvedValue(RAW_INSPECT),
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
  it('rejects malformed references with 400 before any Docker inspection', async () => {
    const { fake } = stubDocker();
    const malformed = [
      'bad!name',
      'with%20space',
      '..%2Fetc%2Fpasswd',
      '.%2e%2Fetc',
      'bad%2Fname',
      '-leading',
      '%2Fetc%2Fpasswd',
    ];

    for (const reference of malformed) {
      const res = await request(app)
        .get(`/api/system/networks/${reference}`)
        .set('Authorization', adminHeader);
      expect(res.status, reference).toBe(400);
      expect(res.body.error, reference).toBe('Invalid network ID or name format');
    }
    expect(fake.inspectNetwork).not.toHaveBeenCalled();
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
      expect(res.body.Id).toBe(NET_ID_12);
      expect(res.body.Name).toBe('app_default');
      expect(res.body.schemaVersion).toBeUndefined();
      vi.restoreAllMocks();
    }
  });

  it('accepts network names so names are not rejected as malformed IDs', async () => {
    for (const name of ['bridge', 'app_default', 'my.network-1']) {
      const { fake } = stubDocker();
      const res = await request(app)
        .get(`/api/system/networks/${name}`)
        .set('Authorization', adminHeader);

      expect(res.status).toBe(200);
      expect(fake.inspectNetwork).toHaveBeenCalledWith(name);
      vi.restoreAllMocks();
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

  it('requires authentication and node:read, and scopes inspection to the selected node', async () => {
    const { fake, getInstance } = stubDocker();

    const unauthenticated = await request(app).get(`/api/system/networks/${NET_ID_12}`);
    expect(unauthenticated.status).toBe(401);

    const deployer = await request(app)
      .get(`/api/system/networks/${NET_ID_12}`)
      .set('Authorization', deployerHeader);
    expect(deployer.status).toBe(403);
    expect(fake.inspectNetwork).not.toHaveBeenCalled();

    const viewer = await request(app)
      .get(`/api/system/networks/${NET_ID_12}`)
      .set('Authorization', viewerHeader)
      .set('x-node-id', '1');
    expect(viewer.status).toBe(200);
    expect(getInstance).toHaveBeenCalledWith(1);
    expect(fake.inspectNetwork).toHaveBeenCalledWith(NET_ID_12);
  });
});

describe('GET /api/networking/networks/:id parity', () => {
  it('rejects the same malformed references with 400 before any Docker inspection', async () => {
    const { fake } = stubDocker();
    const malformed = ['bad!name', 'with%20space', '..%2Fetc%2Fpasswd', '.%2e%2Fetc', 'bad%2Fname', '-leading'];

    for (const reference of malformed) {
      const res = await request(app)
        .get(`/api/networking/networks/${reference}`)
        .set('Authorization', adminHeader);
      expect(res.status, reference).toBe(400);
    }
    expect(fake.inspectNetwork).not.toHaveBeenCalled();
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
});
