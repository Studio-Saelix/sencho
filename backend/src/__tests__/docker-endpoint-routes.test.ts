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
import { allowEveryUpdatePolicy } from './__helpers__/allowingUpdatePolicy';

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

// The policy module holds the ComposeService class from its own import, so the
// getInstance mock above is invisible to it; these tests are about the Docker
// endpoint guard, and the policy has its own suites.
vi.mock('../services/updatePolicy', () => import('./__helpers__/allowingUpdatePolicy').then(m => m.allowingUpdatePolicyModule()));

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
    ['POST', '/api/stacks/infra/services/web/stop', { kind: 'service', service: 'web', restart: false, engineOnly: true }],
    ['POST', '/api/stacks/infra/services/web/restart', { kind: 'service', service: 'web', restart: true, engineOnly: true }],
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

  it('checks the container batch once and lets each container skip its own check', async () => {
    mockEvaluate.mockResolvedValue(null);

    const stop = await request(app).post('/api/stacks/infra/stop').set('Cookie', authCookie);
    const restart = await request(app).post('/api/stacks/infra/restart').set('Cookie', authCookie);

    expect(stop.status).toBe(200);
    expect(restart.status).toBe(200);
    expect(mockAssertNoEndpointContainers).toHaveBeenNthCalledWith(1, ['c1'], 'stop');
    expect(mockAssertNoEndpointContainers).toHaveBeenNthCalledWith(2, ['c1'], 'restart');
    expect(mockStopContainer).toHaveBeenCalledWith('c1', { endpointGuard: 'batch-checked' });
    expect(mockRestartContainer).toHaveBeenCalledWith('c1', { endpointGuard: 'batch-checked' });
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

describe('a refusal that the delete and rollback paths meet after the route check', () => {
  it('maps a refused teardown during DELETE to 409 and keeps the stack', async () => {
    const { DeployedStackDeletionService } = await import('../services/DeployedStackDeletionService');
    mockEvaluate.mockResolvedValue(null);
    const del = vi.spyOn(DeployedStackDeletionService.prototype, 'deleteDeployedStack').mockResolvedValue({
      ok: false,
      code: 'docker_endpoint_protected',
      error: refusal.message,
    });

    const res = await request(app).delete('/api/stacks/infra').set('Cookie', authCookie);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'docker_endpoint_protected', error: refusal.message });
    expect(del).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(process.env.COMPOSE_DIR!, 'infra', 'compose.yaml'))).toBe(true);
    del.mockRestore();
  });

  it('answers a refused recovery restore with 409 and carries the failure class the hub needs', async () => {
    const { StackUpdateRecoveryService } = await import('../services/StackUpdateRecoveryService');
    const { DockerEndpointProtectedError } = await import('../helpers/dockerEndpointGuard');
    mockEvaluate.mockResolvedValue(null);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const recovery = StackUpdateRecoveryService.getInstance();
    vi.spyOn(recovery, 'getCurrent').mockReturnValue({ id: 'rec-1', gitops_generation_id: null } as never);
    vi.spyOn(recovery, 'compensateWithCandidateOutcome').mockRejectedValue(
      Object.assign(new DockerEndpointProtectedError(refusal), { failureClass: 'pre_mutation' }),
    );

    const res = await request(app).post('/api/stacks/infra/rollback').set('Cookie', authCookie);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'docker_endpoint_protected', reason: 'provider', failureClass: 'pre_mutation' });
  });
});

describe('a file-backup rollback whose redeploy the guard refuses', () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  afterEach(() => {
    while (spies.length) spies.pop()?.mockRestore();
    mockDeployStack.mockReset();
  });

  async function arrangeFileBackupRollback() {
    const { StackUpdateRecoveryService } = await import('../services/StackUpdateRecoveryService');
    const { FileSystemService } = await import('../services/FileSystemService');
    const policyGate = await import('../helpers/policyGate');
    mockEvaluate.mockResolvedValue(null);
    const restore = vi.spyOn(FileSystemService.prototype, 'restoreStackFiles').mockResolvedValue(undefined);
    const revert = vi.fn();
    spies.push(
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(StackUpdateRecoveryService.getInstance(), 'getCurrent').mockReturnValue(undefined),
      vi.spyOn(FileSystemService.prototype, 'getBackupInfo').mockResolvedValue({ exists: true } as never),
      restore,
      vi.spyOn(FileSystemService.prototype, 'snapshotStackFiles').mockResolvedValue(revert),
      vi.spyOn(policyGate, 'runPolicyGate').mockResolvedValue(true),
    );
    const { DockerEndpointProtectedError } = await import('../helpers/dockerEndpointGuard');
    mockDeployStack.mockRejectedValue(new DockerEndpointProtectedError(refusal));
    return { restore, revert };
  }

  it('answers 409 and puts the restored files back, since compose never ran', async () => {
    const { restore, revert } = await arrangeFileBackupRollback();
    revert.mockResolvedValue(undefined);

    const res = await request(app).post('/api/stacks/infra/rollback').set('Cookie', authCookie);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'docker_endpoint_protected', reason: 'provider' });
    expect(restore).toHaveBeenCalledTimes(1);
    expect(revert).toHaveBeenCalledTimes(1);
  });

  it('still answers 409 and raises an alert when putting the files back fails', async () => {
    const { revert } = await arrangeFileBackupRollback();
    revert.mockRejectedValue(new Error('disk full'));
    const { NotificationService } = await import('../services/NotificationService');

    const res = await request(app).post('/api/stacks/infra/rollback').set('Cookie', authCookie);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('docker_endpoint_protected');
    // Told in the reply, not only in the alert feed: the files are a mix of the restore and what was there.
    expect(res.body.error).toContain('could not be put back');
    expect(res.body.failureClass).toBe('post_mutation');
    expect(revert).toHaveBeenCalledTimes(1);
    expect(NotificationService.getInstance().dispatchAlert).toHaveBeenCalled();
  });
});

describe('a service-scoped update or restore refused after the route check', () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  afterEach(() => {
    while (spies.length) spies.pop()?.mockRestore();
  });

  // A restore is not an image refresh, so the route calls `restore` rather than
  // `execute`; each case stubs the method its route actually uses.
  const routes = [
    ['update', '/api/stacks/infra/services/web/update', 'execute'],
    ['restore', '/api/stacks/infra/services/web/restore', 'restore'],
  ] as const;

  it.each(routes)('maps a refused %s the orchestrator reports to 409 with the guard code', async (_name, url, method) => {
    const { StackUpdateOrchestrator } = await import('../services/StackUpdateOrchestrator');
    mockEvaluate.mockResolvedValue(null);
    const outcome = {
      kind: 'service_failed' as const,
      code: 'docker_endpoint_protected',
      error: refusal.message,
      serviceName: 'web',
    };
    spies.push(method === 'restore'
      ? vi.spyOn(StackUpdateOrchestrator.getInstance(), 'restore').mockResolvedValue(outcome)
      : vi.spyOn(StackUpdateOrchestrator.getInstance(), 'execute').mockResolvedValue(outcome));

    const res = await request(app).post(url).set('Cookie', authCookie).send({ recoveryId: 'rec-1' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'docker_endpoint_protected', error: refusal.message });
  });

  it.each(routes)('maps a refusal thrown inside the %s to 409, not a generic 500', async (_name, url, method) => {
    const { StackUpdateOrchestrator } = await import('../services/StackUpdateOrchestrator');
    const { DockerEndpointProtectedError } = await import('../helpers/dockerEndpointGuard');
    mockEvaluate.mockResolvedValue(null);
    const rejection = new DockerEndpointProtectedError(refusal);
    spies.push(
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      method === 'restore'
        ? vi.spyOn(StackUpdateOrchestrator.getInstance(), 'restore').mockRejectedValue(rejection)
        : vi.spyOn(StackUpdateOrchestrator.getInstance(), 'execute').mockRejectedValue(rejection),
    );

    const res = await request(app).post(url).set('Cookie', authCookie).send({ recoveryId: 'rec-1' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'docker_endpoint_protected', reason: 'provider' });
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
    // The check failed; no refusal was made, so the row is a failed operation, not a protected one.
    expect(infra).toMatchObject({ ok: false, code: 'op_failed' });
    expect(infra.error).toContain('Could not verify');
    expect(blog.ok).toBe(true);
    expect(mockUpdateStack).toHaveBeenCalledTimes(1);
  });

  it('reports a refusal raised inside the lock, after the pre-check passed, as protected rather than failed', async () => {
    mockEvaluate.mockResolvedValue(null);
    const { DockerEndpointProtectedError } = await import('../helpers/dockerEndpointGuard');
    mockUpdateStack.mockRejectedValue(new DockerEndpointProtectedError(refusal));
    const { NotificationService } = await import('../services/NotificationService');

    const res = await request(app)
      .post('/api/stacks/bulk')
      .set('Cookie', authCookie)
      .send({ action: 'update', stackNames: ['infra'] });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ stackName: 'infra', ok: false, code: 'docker_endpoint_protected', error: refusal.message });
    expect(NotificationService.getInstance().dispatchAlert).not.toHaveBeenCalledWith('error', 'deploy_failure', expect.anything(), expect.objectContaining({ stackName: 'infra' }));
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

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'docker_endpoint_protected', reason: 'provider', error: refusal.message });
    expect(mockAssertNoEndpointContainers).toHaveBeenCalledWith(['c1', 'c2'], 'stop');
    expect(mockStopContainer).not.toHaveBeenCalled();
  });

  it('reports a refused container batch in a bulk request as refused, not as a failed operation', async () => {
    const { DockerEndpointProtectedError } = await import('../helpers/dockerEndpointGuard');
    mockEvaluate.mockResolvedValue(null);
    mockAssertNoEndpointContainers.mockRejectedValue(new DockerEndpointProtectedError(refusal));

    const res = await request(app)
      .post('/api/stacks/bulk')
      .set('Cookie', authCookie)
      .send({ action: 'stop', stackNames: ['infra'] });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ stackName: 'infra', ok: false, code: 'docker_endpoint_protected', error: refusal.message });
    expect(mockStopContainer).not.toHaveBeenCalled();
  });

  it('answers 409 when a service action is refused after the route check passed', async () => {
    const { DockerEndpointProtectedError } = await import('../helpers/dockerEndpointGuard');
    mockEvaluate.mockResolvedValue(null);
    mockStopContainer.mockRejectedValue(new DockerEndpointProtectedError(refusal));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await request(app).post('/api/stacks/infra/services/web/stop').set('Cookie', authCookie);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'docker_endpoint_protected', reason: 'provider' });
  });

  it('still reports an ordinary Docker failure as 500', async () => {
    mockStopContainer.mockRejectedValue(new Error('no such container'));

    const res = await request(app)
      .post(`/api/containers/${'c'.repeat(12)}/stop`)
      .set('Cookie', authCookie);

    expect(res.status).toBe(500);
  });
});
