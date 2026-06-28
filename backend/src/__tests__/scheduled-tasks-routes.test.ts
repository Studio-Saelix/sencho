/**
 * Integration tests for /api/scheduled-tasks. Locks down auth, tier gates,
 * validation, and the list/create/get/update/toggle/run/delete lifecycle
 * before extraction.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let adminCookie: string;
let viewerCookie: string;
let tierSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));

  const { LicenseService } = await import('../services/LicenseService');
  tierSpy = vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');

  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);

  const viewerHash = await bcrypt.hash('viewerpass', 1);
  DatabaseService.getInstance().addUser({ username: 'sched-viewer', password_hash: viewerHash, role: 'viewer' });
  const viewerRes = await request(app).post('/api/auth/login').send({ username: 'sched-viewer', password: 'viewerpass' });
  const cookies = viewerRes.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  // Start each test with an empty scheduled_tasks table.
  const db = DatabaseService.getInstance().getDb();
  db.prepare('DELETE FROM scheduled_tasks').run();
  tierSpy.mockReturnValue('paid');
});

describe('GET /api/scheduled-tasks', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/scheduled-tasks');
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users with 403', async () => {
    const res = await request(app).get('/api/scheduled-tasks').set('Cookie', viewerCookie);
    expect(res.status).toBe(403);
  });

  it('returns an empty array when no tasks exist', async () => {
    const res = await request(app).get('/api/scheduled-tasks').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('enriches each task with computed next_runs inside the window', async () => {
    const db = DatabaseService.getInstance();
    const now = Date.now();
    db.createScheduledTask({
      name: 'nightly-scan',
      target_type: 'system',
      target_id: null,
      node_id: 1,
      action: 'scan',
      cron_expression: '0 0 * * *',
      enabled: 1,
      created_by: 'admin',
      created_at: now,
      updated_at: now,
      last_run_at: null,
      next_run_at: now + 3600_000,
      last_status: null,
      last_error: null,
      prune_targets: null,
      target_services: null,
      prune_label_filter: null,
    });

    const res = await request(app).get('/api/scheduled-tasks?window_hours=48').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe('nightly-scan');
    expect(Array.isArray(res.body[0].next_runs)).toBe(true);
  });

  it('shows every action to admins', async () => {
    const db = DatabaseService.getInstance();
    const now = Date.now();
    db.createScheduledTask({
      name: 'nightly-scan',
      target_type: 'system',
      target_id: null,
      node_id: 1,
      action: 'scan',
      cron_expression: '0 0 * * *',
      enabled: 1,
      created_by: 'admin',
      created_at: now,
      updated_at: now,
      last_run_at: null,
      next_run_at: null,
      last_status: null,
      last_error: null,
      prune_targets: null,
      target_services: null,
      prune_label_filter: null,
    });
    db.createScheduledTask({
      name: 'daily-snapshot',
      target_type: 'fleet',
      target_id: null,
      node_id: 1,
      action: 'snapshot',
      cron_expression: '0 1 * * *',
      enabled: 1,
      created_by: 'admin',
      created_at: now,
      updated_at: now,
      last_run_at: null,
      next_run_at: null,
      last_status: null,
      last_error: null,
      prune_targets: null,
      target_services: null,
      prune_label_filter: null,
    });
    db.createScheduledTask({
      name: 'system-prune',
      target_type: 'system',
      target_id: null,
      node_id: 1,
      action: 'prune',
      cron_expression: '0 2 * * *',
      enabled: 1,
      created_by: 'admin',
      created_at: now,
      updated_at: now,
      last_run_at: null,
      next_run_at: null,
      last_status: null,
      last_error: null,
      prune_targets: JSON.stringify(['images']),
      target_services: null,
      prune_label_filter: null,
    });

    const res = await request(app).get('/api/scheduled-tasks').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.map((t: { action: string }) => t.action).sort()).toEqual(['prune', 'scan', 'snapshot']);
  });
});

describe('POST /api/scheduled-tasks', () => {
  const basePayload = {
    name: 'daily-update',
    target_type: 'stack',
    target_id: 'my-stack',
    node_id: 1,
    action: 'update',
    cron_expression: '0 3 * * *',
    enabled: true,
  };

  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).post('/api/scheduled-tasks').send(basePayload);
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users with 403', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', viewerCookie).send(basePayload);
    expect(res.status).toBe(403);
  });

  it('creates a task and returns the new record', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send(basePayload);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('daily-update');
    expect(res.body.action).toBe('update');
    expect(res.body.enabled).toBe(1);
  });

  it('rejects an invalid cron expression with 400', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      ...basePayload, cron_expression: 'this is not cron',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid cron expression/);
  });

  it('rejects a 6-field cron expression with the seconds field', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      ...basePayload, cron_expression: '30 0 3 * * *',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/5 fields/);
  });

  it('rejects a missing cron expression with a clear message', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      ...basePayload, cron_expression: undefined,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
  });

  it('rejects an empty cron expression with a clear message', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      ...basePayload, cron_expression: '',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
  });

  it('accepts a cron nickname such as @daily', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      ...basePayload, cron_expression: '@daily',
    });
    expect(res.status).toBe(201);
    expect(res.body.cron_expression).toBe('@daily');
  });

  it('pins next_run_at to an explicit one-shot run_at instead of the cron-derived next run', async () => {
    // A one-shot for next year: the cron (0 23 1 7 *) would otherwise resolve to
    // this year's occurrence. run_at must win so the task fires on the chosen year.
    const runAt = new Date(new Date().getFullYear() + 1, 6, 1, 23, 0, 0, 0).getTime();
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      ...basePayload, cron_expression: '0 23 1 7 *', delete_after_run: true, run_at: runAt,
    });
    expect(res.status).toBe(201);
    expect(res.body.next_run_at).toBe(runAt);
    // run_at is persisted in its own column so it survives disable/enable and edit.
    expect(res.body.run_at).toBe(runAt);
  });

  it('falls back to the cron-derived next run when no run_at is supplied', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      ...basePayload, cron_expression: '0 3 * * *',
    });
    expect(res.status).toBe(201);
    // Cron-derived next run is some future instant, not pinned to a passed timestamp.
    expect(typeof res.body.next_run_at).toBe('number');
    expect(res.body.next_run_at).toBeGreaterThan(Date.now());
  });

  it('rejects a run_at in the past with 400', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      ...basePayload, cron_expression: '0 23 1 7 *', delete_after_run: true, run_at: Date.now() - 60_000,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/run_at must be in the future/);
  });

  it('rejects a non-numeric run_at with 400', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      ...basePayload, cron_expression: '0 23 1 7 *', run_at: '2027-07-01',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/run_at must be an epoch-millisecond timestamp/);
  });

  it('rejects a fractional run_at with 400 (must be an integer epoch-ms)', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      ...basePayload, cron_expression: '0 23 1 7 *', run_at: Date.now() + 100000.5,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/run_at must be an epoch-millisecond timestamp/);
  });

  it('persists a disabled one-shot run_at (next_run_at null) so enabling restores the chosen instant', async () => {
    const runAt = new Date(new Date().getFullYear() + 1, 6, 1, 23, 0, 0, 0).getTime();
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      ...basePayload, enabled: false, cron_expression: '0 23 1 7 *', delete_after_run: true, run_at: runAt,
    });
    expect(res.status).toBe(201);
    // A disabled task does not schedule, but the pinned instant is retained.
    expect(res.body.next_run_at).toBeNull();
    expect(res.body.run_at).toBe(runAt);

    // Enabling it must restore the exact chosen instant, not the cron's annual occurrence.
    const on = await request(app).patch(`/api/scheduled-tasks/${res.body.id}/toggle`).set('Cookie', adminCookie);
    expect(on.status).toBe(200);
    expect(on.body.enabled).toBe(1);
    expect(on.body.next_run_at).toBe(runAt);
  });

  it('rejects unsupported actions', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      ...basePayload, action: 'nuke',
    });
    expect(res.status).toBe(400);
  });

  it('rejects action/target_type mismatches', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      ...basePayload, action: 'snapshot', target_type: 'stack',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Snapshot action requires target_type "fleet"/);
  });

  it('rejects scan without node_id', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      name: 'nightly-scan', target_type: 'system', action: 'scan', cron_expression: '0 0 * * *',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Scan action requires node_id/);
  });

  for (const badNodeId of [true, '1.5', 0]) {
    it(`rejects scan with malformed node_id ${JSON.stringify(badNodeId)}`, async () => {
      const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
        name: 'bad-scan-node',
        target_type: 'system',
        node_id: badNodeId,
        action: 'scan',
        cron_expression: '0 0 * * *',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/valid node_id|node_id/);
    });
  }

  for (const badNodeId of [true, '1.5', 0]) {
    it(`rejects fleet update with malformed node_id ${JSON.stringify(badNodeId)}`, async () => {
      const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
        name: 'bad-fleet-update-node',
        target_type: 'fleet',
        node_id: badNodeId,
        action: 'update',
        cron_expression: '0 0 * * *',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/valid node_id|node_id/);
    });
  }

  it('rejects scheduled scans on remote nodes', async () => {
    const remoteNodeId = DatabaseService.getInstance().addNode({
      name: 'remote-scan-node',
      type: 'remote',
      api_url: 'http://remote.local:1852',
      api_token: 'token',
      compose_dir: '/srv/compose',
      is_default: false,
    });

    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      name: 'remote-scan',
      target_type: 'system',
      node_id: remoteNodeId,
      action: 'scan',
      cron_expression: '0 0 * * *',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/local node/i);
  });

  it('rejects prune without node_id', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      name: 'cleanup', target_type: 'system', action: 'prune', cron_expression: '0 4 * * *',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Prune action requires node_id/);
  });

  it('rejects scheduled prunes on remote nodes', async () => {
    const remoteNodeId = DatabaseService.getInstance().addNode({
      name: 'remote-prune-node',
      type: 'remote',
      api_url: 'http://remote.local:1852',
      api_token: 'token',
      compose_dir: '/srv/compose',
      is_default: false,
    });

    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      name: 'remote-prune',
      target_type: 'system',
      node_id: remoteNodeId,
      action: 'prune',
      cron_expression: '0 4 * * *',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/local node/i);
  });

  it('creates a prune task on a local node', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      name: 'local-prune', target_type: 'system', node_id: 1, action: 'prune',
      cron_expression: '0 4 * * *', enabled: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.action).toBe('prune');
    expect(res.body.node_id).toBe(1);
  });

  it('rejects target_services with wrong action', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      ...basePayload, action: 'update', target_services: ['web'],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/target_services can only be used with restart/);
  });

  it('rejects invalid stack target_id values', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      ...basePayload, target_id: '../etc/passwd',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid stack name/);
  });

  it('rejects stack target_id values with surrounding whitespace', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      ...basePayload, target_id: ' my-stack ',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid stack name/);
  });

  it('rejects invalid stack node_id values', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      ...basePayload, node_id: 'not-a-node',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid node_id/);
  });
});

describe('GET /api/scheduled-tasks/:id', () => {
  let taskId: number;
  beforeEach(() => {
    const now = Date.now();
    taskId = DatabaseService.getInstance().createScheduledTask({
      name: 't', target_type: 'stack', target_id: 's', node_id: 1, action: 'update',
      cron_expression: '0 3 * * *', enabled: 1, created_by: 'admin', created_at: now, updated_at: now,
      last_run_at: null, next_run_at: null, last_status: null, last_error: null,
      prune_targets: null, target_services: null, prune_label_filter: null,
    });
  });

  it('returns 404 for missing task', async () => {
    const res = await request(app).get('/api/scheduled-tasks/99999').set('Cookie', adminCookie);
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid id', async () => {
    const res = await request(app).get('/api/scheduled-tasks/not-a-number').set('Cookie', adminCookie);
    expect(res.status).toBe(400);
  });

  it('returns the task for admin', async () => {
    const res = await request(app).get(`/api/scheduled-tasks/${taskId}`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(taskId);
  });
});

describe('PATCH /api/scheduled-tasks/:id/toggle', () => {
  it('flips the enabled flag and recomputes next_run_at', async () => {
    const now = Date.now();
    const id = DatabaseService.getInstance().createScheduledTask({
      name: 't', target_type: 'stack', target_id: 's', node_id: 1, action: 'update',
      cron_expression: '0 3 * * *', enabled: 1, created_by: 'admin', created_at: now, updated_at: now,
      last_run_at: null, next_run_at: now + 1000, last_status: null, last_error: null,
      prune_targets: null, target_services: null, prune_label_filter: null,
    });

    const off = await request(app).patch(`/api/scheduled-tasks/${id}/toggle`).set('Cookie', adminCookie);
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(0);
    expect(off.body.next_run_at).toBeNull();

    const on = await request(app).patch(`/api/scheduled-tasks/${id}/toggle`).set('Cookie', adminCookie);
    expect(on.status).toBe(200);
    expect(on.body.enabled).toBe(1);
    expect(typeof on.body.next_run_at).toBe('number');
  });

  it('preserves a one-shot pinned run_at across a disable/enable cycle', async () => {
    const now = Date.now();
    // A one-shot pinned to next year (its yearless cron would resolve to this year).
    const pinned = new Date(new Date().getFullYear() + 1, 6, 1, 23, 0, 0, 0).getTime();
    const id = DatabaseService.getInstance().createScheduledTask({
      name: 'once', target_type: 'stack', target_id: 's', node_id: 1, action: 'auto_backup',
      cron_expression: '0 23 1 7 *', enabled: 1, created_by: 'admin', created_at: now, updated_at: now,
      last_run_at: null, next_run_at: pinned, last_status: null, last_error: null,
      prune_targets: null, target_services: null, prune_label_filter: null, delete_after_run: 1, run_at: pinned,
    });

    const off = await request(app).patch(`/api/scheduled-tasks/${id}/toggle`).set('Cookie', adminCookie);
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(0);
    // Disabling clears next_run_at, but the run_at column retains the instant.
    expect(off.body.next_run_at).toBeNull();
    expect(off.body.run_at).toBe(pinned);

    const on = await request(app).patch(`/api/scheduled-tasks/${id}/toggle`).set('Cookie', adminCookie);
    expect(on.status).toBe(200);
    expect(on.body.enabled).toBe(1);
    // Re-enable restores the exact chosen instant, not the cron's annual occurrence.
    expect(on.body.next_run_at).toBe(pinned);
  });
});

describe('DELETE /api/scheduled-tasks/:id', () => {
  it('deletes the task and subsequent GET returns 404', async () => {
    const now = Date.now();
    const id = DatabaseService.getInstance().createScheduledTask({
      name: 't', target_type: 'stack', target_id: 's', node_id: 1, action: 'update',
      cron_expression: '0 3 * * *', enabled: 1, created_by: 'admin', created_at: now, updated_at: now,
      last_run_at: null, next_run_at: null, last_status: null, last_error: null,
      prune_targets: null, target_services: null, prune_label_filter: null,
    });

    const del = await request(app).delete(`/api/scheduled-tasks/${id}`).set('Cookie', adminCookie);
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);

    const get = await request(app).get(`/api/scheduled-tasks/${id}`).set('Cookie', adminCookie);
    expect(get.status).toBe(404);
  });
});

describe('GET /api/scheduled-tasks/:id/runs', () => {
  it('returns paginated run history', async () => {
    const now = Date.now();
    const id = DatabaseService.getInstance().createScheduledTask({
      name: 't', target_type: 'stack', target_id: 's', node_id: 1, action: 'update',
      cron_expression: '0 3 * * *', enabled: 1, created_by: 'admin', created_at: now, updated_at: now,
      last_run_at: null, next_run_at: null, last_status: null, last_error: null,
      prune_targets: null, target_services: null, prune_label_filter: null,
    });

    const res = await request(app).get(`/api/scheduled-tasks/${id}/runs`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('runs');
  });
});

describe('POST /api/scheduled-tasks - new lifecycle actions', () => {
  const stackPayload = (action: string) => ({
    name: `test-${action}`,
    target_type: 'stack',
    target_id: 'my-stack',
    node_id: 1,
    action,
    cron_expression: '0 3 * * *',
    enabled: true,
  });

  for (const action of ['auto_backup', 'auto_stop', 'auto_down', 'auto_start']) {
    it(`creates ${action} task successfully (Admiral)`, async () => {
      const res = await request(app)
        .post('/api/scheduled-tasks')
        .set('Cookie', adminCookie)
        .send(stackPayload(action));
      expect(res.status).toBe(201);
      expect(res.body.action).toBe(action);
      expect(res.body.target_type).toBe('stack');
    });

    it(`rejects ${action} with target_type "system"`, async () => {
      const res = await request(app)
        .post('/api/scheduled-tasks')
        .set('Cookie', adminCookie)
        .send({ ...stackPayload(action), target_type: 'system', target_id: null });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/target_type "stack"/);
    });
  }

  it('persists delete_after_run flag', async () => {
    const res = await request(app)
      .post('/api/scheduled-tasks')
      .set('Cookie', adminCookie)
      .send({ ...stackPayload('auto_backup'), delete_after_run: true });
    expect(res.status).toBe(201);
    expect(res.body.delete_after_run).toBe(1);
  });

  it('defaults delete_after_run to 0 when not provided', async () => {
    const res = await request(app)
      .post('/api/scheduled-tasks')
      .set('Cookie', adminCookie)
      .send(stackPayload('auto_stop'));
    expect(res.status).toBe(201);
    expect(res.body.delete_after_run).toBe(0);
  });
});

describe('POST /api/scheduled-tasks - available on the Community tier', () => {
  beforeEach(() => {
    tierSpy.mockReturnValue('community');
  });

  it('allows Community admins to create update tasks', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      name: 'community-update', target_type: 'stack', target_id: 'my-stack', node_id: 1,
      action: 'update', cron_expression: '0 3 * * *', enabled: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.action).toBe('update');
  });

  it('allows Community admins to create scan tasks', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      name: 'community-scan', target_type: 'system', node_id: 1,
      action: 'scan', cron_expression: '0 0 * * *', enabled: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.action).toBe('scan');
  });

  it('allows Community admins to create snapshot tasks', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      name: 'community-snapshot', target_type: 'fleet', node_id: 1,
      action: 'snapshot', cron_expression: '0 1 * * *', enabled: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.action).toBe('snapshot');
  });

  for (const action of ['restart', 'auto_backup', 'auto_stop', 'auto_down', 'auto_start']) {
    it(`allows Community admins to create ${action} tasks`, async () => {
      const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
        name: `community-${action}`, target_type: 'stack', target_id: 'my-stack', node_id: 1,
        action, cron_expression: '0 3 * * *', enabled: true,
      });
      expect(res.status).toBe(201);
      expect(res.body.action).toBe(action);
    });
  }

  it('allows Community admins to create prune tasks', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send({
      name: 'community-prune', target_type: 'system', node_id: 1,
      action: 'prune', cron_expression: '0 4 * * *', enabled: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.action).toBe('prune');
  });
});

describe('PUT /api/scheduled-tasks/:id - delete_after_run', () => {
  it('can toggle delete_after_run via update', async () => {
    const now = Date.now();
    const id = DatabaseService.getInstance().createScheduledTask({
      name: 't', target_type: 'stack', target_id: 's', node_id: 1, action: 'auto_backup',
      cron_expression: '0 3 * * *', enabled: 1, created_by: 'admin', created_at: now, updated_at: now,
      last_run_at: null, next_run_at: null, last_status: null, last_error: null,
      prune_targets: null, target_services: null, prune_label_filter: null, delete_after_run: 0,
    });

    const res = await request(app)
      .put(`/api/scheduled-tasks/${id}`)
      .set('Cookie', adminCookie)
      .send({ delete_after_run: true });
    expect(res.status).toBe(200);
    expect(res.body.delete_after_run).toBe(1);

    const res2 = await request(app)
      .put(`/api/scheduled-tasks/${id}`)
      .set('Cookie', adminCookie)
      .send({ delete_after_run: false });
    expect(res2.status).toBe(200);
    expect(res2.body.delete_after_run).toBe(0);
  });

  it('pins next_run_at to a re-supplied one-shot run_at on update', async () => {
    const now = Date.now();
    const id = DatabaseService.getInstance().createScheduledTask({
      name: 'once', target_type: 'stack', target_id: 's', node_id: 1, action: 'auto_backup',
      cron_expression: '0 23 1 7 *', enabled: 1, created_by: 'admin', created_at: now, updated_at: now,
      last_run_at: null, next_run_at: now + 1000, last_status: null, last_error: null,
      prune_targets: null, target_services: null, prune_label_filter: null, delete_after_run: 1,
    });

    const runAt = new Date(new Date().getFullYear() + 1, 6, 1, 23, 0, 0, 0).getTime();
    const res = await request(app)
      .put(`/api/scheduled-tasks/${id}`)
      .set('Cookie', adminCookie)
      .send({ cron_expression: '0 23 1 7 *', run_at: runAt });
    expect(res.status).toBe(200);
    expect(res.body.next_run_at).toBe(runAt);
    // The column is persisted too, so a later disable/enable restores it.
    expect(res.body.run_at).toBe(runAt);
  });

  it('clears run_at when an update switches a one-shot to a recurring schedule', async () => {
    const now = Date.now();
    const pinned = new Date(new Date().getFullYear() + 1, 6, 1, 23, 0, 0, 0).getTime();
    const id = DatabaseService.getInstance().createScheduledTask({
      name: 'once', target_type: 'stack', target_id: 's', node_id: 1, action: 'auto_backup',
      cron_expression: '0 23 1 7 *', enabled: 1, created_by: 'admin', created_at: now, updated_at: now,
      last_run_at: null, next_run_at: pinned, last_status: null, last_error: null,
      prune_targets: null, target_services: null, prune_label_filter: null, delete_after_run: 1, run_at: pinned,
    });

    // Editing to a recurring daily schedule sends run_at: null (the frontend
    // sends null for every non-once shape). The pin must be cleared and
    // next_run_at recomputed from the cron, not left on the stale instant.
    const res = await request(app)
      .put(`/api/scheduled-tasks/${id}`)
      .set('Cookie', adminCookie)
      .send({ cron_expression: '0 3 * * *', delete_after_run: false, run_at: null });
    expect(res.status).toBe(200);
    expect(res.body.run_at).toBeNull();
    expect(res.body.next_run_at).not.toBe(pinned);
    expect(res.body.next_run_at).toBeGreaterThan(Date.now());
  });

  it('keeps a one-shot run_at persisted when an update disables it', async () => {
    const now = Date.now();
    const pinned = new Date(new Date().getFullYear() + 1, 6, 1, 23, 0, 0, 0).getTime();
    const id = DatabaseService.getInstance().createScheduledTask({
      name: 'once', target_type: 'stack', target_id: 's', node_id: 1, action: 'auto_backup',
      cron_expression: '0 23 1 7 *', enabled: 1, created_by: 'admin', created_at: now, updated_at: now,
      last_run_at: null, next_run_at: pinned, last_status: null, last_error: null,
      prune_targets: null, target_services: null, prune_label_filter: null, delete_after_run: 1, run_at: pinned,
    });

    // Disabling via Save: next_run_at clears, but the pinned instant is retained
    // so re-enabling later restores the exact date.
    const res = await request(app)
      .put(`/api/scheduled-tasks/${id}`)
      .set('Cookie', adminCookie)
      .send({ enabled: false, run_at: pinned });
    expect(res.status).toBe(200);
    expect(res.body.next_run_at).toBeNull();
    expect(res.body.run_at).toBe(pinned);
  });

  it('rejects an update with a past run_at', async () => {
    const now = Date.now();
    const id = DatabaseService.getInstance().createScheduledTask({
      name: 'once', target_type: 'stack', target_id: 's', node_id: 1, action: 'auto_backup',
      cron_expression: '0 23 1 7 *', enabled: 1, created_by: 'admin', created_at: now, updated_at: now,
      last_run_at: null, next_run_at: now + 1000, last_status: null, last_error: null,
      prune_targets: null, target_services: null, prune_label_filter: null, delete_after_run: 1,
    });

    const res = await request(app)
      .put(`/api/scheduled-tasks/${id}`)
      .set('Cookie', adminCookie)
      .send({ run_at: Date.now() - 60_000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/run_at must be in the future/);
  });
});

describe('PUT /api/scheduled-tasks/:id - stack target validation', () => {
  let taskId: number;

  beforeEach(() => {
    const now = Date.now();
    taskId = DatabaseService.getInstance().createScheduledTask({
      name: 't', target_type: 'stack', target_id: 's', node_id: 1, action: 'update',
      cron_expression: '0 3 * * *', enabled: 1, created_by: 'admin', created_at: now, updated_at: now,
      last_run_at: null, next_run_at: null, last_status: null, last_error: null,
      prune_targets: null, target_services: null, prune_label_filter: null, delete_after_run: 0,
    });
  });

  it('rejects updates that introduce path traversal in stack target_id', async () => {
    const res = await request(app)
      .put(`/api/scheduled-tasks/${taskId}`)
      .set('Cookie', adminCookie)
      .send({ target_id: '../bad' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid stack name/);
  });

  it('rejects updates that introduce whitespace in stack target_id', async () => {
    const res = await request(app)
      .put(`/api/scheduled-tasks/${taskId}`)
      .set('Cookie', adminCookie)
      .send({ target_id: ' s ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid stack name/);
  });

  it('rejects updates that clear node_id for a stack target', async () => {
    const res = await request(app)
      .put(`/api/scheduled-tasks/${taskId}`)
      .set('Cookie', adminCookie)
      .send({ node_id: null });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/node_id/);
  });

  it('rejects updates that clear node_id on a prune task', async () => {
    const db = DatabaseService.getInstance();
    const now = Date.now();
    const pruneId = db.createScheduledTask({
      name: 'prune', target_type: 'system', target_id: null, node_id: 1, action: 'prune',
      cron_expression: '0 4 * * *', enabled: 1, created_by: 'admin', created_at: now, updated_at: now,
      last_run_at: null, next_run_at: null, last_status: null, last_error: null,
      prune_targets: null, target_services: null, prune_label_filter: null,
    });

    const res = await request(app)
      .put(`/api/scheduled-tasks/${pruneId}`)
      .set('Cookie', adminCookie)
      .send({ node_id: null });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Prune action requires node_id/);
  });

  it('rejects updates that point a prune task at a remote node', async () => {
    const db = DatabaseService.getInstance();
    const now = Date.now();
    const pruneId = db.createScheduledTask({
      name: 'prune', target_type: 'system', target_id: null, node_id: 1, action: 'prune',
      cron_expression: '0 4 * * *', enabled: 1, created_by: 'admin', created_at: now, updated_at: now,
      last_run_at: null, next_run_at: null, last_status: null, last_error: null,
      prune_targets: null, target_services: null, prune_label_filter: null,
    });
    const remoteNodeId = db.addNode({
      name: 'remote-prune-update-node', type: 'remote', api_url: 'http://remote.local:1852',
      api_token: 'token', compose_dir: '/srv/compose', is_default: false,
    });

    const res = await request(app)
      .put(`/api/scheduled-tasks/${pruneId}`)
      .set('Cookie', adminCookie)
      .send({ node_id: remoteNodeId });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/local node/i);
  });

  it('rejects updates that clear target_type', async () => {
    const res = await request(app)
      .put(`/api/scheduled-tasks/${taskId}`)
      .set('Cookie', adminCookie)
      .send({ target_type: null });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid target_type/);
  });

  it('rejects updates that clear action', async () => {
    const res = await request(app)
      .put(`/api/scheduled-tasks/${taskId}`)
      .set('Cookie', adminCookie)
      .send({ action: null });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid action/);
  });

  it('clears stale stack and service fields when changing a task to a fleet snapshot', async () => {
    const db = DatabaseService.getInstance();
    const now = Date.now();
    const restartId = db.createScheduledTask({
      name: 'restart',
      target_type: 'stack',
      target_id: 'web',
      node_id: 1,
      action: 'restart',
      cron_expression: '0 3 * * *',
      enabled: 1,
      created_by: 'admin',
      created_at: now,
      updated_at: now,
      last_run_at: null,
      next_run_at: null,
      last_status: null,
      last_error: null,
      prune_targets: null,
      target_services: JSON.stringify(['api']),
      prune_label_filter: null,
      delete_after_run: 0,
    });

    const res = await request(app)
      .put(`/api/scheduled-tasks/${restartId}`)
      .set('Cookie', adminCookie)
      .send({ action: 'snapshot', target_type: 'fleet' });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe('snapshot');
    expect(res.body.target_type).toBe('fleet');
    expect(res.body.target_id).toBeNull();
    expect(res.body.node_id).toBeNull();
    expect(res.body.target_services).toBeNull();
    expect(res.body.prune_targets).toBeNull();
    expect(res.body.prune_label_filter).toBeNull();
  });
});

describe('PUT /api/scheduled-tasks/:id - cron validation', () => {
  let taskId: number;

  beforeEach(() => {
    const now = Date.now();
    taskId = DatabaseService.getInstance().createScheduledTask({
      name: 't', target_type: 'stack', target_id: 's', node_id: 1, action: 'update',
      cron_expression: '0 3 * * *', enabled: 1, created_by: 'admin', created_at: now, updated_at: now,
      last_run_at: null, next_run_at: null, last_status: null, last_error: null,
      prune_targets: null, target_services: null, prune_label_filter: null, delete_after_run: 0,
    });
  });

  it('rejects a 6-field cron expression', async () => {
    const res = await request(app)
      .put(`/api/scheduled-tasks/${taskId}`)
      .set('Cookie', adminCookie)
      .send({ cron_expression: '30 0 3 * * *' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/5 fields/);
  });

  it('accepts a valid 5-field cron expression', async () => {
    const res = await request(app)
      .put(`/api/scheduled-tasks/${taskId}`)
      .set('Cookie', adminCookie)
      .send({ cron_expression: '0 4 * * *' });

    expect(res.status).toBe(200);
    expect(res.body.cron_expression).toBe('0 4 * * *');
  });

  it('rejects a whitespace-only cron expression', async () => {
    const res = await request(app)
      .put(`/api/scheduled-tasks/${taskId}`)
      .set('Cookie', adminCookie)
      .send({ cron_expression: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
  });

  it('rejects an empty cron expression', async () => {
    const res = await request(app)
      .put(`/api/scheduled-tasks/${taskId}`)
      .set('Cookie', adminCookie)
      .send({ cron_expression: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
  });
});

describe('scheduled-tasks state-invalidate broadcast', () => {
  // Two frontend hooks (useConfigurationStatus, useNextAutoUpdateRun) refetch
  // when this scope fires; locking it down prevents a silent UX regression
  // where a successful mutation no longer triggers their fast-refresh path.
  it('fires scope=scheduled-tasks on create, update, toggle, and delete', async () => {
    const { NotificationService } = await import('../services/NotificationService');
    const broadcastSpy = vi.spyOn(NotificationService.getInstance(), 'broadcastEvent').mockImplementation(() => undefined);
    try {
      const expectScheduledTasksBroadcast = () => {
        expect(broadcastSpy).toHaveBeenCalledWith(expect.objectContaining({
          type: 'state-invalidate',
          scope: 'scheduled-tasks',
          ts: expect.any(Number),
        }));
      };

      const createRes = await request(app)
        .post('/api/scheduled-tasks')
        .set('Cookie', adminCookie)
        .send({
          name: 'broadcast-test',
          target_type: 'system',
          node_id: 1,
          action: 'prune',
          cron_expression: '0 4 * * *',
          enabled: true,
          prune_targets: ['images'],
        });
      expect(createRes.status).toBe(201);
      const taskId = createRes.body.id as number;
      expectScheduledTasksBroadcast();

      broadcastSpy.mockClear();
      const updateRes = await request(app)
        .put(`/api/scheduled-tasks/${taskId}`)
        .set('Cookie', adminCookie)
        .send({ cron_expression: '0 5 * * *' });
      expect(updateRes.status).toBe(200);
      expectScheduledTasksBroadcast();

      broadcastSpy.mockClear();
      const toggleRes = await request(app)
        .patch(`/api/scheduled-tasks/${taskId}/toggle`)
        .set('Cookie', adminCookie);
      expect(toggleRes.status).toBe(200);
      expectScheduledTasksBroadcast();

      broadcastSpy.mockClear();
      const deleteRes = await request(app)
        .delete(`/api/scheduled-tasks/${taskId}`)
        .set('Cookie', adminCookie);
      expect(deleteRes.status).toBe(200);
      expectScheduledTasksBroadcast();
    } finally {
      broadcastSpy.mockRestore();
    }
  });

  it('does not broadcast when validation rejects the request', async () => {
    const { NotificationService } = await import('../services/NotificationService');
    const broadcastSpy = vi.spyOn(NotificationService.getInstance(), 'broadcastEvent').mockImplementation(() => undefined);
    try {
      const res = await request(app)
        .post('/api/scheduled-tasks')
        .set('Cookie', adminCookie)
        .send({ name: '', target_type: 'system', action: 'prune', cron_expression: '0 4 * * *' });
      expect(res.status).toBe(400);
      const scheduledBroadcasts = broadcastSpy.mock.calls.filter(
        ([event]) => (event as { scope?: string }).scope === 'scheduled-tasks',
      );
      expect(scheduledBroadcasts).toHaveLength(0);
    } finally {
      broadcastSpy.mockRestore();
    }
  });
});
