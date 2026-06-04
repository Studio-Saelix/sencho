/**
 * Integration tests for Alert CRUD endpoints, notification test dispatch
 * validation, and auth enforcement on all alert/notification routes.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let authCookie: string;
let viewerCookie: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));

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
    db.addStackAlert({ stack_name: 'web', metric: 'cpu_percent', operator: '>', threshold: 80, duration_mins: 5, cooldown_mins: 60 });
    db.addStackAlert({ stack_name: 'api', metric: 'memory_percent', operator: '>', threshold: 90, duration_mins: 5, cooldown_mins: 60 });

    const res = await request(app)
      .get('/api/alerts?stackName=web')
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].stack_name).toBe('web');
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

  it('rejects non-admin users with 403', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .set('Cookie', viewerCookie)
      .send({ stack_name: 'test', metric: 'cpu_percent', operator: '>', threshold: 80, duration_mins: 5, cooldown_mins: 60 });
    expect(res.status).toBe(403);
  });

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
    expect(res.body.metric).toBe('memory_percent');
    expect(res.body.threshold).toBe(85);
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

  it('rejects non-admin users with 403', async () => {
    const res = await request(app)
      .delete('/api/alerts/1')
      .set('Cookie', viewerCookie);
    expect(res.status).toBe(403);
  });

  it('deletes existing alert rule', async () => {
    // Create an alert to delete
    const created = DatabaseService.getInstance().addStackAlert({
      stack_name: 'delete-me',
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
    expect(res.body.error).toContain('discord, slack, webhook');
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
});
