/**
 * Tests for User Management, RBAC permissions, token versioning (session invalidation),
 * scoped role assignments, password management, seat limits, and last-admin protection.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_PASSWORD, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { generateApiToken } from '../utils/apiTokenFormat';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

/** Sign a JWT for a given user with optional token_version (tv). */
function authToken(username: string, role: string = 'admin', tv?: number): string {
  const payload: Record<string, unknown> = { username, role };
  if (tv !== undefined) payload.tv = tv;
  return jwt.sign(payload, TEST_JWT_SECRET, { expiresIn: '1m' });
}

/** Sign admin token using the current DB token_version (reads live state). */
function adminToken(): string {
  const db = DatabaseService.getInstance();
  const user = db.getUserByUsername(TEST_USERNAME)!;
  return authToken(TEST_USERNAME, 'admin', user.token_version);
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));

  // Mock LicenseService to return paid/admiral for RBAC tests
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

// ---- User CRUD Endpoints ----

describe('POST /api/users', () => {
  it('creates a user with valid data (201)', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ username: 'newuser', password: 'password123', role: 'viewer' });
    expect(res.status).toBe(201);
    expect(res.body.username).toBe('newuser');
    expect(res.body.role).toBe('viewer');
    expect(res.body.id).toBeDefined();
  });

  it('rejects missing fields (400)', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ username: 'incomplete' });
    expect(res.status).toBe(400);
  });

  it('rejects invalid username format (400)', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ username: 'a b', password: 'password123', role: 'viewer' });
    expect(res.status).toBe(400);
  });

  it('rejects short password (400)', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ username: 'shortpw', password: '123', role: 'viewer' });
    expect(res.status).toBe(400);
  });

  it('rejects invalid role (400)', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ username: 'badrole', password: 'password123', role: 'superadmin' });
    expect(res.status).toBe(400);
  });

  it('rejects duplicate username (409)', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ username: 'newuser', password: 'password123', role: 'viewer' });
    expect(res.status).toBe(409);
  });

  it('requires admin role (403 for viewers)', async () => {
    const db = DatabaseService.getInstance();
    const viewer = db.getUserByUsername('newuser')!;
    const viewerToken = authToken('newuser', 'viewer', viewer.token_version);
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ username: 'test999', password: 'password123', role: 'viewer' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');
  });

  it('blocks API tokens (403 SCOPE_DENIED)', async () => {
    const rawToken = generateApiToken();
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const db = DatabaseService.getInstance();
    const user = db.getUserByUsername(TEST_USERNAME);
    db.addApiToken({ token_hash: tokenHash, name: `test-crud-${Date.now()}`, scope: 'full-admin', user_id: user!.id, created_at: Date.now(), expires_at: null });

    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${rawToken}`)
      .send({ username: 'fromtoken', password: 'password123', role: 'viewer' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SCOPE_DENIED');
  });
});

describe('PUT /api/users/:id', () => {
  let viewerId: number;

  beforeAll(() => {
    const db = DatabaseService.getInstance();
    const user = db.getUserByUsername('newuser');
    viewerId = user!.id;
  });

  it('updates username', async () => {
    const res = await request(app)
      .put(`/api/users/${viewerId}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ username: 'renameduser' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Rename back for other tests
    await request(app)
      .put(`/api/users/${viewerId}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ username: 'newuser' });
  });

  it('updates role', async () => {
    const res = await request(app)
      .put(`/api/users/${viewerId}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ role: 'deployer' });
    expect(res.status).toBe(200);
    // Revert
    await request(app)
      .put(`/api/users/${viewerId}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ role: 'viewer' });
  });

  it('prevents self-role-change (400)', async () => {
    const db = DatabaseService.getInstance();
    const adminUser = db.getUserByUsername(TEST_USERNAME)!;
    const res = await request(app)
      .put(`/api/users/${adminUser.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ role: 'viewer' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Cannot change your own role');
  });

  it('prevents demoting last admin (400)', async () => {
    // testadmin is the only admin
    const db = DatabaseService.getInstance();
    const adminUser = db.getUserByUsername(TEST_USERNAME)!;
    const res = await request(app)
      .put(`/api/users/${adminUser.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ role: 'viewer' });
    expect(res.status).toBe(400);
  });

  it('rejects password on SSO user (400)', async () => {
    // Create an SSO user directly in DB
    const db = DatabaseService.getInstance();
    const ssoId = db.addUser({ username: 'sso-user', password_hash: '$sso$fake', role: 'viewer', auth_provider: 'oidc_google', provider_id: 'google-123', email: 'sso@test.com' });

    const res = await request(app)
      .put(`/api/users/${ssoId}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ password: 'newpassword123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('SSO-provisioned');

    // Cleanup
    db.deleteUser(ssoId);
  });
});

describe('DELETE /api/users/:id', () => {
  it('deletes a user (200)', async () => {
    // Create a disposable user
    const db = DatabaseService.getInstance();
    const hash = await bcrypt.hash('password123', 1);
    const id = db.addUser({ username: 'disposable', password_hash: hash, role: 'viewer' });

    const res = await request(app)
      .delete(`/api/users/${id}`)
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('prevents self-deletion (400)', async () => {
    const db = DatabaseService.getInstance();
    const admin = db.getUserByUsername(TEST_USERNAME)!;
    const res = await request(app)
      .delete(`/api/users/${admin.id}`)
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Cannot delete your own account');
  });

  it('prevents deleting last admin (400)', async () => {
    // Only one admin (testadmin), can't delete
    const db = DatabaseService.getInstance();
    const admin = db.getUserByUsername(TEST_USERNAME)!;
    const res = await request(app)
      .delete(`/api/users/${admin.id}`)
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(400);
  });
});

// ---- Token Version (Session Invalidation) ----

describe('Token version (session invalidation)', () => {
  it('rejects a deleted user\'s JWT (401)', async () => {
    const db = DatabaseService.getInstance();
    const hash = await bcrypt.hash('password123', 1);
    const id = db.addUser({ username: 'willdelete', password_hash: hash, role: 'viewer' });
    const user = db.getUserById(id)!;
    const token = authToken('willdelete', 'viewer', user.token_version);

    // Token works before deletion
    const before = await request(app).get('/api/stacks').set('Authorization', `Bearer ${token}`);
    expect(before.status).not.toBe(401);

    // Delete the user
    db.deleteUser(id);

    // Token should be rejected after deletion
    const after = await request(app).get('/api/stacks').set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);
    expect(after.body.error).toContain('no longer exists');
  });

  it('rejects token after password change bumps tv', async () => {
    const db = DatabaseService.getInstance();
    const hash = await bcrypt.hash('oldpass123', 1);
    const id = db.addUser({ username: 'pwchange', password_hash: hash, role: 'viewer' });
    const user = db.getUserById(id)!;
    const oldToken = authToken('pwchange', 'viewer', user.token_version);

    // Token works before bump
    const before = await request(app).get('/api/stacks').set('Authorization', `Bearer ${oldToken}`);
    expect(before.status).not.toBe(401);

    // Bump token version (simulates password change)
    db.bumpTokenVersion(id);

    // Old token should be rejected
    const after = await request(app).get('/api/stacks').set('Authorization', `Bearer ${oldToken}`);
    expect(after.status).toBe(401);
    expect(after.body.error).toContain('Session invalidated');

    // Cleanup
    db.deleteUser(id);
  });

  it('admin password reset bumps token_version', async () => {
    const db = DatabaseService.getInstance();
    const hash = await bcrypt.hash('password123', 1);
    const id = db.addUser({ username: 'resetme', password_hash: hash, role: 'viewer' });
    const userBefore = db.getUserById(id)!;

    // Admin resets password via PUT /api/users/:id
    await request(app)
      .put(`/api/users/${id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ password: 'newpassword123' });

    const userAfter = db.getUserById(id)!;
    expect(userAfter.token_version).toBe(userBefore.token_version + 1);

    // Cleanup
    db.deleteUser(id);
  });

  it('pre-migration token (no tv claim) still works', async () => {
    // Sign without tv claim (simulates pre-migration token)
    const token = jwt.sign({ username: TEST_USERNAME, role: 'admin' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const res = await request(app).get('/api/stacks').set('Authorization', `Bearer ${token}`);
    // Should not be 401 (backward compat)
    expect(res.status).not.toBe(401);
  });

  it('uses DB role so role changes take effect immediately', async () => {
    const db = DatabaseService.getInstance();
    const hash = await bcrypt.hash('password123', 1);
    const id = db.addUser({ username: 'rolecheck', password_hash: hash, role: 'admin' });
    const user = db.getUserById(id)!;

    // Admin changes their role to viewer in DB directly (simulating a race)
    db.updateUser(id, { role: 'viewer' });
    // Don't bump tv, so the old token still passes version check
    // But the middleware should use DB role (viewer), not JWT role (admin)

    // The token was signed with role: admin, but DB says viewer.
    // Auth check endpoint should reflect the DB role.
    const token = authToken('rolecheck', 'admin', user.token_version);
    const res = await request(app).get('/api/auth/check').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('viewer');

    // Cleanup
    db.deleteUser(id);
  });
});

// ---- Scoped Role Assignments ----

describe('Scoped Role Assignments', () => {
  let targetUserId: number;

  beforeAll(async () => {
    const db = DatabaseService.getInstance();
    const hash = await bcrypt.hash('password123', 1);
    targetUserId = db.addUser({ username: 'scopeuser', password_hash: hash, role: 'viewer' });
  });

  afterAll(() => {
    const db = DatabaseService.getInstance();
    db.deleteUser(targetUserId);
  });

  it('GET /api/users/:id/roles returns assignments', async () => {
    const res = await request(app)
      .get(`/api/users/${targetUserId}/roles`)
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/users/:id/roles creates assignment (201)', async () => {
    const res = await request(app)
      .post(`/api/users/${targetUserId}/roles`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ role: 'deployer', resource_type: 'stack', resource_id: 'test-stack' });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('deployer');
    expect(res.body.resource_type).toBe('stack');
  });

  it('POST /api/users/:id/roles rejects duplicate (409)', async () => {
    const res = await request(app)
      .post(`/api/users/${targetUserId}/roles`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ role: 'deployer', resource_type: 'stack', resource_id: 'test-stack' });
    expect(res.status).toBe(409);
  });

  it('DELETE /api/users/:id/roles/:assignId removes assignment', async () => {
    const db = DatabaseService.getInstance();
    const assignments = db.getAllRoleAssignments(targetUserId);
    const assignment = assignments[0];

    const res = await request(app)
      .delete(`/api/users/${targetUserId}/roles/${assignment.id}`)
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ---- GET /api/permissions/me ----

describe('GET /api/permissions/me', () => {
  it('returns correct structure for admin', async () => {
    const res = await request(app)
      .get('/api/permissions/me')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.globalRole).toBe('admin');
    expect(Array.isArray(res.body.globalPermissions)).toBe(true);
    expect(res.body.globalPermissions).toContain('stack:read');
    expect(res.body.globalPermissions).toContain('system:users');
    // beforeAll mocks a paid admiral license.
    expect(res.body.isAdmiral).toBe(true);
  });

  it('reports isAdmiral=false when the admiral variant is no longer on a paid tier', async () => {
    // An expired or downgraded admiral license keeps variant='admiral' but the
    // effective tier drops to community. isAdmiral must track the effective tier
    // (mirroring the requireAdmiral guard), not the lingering variant, or the
    // frontend would unlock admiral-only surfaces that the API then 403s.
    const { LicenseService } = await import('../services/LicenseService');
    const svc = LicenseService.getInstance();
    vi.spyOn(svc, 'getTier').mockReturnValue('community');
    try {
      const res = await request(app)
        .get('/api/permissions/me')
        .set('Authorization', `Bearer ${adminToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.isAdmiral).toBe(false);
    } finally {
      vi.spyOn(svc, 'getTier').mockReturnValue('paid');
    }
  });

  it('reports isAdmiral=false for a paid non-admiral (skipper) license', async () => {
    const { LicenseService } = await import('../services/LicenseService');
    const svc = LicenseService.getInstance();
    vi.spyOn(svc, 'getVariant').mockReturnValue('skipper');
    try {
      const res = await request(app)
        .get('/api/permissions/me')
        .set('Authorization', `Bearer ${adminToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.isAdmiral).toBe(false);
    } finally {
      vi.spyOn(svc, 'getVariant').mockReturnValue('admiral');
    }
  });

  it('returns 401 when not authenticated', async () => {
    const res = await request(app).get('/api/permissions/me');
    expect(res.status).toBe(401);
  });

  it('includes scoped permissions when assignments exist', async () => {
    const db = DatabaseService.getInstance();
    const hash = await bcrypt.hash('password123', 1);
    const id = db.addUser({ username: 'permcheck', password_hash: hash, role: 'viewer' });
    db.addRoleAssignment({ user_id: id, role: 'deployer', resource_type: 'stack', resource_id: 'my-stack' });

    const user = db.getUserById(id)!;
    const token = authToken('permcheck', 'viewer', user.token_version);
    const res = await request(app)
      .get('/api/permissions/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.globalRole).toBe('viewer');
    expect(res.body.scopedPermissions['stack:my-stack']).toBeDefined();

    // Cleanup
    db.deleteRoleAssignmentsByUser(id);
    db.deleteUser(id);
  });
});

// ---- PUT /api/auth/password ----

describe('PUT /api/auth/password', () => {
  it('changes password with valid old password', async () => {
    const res = await request(app)
      .put('/api/auth/password')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ oldPassword: TEST_PASSWORD, newPassword: 'newpassword123' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Revert password for other tests (must use fresh token since tv was bumped)
    const revert = await request(app)
      .put('/api/auth/password')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ oldPassword: 'newpassword123', newPassword: TEST_PASSWORD });
    expect(revert.status).toBe(200);
  });

  it('rejects wrong old password (401)', async () => {
    const res = await request(app)
      .put('/api/auth/password')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ oldPassword: 'wrongpassword', newPassword: 'newpassword123' });
    expect(res.status).toBe(401);
  });

  it('rejects short new password (400)', async () => {
    const res = await request(app)
      .put('/api/auth/password')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ oldPassword: TEST_PASSWORD, newPassword: '123' });
    expect(res.status).toBe(400);
  });

  it('rejects missing fields (400)', async () => {
    const res = await request(app)
      .put('/api/auth/password')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('blocks API tokens (403)', async () => {
    const rawToken = generateApiToken();
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const db = DatabaseService.getInstance();
    const user = db.getUserByUsername(TEST_USERNAME);
    db.addApiToken({ token_hash: tokenHash, name: `test-pwchange-${Date.now()}`, scope: 'full-admin', user_id: user!.id, created_at: Date.now(), expires_at: null });

    const res = await request(app)
      .put('/api/auth/password')
      .set('Authorization', `Bearer ${rawToken}`)
      .send({ oldPassword: TEST_PASSWORD, newPassword: 'newpassword123' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SCOPE_DENIED');
  });
});

// ---- Seat Limit Enforcement ----

describe('Seat limit enforcement', () => {
  it('rejects new admin when seat limit reached', async () => {
    const { LicenseService } = await import('../services/LicenseService');
    vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: 1, maxViewers: null });

    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ username: 'extraadmin', password: 'password123', role: 'admin' });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('maximum');

    // Restore mock
    vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: null, maxViewers: null });
  });

  it('rejects new viewer when viewer seat limit reached', async () => {
    const { LicenseService } = await import('../services/LicenseService');
    vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: null, maxViewers: 0 });

    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ username: 'extraviewer', password: 'password123', role: 'viewer' });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('maximum');

    // Restore mock
    vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: null, maxViewers: null });
  });
});

// ---- Last-Admin Protection ----

describe('Last-admin protection', () => {
  it('cannot demote the only admin', async () => {
    const db = DatabaseService.getInstance();
    const admin = db.getUserByUsername(TEST_USERNAME)!;
    const res = await request(app)
      .put(`/api/users/${admin.id}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ role: 'viewer' });
    // Should fail with 400 (self-role-change) or last-admin check
    expect(res.status).toBe(400);
  });

  it('cannot delete the only admin', async () => {
    const db = DatabaseService.getInstance();
    const admin = db.getUserByUsername(TEST_USERNAME)!;
    const res = await request(app)
      .delete(`/api/users/${admin.id}`)
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(400);
  });

  it('can demote admin when another admin exists', async () => {
    const db = DatabaseService.getInstance();
    const hash = await bcrypt.hash('password123', 1);
    const secondAdminId = db.addUser({ username: 'secondadmin', password_hash: hash, role: 'admin' });

    // Now demote second admin (testadmin does the demotion)
    const res = await request(app)
      .put(`/api/users/${secondAdminId}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ role: 'viewer' });
    expect(res.status).toBe(200);

    // Cleanup
    db.deleteUser(secondAdminId);
  });
});

// ---- Seat Limit Enforcement On Promotion ----

describe('Seat limit enforcement on role promotion', () => {
  it('rejects promoting a viewer to admin when the admin seat limit is reached', async () => {
    const db = DatabaseService.getInstance();
    const hash = await bcrypt.hash('password123', 1);
    const viewerId = db.addUser({ username: 'promoteme', password_hash: hash, role: 'viewer' });

    const { LicenseService } = await import('../services/LicenseService');
    vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: 1, maxViewers: null });

    const res = await request(app)
      .put(`/api/users/${viewerId}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ role: 'admin' });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('maximum');
    // The role must remain unchanged when the cap blocks the promotion.
    expect(db.getUser(viewerId)!.role).toBe('viewer');

    vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: null, maxViewers: null });
    db.deleteUser(viewerId);
  });

  it('allows promoting a viewer to admin when admin seats are unlimited', async () => {
    const db = DatabaseService.getInstance();
    const hash = await bcrypt.hash('password123', 1);
    const viewerId = db.addUser({ username: 'promoteok', password_hash: hash, role: 'viewer' });
    // Global beforeAll mock already returns unlimited seats; the gate must not over-block.
    const res = await request(app)
      .put(`/api/users/${viewerId}`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ role: 'admin' });
    expect(res.status).toBe(200);
    expect(db.getUser(viewerId)!.role).toBe('admin');
    db.deleteUser(viewerId);
  });
});

// ---- Atomic Last-Admin Guard (TOCTOU protection) ----

describe('Atomic last-admin guard', () => {
  // These lock the guard contract: the admin-count re-check and the mutation run
  // in one transaction, so a refusal writes nothing (no partial state) and the
  // count is unchanged. That re-check inside the transaction is what closes the
  // TOCTOU window a route-level pre-check left open.
  it('updateUserIfNotLastAdmin refuses to demote the sole admin and applies otherwise', async () => {
    const db = DatabaseService.getInstance();
    expect(db.getAdminCount()).toBe(1);
    const sole = db.getUserByUsername(TEST_USERNAME)!;
    expect(db.updateUserIfNotLastAdmin(sole.id, { role: 'viewer' })).toBe(false);
    // Refusal is side-effect free: role intact and count unchanged.
    expect(db.getUser(sole.id)!.role).toBe('admin');
    expect(db.getAdminCount()).toBe(1);

    const hash = await bcrypt.hash('password123', 1);
    const extra = db.addUser({ username: 'raceadmin', password_hash: hash, role: 'admin' });
    expect(db.updateUserIfNotLastAdmin(extra, { role: 'viewer' })).toBe(true);
    expect(db.getUser(extra)!.role).toBe('viewer');
    expect(db.getAdminCount()).toBe(1);
    db.deleteUser(extra);
  });

  it('deleteUserIfNotLastAdmin refuses to delete the sole admin and applies otherwise', async () => {
    const db = DatabaseService.getInstance();
    expect(db.getAdminCount()).toBe(1);
    const sole = db.getUserByUsername(TEST_USERNAME)!;
    expect(db.deleteUserIfNotLastAdmin(sole.id)).toBe(false);
    // Refusal is side-effect free: row intact and count unchanged.
    expect(db.getUser(sole.id)).toBeTruthy();
    expect(db.getAdminCount()).toBe(1);

    const hash = await bcrypt.hash('password123', 1);
    const extra = db.addUser({ username: 'raceadmin2', password_hash: hash, role: 'admin' });
    expect(db.deleteUserIfNotLastAdmin(extra)).toBe(true);
    expect(db.getAdminCount()).toBe(1);
  });
});

// ---- Orphaned Role Assignment Cleanup ----

describe('Orphaned role assignment cleanup', () => {
  it('deleting a node removes its role assignments', async () => {
    const db = DatabaseService.getInstance();
    // Create a test node
    const nodeId = db.addNode({ name: 'test-cleanup-node', type: 'remote', api_url: 'http://test:1852', api_token: '', compose_dir: '/tmp', is_default: false });
    // Create a role assignment for this node
    const hash = await bcrypt.hash('password123', 1);
    const userId = db.addUser({ username: 'nodeorphan', password_hash: hash, role: 'viewer' });
    db.addRoleAssignment({ user_id: userId, role: 'deployer', resource_type: 'node', resource_id: String(nodeId) });

    // Verify assignment exists
    const before = db.getAllRoleAssignments(userId);
    expect(before.length).toBe(1);

    // Delete the node
    db.deleteNode(nodeId);

    // Assignments should be gone
    const after = db.getAllRoleAssignments(userId);
    expect(after.length).toBe(0);

    // Cleanup
    db.deleteUser(userId);
  });
});

// ---- Role-Based Permission Checks (via API) ----

describe('ROLE_PERMISSIONS enforcement via API', () => {
  it('viewer is blocked from deploying (403)', async () => {
    const db = DatabaseService.getInstance();
    const viewerUser = db.getUserByUsername('newuser');
    if (!viewerUser) return; // Created in earlier test

    const token = authToken('newuser', 'viewer', viewerUser.token_version);
    const res = await request(app)
      .post('/api/stacks/test-stack/deploy')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('viewer can read stacks', async () => {
    const db = DatabaseService.getInstance();
    const viewerUser = db.getUserByUsername('newuser');
    if (!viewerUser) return;

    const token = authToken('newuser', 'viewer', viewerUser.token_version);
    const res = await request(app)
      .get('/api/stacks')
      .set('Authorization', `Bearer ${token}`);
    // Should not be 403 (may be 200 or 500 depending on Docker state)
    expect(res.status).not.toBe(403);
  });

  it('viewer is blocked from system settings (403)', async () => {
    const db = DatabaseService.getInstance();
    const viewerUser = db.getUserByUsername('newuser');
    if (!viewerUser) return;

    const token = authToken('newuser', 'viewer', viewerUser.token_version);
    const res = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');
  });
});
