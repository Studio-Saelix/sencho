/**
 * Tests for the two pieces added to fix sessions expiring out from under
 * active users: sliding-refresh (authMiddleware silently reissues a
 * near-expiry session cookie) and "stay signed in" (a longer-lived session
 * chosen at login, carried through MFA and password-change reissues).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { OTP } from 'otplib';
import {
  setupTestDb,
  cleanupTestDb,
  loginAsTestAdmin,
  seedMfaUser,
  TEST_USERNAME,
  TEST_PASSWORD,
  TEST_JWT_SECRET,
} from './helpers/setupTestDb';

// Match the server-side otplib configuration so test-generated OTPs are
// accepted by the verify path (see MfaService and __tests__/mfa.test.ts).
const authenticator = new OTP({ strategy: 'totp' });
const TOTP_PARAMS = { algorithm: 'sha1' as const, digits: 6, period: 30 };

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ app } = await import('../index'));
});

afterAll(() => cleanupTestDb(tmpDir));

/** Extract the sencho_token cookie's raw JWT value from a Set-Cookie header. */
function extractSessionToken(setCookieHeader: string | string[] | undefined): string | undefined {
  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
  const match = cookies.find((c) => c.startsWith('sencho_token='));
  return match?.split(';')[0].split('=')[1];
}

describe('sliding session refresh', () => {
  afterEach(() => {
    DatabaseService.getInstance().updateGlobalSetting('session_sliding_refresh', '1');
  });

  it('refreshes a session nearing expiry', async () => {
    const nearExpiryToken = jwt.sign({ username: TEST_USERNAME, remember: false }, TEST_JWT_SECRET, { expiresIn: '30s' });
    const res = await request(app)
      .get('/api/auth/check')
      .set('Authorization', `Bearer ${nearExpiryToken}`);

    expect(res.status).toBe(200);
    const refreshed = extractSessionToken(res.headers['set-cookie']);
    expect(refreshed).toBeDefined();
    const decoded = jwt.verify(refreshed!, TEST_JWT_SECRET) as { exp: number; remember?: boolean };
    // Refreshed back to a full 24h session, not just extended by seconds.
    expect(decoded.exp * 1000 - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(decoded.remember).toBe(false);
  });

  it('does not refresh a session with plenty of life left', async () => {
    const freshCookie = await loginAsTestAdmin(app);
    const res = await request(app)
      .get('/api/auth/check')
      .set('Cookie', freshCookie);

    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('reissues a "stay signed in" session back to a 30-day TTL, not 24h', async () => {
    const nearExpiryRememberToken = jwt.sign({ username: TEST_USERNAME, remember: true }, TEST_JWT_SECRET, { expiresIn: '30s' });
    const res = await request(app)
      .get('/api/auth/check')
      .set('Authorization', `Bearer ${nearExpiryRememberToken}`);

    const refreshed = extractSessionToken(res.headers['set-cookie']);
    expect(refreshed).toBeDefined();
    const decoded = jwt.verify(refreshed!, TEST_JWT_SECRET) as { exp: number; remember?: boolean };
    expect(decoded.remember).toBe(true);
    expect(decoded.exp * 1000 - Date.now()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
  });

  it('does not refresh when session_sliding_refresh is disabled', async () => {
    DatabaseService.getInstance().updateGlobalSetting('session_sliding_refresh', '0');
    const nearExpiryToken = jwt.sign({ username: TEST_USERNAME, remember: false }, TEST_JWT_SECRET, { expiresIn: '30s' });
    const res = await request(app)
      .get('/api/auth/check')
      .set('Authorization', `Bearer ${nearExpiryToken}`);

    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('"stay signed in" at login', () => {
  it('issues a 30-day session when remember is true', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USERNAME, password: TEST_PASSWORD, remember: true });

    expect(res.status).toBe(200);
    const token = extractSessionToken(res.headers['set-cookie']);
    expect(token).toBeDefined();
    const decoded = jwt.verify(token!, TEST_JWT_SECRET) as { exp: number; iat: number; remember?: boolean };
    expect(decoded.remember).toBe(true);
    expect(decoded.exp - decoded.iat).toBeCloseTo(30 * 24 * 60 * 60, -2);
  });

  it('issues the standard 24h session when remember is omitted', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USERNAME, password: TEST_PASSWORD });

    const token = extractSessionToken(res.headers['set-cookie']);
    const decoded = jwt.verify(token!, TEST_JWT_SECRET) as { exp: number; iat: number; remember?: boolean };
    expect(decoded.remember).toBe(false);
    expect(decoded.exp - decoded.iat).toBeCloseTo(24 * 60 * 60, -2);
  });

  it('carries remember through an MFA challenge to the final session', async () => {
    const { secret } = await seedMfaUser('mfa-remember-user', 'mfa-remember-pass');

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'mfa-remember-user', password: 'mfa-remember-pass', remember: true });
    expect(loginRes.body.mfaRequired).toBe(true);
    const pendingCookies = loginRes.headers['set-cookie'] as string | string[];
    const pendingCookieHeader = (Array.isArray(pendingCookies) ? pendingCookies : [pendingCookies]).find((c) => c.startsWith('sencho_mfa_pending='));
    expect(pendingCookieHeader).toBeDefined();

    const code = authenticator.generateSync({ secret, ...TOTP_PARAMS });
    const mfaRes = await request(app)
      .post('/api/auth/login/mfa')
      .set('Cookie', pendingCookieHeader!)
      .send({ code });

    expect(mfaRes.status).toBe(200);
    const finalToken = extractSessionToken(mfaRes.headers['set-cookie']);
    expect(finalToken).toBeDefined();
    const decoded = jwt.verify(finalToken!, TEST_JWT_SECRET) as { exp: number; iat: number; remember?: boolean };
    expect(decoded.remember).toBe(true);
    expect(decoded.exp - decoded.iat).toBeCloseTo(30 * 24 * 60 * 60, -2);
  });
});

describe('reissueSessionAfterTokenBump preserves "stay signed in"', () => {
  it('keeps a 30-day session after a password change', async () => {
    const bcrypt = (await import('bcrypt')).default;
    const passwordHash = await bcrypt.hash('bump-test-pass', 1);
    DatabaseService.getInstance().addUser({ username: 'bump-test-user', password_hash: passwordHash, role: 'admin' });

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: 'bump-test-user', password: 'bump-test-pass', remember: true });
    const rememberedCookie = extractSessionToken(loginRes.headers['set-cookie']);
    const cookies = loginRes.headers['set-cookie'] as string | string[];
    const cookieHeader = (Array.isArray(cookies) ? cookies : [cookies]).find((c) => c.startsWith('sencho_token='));

    const changeRes = await request(app)
      .put('/api/auth/password')
      .set('Cookie', cookieHeader!)
      .send({ oldPassword: 'bump-test-pass', newPassword: 'bump-test-pass-2' });

    expect(changeRes.status).toBe(200);
    const reissued = extractSessionToken(changeRes.headers['set-cookie']);
    expect(reissued).toBeDefined();
    expect(reissued).not.toBe(rememberedCookie);
    const decoded = jwt.verify(reissued!, TEST_JWT_SECRET) as { exp: number; iat: number; remember?: boolean };
    expect(decoded.remember).toBe(true);
    expect(decoded.exp - decoded.iat).toBeCloseTo(30 * 24 * 60 * 60, -2);
  });
});
