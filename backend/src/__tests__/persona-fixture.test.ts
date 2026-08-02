/**
 * Persona fixture smoke tests: every persona must authenticate and carry
 * the correct permission set before any downstream test relies on it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  setupTestDb,
  cleanupTestDb,
} from './helpers/setupTestDb';
import { seedPersonas, FIVE_ROLES, type PersonaMap } from './fixtures/personas';
import { ROLE_PERMISSIONS, checkPermission } from '../middleware/permissions';
import { DatabaseService } from '../services/DatabaseService';

describe('persona fixture integrity', () => {
  let tmpDir: string;
  let app: import('express').Express;
  let personas: PersonaMap;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ app } = await import('../index'));
    personas = seedPersonas(DatabaseService.getInstance());
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  for (const role of FIVE_ROLES) {
    describe(`${role} persona`, () => {
      it('authenticates on the auth-status endpoint', async () => {
        const res = await request(app)
          .get('/api/auth/status')
          .set('Authorization', personas[role].bearer);
        expect(res.status).toBe(200);
        // Smoke: a 200 on /api/auth/status proves the JWT was accepted.
      });

      it('has the expected global permissions from ROLE_PERMISSIONS', () => {
        const actions = ROLE_PERMISSIONS[role];
        expect(actions).toBeDefined();
        expect(actions).toContain('stack:read');
      });

      it('checkPermission matches global role grants for each owned action', () => {
        const p = personas[role];
        const actions = ROLE_PERMISSIONS[role];
        for (const action of actions) {
          const req = { user: { username: p.username, role: p.role, userId: 1 } } as any;
          expect(checkPermission(req, action)).toBe(true);
        }
      });
    });
  }
});
