/**
 * Authorization tests for the stack-specific and fleet container/stack read
 * routes that were previously auth-only (no permission check):
 *   - GET /api/stacks/:stackName/containers
 *   - GET /api/fleet/node/:nodeId/stacks
 *   - GET /api/fleet/node/:nodeId/stacks/:stackName/containers
 *
 * They are now gated by `requirePermission('stack:read')`, the same read model
 * the generic container/port routes and the rest of the stacks router use.
 * Every shipped role carries `stack:read`, so the denial path is exercised by
 * temporarily removing it from a role at runtime.
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

const VIEWER = 'fleet-read-viewer';
let READ_PATHS: string[];

function viewerToken(): string {
  const user = DatabaseService.getInstance().getUserByUsername(VIEWER)!;
  return jwt.sign({ username: VIEWER, role: 'viewer', tv: user.token_version }, TEST_JWT_SECRET, { expiresIn: '1m' });
}

/** Stub the Docker/FS singletons so the admitted path resolves without a daemon. */
function stubDockerAndFs(): { docker: ReturnType<typeof vi.spyOn>; fs: ReturnType<typeof vi.spyOn> } {
  const docker = vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getContainersByStack: vi.fn().mockResolvedValue([]),
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
  const localId = DatabaseService.getInstance().getNodes().find(n => n.is_default)!.id;
  READ_PATHS = [
    '/api/stacks/alpha/containers',
    `/api/fleet/node/${localId}/stacks`,
    `/api/fleet/node/${localId}/stacks/alpha/containers`,
  ];
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stack/fleet container reads deny a role without stack:read', () => {
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

  it('rejects each read before any Docker/FS work', async () => {
    for (const path of READ_PATHS) {
      const res = await request(app).get(path).set('Authorization', `Bearer ${viewerToken()}`);
      expect(res.status, `denied ${path}`).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
    }
    // The guard short-circuits before the handler instantiates the controller.
    expect(docker).not.toHaveBeenCalled();
    expect(fs).not.toHaveBeenCalled();
  });
});

describe('stack/fleet container reads admit a role with stack:read', () => {
  beforeEach(() => {
    stubDockerAndFs();
  });

  it('admits each read', async () => {
    for (const path of READ_PATHS) {
      const res = await request(app).get(path).set('Authorization', `Bearer ${viewerToken()}`);
      expect(res.status, `admitted ${path}`).toBe(200);
    }
  });
});

describe('stack/fleet container reads reject unauthenticated requests', () => {
  it('returns 401 without a token', async () => {
    for (const path of READ_PATHS) {
      const res = await request(app).get(path);
      expect(res.status, `unauth ${path}`).toBe(401);
    }
  });
});
