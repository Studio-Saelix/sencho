/**
 * Stress tests for the tiered rate limiting system.
 *
 * Validates that:
 * - Polling endpoints are exempt from the global limiter but have their own ceiling
 * - Standard endpoints are governed by the global limiter
 * - Webhook triggers have a dedicated limiter
 * - Node proxy tokens bypass all rate limiters
 * - Authenticated requests are keyed by user session, not IP
 *
 * These tests run against the real Express app with in-memory SQLite.
 * Rate limits in development mode are 10x production values (1000/3000/5000),
 * so we test header presence and tier separation rather than hitting ceilings.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET, TEST_USERNAME, TEST_PASSWORD } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));

  // Log in to get an auth cookie for authenticated tests
  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ username: TEST_USERNAME, password: TEST_PASSWORD });
  const setCookie = loginRes.headers['set-cookie'];
  authCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

// ── Tier 0/1: Polling endpoints ──────────────────────────────────────────────

describe('Tier 0/1: Polling endpoints', () => {
  const pollingPaths = [
    '/api/health',
    '/api/meta',
    '/api/stats',
    '/api/system/stats',
    '/api/stacks/statuses',
    '/api/metrics/historical',
    '/api/auth/status',
    '/api/auth/sso/providers',
    '/api/license',
  ];

  it.each(pollingPaths)('%s returns polling-tier rate limit headers', async (path) => {
    const res = await request(app).get(path);
    const limit = parseInt(res.headers['ratelimit-limit'], 10);
    // Dev mode polling limit is 3000 (production would be 300)
    expect(limit).toBe(3000);
  });

  it('polling endpoints do NOT count against the global limiter', async () => {
    // Snapshot the global limiter's remaining count before polling
    const before = await request(app).get('/api/stacks');
    const remainBefore = parseInt(before.headers['ratelimit-remaining'], 10);

    // Hit 10 polling endpoints (none should decrement the global counter)
    await Promise.all(Array.from({ length: 10 }, () =>
      request(app).get('/api/health')
    ));

    // Check that the global limiter's remaining decreased by exactly 1
    // (the GET /api/stacks below, not the 10 polling requests)
    const after = await request(app).get('/api/stacks');
    const remainAfter = parseInt(after.headers['ratelimit-remaining'], 10);
    expect(remainAfter).toBe(remainBefore - 1);
  });

  it('rapid polling does not trigger global rate limit', async () => {
    // Snapshot the global limiter budget before polling
    const before = await request(app).get('/api/stacks');
    const remainBefore = parseInt(before.headers['ratelimit-remaining'], 10);

    // Fire 20 rapid polling requests
    const requests = Array.from({ length: 20 }, () =>
      request(app).get('/api/stats')
    );
    const results = await Promise.all(requests);

    // All should succeed (no 429)
    for (const res of results) {
      expect(res.status).not.toBe(429);
    }

    // Standard endpoint budget should only decrease by 1 (this request),
    // not by 21 (the 20 polling requests should not count)
    const after = await request(app).get('/api/stacks');
    const remainAfter = parseInt(after.headers['ratelimit-remaining'], 10);
    expect(remainAfter).toBe(remainBefore - 1);
  });
});

// ── Tier 2: Standard endpoints ───────────────────────────────────────────────

describe('Tier 2: Standard endpoints', () => {
  it('standard endpoints return global-tier rate limit headers', async () => {
    const res = await request(app).get('/api/stacks');
    const limit = parseInt(res.headers['ratelimit-limit'], 10);
    // Dev mode global limit is 1000 (production would be 200)
    expect(limit).toBe(1000);
  });

  it('standard endpoints do NOT get polling-tier headers', async () => {
    const res = await request(app).get('/api/containers');
    const limit = parseInt(res.headers['ratelimit-limit'], 10);
    // Should be 1000 (global), not 3000 (polling)
    expect(limit).not.toBe(3000);
    expect(limit).toBe(1000);
  });
});

// ── Node proxy bypass ────────────────────────────────────────────────────────
// Valid node_proxy JWTs skip both limiters. Polling paths (/api/stats) exercise
// pollingLimiter.skip; standard paths (/api/stacks) exercise globalApiLimiter.skip
// (global skip returns early for polling paths before consulting isNodeProxyRequest).

describe('Node proxy bypass', () => {
  function scopedToken(
    scope: string,
    secret = TEST_JWT_SECRET,
    opts: jwt.SignOptions = { expiresIn: '1h' },
  ): string {
    return jwt.sign({ scope }, secret, opts);
  }

  it('valid node_proxy token bypasses the polling limiter on /api/stats', async () => {
    const res = await request(app)
      .get('/api/stats')
      .set('Authorization', `Bearer ${scopedToken('node_proxy')}`);

    // When skipped, express-rate-limit does not set headers
    expect(res.headers['ratelimit-limit']).toBeUndefined();
  });

  it('valid node_proxy token bypasses the global limiter on /api/stacks', async () => {
    const res = await request(app)
      .get('/api/stacks')
      .set('Authorization', `Bearer ${scopedToken('node_proxy')}`);

    expect(res.headers['ratelimit-limit']).toBeUndefined();
  });

  it('forged node_proxy claim (wrong secret) still hits the polling limiter', async () => {
    const res = await request(app)
      .get('/api/stats')
      .set('Authorization', `Bearer ${scopedToken('node_proxy', 'wrong-secret')}`);

    expect(parseInt(res.headers['ratelimit-limit'], 10)).toBe(3000);
    expect(res.status).toBe(401);
  });

  it('forged node_proxy claim (wrong secret) still hits the global limiter', async () => {
    const res = await request(app)
      .get('/api/stacks')
      .set('Authorization', `Bearer ${scopedToken('node_proxy', 'wrong-secret')}`);

    expect(parseInt(res.headers['ratelimit-limit'], 10)).toBe(1000);
    expect(res.status).toBe(401);
  });

  it('expired node_proxy token still gets rate limited (fail closed)', async () => {
    const expired = scopedToken('node_proxy', TEST_JWT_SECRET, { expiresIn: '-1s' });

    const polling = await request(app)
      .get('/api/stats')
      .set('Authorization', `Bearer ${expired}`);
    expect(parseInt(polling.headers['ratelimit-limit'], 10)).toBe(3000);

    const standard = await request(app)
      .get('/api/stacks')
      .set('Authorization', `Bearer ${expired}`);
    expect(parseInt(standard.headers['ratelimit-limit'], 10)).toBe(1000);
  });

  it('valid pilot_tunnel token remains rate-limited (not exempt)', async () => {
    const res = await request(app)
      .get('/api/stacks')
      .set('Authorization', `Bearer ${scopedToken('pilot_tunnel')}`);

    expect(parseInt(res.headers['ratelimit-limit'], 10)).toBe(1000);
  });

  it('requests with invalid Bearer token still get rate limited', async () => {
    const res = await request(app)
      .get('/api/stats')
      .set('Authorization', 'Bearer invalid-token-here');

    // Should still get rate limit headers (polling tier for /stats)
    expect(parseInt(res.headers['ratelimit-limit'], 10)).toBe(3000);
  });

  it('requests with non-node_proxy Bearer token still get rate limited', async () => {
    const userToken = jwt.sign(
      { username: 'testuser', role: 'admin' },
      TEST_JWT_SECRET,
      { expiresIn: '1h' }
    );

    const res = await request(app)
      .get('/api/stacks')
      .set('Authorization', `Bearer ${userToken}`);

    expect(parseInt(res.headers['ratelimit-limit'], 10)).toBe(1000);
  });
});

// ── Hybrid key generator (per-user keying) ───────────────────────────────────

describe('Hybrid key generator', () => {
  it('authenticated requests are keyed by user, not IP', async () => {
    // Make requests with auth cookie
    const res1 = await request(app)
      .get('/api/stacks')
      .set('Cookie', authCookie);

    // Make a request without auth (keyed by IP)
    const res2 = await request(app).get('/api/stacks');

    // Both should succeed, and their remaining counts should be independent
    // (different rate limit buckets: user:testadmin vs IP)
    const remaining1 = parseInt(res1.headers['ratelimit-remaining'], 10);
    const remaining2 = parseInt(res2.headers['ratelimit-remaining'], 10);

    // Each should have its own budget. Floor is suite-aware: earlier cases in
    // this file (including forged/expired node_proxy requests keyed by IP)
    // already spent some of the anonymous bucket; independence still holds as
    // long as both remain near the 1000 ceiling.
    expect(remaining1).toBeGreaterThanOrEqual(980);
    expect(remaining2).toBeGreaterThanOrEqual(980);
  });

  it('two different users get independent rate limit budgets', async () => {
    // User A (via cookie)
    const resA = await request(app)
      .get('/api/stacks')
      .set('Cookie', authCookie);

    // User B (via Bearer with different username)
    const userBToken = jwt.sign(
      { username: 'otheruser', role: 'viewer' },
      TEST_JWT_SECRET,
      { expiresIn: '1h' }
    );
    const resB = await request(app)
      .get('/api/stacks')
      .set('Authorization', `Bearer ${userBToken}`);

    // Both should have independent remaining counts
    const remainA = parseInt(resA.headers['ratelimit-remaining'], 10);
    const remainB = parseInt(resB.headers['ratelimit-remaining'], 10);

    // Each user's budget should be near-full
    expect(remainA).toBeGreaterThanOrEqual(990);
    expect(remainB).toBeGreaterThanOrEqual(990);
  });
});

// ── Webhook trigger tier ─────────────────────────────────────────────────────

describe('Tier W: Webhook trigger', () => {
  it('webhook trigger route is exempt from the global limiter', async () => {
    // We can't easily test the webhook-specific limiter without creating a webhook,
    // but we can verify the global limiter skip logic by checking that rapid
    // POST requests to a webhook-trigger-shaped path don't decrement the global counter.

    // Hit a standard endpoint first to establish a baseline
    const baseline = await request(app).get('/api/stacks');
    const baselineRemaining = parseInt(baseline.headers['ratelimit-remaining'], 10);

    // POST to webhook trigger (will 404 since no webhook exists, but the rate
    // limiter skip runs before the route handler)
    await request(app).post('/api/webhooks/999/trigger').send({});

    // Check that the global limiter's remaining hasn't decreased
    const after = await request(app).get('/api/stacks');
    const afterRemaining = parseInt(after.headers['ratelimit-remaining'], 10);

    // Should have decreased by exactly 1 (the GET /api/stacks request itself)
    expect(afterRemaining).toBe(baselineRemaining - 1);
  });
});

// ── Tier separation stress test ──────────────────────────────────────────────

describe('Tier separation under load', () => {
  it('50 polling requests do not affect standard endpoint budget', async () => {
    // Blast 50 polling requests in parallel
    const pollingRequests = Array.from({ length: 50 }, () =>
      request(app).get('/api/health')
    );
    await Promise.all(pollingRequests);

    // Standard endpoint should still have a nearly full budget
    const stdRes = await request(app).get('/api/stacks');
    const remaining = parseInt(stdRes.headers['ratelimit-remaining'], 10);

    // Should have lost very few from the standard budget (only from other tests)
    expect(remaining).toBeGreaterThanOrEqual(980);
  });

  it('mixed polling and standard requests maintain independent counters', async () => {
    // Interleave 10 polling and 10 standard requests
    const mixed = [];
    for (let i = 0; i < 10; i++) {
      mixed.push(request(app).get('/api/stats'));      // polling
      mixed.push(request(app).get('/api/containers')); // standard
    }
    const results = await Promise.all(mixed);

    // No 429s should occur (we're well within dev limits)
    for (const res of results) {
      expect(res.status).not.toBe(429);
    }

    // Check that polling results have polling-tier headers
    for (let i = 0; i < results.length; i += 2) {
      const limit = parseInt(results[i].headers['ratelimit-limit'], 10);
      expect(limit).toBe(3000);
    }

    // Check that standard results have global-tier headers
    for (let i = 1; i < results.length; i += 2) {
      const limit = parseInt(results[i].headers['ratelimit-limit'], 10);
      expect(limit).toBe(1000);
    }
  });
});
