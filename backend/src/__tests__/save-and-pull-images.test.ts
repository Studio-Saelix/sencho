/**
 * Route tests for POST /api/stacks/:stackName/pull-images.
 *
 * The action acquires registry images and stops: it never runs `up`, restarts,
 * recreates, or builds. Two halves of that contract are testable at this layer:
 * the paired permission gate, and the 409 raised when an image pull already
 * holds the stack.
 *
 * No role in the matrix holds stack:edit without stack:deploy, so the persona
 * cases strip one action off node-admin at a time. The subject stays identical
 * across all three cases, which makes the stripped action the only variable.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import {
  setupTestDb,
  cleanupTestDb,
  loginAsTestAdmin,
  TEST_JWT_SECRET,
} from './helpers/setupTestDb';
import { ROLE_PERMISSIONS, type PermissionAction } from '../middleware/permissions';

const { mockPullStackImages, mockGetContainersByStack } = vi.hoisted(() => ({
  mockPullStackImages: vi.fn(),
  mockGetContainersByStack: vi.fn(),
}));

vi.mock('../services/ComposeService', async () => {
  const actual = await vi.importActual<typeof import('../services/ComposeService')>(
    '../services/ComposeService',
  );
  return {
    ...actual,
    ComposeService: {
      ...actual.ComposeService,
      getInstance: () => ({ pullStackImages: mockPullStackImages }),
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
      getInstance: () => ({ getContainersByStack: mockGetContainersByStack }),
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
let adminCookie: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  // authGate resolves a Bearer subject against a user row, so the persona the
  // permission-gate cases strip actions from has to exist.
  const { DatabaseService } = await import('../services/DatabaseService');
  DatabaseService.getInstance().addUser({
    username: 'node-admin',
    password_hash: 'test',
    role: 'node-admin',
  });
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

beforeEach(async () => {
  mockPullStackImages.mockReset();
  mockGetContainersByStack.mockReset();
  const { StackOpLockService } = await import('../services/StackOpLockService');
  StackOpLockService.resetForTests();
});

function nodeAdminToken(): string {
  return jwt.sign(
    { username: 'node-admin', role: 'node-admin' },
    TEST_JWT_SECRET,
    { expiresIn: '1m' },
  );
}

/** Runs `fn` with one action stripped from node-admin's matrix, restoring after. */
async function withoutNodeAdminAction<T>(
  action: PermissionAction,
  fn: () => Promise<T>,
): Promise<T> {
  const original = ROLE_PERMISSIONS['node-admin'];
  ROLE_PERMISSIONS['node-admin'] = original.filter((permission) => permission !== action);
  try {
    return await fn();
  } finally {
    ROLE_PERMISSIONS['node-admin'] = original;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('POST /api/stacks/:stackName/pull-images permission gate', () => {
  it('refuses a subject without stack:edit before the handler runs', async () => {
    const res = await withoutNodeAdminAction('stack:edit', () =>
      request(app)
        .post('/api/stacks/web/pull-images')
        .set('Authorization', `Bearer ${nodeAdminToken()}`),
    );

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Permission denied.', code: 'PERMISSION_DENIED' });
    expect(mockPullStackImages).not.toHaveBeenCalled();
  });

  it('refuses a subject that holds stack:edit but not stack:deploy', async () => {
    const res = await withoutNodeAdminAction('stack:deploy', () =>
      request(app)
        .post('/api/stacks/web/pull-images')
        .set('Authorization', `Bearer ${nodeAdminToken()}`),
    );

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Permission denied.', code: 'PERMISSION_DENIED' });
    expect(mockPullStackImages).not.toHaveBeenCalled();
  });

  it('allows the same subject once it holds both actions', async () => {
    mockPullStackImages.mockResolvedValueOnce({ skippedBuildBacked: [] });

    const res = await request(app)
      .post('/api/stacks/web/pull-images')
      .set('Authorization', `Bearer ${nodeAdminToken()}`);

    expect(res.status).toBe(200);
    expect(mockPullStackImages).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/stacks/:stackName/pull-images', () => {
  it('returns the skip list when the pull succeeds', async () => {
    mockPullStackImages.mockResolvedValueOnce({ skippedBuildBacked: ['app'] });

    const res = await request(app)
      .post('/api/stacks/web/pull-images')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      message: 'Pulled registry images',
      skippedBuildBacked: ['app'],
    });
    expect(mockPullStackImages).toHaveBeenCalledTimes(1);
    expect(mockPullStackImages.mock.calls[0][0]).toBe('web');
  });

  it('returns 409 naming the in-flight pull while the first request runs', async () => {
    const gate = deferred<{ skippedBuildBacked: string[] }>();
    mockPullStackImages.mockImplementationOnce(() => gate.promise);

    const first = request(app)
      .post('/api/stacks/web/pull-images')
      .set('Cookie', adminCookie)
      .then(r => r);
    await vi.waitFor(() => expect(mockPullStackImages).toHaveBeenCalled());

    const second = await request(app)
      .post('/api/stacks/web/pull-images')
      .set('Cookie', adminCookie);

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('stack_op_in_progress');
    expect(second.body.inProgress.action).toBe('image_pull');
    expect(second.body.error).toMatch(/already pulling images/);

    gate.resolve({ skippedBuildBacked: [] });
    expect((await first).status).toBe(200);
  });

  it('returns 500 and frees the stack when the pull fails', async () => {
    mockPullStackImages.mockRejectedValueOnce(new Error('manifest unknown'));

    const failed = await request(app)
      .post('/api/stacks/web/pull-images')
      .set('Cookie', adminCookie);

    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe('manifest unknown');

    const { StackOpLockService } = await import('../services/StackOpLockService');
    expect(StackOpLockService.getInstance().size()).toBe(0);

    mockPullStackImages.mockResolvedValueOnce({ skippedBuildBacked: [] });
    const retry = await request(app)
      .post('/api/stacks/web/pull-images')
      .set('Cookie', adminCookie);
    expect(retry.status).toBe(200);
  });

  it('logs the pull failure without line breaks and keeps the compose lines apart', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Compose reports a failed pull as multi-line output, so an entry that
    // keeps those breaks would let image or registry text forge new lines.
    mockPullStackImages.mockRejectedValueOnce(new Error('manifest unknown\n[INFO] forged entry'));

    const failed = await request(app)
      .post('/api/stacks/web/pull-images')
      .set('Cookie', adminCookie);

    expect(failed.status).toBe(500);
    const logged = errorSpy.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toMatch(/[\r\n]/);
    expect(logged).toContain('manifest unknown | [INFO] forged entry');
    errorSpy.mockRestore();
  });
});
