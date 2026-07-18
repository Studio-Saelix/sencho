/**
 * Route + provenance tests for missing-external-network preflight.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import {
  setupTestDb,
  cleanupTestDb,
  loginAsTestAdmin,
  TEST_JWT_SECRET,
} from './helpers/setupTestDb';
import { TEST_USERNAME } from './helpers/testConstants';
import {
  PROXY_DEPLOY_SOURCE_HEADER,
  PROXY_DEPLOY_ACTOR_HEADER,
} from '../services/license-headers';

let tmpDir: string;
let app: import('express').Express;
let adminCookie: string;
let composeDir: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  composeDir = process.env.COMPOSE_DIR!;
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);

  const stackDir = path.join(composeDir, 'netcheck');
  fs.mkdirSync(stackDir, { recursive: true });
  fs.writeFileSync(
    path.join(stackDir, 'compose.yaml'),
    [
      'services:',
      '  web:',
      '    image: nginx:alpine',
      'networks:',
      '  arr:',
      '    external: true',
      '    name: arr-net',
      '',
    ].join('\n'),
    'utf8',
  );
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

const signToken = (payload: Record<string, unknown>) =>
  jwt.sign(payload, TEST_JWT_SECRET, { expiresIn: '1m' });

describe('GET /api/stacks/:stackName/missing-external-networks', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/stacks/netcheck/missing-external-networks');
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown stack', async () => {
    const res = await request(app)
      .get('/api/stacks/does-not-exist/missing-external-networks')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(404);
  });

  it('returns a typed envelope for an existing stack', async () => {
    const res = await request(app)
      .get('/api/stacks/netcheck/missing-external-networks')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      stackName: 'netcheck',
      autoCreateEnabled: expect.any(Boolean),
      declaredExternalCount: expect.any(Number),
      networks: expect.any(Array),
    }));
    expect(['ok', 'render_unavailable', 'runtime_unavailable']).toContain(res.body.status);
  });
});

describe('deploy provenance trust boundary', () => {
  async function runAuth(
    headers: Record<string, string>,
  ): Promise<{ nextCalled: boolean; deployContext: import('express').Request['deployContext'] }> {
    const { authMiddleware } = await import('../middleware/auth');
    const req = {
      headers,
      cookies: {},
    } as unknown as import('express').Request;
    let nextCalled = false;
    await new Promise<void>((resolve) => {
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(() => resolve()),
      } as unknown as import('express').Response;
      void Promise.resolve(authMiddleware(req, res, () => {
        nextCalled = true;
        resolve();
      })).catch(() => resolve());
    });
    return { nextCalled, deployContext: req.deployContext };
  }

  it('ignores browser-supplied deploy provenance headers on a user session', async () => {
    const res = await request(app)
      .get('/api/stacks')
      .set('Cookie', adminCookie)
      .set(PROXY_DEPLOY_SOURCE_HEADER, 'scheduler')
      .set(PROXY_DEPLOY_ACTOR_HEADER, 'system:scheduler');
    expect(res.status).toBe(200);
  });

  it('stores trusted deployContext for node_proxy with valid provenance headers', async () => {
    const token = signToken({ scope: 'node_proxy' });
    const result = await runAuth({
      authorization: `Bearer ${token}`,
      [PROXY_DEPLOY_SOURCE_HEADER]: 'scheduler',
      [PROXY_DEPLOY_ACTOR_HEADER]: 'system:scheduler',
    });
    expect(result.nextCalled).toBe(true);
    expect(result.deployContext).toEqual({
      source: 'scheduler',
      actor: 'system:scheduler',
    });
  });

  it('does not trust deploy provenance headers on user session JWTs', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const user = DatabaseService.getInstance().getUserByUsername(TEST_USERNAME);
    expect(user).toBeTruthy();
    const token = signToken({
      username: TEST_USERNAME,
      role: 'admin',
      tv: user!.token_version,
    });
    const result = await runAuth({
      authorization: `Bearer ${token}`,
      [PROXY_DEPLOY_SOURCE_HEADER]: 'scheduler',
      [PROXY_DEPLOY_ACTOR_HEADER]: 'system:scheduler',
    });
    expect(result.nextCalled).toBe(true);
    expect(result.deployContext).toBeUndefined();
  });
});
