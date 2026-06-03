/**
 * Tests for the API-token hardening pass:
 *   - validateApiToken: shared format/checksum/lookup/revocation/expiry result.
 *   - touchApiTokenLastUsed: throttled last-used write.
 *   - rateLimitKeyGenerator: per-token budget only for live tokens; forged,
 *     bad-checksum, revoked, or expired token-shaped bearers fall back to
 *     per-IP keying so they cannot fragment the limiter (H-1).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { Request } from 'express';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { COOKIE_NAME } from '../helpers/constants';
import { generateApiToken } from '../utils/apiTokenFormat';
import { validateApiToken, touchApiTokenLastUsed } from '../utils/apiTokenAuth';
import { rateLimitKeyGenerator } from '../middleware/rateLimiters';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

/** Insert an API token directly and return both the raw value and its row id. */
function createToken(
  scope: 'read-only' | 'deploy-only' | 'full-admin',
  opts: { expiresAt?: number | null; revoked?: boolean } = {},
): { raw: string; id: number } {
  const raw = generateApiToken();
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  const db = DatabaseService.getInstance();
  const userId = db.getUserByUsername('testadmin')!.id;
  const id = db.addApiToken({
    token_hash: tokenHash,
    name: `hardening-${scope}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    scope,
    user_id: userId,
    created_at: Date.now(),
    expires_at: opts.expiresAt ?? null,
  });
  if (opts.revoked) db.revokeApiToken(id);
  return { raw, id };
}

/** Minimal Express request carrying a Bearer token, for the key generator. */
function bearerReq(token: string): Request {
  return { cookies: {}, headers: { authorization: `Bearer ${token}` }, ip: '203.0.113.7' } as unknown as Request;
}

const sk16 = (raw: string): string => crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);

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
    const result = validateApiToken(generateApiToken());
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
    const { id } = createToken('read-only');
    const row = DatabaseService.getInstance().getApiTokenById(id)!;
    const spy = vi.spyOn(DatabaseService.getInstance(), 'updateApiTokenLastUsed');
    touchApiTokenLastUsed({ ...row, last_used_at: null });
    expect(spy).toHaveBeenCalledWith(id);
  });

  it('writes when last_used_at is stale (older than the throttle window)', () => {
    const { id } = createToken('read-only');
    const row = DatabaseService.getInstance().getApiTokenById(id)!;
    const spy = vi.spyOn(DatabaseService.getInstance(), 'updateApiTokenLastUsed');
    touchApiTokenLastUsed({ ...row, last_used_at: Date.now() - 70_000 });
    expect(spy).toHaveBeenCalledWith(id);
  });

  it('skips the write when last_used_at is within the throttle window', () => {
    const { id } = createToken('read-only');
    const row = DatabaseService.getInstance().getApiTokenById(id)!;
    const spy = vi.spyOn(DatabaseService.getInstance(), 'updateApiTokenLastUsed');
    touchApiTokenLastUsed({ ...row, last_used_at: Date.now() - 1000 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('rateLimitKeyGenerator (API token branch)', () => {
  it('keys a live token by its own hash and memoizes the row for auth reuse', () => {
    const { raw } = createToken('read-only');
    const spy = vi.spyOn(DatabaseService.getInstance(), 'getApiTokenByHash');
    const req = bearerReq(raw);
    expect(rateLimitKeyGenerator(req)).toBe(`user:sk:${sk16(raw)}`);
    expect(req._apiToken?.token_hash).toBe(crypto.createHash('sha256').update(raw).digest('hex'));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reuses the memoized row on a second pass without another lookup', () => {
    const { raw } = createToken('read-only');
    const req = bearerReq(raw);
    rateLimitKeyGenerator(req);
    const spy = vi.spyOn(DatabaseService.getInstance(), 'getApiTokenByHash');
    expect(rateLimitKeyGenerator(req)).toBe(`user:sk:${sk16(raw)}`);
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
    const req = bearerReq(generateApiToken());
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
    const keyA = rateLimitKeyGenerator(forged(generateApiToken()));
    const keyB = rateLimitKeyGenerator(forged(generateApiToken()));
    const keyAnon = rateLimitKeyGenerator({ cookies: {}, headers: {}, ip } as unknown as Request);
    expect(keyA).not.toMatch(/^user:sk:/);
    expect(keyA).toBe(keyB);
    expect(keyA).toBe(keyAnon);
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
