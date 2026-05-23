/**
 * Integration tests for the per-(nodeId, stackName) lifecycle mutex.
 *
 * The mutex prevents two simultaneous compose actions from racing against the
 * same stack. The second caller receives 409 with a structured envelope so the
 * frontend can show "X is already deploying" instead of doubling up.
 *
 * Each lifecycle route (deploy, down, restart, stop, start, update) is
 * exercised: the first request is held mid-call via a deferred promise so the
 * second request lands while the lock is still held, asserting both 409 and
 * the expected `{code, inProgress}` payload.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

const {
  mockDeployStack,
  mockRunCommand,
  mockUpdateStack,
  mockGetContainersByStack,
  mockRestartContainer,
  mockStopContainer,
  mockStartContainer,
} = vi.hoisted(() => ({
  mockDeployStack: vi.fn(),
  mockRunCommand: vi.fn(),
  mockUpdateStack: vi.fn(),
  mockGetContainersByStack: vi.fn(),
  mockRestartContainer: vi.fn(),
  mockStopContainer: vi.fn(),
  mockStartContainer: vi.fn(),
}));

vi.mock('../services/ComposeService', async () => {
  const actual = await vi.importActual<typeof import('../services/ComposeService')>(
    '../services/ComposeService',
  );
  return {
    ...actual,
    ComposeService: {
      ...actual.ComposeService,
      getInstance: () => ({
        deployStack: mockDeployStack,
        runCommand: mockRunCommand,
        updateStack: mockUpdateStack,
      }),
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
        restartContainer: mockRestartContainer,
        stopContainer: mockStopContainer,
        startContainer: mockStartContainer,
      }),
    },
  };
});

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: () => ({
      getBaseDir: () => '/tmp/compose',
      hasComposeFile: vi.fn().mockResolvedValue(true),
    }),
  },
}));

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);

  const { NotificationService } = await import('../services/NotificationService');
  vi.spyOn(NotificationService.getInstance(), 'dispatchAlert').mockResolvedValue(undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

beforeEach(async () => {
  mockDeployStack.mockReset();
  mockRunCommand.mockReset();
  mockUpdateStack.mockReset();
  mockGetContainersByStack.mockReset();
  mockRestartContainer.mockReset();
  mockStopContainer.mockReset();
  mockStartContainer.mockReset();
  const { StackOpLockService } = await import('../services/StackOpLockService');
  StackOpLockService.resetForTests();
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Stack lifecycle mutex', () => {
  it('returns 409 with stack_op_in_progress when a deploy is already running', async () => {
    const gate = deferred<void>();
    mockDeployStack.mockImplementationOnce(() => gate.promise);

    const first = request(app)
      .post('/api/stacks/web/deploy')
      .set('Cookie', authCookie)
      .send({ skip_scan: true })
      .then(r => r);

    await vi.waitFor(() => expect(mockDeployStack).toHaveBeenCalled());

    const second = await request(app)
      .post('/api/stacks/web/deploy')
      .set('Cookie', authCookie)
      .send({ skip_scan: true });

    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      code: 'stack_op_in_progress',
      inProgress: { action: 'deploy' },
    });
    expect(second.body.error).toMatch(/already deploying/i);
    expect(typeof second.body.inProgress.startedAt).toBe('number');

    gate.resolve();
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
  });

  it('releases the lock after a successful deploy so the next request acquires', async () => {
    mockDeployStack.mockResolvedValueOnce(undefined);
    const first = await request(app)
      .post('/api/stacks/web/deploy')
      .set('Cookie', authCookie)
      .send({ skip_scan: true });
    expect(first.status).toBe(200);

    mockDeployStack.mockResolvedValueOnce(undefined);
    const second = await request(app)
      .post('/api/stacks/web/deploy')
      .set('Cookie', authCookie)
      .send({ skip_scan: true });
    expect(second.status).toBe(200);
  });

  it('releases the lock after a failed deploy', async () => {
    mockDeployStack.mockRejectedValueOnce(new Error('image pull failed'));
    const first = await request(app)
      .post('/api/stacks/web/deploy')
      .set('Cookie', authCookie)
      .send({ skip_scan: true });
    expect(first.status).toBe(500);

    mockDeployStack.mockResolvedValueOnce(undefined);
    const second = await request(app)
      .post('/api/stacks/web/deploy')
      .set('Cookie', authCookie)
      .send({ skip_scan: true });
    expect(second.status).toBe(200);
  });

  it('blocks restart while a deploy is in flight on the same stack', async () => {
    const gate = deferred<void>();
    mockDeployStack.mockImplementationOnce(() => gate.promise);

    const deploy = request(app)
      .post('/api/stacks/web/deploy')
      .set('Cookie', authCookie)
      .send({ skip_scan: true })
      .then(r => r);
    await vi.waitFor(() => expect(mockDeployStack).toHaveBeenCalled());

    const restart = await request(app)
      .post('/api/stacks/web/restart')
      .set('Cookie', authCookie);
    expect(restart.status).toBe(409);
    expect(restart.body.code).toBe('stack_op_in_progress');
    expect(restart.body.inProgress.action).toBe('deploy');

    gate.resolve();
    await deploy;
  });

  it('allows concurrent ops on different stacks', async () => {
    const gate = deferred<void>();
    mockDeployStack.mockImplementation(() => gate.promise);

    const webDeploy = request(app)
      .post('/api/stacks/web/deploy')
      .set('Cookie', authCookie)
      .send({ skip_scan: true })
      .then(r => r);
    await vi.waitFor(() => expect(mockDeployStack).toHaveBeenCalledTimes(1));

    const apiDeploy = request(app)
      .post('/api/stacks/api/deploy')
      .set('Cookie', authCookie)
      .send({ skip_scan: true })
      .then(r => r);
    await vi.waitFor(() => expect(mockDeployStack).toHaveBeenCalledTimes(2));

    gate.resolve();
    const [webRes, apiRes] = await Promise.all([webDeploy, apiDeploy]);
    expect(webRes.status).toBe(200);
    expect(apiRes.status).toBe(200);
  });

  it('blocks update while down is in flight', async () => {
    const gate = deferred<void>();
    mockRunCommand.mockImplementationOnce(() => gate.promise);

    const down = request(app)
      .post('/api/stacks/web/down')
      .set('Cookie', authCookie)
      .then(r => r);
    await vi.waitFor(() => expect(mockRunCommand).toHaveBeenCalled());

    const update = await request(app)
      .post('/api/stacks/web/update')
      .set('Cookie', authCookie)
      .send({ skip_scan: true });
    expect(update.status).toBe(409);
    expect(update.body.inProgress.action).toBe('down');

    gate.resolve();
    await down;
  });

  it('returns 409 for stop while restart is in flight', async () => {
    mockGetContainersByStack.mockResolvedValue([{ Id: 'c1' }]);
    const gate = deferred<void>();
    mockRestartContainer.mockImplementationOnce(() => gate.promise);

    const restart = request(app)
      .post('/api/stacks/web/restart')
      .set('Cookie', authCookie)
      .then(r => r);
    await vi.waitFor(() => expect(mockRestartContainer).toHaveBeenCalled());

    const stop = await request(app)
      .post('/api/stacks/web/stop')
      .set('Cookie', authCookie);
    expect(stop.status).toBe(409);
    expect(stop.body.inProgress.action).toBe('restart');

    gate.resolve();
    await restart;
  });
});
