/**
 * Settings write authorization: per-key permission buckets on /api/settings
 * and Settings-scoped image-update routes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import type { UserRole } from '../services/DatabaseService';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let adminCookie: string;
const roleCookie: Partial<Record<UserRole, string>> = {};

async function seedAndLogin(role: UserRole): Promise<string> {
  const username = `settings-perm-${role}`;
  const password = `${username}-pass`;
  const passwordHash = await bcrypt.hash(password, 1);
  DatabaseService.getInstance().addUser({ username, password_hash: passwordHash, role });
  const res = await request(app).post('/api/auth/login').send({ username, password });
  const cookies = res.headers['set-cookie'] as string | string[];
  return Array.isArray(cookies) ? cookies[0] : cookies;
}

let LicenseService: typeof import('../services/LicenseService').LicenseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ LicenseService } = await import('../services/LicenseService'));

  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');

  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
  for (const role of ['node-admin', 'deployer', 'viewer', 'auditor'] as const) {
    roleCookie[role] = await seedAndLogin(role);
  }
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
});

describe('PATCH /api/settings permission buckets', () => {
  it('lets node-admin write a node:manage key', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .set('Cookie', roleCookie['node-admin']!)
      .send({ host_cpu_limit: 80 });
    expect(res.status).toBe(200);
  });

  it('rejects node-admin writing a system:settings key', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .set('Cookie', roleCookie['node-admin']!)
      .send({ developer_mode: '1' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('rejects mixed node-manage + system-settings PATCH from node-admin', async () => {
    const before = DatabaseService.getInstance().getGlobalSettings().host_cpu_limit;
    const res = await request(app)
      .patch('/api/settings')
      .set('Cookie', roleCookie['node-admin']!)
      .send({ host_cpu_limit: 80, developer_mode: '1' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
    expect(DatabaseService.getInstance().getGlobalSettings().host_cpu_limit).toBe(before);
  });

  it.each(['deployer', 'viewer', 'auditor'] as const)(
    'rejects %s writing a node:manage key',
    async (role) => {
      const res = await request(app)
        .patch('/api/settings')
        .set('Cookie', roleCookie[role]!)
        .send({ host_cpu_limit: 70 });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
    },
  );

  it('lets admin write system:settings keys', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .set('Cookie', adminCookie)
      .send({ developer_mode: '0' });
    expect(res.status).toBe(200);
  });

  it('lets admin empty PATCH as a no-op', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(200);
  });

  it('lets node-admin empty PATCH as a no-op', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .set('Cookie', roleCookie['node-admin']!)
      .send({});
    expect(res.status).toBe(200);
  });

  it.each(['deployer', 'viewer', 'auditor'] as const)(
    'rejects empty PATCH from %s',
    async (role) => {
      const res = await request(app)
        .patch('/api/settings')
        .set('Cookie', roleCookie[role]!)
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
    },
  );

  it('lets node-admin POST a single node:manage key', async () => {
    const res = await request(app)
      .post('/api/settings')
      .set('Cookie', roleCookie['node-admin']!)
      .send({ key: 'host_cpu_limit', value: 75 });
    expect(res.status).toBe(200);
  });

  it('rejects node-admin POST of a system:settings key', async () => {
    const res = await request(app)
      .post('/api/settings')
      .set('Cookie', roleCookie['node-admin']!)
      .send({ key: 'developer_mode', value: '1' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('honors node-scoped node-admin grants for node:manage writes', async () => {
    const db = DatabaseService.getInstance();
    const defaultNodeId = db.getDefaultNode()!.id!;
    const remoteId = db.addNode({
      name: 'settings-scoped-remote',
      type: 'remote',
      api_url: 'http://192.168.1.50:1852',
      api_token: 'test-token',
      compose_dir: '/tmp',
      is_default: false,
    });

    const allowedPassword = 'settings-scoped-allow-pass';
    const allowedUserId = db.addUser({
      username: 'settings-scoped-allow',
      password_hash: await bcrypt.hash(allowedPassword, 1),
      role: 'viewer',
    });
    db.addRoleAssignment({
      user_id: allowedUserId,
      role: 'node-admin',
      resource_type: 'node',
      resource_id: String(defaultNodeId),
    });
    const allowedLogin = await request(app).post('/api/auth/login').send({
      username: 'settings-scoped-allow',
      password: allowedPassword,
    });
    const allowedCookies = allowedLogin.headers['set-cookie'] as string | string[];
    const allowedCookie = Array.isArray(allowedCookies) ? allowedCookies[0] : allowedCookies;

    const allowed = await request(app)
      .patch('/api/settings')
      .set('Cookie', allowedCookie)
      .set('x-node-id', String(defaultNodeId))
      .send({ host_cpu_limit: 81 });
    expect(allowed.status).toBe(200);

    // Grant only on a remote node; local default writes must still 403 (and stay
    // on the local settings route, not the remote proxy).
    const deniedPassword = 'settings-scoped-deny-pass';
    const deniedUserId = db.addUser({
      username: 'settings-scoped-deny',
      password_hash: await bcrypt.hash(deniedPassword, 1),
      role: 'viewer',
    });
    db.addRoleAssignment({
      user_id: deniedUserId,
      role: 'node-admin',
      resource_type: 'node',
      resource_id: String(remoteId),
    });
    const deniedLogin = await request(app).post('/api/auth/login').send({
      username: 'settings-scoped-deny',
      password: deniedPassword,
    });
    const deniedCookies = deniedLogin.headers['set-cookie'] as string | string[];
    const deniedCookie = Array.isArray(deniedCookies) ? deniedCookies[0] : deniedCookies;

    const denied = await request(app)
      .patch('/api/settings')
      .set('Cookie', deniedCookie)
      .set('x-node-id', String(defaultNodeId))
      .send({ host_cpu_limit: 82 });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('PERMISSION_DENIED');
  });
});

describe('Settings feature routes permission matrix', () => {
  it('rejects node-admin on system:* feature mutations', async () => {
    const cookie = roleCookie['node-admin']!;
    const cases: Array<{ method: 'get' | 'post' | 'put' | 'delete'; path: string; body?: object }> = [
      { method: 'get', path: '/api/users' },
      { method: 'post', path: '/api/api-tokens', body: { name: 'x', scope: 'read-only' } },
      { method: 'post', path: '/api/webhooks', body: { name: 'x', stack_name: 'demo', action: 'restart' } },
      { method: 'post', path: '/api/registries', body: { name: 'x', url: 'https://example.com', username: 'u', password: 'p' } },
      { method: 'post', path: '/api/license/activate', body: { license_key: 'x' } },
    ];
    for (const c of cases) {
      const req = request(app)[c.method](c.path).set('Cookie', cookie);
      const res = c.body ? await req.send(c.body) : await req;
      expect(res.status, c.path).toBe(403);
      expect(res.body.code, c.path).toBe('PERMISSION_DENIED');
    }
  });

  it('lets node-admin upsert a notification agent channel', async () => {
    const res = await request(app)
      .post('/api/agents')
      .set('Cookie', roleCookie['node-admin']!)
      .send({
        type: 'discord',
        url: 'https://discord.com/api/webhooks/123/abc',
        enabled: true,
      });
    expect(res.status).toBe(200);
  });

  it('rejects viewer upserting a notification agent channel', async () => {
    const res = await request(app)
      .post('/api/agents')
      .set('Cookie', roleCookie.viewer!)
      .send({
        type: 'discord',
        url: 'https://discord.com/api/webhooks/123/abc',
        enabled: true,
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });
});

describe('image-updates Settings-scoped routes', () => {
  it('rejects node-admin PUT /interval (system:settings)', async () => {
    const res = await request(app)
      .put('/api/image-updates/interval')
      .set('Cookie', roleCookie['node-admin']!)
      .send({ minutes: 60 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('rejects node-admin PUT /enabled (system:settings)', async () => {
    const res = await request(app)
      .put('/api/image-updates/enabled')
      .set('Cookie', roleCookie['node-admin']!)
      .send({ enabled: false });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('lets admin PUT /interval', async () => {
    const res = await request(app)
      .put('/api/image-updates/interval')
      .set('Cookie', adminCookie)
      .send({ minutes: 60 });
    expect(res.status).toBe(200);
  });

  it('lets admin PUT /enabled', async () => {
    const res = await request(app)
      .put('/api/image-updates/enabled')
      .set('Cookie', adminCookie)
      .send({ enabled: true });
    expect(res.status).toBe(200);
  });

  it('lets node-admin POST /refresh (node:manage)', async () => {
    const res = await request(app)
      .post('/api/image-updates/refresh')
      .set('Cookie', roleCookie['node-admin']!);
    // 200 on success, 409 when checks disabled, 429 on cooldown — not 403.
    expect(res.status).not.toBe(403);
    expect([200, 409, 429]).toContain(res.status);
  });

  it('rejects viewer POST /refresh', async () => {
    const res = await request(app)
      .post('/api/image-updates/refresh')
      .set('Cookie', roleCookie.viewer!);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });
});
