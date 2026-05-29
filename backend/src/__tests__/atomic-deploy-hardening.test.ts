/**
 * Route-level tests for the Atomic Deployments hardening pass.
 *
 * Covers:
 *  - The manual rollback route holds the per-stack lifecycle lock, so it cannot
 *    race a concurrent deploy/update on the same stack (and vice versa).
 *  - Rollback releases the lock after both success and failure.
 *  - Rollback dispatches a notification on success/failure.
 *  - The backup-metadata read and the rollback action are paid-gated, matching
 *    the frontend, which only fetches backup state on a licensed instance.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

const {
  mockDeployStack,
  mockGetBackupInfo,
  mockRestoreStackFiles,
} = vi.hoisted(() => ({
  mockDeployStack: vi.fn(),
  mockGetBackupInfo: vi.fn(),
  mockRestoreStackFiles: vi.fn(),
}));

vi.mock('../services/ComposeService', async () => {
  const actual = await vi.importActual<typeof import('../services/ComposeService')>(
    '../services/ComposeService',
  );
  return {
    ...actual,
    ComposeService: {
      ...actual.ComposeService,
      getInstance: () => ({ deployStack: mockDeployStack }),
    },
  };
});

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: () => ({
      getBaseDir: () => '/tmp/compose',
      hasComposeFile: vi.fn().mockResolvedValue(true),
      getBackupInfo: mockGetBackupInfo,
      restoreStackFiles: mockRestoreStackFiles,
    }),
  },
}));

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;
let LicenseService: typeof import('../services/LicenseService').LicenseService;

function mockTier(tier: 'paid' | 'community') {
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue(tier);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ LicenseService } = await import('../services/LicenseService'));
  authCookie = await loginAsTestAdmin(app);
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

beforeEach(async () => {
  mockDeployStack.mockReset();
  mockGetBackupInfo.mockReset().mockResolvedValue({ exists: true, timestamp: Date.now() });
  mockRestoreStackFiles.mockReset().mockResolvedValue(undefined);
  const { StackOpLockService } = await import('../services/StackOpLockService');
  StackOpLockService.resetForTests();
});

afterEach(() => vi.restoreAllMocks());

describe('Rollback holds the stack lifecycle lock (H-1)', () => {
  it('blocks deploy while a rollback is in flight on the same stack', async () => {
    mockTier('paid');
    const gate = deferred<void>();
    mockDeployStack.mockImplementationOnce(() => gate.promise);

    const rollback = request(app)
      .post('/api/stacks/web/rollback')
      .set('Cookie', authCookie)
      .then(r => r);
    await vi.waitFor(() => expect(mockDeployStack).toHaveBeenCalled());

    const deploy = await request(app)
      .post('/api/stacks/web/deploy')
      .set('Cookie', authCookie)
      .send({ skip_scan: true });
    expect(deploy.status).toBe(409);
    expect(deploy.body.code).toBe('stack_op_in_progress');
    expect(deploy.body.inProgress.action).toBe('rollback');

    gate.resolve();
    const rollbackRes = await rollback;
    expect(rollbackRes.status).toBe(200);
  });

  it('returns 409 when a rollback lands while a deploy is in flight', async () => {
    mockTier('paid');
    const gate = deferred<void>();
    mockDeployStack.mockImplementationOnce(() => gate.promise);

    const deploy = request(app)
      .post('/api/stacks/web/deploy')
      .set('Cookie', authCookie)
      .send({ skip_scan: true })
      .then(r => r);
    await vi.waitFor(() => expect(mockDeployStack).toHaveBeenCalled());

    const rollback = await request(app)
      .post('/api/stacks/web/rollback')
      .set('Cookie', authCookie);
    expect(rollback.status).toBe(409);
    expect(rollback.body.inProgress.action).toBe('deploy');

    gate.resolve();
    await deploy;
  });

  it('releases the lock after a successful rollback', async () => {
    mockTier('paid');
    mockDeployStack.mockResolvedValue(undefined);

    const first = await request(app).post('/api/stacks/web/rollback').set('Cookie', authCookie);
    expect(first.status).toBe(200);

    const second = await request(app).post('/api/stacks/web/rollback').set('Cookie', authCookie);
    expect(second.status).toBe(200);
  });

  it('releases the lock after a failed rollback', async () => {
    mockTier('paid');
    mockDeployStack.mockRejectedValueOnce(new Error('image pull failed'));
    const first = await request(app).post('/api/stacks/web/rollback').set('Cookie', authCookie);
    expect(first.status).toBe(500);

    mockDeployStack.mockResolvedValueOnce(undefined);
    const second = await request(app).post('/api/stacks/web/rollback').set('Cookie', authCookie);
    expect(second.status).toBe(200);
  });
});

describe('Rollback notifications (M-2)', () => {
  it('dispatches a success notification when a rollback completes', async () => {
    mockTier('paid');
    mockDeployStack.mockResolvedValue(undefined);
    const { NotificationService } = await import('../services/NotificationService');
    const spy = vi.spyOn(NotificationService.getInstance(), 'dispatchAlert').mockResolvedValue(undefined);

    const res = await request(app).post('/api/stacks/web/rollback').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    await vi.waitFor(() =>
      expect(spy).toHaveBeenCalledWith(
        'info',
        'deploy_success',
        expect.stringMatching(/rolled back/i),
        expect.objectContaining({ stackName: 'web', actor: expect.any(String) }),
      ),
    );
  });

  it('dispatches a failure notification when a rollback fails', async () => {
    mockTier('paid');
    mockDeployStack.mockRejectedValueOnce(new Error('restore failed'));
    const { NotificationService } = await import('../services/NotificationService');
    const spy = vi.spyOn(NotificationService.getInstance(), 'dispatchAlert').mockResolvedValue(undefined);

    const res = await request(app).post('/api/stacks/web/rollback').set('Cookie', authCookie);
    expect(res.status).toBe(500);
    await vi.waitFor(() =>
      expect(spy).toHaveBeenCalledWith(
        'error',
        'deploy_failure',
        expect.any(String),
        expect.objectContaining({ stackName: 'web', actor: expect.any(String) }),
      ),
    );
  });
});

describe('Rollback returns 404 when no backup exists', () => {
  it('does not touch compose when there is nothing to restore, and releases the lock', async () => {
    mockTier('paid');
    mockGetBackupInfo.mockResolvedValue({ exists: false, timestamp: null });

    const res = await request(app).post('/api/stacks/web/rollback').set('Cookie', authCookie);
    expect(res.status).toBe(404);
    expect(mockRestoreStackFiles).not.toHaveBeenCalled();
    expect(mockDeployStack).not.toHaveBeenCalled();

    // The 404 is an early return inside the try; the finally must still release
    // the lock so the stack is not wedged at 409 afterwards.
    mockGetBackupInfo.mockResolvedValue({ exists: true, timestamp: Date.now() });
    mockDeployStack.mockResolvedValue(undefined);
    const next = await request(app).post('/api/stacks/web/rollback').set('Cookie', authCookie);
    expect(next.status).toBe(200);
  });
});

describe('Developer Mode logging matrix', () => {
  it('only emits rollback diagnostic logs when Developer Mode is enabled', async () => {
    mockTier('paid');
    mockDeployStack.mockResolvedValue(undefined);
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    db.updateGlobalSetting('developer_mode', '0');
    const quiet = await request(app).post('/api/stacks/web/rollback').set('Cookie', authCookie);
    expect(quiet.status).toBe(200);
    expect(logSpy.mock.calls.flat().some(a => typeof a === 'string' && /Rollback initiated/i.test(a))).toBe(false);

    db.updateGlobalSetting('developer_mode', '1');
    const noisy = await request(app).post('/api/stacks/web/rollback').set('Cookie', authCookie);
    expect(noisy.status).toBe(200);
    expect(logSpy.mock.calls.flat().some(a => typeof a === 'string' && /Rollback initiated/i.test(a))).toBe(true);

    db.updateGlobalSetting('developer_mode', '0');
  });
});

describe('Tier gating parity (M-3)', () => {
  it('rejects rollback on community with PAID_REQUIRED', async () => {
    mockTier('community');
    const res = await request(app).post('/api/stacks/web/rollback').set('Cookie', authCookie);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PAID_REQUIRED');
    expect(mockDeployStack).not.toHaveBeenCalled();
  });

  it('rejects GET /backup on community with PAID_REQUIRED', async () => {
    mockTier('community');
    const res = await request(app).get('/api/stacks/web/backup').set('Cookie', authCookie);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PAID_REQUIRED');
  });

  it('returns backup metadata on paid', async () => {
    mockTier('paid');
    mockGetBackupInfo.mockResolvedValue({ exists: true, timestamp: 1700000000000 });
    const res = await request(app).get('/api/stacks/web/backup').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ exists: true, timestamp: 1700000000000 });
  });
});
