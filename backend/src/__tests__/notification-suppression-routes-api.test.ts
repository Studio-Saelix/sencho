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

  it('POST accepts history-only category update_started (bell-visible)', async () => {
    const res = await request(app)
      .post('/api/notification-suppression-rules')
      .set('Cookie', authCookie)
      .send({
        name: 'Mute stack updates',
        stack_patterns: [],
        categories: ['update_started'],
        levels: null,
        applies_to: 'both',
        enabled: true,
        expires_at: null,
      });
    expect(res.status).toBe(201);
    expect(res.body.categories).toEqual(['update_started']);
    if (typeof res.body?.id === 'number') {
      DatabaseService.getInstance().deleteNotificationSuppressionRule(res.body.id);
    }
  });

  it('POST accepts routable category image_update_available', async () => {
    const res = await request(app)
      .post('/api/notification-suppression-rules')
      .set('Cookie', authCookie)
      .send({
        name: 'Mute image updates',
        stack_patterns: [],
        categories: ['image_update_available'],
        levels: null,
        applies_to: 'both',
        enabled: true,
        expires_at: null,
      });
    expect(res.status).toBe(201);
    if (typeof res.body?.id === 'number') {
      DatabaseService.getInstance().deleteNotificationSuppressionRule(res.body.id);
    }
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

  it('POST omits stack_patterns to []; rejects malformed and ReDoS patterns', async () => {
    const omitted = await request(app)
      .post('/api/notification-suppression-rules')
      .set('Cookie', authCookie)
      .send({
        name: 'Mute omit',
        applies_to: 'both',
      });
    expect(omitted.status).toBe(201);
    expect(omitted.body.stack_patterns).toEqual([]);
    DatabaseService.getInstance().deleteNotificationSuppressionRule(omitted.body.id);

    const bad = await request(app)
      .post('/api/notification-suppression-rules')
      .set('Cookie', authCookie)
      .send({ ...validBody, name: 'bad', stack_patterns: null });
    expect(bad.status).toBe(400);

    const redos = await request(app)
      .post('/api/notification-suppression-rules')
      .set('Cookie', authCookie)
      .send({ ...validBody, name: 'redos', stack_patterns: ['****'] });
    expect(redos.status).toBe(400);
  });

  it('PUT enabled-only preserves patterns; explicit [] clears', async () => {
    const created = await request(app)
      .post('/api/notification-suppression-rules')
      .set('Cookie', authCookie)
      .send(validBody);
    const id = created.body.id as number;

    const partial = await request(app)
      .put(`/api/notification-suppression-rules/${id}`)
      .set('Cookie', authCookie)
      .send({ enabled: false });
    expect(partial.status).toBe(200);
    expect(partial.body.enabled).toBe(false);
    expect(partial.body.stack_patterns).toEqual(['staging']);
    expect(partial.body.levels).toEqual(['warning']);

    const cleared = await request(app)
      .put(`/api/notification-suppression-rules/${id}`)
      .set('Cookie', authCookie)
      .send({ stack_patterns: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.stack_patterns).toEqual([]);

    DatabaseService.getInstance().deleteNotificationSuppressionRule(id);
  });

  it('replica requires and validates stack_patterns', async () => {
    const jwt = await import('jsonwebtoken');
    const { TEST_JWT_SECRET } = await import('./helpers/testConstants');
    const token = jwt.default.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });

    const missing = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({
        rule: {
          id: 9001,
          name: 'replica',
          applies_to: 'both',
          node_id: null,
          label_ids: null,
          categories: null,
          levels: null,
          enabled: true,
          expires_at: null,
          created_at: 1,
          updated_at: 1,
        },
      });
    expect(missing.status).toBe(400);

    const redos = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({
        rule: {
          id: 9001,
          name: 'replica',
          applies_to: 'both',
          stack_patterns: ['****'],
          node_id: null,
          label_ids: null,
          categories: null,
          levels: null,
          enabled: true,
          expires_at: null,
          created_at: 1,
          updated_at: 1,
        },
      });
    expect(redos.status).toBe(400);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(9001)).toBeUndefined();

    const ok = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({
        rule: {
          id: 9001,
          name: 'replica',
          applies_to: 'both',
          stack_patterns: ['prod-*'],
          node_id: null,
          label_ids: null,
          categories: null,
          levels: null,
          enabled: true,
          expires_at: null,
          created_at: 1,
          updated_at: 1,
        },
      });
    expect(ok.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(9001)?.stack_patterns).toEqual(['prod-*']);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(9001)?.schedule).toBeNull();
    DatabaseService.getInstance().deleteNotificationSuppressionRule(9001);

    const omitSched = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({
        rule: {
          id: 9003,
          name: 'replica-omit-sched',
          applies_to: 'both',
          stack_patterns: [],
          node_id: null,
          label_ids: null,
          categories: null,
          levels: null,
          enabled: true,
          expires_at: null,
          created_at: 1,
          updated_at: 1,
        },
      });
    expect(omitSched.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(9003)?.schedule).toBeNull();
    DatabaseService.getInstance().deleteNotificationSuppressionRule(9003);
  });

  it('schedule: create omit null; PUT preserve; null clear; canonicalize days; reject invalid', async () => {
    const omitted = await request(app)
      .post('/api/notification-suppression-rules')
      .set('Cookie', authCookie)
      .send({ name: 'sched omit', applies_to: 'both' });
    expect(omitted.status).toBe(201);
    expect(omitted.body.schedule).toBeNull();
    const id = omitted.body.id as number;

    const withSched = await request(app)
      .put(`/api/notification-suppression-rules/${id}`)
      .set('Cookie', authCookie)
      .send({
        schedule: { days: [3, 1], start_minute: 60, end_minute: 120, tz: 'UTC' },
      });
    expect(withSched.status).toBe(200);
    expect(withSched.body.schedule).toEqual({
      days: [1, 3],
      start_minute: 60,
      end_minute: 120,
      tz: 'UTC',
    });

    const preserved = await request(app)
      .put(`/api/notification-suppression-rules/${id}`)
      .set('Cookie', authCookie)
      .send({ enabled: false });
    expect(preserved.status).toBe(200);
    expect(preserved.body.schedule).toEqual({
      days: [1, 3],
      start_minute: 60,
      end_minute: 120,
      tz: 'UTC',
    });

    const cleared = await request(app)
      .put(`/api/notification-suppression-rules/${id}`)
      .set('Cookie', authCookie)
      .send({ schedule: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.schedule).toBeNull();

    const bad = await request(app)
      .put(`/api/notification-suppression-rules/${id}`)
      .set('Cookie', authCookie)
      .send({ schedule: { days: [1], start_minute: 10, end_minute: 10, tz: 'UTC' } });
    expect(bad.status).toBe(400);

    DatabaseService.getInstance().deleteNotificationSuppressionRule(id);
  });

  it('replica rejects invalid schedule and accepts valid schedule', async () => {
    const jwt = await import('jsonwebtoken');
    const { TEST_JWT_SECRET } = await import('./helpers/testConstants');
    const token = jwt.default.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });

    const bad = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({
        rule: {
          id: 9002,
          name: 'replica-sched',
          applies_to: 'both',
          stack_patterns: [],
          node_id: null,
          label_ids: null,
          categories: null,
          levels: null,
          enabled: true,
          expires_at: null,
          schedule: { days: [1], start_minute: 0, end_minute: 0, tz: 'UTC' },
          created_at: 1,
          updated_at: 1,
        },
      });
    expect(bad.status).toBe(400);

    const ok = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({
        rule: {
          id: 9002,
          name: 'replica-sched',
          applies_to: 'both',
          stack_patterns: [],
          node_id: null,
          label_ids: null,
          categories: null,
          levels: null,
          enabled: true,
          expires_at: null,
          schedule: { days: [6], start_minute: 1320, end_minute: 120, tz: 'UTC' },
          created_at: 1,
          updated_at: 1,
        },
      });
    expect(ok.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(9002)?.schedule).toEqual({
      days: [6],
      start_minute: 1320,
      end_minute: 120,
      tz: 'UTC',
    });
    DatabaseService.getInstance().deleteNotificationSuppressionRule(9002);
  });
});
