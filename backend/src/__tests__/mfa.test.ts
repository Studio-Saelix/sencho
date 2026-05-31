/**
 * Tests for Multi-Factor Authentication (TOTP + backup codes):
 *   - Enrolment flow (start + confirm) and rejection of wrong OTPs
 *   - Login flow: password -> mfa_pending cookie -> /login/mfa -> session cookie
 *   - Replay prevention: same (user, code, window) refused twice
 *   - Backup code single-use semantics and remaining count
 *   - Lockout after repeated failures
 *   - Partial-auth session: mfa_pending token rejected on non-MFA routes
 *   - Admin reset endpoint
 *   - SSO bypass toggle
 *   - CLI reset helper (direct import, no subprocess)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { OTP } from 'otplib';
import {
  setupTestDb,
  cleanupTestDb,
  seedMfaUser,
  TEST_USERNAME,
  TEST_JWT_SECRET,
} from './helpers/setupTestDb';

// Match the server-side otplib configuration so test-generated OTPs are
// accepted by the verify path.
const authenticator = new OTP({ strategy: 'totp' });
const TOTP_PARAMS = { algorithm: 'sha1' as const, digits: 6, period: 30 };

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let MfaService: typeof import('../services/MfaService').MfaService;

function adminToken(): string {
  const db = DatabaseService.getInstance();
  const user = db.getUserByUsername(TEST_USERNAME)!;
  return jwt.sign(
    { username: TEST_USERNAME, role: 'admin', tv: user.token_version },
    TEST_JWT_SECRET,
    { expiresIn: '1m' },
  );
}

function cookieArray(headers: request.Response['headers']): string[] {
  const raw = headers['set-cookie'] as unknown;
  if (!raw) return [];
  return Array.isArray(raw) ? (raw as string[]) : [raw as string];
}

function parseCookie(headers: request.Response['headers'], name: string): string | null {
  for (const c of cookieArray(headers)) {
    if (c.startsWith(`${name}=`)) {
      const value = c.split(';')[0].split('=').slice(1).join('=');
      // express-server `clearCookie` sends an empty value with an expired date
      return value || null;
    }
  }
  return null;
}

function findCookie(headers: request.Response['headers'], name: string): string | undefined {
  return cookieArray(headers).find((c) => c.startsWith(`${name}=`));
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ MfaService } = await import('../services/MfaService'));

  // Mock LicenseService to return paid/admiral so the admin routes pass gates
  const { LicenseService } = await import('../services/LicenseService');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('admiral');
  vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: null, maxViewers: null });

  ({ app } = await import('../index'));
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

// ─── MfaService unit-ish tests ────────────────────────────────────────────────

describe('MfaService', () => {
  it('verifyTotp accepts a freshly generated code', () => {
    const secret = MfaService.generateSecret();
    const code = authenticator.generateSync({ secret, ...TOTP_PARAMS });
    expect(MfaService.verifyTotp(secret, code)).toBe(true);
  });

  it('verifyTotp rejects garbage', () => {
    const secret = MfaService.generateSecret();
    expect(MfaService.verifyTotp(secret, '000000')).toBe(false);
    expect(MfaService.verifyTotp(secret, 'abcdef')).toBe(false);
    expect(MfaService.verifyTotp(secret, '')).toBe(false);
  });

  it('generateBackupCodes returns 10 uppercase-alnum codes', () => {
    const codes = MfaService.generateBackupCodes();
    expect(codes).toHaveLength(10);
    for (const c of codes) {
      expect(c).toMatch(/^[A-Z0-9]{10}$/);
    }
  });

  it('verifyBackupCode matches and returns the matched hash for the caller to consume', async () => {
    const codes = MfaService.generateBackupCodes();
    const hashes = await MfaService.hashBackupCodes(codes);
    const result = await MfaService.verifyBackupCode(hashes, codes[3]);
    expect(result.matched).toBe(true);
    if (result.matched) expect(result.matchedHash).toBe(hashes[3]);
  });

  it('verifyBackupCode on non-match reports no match', async () => {
    const codes = MfaService.generateBackupCodes();
    const hashes = await MfaService.hashBackupCodes(codes);
    const result = await MfaService.verifyBackupCode(hashes, 'NOTACODE99');
    expect(result.matched).toBe(false);
  });

  it('normalizeBackupCode strips spaces/dashes and uppercases', () => {
    expect(MfaService.normalizeBackupCode('abcde-fghij')).toBe('ABCDEFGHIJ');
    expect(MfaService.normalizeBackupCode('abcde fghij')).toBe('ABCDEFGHIJ');
  });
});

// ─── consumeBackupCodeHash: the atomic single-use enforcement point ────────────

describe('DatabaseService.consumeBackupCodeHash', () => {
  it('consumes a present hash once: a second consume of the same hash returns false', async () => {
    const { userId, backupCodes } = await seedMfaUser('consume-same', 'mfapassword123');
    const db = DatabaseService.getInstance();
    const hashes = JSON.parse(db.getUserMfa(userId)!.backup_codes_json!) as string[];
    const target = hashes[2];

    // First consume wins, second loses: this is what guarantees single-use
    // when two concurrent logins race on the same code.
    expect(db.consumeBackupCodeHash(userId, target)).toBe(true);
    expect(db.consumeBackupCodeHash(userId, target)).toBe(false);

    const remaining = JSON.parse(db.getUserMfa(userId)!.backup_codes_json!) as string[];
    expect(remaining).toHaveLength(backupCodes.length - 1);
    expect(remaining).not.toContain(target);
  });

  it('consumes two distinct hashes independently, dropping the set by two', async () => {
    const { userId, backupCodes } = await seedMfaUser('consume-distinct', 'mfapassword123');
    const db = DatabaseService.getInstance();
    const hashes = JSON.parse(db.getUserMfa(userId)!.backup_codes_json!) as string[];

    expect(db.consumeBackupCodeHash(userId, hashes[0])).toBe(true);
    expect(db.consumeBackupCodeHash(userId, hashes[1])).toBe(true);

    const remaining = JSON.parse(db.getUserMfa(userId)!.backup_codes_json!) as string[];
    expect(remaining).toHaveLength(backupCodes.length - 2);
  });

  it('returns false for a hash that is not in the stored set', async () => {
    const { userId } = await seedMfaUser('consume-absent', 'mfapassword123');
    const db = DatabaseService.getInstance();
    expect(db.consumeBackupCodeHash(userId, 'not-a-stored-hash')).toBe(false);
  });
});

// ─── Login flow ───────────────────────────────────────────────────────────────

describe('POST /api/auth/login with MFA-enabled user', () => {
  const username = 'mfauser-login';
  const password = 'mfapassword123';

  it('returns mfaRequired and sets the partial-auth cookie only', async () => {
    await seedMfaUser(username, password);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username, password });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.mfaRequired).toBe(true);

    expect(parseCookie(res.headers, 'sencho_mfa_pending')).toBeTruthy();
    // No full session cookie yet.
    expect(parseCookie(res.headers, 'sencho_token')).toBeFalsy();
  });

  it('/auth/status reports mfaPending=true for a valid pending cookie', async () => {
    const login = await request(app).post('/api/auth/login').send({ username, password });
    const pendingCookie = findCookie(login.headers, 'sencho_mfa_pending')!;

    const status = await request(app).get('/api/auth/status').set('Cookie', pendingCookie);
    expect(status.status).toBe(200);
    expect(status.body.mfaPending).toBe(true);
  });
});

// ─── MFA verify endpoint ──────────────────────────────────────────────────────

describe('POST /api/auth/login/mfa', () => {
  const username = 'mfauser-verify';
  const password = 'mfapassword123';
  let secret = '';
  let backupCodes: string[] = [];

  beforeAll(async () => {
    ({ secret, backupCodes } = await seedMfaUser(username, password));
  });

  async function startChallenge() {
    const res = await request(app).post('/api/auth/login').send({ username, password });
    return findCookie(res.headers, 'sencho_mfa_pending')!;
  }

  it('401 when no pending cookie is present', async () => {
    const res = await request(app).post('/api/auth/login/mfa').send({ code: '123456' });
    expect(res.status).toBe(401);
  });

  it('accepts a valid TOTP, clears pending cookie, issues session', async () => {
    const pendingCookie = await startChallenge();
    const code = authenticator.generateSync({ secret, ...TOTP_PARAMS });

    const res = await request(app)
      .post('/api/auth/login/mfa')
      .set('Cookie', pendingCookie)
      .send({ code });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Session cookie is issued.
    expect(findCookie(res.headers, 'sencho_token')).toBeDefined();
    // Pending cookie is cleared (empty value or Expires in the past).
    const cleared = findCookie(res.headers, 'sencho_mfa_pending');
    expect(cleared).toBeDefined();
    expect(cleared!).toMatch(/sencho_mfa_pending=;/);
  });

  it('rejects a replayed TOTP within the same window', async () => {
    // Fresh user so previous test state does not pollute the replay table.
    const u = 'mfauser-replay';
    const p = 'mfapassword123';
    const { secret: s } = await seedMfaUser(u, p);

    const login = await request(app).post('/api/auth/login').send({ username: u, password: p });
    const pending = findCookie(login.headers, 'sencho_mfa_pending')!;
    const code = authenticator.generateSync({ secret: s, ...TOTP_PARAMS });

    const ok = await request(app).post('/api/auth/login/mfa').set('Cookie', pending).send({ code });
    expect(ok.status).toBe(200);

    // Second login, same code, still within this 30s window
    const login2 = await request(app).post('/api/auth/login').send({ username: u, password: p });
    const pending2 = findCookie(login2.headers, 'sencho_mfa_pending')!;
    const replay = await request(app).post('/api/auth/login/mfa').set('Cookie', pending2).send({ code });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('OTP_REPLAY');
  });

  it('rejects an obviously wrong TOTP', async () => {
    const pending = await startChallenge();
    const res = await request(app).post('/api/auth/login/mfa').set('Cookie', pending).send({ code: '000000' });
    expect(res.status).toBe(401);
  });

  it('accepts a backup code and invalidates it on a second submission', async () => {
    const u = 'mfauser-backup';
    const p = 'mfapassword123';
    const { backupCodes: codes } = await seedMfaUser(u, p);
    const chosen = codes[0];

    // First use: ok
    const login1 = await request(app).post('/api/auth/login').send({ username: u, password: p });
    const pending1 = findCookie(login1.headers, 'sencho_mfa_pending')!;
    const first = await request(app)
      .post('/api/auth/login/mfa')
      .set('Cookie', pending1)
      .send({ code: chosen, isBackupCode: true });
    expect(first.status).toBe(200);

    // Second use of the same code: rejected
    const login2 = await request(app).post('/api/auth/login').send({ username: u, password: p });
    const pending2 = findCookie(login2.headers, 'sencho_mfa_pending')!;
    const second = await request(app)
      .post('/api/auth/login/mfa')
      .set('Cookie', pending2)
      .send({ code: chosen, isBackupCode: true });
    expect(second.status).toBe(401);

    // Remaining backup count decreased by exactly 1
    const remaining = backupCodes.length;
    const db = DatabaseService.getInstance();
    const user = db.getUserByUsername(u)!;
    const mfa = db.getUserMfa(user.id)!;
    const hashes = mfa.backup_codes_json ? (JSON.parse(mfa.backup_codes_json) as string[]) : [];
    expect(hashes.length).toBe(remaining - 1);
  });

  it('enforces single-use when the same backup code is submitted concurrently', async () => {
    const u = 'mfauser-backup-race';
    const p = 'mfapassword123';
    const { backupCodes: codes } = await seedMfaUser(u, p);
    const chosen = codes[0];

    // Two independent pending challenges, then fire both /login/mfa calls with
    // the same backup code at once. The bcrypt.compare await lets both requests
    // read the same hash set before either consumes it; the atomic consume must
    // still let exactly one win (the regression guard for the consume race).
    const [login1, login2] = await Promise.all([
      request(app).post('/api/auth/login').send({ username: u, password: p }),
      request(app).post('/api/auth/login').send({ username: u, password: p }),
    ]);
    const pending1 = findCookie(login1.headers, 'sencho_mfa_pending')!;
    const pending2 = findCookie(login2.headers, 'sencho_mfa_pending')!;

    const [r1, r2] = await Promise.all([
      request(app).post('/api/auth/login/mfa').set('Cookie', pending1).send({ code: chosen, isBackupCode: true }),
      request(app).post('/api/auth/login/mfa').set('Cookie', pending2).send({ code: chosen, isBackupCode: true }),
    ]);

    expect([r1, r2].filter((r) => r.status === 200)).toHaveLength(1);
    expect([r1, r2].filter((r) => r.status === 401)).toHaveLength(1);

    // Exactly one code was consumed from the stored set.
    const db = DatabaseService.getInstance();
    const mfa = db.getUserMfa(db.getUserByUsername(u)!.id)!;
    const hashes = mfa.backup_codes_json ? (JSON.parse(mfa.backup_codes_json) as string[]) : [];
    expect(hashes.length).toBe(codes.length - 1);
  });

  it('exhausts all backup codes: each works once, then none remain', async () => {
    const u = 'mfauser-backup-exhaust';
    const p = 'mfapassword123';
    const { backupCodes: codes } = await seedMfaUser(u, p);

    for (const code of codes) {
      const login = await request(app).post('/api/auth/login').send({ username: u, password: p });
      const pending = findCookie(login.headers, 'sencho_mfa_pending')!;
      const res = await request(app)
        .post('/api/auth/login/mfa')
        .set('Cookie', pending)
        .send({ code, isBackupCode: true });
      expect(res.status).toBe(200);
    }

    const db = DatabaseService.getInstance();
    const mfa = db.getUserMfa(db.getUserByUsername(u)!.id)!;
    const remaining = mfa.backup_codes_json ? (JSON.parse(mfa.backup_codes_json) as string[]) : [];
    expect(remaining.length).toBe(0);

    // A further attempt with a spent code is rejected cleanly, not crashed.
    const login = await request(app).post('/api/auth/login').send({ username: u, password: p });
    const pending = findCookie(login.headers, 'sencho_mfa_pending')!;
    const after = await request(app)
      .post('/api/auth/login/mfa')
      .set('Cookie', pending)
      .send({ code: codes[0], isBackupCode: true });
    expect(after.status).toBe(401);
  });

  it('locks the user after MFA_MAX_FAILED (5) wrong codes and returns 423', async () => {
    const u = 'mfauser-lock';
    const p = 'mfapassword123';
    await seedMfaUser(u, p);

    const login = await request(app).post('/api/auth/login').send({ username: u, password: p });
    const pending = findCookie(login.headers, 'sencho_mfa_pending')!;

    let lastStatus = 0;
    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post('/api/auth/login/mfa')
        .set('Cookie', pending)
        .send({ code: '000000' });
      lastStatus = r.status;
    }
    expect(lastStatus).toBe(423);

    // Any further attempt still 423
    const blocked = await request(app)
      .post('/api/auth/login/mfa')
      .set('Cookie', pending)
      .send({ code: '111111' });
    expect(blocked.status).toBe(423);
  });
});

// ─── Partial-auth session guard ───────────────────────────────────────────────

describe('authMiddleware partial-auth guard', () => {
  it('rejects mfa_pending token on a non-MFA route with 403 MFA_PENDING', async () => {
    const pendingToken = jwt.sign(
      { scope: 'mfa_pending', user_id: 42, username: 'whoever' },
      TEST_JWT_SECRET,
      { expiresIn: '5m' },
    );
    const res = await request(app)
      .get('/api/stacks')
      .set('Authorization', `Bearer ${pendingToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MFA_PENDING');
  });
});

// ─── Enrol / confirm / disable ────────────────────────────────────────────────

describe('MFA enrol + confirm', () => {
  it('full enrol -> confirm activates MFA and returns 10 backup codes', async () => {
    // Create a dedicated user so we do not toggle MFA on the admin.
    const start = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ username: 'enroller', password: 'enrolpass123', role: 'viewer' });
    expect(start.status).toBe(201);

    const userId = start.body.id as number;
    const db = DatabaseService.getInstance();
    const user = db.getUserByUsername('enroller')!;
    const userToken = jwt.sign(
      { username: 'enroller', role: 'viewer', tv: user.token_version },
      TEST_JWT_SECRET,
      { expiresIn: '1m' },
    );

    const startRes = await request(app)
      .post('/api/auth/mfa/enroll/start')
      .set('Authorization', `Bearer ${userToken}`);
    expect(startRes.status).toBe(200);
    expect(typeof startRes.body.otpauthUri).toBe('string');
    expect(typeof startRes.body.secret).toBe('string');

    // Reject wrong OTP
    const wrong = await request(app)
      .post('/api/auth/mfa/enroll/confirm')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ code: '000000' });
    expect(wrong.status).toBe(401);

    const code = authenticator.generateSync({ secret: startRes.body.secret as string, ...TOTP_PARAMS });
    const confirm = await request(app)
      .post('/api/auth/mfa/enroll/confirm')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ code });
    expect(confirm.status).toBe(200);
    expect(Array.isArray(confirm.body.backupCodes)).toBe(true);
    expect(confirm.body.backupCodes).toHaveLength(10);

    const mfa = db.getUserMfa(userId);
    expect(mfa?.enabled).toBe(1);
  });

  it('rejects enroll/start when already enrolled', async () => {
    const db = DatabaseService.getInstance();
    const user = db.getUserByUsername('enroller')!;
    const token = jwt.sign(
      { username: 'enroller', role: 'viewer', tv: user.token_version },
      TEST_JWT_SECRET,
      { expiresIn: '1m' },
    );
    const res = await request(app)
      .post('/api/auth/mfa/enroll/start')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(409);
  });

  it('disable without a valid code returns 401 and MFA stays enabled', async () => {
    const db = DatabaseService.getInstance();
    const user = db.getUserByUsername('enroller')!;
    const token = jwt.sign(
      { username: 'enroller', role: 'viewer', tv: user.token_version },
      TEST_JWT_SECRET,
      { expiresIn: '1m' },
    );
    const res = await request(app)
      .post('/api/auth/mfa/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '000000' });
    expect(res.status).toBe(401);
    expect(db.getUserMfa(user.id)?.enabled).toBe(1);
  });

  it('disables MFA when a valid backup code is supplied as proof of possession', async () => {
    const db = DatabaseService.getInstance();
    const { userId, backupCodes } = await seedMfaUser('disabler-backup', 'mfapassword123');
    const user = db.getUser(userId)!;
    const token = jwt.sign(
      { username: 'disabler-backup', role: 'viewer', tv: user.token_version },
      TEST_JWT_SECRET,
      { expiresIn: '1m' },
    );
    const res = await request(app)
      .post('/api/auth/mfa/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: backupCodes[0], isBackupCode: true });
    expect(res.status).toBe(200);
    // Disable wipes the whole MFA record, so single-use of the code is moot here.
    expect(db.getUserMfa(userId)).toBeUndefined();
  });
});

// ─── Admin reset ──────────────────────────────────────────────────────────────

describe('POST /api/users/:id/mfa/reset', () => {
  it('non-admin caller gets 403', async () => {
    // Create a viewer and seed MFA for someone else
    const db = DatabaseService.getInstance();
    const { userId: victimId } = await seedMfaUser('victim', 'victimpass123');
    await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ username: 'nonadmin', password: 'nonadminpass123', role: 'viewer' });
    const nonAdmin = db.getUserByUsername('nonadmin')!;
    const nonAdminToken = jwt.sign(
      { username: 'nonadmin', role: 'viewer', tv: nonAdmin.token_version },
      TEST_JWT_SECRET,
      { expiresIn: '1m' },
    );
    const res = await request(app)
      .post(`/api/users/${victimId}/mfa/reset`)
      .set('Authorization', `Bearer ${nonAdminToken}`);
    expect(res.status).toBe(403);
    expect(db.getUserMfa(victimId)?.enabled).toBe(1);
  });

  it('admin clears the target MFA and bumps their token_version', async () => {
    const db = DatabaseService.getInstance();
    const { userId } = await seedMfaUser('victim2', 'victim2pass123');
    const before = db.getUser(userId)!.token_version;
    const res = await request(app)
      .post(`/api/users/${userId}/mfa/reset`)
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(db.getUserMfa(userId)).toBeUndefined();
    expect(db.getUser(userId)!.token_version).toBeGreaterThan(before);
  });
});

// ─── SSO bypass toggle ────────────────────────────────────────────────────────

describe('PUT /api/auth/mfa/sso-bypass', () => {
  it('persists the toggle on an enrolled user', async () => {
    const db = DatabaseService.getInstance();
    const { userId } = await seedMfaUser('ssouser', 'ssouserpass123');
    const user = db.getUserById(userId)!;
    const token = jwt.sign(
      { username: user.username, role: user.role, tv: user.token_version },
      TEST_JWT_SECRET,
      { expiresIn: '1m' },
    );

    const enable = await request(app)
      .put('/api/auth/mfa/sso-bypass')
      .set('Authorization', `Bearer ${token}`)
      .send({ enforce: true });
    expect(enable.status).toBe(200);
    expect(db.getUserMfa(userId)?.sso_enforce_mfa).toBe(1);

    const disable = await request(app)
      .put('/api/auth/mfa/sso-bypass')
      .set('Authorization', `Bearer ${token}`)
      .send({ enforce: false });
    expect(disable.status).toBe(200);
    expect(db.getUserMfa(userId)?.sso_enforce_mfa).toBe(0);
  });
});

// ─── CLI reset helper ─────────────────────────────────────────────────────────

describe('resetMfaForUser CLI helper', () => {
  it('clears MFA and bumps token_version for the target user', async () => {
    const { resetMfaForUser } = await import('../cli/resetMfa');
    const db = DatabaseService.getInstance();
    const { userId } = await seedMfaUser('cliuser', 'cliuserpass123');
    const before = db.getUser(userId)!.token_version;

    const result = await resetMfaForUser('cliuser');
    expect(result.ok).toBe(true);
    expect(db.getUserMfa(userId)).toBeUndefined();
    expect(db.getUser(userId)!.token_version).toBeGreaterThan(before);
  });

  it('returns ok:false for an unknown username', async () => {
    const { resetMfaForUser } = await import('../cli/resetMfa');
    const result = await resetMfaForUser('definitely-not-a-user');
    expect(result.ok).toBe(false);
  });
});

// ─── Edge cases surfaced by Phase 1 audit ─────────────────────────────────────

describe('MfaService.verifyTotp drift handling', () => {
  it('rejects a code generated more than one step outside the window', () => {
    const secret = MfaService.generateSecret();
    // Freeze clock at a known step boundary.
    const baseMs = 1_700_000_000_000;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(baseMs);
      const code = authenticator.generateSync({ secret, ...TOTP_PARAMS });
      // Advance three full 30s windows so the code is outside the +-1 tolerance.
      vi.setSystemTime(baseMs + 3 * 30_000);
      expect(MfaService.verifyTotp(secret, code)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still accepts a fresh code generated in the current window', () => {
    const secret = MfaService.generateSecret();
    const code = authenticator.generateSync({ secret, ...TOTP_PARAMS });
    expect(MfaService.verifyTotp(secret, code)).toBe(true);
  });
});

describe('MfaService.normalizeBackupCode canonicalisation', () => {
  it('canonicalises smart-dash and trailing whitespace to the hyphenless form', () => {
    // en-dash and em-dash variants a user may paste from a word processor
    expect(MfaService.normalizeBackupCode('abcde\u2013fghij ')).toBe('ABCDEFGHIJ');
    expect(MfaService.normalizeBackupCode('abcde\u2014fghij')).toBe('ABCDEFGHIJ');
    expect(MfaService.normalizeBackupCode('  ABCDE-FGHIJ\n')).toBe('ABCDEFGHIJ');
  });
});

describe('POST /api/auth/login/mfa edge cases', () => {
  const password = 'edgepass12345';

  async function challenge(username: string): Promise<string> {
    const res = await request(app).post('/api/auth/login').send({ username, password });
    return findCookie(res.headers, 'sencho_mfa_pending')!;
  }

  it('rejects backup codes with invalid format without reaching the bcrypt path', async () => {
    const username = 'mfa-badformat';
    const { userId } = await seedMfaUser(username, password);
    const db = DatabaseService.getInstance();
    const pending = await challenge(username);

    // Too short, non-alphanumeric garbage, and an 11-char alphanumeric that
    // matches no stored hash. All should produce 401 and increment the counter.
    const bad = ['12345', '!!!!!!!!!!!', 'ZZZZZZZZZZZ'];
    for (const code of bad) {
      const r = await request(app)
        .post('/api/auth/login/mfa')
        .set('Cookie', pending)
        .send({ code, isBackupCode: true });
      expect(r.status).toBe(401);
    }

    const mfa = db.getUserMfa(userId)!;
    expect(mfa.failed_attempts).toBe(bad.length);
  });

  it('clears failed_attempts on a successful verify after prior failures below the threshold', async () => {
    const username = 'mfa-reset-counter';
    const { userId, secret } = await seedMfaUser(username, password);
    const db = DatabaseService.getInstance();

    // Seed three failed attempts (below the 5-failure lockout threshold).
    db.upsertUserMfa(userId, { failed_attempts: 3, locked_until: null });
    expect(db.getUserMfa(userId)!.failed_attempts).toBe(3);

    const pending = await challenge(username);
    const ok = await request(app)
      .post('/api/auth/login/mfa')
      .set('Cookie', pending)
      .send({ code: authenticator.generateSync({ secret, ...TOTP_PARAMS }) });
    expect(ok.status).toBe(200);

    const after = db.getUserMfa(userId)!;
    expect(after.failed_attempts).toBe(0);
    expect(after.locked_until).toBeNull();
  });

  it('lets a locked user sign in again once locked_until has passed', async () => {
    const username = 'mfa-lock-expired';
    const { userId, secret } = await seedMfaUser(username, password);
    const db = DatabaseService.getInstance();

    // Simulate a stale lockout that has already expired.
    db.upsertUserMfa(userId, {
      failed_attempts: 5,
      locked_until: Date.now() - 60_000,
    });

    const pending = await challenge(username);
    const ok = await request(app)
      .post('/api/auth/login/mfa')
      .set('Cookie', pending)
      .send({ code: authenticator.generateSync({ secret, ...TOTP_PARAMS }) });
    expect(ok.status).toBe(200);

    const after = db.getUserMfa(userId)!;
    expect(after.failed_attempts).toBe(0);
    expect(after.locked_until).toBeNull();
  });
});

describe('MFA enrol/start overwrites a prior pending secret', () => {
  it('only the most recent enroll/start secret is valid on confirm', async () => {
    const username = 'mfa-overwrite';
    const password = 'overwritepass12345';
    // Create a plain user (no MFA seeded); we want to exercise the enrol path.
    const db = DatabaseService.getInstance();
    const bcryptMod = (await import('bcrypt')).default;
    const passwordHash = await bcryptMod.hash(password, 1);
    const userId = db.addUser({ username, password_hash: passwordHash, role: 'viewer' });

    const user = db.getUser(userId)!;
    const token = jwt.sign(
      { username, role: 'viewer', tv: user.token_version },
      TEST_JWT_SECRET,
      { expiresIn: '1m' },
    );

    const first = await request(app)
      .post('/api/auth/mfa/enroll/start')
      .set('Authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);
    const firstSecret = first.body.secret as string;

    const second = await request(app)
      .post('/api/auth/mfa/enroll/start')
      .set('Authorization', `Bearer ${token}`);
    expect(second.status).toBe(200);
    const secondSecret = second.body.secret as string;
    expect(secondSecret).not.toBe(firstSecret);

    // First secret no longer verifies against the stored (now-overwritten) secret.
    const wrongCode = authenticator.generateSync({ secret: firstSecret, ...TOTP_PARAMS });
    const rejected = await request(app)
      .post('/api/auth/mfa/enroll/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: wrongCode });
    // The rejected code may still happen to equal the new secret's current
    // code (1-in-a-million), so retry with the second secret on a clean run.
    if (rejected.status === 200) {
      // Extremely unlikely collision; the assertion proves the overwrite
      // path at least did not reject a valid-for-secondSecret code.
      expect(rejected.body.backupCodes).toHaveLength(10);
      return;
    }
    expect(rejected.status).toBe(401);

    // Second secret verifies on confirm.
    const ok = await request(app)
      .post('/api/auth/mfa/enroll/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: authenticator.generateSync({ secret: secondSecret, ...TOTP_PARAMS }) });
    expect(ok.status).toBe(200);
    expect(ok.body.backupCodes).toHaveLength(10);
  });
});
