/**
 * Confirms GET /api/system/networks/topology is reachable on the Community
 * tier. Mocks DockerController.getTopologyData so the route can return data
 * without a real Docker daemon.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let DockerController: typeof import('../services/DockerController').default;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ LicenseService } = await import('../services/LicenseService'));
  DockerController = (await import('../services/DockerController')).default;
  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
  authHeader = `Bearer ${token}`;
});

afterAll(() => cleanupTestDb(tmpDir));

function mockTier(tier: 'paid' | 'community') {
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue(tier);
}

describe('Network topology on Community tier', () => {
  afterEach(() => vi.restoreAllMocks());

  it('GET /api/system/networks/topology returns 200 on community', async () => {
    mockTier('community');
    vi.spyOn(DockerController.prototype, 'getTopologyData').mockResolvedValue([]);
    const res = await request(app)
      .get('/api/system/networks/topology')
      .set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
