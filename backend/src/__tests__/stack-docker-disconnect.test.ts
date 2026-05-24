/**
 * Integration tests for Docker-daemon disconnect handling on stack lifecycle
 * routes. When the engine socket is unreachable, the lifecycle routes must
 * return a structured 503 envelope with `code: docker_unavailable` so the UI
 * can surface a "Docker is down" message instead of raw ECONNREFUSED text.
 *
 * Disconnect is simulated by injecting ECONNREFUSED at the Dockerode test
 * seam (DockerController.getInstance(...).getContainersByStack throws) and at
 * the ComposeService spawn path (deploy/down/update rejection with the same
 * error shape). Both shapes flow through isDockerUnavailableError in the
 * route layer.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { isDockerUnavailableError } from '../routes/stacks';

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

beforeEach(() => {
  mockDeployStack.mockReset();
  mockRunCommand.mockReset();
  mockUpdateStack.mockReset();
  mockGetContainersByStack.mockReset();
  mockRestartContainer.mockReset();
  mockStopContainer.mockReset();
  mockStartContainer.mockReset();
});

/** Build an Error that mimics the shape Dockerode throws on socket failure. */
function dockerSocketDownError(): NodeJS.ErrnoException {
  const err = Object.assign(new Error('connect ECONNREFUSED /var/run/docker.sock'), {
    code: 'ECONNREFUSED',
    errno: -111,
    syscall: 'connect',
    address: '/var/run/docker.sock',
  }) as NodeJS.ErrnoException;
  return err;
}

/** Build an Error that mimics docker compose CLI output when dockerd is down. */
function composeDaemonDownError(): Error {
  return new Error(
    'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
  );
}

describe('isDockerUnavailableError helper', () => {
  it('matches plain ECONNREFUSED node errors', () => {
    expect(isDockerUnavailableError(dockerSocketDownError())).toBe(true);
  });

  it('matches docker compose CLI "cannot connect to the Docker daemon" output', () => {
    expect(isDockerUnavailableError(composeDaemonDownError())).toBe(true);
  });

  it('matches docker.sock ENOENT errors', () => {
    const err = Object.assign(new Error('ENOENT: no such file or directory, connect /var/run/docker.sock'), {
      code: 'ENOENT',
    });
    expect(isDockerUnavailableError(err)).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isDockerUnavailableError(new Error('image pull failed: manifest unknown'))).toBe(false);
    expect(isDockerUnavailableError(new Error('compose YAML parse error'))).toBe(false);
    expect(isDockerUnavailableError(null)).toBe(false);
    expect(isDockerUnavailableError(undefined)).toBe(false);
  });
});

describe('POST /api/stacks/:name/restart with daemon down', () => {
  it('returns 503 with code: docker_unavailable when Dockerode listContainers refuses', async () => {
    mockGetContainersByStack.mockRejectedValue(dockerSocketDownError());

    const res = await request(app)
      .post('/api/stacks/web/restart')
      .set('Cookie', authCookie);

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'docker_unavailable' });
    expect(res.body.error).toMatch(/ECONNREFUSED|docker daemon|unreachable/i);
  });

  it('still returns 503 on stop when the daemon is down', async () => {
    mockGetContainersByStack.mockRejectedValue(dockerSocketDownError());

    const res = await request(app)
      .post('/api/stacks/web/stop')
      .set('Cookie', authCookie);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('docker_unavailable');
  });

  it('still returns 503 on start when the daemon is down', async () => {
    mockGetContainersByStack.mockRejectedValue(dockerSocketDownError());

    const res = await request(app)
      .post('/api/stacks/web/start')
      .set('Cookie', authCookie);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('docker_unavailable');
  });
});

describe('POST /api/stacks/:name/deploy with daemon down', () => {
  it('returns 503 with code: docker_unavailable when ComposeService surfaces the daemon error', async () => {
    mockDeployStack.mockRejectedValue(composeDaemonDownError());

    const res = await request(app)
      .post('/api/stacks/web/deploy')
      .set('Cookie', authCookie)
      .send({ skip_scan: true });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('docker_unavailable');
    expect(res.body.error).toMatch(/Cannot connect to the Docker daemon|unreachable/i);
  });

  it('still returns 500 (not 503) for unrelated deploy failures', async () => {
    mockDeployStack.mockRejectedValue(new Error('compose YAML parse error'));

    const res = await request(app)
      .post('/api/stacks/web/deploy')
      .set('Cookie', authCookie)
      .send({ skip_scan: true });

    expect(res.status).toBe(500);
    expect(res.body.code).toBeUndefined();
  });
});

describe('POST /api/stacks/:name/down with daemon down', () => {
  it('returns 503 with code: docker_unavailable when runCommand surfaces the daemon error', async () => {
    mockRunCommand.mockRejectedValue(composeDaemonDownError());

    const res = await request(app)
      .post('/api/stacks/web/down')
      .set('Cookie', authCookie);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('docker_unavailable');
  });
});

describe('POST /api/stacks/:name/update with daemon down', () => {
  it('returns 503 with code: docker_unavailable when updateStack surfaces the daemon error', async () => {
    mockUpdateStack.mockRejectedValue(composeDaemonDownError());

    const res = await request(app)
      .post('/api/stacks/web/update')
      .set('Cookie', authCookie)
      .send({ skip_scan: true });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('docker_unavailable');
  });
});
