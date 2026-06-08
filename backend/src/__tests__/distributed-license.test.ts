/**
 * Tests for Distributed License Enforcement: the trust chain where the main
 * instance asserts its license tier to remote nodes via proxy headers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

/** Helper: sign a token with the test JWT secret. */
const signToken = (payload: Record<string, unknown>, expiresIn: string | number = '1m') =>
  jwt.sign(payload, TEST_JWT_SECRET, { expiresIn: expiresIn as jwt.SignOptions['expiresIn'] });

// We need a Paid-gated route that doesn't depend on Docker or remote nodes.
// The bare /api/audit-log list is Community (recent-activity window), but
// /api/audit-log/stats keeps requirePaid and reads from the DB, so it is a
// stable stand-in for exercising the distributed-license trust chain. The
// node_proxy and admin session tokens used below both satisfy its
// system:audit permission gate.
const PAID_ROUTE = '/api/audit-log/stats';

// ─── authMiddleware: proxyTier propagation ──────────────────────────────────

describe('authMiddleware - distributed license headers', () => {
  it('sets proxyTier for node_proxy tokens with a valid tier header', async () => {
    const token = signToken({ scope: 'node_proxy' });
    // Hit a Paid-gated route with tier assertion - should be allowed
    const res = await request(app)
      .get(PAID_ROUTE)
      .set('Authorization', `Bearer ${token}`)
      .set('x-sencho-tier', 'paid');

    // Should NOT get 403 PAID_REQUIRED; the proxy tier assertion grants access
    expect(res.status).not.toBe(403);
  });

  it('ignores tier headers for user session tokens', async () => {
    const token = signToken({ username: TEST_USERNAME, role: 'admin' });
    // Even with a tier header set, a user session should use the local license (community)
    const res = await request(app)
      .get(PAID_ROUTE)
      .set('Authorization', `Bearer ${token}`)
      .set('x-sencho-tier', 'paid');

    // Local license is community in test env → should get 403
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PAID_REQUIRED');
  });

  it('ignores tier headers for malformed values on node_proxy tokens', async () => {
    const token = signToken({ scope: 'node_proxy' });
    const res = await request(app)
      .get(PAID_ROUTE)
      .set('Authorization', `Bearer ${token}`)
      .set('x-sencho-tier', 'enterprise');  // invalid value

    // Invalid tier header → proxyTier not set → falls back to local (community) → 403
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PAID_REQUIRED');
  });

  it('falls back to local tier when no tier headers on node_proxy token', async () => {
    const token = signToken({ scope: 'node_proxy' });
    const res = await request(app)
      .get(PAID_ROUTE)
      .set('Authorization', `Bearer ${token}`);
    // No tier headers → falls back to local (community) → 403

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PAID_REQUIRED');
  });
});

// ─── requirePaid guard ───────────────────────────────────────────────────────

describe('requirePaid - distributed license', () => {
  it('allows access when proxy asserts paid tier', async () => {
    const token = signToken({ scope: 'node_proxy' });
    const res = await request(app)
      .get(PAID_ROUTE)
      .set('Authorization', `Bearer ${token}`)
      .set('x-sencho-tier', 'paid');

    expect(res.status).not.toBe(403);
  });

  it('blocks access when proxy asserts community tier', async () => {
    const token = signToken({ scope: 'node_proxy' });
    const res = await request(app)
      .get(PAID_ROUTE)
      .set('Authorization', `Bearer ${token}`)
      .set('x-sencho-tier', 'community');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PAID_REQUIRED');
  });

  it('blocks access for direct user when local tier is community', async () => {
    const token = signToken({ username: TEST_USERNAME, role: 'admin' });
    const res = await request(app)
      .get(PAID_ROUTE)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PAID_REQUIRED');
  });
});

// ─── Security: header injection prevention ──────────────────────────────────

describe('Security - tier header injection', () => {
  it('cannot elevate access via tier headers on a user session', async () => {
    const token = signToken({ username: TEST_USERNAME, role: 'admin' });
    const res = await request(app)
      .get(PAID_ROUTE)
      .set('Authorization', `Bearer ${token}`)
      .set('x-sencho-tier', 'paid');

    // User session → tier headers ignored → local community tier → 403
    expect(res.status).toBe(403);
  });

  it('cannot elevate access via tier headers without any auth', async () => {
    const res = await request(app)
      .get(PAID_ROUTE)
      .set('x-sencho-tier', 'paid');

    expect(res.status).toBe(401);
  });

  it('cannot elevate access with expired node_proxy token', async () => {
    const token = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '-1s' });
    const res = await request(app)
      .get(PAID_ROUTE)
      .set('Authorization', `Bearer ${token}`)
      .set('x-sencho-tier', 'paid');

    expect(res.status).toBe(401);
  });

  it('cannot elevate access with token signed by wrong secret', async () => {
    const token = jwt.sign({ scope: 'node_proxy' }, 'wrong-secret', { expiresIn: '1m' });
    const res = await request(app)
      .get(PAID_ROUTE)
      .set('Authorization', `Bearer ${token}`)
      .set('x-sencho-tier', 'paid');

    expect(res.status).toBe(401);
  });
});
