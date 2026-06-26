import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let mockFsStacks: string[] = [];
const deployStack = vi.fn();
const getContainersByStack = vi.fn();
const stopContainer = vi.fn();
const restartContainer = vi.fn();
const enforcePolicyPreDeploy = vi.fn();
const invalidateNodeCaches = vi.fn();

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: vi.fn(() => ({
      getStacks: vi.fn(async () => mockFsStacks),
    })),
  },
}));

vi.mock('../services/ComposeService', () => ({
  ComposeService: {
    getInstance: vi.fn(() => ({ deployStack })),
  },
}));

vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: vi.fn(() => ({
      getContainersByStack,
      stopContainer,
      restartContainer,
    })),
  },
}));

vi.mock('../services/PolicyEnforcement', () => ({
  enforcePolicyPreDeploy,
}));

vi.mock('../helpers/cacheInvalidation', () => ({
  invalidateNodeCaches,
}));

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let db: import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let activeBulkActions: typeof import('../routes/labels').activeBulkActions;
let StackOpLockService: typeof import('../services/StackOpLockService').StackOpLockService;
let labelCounter = 0;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ LicenseService } = await import('../services/LicenseService'));
  ({ activeBulkActions } = await import('../routes/labels'));
  ({ StackOpLockService } = await import('../services/StackOpLockService'));
  const { DatabaseService } = await import('../services/DatabaseService');
  db = DatabaseService.getInstance();
  authHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  vi.restoreAllMocks();
  // restoreAllMocks only resets spies; bare vi.fn() mocks keep their call
  // history across tests. Clear them all so each test sees a fresh slate
  // before its `.not.toHaveBeenCalled()` assertions run.
  vi.clearAllMocks();
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  mockFsStacks = ['alpha', 'beta'];
  deployStack.mockResolvedValue(undefined);
  getContainersByStack.mockResolvedValue([{ Id: 'container-1' }]);
  stopContainer.mockResolvedValue(undefined);
  restartContainer.mockResolvedValue(undefined);
  enforcePolicyPreDeploy.mockResolvedValue({ ok: true });
  activeBulkActions.clear();
  StackOpLockService.resetForTests();
  db.getDb().prepare('DELETE FROM stack_label_assignments').run();
  db.getDb().prepare('DELETE FROM stack_labels').run();
});

async function createAssignedLabel(stacks: string[] = ['alpha']) {
  const created = await request(app)
    .post('/api/labels')
    .set('Authorization', authHeader)
    .send({ name: `bulk-${++labelCounter}`, color: 'teal' });
  expect(created.status).toBe(201);

  for (const stack of stacks) {
    const assigned = await request(app)
      .put(`/api/stacks/${stack}/labels`)
      .set('Authorization', authHeader)
      .send({ labelIds: [created.body.id] });
    expect(assigned.status).toBe(200);
  }

  return created.body as { id: number; node_id: number; name: string; color: string };
}

describe('Stack Labels bulk actions', () => {
  it('deploys every existing stack assigned to the label', async () => {
    const label = await createAssignedLabel(['alpha']);

    const res = await request(app)
      .post(`/api/labels/${label.id}/action`)
      .set('Authorization', authHeader)
      .send({ action: 'deploy' });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ stackName: 'alpha', success: true }]);
    expect(enforcePolicyPreDeploy).toHaveBeenCalledWith('alpha', label.node_id, expect.any(Object));
    expect(deployStack).toHaveBeenCalledWith('alpha', undefined, false);
    expect(invalidateNodeCaches).toHaveBeenCalledWith(label.node_id);
  });

  it('reports partial Docker stop failures without aborting other stacks', async () => {
    const label = await createAssignedLabel(['alpha', 'beta']);
    getContainersByStack.mockImplementation(async (stackName: string) => {
      if (stackName === 'beta') throw new Error('socket permission denied');
      return [{ Id: `${stackName}-1` }];
    });

    const res = await request(app)
      .post(`/api/labels/${label.id}/action`)
      .set('Authorization', authHeader)
      .send({ action: 'stop' });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { stackName: 'alpha', success: true },
      { stackName: 'beta', success: false, error: 'socket permission denied' },
    ]);
    expect(stopContainer).toHaveBeenCalledWith('alpha-1');
    expect(invalidateNodeCaches).toHaveBeenCalledWith(label.node_id);
  });

  it('rejects a second bulk action while the node lock is held', async () => {
    const label = await createAssignedLabel(['alpha']);
    activeBulkActions.add(`bulk:${label.node_id}`);

    const res = await request(app)
      .post(`/api/labels/${label.id}/action`)
      .set('Authorization', authHeader)
      .send({ action: 'restart' });

    expect(res.status).toBe(429);
    expect(res.body.error).toContain('already running');
    expect(restartContainer).not.toHaveBeenCalled();
  });

  it('skips a stack whose per-stack lock is held by a manual operation', async () => {
    const label = await createAssignedLabel(['alpha', 'beta']);
    // A manual operation holds 'alpha'; the bulk deploy must not race it.
    StackOpLockService.getInstance().tryAcquire(label.node_id, 'alpha', 'update', 'admin');

    const res = await request(app)
      .post(`/api/labels/${label.id}/action`)
      .set('Authorization', authHeader)
      .send({ action: 'deploy' });

    expect(res.status).toBe(200);
    const alpha = res.body.results.find((r: { stackName: string }) => r.stackName === 'alpha');
    const beta = res.body.results.find((r: { stackName: string }) => r.stackName === 'beta');
    expect(alpha).toMatchObject({ stackName: 'alpha', success: false });
    expect(alpha.error).toContain('another operation (update) is already in progress');
    expect(beta).toEqual({ stackName: 'beta', success: true });
    // 'alpha' was skipped; only 'beta' reached ComposeService.
    expect(deployStack).toHaveBeenCalledTimes(1);
    expect(deployStack).toHaveBeenCalledWith('beta', undefined, false);
  });

  it('dry-run deploy runs the policy gate and reports blocked stacks honestly', async () => {
    const label = await createAssignedLabel(['alpha']);
    enforcePolicyPreDeploy.mockResolvedValue({
      ok: false,
      policy: { name: 'block-criticals', max_severity: 'high' },
      violations: [{ imageRef: 'nginx:latest', severity: 'CRITICAL', reasons: ['severity'] }],
    });

    const res = await request(app)
      .post(`/api/labels/${label.id}/action`)
      .set('Authorization', authHeader)
      .send({ action: 'deploy', dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      expect.objectContaining({ stackName: 'alpha', success: false, dryRun: true }),
    ]);
    expect(res.body.results[0].error).toContain('Policy "block-criticals" blocked deploy');
    expect(res.body.results[0].error).toContain('matched severity threshold');
    expect(deployStack).not.toHaveBeenCalled();
    expect(invalidateNodeCaches).not.toHaveBeenCalled();
  });

  it('dry-run deploy reports success when the policy gate passes, without touching Docker', async () => {
    const label = await createAssignedLabel(['alpha']);
    enforcePolicyPreDeploy.mockResolvedValue({ ok: true });

    const res = await request(app)
      .post(`/api/labels/${label.id}/action`)
      .set('Authorization', authHeader)
      .send({ action: 'deploy', dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { stackName: 'alpha', success: true, dryRun: true },
    ]);
    expect(enforcePolicyPreDeploy).toHaveBeenCalledWith('alpha', label.node_id, expect.any(Object));
    expect(deployStack).not.toHaveBeenCalled();
    expect(invalidateNodeCaches).not.toHaveBeenCalled();
  });

  it('dry-run stop reports per-stack success without dispatching real stops', async () => {
    const label = await createAssignedLabel(['alpha', 'beta']);

    const res = await request(app)
      .post(`/api/labels/${label.id}/action`)
      .set('Authorization', authHeader)
      .send({ action: 'stop', dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { stackName: 'alpha', success: true, dryRun: true },
      { stackName: 'beta', success: true, dryRun: true },
    ]);
    expect(getContainersByStack).not.toHaveBeenCalled();
    expect(stopContainer).not.toHaveBeenCalled();
    expect(invalidateNodeCaches).not.toHaveBeenCalled();
  });
});
