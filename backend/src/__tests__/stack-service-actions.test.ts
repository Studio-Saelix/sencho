/**
 * Integration tests for per-service lifecycle routes:
 *   POST /api/stacks/:stackName/services/:serviceName/restart
 *   POST /api/stacks/:stackName/services/:serviceName/stop
 *   POST /api/stacks/:stackName/services/:serviceName/start
 *
 * Verifies permission gating, name validation, container filtering, fan-out
 * to the correct DockerController method, 404 paths, and error propagation.
 *
 * DockerController is mocked at the service layer so no real Docker daemon
 * is required. All other external dependencies are stubbed in kind.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

// ── Hoisted mocks (must come before importing the app) ──────────────────────

const {
  mockGetContainersByStack,
  mockRestartContainer,
  mockStopContainer,
  mockStartContainer,
} = vi.hoisted(() => ({
  mockGetContainersByStack: vi.fn(),
  mockRestartContainer: vi.fn(),
  mockStopContainer: vi.fn(),
  mockStartContainer: vi.fn(),
}));

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
      getStacks: vi.fn().mockResolvedValue([]),
      getBaseDir: () => '/tmp/compose',
      readComposeFile: vi.fn().mockResolvedValue(''),
    }),
  },
}));

// ── Container fixture helpers ───────────────────────────────────────────────

interface ContainerFixture {
  Id: string;
  Service: string;
  Names: string[];
  State: string;
  Status: string;
  Ports: { PrivatePort: number; PublicPort: number }[];
}

function makeContainer(id: string, service: string): ContainerFixture {
  return {
    Id: id,
    Service: service,
    Names: [`/${service}`],
    State: 'running',
    Status: 'Up 1 second',
    Ports: [],
  };
}

// ── Setup ───────────────────────────────────────────────────────────────────

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;
let viewerCookie: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);

  const viewerHash = await bcrypt.hash('viewerpass', 1);
  DatabaseService.getInstance().addUser({ username: 'svc-viewer', password_hash: viewerHash, role: 'viewer' });
  const viewerRes = await request(app).post('/api/auth/login').send({ username: 'svc-viewer', password: 'viewerpass' });
  const cookies = viewerRes.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  mockGetContainersByStack.mockReset();
  mockRestartContainer.mockReset();
  mockStopContainer.mockReset();
  mockStartContainer.mockReset();

  // Default: no containers found (safe baseline for tests that set their own value)
  mockGetContainersByStack.mockResolvedValue([]);

  // Default: operations resolve successfully
  mockRestartContainer.mockResolvedValue(undefined);
  mockStopContainer.mockResolvedValue(undefined);
  mockStartContainer.mockResolvedValue(undefined);
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('POST /api/stacks/:stackName/services/:serviceName/restart', () => {
  it('happy path: restarts matched container, ignores other services', async () => {
    const appContainer = makeContainer('container-app-1', 'app');
    const dbContainer = makeContainer('container-db-1', 'db');
    mockGetContainersByStack.mockResolvedValue([appContainer, dbContainer]);

    const res = await request(app)
      .post('/api/stacks/web/services/app/restart')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(1);

    expect(mockRestartContainer).toHaveBeenCalledTimes(1);
    expect(mockRestartContainer).toHaveBeenCalledWith('container-app-1');
    expect(mockRestartContainer).not.toHaveBeenCalledWith('container-db-1');
  });

  it('matches smartFallback containers when Service is empty but container name equals service', async () => {
    mockGetContainersByStack.mockResolvedValue([
      {
        Id: 'container-mariadb-1',
        Service: '',
        Names: ['/mariadb'],
        State: 'running',
        Status: 'Up 12 days',
        Ports: [],
      },
      makeContainer('container-phpmyadmin-1', 'phpmyadmin'),
    ]);

    const res = await request(app)
      .post('/api/stacks/db-compose/services/mariadb/restart')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(mockRestartContainer).toHaveBeenCalledWith('container-mariadb-1');
  });
});

describe('POST /api/stacks/:stackName/services/:serviceName/stop', () => {
  it('happy path: stops matched container only', async () => {
    const appContainer = makeContainer('container-app-1', 'app');
    const dbContainer = makeContainer('container-db-1', 'db');
    mockGetContainersByStack.mockResolvedValue([appContainer, dbContainer]);

    const res = await request(app)
      .post('/api/stacks/web/services/app/stop')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(1);

    expect(mockStopContainer).toHaveBeenCalledTimes(1);
    expect(mockStopContainer).toHaveBeenCalledWith('container-app-1');
    expect(mockStopContainer).not.toHaveBeenCalledWith('container-db-1');
  });
});

describe('POST /api/stacks/:stackName/services/:serviceName/start', () => {
  it('happy path: starts matched container only', async () => {
    const appContainer = makeContainer('container-app-1', 'app');
    const dbContainer = makeContainer('container-db-1', 'db');
    mockGetContainersByStack.mockResolvedValue([appContainer, dbContainer]);

    const res = await request(app)
      .post('/api/stacks/web/services/app/start')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(1);

    expect(mockStartContainer).toHaveBeenCalledTimes(1);
    expect(mockStartContainer).toHaveBeenCalledWith('container-app-1');
    expect(mockStartContainer).not.toHaveBeenCalledWith('container-db-1');
  });
});

describe('multi-replica fan-out', () => {
  it('restarts all replicas when multiple containers share the same service name', async () => {
    const containers = [
      makeContainer('container-app-1', 'app'),
      makeContainer('container-app-2', 'app'),
      makeContainer('container-app-3', 'app'),
    ];
    mockGetContainersByStack.mockResolvedValue(containers);

    const res = await request(app)
      .post('/api/stacks/web/services/app/restart')
      .set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(mockRestartContainer).toHaveBeenCalledTimes(3);
    expect(mockRestartContainer).toHaveBeenCalledWith('container-app-1');
    expect(mockRestartContainer).toHaveBeenCalledWith('container-app-2');
    expect(mockRestartContainer).toHaveBeenCalledWith('container-app-3');
  });
});

describe('404 error cases', () => {
  it('returns 404 when requested service is not in the stack', async () => {
    mockGetContainersByStack.mockResolvedValue([
      makeContainer('container-app-1', 'app'),
      makeContainer('container-db-1', 'db'),
    ]);

    const res = await request(app)
      .post('/api/stacks/web/services/nginx/restart')
      .set('Cookie', authCookie);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Service 'nginx' not found in stack 'web'.");
    expect(mockRestartContainer).not.toHaveBeenCalled();
  });

  it('returns 404 when stack has no containers', async () => {
    mockGetContainersByStack.mockResolvedValue([]);

    const res = await request(app)
      .post('/api/stacks/web/services/app/restart')
      .set('Cookie', authCookie);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No containers found for this stack.');
    expect(mockRestartContainer).not.toHaveBeenCalled();
  });
});

describe('400 validation errors', () => {
  it('returns 400 for stack name containing invalid characters', async () => {
    // Express decodes %2F but a literal ".." fails isValidStackName
    const res = await request(app)
      .post('/api/stacks/..invalid../services/app/restart')
      .set('Cookie', authCookie);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid stack name');
  });

  it('returns 400 for invalid service name (starts with hyphen)', async () => {
    const res = await request(app)
      .post('/api/stacks/web/services/-invalid/restart')
      .set('Cookie', authCookie);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid service name');
  });
});

describe('authentication', () => {
  it('returns 401 when request has no auth cookie', async () => {
    const res = await request(app).post('/api/stacks/web/services/app/restart');
    expect(res.status).toBe(401);
  });

  it('returns 403 for viewer role (no write permission)', async () => {
    const res = await request(app)
      .post('/api/stacks/web/services/app/restart')
      .set('Cookie', viewerCookie);

    expect(res.status).toBe(403);
    expect(mockRestartContainer).not.toHaveBeenCalled();
  });
});

describe('Docker error propagation', () => {
  it('returns 500 with the error message when restartContainer rejects', async () => {
    mockGetContainersByStack.mockResolvedValue([makeContainer('container-app-1', 'app')]);
    mockRestartContainer.mockRejectedValue(new Error('daemon error'));

    const res = await request(app)
      .post('/api/stacks/web/services/app/restart')
      .set('Cookie', authCookie);

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('daemon error');
  });
});
