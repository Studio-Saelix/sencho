/**
 * Route-level tests for the Docker endpoint guard. A lifecycle request that
 * would stop or recreate the container carrying this node's Docker API (the
 * socket proxy, or Sencho) is answered 409 docker_endpoint_protected before the
 * route takes a lock or starts any work, and a check that itself errors is a
 * refusal, not a pass.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

const {
  mockEvaluate,
  mockDeployStack,
  mockRunCommand,
  mockRunDown,
  mockUpdateStack,
  mockGetContainersByStack,
  mockStopContainer,
  mockRestartContainer,
  mockStartContainer,
  mockGetBulkStackStatuses,
  mockAssertNoEndpointContainers,
} = vi.hoisted(() => ({
  mockEvaluate: vi.fn(),
  mockDeployStack: vi.fn(),
  mockRunCommand: vi.fn(),
  mockRunDown: vi.fn(),
  mockUpdateStack: vi.fn(),
  mockGetContainersByStack: vi.fn(),
  mockStopContainer: vi.fn(),
  mockRestartContainer: vi.fn(),
  mockStartContainer: vi.fn(),
  mockGetBulkStackStatuses: vi.fn(),
  mockAssertNoEndpointContainers: vi.fn(),
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
        evaluateDockerEndpoint: mockEvaluate,
        deployStack: mockDeployStack,
        runCommand: mockRunCommand,
        runDown: mockRunDown,
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
        stopContainer: mockStopContainer,
        restartContainer: mockRestartContainer,
        startContainer: mockStartContainer,
        getBulkStackStatuses: mockGetBulkStackStatuses,
        assertNoDockerEndpointContainers: mockAssertNoEndpointContainers,
      }),
    },
  };
});

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;

const refusal = {
  reason: 'provider' as const,
  service: 'socket-proxy',
  message: 'Service "socket-proxy" carries the Docker connection Sencho is using.',
};

function writeStack(name: string) {
  const dir = path.join(process.env.COMPOSE_DIR!, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);
  writeStack('infra');

  const { NotificationService } = await import('../services/NotificationService');
  vi.spyOn(NotificationService.getInstance(), 'dispatchAlert').mockResolvedValue({ persisted: true });
  const SelfIdentityService = (await import('../services/SelfIdentityService')).default;
  vi.spyOn(SelfIdentityService.getInstance(), 'initialize').mockResolvedValue(undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

afterEach(async () => {
  vi.clearAllMocks();
  mockEvaluate.mockReset();
  mockGetContainersByStack.mockResolvedValue([{ Id: 'c1', Labels: { 'com.docker.compose.service': 'web' } }]);
  mockRestartContainer.mockResolvedValue(undefined);
  mockStopContainer.mockResolvedValue(undefined);
  mockStartContainer.mockResolvedValue(undefined);
  mockGetBulkStackStatuses.mockResolvedValue({ infra: { status: 'running' } });
  mockAssertNoEndpointContainers.mockReset();
  mockAssertNoEndpointContainers.mockResolvedValue(undefined);
  const { StackOpLockService } = await import('../services/StackOpLockService');
  StackOpLockService.resetForTests();
});

describe('a refused lifecycle request', () => {
  const cases = [
    ['POST', '/api/stacks/infra/deploy', { kind: 'up' }],
    ['POST', '/api/stacks/infra/update', { kind: 'update' }],
    ['POST', '/api/stacks/infra/rollback', { kind: 'update' }],
    ['POST', '/api/stacks/infra/down', { kind: 'stop' }],
    ['POST', '/api/stacks/infra/stop', { kind: 'stop' }],
    ['POST', '/api/stacks/infra/restart', { kind: 'restart' }],
    ['POST', '/api/stacks/infra/services/web/stop', { kind: 'service', service: 'web', restart: false }],
    ['POST', '/api/stacks/infra/services/web/restart', { kind: 'service', service: 'web', restart: true }],
    ['POST', '/api/stacks/infra/services/web/update', { kind: 'service', service: 'web' }],
    ['POST', '/api/stacks/infra/services/web/restore', { kind: 'service', service: 'web' }],
    ['DELETE', '/api/stacks/infra', { kind: 'stop' }],
  ] as const;

  it.each(cases)('%s %s returns 409 docker_endpoint_protected with the reason', async (method, url, mutation) => {
    mockEvaluate.mockResolvedValue(refusal);

    const res = method === 'DELETE'
      ? await request(app).delete(url).set('Cookie', authCookie)
      : await request(app).post(url).set('Cookie', authCookie).send({ recoveryId: 'rec-1' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'docker_endpoint_protected', reason: 'provider', error: refusal.message });
    expect(mockEvaluate).toHaveBeenCalledWith('infra', mutation);
    expect(mockDeployStack).not.toHaveBeenCalled();
    expect(mockUpdateStack).not.toHaveBeenCalled();
    expect(mockRunCommand).not.toHaveBeenCalled();
    expect(mockRunDown).not.toHaveBeenCalled();
    expect(mockStopContainer).not.toHaveBeenCalled();
    expect(mockRestartContainer).not.toHaveBeenCalled();
  });

  it('releases the stack lock when it refuses, so the next request is not told the stack is busy', async () => {
    mockEvaluate.mockResolvedValueOnce(refusal);
    mockDeployStack.mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });

    const refused = await request(app).post('/api/stacks/infra/deploy').set('Cookie', authCookie);
    mockEvaluate.mockResolvedValue(null);
    const next = await request(app).post('/api/stacks/infra/deploy').set('Cookie', authCookie);

    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('docker_endpoint_protected');
    expect(next.status).toBe(200);
    expect(mockDeployStack).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['deploy', () => mockDeployStack],
    ['update', () => mockUpdateStack],
    ['down', () => mockRunDown],
  ] as const)('answers 409 when the %s itself is refused after the route check passed', async (action, mockFor) => {
    const { DockerEndpointProtectedError } = await import('../helpers/dockerEndpointGuard');
    mockEvaluate.mockResolvedValue(null);
    mockFor().mockRejectedValue(new DockerEndpointProtectedError(refusal));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await request(app).post(`/api/stacks/infra/${action}`).set('Cookie', authCookie);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'docker_endpoint_protected', reason: 'provider' });
  });

  it('does not consult the guard for start, which never stops anything', async () => {
    mockEvaluate.mockResolvedValue(refusal);

    const res = await request(app).post('/api/stacks/infra/start').set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  it('refuses when the check itself fails, because an error is not a pass', async () => {
    mockEvaluate.mockRejectedValue(new Error('docker exploded'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await request(app).post('/api/stacks/infra/deploy').set('Cookie', authCookie);

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Docker connection');
    expect(mockDeployStack).not.toHaveBeenCalled();
  });

  it('lets the request through when nothing is protected', async () => {
    mockEvaluate.mockResolvedValue(null);
    mockUpdateStack.mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });

    const res = await request(app).post('/api/stacks/infra/update').set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(mockUpdateStack).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/stacks/bulk', () => {
  it('reports a per-stack refusal and still runs the stacks that are fine', async () => {
    writeStack('blog');
    mockEvaluate.mockImplementation(async (stackName: string) => (stackName === 'infra' ? refusal : null));
    mockUpdateStack.mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });

    const res = await request(app)
      .post('/api/stacks/bulk')
      .set('Cookie', authCookie)
      .send({ action: 'update', stackNames: ['infra', 'blog'] });

    expect(res.status).toBe(200);
    const infra = res.body.results.find((r: { stackName: string }) => r.stackName === 'infra');
    const blog = res.body.results.find((r: { stackName: string }) => r.stackName === 'blog');
    expect(infra).toMatchObject({ ok: false, code: 'docker_endpoint_protected', error: refusal.message });
    expect(blog.ok).toBe(true);
    expect(mockUpdateStack).toHaveBeenCalledTimes(1);
  });

  it('reports a stack whose check errors as refused and still runs the others', async () => {
    writeStack('blog');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockEvaluate.mockImplementation(async (stackName: string) => {
      if (stackName === 'infra') throw new Error('docker exploded');
      return null;
    });
    mockUpdateStack.mockResolvedValue({ recoveryId: null, deployedGenerationId: null, gitopsOperationId: null });

    const res = await request(app)
      .post('/api/stacks/bulk')
      .set('Cookie', authCookie)
      .send({ action: 'update', stackNames: ['infra', 'blog'] });

    expect(res.status).toBe(200);
    const infra = res.body.results.find((r: { stackName: string }) => r.stackName === 'infra');
    const blog = res.body.results.find((r: { stackName: string }) => r.stackName === 'blog');
    expect(infra).toMatchObject({ ok: false, code: 'docker_endpoint_protected' });
    expect(blog.ok).toBe(true);
    expect(mockUpdateStack).toHaveBeenCalledTimes(1);
  });

  it('keeps restart a restart kind, and skips the guard for start', async () => {
    mockEvaluate.mockResolvedValue(null);

    await request(app).post('/api/stacks/bulk').set('Cookie', authCookie).send({ action: 'restart', stackNames: ['infra'] });
    await request(app).post('/api/stacks/bulk').set('Cookie', authCookie).send({ action: 'start', stackNames: ['infra'] });

    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    expect(mockEvaluate).toHaveBeenCalledWith('infra', { kind: 'restart' });
  });
});

describe('container stop and restart routes', () => {
  it.each(['stop', 'restart'] as const)('answers 409 when %s is refused for the proxy container', async (action) => {
    const { DockerEndpointProtectedError } = await import('../helpers/dockerEndpointGuard');
    const error = new DockerEndpointProtectedError(refusal);
    mockStopContainer.mockRejectedValue(error);
    mockRestartContainer.mockRejectedValue(error);

    const res = await request(app)
      .post(`/api/containers/${'b'.repeat(12)}/${action}`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'docker_endpoint_protected', reason: 'provider' });
  });

  it('refuses a stack stop whose container batch holds the endpoint container before stopping any sibling', async () => {
    const { DockerEndpointProtectedError } = await import('../helpers/dockerEndpointGuard');
    mockEvaluate.mockResolvedValue(null);
    mockGetContainersByStack.mockResolvedValue([
      { Id: 'c1', Labels: { 'com.docker.compose.service': 'web' } },
      { Id: 'c2', Labels: { 'com.docker.compose.service': 'socket-proxy' } },
    ]);
    mockAssertNoEndpointContainers.mockRejectedValue(new DockerEndpointProtectedError(refusal));

    const res = await request(app).post('/api/stacks/infra/stop').set('Cookie', authCookie);

    expect(res.status).not.toBe(200);
    expect(mockAssertNoEndpointContainers).toHaveBeenCalledWith(['c1', 'c2'], 'stop');
    expect(mockStopContainer).not.toHaveBeenCalled();
  });

  it('still reports an ordinary Docker failure as 500', async () => {
    mockStopContainer.mockRejectedValue(new Error('no such container'));

    const res = await request(app)
      .post(`/api/containers/${'c'.repeat(12)}/stop`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(500);
  });
});
