/**
 * Machine-auth scoped stack evidence: headers are trusted only under
 * node_proxy / pilot_tunnel, and only when the name + actions pair is valid.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET } from './helpers/setupTestDb';
import {
  PROXY_SCOPED_STACK_NAME_HEADER,
  PROXY_SCOPED_STACK_ACTIONS_HEADER,
  PROXY_ROLE_HEADER,
} from '../services/license-headers';
import { checkPermission } from '../middleware/permissions';

let tmpDir: string;
let authMiddleware: typeof import('../middleware/auth').authMiddleware;

function runAuth(req: Partial<Request>): Promise<Request> {
  return new Promise((resolve, reject) => {
    const fullReq = Object.assign(
      { cookies: {} as Record<string, string>, headers: {} as Record<string, string | undefined> },
      req,
      {
        headers: { ...(req.headers ?? {}) },
        cookies: {},
      },
    ) as Request;
    let settled = false;
    const res = {
      status: () => res,
      json: (body: unknown) => {
        if (!settled) {
          settled = true;
          reject(new Error(`authMiddleware rejected: ${JSON.stringify(body)}`));
        }
        return res;
      },
    } as unknown as Response;
    const next: NextFunction = (err?: unknown) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(fullReq);
    };
    void Promise.resolve(authMiddleware(fullReq, res, next)).catch(reject);
  });
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ authMiddleware } = await import('../middleware/auth'));
  const { LicenseService } = await import('../services/LicenseService');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

describe('scoped stack evidence under machine auth', () => {
  it('attaches evidence for node_proxy when headers are valid', async () => {
    const token = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const req = await runAuth({
      headers: {
        authorization: `Bearer ${token}`,
        [PROXY_ROLE_HEADER]: 'viewer',
        [PROXY_SCOPED_STACK_NAME_HEADER]: 'web',
        [PROXY_SCOPED_STACK_ACTIONS_HEADER]: 'stack:edit,stack:deploy',
      },
    });
    expect(req.scopedStackEvidence?.stackName).toBe('web');
    expect(req.scopedStackEvidence?.actions.has('stack:edit')).toBe(true);
    expect(req.scopedStackEvidence?.actions.has('stack:deploy')).toBe(true);
    expect(checkPermission(req, 'stack:deploy', 'stack', 'web')).toBe(true);
    expect(checkPermission(req, 'stack:edit', 'stack', 'web')).toBe(true);
  });

  it('attaches evidence for pilot_tunnel the same way', async () => {
    const token = jwt.sign({ scope: 'pilot_tunnel' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const req = await runAuth({
      headers: {
        authorization: `Bearer ${token}`,
        [PROXY_ROLE_HEADER]: 'viewer',
        [PROXY_SCOPED_STACK_NAME_HEADER]: 'api',
        [PROXY_SCOPED_STACK_ACTIONS_HEADER]: 'stack:read',
      },
    });
    expect(req.scopedStackEvidence?.stackName).toBe('api');
    expect(checkPermission(req, 'stack:read', 'stack', 'api')).toBe(true);
  });

  it('treats malformed actions as absent evidence', async () => {
    const token = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const req = await runAuth({
      headers: {
        authorization: `Bearer ${token}`,
        [PROXY_ROLE_HEADER]: 'viewer',
        [PROXY_SCOPED_STACK_NAME_HEADER]: 'web',
        [PROXY_SCOPED_STACK_ACTIONS_HEADER]: 'stack:edit,not-real',
      },
    });
    expect(req.scopedStackEvidence).toBeUndefined();
    expect(checkPermission(req, 'stack:edit', 'stack', 'web')).toBe(false);
  });

  it('ignores evidence headers on a user session JWT', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const { TEST_USERNAME } = await import('./helpers/setupTestDb');
    const user = DatabaseService.getInstance().getUserByUsername(TEST_USERNAME);
    expect(user).toBeDefined();
    const token = jwt.sign(
      { username: user!.username, role: user!.role, tv: user!.token_version },
      TEST_JWT_SECRET,
      { expiresIn: '1m' },
    );
    const req = await runAuth({
      headers: {
        authorization: `Bearer ${token}`,
        [PROXY_SCOPED_STACK_NAME_HEADER]: 'web',
        [PROXY_SCOPED_STACK_ACTIONS_HEADER]: 'stack:deploy,stack:edit',
      },
    });
    expect(req.scopedStackEvidence).toBeUndefined();
  });
});
