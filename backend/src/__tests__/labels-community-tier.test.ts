/**
 * Confirms Stack Labels CRUD + per-stack assignment is reachable on the
 * Community tier. The per-label bulk-action endpoint stays Skipper+ and is
 * exercised here too to guard against an accidental gate removal in the
 * future.
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

describe('Stack Labels on Community tier', () => {
  afterEach(() => vi.restoreAllMocks());

  it('GET /api/labels returns 200 (empty array) on community', async () => {
    mockTier('community');
    const res = await request(app).get('/api/labels').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/labels creates a label on community', async () => {
    mockTier('community');
    const res = await request(app)
      .post('/api/labels')
      .set('Authorization', authHeader)
      .send({ name: 'production', color: 'teal' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'production', color: 'teal' });
    expect(typeof res.body.id).toBe('number');
  });

  it('GET /api/labels/assignments returns 200 on community', async () => {
    mockTier('community');
    const res = await request(app).get('/api/labels/assignments').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
  });

  it('PUT /api/labels/:id updates a label on community', async () => {
    mockTier('community');
    const created = await request(app)
      .post('/api/labels')
      .set('Authorization', authHeader)
      .send({ name: 'staging', color: 'blue' });
    expect(created.status).toBe(201);

    const res = await request(app)
      .put(`/api/labels/${created.body.id}`)
      .set('Authorization', authHeader)
      .send({ color: 'rose' });
    expect(res.status).toBe(200);
    expect(res.body.color).toBe('rose');
  });

  it('DELETE /api/labels/:id removes a label on community', async () => {
    mockTier('community');
    const created = await request(app)
      .post('/api/labels')
      .set('Authorization', authHeader)
      .send({ name: 'temp', color: 'amber' });
    expect(created.status).toBe(201);

    const res = await request(app)
      .delete(`/api/labels/${created.body.id}`)
      .set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('PUT /api/stacks/:stackName/labels accepts an empty assignment on community', async () => {
    mockTier('community');
    const res = await request(app)
      .put('/api/stacks/some-stack/labels')
      .set('Authorization', authHeader)
      .send({ labelIds: [] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('Stack Labels bulk-action endpoint stays Skipper+', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POST /api/labels/:id/action returns 403 on community', async () => {
    mockTier('community');
    const res = await request(app)
      .post('/api/labels/1/action')
      .set('Authorization', authHeader)
      .send({ action: 'deploy' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PAID_REQUIRED');
  });
});
