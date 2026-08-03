/**
 * Integration tests for Alert CRUD endpoints, notification test dispatch
 * validation, and auth enforcement on all alert/notification routes.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let ROLE_PERMISSIONS: typeof import('../middleware/permissions').ROLE_PERMISSIONS;
let authCookie: string;
let viewerCookie: string;

type SeedRole = 'admin' | 'node-admin' | 'deployer' | 'viewer' | 'auditor';

/** Seed a user with the given role and return a signed bearer token for it. */
async function seedRoleToken(username: string, role: SeedRole): Promise<string> {
  const db = DatabaseService.getInstance();
  let user = db.getUserByUsername(username);
  if (!user) {
    const hash = await bcrypt.hash('password123', 1);
    db.addUser({ username, password_hash: hash, role });
    user = db.getUserByUsername(username);
  }
  return jwt.sign({ username, role, tv: user!.token_version }, TEST_JWT_SECRET, { expiresIn: '5m' });
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ ROLE_PERMISSIONS } = await import('../middleware/permissions'));

  // Mock LicenseService so paid-gated routes are accessible
  const { LicenseService } = await import('../services/LicenseService');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');

  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);

  // Create a viewer user for non-admin tests
  const viewerHash = await bcrypt.hash('viewerpass', 1);
  DatabaseService.getInstance().addUser({ username: 'viewer', password_hash: viewerHash, role: 'viewer' });
  const viewerRes = await request(app)
    .post('/api/auth/login')
    .send({ username: 'viewer', password: 'viewerpass' });
  const cookies = viewerRes.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

// --- GET /api/alerts ---

describe('GET /api/alerts', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/alerts');
    expect(res.status).toBe(401);
  });

  it('returns empty array when no alerts exist', async () => {
    const res = await request(app)
      .get('/api/alerts')
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('filters alerts by stackName query param', async () => {
    // Seed two alerts for different stacks
    const db = DatabaseService.getInstance();
    db.addStackAlert({ stack_name: 'web', service_name: null, metric: 'cpu_percent', operator: '>', threshold: 80, duration_mins: 5, cooldown_mins: 60 });
    db.addStackAlert({ stack_name: 'api', service_name: null, metric: 'memory_percent', operator: '>', threshold: 90, duration_mins: 5, cooldown_mins: 60 });

    const res = await request(app)
      .get('/api/alerts?stackName=web')
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].stack_name).toBe('web');
  });

  it('denies a role without stack:read with 403 PERMISSION_DENIED', async () => {
    // Every shipped role carries stack:read, so the denial path is exercised
    // by temporarily removing it from viewer at runtime, proving the added
    // gate actually runs rather than being a no-op.
    const original = ROLE_PERMISSIONS.viewer;
    ROLE_PERMISSIONS.viewer = original.filter((p) => p !== 'stack:read');
    try {
      const res = await request(app)
        .get('/api/alerts')
        .set('Cookie', viewerCookie);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
    } finally {
      ROLE_PERMISSIONS.viewer = original;
    }
  });
});

// --- POST /api/alerts ---

describe('POST /api/alerts', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .send({ stack_name: 'test', metric: 'cpu_percent', operator: '>', threshold: 80, duration_mins: 5, cooldown_mins: 60 });
    expect(res.status).toBe(401);
  });

  it.each(['viewer', 'deployer', 'auditor'] as const)(
    'rejects %s with 403 PERMISSION_DENIED (lacks stack:edit)',
    async (role) => {
      const token = await seedRoleToken(`alerts-post-${role}`, role);
      const res = await request(app)
        .post('/api/alerts')
        .set('Authorization', `Bearer ${token}`)
        .send({ stack_name: 'perm-gate-post', metric: 'cpu_percent', operator: '>', threshold: 80, duration_mins: 5, cooldown_mins: 60 });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
    },
  );

  it.each(['admin', 'node-admin'] as const)(
    'lets %s pass the permission gate',
    async (role) => {
      const token = await seedRoleToken(`alerts-post-${role}`, role);
      const res = await request(app)
        .post('/api/alerts')
        .set('Authorization', `Bearer ${token}`)
        .send({ stack_name: `perm-gate-post-${role}`, metric: 'cpu_percent', operator: '>', threshold: 80, duration_mins: 5, cooldown_mins: 60 });
      expect(res.status).toBe(201);
    },
  );

  it('creates alert and returns 201 with created resource', async () => {
    const payload = {
      stack_name: 'new-stack',
      metric: 'memory_percent',
      operator: '>=',
      threshold: 85,
      duration_mins: 10,
      cooldown_mins: 30,
    };

    const res = await request(app)
      .post('/api/alerts')
      .set('Cookie', authCookie)
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.stack_name).toBe('new-stack');
    expect(res.body.service_name).toBeNull();
    expect(res.body.metric).toBe('memory_percent');
    expect(res.body.threshold).toBe(85);
  });

  it('persists a valid dotted service_name', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Cookie', authCookie)
      .send({
        stack_name: 'svc-stack',
        service_name: 'api.web',
        metric: 'cpu_percent',
        operator: '>',
        threshold: 80,
        duration_mins: 5,
        cooldown_mins: 60,
      });
    expect(res.status).toBe(201);
    expect(res.body.service_name).toBe('api.web');
  });

  it('normalizes empty service_name to null', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Cookie', authCookie)
      .send({
        stack_name: 'empty-svc',
        service_name: '',
        metric: 'cpu_percent',
        operator: '>',
        threshold: 80,
        duration_mins: 5,
        cooldown_mins: 60,
      });
    expect(res.status).toBe(201);
    expect(res.body.service_name).toBeNull();
  });

  it('rejects whitespace-only service_name', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Cookie', authCookie)
      .send({
        stack_name: 'bad-svc',
        service_name: '   ',
        metric: 'cpu_percent',
        operator: '>',
        threshold: 80,
        duration_mins: 5,
        cooldown_mins: 60,
      });
    expect(res.status).toBe(400);
  });

  it('rejects reserved _unlabeled service_name', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Cookie', authCookie)
      .send({
        stack_name: 'bad-svc',
        service_name: '_unlabeled',
        metric: 'cpu_percent',
        operator: '>',
        threshold: 80,
        duration_mins: 5,
        cooldown_mins: 60,
      });
    expect(res.status).toBe(400);
  });

  it('rejects service_name when the capability is disabled', async () => {
    const { disableCapability, enableCapability, SERVICE_SCOPED_STACK_ALERT_CAPABILITY } =
      await import('../services/CapabilityRegistry');
    disableCapability(SERVICE_SCOPED_STACK_ALERT_CAPABILITY);
    try {
      const res = await request(app)
        .post('/api/alerts')
        .set('Cookie', authCookie)
        .send({
          stack_name: 'cap-stack',
          service_name: 'api',
          metric: 'cpu_percent',
          operator: '>',
          threshold: 80,
          duration_mins: 5,
          cooldown_mins: 60,
        });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('capability_unavailable');
    } finally {
      enableCapability(SERVICE_SCOPED_STACK_ALERT_CAPABILITY);
    }
  });

  it('validates required fields and returns 400 for missing data', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Cookie', authCookie)
      .send({ stack_name: 'test' }); // missing metric, operator, threshold, etc.

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid alert data');
  });

  it('rejects invalid metric values', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Cookie', authCookie)
      .send({ stack_name: 'test', metric: 'invalid_metric', operator: '>', threshold: 80, duration_mins: 5, cooldown_mins: 60 });

    expect(res.status).toBe(400);
  });

  it('rejects negative threshold', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Cookie', authCookie)
      .send({ stack_name: 'test', metric: 'cpu_percent', operator: '>', threshold: -1, duration_mins: 5, cooldown_mins: 60 });

    expect(res.status).toBe(400);
  });

  it('rejects empty stack_name', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Cookie', authCookie)
      .send({ stack_name: '', metric: 'cpu_percent', operator: '>', threshold: 80, duration_mins: 5, cooldown_mins: 60 });

    expect(res.status).toBe(400);
  });

  it('rejects stack_name exceeding 255 characters', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Cookie', authCookie)
      .send({ stack_name: 'a'.repeat(256), metric: 'cpu_percent', operator: '>', threshold: 80, duration_mins: 5, cooldown_mins: 60 });

    expect(res.status).toBe(400);
  });

  it('rejects duration_mins exceeding 1440', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Cookie', authCookie)
      .send({ stack_name: 'test', metric: 'cpu_percent', operator: '>', threshold: 80, duration_mins: 1441, cooldown_mins: 60 });

    expect(res.status).toBe(400);
  });

  it('rejects cooldown_mins exceeding 10080', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Cookie', authCookie)
      .send({ stack_name: 'test', metric: 'cpu_percent', operator: '>', threshold: 80, duration_mins: 5, cooldown_mins: 10081 });

    expect(res.status).toBe(400);
  });

  it('rejects invalid operator', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Cookie', authCookie)
      .send({ stack_name: 'test', metric: 'cpu_percent', operator: '!=', threshold: 80, duration_mins: 5, cooldown_mins: 60 });

    expect(res.status).toBe(400);
  });
});

// --- DELETE /api/alerts/:id ---

describe('DELETE /api/alerts/:id', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).delete('/api/alerts/1');
    expect(res.status).toBe(401);
  });

  it.each(['viewer', 'deployer', 'auditor'] as const)(
    'rejects %s with 403 PERMISSION_DENIED (lacks stack:edit)',
    async (role) => {
      const alert = DatabaseService.getInstance().addStackAlert({
        stack_name: `delete-gate-deny-${role}`,
        service_name: null,
        metric: 'cpu_percent',
        operator: '>',
        threshold: 90,
        duration_mins: 0,
        cooldown_mins: 0,
      });
      const token = await seedRoleToken(`alerts-delete-${role}`, role);
      const res = await request(app)
        .delete(`/api/alerts/${alert.id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
    },
  );

  it.each(['admin', 'node-admin'] as const)(
    'lets %s delete',
    async (role) => {
      const alert = DatabaseService.getInstance().addStackAlert({
        stack_name: `delete-gate-allow-${role}`,
        service_name: null,
        metric: 'cpu_percent',
        operator: '>',
        threshold: 90,
        duration_mins: 0,
        cooldown_mins: 0,
      });
      const token = await seedRoleToken(`alerts-delete-${role}`, role);
      const res = await request(app)
        .delete(`/api/alerts/${alert.id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    },
  );

  it('returns 404 for a nonexistent alert id', async () => {
    const res = await request(app)
      .delete('/api/alerts/99999')
      .set('Cookie', authCookie);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Alert not found' });
  });

  it("authorizes against the alert's own stack, not a caller's scoped grant on a different stack", async () => {
    const db = DatabaseService.getInstance();
    const defaultNodeId = db.getDefaultNode()!.id!;
    const hash = await bcrypt.hash('password123', 1);
    const userId = db.addUser({ username: 'alerts-scoped-editor', password_hash: hash, role: 'viewer' });
    db.addRoleAssignment({
      user_id: userId,
      role: 'node-admin',
      resource_type: 'stack',
      resource_id: 'scoped-allowed-stack',
      node_id: defaultNodeId,
    });
    const user = db.getUserByUsername('alerts-scoped-editor')!;
    const token = jwt.sign({ username: user.username, role: user.role, tv: user.token_version }, TEST_JWT_SECRET, { expiresIn: '5m' });

    try {
      // The scoped grant only covers 'scoped-allowed-stack', so an alert
      // belonging to a different stack must still be denied.
      const deniedAlert = db.addStackAlert({
        stack_name: 'scoped-other-stack',
        service_name: null,
        metric: 'cpu_percent',
        operator: '>',
        threshold: 90,
        duration_mins: 0,
        cooldown_mins: 0,
      });
      const deniedRes = await request(app)
        .delete(`/api/alerts/${deniedAlert.id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(deniedRes.status).toBe(403);
      expect(deniedRes.body.code).toBe('PERMISSION_DENIED');

      const allowedAlert = db.addStackAlert({
        stack_name: 'scoped-allowed-stack',
        service_name: null,
        metric: 'cpu_percent',
        operator: '>',
        threshold: 90,
        duration_mins: 0,
        cooldown_mins: 0,
      });
      const allowedRes = await request(app)
        .delete(`/api/alerts/${allowedAlert.id}`)
        .set('Authorization', `Bearer ${token}`);
      expect(allowedRes.status).toBe(200);
      expect(allowedRes.body.success).toBe(true);
    } finally {
      db.deleteRoleAssignmentsByUser(userId);
      db.deleteUser(userId);
    }
  });

  it('deletes existing alert rule', async () => {
    // Create an alert to delete
    const created = DatabaseService.getInstance().addStackAlert({
      stack_name: 'delete-me',
      service_name: null,
      metric: 'cpu_percent',
      operator: '>',
      threshold: 90,
      duration_mins: 0,
      cooldown_mins: 0,
    });

    const res = await request(app)
      .delete(`/api/alerts/${created.id}`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('rejects leading-junk ids like 1abc without deleting alert 1', async () => {
    const created = DatabaseService.getInstance().addStackAlert({
      stack_name: 'strict-id-junk',
      service_name: null,
      metric: 'cpu_percent',
      operator: '>',
      threshold: 90,
      duration_mins: 0,
      cooldown_mins: 0,
    });
    expect(created.id).toBeDefined();

    const res = await request(app)
      .delete(`/api/alerts/${created.id}abc`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid alert id');
    expect(DatabaseService.getInstance().getStackAlerts('strict-id-junk').some((a) => a.id === created.id)).toBe(true);
  });

  it('rejects fractional ids like 2.5 without deleting alert 2', async () => {
    const first = DatabaseService.getInstance().addStackAlert({
      stack_name: 'strict-id-fraction',
      service_name: null,
      metric: 'cpu_percent',
      operator: '>',
      threshold: 80,
      duration_mins: 0,
      cooldown_mins: 0,
    });
    const second = DatabaseService.getInstance().addStackAlert({
      stack_name: 'strict-id-fraction',
      service_name: null,
      metric: 'memory_percent',
      operator: '>',
      threshold: 80,
      duration_mins: 0,
      cooldown_mins: 0,
    });
    expect(second.id).toBeDefined();

    const res = await request(app)
      .delete(`/api/alerts/${second.id}.5`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid alert id');
    const remaining = DatabaseService.getInstance().getStackAlerts('strict-id-fraction').map((a) => a.id);
    expect(remaining).toEqual(expect.arrayContaining([first.id, second.id]));
  });
});

// --- POST /api/notifications/test ---

describe('POST /api/notifications/test', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app)
      .post('/api/notifications/test')
      .send({ type: 'discord', url: 'https://discord.com/api/webhooks/123/abc' });
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users with 403', async () => {
    const res = await request(app)
      .post('/api/notifications/test')
      .set('Cookie', viewerCookie)
      .send({ type: 'discord', url: 'https://discord.com/api/webhooks/123/abc' });
    expect(res.status).toBe(403);
  });

  it('rejects invalid type with 400', async () => {
    const res = await request(app)
      .post('/api/notifications/test')
      .set('Cookie', authCookie)
      .send({ type: 'telegram', url: 'https://example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('discord, slack, webhook, apprise, ntfy');
  });

  it('rejects missing type with 400', async () => {
    const res = await request(app)
      .post('/api/notifications/test')
      .set('Cookie', authCookie)
      .send({ url: 'https://example.com' });
    expect(res.status).toBe(400);
  });

  it('rejects non-HTTPS url with 400', async () => {
    const res = await request(app)
      .post('/api/notifications/test')
      .set('Cookie', authCookie)
      .send({ type: 'discord', url: 'http://example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('HTTPS');
  });

  it('rejects missing url with 400', async () => {
    const res = await request(app)
      .post('/api/notifications/test')
      .set('Cookie', authCookie)
      .send({ type: 'discord' });
    expect(res.status).toBe(400);
  });

  it('rejects malformed url with 400', async () => {
    const res = await request(app)
      .post('/api/notifications/test')
      .set('Cookie', authCookie)
      .send({ type: 'discord', url: 'https://' });
    expect(res.status).toBe(400);
  });

  it('dispatches keyed Apprise test with exact payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const res = await request(app)
        .post('/api/notifications/test')
        .set('Cookie', authCookie)
        .send({ type: 'apprise', url: 'http://apprise.local/notify/test-key', config: { tags: 'ops' } });
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://apprise.local/notify/test-key',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            title: 'Sencho Alert [INFO]',
            body: '🔌 Test Notification from Sencho!',
            type: 'info',
            tag: 'ops',
          }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('dispatches stateless Apprise test with urls and rejects scheme-less tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const bad = await request(app)
        .post('/api/notifications/test')
        .set('Cookie', authCookie)
        .send({ type: 'apprise', url: 'http://apprise.local/notify', config: { urls: 'no-scheme' } });
      expect(bad.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();

      const ok = await request(app)
        .post('/api/notifications/test')
        .set('Cookie', authCookie)
        .send({ type: 'apprise', url: 'http://apprise.local/notify', config: { urls: 'discord://token' } });
      expect(ok.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://apprise.local/notify',
        expect.objectContaining({
          body: JSON.stringify({
            title: 'Sencho Alert [INFO]',
            body: '🔌 Test Notification from Sencho!',
            type: 'info',
            urls: 'discord://token',
          }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns sanitized details on Apprise 204 without leaking secrets', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204 }));
    try {
      const res = await request(app)
        .post('/api/notifications/test')
        .set('Cookie', authCookie)
        .send({ type: 'apprise', url: 'http://apprise.local/notify/secret-key', config: {} });
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).toContain('HTTP 204');
      expect(JSON.stringify(res.body)).not.toContain('secret-key');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
