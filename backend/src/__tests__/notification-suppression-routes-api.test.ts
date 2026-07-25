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
          id: 910001,
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
          id: 910001,
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
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(910001)).toBeUndefined();

    const ok = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({
        rule: {
          id: 910001,
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
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(910001)?.stack_patterns).toEqual(['prod-*']);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(910001)?.schedule).toBeNull();
    DatabaseService.getInstance().deleteNotificationSuppressionRule(910001);

    const omitSched = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({
        rule: {
          id: 910003,
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
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(910003)?.schedule).toBeNull();
    DatabaseService.getInstance().deleteNotificationSuppressionRule(910003);
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
          id: 920002,
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
          id: 920002,
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
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(920002)?.schedule).toEqual({
      days: [6],
      start_minute: 1320,
      end_minute: 120,
      tz: 'UTC',
    });
    DatabaseService.getInstance().deleteNotificationSuppressionRule(920002);
  });

  it('replica forces node_id to null regardless of the payload value', async () => {
    const jwt = await import('jsonwebtoken');
    const { TEST_JWT_SECRET } = await import('./helpers/testConstants');
    const token = jwt.default.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });

    const res = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({
        rule: {
          id: 930004,
          name: 'replica-scoped',
          applies_to: 'both',
          stack_patterns: [],
          node_id: 5,
          label_ids: null,
          categories: null,
          levels: null,
          enabled: true,
          expires_at: null,
          created_at: 1,
          updated_at: 1,
        },
      });
    expect(res.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(930004)?.node_id).toBeNull();
    DatabaseService.getInstance().deleteNotificationSuppressionRule(930004);
  });

  it('replica ignores a stale write with an older updated_at than the stored row', async () => {
    const jwt = await import('jsonwebtoken');
    const { TEST_JWT_SECRET } = await import('./helpers/testConstants');
    const token = jwt.default.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const replicaRule = (overrides: Record<string, unknown>) => ({
      id: 940005,
      name: 'replica-race',
      applies_to: 'both',
      stack_patterns: [],
      node_id: null,
      label_ids: null,
      categories: null,
      levels: null,
      enabled: true,
      expires_at: null,
      created_at: 1,
      ...overrides,
    });

    const first = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({ rule: replicaRule({ name: 'v2-newer', updated_at: 2000 }) });
    expect(first.status).toBe(200);

    const stale = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({ rule: replicaRule({ name: 'v1-delayed-stale', updated_at: 1000 }) });
    expect(stale.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(940005)?.name).toBe('v2-newer');

    const tie = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({ rule: replicaRule({ name: 'v2-tie-same-timestamp', updated_at: 2000 }) });
    expect(tie.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(940005)?.name).toBe('v2-newer');

    const newer = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({ rule: replicaRule({ name: 'v3-newest', updated_at: 3000 }) });
    expect(newer.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(940005)?.name).toBe('v3-newest');

    DatabaseService.getInstance().deleteNotificationSuppressionRule(940005);
  });

  it('omitted-body replica DELETE is permanent; delayed POST cannot resurrect', async () => {
    const jwt = await import('jsonwebtoken');
    const { TEST_JWT_SECRET } = await import('./helpers/testConstants');
    const token = jwt.default.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const replicaRule = (overrides: Record<string, unknown>) => ({
      id: 950006,
      name: 'replica-delete-race',
      applies_to: 'both',
      stack_patterns: [],
      node_id: null,
      label_ids: null,
      categories: null,
      levels: null,
      enabled: true,
      expires_at: null,
      created_at: 1,
      ...overrides,
    });

    const first = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({ rule: replicaRule({ updated_at: 1000 }) });
    expect(first.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(950006)).not.toBeUndefined();

    const del = await request(app)
      .delete('/api/notification-suppression-rules/replica/950006')
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(950006)).toBeUndefined();

    // Omitted DELETE body (old hub) fails closed as permanent. A delayed POST
    // with any updated_at must stay blocked.
    const delayed = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({ rule: replicaRule({ updated_at: 2000 }) });
    expect(delayed.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(950006)).toBeUndefined();
  });

  it('replica DELETE tombstones an id even when the remote never had that row', async () => {
    const jwt = await import('jsonwebtoken');
    const { TEST_JWT_SECRET } = await import('./helpers/testConstants');
    const token = jwt.default.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });

    // This remote never received rule 960007 (e.g. it just enrolled, or the rule
    // failed capability probing before its first push). A cleanup DELETE still
    // arrives unconditionally from deleteRuleOnNode. A POST reordered behind it
    // must not be allowed to create the rule for the first time.
    const del = await request(app)
      .delete('/api/notification-suppression-rules/replica/960007')
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(960007)).toBeUndefined();

    const delayed = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({
        rule: {
          id: 960007,
          name: 'replica-delete-before-first-post',
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
    expect(delayed.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(960007)).toBeUndefined();
  });

  it('replica does not resurrect a deleted rule with a schedule', async () => {
    const jwt = await import('jsonwebtoken');
    const { TEST_JWT_SECRET } = await import('./helpers/testConstants');
    const token = jwt.default.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const replicaRule = (overrides: Record<string, unknown>) => ({
      id: 970008,
      name: 'replica-scheduled-delete-race',
      applies_to: 'both',
      stack_patterns: [],
      node_id: null,
      label_ids: null,
      categories: null,
      levels: null,
      enabled: true,
      expires_at: null,
      schedule: { days: [1], start_minute: 120, end_minute: 360, tz: 'UTC' },
      created_at: 1,
      ...overrides,
    });

    const first = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({ rule: replicaRule({ updated_at: 1000 }) });
    expect(first.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(970008)?.schedule).not.toBeNull();

    // Capability-cleanup DELETE is recoverable at the pushed version. A delayed
    // re-push at the same or older watermark must not undo cleanup.
    const del = await request(app)
      .delete('/api/notification-suppression-rules/replica/970008')
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'recoverable', source_updated_at: 1000 });
    expect(del.status).toBe(200);

    const delayed = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({ rule: replicaRule({ updated_at: 1000 }) });
    expect(delayed.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(970008)).toBeUndefined();
    expect(DatabaseService.getInstance().getNotificationSuppressionRuleTombstone(970008)?.kind).toBe(
      'recoverable',
    );
  });

  it('recoverable soft-cleanup allows recreate when hub re-save is newer', async () => {
    const jwt = await import('jsonwebtoken');
    const { TEST_JWT_SECRET } = await import('./helpers/testConstants');
    const replicaRule = (overrides: Record<string, unknown>) => ({
      id: 980009,
      name: 'replica-soft-cleanup-resave',
      applies_to: 'both',
      stack_patterns: [],
      node_id: null,
      label_ids: null,
      categories: null,
      levels: null,
      enabled: true,
      expires_at: null,
      schedule: { days: [2], start_minute: 60, end_minute: 120, tz: 'UTC' },
      created_at: 1,
      ...overrides,
    });

    // Receiver clock skew must not affect ordering. Sign the JWT under the same
    // mocked clock so exp verification stays valid.
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(9_000_000_000_000);
    const token = jwt.default.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1h' });
    try {
      const first = await request(app)
        .post('/api/notification-suppression-rules/replica')
        .set('Authorization', `Bearer ${token}`)
        .send({ rule: replicaRule({ updated_at: 1000 }) });
      expect(first.status).toBe(200);

      const del = await request(app)
        .delete('/api/notification-suppression-rules/replica/980009')
        .set('Authorization', `Bearer ${token}`)
        .send({ kind: 'recoverable', source_updated_at: 1000 });
      expect(del.status).toBe(200);
      expect(DatabaseService.getInstance().getNotificationSuppressionRule(980009)).toBeUndefined();

      const tie = await request(app)
        .post('/api/notification-suppression-rules/replica')
        .set('Authorization', `Bearer ${token}`)
        .send({ rule: replicaRule({ updated_at: 1000 }) });
      expect(tie.status).toBe(200);
      expect(DatabaseService.getInstance().getNotificationSuppressionRule(980009)).toBeUndefined();

      const resave = await request(app)
        .post('/api/notification-suppression-rules/replica')
        .set('Authorization', `Bearer ${token}`)
        .send({ rule: replicaRule({ name: 'replica-soft-cleanup-resave-v2', updated_at: 2000 }) });
      expect(resave.status).toBe(200);
      const restored = DatabaseService.getInstance().getNotificationSuppressionRule(980009);
      expect(restored?.name).toBe('replica-soft-cleanup-resave-v2');
      expect(restored?.updated_at).toBe(2000);
      expect(DatabaseService.getInstance().getNotificationSuppressionRuleTombstone(980009)).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('permanent DELETE blocks any later POST regardless of updated_at', async () => {
    const jwt = await import('jsonwebtoken');
    const { TEST_JWT_SECRET } = await import('./helpers/testConstants');
    const token = jwt.default.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });

    const del = await request(app)
      .delete('/api/notification-suppression-rules/replica/990010')
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'permanent', source_updated_at: 50 });
    expect(del.status).toBe(200);

    const post = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({
        rule: {
          id: 990010,
          name: 'should-not-return',
          applies_to: 'both',
          stack_patterns: [],
          node_id: null,
          label_ids: null,
          categories: null,
          levels: null,
          enabled: true,
          expires_at: null,
          created_at: 1,
          updated_at: Number.MAX_SAFE_INTEGER,
        },
      });
    expect(post.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(990010)).toBeUndefined();
    expect(DatabaseService.getInstance().getNotificationSuppressionRuleTombstone(990010)?.kind).toBe(
      'permanent',
    );
  });

  it('stale recoverable DELETE does not remove a newer stored row', async () => {
    const jwt = await import('jsonwebtoken');
    const { TEST_JWT_SECRET } = await import('./helpers/testConstants');
    const token = jwt.default.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const replicaRule = (overrides: Record<string, unknown>) => ({
      id: 991011,
      name: 'v200',
      applies_to: 'both',
      stack_patterns: [],
      node_id: null,
      label_ids: null,
      categories: null,
      levels: null,
      enabled: true,
      expires_at: null,
      created_at: 1,
      ...overrides,
    });

    const post = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({ rule: replicaRule({ updated_at: 200 }) });
    expect(post.status).toBe(200);

    const del = await request(app)
      .delete('/api/notification-suppression-rules/replica/991011')
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'recoverable', source_updated_at: 100 });
    expect(del.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(991011)?.updated_at).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRuleTombstone(991011)).toBeUndefined();
  });

  it('recoverable DELETE at exact stored version deletes and tombstones', async () => {
    const jwt = await import('jsonwebtoken');
    const { TEST_JWT_SECRET } = await import('./helpers/testConstants');
    const token = jwt.default.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });

    await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({
        rule: {
          id: 992012,
          name: 'exact-tie-delete',
          applies_to: 'both',
          stack_patterns: [],
          node_id: null,
          label_ids: null,
          categories: null,
          levels: null,
          enabled: true,
          expires_at: null,
          created_at: 1,
          updated_at: 150,
        },
      });

    const del = await request(app)
      .delete('/api/notification-suppression-rules/replica/992012')
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'recoverable', source_updated_at: 150 });
    expect(del.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(992012)).toBeUndefined();
    const tomb = DatabaseService.getInstance().getNotificationSuppressionRuleTombstone(992012);
    expect(tomb?.kind).toBe('recoverable');
    expect(tomb?.source_updated_at).toBe(150);
  });

  it('reordered recoverable tombstones keep the max watermark; permanent wins', async () => {
    const jwt = await import('jsonwebtoken');
    const { TEST_JWT_SECRET } = await import('./helpers/testConstants');
    const token = jwt.default.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });

    await request(app)
      .delete('/api/notification-suppression-rules/replica/993013')
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'recoverable', source_updated_at: 200 });
    await request(app)
      .delete('/api/notification-suppression-rules/replica/993013')
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'recoverable', source_updated_at: 100 });
    expect(
      DatabaseService.getInstance().getNotificationSuppressionRuleTombstone(993013)?.source_updated_at,
    ).toBe(200);

    await request(app)
      .delete('/api/notification-suppression-rules/replica/993013')
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'permanent', source_updated_at: 50 });
    const tomb = DatabaseService.getInstance().getNotificationSuppressionRuleTombstone(993013);
    expect(tomb?.kind).toBe('permanent');
    expect(tomb?.source_updated_at).toBe(200);

    // Later recoverable cannot weaken permanent.
    await request(app)
      .delete('/api/notification-suppression-rules/replica/993013')
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'recoverable', source_updated_at: 999 });
    expect(DatabaseService.getInstance().getNotificationSuppressionRuleTombstone(993013)?.kind).toBe(
      'permanent',
    );
  });

  it('partial or invalid DELETE body returns 400 without mutation', async () => {
    const jwt = await import('jsonwebtoken');
    const { TEST_JWT_SECRET } = await import('./helpers/testConstants');
    const token = jwt.default.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });

    await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({
        rule: {
          id: 994014,
          name: 'keep-me',
          applies_to: 'both',
          stack_patterns: [],
          node_id: null,
          label_ids: null,
          categories: null,
          levels: null,
          enabled: true,
          expires_at: null,
          created_at: 1,
          updated_at: 10,
        },
      });

    const cases: object[] = [
      { kind: 'recoverable' },
      { source_updated_at: 1 },
      { kind: 'nope', source_updated_at: 1 },
      { kind: 'recoverable', source_updated_at: 1.5 },
      { kind: 'recoverable', source_updated_at: -1 },
      { kind: 'recoverable', source_updated_at: '1' },
      { kind: 'recoverable', source_updated_at: null },
      { kind: 'recoverable', source_updated_at: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const body of cases) {
      const res = await request(app)
        .delete('/api/notification-suppression-rules/replica/994014')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(400);
    }
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(994014)?.name).toBe('keep-me');
    expect(DatabaseService.getInstance().getNotificationSuppressionRuleTombstone(994014)).toBeUndefined();
  });

  it('replica POST rejects missing or invalid created_at and updated_at', async () => {
    const jwt = await import('jsonwebtoken');
    const { TEST_JWT_SECRET } = await import('./helpers/testConstants');
    const token = jwt.default.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const base = {
      id: 995015,
      name: 'bad-ts',
      applies_to: 'both',
      stack_patterns: [],
      node_id: null,
      label_ids: null,
      categories: null,
      levels: null,
      enabled: true,
      expires_at: null,
    };

    for (const rule of [
      { ...base, updated_at: 1 },
      { ...base, created_at: 1 },
      { ...base, created_at: -1, updated_at: 1 },
      { ...base, created_at: 1, updated_at: 1.5 },
      { ...base, created_at: 1, updated_at: '1' },
    ]) {
      const res = await request(app)
        .post('/api/notification-suppression-rules/replica')
        .set('Authorization', `Bearer ${token}`)
        .send({ rule });
      expect(res.status).toBe(400);
    }
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(995015)).toBeUndefined();
  });

  it('permanent DELETE removes a newer stored row', async () => {
    const jwt = await import('jsonwebtoken');
    const { TEST_JWT_SECRET } = await import('./helpers/testConstants');
    const token = jwt.default.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });

    await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({
        rule: {
          id: 999019,
          name: 'newer-row',
          applies_to: 'both',
          stack_patterns: [],
          node_id: null,
          label_ids: null,
          categories: null,
          levels: null,
          enabled: true,
          expires_at: null,
          created_at: 1,
          updated_at: 200,
        },
      });

    const del = await request(app)
      .delete('/api/notification-suppression-rules/replica/999019')
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'permanent', source_updated_at: 50 });
    expect(del.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(999019)).toBeUndefined();
    expect(DatabaseService.getInstance().getNotificationSuppressionRuleTombstone(999019)?.kind).toBe(
      'permanent',
    );
  });

  it('empty JSON DELETE body fails closed as permanent', async () => {
    const jwt = await import('jsonwebtoken');
    const { TEST_JWT_SECRET } = await import('./helpers/testConstants');
    const token = jwt.default.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });

    const del = await request(app)
      .delete('/api/notification-suppression-rules/replica/999020')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .send({});
    expect(del.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRuleTombstone(999020)?.kind).toBe(
      'permanent',
    );
    expect(
      DatabaseService.getInstance().getNotificationSuppressionRuleTombstone(999020)?.source_updated_at,
    ).toBe(0);
  });

  it('one-arg deleteNotificationSuppressionRule defaults to permanent', () => {
    DatabaseService.getInstance().upsertNotificationSuppressionRuleReplica({
      id: 996016,
      name: 'one-arg',
      applies_to: 'both',
      stack_patterns: [],
      node_id: null,
      label_ids: null,
      categories: null,
      levels: null,
      enabled: true,
      expires_at: null,
      schedule: null,
      scheduleInvalid: false,
      created_at: 1,
      updated_at: 5,
    });
    DatabaseService.getInstance().deleteNotificationSuppressionRule(996016);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(996016)).toBeUndefined();
    expect(DatabaseService.getInstance().getNotificationSuppressionRuleTombstone(996016)?.kind).toBe(
      'permanent',
    );
  });

  it('delete rolls back when tombstone upsert fails', () => {
    const db = DatabaseService.getInstance();
    db.upsertNotificationSuppressionRuleReplica({
      id: 997017,
      name: 'atomic-del',
      applies_to: 'both',
      stack_patterns: [],
      node_id: null,
      label_ids: null,
      categories: null,
      levels: null,
      enabled: true,
      expires_at: null,
      schedule: null,
      scheduleInvalid: false,
      created_at: 1,
      updated_at: 7,
    });
    const raw = db.getDb();
    const orig = raw.prepare.bind(raw);
    const spy = vi.spyOn(raw, 'prepare').mockImplementation(((sql: string) => {
      if (
        typeof sql === 'string' &&
        sql.includes('INSERT INTO notification_suppression_rule_tombstones')
      ) {
        throw new Error('forced tombstone upsert failure');
      }
      return orig(sql);
    }) as typeof raw.prepare);

    expect(() =>
      db.deleteNotificationSuppressionRule(997017, {
        kind: 'recoverable',
        source_updated_at: 7,
      }),
    ).toThrow(/forced tombstone upsert failure/);
    spy.mockRestore();

    expect(db.getNotificationSuppressionRule(997017)?.name).toBe('atomic-del');
    expect(db.getNotificationSuppressionRuleTombstone(997017)).toBeUndefined();
  });

  it('recoverable recreate rolls back when insert fails after tombstone clear attempt', () => {
    const db = DatabaseService.getInstance();
    db.deleteNotificationSuppressionRule(998018, {
      kind: 'recoverable',
      source_updated_at: 10,
    });
    expect(db.getNotificationSuppressionRuleTombstone(998018)?.kind).toBe('recoverable');

    const raw = db.getDb();
    const orig = raw.prepare.bind(raw);
    const spy = vi.spyOn(raw, 'prepare').mockImplementation(((sql: string) => {
      if (
        typeof sql === 'string' &&
        sql.includes('INSERT INTO notification_suppression_rules')
      ) {
        throw new Error('forced replica insert failure');
      }
      return orig(sql);
    }) as typeof raw.prepare);

    expect(() =>
      db.upsertNotificationSuppressionRuleReplica({
        id: 998018,
        name: 'recreate-fail',
        applies_to: 'both',
        stack_patterns: [],
        node_id: null,
        label_ids: null,
        categories: null,
        levels: null,
        enabled: true,
        expires_at: null,
        schedule: null,
        scheduleInvalid: false,
        created_at: 1,
        updated_at: 20,
      }),
    ).toThrow(/forced replica insert failure/);
    spy.mockRestore();

    expect(db.getNotificationSuppressionRule(998018)).toBeUndefined();
    expect(db.getNotificationSuppressionRuleTombstone(998018)?.kind).toBe('recoverable');
    expect(db.getNotificationSuppressionRuleTombstone(998018)?.source_updated_at).toBe(10);
  });
});
