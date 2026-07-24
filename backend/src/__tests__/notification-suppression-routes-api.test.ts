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

  it('replica does not resurrect a rule after it was deleted, even with a newer updated_at', async () => {
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

    // A delayed POST arrives after the DELETE, reordered by the network. Even
    // though its updated_at is newer than anything the sender ever sent before
    // the delete, it is still older than deleted_at (wall-clock at DELETE time),
    // so the tombstone must keep this id gone.
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

    // This is the worst case the fix protects: a capability-cleanup DELETE
    // retracts an all-day/scheduled mute from a node that stopped supporting
    // it. A delayed re-push of the scheduled rule must not undo that cleanup.
    const del = await request(app)
      .delete('/api/notification-suppression-rules/replica/970008')
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(200);

    const delayed = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({ rule: replicaRule({ updated_at: 2000 }) });
    expect(delayed.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(970008)).toBeUndefined();
  });

  it('replica recreates after soft-cleanup when hub re-save is newer than tombstone', async () => {
    const jwt = await import('jsonwebtoken');
    const { TEST_JWT_SECRET } = await import('./helpers/testConstants');
    const token = jwt.default.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
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

    const first = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({ rule: replicaRule({ updated_at: Date.now() - 60_000 }) });
    expect(first.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(980009)).not.toBeUndefined();

    // Soft cleanup DELETE (capability unsupported-or-unreachable / corrupt schedule)
    // tombstones the id. A later hub re-save must recreate once updated_at is newer.
    const del = await request(app)
      .delete('/api/notification-suppression-rules/replica/980009')
      .set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(980009)).toBeUndefined();

    const resaveAt = Date.now() + 1_000;
    const resave = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({ rule: replicaRule({ name: 'replica-soft-cleanup-resave-v2', updated_at: resaveAt }) });
    expect(resave.status).toBe(200);
    const restored = DatabaseService.getInstance().getNotificationSuppressionRule(980009);
    expect(restored).not.toBeUndefined();
    expect(restored?.name).toBe('replica-soft-cleanup-resave-v2');
    expect(restored?.updated_at).toBe(resaveAt);
    expect(restored?.schedule).not.toBeNull();
  });

  it('replica refuses a post-delete write whose updated_at ties the tombstone', async () => {
    const jwt = await import('jsonwebtoken');
    const { TEST_JWT_SECRET } = await import('./helpers/testConstants');
    const token = jwt.default.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });

    const deletedAt = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(deletedAt);
    try {
      const del = await request(app)
        .delete('/api/notification-suppression-rules/replica/990010')
        .set('Authorization', `Bearer ${token}`);
      expect(del.status).toBe(200);
    } finally {
      nowSpy.mockRestore();
    }

    const tie = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({
        rule: {
          id: 990010,
          name: 'replica-tombstone-tie',
          applies_to: 'both',
          stack_patterns: [],
          node_id: null,
          label_ids: null,
          categories: null,
          levels: null,
          enabled: true,
          expires_at: null,
          created_at: 1,
          updated_at: deletedAt,
        },
      });
    expect(tie.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(990010)).toBeUndefined();

    const newer = await request(app)
      .post('/api/notification-suppression-rules/replica')
      .set('Authorization', `Bearer ${token}`)
      .send({
        rule: {
          id: 990010,
          name: 'replica-tombstone-newer',
          applies_to: 'both',
          stack_patterns: [],
          node_id: null,
          label_ids: null,
          categories: null,
          levels: null,
          enabled: true,
          expires_at: null,
          created_at: 1,
          updated_at: deletedAt + 1,
        },
      });
    expect(newer.status).toBe(200);
    expect(DatabaseService.getInstance().getNotificationSuppressionRule(990010)?.name).toBe(
      'replica-tombstone-newer',
    );
  });
});
