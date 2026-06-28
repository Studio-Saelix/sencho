/**
 * Authorization tests for the fleet topology reads. /overview, /configuration,
 * /dependency-map, /networking-summary, and /update-status expose node names,
 * host stats, versions, and cross-node topology, so they require node:read.
 * Every shipped role carries node:read except deployer, the denial persona here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let viewerToken: string;
let deployerToken: string;

const NODE_READ_ROUTES = [
  '/api/fleet/overview',
  '/api/fleet/configuration',
  '/api/fleet/dependency-map',
  '/api/fleet/networking-summary',
  '/api/fleet/update-status',
];

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  const { DatabaseService } = await import('../services/DatabaseService');
  const db = DatabaseService.getInstance();
  const hash = await bcrypt.hash('password123', 1);
  db.addUser({ username: 'fleet-viewer', password_hash: hash, role: 'viewer' });
  db.addUser({ username: 'fleet-deployer', password_hash: hash, role: 'deployer' });
  const sign = (username: string, role: string): string => {
    const user = db.getUserByUsername(username)!;
    return jwt.sign({ username, role, tv: user.token_version }, TEST_JWT_SECRET, { expiresIn: '1m' });
  };
  viewerToken = sign('fleet-viewer', 'viewer');
  deployerToken = sign('fleet-deployer', 'deployer');
});

afterAll(() => cleanupTestDb(tmpDir));

describe('fleet topology reads require node:read', () => {
  for (const route of NODE_READ_ROUTES) {
    it(`denies ${route} for a role without node:read (deployer)`, async () => {
      const res = await request(app).get(route).set('Authorization', `Bearer ${deployerToken}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
    });

    it(`allows ${route} for a role with node:read (viewer)`, async () => {
      const res = await request(app).get(route).set('Authorization', `Bearer ${viewerToken}`);
      // The guard lets the request through; the body may be empty/offline in a
      // Docker-less test env, but it must not be a 403.
      expect(res.status).not.toBe(403);
    });
  }

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/fleet/overview');
    expect(res.status).toBe(401);
  });
});
