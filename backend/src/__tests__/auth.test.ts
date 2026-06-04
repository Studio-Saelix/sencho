/**
 * Tests for authentication: login, rate limiting, and auth middleware.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_PASSWORD, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

// ─── Login ───────────────────────────────────────────────────────────────────

describe('POST /api/auth/login', () => {
  it('returns 200 and sets a cookie on valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USERNAME, password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('returns 401 on wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USERNAME, password: 'wrong-password' });

    expect(res.status).toBe(401);
  });

  it('returns 401 on unknown username', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nobody', password: 'anything' });

    expect(res.status).toBe(401);
  });

  it('returns 400 when credentials are missing', async () => {
    const res = await request(app).post('/api/auth/login').send({});
    expect(res.status).toBe(400);
  });
});

// ─── Auth middleware ──────────────────────────────────────────────────────────

describe('authMiddleware', () => {
  it('rejects requests with no token (401)', async () => {
    const res = await request(app).get('/api/stacks');
    expect(res.status).toBe(401);
  });

  it('rejects requests with an invalid token (401)', async () => {
    const res = await request(app)
      .get('/api/stacks')
      .set('Authorization', 'Bearer this.is.not.valid');
    expect(res.status).toBe(401);
  });

  it('accepts a valid Bearer token', async () => {
    // Issue a real token using the known test secret
    const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const res = await request(app)
      .get('/api/stacks')
      .set('Authorization', `Bearer ${token}`);
    // Will succeed (200) or fail with a docker/fs error (500) - but NOT 401
    expect(res.status).not.toBe(401);
  });

  it('accepts a valid cookie token', async () => {
    // First login to get the cookie
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USERNAME, password: TEST_PASSWORD });
    const cookies = loginRes.headers['set-cookie'] as string | string[];
    const cookieHeader = Array.isArray(cookies) ? cookies[0] : cookies;

    const res = await request(app)
      .get('/api/stacks')
      .set('Cookie', cookieHeader);
    expect(res.status).not.toBe(401);
  });
});

// ─── Protected endpoint: console-token ───────────────────────────────────────

describe('POST /api/system/console-token', () => {
  // Console-token requires the paid tier — mock LicenseService for the happy-path test
  beforeAll(async () => {
    const { LicenseService } = await import('../services/LicenseService');
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 without authentication (was a security bug - C1 fix)', async () => {
    const res = await request(app).post('/api/system/console-token');
    expect(res.status).toBe(401);
  });

  it('returns a token when authenticated', async () => {
    const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const res = await request(app)
      .post('/api/system/console-token')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
  });
});
