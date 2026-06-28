/**
 * Tests for the API-token hardening pass:
 *   - validateApiToken: shared format/checksum/lookup/revocation/expiry result.
 *   - touchApiTokenLastUsed: throttled last-used write.
 *   - rateLimitKeyGenerator: per-token budget only for live tokens; forged,
 *     bad-checksum, revoked, or expired token-shaped bearers fall back to
 *     per-IP keying so they cannot fragment the limiter (H-1).
 *   - rateLimitKeyGenerator (JWT / cookie): only a signature-verified session
 *     username is keyed per-user; forged or expired JWTs (bearer or cookie) fall
 *     back to per-IP, and a present Bearer never defers to the cookie.
 *
 * Token rows are seeded through the shared apiTokenTestHelper and their stored
 * hash is read back from the row, so this suite hashes nothing itself.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request } from 'express';
import type { ApiToken } from '../services/DatabaseService';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { COOKIE_NAME } from '../helpers/constants';
import { createTestApiToken, unbackedApiToken } from './helpers/apiTokenTestHelper';
import { validateApiToken, touchApiTokenLastUsed } from '../utils/apiTokenAuth';
import { rateLimitKeyGenerator } from '../middleware/rateLimiters';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

/** Seed an API token via the shared helper and return the raw value plus its stored row. */
function createToken(
  scope: 'read-only' | 'deploy-only' | 'full-admin',
  opts: { expiresAt?: number | null; revoked?: boolean } = {},
): { raw: string; row: ApiToken } {
  const db = DatabaseService.getInstance();
  const userId = db.getUserByUsername('testadmin')!.id;
  const name = `hardening-${scope}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const raw = createTestApiToken({ db: DatabaseService, scope, userId, name, expiresAt: opts.expiresAt ?? null });
  const row = db.getActiveApiTokenByNameAndUser(name, userId)!;
  if (opts.revoked) db.revokeApiToken(row.id);
  return { raw, row };
}

/** Minimal Express request carrying a Bearer token, for the key generator. */
function bearerReq(token: string): Request {
  return { cookies: {}, headers: { authorization: `Bearer ${token}` }, ip: '203.0.113.7' } as unknown as Request;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('validateApiToken', () => {
  it('accepts a live token', () => {
    const { raw } = createToken('read-only');
    const result = validateApiToken(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.token.scope).toBe('read-only');
  });

  it('rejects a non-token string', () => {
    const result = validateApiToken('not-a-sencho-token');
    expect(result).toEqual({ ok: false, reason: 'not-api-token' });
  });

  it('rejects a token-shaped string with a bad checksum', () => {
    const result = validateApiToken('sen_sk_' + 'A'.repeat(49));
    expect(result).toEqual({ ok: false, reason: 'checksum' });
  });

  it('rejects a well-formed token that is not in the database', () => {
    const result = validateApiToken(unbackedApiToken());
    expect(result).toEqual({ ok: false, reason: 'not-found' });
  });

  it('rejects a revoked token', () => {
    const { raw } = createToken('full-admin', { revoked: true });
    const result = validateApiToken(raw);
    expect(result).toEqual({ ok: false, reason: 'revoked' });
  });

  it('rejects an expired token', () => {
    const { raw } = createToken('deploy-only', { expiresAt: Date.now() - 1000 });
    const result = validateApiToken(raw);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('touchApiTokenLastUsed', () => {
  it('writes when last_used_at is null', () => {
    const { row } = createToken('read-only');
    const spy = vi.spyOn(DatabaseService.getInstance(), 'updateApiTokenLastUsed');
    touchApiTokenLastUsed({ ...row, last_used_at: null });
    expect(spy).toHaveBeenCalledWith(row.id);
  });

  it('writes when last_used_at is stale (older than the throttle window)', () => {
    const { row } = createToken('read-only');
    const spy = vi.spyOn(DatabaseService.getInstance(), 'updateApiTokenLastUsed');
    touchApiTokenLastUsed({ ...row, last_used_at: Date.now() - 70_000 });
    expect(spy).toHaveBeenCalledWith(row.id);
  });

  it('skips the write when last_used_at is within the throttle window', () => {
    const { row } = createToken('read-only');
    const spy = vi.spyOn(DatabaseService.getInstance(), 'updateApiTokenLastUsed');
    touchApiTokenLastUsed({ ...row, last_used_at: Date.now() - 1000 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('rateLimitKeyGenerator (API token branch)', () => {
  it('keys a live token by its own hash and memoizes the row for auth reuse', () => {
    const { raw, row } = createToken('read-only');
    const spy = vi.spyOn(DatabaseService.getInstance(), 'getApiTokenByHash');
    const req = bearerReq(raw);
    expect(rateLimitKeyGenerator(req)).toBe(`user:sk:${row.token_hash.slice(0, 16)}`);
    expect(req._apiToken?.token_hash).toBe(row.token_hash);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reuses the memoized row on a second pass without another lookup', () => {
    const { raw, row } = createToken('read-only');
    const req = bearerReq(raw);
    rateLimitKeyGenerator(req);
    const spy = vi.spyOn(DatabaseService.getInstance(), 'getApiTokenByHash');
    expect(rateLimitKeyGenerator(req)).toBe(`user:sk:${row.token_hash.slice(0, 16)}`);
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to per-IP keying for a bad-checksum token without a DB lookup', () => {
    const spy = vi.spyOn(DatabaseService.getInstance(), 'getApiTokenByHash');
    const req = bearerReq('sen_sk_' + 'A'.repeat(49));
    const key = rateLimitKeyGenerator(req);
    expect(key).not.toMatch(/^user:sk:/);
    expect(key).toContain('203.0.113.7');
    expect(req._apiToken).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('falls back to per-IP keying for a well-formed but unknown token', () => {
    const req = bearerReq(unbackedApiToken());
    const key = rateLimitKeyGenerator(req);
    expect(key).not.toMatch(/^user:sk:/);
    expect(key).toContain('203.0.113.7');
    expect(req._apiToken).toBeUndefined();
  });

  it('falls back to per-IP keying for a revoked token', () => {
    const { raw } = createToken('full-admin', { revoked: true });
    const key = rateLimitKeyGenerator(bearerReq(raw));
    expect(key).not.toMatch(/^user:sk:/);
    expect(key).toContain('203.0.113.7');
  });

  it('falls back to per-IP keying for an expired token', () => {
    const { raw } = createToken('deploy-only', { expiresAt: Date.now() - 1000 });
    const key = rateLimitKeyGenerator(bearerReq(raw));
    expect(key).not.toMatch(/^user:sk:/);
    expect(key).toContain('203.0.113.7');
  });

  it('collapses distinct forged tokens from one IP into the same anonymous bucket (no fragmentation)', () => {
    // The H-1 property: a single source cannot mint a fresh per-token budget by
    // rotating forged token-shaped bearers. Two different well-formed tokens
    // that are not in the DB, from one IP, must share one key, and that key must
    // be the same per-IP bucket an unauthenticated request from that IP gets.
    const ip = '198.51.100.42';
    const forged = (token: string) =>
      ({ cookies: {}, headers: { authorization: `Bearer ${token}` }, ip } as unknown as Request);
    const keyA = rateLimitKeyGenerator(forged(unbackedApiToken()));
    const keyB = rateLimitKeyGenerator(forged(unbackedApiToken()));
    const keyAnon = rateLimitKeyGenerator({ cookies: {}, headers: {}, ip } as unknown as Request);
    expect(keyA).not.toMatch(/^user:sk:/);
    expect(keyA).toBe(keyB);
    expect(keyA).toBe(keyAnon);
  });

  it('keys a live API-token bearer by the token even when a cookie is present (bearer precedence)', () => {
    // authMiddleware prefers the Bearer token over the cookie, so the limiter
    // must key off the same credential; a forged cookie must not override the
    // token's bucket.
    const { raw, row } = createToken('read-only');
    const forgedCookie = jwt.sign({ username: 'someone-else' }, 'attacker-secret');
    const req = {
      cookies: { [COOKIE_NAME]: forgedCookie },
      headers: { authorization: `Bearer ${raw}` },
      ip: '203.0.113.7',
    } as unknown as Request;
    expect(rateLimitKeyGenerator(req)).toBe(`user:sk:${row.token_hash.slice(0, 16)}`);
  });

  it('does not let a forged cookie rescue a forged API-token bearer from per-IP keying', () => {
    const forgedCookie = jwt.sign({ username: 'rotated-1' }, 'attacker-secret');
    const req = {
      cookies: { [COOKIE_NAME]: forgedCookie },
      headers: { authorization: `Bearer ${unbackedApiToken()}` },
      ip: '203.0.113.7',
    } as unknown as Request;
    const key = rateLimitKeyGenerator(req);
    expect(key).not.toMatch(/^user:/);
    expect(key).toContain('203.0.113.7');
  });

  it('still keys a JWT session bearer by username (non-token branch intact)', () => {
    const token = jwt.sign({ username: 'ci-bot' }, TEST_JWT_SECRET);
    const req = { cookies: {}, headers: { authorization: `Bearer ${token}` }, ip: '203.0.113.7' } as unknown as Request;
    expect(rateLimitKeyGenerator(req)).toBe('user:ci-bot');
  });

  it('still keys a session cookie by username (cookie branch intact)', () => {
    const token = jwt.sign({ username: 'cookie-user' }, TEST_JWT_SECRET);
    const req = { cookies: { [COOKIE_NAME]: token }, headers: {}, ip: '203.0.113.7' } as unknown as Request;
    expect(rateLimitKeyGenerator(req)).toBe('user:cookie-user');
  });
});

describe('rateLimitKeyGenerator (JWT / cookie username branch)', () => {
  // A signature the server never issued: the baseline test DB seeds
  // auth_jwt_secret = TEST_JWT_SECRET (vitestGlobalSetup), so a JWT signed with
  // any other key fails verification and must never yield a per-user bucket.
  const WRONG_SECRET = 'attacker-controlled-secret';
  const IP = '198.51.100.9';
  // The per-IP bucket an unauthenticated request from `ip` gets; a verified-out
  // credential must collapse to exactly this key.
  const anonKey = (ip: string) =>
    rateLimitKeyGenerator({ cookies: {}, headers: {}, ip } as unknown as Request);

  it('falls back to per-IP for a forged Bearer JWT (wrong signature) despite a valid username claim', () => {
    const forged = jwt.sign({ username: 'victim' }, WRONG_SECRET);
    const key = rateLimitKeyGenerator(bearerReq(forged));
    expect(key).not.toMatch(/^user:/);
    expect(key).toBe(anonKey('203.0.113.7'));
  });

  it('collapses distinct forged Bearer JWTs from one IP into the anonymous bucket (no username fragmentation)', () => {
    const forgedFrom = (username: string) =>
      ({ cookies: {}, headers: { authorization: `Bearer ${jwt.sign({ username }, WRONG_SECRET)}` }, ip: IP } as unknown as Request);
    const keyA = rateLimitKeyGenerator(forgedFrom('rotated-1'));
    const keyB = rateLimitKeyGenerator(forgedFrom('rotated-2'));
    expect(keyA).not.toMatch(/^user:/);
    expect(keyA).toBe(keyB);
    expect(keyA).toBe(anonKey(IP));
  });

  it('falls back to per-IP for a forged session cookie (wrong signature)', () => {
    const forged = jwt.sign({ username: 'victim' }, WRONG_SECRET);
    const req = { cookies: { [COOKIE_NAME]: forged }, headers: {}, ip: IP } as unknown as Request;
    const key = rateLimitKeyGenerator(req);
    expect(key).not.toMatch(/^user:/);
    expect(key).toBe(anonKey(IP));
  });

  it('falls back to per-IP for a validly-signed but expired Bearer JWT', () => {
    const expired = jwt.sign({ username: 'ci-bot' }, TEST_JWT_SECRET, { expiresIn: -10 });
    const key = rateLimitKeyGenerator(bearerReq(expired));
    expect(key).not.toMatch(/^user:/);
    expect(key).toBe(anonKey('203.0.113.7'));
  });

  it('falls back to per-IP for a validly-signed but expired session cookie', () => {
    const expired = jwt.sign({ username: 'cookie-user' }, TEST_JWT_SECRET, { expiresIn: -10 });
    const req = { cookies: { [COOKIE_NAME]: expired }, headers: {}, ip: IP } as unknown as Request;
    const key = rateLimitKeyGenerator(req);
    expect(key).not.toMatch(/^user:/);
    expect(key).toBe(anonKey(IP));
  });

  it('does not let a valid session cookie rescue a forged Bearer JWT (bearer precedence)', () => {
    // auth uses bearerToken || cookieToken, so a present-but-invalid Bearer is the
    // credential auth rejects; the limiter must not key it as the cookie's user.
    const validCookie = jwt.sign({ username: 'real-user' }, TEST_JWT_SECRET);
    const forgedBearer = jwt.sign({ username: 'attacker' }, WRONG_SECRET);
    const req = {
      cookies: { [COOKIE_NAME]: validCookie },
      headers: { authorization: `Bearer ${forgedBearer}` },
      ip: IP,
    } as unknown as Request;
    const key = rateLimitKeyGenerator(req);
    expect(key).not.toMatch(/^user:/);
    expect(key).toBe(anonKey(IP));
  });

  it('does not let a valid session cookie rescue an expired Bearer JWT (bearer precedence)', () => {
    const validCookie = jwt.sign({ username: 'real-user' }, TEST_JWT_SECRET);
    const expiredBearer = jwt.sign({ username: 'real-user' }, TEST_JWT_SECRET, { expiresIn: -10 });
    const req = {
      cookies: { [COOKIE_NAME]: validCookie },
      headers: { authorization: `Bearer ${expiredBearer}` },
      ip: IP,
    } as unknown as Request;
    const key = rateLimitKeyGenerator(req);
    expect(key).not.toMatch(/^user:/);
    expect(key).toBe(anonKey(IP));
  });

  it('keys a valid Bearer JWT by its own username even when a valid cookie for another user is present (bearer precedence)', () => {
    // The positive mirror: auth would use the Bearer, so the limiter must key the
    // Bearer user, never the unrelated cookie user. Guards against a refactor that
    // consults the cookie before the verified Bearer.
    const validBearer = jwt.sign({ username: 'bearer-user' }, TEST_JWT_SECRET);
    const validCookie = jwt.sign({ username: 'cookie-user' }, TEST_JWT_SECRET);
    const req = {
      cookies: { [COOKIE_NAME]: validCookie },
      headers: { authorization: `Bearer ${validBearer}` },
      ip: IP,
    } as unknown as Request;
    expect(rateLimitKeyGenerator(req)).toBe('user:bearer-user');
  });

  it('fails closed to per-IP when the JWT signing secret is unset', () => {
    // The explicit no-secret branch in verifiedJwtPayload: a validly-signed token
    // must still collapse to per-IP rather than throw or grant a per-user bucket.
    vi.spyOn(DatabaseService.getInstance(), 'getGlobalSettings').mockReturnValue({});
    const validBearer = jwt.sign({ username: 'ci-bot' }, TEST_JWT_SECRET);
    const key = rateLimitKeyGenerator(bearerReq(validBearer));
    expect(key).not.toMatch(/^user:/);
    expect(key).toBe(anonKey('203.0.113.7'));
  });
});
