/**
 * Route-level tests for self-stack lifecycle protection. When Sencho's compose
 * project is discovered as a managed stack, destructive lifecycle endpoints
 * return 409 self_stack_protected instead of recreating or removing the instance.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { SELF_STACK_PROTECTED_CODE } from '../helpers/selfStackGuard';

const {
  mockDeployStack,
  mockRunCommand,
  mockRunDown,
  mockUpdateStack,
  mockDownStack,
  mockGetContainersByStack,
  mockStopContainer,
  mockRestartContainer,
  mockGetBulkStackStatuses,
} = vi.hoisted(() => ({
  mockDeployStack: vi.fn(),
  mockRunCommand: vi.fn(),
  mockRunDown: vi.fn(),
  mockUpdateStack: vi.fn(),
  mockDownStack: vi.fn(),
  mockGetContainersByStack: vi.fn(),
  mockStopContainer: vi.fn(),
  mockRestartContainer: vi.fn(),
  mockGetBulkStackStatuses: vi.fn(),
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
        runDown: mockRunDown,
        updateStack: mockUpdateStack,
        downStack: mockDownStack,
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
        getBulkStackStatuses: mockGetBulkStackStatuses,
      }),
    },
  };
});

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;
let SelfIdentityService: typeof import('../services/SelfIdentityService').default;

function writeStack(name: string) {
  const dir = path.join(process.env.COMPOSE_DIR!, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
}

function stubSelfProject(projectName: string | null) {
  const svc = SelfIdentityService.getInstance();
  vi.spyOn(svc, 'initialize').mockResolvedValue(undefined);
  vi.spyOn(svc, 'getIdentity').mockReturnValue({
    containerId: 'a'.repeat(64),
    containerName: 'sencho',
    composeProjectName: projectName,
    imageId: 'b'.repeat(64),
    networkNames: [],
    volumeNames: [],
  });
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ default: SelfIdentityService } = await import('../services/SelfIdentityService'));
  authCookie = await loginAsTestAdmin(app);
  writeStack('sencho');
  writeStack('web');

  const { NotificationService } = await import('../services/NotificationService');
  vi.spyOn(NotificationService.getInstance(), 'dispatchAlert').mockResolvedValue({ persisted: true });
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

afterEach(async () => {
  vi.clearAllMocks();
  SelfIdentityService.getInstance().resetForTesting();
  mockGetContainersByStack.mockResolvedValue([{ Id: 'c1' }]);
  mockRestartContainer.mockResolvedValue(undefined);
  mockStopContainer.mockResolvedValue(undefined);
  mockGetBulkStackStatuses.mockResolvedValue({
    sencho: { status: 'running' },
    web: { status: 'running' },
  });
  const { StackOpLockService } = await import('../services/StackOpLockService');
  StackOpLockService.resetForTests();
});

describe('self stack lifecycle refusal', () => {
  beforeEach(() => {
    stubSelfProject('sencho');
  });

  const protectedEndpoints = [
    ['POST', '/api/stacks/sencho/deploy'],
    ['POST', '/api/stacks/sencho/update'],
    ['POST', '/api/stacks/sencho/down'],
    ['POST', '/api/stacks/sencho/stop'],
    ['POST', '/api/stacks/sencho/rollback'],
    ['POST', '/api/stacks/sencho/services/web/stop'],
    ['DELETE', '/api/stacks/sencho'],
  ] as const;

  it.each(protectedEndpoints)('%s %s returns 409 self_stack_protected', async (method, url) => {
    const res = method === 'DELETE'
      ? await request(app).delete(url).set('Cookie', authCookie)
      : await request(app).post(url).set('Cookie', authCookie);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(SELF_STACK_PROTECTED_CODE);
    expect(mockDeployStack).not.toHaveBeenCalled();
    expect(mockUpdateStack).not.toHaveBeenCalled();
    expect(mockRunCommand).not.toHaveBeenCalled();
    expect(mockRunDown).not.toHaveBeenCalled();
    expect(mockDownStack).not.toHaveBeenCalled();
    expect(mockStopContainer).not.toHaveBeenCalled();
  });

  it('allows restart on the self stack', async () => {
    mockGetContainersByStack.mockResolvedValue([{ Id: 'c1' }]);
    const res = await request(app)
      .post('/api/stacks/sencho/restart')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
  });

  it('allows update on a non-self stack', async () => {
    mockUpdateStack.mockResolvedValue({ recoveryId: null, deployedGenerationId: null });
    const res = await request(app)
      .post('/api/stacks/web/update')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(mockUpdateStack).toHaveBeenCalledWith('web', undefined, true);
  });
});

describe('POST /api/stacks/bulk self stack skip', () => {
  beforeEach(() => {
    stubSelfProject('sencho');
    mockUpdateStack.mockResolvedValue({ recoveryId: null, deployedGenerationId: null });
    mockGetContainersByStack.mockResolvedValue([{ Id: 'c1' }]);
  });

  it('returns self_stack_protected for update/stop on the self stack but allows restart', async () => {
    const updateRes = await request(app)
      .post('/api/stacks/bulk')
      .set('Cookie', authCookie)
      .send({ action: 'update', stackNames: ['sencho', 'web'] });

    expect(updateRes.status).toBe(200);
    const updateRow = updateRes.body.results.find((r: { stackName: string }) => r.stackName === 'sencho');
    const webRow = updateRes.body.results.find((r: { stackName: string }) => r.stackName === 'web');
    expect(updateRow.ok).toBe(false);
    expect(updateRow.code).toBe(SELF_STACK_PROTECTED_CODE);
    expect(webRow.ok).toBe(true);

    const stopRes = await request(app)
      .post('/api/stacks/bulk')
      .set('Cookie', authCookie)
      .send({ action: 'stop', stackNames: ['sencho'] });

    expect(stopRes.body.results[0].code).toBe(SELF_STACK_PROTECTED_CODE);

    const restartRes = await request(app)
      .post('/api/stacks/bulk')
      .set('Cookie', authCookie)
      .send({ action: 'restart', stackNames: ['sencho'] });

    expect(restartRes.body.results[0].ok).toBe(true);
  });
});

describe('GET /api/stacks/statuses isSelf flag', () => {
  it('marks the self stack in the statuses payload', async () => {
    stubSelfProject('sencho');
    const res = await request(app)
      .get('/api/stacks/statuses')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    const senchoKey = Object.keys(res.body).find(k => k.replace(/\.(yml|yaml)$/, '') === 'sencho');
    expect(senchoKey).toBeDefined();
    expect(res.body[senchoKey!].isSelf).toBe(true);
  });
});
