/**
 * Route smoke tests for the nested service update/restore endpoints: auth and
 * permission gates, the restore recoveryId requirement, and the mapping from
 * OrchestratorResult to HTTP status. The orchestrator itself is mocked so these
 * tests exercise only the route wiring.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

const { mockExecute } = vi.hoisted(() => ({ mockExecute: vi.fn() }));

vi.mock('../services/StackUpdateOrchestrator', () => ({
  StackUpdateOrchestrator: { getInstance: () => ({ execute: mockExecute }) },
}));

let tmpDir: string;
let app: import('express').Express;
let adminCookie: string;
let viewerCookie: string;

function writeStack(name: string) {
  const dir = path.join(process.env.COMPOSE_DIR!, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  app:\n    image: nginx\n  db:\n    image: postgres\n');
}

async function loginAsViewer(): Promise<string> {
  const bcrypt = (await import('bcrypt')).default;
  const { DatabaseService } = await import('../services/DatabaseService');
  const hash = await bcrypt.hash('viewerpass', 1);
  DatabaseService.getInstance().addUser({ username: 'viewer1', password_hash: hash, role: 'viewer' });
  const res = await request(app).post('/api/auth/login').send({ username: 'viewer1', password: 'viewerpass' });
  const cookies = res.headers['set-cookie'] as string | string[];
  return Array.isArray(cookies) ? cookies[0] : cookies;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
  viewerCookie = await loginAsViewer();
  writeStack('web');

  const { NotificationService } = await import('../services/NotificationService');
  vi.spyOn(NotificationService.getInstance(), 'dispatchAlert').mockResolvedValue({ persisted: true });
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

afterEach(async () => {
  mockExecute.mockReset();
  const { StackOpLockService } = await import('../services/StackOpLockService');
  StackOpLockService.resetForTests();
});

describe('nested service route auth and permission gates', () => {
  it('rejects an unauthenticated update with 401', async () => {
    const res = await request(app).post('/api/stacks/web/services/app/update');
    expect(res.status).toBe(401);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated restore with 401', async () => {
    const res = await request(app).post('/api/stacks/web/services/app/restore').send({ recoveryId: 'r1' });
    expect(res.status).toBe(401);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('rejects a viewer without stack:deploy with 403', async () => {
    const res = await request(app)
      .post('/api/stacks/web/services/app/update')
      .set('Cookie', viewerCookie);
    expect(res.status).toBe(403);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe('restore recoveryId requirement', () => {
  it('rejects a restore with no recoveryId with 400 recovery_id_required', async () => {
    const res = await request(app)
      .post('/api/stacks/web/services/app/restore')
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('recovery_id_required');
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe('OrchestratorResult to HTTP mapping', () => {
  it('maps service_done to 200 with the result body', async () => {
    mockExecute.mockResolvedValue({
      kind: 'service_done',
      serviceName: 'app',
      healthGateId: 'hg-1',
      observing: true,
      recoveryId: 'rec-1',
      recoveryAvailable: true,
    });
    const res = await request(app)
      .post('/api/stacks/web/services/app/update')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ serviceName: 'app', healthGateId: 'hg-1', recoveryId: 'rec-1', recoveryAvailable: true });
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('maps service_update_single_service to 400', async () => {
    mockExecute.mockResolvedValue({ kind: 'service_failed', code: 'service_update_single_service', error: 'only one service' });
    const res = await request(app)
      .post('/api/stacks/web/services/app/update')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('service_update_single_service');
  });

  it('maps a policy block to 409', async () => {
    mockExecute.mockResolvedValue({ kind: 'service_failed', code: 'policy_blocked', error: 'blocked' });
    const res = await request(app)
      .post('/api/stacks/web/services/app/update')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('policy_blocked');
  });

  it('maps a service compose failure to 500', async () => {
    mockExecute.mockResolvedValue({ kind: 'service_failed', code: 'service_update_compose_failed', error: 'compose exploded' });
    const res = await request(app)
      .post('/api/stacks/web/services/app/update')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('service_update_compose_failed');
  });

  it('maps a restore service_done to 200', async () => {
    mockExecute.mockResolvedValue({
      kind: 'service_done',
      serviceName: 'app',
      healthGateId: 'hg-2',
      observing: true,
      recoveryId: 'rec-2',
      recoveryAvailable: false,
    });
    const res = await request(app)
      .post('/api/stacks/web/services/app/restore')
      .set('Cookie', adminCookie)
      .send({ deployedGenerationId: null, recoveryId: 'rec-2' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ serviceName: 'app', healthGateId: 'hg-2', recoveryId: 'rec-2' });
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/stacks/:stackName/services/:serviceName/recovery', () => {
  it('returns null when no active recovery exists', async () => {
    const res = await request(app)
      .get('/api/stacks/web/services/app/recovery')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recovery: null });
  });

  it('returns the newest active recovery row', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const { NodeRegistry } = await import('../services/NodeRegistry');
    const db = DatabaseService.getInstance();
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    const now = Date.now();
    db.insertServiceUpdateRecovery({
      id: 'rec-old',
      node_id: nodeId,
      stack_name: 'web',
      service_name: 'app',
      replicas_json: '[]',
      majority_image_id: 'sha256:old',
      declared_image_ref: 'nginx:latest',
      weak_floating_tag: 0,
      health_gate_id: null,
      status: 'active',
      expires_at: now + 60_000,
      claim_expires_at: null,
      created_at: now - 1_000,
      created_by: 'tester',
    });
    db.insertServiceUpdateRecovery({
      id: 'rec-new',
      node_id: nodeId,
      stack_name: 'web',
      service_name: 'app',
      replicas_json: '[]',
      majority_image_id: 'sha256:new',
      declared_image_ref: 'nginx:latest',
      weak_floating_tag: 0,
      health_gate_id: 'gate-1',
      status: 'active',
      expires_at: now + 60_000,
      claim_expires_at: null,
      created_at: now,
      created_by: 'tester',
    });
    const res = await request(app)
      .get('/api/stacks/web/services/app/recovery')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.recovery).toMatchObject({
      id: 'rec-new',
      healthGateId: 'gate-1',
      majorityImageId: 'sha256:new',
    });
  });
});
