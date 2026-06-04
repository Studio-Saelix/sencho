/**
 * RBAC tests for POST /api/templates/deploy.
 *
 * The deploy gate must match the RBAC permission matrix in
 * `backend/src/middleware/permissions.ts`: any role that holds
 * `stack:create` (admin, node-admin) can deploy a template; viewer,
 * deployer, and auditor cannot. This locks in the fix where the route
 * previously gated on `requireAdmin` and silently rejected node-admins
 * who could create stacks through every other path.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

type SeedRole = 'admin' | 'node-admin' | 'deployer' | 'viewer' | 'auditor';

async function seedUser(username: string, role: SeedRole): Promise<string> {
  const db = DatabaseService.getInstance();
  const passwordHash = await bcrypt.hash('password123', 1);
  const id = db.addUser({ username, password_hash: passwordHash, role });
  const user = db.getUserById(id)!;
  return jwt.sign({ username, role, tv: user.token_version }, TEST_JWT_SECRET, { expiresIn: '1m' });
}

const minimalTemplate = {
  title: 'rbac-probe',
  description: 'placeholder',
  image: 'nginx:alpine',
};

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));

  const { LicenseService } = await import('../services/LicenseService');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');

  ({ app } = await import('../index'));
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

describe('POST /api/templates/deploy permission gate', () => {
  it.each(['viewer', 'deployer', 'auditor'] as const)(
    'rejects %s with 403 PERMISSION_DENIED',
    async (role) => {
      const token = await seedUser(`probe-${role}`, role);
      const res = await request(app)
        .post('/api/templates/deploy')
        .set('Authorization', `Bearer ${token}`)
        .send({ stackName: `probe-${role}-stack`, template: minimalTemplate });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
    },
  );

  it.each(['admin', 'node-admin'] as const)(
    'lets %s pass the permission gate',
    async (role) => {
      const token = await seedUser(`probe-${role}`, role);
      const res = await request(app)
        .post('/api/templates/deploy')
        .set('Authorization', `Bearer ${token}`)
        .send({ stackName: `probe-${role}-stack`, template: minimalTemplate });
      // The deploy itself may fail downstream (no Docker daemon in tests),
      // but the request must clear the permission gate. PERMISSION_DENIED
      // is the only code emitted by the gate, so its absence proves the
      // request reached the deploy logic.
      expect(res.body.code).not.toBe('PERMISSION_DENIED');
      expect(res.status).not.toBe(403);
    },
  );

  it('returns 401 without a token', async () => {
    const res = await request(app)
      .post('/api/templates/deploy')
      .send({ stackName: 'no-auth', template: minimalTemplate });
    expect(res.status).toBe(401);
  });
});
