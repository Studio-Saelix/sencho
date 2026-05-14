/**
 * Integration tests verifying that deploy_failure notifications are dispatched
 * when stack action routes encounter errors.
 *
 * Covers: deploy, down, restart, stop, update
 *
 * ComposeService and DockerController are mocked so no real Docker daemon is
 * required. NotificationService.dispatchAlert is spied on to assert dispatch.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { ComposeRollbackError } from '../services/ComposeService';

// ── Hoisted mocks (must come before importing the app) ──────────────────────

const {
  mockDeployStack,
  mockRunCommand,
  mockUpdateStack,
  mockGetContainersByStack,
  mockRestartContainer,
  mockStopContainer,
  mockListContainers,
  mockIsTrivyAvailable,
  mockGetImageDigest,
  mockRunScanAndPersist,
} = vi.hoisted(() => ({
  mockDeployStack: vi.fn(),
  mockRunCommand: vi.fn(),
  mockUpdateStack: vi.fn(),
  mockGetContainersByStack: vi.fn(),
  mockRestartContainer: vi.fn(),
  mockStopContainer: vi.fn(),
  mockListContainers: vi.fn(),
  mockIsTrivyAvailable: vi.fn(),
  mockGetImageDigest: vi.fn(),
  mockRunScanAndPersist: vi.fn(),
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
        getDocker: () => ({
          listContainers: mockListContainers,
        }),
      }),
    },
  };
});

vi.mock('../services/TrivyService', async () => {
  const actual = await vi.importActual<typeof import('../services/TrivyService')>(
    '../services/TrivyService',
  );
  return {
    ...actual,
    default: {
      ...actual.default,
      getInstance: () => ({
        isTrivyAvailable: mockIsTrivyAvailable,
        getImageDigest: mockGetImageDigest,
        runScanAndPersist: mockRunScanAndPersist,
      }),
    },
  };
});

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: () => ({
      getStacks: vi.fn().mockResolvedValue([]),
      getBaseDir: () => '/tmp/compose',
      readComposeFile: vi.fn().mockResolvedValue(''),
    }),
  },
}));

// ── Setup ───────────────────────────────────────────────────────────────────

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;
let dispatchAlertSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);

  const { NotificationService } = await import('../services/NotificationService');
  dispatchAlertSpy = vi
    .spyOn(NotificationService.getInstance(), 'dispatchAlert')
    .mockResolvedValue(undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  mockDeployStack.mockReset();
  mockRunCommand.mockReset();
  mockUpdateStack.mockReset();
  mockGetContainersByStack.mockReset();
  mockRestartContainer.mockReset();
  mockStopContainer.mockReset();
  mockListContainers.mockReset();
  mockIsTrivyAvailable.mockReset();
  mockGetImageDigest.mockReset();
  mockRunScanAndPersist.mockReset();
  mockIsTrivyAvailable.mockReturnValue(true);
  mockListContainers.mockResolvedValue([{ Image: 'nginx:latest' }]);
  mockGetImageDigest.mockResolvedValue(null);
  mockRunScanAndPersist.mockResolvedValue({
    critical_count: 0,
    high_count: 0,
  });
  dispatchAlertSpy.mockClear();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('deploy_failure notification on /deploy error', () => {
  it('dispatches deploy_failure alert with correct stackName when deployStack throws', async () => {
    mockDeployStack.mockRejectedValue(new Error('image pull failed'));

    const res = await request(app)
      .post('/api/stacks/myapp/deploy')
      .set('Cookie', authCookie);

    expect(res.status).toBe(500);

    await new Promise(resolve => setImmediate(resolve));

    expect(dispatchAlertSpy).toHaveBeenCalledWith(
      'error',
      'deploy_failure',
      expect.stringContaining('image pull failed'),
      { stackName: 'myapp' },
    );
  });

  it('includes the error message in the dispatched alert', async () => {
    mockDeployStack.mockRejectedValue(new Error('network timeout'));

    await request(app)
      .post('/api/stacks/webapp/deploy')
      .set('Cookie', authCookie);

    await new Promise(resolve => setImmediate(resolve));

    const call = dispatchAlertSpy.mock.calls[0];
    expect(call[0]).toBe('error');
    expect(call[1]).toBe('deploy_failure');
    expect(call[2]).toContain('network timeout');
    expect(call[3]).toEqual({ stackName: 'webapp' });
  });

  it('returns rolledBack=true only when compose rollback completed', async () => {
    mockDeployStack.mockRejectedValue(
      new ComposeRollbackError(new Error('image pull failed'), true, true),
    );

    const res = await request(app)
      .post('/api/stacks/myapp/deploy')
      .set('Cookie', authCookie);

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ rolledBack: true });
  });

  it('returns rolledBack=false when compose rollback failed', async () => {
    mockDeployStack.mockRejectedValue(
      new ComposeRollbackError(new Error('image pull failed'), true, false),
    );

    const res = await request(app)
      .post('/api/stacks/myapp/deploy')
      .set('Cookie', authCookie);

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ rolledBack: false });
  });

  it('uses trusted proxy tier headers for remote atomic deploys', async () => {
    mockDeployStack.mockResolvedValue(undefined);
    const token = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });

    const res = await request(app)
      .post('/api/stacks/myapp/deploy')
      .set('Authorization', `Bearer ${token}`)
      .set('x-sencho-tier', 'paid')
      .set('x-sencho-variant', 'skipper');

    expect(res.status).toBe(200);
    expect(mockDeployStack.mock.calls[0][2]).toBe(true);
  });
});

describe('post-deploy scan opt-out', () => {
  it('does not trigger a post-deploy scan when skip_scan is true', async () => {
    mockDeployStack.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/stacks/myapp/deploy')
      .set('Cookie', authCookie)
      .send({ skip_scan: true });

    expect(res.status).toBe(200);
    await new Promise(resolve => setImmediate(resolve));

    expect(mockListContainers).not.toHaveBeenCalled();
    expect(mockRunScanAndPersist).not.toHaveBeenCalled();
  });
});

describe('deploy_failure notification on /down error', () => {
  it('dispatches deploy_failure alert when runCommand (down) throws', async () => {
    mockRunCommand.mockRejectedValue(new Error('container removal error'));

    const res = await request(app)
      .post('/api/stacks/myapp/down')
      .set('Cookie', authCookie);

    expect(res.status).toBe(500);

    await new Promise(resolve => setImmediate(resolve));

    expect(dispatchAlertSpy).toHaveBeenCalledWith(
      'error',
      'deploy_failure',
      expect.any(String),
      { stackName: 'myapp' },
    );
  });
});

describe('deploy_failure notification on /restart error', () => {
  it('dispatches deploy_failure alert when restartContainer throws', async () => {
    mockGetContainersByStack.mockResolvedValue([{ Id: 'c1', Service: 'web' }]);
    mockRestartContainer.mockRejectedValue(new Error('restart daemon error'));

    const res = await request(app)
      .post('/api/stacks/myapp/restart')
      .set('Cookie', authCookie);

    expect(res.status).toBe(500);

    await new Promise(resolve => setImmediate(resolve));

    expect(dispatchAlertSpy).toHaveBeenCalledWith(
      'error',
      'deploy_failure',
      expect.stringContaining('restart daemon error'),
      { stackName: 'myapp' },
    );
  });
});

describe('deploy_failure notification on /stop error', () => {
  it('dispatches deploy_failure alert when stopContainer throws', async () => {
    mockGetContainersByStack.mockResolvedValue([{ Id: 'c1', Service: 'web' }]);
    mockStopContainer.mockRejectedValue(new Error('stop daemon error'));

    const res = await request(app)
      .post('/api/stacks/myapp/stop')
      .set('Cookie', authCookie);

    expect(res.status).toBe(500);

    await new Promise(resolve => setImmediate(resolve));

    expect(dispatchAlertSpy).toHaveBeenCalledWith(
      'error',
      'deploy_failure',
      expect.stringContaining('stop daemon error'),
      { stackName: 'myapp' },
    );
  });
});

describe('deploy_failure notification on /update error', () => {
  it('dispatches deploy_failure alert with correct stackName when updateStack throws', async () => {
    mockUpdateStack.mockRejectedValue(new Error('image not found'));

    const res = await request(app)
      .post('/api/stacks/myapp/update')
      .set('Cookie', authCookie);

    expect(res.status).toBe(500);

    await new Promise(resolve => setImmediate(resolve));

    expect(dispatchAlertSpy).toHaveBeenCalledWith(
      'error',
      'deploy_failure',
      expect.stringContaining('image not found'),
      { stackName: 'myapp' },
    );
  });

  it('returns rollback completion status when updateStack throws rollback metadata', async () => {
    mockUpdateStack.mockRejectedValue(
      new ComposeRollbackError(new Error('image not found'), true, false),
    );

    const res = await request(app)
      .post('/api/stacks/myapp/update')
      .set('Cookie', authCookie);

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ rolledBack: false });
  });
});
