/**
 * RBAC regression coverage: MFA reset gating, SSO user permission parity,
 * and scoped-evidence fail-closed on remote.
 *
 * Tests for last-admin protection, immediate role-change effect, and
 * API-token scope isolation are already covered by users-rbac.test.ts,
 * api-tokens.test.ts, and api-token-ws-scope.test.ts respectively.
 *
 * Single describe + single setupTestDb()/cleanupTestDb() pair because the
 * DatabaseService singleton is lazy-constructed on first getInstance() and
 * never re-initializes; a second setupTestDb() after a first cleanupTestDb()
 * would reuse a stale handle pointing at a deleted file, tripping
 * SQLITE_READONLY_DBMOVED on Linux.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import {
  setupTestDb,
  cleanupTestDb,
  TEST_JWT_SECRET,
} from './helpers/setupTestDb';
import { checkPermission } from '../middleware/permissions';
import { DatabaseService } from '../services/DatabaseService';

describe('RBAC regression coverage', () => {
  let tmpDir: string;
  let app: import('express').Express;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ app } = await import('../index'));
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  // ── MFA reset gating ────────────────────────────────────────────
  // POST /:id/mfa/reset requires system:users (admin only).
  const TARGET_ID = 1; // Baseline admin is id 1, seeded by globalSetup.

  it('rejects unauthenticated MFA reset (401)', async () => {
    const res = await request(app).post(`/api/users/${TARGET_ID}/mfa/reset`);
    expect(res.status).toBe(401);
  });

  it('rejects non-admin from resetting MFA (403)', async () => {
    const db = DatabaseService.getInstance();
    const bcrypt = await import('bcrypt');
    const hash = await bcrypt.default.hash('password123', 1);
    db.addUser({ username: 'mfa-viewer', password_hash: hash, role: 'viewer' });
    const user = db.getUserByUsername('mfa-viewer')!;
    const token = jwt.sign(
      { username: 'mfa-viewer', role: 'viewer', tv: user.token_version },
      TEST_JWT_SECRET,
      { expiresIn: '1m' },
    );
    const res = await request(app)
      .post(`/api/users/${TARGET_ID}/mfa/reset`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  // ── SSO user permission parity ──────────────────────────────────

  it('grants same permissions as a local user of the same role', () => {
    const db = DatabaseService.getInstance();
    db.addUser({
      username: 'sso-node-admin',
      password_hash: '$sso$fake',
      role: 'node-admin',
      auth_provider: 'oidc_google',
      provider_id: 'google-456',
      email: 'sso-na@test.com',
    });
    const ssoUser = db.getUserByUsername('sso-node-admin')!;

    // permissions.ts never branches on auth_provider; only role matters.
    const req = {
      user: { username: ssoUser.username, role: ssoUser.role, userId: ssoUser.id },
    } as any;

    expect(checkPermission(req, 'stack:read')).toBe(true);
    expect(checkPermission(req, 'stack:edit')).toBe(true);
    expect(checkPermission(req, 'stack:deploy')).toBe(true);
    expect(checkPermission(req, 'node:manage')).toBe(true);
    expect(checkPermission(req, 'system:settings')).toBe(false);
    expect(checkPermission(req, 'system:users')).toBe(false);
  });

  // ── Scoped evidence fail-closed ─────────────────────────────────

  it('denies a scoped-only user when scopedStackEvidence is absent', () => {
    const remoteReq = {
      user: { username: 'node-proxy', role: 'viewer', userId: 0 },
      scopedStackEvidence: undefined,
    } as any;
    expect(checkPermission(remoteReq, 'stack:edit', 'stack', 'web')).toBe(false);
  });

  it('allows the same action when evidence is present and matches', () => {
    const remoteReq = {
      user: { username: 'node-proxy', role: 'viewer', userId: 0 },
      scopedStackEvidence: {
        stackName: 'web',
        actions: new Set(['stack:edit', 'stack:deploy']),
      },
    } as any;
    expect(checkPermission(remoteReq, 'stack:edit', 'stack', 'web')).toBe(true);
  });
});
