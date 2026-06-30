/**
 * Integration tests for notification suppression rules CRUD.
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

const validBody = {
  name: 'Mute staging',
  stack_patterns: ['staging'],
  categories: ['monitor_alert'],
  levels: ['warning'],
  applies_to: 'both',
  enabled: true,
  expires_at: null,
};

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));

  const { LicenseService } = await import('../services/LicenseService');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');

  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);

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

describe('Notification suppression - auth enforcement', () => {
  it('GET returns 401 without auth', async () => {
    const res = await request(app).get('/api/notification-suppression-rules');
    expect(res.status).toBe(401);
  });

  it('GET returns 403 for viewer', async () => {
    const res = await request(app)
      .get('/api/notification-suppression-rules')
      .set('Cookie', viewerCookie);
    expect(res.status).toBe(403);
  });

  it('POST returns 403 for viewer', async () => {
    const res = await request(app)
      .post('/api/notification-suppression-rules')
      .set('Cookie', viewerCookie)
      .send(validBody);
    expect(res.status).toBe(403);
  });
});

describe('Notification suppression - CRUD', () => {
  it('POST creates a rule on Community tier', async () => {
    const res = await request(app)
      .post('/api/notification-suppression-rules')
      .set('Cookie', authCookie)
      .send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Mute staging');
    expect(res.body.applies_to).toBe('both');
    if (typeof res.body?.id === 'number') {
      DatabaseService.getInstance().deleteNotificationSuppressionRule(res.body.id);
    }
  });

  it('GET lists rules', async () => {
    const res = await request(app)
      .get('/api/notification-suppression-rules')
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST rejects invalid applies_to', async () => {
    const res = await request(app)
      .post('/api/notification-suppression-rules')
      .set('Cookie', authCookie)
      .send({ ...validBody, applies_to: 'invalid' });
    expect(res.status).toBe(400);
  });

  it('POST rejects invalid levels', async () => {
    const res = await request(app)
      .post('/api/notification-suppression-rules')
      .set('Cookie', authCookie)
      .send({ ...validBody, levels: ['critical'] });
    expect(res.status).toBe(400);
  });

  it('PUT updates a rule', async () => {
    const created = await request(app)
      .post('/api/notification-suppression-rules')
      .set('Cookie', authCookie)
      .send(validBody);
    const id = created.body.id as number;

    const res = await request(app)
      .put(`/api/notification-suppression-rules/${id}`)
      .set('Cookie', authCookie)
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);

    DatabaseService.getInstance().deleteNotificationSuppressionRule(id);
  });

  it('DELETE removes a rule', async () => {
    const created = await request(app)
      .post('/api/notification-suppression-rules')
      .set('Cookie', authCookie)
      .send(validBody);
    const id = created.body.id as number;

    const res = await request(app)
      .delete(`/api/notification-suppression-rules/${id}`)
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
  });
});
