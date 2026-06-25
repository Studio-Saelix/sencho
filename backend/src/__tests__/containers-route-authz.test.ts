/**
 * Authorization tests for the container/ports read routes. These reads
 * (`GET /api/containers`, `GET /api/containers/:id/logs`, `GET /api/ports/in-use`)
 * are gated by `requirePermission('stack:read')`, the same read model used across
 * the stacks router. Every shipped role carries `stack:read`, so the denial path
 * is exercised by temporarily removing it from a role at runtime.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let DockerController: typeof import('../services/DockerController').default;
let FileSystemService: typeof import('../services/FileSystemService').FileSystemService;
let ROLE_PERMISSIONS: typeof import('../middleware/permissions').ROLE_PERMISSIONS;

const VIEWER = 'container-read-viewer';
const READ_PATHS = ['/api/containers', '/api/containers/abc123/logs', '/api/ports/in-use'];

/** Sign a viewer JWT using the live token_version so authMiddleware accepts it. */
function viewerToken(): string {
  const user = DatabaseService.getInstance().getUserByUsername(VIEWER)!;
  return jwt.sign({ username: VIEWER, role: 'viewer', tv: user.token_version }, TEST_JWT_SECRET, { expiresIn: '1m' });
}

/**
 * Replace the DockerController / FileSystemService singletons with stubs so the
 * handlers run without a Docker daemon. The logs stub ends the response itself
 * (the real streamContainerLogs flushes SSE headers and streams), so a request
 * that clears the guard resolves instead of hanging. Returns the spies so a test
 * can assert whether a handler ever reached the Docker/FS layer.
 */
function stubDockerAndFs(): { docker: ReturnType<typeof vi.spyOn>; fs: ReturnType<typeof vi.spyOn> } {
  const docker = vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getRunningContainers: vi.fn().mockResolvedValue([]),
    streamContainerLogs: vi.fn().mockImplementation((_id: string, _req: unknown, res: import('express').Response) => {
      res.status(200).end();
      return Promise.resolve();
    }),
    getPortsInUse: vi.fn().mockResolvedValue([]),
  } as unknown as ReturnType<typeof DockerController.getInstance>);
  const fs = vi.spyOn(FileSystemService, 'getInstance').mockReturnValue({
    getStacks: vi.fn().mockResolvedValue([]),
  } as unknown as ReturnType<typeof FileSystemService.getInstance>);
  return { docker, fs };
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ default: DockerController } = await import('../services/DockerController'));
  ({ FileSystemService } = await import('../services/FileSystemService'));
  ({ ROLE_PERMISSIONS } = await import('../middleware/permissions'));
  ({ app } = await import('../index'));

  const hash = await bcrypt.hash('password123', 1);
  DatabaseService.getInstance().addUser({ username: VIEWER, password_hash: hash, role: 'viewer' });
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('container/ports reads deny a role without stack:read', () => {
  let originalViewerPerms: typeof ROLE_PERMISSIONS.viewer;
  let docker: ReturnType<typeof vi.spyOn>;
  let fs: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalViewerPerms = ROLE_PERMISSIONS.viewer;
    ROLE_PERMISSIONS.viewer = originalViewerPerms.filter((p) => p !== 'stack:read');
    ({ docker, fs } = stubDockerAndFs());
  });

  afterEach(() => {
    ROLE_PERMISSIONS.viewer = originalViewerPerms;
  });

  it.each(READ_PATHS)('GET %s is rejected before any Docker work', async (path) => {
    const res = await request(app).get(path).set('Authorization', `Bearer ${viewerToken()}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
    // The guard short-circuits before the handler instantiates the controller. For the
    // logs route this proves the 403 is sent before streamContainerLogs flushes SSE
    // headers (DockerController.ts), since getInstance precedes that flush.
    expect(docker).not.toHaveBeenCalled();
    expect(fs).not.toHaveBeenCalled();
  });
});

describe('container/ports reads admit a role with stack:read', () => {
  beforeEach(() => {
    stubDockerAndFs();
  });

  it.each(READ_PATHS)('GET %s is admitted', async (path) => {
    const res = await request(app).get(path).set('Authorization', `Bearer ${viewerToken()}`);
    expect(res.status).toBe(200);
  });
});

describe('container/ports reads reject unauthenticated requests', () => {
  it.each(READ_PATHS)('GET %s without a token is 401', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(401);
  });
});
