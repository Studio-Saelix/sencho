/**
 * Tests for the Fleet Actions tab endpoints. Covers auth, tier gating, input
 * validation, and orchestration shape across the two routes.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let LicenseService: typeof import('../services/LicenseService').LicenseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ LicenseService } = await import('../services/LicenseService'));
  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
  authHeader = `Bearer ${token}`;
});

afterAll(() => cleanupTestDb(tmpDir));

function mockTier(tier: 'paid' | 'community') {
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue(tier);
}

describe('Fleet Actions endpoints require authentication', () => {
  it('POST /api/fleet-actions/labels/bulk-assign returns 401 without auth', async () => {
    const res = await request(app).post('/api/fleet-actions/labels/bulk-assign').send({ assignments: [] });
    expect(res.status).toBe(401);
  });

  it('POST /api/fleet/labels/fleet-stop returns 401 without auth', async () => {
    const res = await request(app).post('/api/fleet/labels/fleet-stop').send({ labelName: 'prod' });
    expect(res.status).toBe(401);
  });
});

describe('Fleet Actions tier gating (Community + admin)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POST /api/fleet/labels/fleet-stop is reachable on community tier for admins', async () => {
    mockTier('community');
    const res = await request(app)
      .post('/api/fleet/labels/fleet-stop')
      .set('Authorization', authHeader)
      .send({ labelName: 'this-label-does-not-exist' });
    expect(res.status).toBe(200);
    expect(res.body.code).not.toBe('PAID_REQUIRED');
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  it('POST /api/fleet-actions/labels/bulk-assign is reachable on community tier for admins', async () => {
    mockTier('community');
    const res = await request(app)
      .post('/api/fleet-actions/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ assignments: [] });
    expect(res.status).toBe(200);
    expect(res.body.code).not.toBe('PAID_REQUIRED');
    expect(res.body.results).toEqual([]);
  });
});

describe('Fleet Actions input validation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POST /api/fleet/labels/fleet-stop rejects missing labelName', async () => {
    const res = await request(app)
      .post('/api/fleet/labels/fleet-stop')
      .set('Authorization', authHeader)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/labelName/);
  });

  it('POST /api/fleet/labels/fleet-stop rejects whitespace-only labelName', async () => {
    const res = await request(app)
      .post('/api/fleet/labels/fleet-stop')
      .set('Authorization', authHeader)
      .send({ labelName: '   ' });
    expect(res.status).toBe(400);
  });

  it('POST /api/fleet-actions/labels/bulk-assign rejects non-array assignments', async () => {
    const res = await request(app)
      .post('/api/fleet-actions/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ assignments: 'oops' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/assignments must be an array/);
  });

  it('POST /api/fleet-actions/labels/bulk-assign rejects oversized payload', async () => {
    const big = Array.from({ length: 1001 }, (_, i) => ({ stackName: `s${i}`, labelIds: [] }));
    const res = await request(app)
      .post('/api/fleet-actions/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ assignments: big });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/may not exceed/);
  });
});

describe('Fleet Actions orchestration shape', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POST /api/fleet/labels/fleet-stop with unknown label returns matched:false per node', async () => {
    const res = await request(app)
      .post('/api/fleet/labels/fleet-stop')
      .set('Authorization', authHeader)
      .send({ labelName: 'this-label-does-not-exist' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.results)).toBe(true);
    for (const row of res.body.results) {
      expect(row.matched).toBe(false);
      expect(row.stackResults).toEqual([]);
    }
  });

  it('POST /api/fleet-actions/labels/bulk-assign accepts empty assignments and returns empty results', async () => {
    const res = await request(app)
      .post('/api/fleet-actions/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ assignments: [] });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('POST /api/fleet-actions/labels/bulk-assign rejects an entry with bad stack name in-line', async () => {
    const res = await request(app)
      .post('/api/fleet-actions/labels/bulk-assign')
      .set('Authorization', authHeader)
      .send({ assignments: [{ stackName: 'has spaces!', labelIds: [1] }] });
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ success: false, error: 'Invalid stack name' });
  });
});
