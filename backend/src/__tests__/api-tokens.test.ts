/**
 * Tests for API token scope enforcement, blocked endpoints, expiration,
 * revocation, creation validation, limits, and ownership.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { generateApiToken } from '../utils/apiTokenFormat';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let authCookie: string;

/** Create an API token directly in the DB and return its raw value. */
function createTestApiToken(
  scope: 'read-only' | 'deploy-only' | 'full-admin',
  expiresAt: number | null = null,
  userId?: number,
): string {
  const rawToken = generateApiToken();
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const db = DatabaseService.getInstance();
  const resolvedUserId = userId ?? db.getUserByUsername('testadmin')!.id;
  db.addApiToken({
    token_hash: tokenHash,
    name: `test-${scope}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    scope,
    user_id: resolvedUserId,
    created_at: Date.now(),
    expires_at: expiresAt,
  });
  return rawToken;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));

  // Mock LicenseService to return paid/admiral for Admiral-gated routes
  const { LicenseService } = await import('../services/LicenseService');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('admiral');
  vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: null, maxViewers: null });

  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

// --- Scope Enforcement Middleware ---

describe('enforceApiTokenScope', () => {
  it('read-only token allows GET requests', async () => {
    const token = createTestApiToken('read-only');
    const res = await request(app)
      .get('/api/stacks')
      .set('Authorization', `Bearer ${token}`);
    // Should not be 403 SCOPE_DENIED (may be 200 or other non-scope error)
    expect(res.body.code).not.toBe('SCOPE_DENIED');
  });

  it('read-only token blocks POST requests', async () => {
    const token = createTestApiToken('read-only');
    const res = await request(app)
      .post('/api/stacks/test-stack/deploy')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SCOPE_DENIED');
  });

  it('deploy-only token allows GET requests', async () => {
    const token = createTestApiToken('deploy-only');
    const res = await request(app)
      .get('/api/stacks')
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.code).not.toBe('SCOPE_DENIED');
  });

  it('deploy-only token allows POST to deploy patterns', async () => {
    const token = createTestApiToken('deploy-only');
    const res = await request(app)
      .post('/api/stacks/test-stack/deploy')
      .set('Authorization', `Bearer ${token}`);
    // Should not be SCOPE_DENIED (may fail for other reasons like stack not found)
    expect(res.body.code).not.toBe('SCOPE_DENIED');
  });

  it('deploy-only token blocks POST to non-deploy endpoints', async () => {
    const token = createTestApiToken('deploy-only');
    const res = await request(app)
      .post('/api/stacks')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'test', content: 'version: "3"' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SCOPE_DENIED');
  });

  it('full-admin token passes scope enforcement on stack routes', async () => {
    const token = createTestApiToken('full-admin');
    const res = await request(app)
      .get('/api/stacks')
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.code).not.toBe('SCOPE_DENIED');
  });
});

// --- Blocked Endpoints (human-session-only) ---

describe('API token blocked endpoints', () => {
  let fullAdminToken: string;

  beforeAll(() => {
    fullAdminToken = createTestApiToken('full-admin');
  });

  const blockedEndpoints: Array<{ method: 'get' | 'post' | 'put' | 'delete'; path: string; body?: Record<string, unknown> }> = [
    // Password management
    { method: 'put', path: '/api/auth/password', body: { oldPassword: 'x', newPassword: 'y' } },
    // Node token generation
    { method: 'post', path: '/api/auth/generate-node-token' },
    // User management
    { method: 'get', path: '/api/users' },
    { method: 'post', path: '/api/users', body: { username: 'test', password: 'test123', role: 'viewer' } },
    { method: 'put', path: '/api/users/1', body: { role: 'viewer' } },
    { method: 'delete', path: '/api/users/1' },
    // SSO configuration
    { method: 'get', path: '/api/sso/config' },
    { method: 'get', path: '/api/sso/config/ldap' },
    { method: 'put', path: '/api/sso/config/ldap', body: { enabled: true } },
    { method: 'delete', path: '/api/sso/config/ldap' },
    { method: 'post', path: '/api/sso/config/ldap/test' },
    // Node management
    { method: 'post', path: '/api/nodes', body: { name: 'test', type: 'local' } },
    { method: 'put', path: '/api/nodes/1', body: { name: 'updated' } },
    { method: 'delete', path: '/api/nodes/1' },
    // License management
    { method: 'post', path: '/api/license/activate', body: { license_key: 'test' } },
    { method: 'post', path: '/api/license/deactivate' },
    // Console token
    { method: 'post', path: '/api/system/console-token' },
    // Token self-management
    { method: 'get', path: '/api/api-tokens' },
    { method: 'post', path: '/api/api-tokens', body: { name: 'test', scope: 'read-only' } },
    { method: 'delete', path: '/api/api-tokens/1' },
    // Registry management
    { method: 'get', path: '/api/registries' },
    { method: 'post', path: '/api/registries', body: { name: 'test', type: 'dockerhub', url: 'https://index.docker.io' } },
    { method: 'put', path: '/api/registries/1', body: { name: 'updated' } },
    { method: 'delete', path: '/api/registries/1' },
    { method: 'post', path: '/api/registries/1/test' },
  ];

  for (const { method, path, body } of blockedEndpoints) {
    it(`${method.toUpperCase()} ${path} returns 403 SCOPE_DENIED`, async () => {
      let req = request(app)[method](path).set('Authorization', `Bearer ${fullAdminToken}`);
      if (body) req = req.send(body);
      const res = await req;
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SCOPE_DENIED');
    });
  }
});

// --- Token Expiration ---

describe('API token expiration', () => {
  it('expired token returns 401', async () => {
    const token = createTestApiToken('full-admin', Date.now() - 1000); // expired 1s ago
    const res = await request(app)
      .get('/api/stacks')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('non-expired token is accepted', async () => {
    const token = createTestApiToken('full-admin', Date.now() + 86400000); // expires in 1 day
    const res = await request(app)
      .get('/api/stacks')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).not.toBe(401);
  });
});

// --- Token Revocation ---

describe('API token revocation', () => {
  it('revoked token returns 401', async () => {
    const rawToken = createTestApiToken('full-admin');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    // Revoke by finding the token ID
    const db = DatabaseService.getInstance();
    const apiToken = db.getApiTokenByHash(tokenHash)!;
    db.revokeApiToken(apiToken.id);

    const res = await request(app)
      .get('/api/stacks')
      .set('Authorization', `Bearer ${rawToken}`);
    expect(res.status).toBe(401);
  });
});

// --- Creation Validation ---

describe('API token creation validation', () => {
  it('rejects missing name', async () => {
    const res = await request(app)
      .post('/api/api-tokens')
      .set('Cookie', authCookie)
      .send({ scope: 'read-only' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it('rejects empty/whitespace name', async () => {
    const res = await request(app)
      .post('/api/api-tokens')
      .set('Cookie', authCookie)
      .send({ name: '   ', scope: 'read-only' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it('rejects name longer than 100 characters', async () => {
    const res = await request(app)
      .post('/api/api-tokens')
      .set('Cookie', authCookie)
      .send({ name: 'a'.repeat(101), scope: 'read-only' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/100/);
  });

  it('rejects invalid scope', async () => {
    const res = await request(app)
      .post('/api/api-tokens')
      .set('Cookie', authCookie)
      .send({ name: 'test-invalid-scope', scope: 'superadmin' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scope/i);
  });

  it('rejects invalid expiry value', async () => {
    const res = await request(app)
      .post('/api/api-tokens')
      .set('Cookie', authCookie)
      .send({ name: 'test-invalid-expiry', scope: 'read-only', expires_in: 7 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expires_in/i);
  });

  it('accepts null expiry (no expiration)', async () => {
    const res = await request(app)
      .post('/api/api-tokens')
      .set('Cookie', authCookie)
      .send({ name: `test-null-expiry-${Date.now()}`, scope: 'read-only', expires_in: null });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
  });

  it('accepts valid expiry values', async () => {
    for (const days of [30, 60, 90, 365]) {
      const res = await request(app)
        .post('/api/api-tokens')
        .set('Cookie', authCookie)
        .send({ name: `test-expiry-${days}-${Date.now()}`, scope: 'read-only', expires_in: days });
      expect(res.status).toBe(201);
    }
  });
});

// --- Token Count Limit ---

describe('API token count limit', () => {
  it('rejects creation when user has 25 active tokens', async () => {
    const db = DatabaseService.getInstance();
    const user = db.getUserByUsername('testadmin')!;

    // Seed up to 25 active tokens using the shared helper
    const existing = db.getActiveApiTokenCountByUser(user.id);
    const toCreate = 25 - existing;
    for (let i = 0; i < toCreate; i++) {
      createTestApiToken('read-only', null, user.id);
    }

    expect(db.getActiveApiTokenCountByUser(user.id)).toBeGreaterThanOrEqual(25);

    const res = await request(app)
      .post('/api/api-tokens')
      .set('Cookie', authCookie)
      .send({ name: `overflow-${Date.now()}`, scope: 'read-only' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maximum/i);
  });
});

// --- Token Name Uniqueness ---

describe('API token name uniqueness', () => {
  it('rejects duplicate token name for same user', async () => {
    // Revoke existing tokens to make room (limit test may have filled to 25)
    const db = DatabaseService.getInstance();
    const user = db.getUserByUsername('testadmin')!;
    const existing = db.getApiTokensByUser(user.id);
    for (const t of existing) {
      if (!t.revoked_at) db.revokeApiToken(t.id);
    }

    const uniqueName = `dup-test-${Date.now()}`;

    // Create the first token
    const res1 = await request(app)
      .post('/api/api-tokens')
      .set('Cookie', authCookie)
      .send({ name: uniqueName, scope: 'read-only' });
    expect(res1.status).toBe(201);

    // Attempt to create another with the same name
    const res2 = await request(app)
      .post('/api/api-tokens')
      .set('Cookie', authCookie)
      .send({ name: uniqueName, scope: 'read-only' });
    expect(res2.status).toBe(409);
    expect(res2.body.error).toMatch(/already exists/i);
  });
});

// --- last_used_at Tracking ---

describe('API token last_used_at tracking', () => {
  it('updates last_used_at on API token usage', async () => {
    const rawToken = createTestApiToken('read-only');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const db = DatabaseService.getInstance();

    // Verify last_used_at is null initially
    const before = db.getApiTokenByHash(tokenHash)!;
    expect(before.last_used_at).toBeNull();

    // Make a request with the token
    await request(app)
      .get('/api/stacks')
      .set('Authorization', `Bearer ${rawToken}`);

    // Verify last_used_at is now set
    const after = db.getApiTokenByHash(tokenHash)!;
    expect(after.last_used_at).toBeTypeOf('number');
    expect(after.last_used_at!).toBeGreaterThan(0);
  });
});

// --- Ownership Constraint ---

describe('API token ownership', () => {
  it('returns 403 when deleting another user\'s token', async () => {
    const db = DatabaseService.getInstance();

    // Create a second user
    const otherHash = await bcrypt.hash('otherpass123', 1);
    db.addUser({ username: 'otheruser', password_hash: otherHash, role: 'admin' });
    const otherUser = db.getUserByUsername('otheruser')!;

    // Create a token for the other user using the shared helper
    const rawToken = createTestApiToken('read-only', null, otherUser.id);
    const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const apiToken = db.getApiTokenByHash(hash)!;
    const tokenId = apiToken.id;

    // Try to delete it as testadmin
    const res = await request(app)
      .delete(`/api/api-tokens/${tokenId}`)
      .set('Cookie', authCookie);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/your own/i);
  });
});

// --- Delete Edge Cases ---

describe('API token delete edge cases', () => {
  it('returns 404 for nonexistent token ID', async () => {
    const res = await request(app)
      .delete('/api/api-tokens/99999')
      .set('Cookie', authCookie);
    expect(res.status).toBe(404);
  });

  it('returns 400 for non-numeric token ID', async () => {
    const res = await request(app)
      .delete('/api/api-tokens/abc')
      .set('Cookie', authCookie);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });
});
