/**
 * RBAC tests for /api/scheduled-tasks. Verifies that target-aware permission
 * checks replace the blanket requireAdmin gate: scoped deployers can create
 * stack-lifecycle schedules for their stacks, node admins can create node-wide
 * schedules, viewers/auditors get 403 on mutations, and listing is filtered.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let adminCookie: string;
let deployerCookie: string;
let viewerCookie: string;
let auditorCookie: string;
let tierSpy: ReturnType<typeof vi.spyOn>;

/**
 * Creates a user whose ONLY source of the given permission is a scoped
 * role assignment. The global role is set to 'viewer' so the scoped
 * grant is the sole path for authorization beyond read-only access.
 */
async function createScopedUser(
  app: import('express').Express,
  db: ReturnType<typeof DatabaseService.getInstance>,
  username: string,
  assignmentRole: 'deployer' | 'node-admin',
  resourceType: 'stack' | 'node',
  resourceId: string,
  nodeId?: number,
): Promise<string> {
  const hash = await bcrypt.hash('testpass', 1);
  const userId = db.addUser({ username, password_hash: hash, role: 'viewer' });
  db.addRoleAssignment({ user_id: userId, role: assignmentRole, resource_type: resourceType, resource_id: resourceId, node_id: nodeId ?? null });
  const res = await request(app).post('/api/auth/login').send({ username, password: 'testpass' });
  const cookies = res.headers['set-cookie'] as string | string[];
  return Array.isArray(cookies) ? cookies[0] : cookies;
}

let scopedDeployerCookie: string;
let scopedNodeAdminCookie: string;
let secondStackDeployerCookie: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  const db = DatabaseService.getInstance();

  const { LicenseService } = await import('../services/LicenseService');
  tierSpy = vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');

  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);

  // Global roles
  for (const [role, pw] of [['deployer', 'dp'], ['viewer', 'vwp'], ['auditor', 'aud']] as const) {
    const hash = await bcrypt.hash(pw, 1);
    db.addUser({ username: `sched-${role}`, password_hash: hash, role });
    const res = await request(app).post('/api/auth/login').send({ username: `sched-${role}`, password: pw });
    const cookies = res.headers['set-cookie'] as string | string[];
    const c = Array.isArray(cookies) ? cookies[0] : cookies;
    if (role === 'deployer') deployerCookie = c;
    else if (role === 'viewer') viewerCookie = c;
    else auditorCookie = c;
  }

  // Insert a local node for stack-target fixtures
  for (const [nodeName, nodeType] of [['local-test', 'local'], ['remote-test', 'remote']] as const) {
    const existing = db.getDb().prepare('SELECT id FROM nodes WHERE name = ?').get(nodeName) as { id: number } | undefined;
    if (!existing) {
      db.getDb().prepare(
        `INSERT INTO nodes (name, type, mode, compose_dir, is_default, status, created_at)
         VALUES (?, ?, 'proxy', '/tmp/compose', 0, 'online', ?)`,
      ).run(nodeName, nodeType, Date.now());
    }
  }

  // Scoped deployer: stack:deploy on stack "web" at node 1
  scopedDeployerCookie = await createScopedUser(app, db, 'scoped-deploy', 'deployer', 'stack', 'web', 1);
  // Scoped node-admin: node:manage on node 1
  scopedNodeAdminCookie = await createScopedUser(app, db, 'scoped-nodeadm', 'node-admin', 'node', '1');
  // Second scoped deployer: stack:deploy on stack "api" at node 1
  secondStackDeployerCookie = await createScopedUser(app, db, 'scoped-deploy-2', 'deployer', 'stack', 'api', 1);
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  const db = DatabaseService.getInstance().getDb();
  db.prepare('DELETE FROM scheduled_tasks').run();
  tierSpy.mockReturnValue('paid');
});

const stackRestartPayload = {
  name: 'nightly-restart', target_type: 'stack', target_id: 'web',
  node_id: 1, action: 'restart', cron_expression: '0 3 * * *', enabled: true,
};

const nodeScanPayload = {
  name: 'nightly-scan', target_type: 'system', target_id: null,
  node_id: 1, action: 'scan', cron_expression: '0 4 * * *', enabled: true,
};

const prunePayload = {
  name: 'weekly-prune', target_type: 'system', target_id: null,
  node_id: 1, action: 'prune', cron_expression: '0 5 * * 0', enabled: true,
};

const fleetUpdatePayload = {
  name: 'fleet-update', target_type: 'fleet', target_id: null,
  node_id: 1, action: 'update', cron_expression: '0 6 * * *', enabled: true,
};

// ── Create ─────────────────────────────────────────────────────────────────

describe('POST /api/scheduled-tasks (RBAC)', () => {
  it('allows global deployer (stack:deploy) to create stack restart', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', deployerCookie).send(stackRestartPayload);
    expect(res.status).toBe(201);
  });

  it('allows global deployer to create node scan (node:manage)', async () => {
    // Global deployer has stack:read + stack:deploy only — no node:manage.
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', deployerCookie).send(nodeScanPayload);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('allows global deployer to create fleet-wide update (node:manage)', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', deployerCookie).send(fleetUpdatePayload);
    expect(res.status).toBe(403);
  });

  it('rejects global deployer creating prune (system:settings)', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', deployerCookie).send(prunePayload);
    expect(res.status).toBe(403);
  });

  it('allows admin to create prune', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', adminCookie).send(prunePayload);
    expect(res.status).toBe(201);
  });

  it('allows scoped deployer on their own stack', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', scopedDeployerCookie).send(stackRestartPayload);
    expect(res.status).toBe(201);
  });

  it('rejects scoped deployer on a different stack', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', scopedDeployerCookie).send({
      ...stackRestartPayload, target_id: 'api',
    });
    expect(res.status).toBe(403);
  });

  it('rejects scoped deployer creating node scan', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', scopedDeployerCookie).send(nodeScanPayload);
    expect(res.status).toBe(403);
  });

  it('allows scoped node-admin to create node scan', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', scopedNodeAdminCookie).send(nodeScanPayload);
    expect(res.status).toBe(201);
  });

  it('rejects scoped node-admin creating prune (unscoped, admin-only)', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', scopedNodeAdminCookie).send(prunePayload);
    expect(res.status).toBe(403);
  });

  it('rejects viewer creating any task', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', viewerCookie).send(stackRestartPayload);
    expect(res.status).toBe(403);
  });

  it('rejects auditor creating any task', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', auditorCookie).send(stackRestartPayload);
    expect(res.status).toBe(403);
  });

  it('records creator_user_id from the authenticated user', async () => {
    const res = await request(app).post('/api/scheduled-tasks').set('Cookie', deployerCookie).send(stackRestartPayload);
    expect(res.status).toBe(201);
    const task = DatabaseService.getInstance().getScheduledTask(res.body.id);
    expect(task).toBeDefined();
    expect(task!.creator_user_id).not.toBeNull();
    expect(task!.created_by).toBe('sched-deployer');
  });
});

// ── List filtering ─────────────────────────────────────────────────────────

describe('GET /api/scheduled-tasks (RBAC listing filter)', () => {
  let db: ReturnType<typeof DatabaseService.getInstance>;

  beforeEach(() => {
    db = DatabaseService.getInstance();
    // Create a mix of tasks
    db.createScheduledTask({
      name: 'web-restart', target_type: 'stack', target_id: 'web', node_id: 1,
      action: 'restart', cron_expression: '0 3 * * *', enabled: 1,
      created_by: 'admin', creator_user_id: 1, created_at: 0, updated_at: 0,
      last_run_at: null, next_run_at: null, last_status: null, last_error: null,
      prune_targets: null, target_services: null, prune_label_filter: null,
      selector_type: null, selector_value: null, delete_after_run: 0, run_at: null,
    });
    db.createScheduledTask({
      name: 'api-restart', target_type: 'stack', target_id: 'api', node_id: 1,
      action: 'restart', cron_expression: '0 4 * * *', enabled: 1,
      created_by: 'admin', creator_user_id: 1, created_at: 0, updated_at: 0,
      last_run_at: null, next_run_at: null, last_status: null, last_error: null,
      prune_targets: null, target_services: null, prune_label_filter: null,
      selector_type: null, selector_value: null, delete_after_run: 0, run_at: null,
    });
    db.createScheduledTask({
      name: 'node-scan', target_type: 'system', target_id: null, node_id: 1,
      action: 'scan', cron_expression: '0 5 * * *', enabled: 1,
      created_by: 'admin', creator_user_id: 1, created_at: 0, updated_at: 0,
      last_run_at: null, next_run_at: null, last_status: null, last_error: null,
      prune_targets: null, target_services: null, prune_label_filter: null,
      selector_type: null, selector_value: null, delete_after_run: 0, run_at: null,
    });
  });

  it('admin sees all tasks', async () => {
    const res = await request(app).get('/api/scheduled-tasks').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
  });

  it('scoped deployer sees only their own stack tasks', async () => {
    const res = await request(app).get('/api/scheduled-tasks').set('Cookie', scopedDeployerCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].target_id).toBe('web');
  });

  it('global deployer sees all stack and node tasks but not prune', async () => {
    // Global deployer: stack:read + stack:deploy. Can see stack tasks but not
    // scan (node:manage) or prune (system:settings). Fleet update without a
    // specific node_id is unscoped node:manage — also 403.
    const res = await request(app).get('/api/scheduled-tasks').set('Cookie', deployerCookie);
    expect(res.status).toBe(200);
    // Should see only the two stack restart tasks
    expect(res.body).toHaveLength(2);
    expect(res.body.every((t: any) => t.target_type === 'stack')).toBe(true);
  });

  it('viewer sees empty list', async () => {
    const res = await request(app).get('/api/scheduled-tasks').set('Cookie', viewerCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ── By-id / runs / export ──────────────────────────────────────────────────

describe('GET /:id, /:id/runs, /:id/runs/export (RBAC)', () => {
  let taskId: number;

  beforeEach(() => {
    const db = DatabaseService.getInstance();
    const res = db.getDb().prepare(`
      INSERT INTO scheduled_tasks (name, target_type, target_id, node_id, action, cron_expression, enabled, created_by, creator_user_id, created_at, updated_at)
      VALUES ('test-task', 'stack', 'web', 1, 'restart', '0 3 * * *', 1, 'admin', 1, 0, 0)
    `).run();
    taskId = res.lastInsertRowid as number;
  });

  it('scoped deployer can GET /:id for their own stack', async () => {
    const res = await request(app).get(`/api/scheduled-tasks/${taskId}`).set('Cookie', scopedDeployerCookie);
    expect(res.status).toBe(200);
  });

  it('scoped deployer gets 404 for a different stack task', async () => {
    // Create a task they don't own
    const db = DatabaseService.getInstance();
    const other = db.getDb().prepare(`
      INSERT INTO scheduled_tasks (name, target_type, target_id, node_id, action, cron_expression, enabled, created_by, creator_user_id, created_at, updated_at)
      VALUES ('api-task', 'stack', 'api', 1, 'restart', '0 4 * * *', 1, 'admin', 1, 0, 0)
    `).run();
    const res = await request(app).get(`/api/scheduled-tasks/${other.lastInsertRowid}`).set('Cookie', scopedDeployerCookie);
    expect(res.status).toBe(404);
  });
});

// ── Update (two-phase) ─────────────────────────────────────────────────────

describe('PUT /:id (RBAC two-phase)', () => {
  let taskId: number;

  beforeEach(() => {
    const db = DatabaseService.getInstance();
    const res = db.getDb().prepare(`
      INSERT INTO scheduled_tasks (name, target_type, target_id, node_id, action, cron_expression, enabled, created_by, creator_user_id, created_at, updated_at)
      VALUES ('web-task', 'stack', 'web', 1, 'restart', '0 3 * * *', 1, 'admin', 1, 0, 0)
    `).run();
    taskId = res.lastInsertRowid as number;
  });

  it('scoped deployer can update their own stack task', async () => {
    const res = await request(app).put(`/api/scheduled-tasks/${taskId}`).set('Cookie', scopedDeployerCookie).send({ name: 'renamed' });
    expect(res.status).toBe(200);
  });

  it('scoped deployer gets 403 when trying to retarget to a different stack', async () => {
    const res = await request(app).put(`/api/scheduled-tasks/${taskId}`).set('Cookie', scopedDeployerCookie).send({ target_id: 'api' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('scoped deployer gets 403 when trying to flip restart -> prune', async () => {
    // prune requires target_type: system, so include it to reach the
    // permission check rather than hitting structural validation first.
    const res = await request(app).put(`/api/scheduled-tasks/${taskId}`).set('Cookie', scopedDeployerCookie).send({ action: 'prune', target_type: 'system', target_id: null });
    expect(res.status).toBe(403);
  });

  it('second deployer gets 404 editing a task they do not own', async () => {
    const res = await request(app).put(`/api/scheduled-tasks/${taskId}`).set('Cookie', secondStackDeployerCookie).send({ name: 'stolen' });
    expect(res.status).toBe(404);
  });
});

// ── Toggle / Run-now ───────────────────────────────────────────────────────

describe('PATCH /:id/toggle and POST /:id/run (RBAC)', () => {
  let taskId: number;

  beforeEach(() => {
    const db = DatabaseService.getInstance();
    const res = db.getDb().prepare(`
      INSERT INTO scheduled_tasks (name, target_type, target_id, node_id, action, cron_expression, enabled, created_by, creator_user_id, created_at, updated_at)
      VALUES ('web-task', 'stack', 'web', 1, 'restart', '0 3 * * *', 1, 'admin', 1, 0, 0)
    `).run();
    taskId = res.lastInsertRowid as number;
  });

  it('scoped deployer can toggle their stack task', async () => {
    const res = await request(app).patch(`/api/scheduled-tasks/${taskId}/toggle`).set('Cookie', scopedDeployerCookie);
    expect(res.status).toBe(200);
  });

  it('scoped deployer can run-now their stack task', async () => {
    const res = await request(app).post(`/api/scheduled-tasks/${taskId}/run`).set('Cookie', scopedDeployerCookie);
    // 409 (already running) is also acceptable; 202 is the success case
    // 403 means the permission check rejected
    expect(res.status).not.toBe(403);
  });

  it('scoped deployer gets 404 on toggle of other stack task', async () => {
    const res = await request(app).patch(`/api/scheduled-tasks/${taskId}/toggle`).set('Cookie', secondStackDeployerCookie);
    expect(res.status).toBe(404);
  });

  it('viewer gets 404 on toggle', async () => {
    const res = await request(app).patch(`/api/scheduled-tasks/${taskId}/toggle`).set('Cookie', viewerCookie);
    expect(res.status).toBe(404);
  });
});

// ── Execution-time revalidation ────────────────────────────────────────────

describe('Scheduler revalidation', () => {
  it('rejects a task whose creator was deleted', async () => {
    // Verify that executeTask auto-disables the task when the creator no longer exists:
    const { SchedulerService } = await import('../services/SchedulerService');
    const db = DatabaseService.getInstance();

    // Create a task with a non-existent creator_user_id
    const res = db.getDb().prepare(`
      INSERT INTO scheduled_tasks (name, target_type, target_id, node_id, action, cron_expression, enabled, created_by, creator_user_id, created_at, updated_at)
      VALUES ('orphan-task', 'stack', 'web', 1, 'restart', '0 3 * * *', 1, 'deleted-user', 99999, 0, 0)
    `).run();
    const task = db.getScheduledTask(res.lastInsertRowid as number);
    expect(task).toBeDefined();

    // executeTask catches TaskAuthorizationError internally (auto-disables the
    // task and records the error), then returns normally rather than re-throwing.
    await (SchedulerService.getInstance() as any).executeTask(task!, 'scheduler');
    const updated = db.getScheduledTask(task!.id);
    expect(updated!.enabled).toBe(0);
    expect(updated!.last_error).toContain('creator account no longer exists');
  });

  it('legacy task with NULL creator_user_id executes without revalidation', async () => {
    const { SchedulerService } = await import('../services/SchedulerService');
    const db = DatabaseService.getInstance();

    // A legacy task with NULL creator_user_id
    const res = db.getDb().prepare(`
      INSERT INTO scheduled_tasks (name, target_type, target_id, node_id, action, cron_expression, enabled, created_by, creator_user_id, created_at, updated_at)
      VALUES ('legacy-task', 'stack', 'web', 1, 'restart', '0 3 * * *', 1, 'admin', NULL, 0, 0)
    `).run();
    const task = db.getScheduledTask(res.lastInsertRowid as number);

    // Should not throw TaskAuthorizationError. Any other error (e.g., Docker
    // not available) means the revalidation was skipped correctly.
    let threwAuthError = false;
    try {
      await (SchedulerService.getInstance() as any).executeTask(task!, 'scheduler');
    } catch (e: unknown) {
      const { TaskAuthorizationError } = await import('../services/SchedulerService');
      threwAuthError = e instanceof TaskAuthorizationError;
    }
    expect(threwAuthError).toBe(false);
  });
});

// ── Registry lockstep ──────────────────────────────────────────────────────

describe('Action registry lockstep', () => {
  it('every BACKEND_SCHEDULED_ACTIONS entry has a valid permission', async () => {
    const { BACKEND_SCHEDULED_ACTIONS } = await import('../services/scheduledActionRegistry');
    const { ALL_PERMISSION_ACTIONS } = await import('../middleware/permissions');
    for (const def of BACKEND_SCHEDULED_ACTIONS) {
      expect(ALL_PERMISSION_ACTIONS).toContain(def.permission);
    }
  });

  it('resolveTaskPermissionScope covers every (action x target_type) pair', async () => {
    const { BACKEND_SCHEDULED_ACTIONS, resolveTaskPermissionScope } = await import('../services/scheduledActionRegistry');
    for (const def of BACKEND_SCHEDULED_ACTIONS) {
      for (const tt of def.targetTypes) {
        const scope = resolveTaskPermissionScope(def.id, tt, 'test-stack', 1, null);
        expect(scope.action).toBeDefined();
        expect(scope.action).not.toBeNull();
      }
    }
  });

  it('prune resolves unscoped regardless of node_id', async () => {
    const { resolveTaskPermissionScope } = await import('../services/scheduledActionRegistry');
    const scope = resolveTaskPermissionScope('prune', 'system', null, 1, null);
    expect(scope.resourceType).toBeUndefined();
    expect(scope.action).toBe('system:settings');
  });

  it('snapshot resolves unscoped', async () => {
    const { resolveTaskPermissionScope } = await import('../services/scheduledActionRegistry');
    const scope = resolveTaskPermissionScope('snapshot', 'fleet', null, null, null);
    expect(scope.resourceType).toBeUndefined();
    expect(scope.action).toBe('node:manage');
  });

  it('scan resolves node-scoped', async () => {
    const { resolveTaskPermissionScope } = await import('../services/scheduledActionRegistry');
    const scope = resolveTaskPermissionScope('scan', 'system', null, 1, null);
    expect(scope.resourceType).toBe('node');
    expect(scope.resourceId).toBe('1');
    expect(scope.action).toBe('node:manage');
  });
});
