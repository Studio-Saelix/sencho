/**
 * Reusable five-role persona fixtures for RBAC test suites.
 *
 * Usage (one-time setup per test file):
 *   const personas = seedPersonas(DatabaseService.getInstance());
 *   const viewerReq = request(app).get('/api/stacks').set('Authorization', personas.viewer.bearer);
 *
 * Each persona carries its own smoke test so a token_version mismatch
 * (seeding vs signing) surfaces as a 401 before any permission assertion.
 */
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { TEST_JWT_SECRET } from '../helpers/setupTestDb';
import type { UserRole } from '../../services/DatabaseService';

export const FIVE_ROLES: readonly UserRole[] = ['admin', 'viewer', 'deployer', 'node-admin', 'auditor'] as const;

export interface Persona {
  username: string;
  role: UserRole;
  tokenVersion: number;
  bearer: string;
}

export type PersonaMap = Record<UserRole, Persona>;

/** Minimal DB interface needed by seedPersonas — avoids InstanceType<T> issues with private constructors. */
interface PersonaDb {
  addUser(u: { username: string; password_hash: string; role: string }): number;
  getUserByUsername(username: string): { username: string; role: UserRole; token_version: number } | undefined;
}

/** Seed one user per built-in global role and return signed JWTs for all five. */
export function seedPersonas(db: PersonaDb): PersonaMap {
  const personas: Partial<PersonaMap> = {};

  for (const role of FIVE_ROLES) {
    const username = `persona-${role}`;
    // Use a simple shared password since tests auth via Bearer, not login.
    const passwordHash = bcrypt.hashSync('password123', 1);
    db.addUser({ username, password_hash: passwordHash, role });
    const user = db.getUserByUsername(username)!;
    const tv = user.token_version;
    const token = jwt.sign(
      { username, role, tv },
      TEST_JWT_SECRET,
      { expiresIn: '1m' },
    );
    personas[role] = { username, role, tokenVersion: tv, bearer: `Bearer ${token}` };
  }

  return personas as PersonaMap;
}
