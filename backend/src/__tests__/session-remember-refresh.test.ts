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

/** All Set-Cookie entries in a response for one cookie name. */
function cookieEntries(setCookieHeader: string | string[] | undefined, name: string): string[] {
  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
  return cookies.filter((c) => c.startsWith(`${name}=`));
}

/** All sencho_token Set-Cookie entries in a response (should never be more than one). */
function sessionCookieEntries(setCookieHeader: string | string[] | undefined): string[] {
  return cookieEntries(setCookieHeader, 'sencho_token');
}

/** Extract the sencho_token cookie's raw JWT value from a Set-Cookie header. */
function extractSessionToken(setCookieHeader: string | string[] | undefined): string | undefined {
  const match = sessionCookieEntries(setCookieHeader)[0];
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

  // The refresh sits after the token-version check in authMiddleware, which is
  // what makes it safe: a stale token cannot ride the refresh back to life. If
  // that ordering ever moved, these would be the tests to catch it.
  it('rejects (does not refresh) a near-expiry token with a stale token_version', async () => {
    const user = DatabaseService.getInstance().getUserByUsername(TEST_USERNAME)!;
    const staleToken = jwt.sign(
      { username: TEST_USERNAME, remember: false, tv: user.token_version - 1 },
      TEST_JWT_SECRET,
      { expiresIn: '30s' },
    );
    const res = await request(app)
      .get('/api/auth/check')
      .set('Authorization', `Bearer ${staleToken}`);

    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('refreshes a near-expiry token with a current token_version and carries it forward', async () => {
    const user = DatabaseService.getInstance().getUserByUsername(TEST_USERNAME)!;
    const currentToken = jwt.sign(
      { username: TEST_USERNAME, remember: false, tv: user.token_version },
      TEST_JWT_SECRET,
      { expiresIn: '30s' },
    );
    const res = await request(app)
      .get('/api/auth/check')
      .set('Authorization', `Bearer ${currentToken}`);

    expect(res.status).toBe(200);
    const refreshed = extractSessionToken(res.headers['set-cookie']);
    expect(refreshed).toBeDefined();
    const decoded = jwt.verify(refreshed!, TEST_JWT_SECRET) as { exp: number; tv?: number };
    expect(decoded.tv).toBe(user.token_version);
    expect(decoded.exp * 1000 - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
  });
});

describe('"stay signed in" at login', () => {
  it('issues a 30-day session when remember is true', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_USERNAME, password: TEST_PASSWORD, remember: true });

    expect(res.status).toBe(200);
    const cookieEntry = sessionCookieEntries(res.headers['set-cookie'])[0];
    expect(cookieEntry).toBeDefined();
    // The cookie's own Max-Age must match the JWT's exp, or a browser would
    // drop the cookie before the token expires, defeating "stay signed in"
    // even though the token itself looks correct.
    expect(cookieEntry).toMatch(/Max-Age=2592000/);
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
    const pendingCookieHeader = cookieEntries(loginRes.headers['set-cookie'], 'sencho_mfa_pending')[0];
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
    const cookieHeader = sessionCookieEntries(loginRes.headers['set-cookie'])[0];

    const changeRes = await request(app)
      .put('/api/auth/password')
      .set('Cookie', cookieHeader!)
      .send({ oldPassword: 'bump-test-pass', newPassword: 'bump-test-pass-2' });

    expect(changeRes.status).toBe(200);
    // Exactly one sencho_token Set-Cookie, not one from the sliding refresh
    // (pre-bump token_version) followed by a second from the post-bump
    // reissue: a second, stale entry would leave any client that reads the
    // first Set-Cookie signed out on its very next request.
    expect(sessionCookieEntries(changeRes.headers['set-cookie'])).toHaveLength(1);
    const reissued = extractSessionToken(changeRes.headers['set-cookie']);
    expect(reissued).toBeDefined();
    expect(reissued).not.toBe(rememberedCookie);
    const decoded = jwt.verify(reissued!, TEST_JWT_SECRET) as { exp: number; iat: number; remember?: boolean };
    expect(decoded.remember).toBe(true);
    expect(decoded.exp - decoded.iat).toBeCloseTo(30 * 24 * 60 * 60, -2);
  });

  it('does not duplicate the session cookie when the password change lands inside the sliding-refresh window', async () => {
    const bcrypt = (await import('bcrypt')).default;
    const passwordHash = await bcrypt.hash('bump-window-pass', 1);
    const db = DatabaseService.getInstance();
    db.addUser({ username: 'bump-window-user', password_hash: passwordHash, role: 'admin' });
    const user = db.getUserByUsername('bump-window-user')!;

    // Hand-sign a near-expiry token so authMiddleware's sliding refresh fires
    // on this very request, immediately before the route bumps token_version.
    const nearExpiryToken = jwt.sign(
      { username: 'bump-window-user', remember: true, tv: user.token_version },
      TEST_JWT_SECRET,
      { expiresIn: '30s' },
    );

    const changeRes = await request(app)
      .put('/api/auth/password')
      .set('Authorization', `Bearer ${nearExpiryToken}`)
      .send({ oldPassword: 'bump-window-pass', newPassword: 'bump-window-pass-2' });

    expect(changeRes.status).toBe(200);
    const entries = sessionCookieEntries(changeRes.headers['set-cookie']);
    expect(entries).toHaveLength(1);
    const decoded = jwt.verify(extractSessionToken(changeRes.headers['set-cookie'])!, TEST_JWT_SECRET) as { tv?: number };
    expect(decoded.tv).toBe(db.getUserByUsername('bump-window-user')!.token_version);
  });
});
