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

  it('returns 403 when authentication_mode is sso_only', async () => {
    const { setAuthenticationMode } = await import('../helpers/authenticationMode');
    setAuthenticationMode('sso_only');
    try {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: TEST_USERNAME, password: TEST_PASSWORD });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Local password authentication is disabled/i);
    } finally {
      setAuthenticationMode('local_and_sso');
    }
  });
});

describe('GET /api/auth/status', () => {
  it('reports localLoginEnabled true by default', async () => {
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body.localLoginEnabled).toBe(true);
    expect(res.body.authenticationMode).toBe('local_and_sso');
  });

  it('reports localLoginEnabled false when sso_only', async () => {
    const { setAuthenticationMode } = await import('../helpers/authenticationMode');
    setAuthenticationMode('sso_only');
    try {
      const res = await request(app).get('/api/auth/status');
      expect(res.status).toBe(200);
      expect(res.body.localLoginEnabled).toBe(false);
      expect(res.body.authenticationMode).toBe('sso_only');
    } finally {
      setAuthenticationMode('local_and_sso');
    }
  });

  it('defaults localLoginEnabled to true when the setting key is missing', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    db.getDb().prepare('DELETE FROM global_settings WHERE key = ?').run('authentication_mode');
    const res = await request(app).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body.localLoginEnabled).toBe(true);
  });

  it('honors a sidecar CLI write to authentication_mode without clearing the settings cache', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const { setAuthenticationMode, getAuthenticationMode, isLocalLoginEnabled } = await import('../helpers/authenticationMode');
    setAuthenticationMode('sso_only');
    const db = DatabaseService.getInstance();
    // Warm the process cache so a naive getGlobalSettings() read would still
    // report sso_only after a direct SQLite write (the enableLocalLogin /
    // disableSso sidecar path).
    expect(db.getGlobalSettings().authentication_mode).toBe('sso_only');
    db.getDb()
      .prepare('INSERT OR REPLACE INTO global_settings (key, value) VALUES (?, ?)')
      .run('authentication_mode', 'local_and_sso');
    expect(db.getGlobalSettings().authentication_mode).toBe('sso_only');
    expect(getAuthenticationMode()).toBe('local_and_sso');
    expect(isLocalLoginEnabled()).toBe(true);

    const status = await request(app).get('/api/auth/status');
    expect(status.status).toBe(200);
    expect(status.body.localLoginEnabled).toBe(true);
    expect(status.body.authenticationMode).toBe('local_and_sso');

    const login = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USERNAME, password: TEST_PASSWORD });
    expect(login.status).toBe(200);

    // Restore via the normal path so later tests see a coherent cache.
    setAuthenticationMode('local_and_sso');
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
      .set('Authorization', `Bearer ${token}`)
      .send({ path: 'host-console' });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
  });
});
