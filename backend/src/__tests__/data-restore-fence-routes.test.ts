/**
 * A container start refused because a data restore owns a volume it mounts is
 * answered `409 data_restore` on every route that starts a container without
 * the stack lock (while the restore runs, a stack route answers
 * `stack_op_in_progress` from the lock first), as the Files & Volumes browser
 * already does. A generic 500 would tell the operator
 * the start failed, not that a restore owns the data.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { DataRestoreFenceError } from '../helpers/dataRestoreFenceError';

const { mockGetContainersByStack, mockStartContainer, mockRestartContainer, mockStopContainer, mockAssertNoEndpointContainers } = vi.hoisted(() => ({
  mockGetContainersByStack: vi.fn(),
  mockStartContainer: vi.fn(),
  mockRestartContainer: vi.fn(),
  mockStopContainer: vi.fn(),
  mockAssertNoEndpointContainers: vi.fn(),
}));

// Restarts consult the Docker endpoint guard first; this suite is about the fence.
vi.mock('../services/ComposeService', async () => {
  const actual = await vi.importActual<typeof import('../services/ComposeService')>(
    '../services/ComposeService',
  );
  return {
    ...actual,
    ComposeService: {
      ...actual.ComposeService,
      getInstance: () => ({ evaluateDockerEndpoint: async () => null }),
    },
  };
});

vi.mock('../services/DockerController', async () => {
  const actual = await vi.importActual<typeof import('../services/DockerController')>(
    '../services/DockerController',
  );
  return {
    ...actual,
    default: {
      ...actual.default,
      getInstance: () => ({
        getContainersByStack: mockGetContainersByStack,
        startContainer: mockStartContainer,
        restartContainer: mockRestartContainer,
        stopContainer: mockStopContainer,
        assertNoDockerEndpointContainers: mockAssertNoEndpointContainers,
      }),
    },
  };
});

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;

const VOLUME = 'app-data';
const fenced = () => new DataRestoreFenceError(VOLUME);

/**
 * A held fence for a stack, written the way a running overwrite records it: an
 * intent for the volume plus the container it stopped. The route asks the same
 * durable store, so this exercises the real refusal, not a mocked one.
 */
async function seedHeldFence(stackName: string, projectName = stackName): Promise<void> {
  const { recoveryDb } = await import('../services/recovery/recoveryDb');
  const db = recoveryDb();
  const intentId = randomUUID();
  // Only the intent and its member decide `isStackFenced`; the operation and
  // point rows a real admission writes are not needed, so the test seeds the
  // two tables it exercises and leaves the declarative references unfulfilled.
  db.pragma('foreign_keys = OFF');
  try {
    db.prepare(`INSERT INTO recovery_restore_intents
      (id, operation_id, point_id, target_mode, target_volume, phase, fence_state, actor, process_epoch, created_at, updated_at)
      VALUES (?, ?, ?, 'staged_overwrite', ?, 'fenced', 'held', 'admin', 'e', 1, 1)`)
      .run(intentId, randomUUID(), randomUUID(), `${stackName}-vol`);
    db.prepare(`INSERT INTO recovery_restore_fence_members
      (intent_id, container_id, container_name, stack_name, project_name, restart_policy_json, was_running, released_at)
      VALUES (?, 'c1', ?, ?, ?, '{"Name":"always"}', 1, NULL)`)
      .run(intentId, `${stackName}-web-1`, stackName, projectName);
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);
  const dir = path.join(process.env.COMPOSE_DIR!, 'infra');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
  const SelfIdentityService = (await import('../services/SelfIdentityService')).default;
  vi.spyOn(SelfIdentityService.getInstance(), 'initialize').mockResolvedValue(undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

afterEach(async () => {
  vi.clearAllMocks();
  mockGetContainersByStack.mockResolvedValue([{ Id: 'c1', Labels: { 'com.docker.compose.service': 'web' } }]);
  mockAssertNoEndpointContainers.mockResolvedValue(undefined);
  mockStopContainer.mockResolvedValue(undefined);
  const { StackOpLockService } = await import('../services/StackOpLockService');
  StackOpLockService.resetForTests();
  const { recoveryDb } = await import('../services/recovery/recoveryDb');
  const db = recoveryDb();
  db.prepare('DELETE FROM recovery_restore_fence_members').run();
  db.prepare('DELETE FROM recovery_restore_intents').run();
});

describe('a start or restart refused by a restore fence', () => {
  const cases: Array<[string, string, 'start' | 'restart']> = [
    ['single container start', '/api/containers/c1/start', 'start'],
    ['single container restart', '/api/containers/c1/restart', 'restart'],
    ['stack start', '/api/stacks/infra/start', 'start'],
    ['stack restart', '/api/stacks/infra/restart', 'restart'],
    ['service start', '/api/stacks/infra/services/web/start', 'start'],
    ['service restart', '/api/stacks/infra/services/web/restart', 'restart'],
  ];

  for (const [name, route, action] of cases) {
    it(`answers 409 data_restore for a ${name}`, async () => {
      (action === 'start' ? mockStartContainer : mockRestartContainer).mockRejectedValue(fenced());
      const res = await request(app).post(route).set('Cookie', authCookie).send({});
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('data_restore');
      expect(res.body.error).toContain(VOLUME);
      expect(res.body.error).toContain('data restore');
    });
  }

  it('still answers 500 for a start that failed for another reason', async () => {
    mockStartContainer.mockRejectedValue(new Error('daemon exploded'));
    const container = await request(app).post('/api/containers/c1/start').set('Cookie', authCookie).send({});
    expect(container.status).toBe(500);
    expect(container.body.code).toBeUndefined();
    const stack = await request(app).post('/api/stacks/infra/start').set('Cookie', authCookie).send({});
    expect(stack.status).toBe(500);
    expect(stack.body.code).toBeUndefined();
  });

  for (const action of ['start', 'restart'] as const) {
    it(`reports data_restore on the bulk ${action} row`, async () => {
      (action === 'start' ? mockStartContainer : mockRestartContainer).mockRejectedValue(fenced());
      const res = await request(app)
        .post('/api/stacks/bulk')
        .set('Cookie', authCookie)
        .send({ action, stackNames: ['infra'] });
      expect(res.status).toBe(200);
      expect(res.body.results[0]).toMatchObject({ stackName: 'infra', ok: false, code: 'data_restore' });
      expect(res.body.results[0].error).toContain(VOLUME);
    });
  }
});

describe('a service lifecycle refused by the lock a restore holds', () => {
  it('refuses a service stop while the fence is held', async () => {
    await seedHeldFence('infra');
    const res = await request(app)
      .post('/api/stacks/infra/services/web/stop')
      .set('Cookie', authCookie)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('stack_op_in_progress');
    expect(res.body.inProgress.action).toBe('data_restore');
    expect(mockStopContainer).not.toHaveBeenCalled();
  });

  it('refuses a service start and restart before they reach Docker', async () => {
    await seedHeldFence('infra');
    for (const action of ['start', 'restart'] as const) {
      const res = await request(app)
        .post(`/api/stacks/infra/services/web/${action}`)
        .set('Cookie', authCookie)
        .send({});
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('stack_op_in_progress');
      expect(res.body.inProgress.action).toBe('data_restore');
    }
    expect(mockStartContainer).not.toHaveBeenCalled();
    expect(mockRestartContainer).not.toHaveBeenCalled();
  });

  it('matches the stack by its Compose project name as well as its directory name', async () => {
    // The route is asked with the project name while the recorded stack directory
    // is different, which is the case a name comparison would miss.
    await seedHeldFence('stack-directory', 'infra');
    const res = await request(app)
      .post('/api/stacks/infra/services/web/stop')
      .set('Cookie', authCookie)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('stack_op_in_progress');
    expect(mockStopContainer).not.toHaveBeenCalled();
  });

  it('lets a service stop through once the fence is released', async () => {
    await seedHeldFence('infra');
    const { recoveryDb } = await import('../services/recovery/recoveryDb');
    recoveryDb().prepare("UPDATE recovery_restore_intents SET fence_state = 'released'").run();
    const res = await request(app)
      .post('/api/stacks/infra/services/web/stop')
      .set('Cookie', authCookie)
      .send({});
    expect(res.status).toBe(200);
    expect(mockStopContainer).toHaveBeenCalledWith('c1');
  });
});
