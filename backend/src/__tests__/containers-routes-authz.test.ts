/**
 * Authorization tests for the container *read* routes
 * (GET /api/containers and GET /api/containers/:id/logs).
 *
 * Both stream container data and, until now, carried only the global auth gate.
 * These tests pin that they enforce the stack:read read model the canonical
 * GET /api/stacks already uses, bringing them under the same authorization
 * discipline as their write siblings (/start, /stop, /restart), which gate on
 * requireAdmin. Every role currently holds stack:read, so the guard denies
 * nobody today; the tests pin that (no role loses access) and prove the guard
 * is actually wired (a denied principal gets 403, not the data).
 *
 * Docker is stubbed at the prototype so the granted path is deterministic
 * without a daemon. For GET /:id/logs the guard runs before streamContainerLogs
 * flushes SSE headers, so a denied caller gets a clean JSON 403 rather than a
 * half-open event-stream.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import type { UserRole } from '../services/DatabaseService';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import DockerController from '../services/DockerController';
import * as permissionsMod from '../middleware/permissions';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
const roleCookie: Record<string, string> = {};
let permSpy: ReturnType<typeof vi.spyOn> | undefined;

// Every role holds stack:read, so all of them must pass the read guard today.
const READ_ROLES: UserRole[] = ['admin', 'node-admin', 'deployer', 'viewer', 'auditor'];

async function seedAndLogin(role: UserRole): Promise<string> {
  const username = `containers-${role}`;
  const password = `containers-${role}-pass`;
  const passwordHash = await bcrypt.hash(password, 1);
  DatabaseService.getInstance().addUser({ username, password_hash: passwordHash, role });
  const res = await request(app).post('/api/auth/login').send({ username, password });
  const cookies = res.headers['set-cookie'] as string | string[];
  return Array.isArray(cookies) ? cookies[0] : cookies;
}

/**
 * Spy the imported requirePermission symbol (the routes call it cross-module, so
 * the namespace spy intercepts reliably) and reproduce its real deny. Spying
 * checkPermission would not work: requirePermission calls it as an intra-module
 * reference a namespace spy cannot reach.
 */
function denyPermission(): void {
  permSpy = vi.spyOn(permissionsMod, 'requirePermission').mockImplementation((_req, res) => {
    res.status(403).json({ error: 'Permission denied.', code: 'PERMISSION_DENIED' });
    return false;
  });
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));

  // Deterministic Docker: the granted path must not depend on a live daemon.
  vi.spyOn(DockerController.prototype, 'getRunningContainers').mockResolvedValue([]);
  vi.spyOn(DockerController.prototype, 'streamContainerLogs').mockImplementation(
    async (_id, _req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end();
    },
  );

  ({ app } = await import('../index'));
  roleCookie['admin'] = await loginAsTestAdmin(app);
  for (const role of ['node-admin', 'deployer', 'viewer', 'auditor'] as const) {
    roleCookie[role] = await seedAndLogin(role);
  }
});

// Restore only the per-test permission spy; the Docker prototype stubs live for
// the whole file (both read routes need them) and vitest isolates per file.
afterEach(() => {
  permSpy?.mockRestore();
  permSpy = undefined;
});

afterAll(() => cleanupTestDb(tmpDir));

describe('GET /api/containers (list) authorization', () => {
  it('rejects unauthenticated requests with the auth-gate 401, not a permission error', async () => {
    const res = await request(app).get('/api/containers');
    expect(res.status).toBe(401);
    // Distinct from the 403 permission shape: bare auth error, no `code`.
    expect(res.body).toEqual({ error: 'Authentication required' });
  });

  it.each(READ_ROLES)('lets a %s through the read guard with 200', async (role) => {
    const res = await request(app).get('/api/containers').set('Cookie', roleCookie[role]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 403 PERMISSION_DENIED when stack:read is denied', async () => {
    denyPermission();
    const res = await request(app).get('/api/containers').set('Cookie', roleCookie['viewer']);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
    expect(permSpy).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'stack:read');
  });
});

describe('GET /api/containers/:id/logs authorization', () => {
  it('rejects unauthenticated requests with the auth-gate 401, not a permission error', async () => {
    const res = await request(app).get('/api/containers/abc123/logs');
    expect(res.status).toBe(401);
    // Distinct from the 403 permission shape: bare auth error, no `code`.
    expect(res.body).toEqual({ error: 'Authentication required' });
  });

  it.each(READ_ROLES)('lets a %s through the read guard with 200', async (role) => {
    const res = await request(app).get('/api/containers/abc123/logs').set('Cookie', roleCookie[role]);
    expect(res.status).toBe(200);
  });

  it('returns 403 PERMISSION_DENIED before opening the stream when stack:read is denied', async () => {
    denyPermission();
    const res = await request(app).get('/api/containers/abc123/logs').set('Cookie', roleCookie['viewer']);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
    expect(permSpy).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'stack:read');
  });
});
