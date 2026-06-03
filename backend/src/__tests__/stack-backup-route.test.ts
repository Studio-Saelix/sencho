/**
 * Integration tests for POST /api/stacks/:stackName/backup, the on-demand
 * stack-files backup trigger. Covers auth, role, paid gating, the success
 * path, the missing-stack 404, name validation, and error propagation. The
 * route exists so a scheduled auto_backup can run on a remote node through the
 * proxy path, and so an operator can take a snapshot on demand.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

const { mockBackupStackFiles, mockHasComposeFile } = vi.hoisted(() => ({
  mockBackupStackFiles: vi.fn(),
  mockHasComposeFile: vi.fn(),
}));

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: () => ({
      getBaseDir: () => '/tmp/compose',
      hasComposeFile: mockHasComposeFile,
      backupStackFiles: mockBackupStackFiles,
      getStacks: vi.fn().mockResolvedValue([]),
    }),
  },
}));

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let adminCookie: string;
let viewerCookie: string;
let tierSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));

  const { LicenseService } = await import('../services/LicenseService');
  tierSpy = vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('admiral');

  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);

  const viewerHash = await bcrypt.hash('viewerpass', 1);
  DatabaseService.getInstance().addUser({ username: 'backup-viewer', password_hash: viewerHash, role: 'viewer' });
  const viewerRes = await request(app).post('/api/auth/login').send({ username: 'backup-viewer', password: 'viewerpass' });
  const cookies = viewerRes.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  mockBackupStackFiles.mockReset().mockResolvedValue(undefined);
  mockHasComposeFile.mockReset().mockResolvedValue(true);
  tierSpy.mockReturnValue('paid');
});

describe('POST /api/stacks/:stackName/backup', () => {
  it('backs up the stack files and returns success', async () => {
    const res = await request(app).post('/api/stacks/web/backup').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockBackupStackFiles).toHaveBeenCalledWith('web');
  });

  it('returns 401 without an auth cookie', async () => {
    const res = await request(app).post('/api/stacks/web/backup');
    expect(res.status).toBe(401);
    expect(mockBackupStackFiles).not.toHaveBeenCalled();
  });

  it('returns 403 for a viewer (no deploy permission)', async () => {
    const res = await request(app).post('/api/stacks/web/backup').set('Cookie', viewerCookie);
    expect(res.status).toBe(403);
    expect(mockBackupStackFiles).not.toHaveBeenCalled();
  });

  it('returns 403 on the community tier', async () => {
    tierSpy.mockReturnValue('community');
    const res = await request(app).post('/api/stacks/web/backup').set('Cookie', adminCookie);
    expect(res.status).toBe(403);
    expect(mockBackupStackFiles).not.toHaveBeenCalled();
  });

  it('returns 404 when the stack does not exist', async () => {
    mockHasComposeFile.mockResolvedValue(false);
    const res = await request(app).post('/api/stacks/ghost/backup').set('Cookie', adminCookie);
    expect(res.status).toBe(404);
    expect(mockBackupStackFiles).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid stack name', async () => {
    const res = await request(app).post('/api/stacks/..bad../backup').set('Cookie', adminCookie);
    expect(res.status).toBe(400);
    expect(mockBackupStackFiles).not.toHaveBeenCalled();
  });

  it('returns 500 when the backup operation fails', async () => {
    mockBackupStackFiles.mockRejectedValue(new Error('disk full'));
    const res = await request(app).post('/api/stacks/web/backup').set('Cookie', adminCookie);
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('disk full');
  });

  it('returns 409 when the stack is busy with another operation', async () => {
    // The backup shares the rollback slot, so it must not run while a deploy
    // holds the stack-op lock for the same stack.
    const { StackOpLockService } = await import('../services/StackOpLockService');
    const localNodeId = DatabaseService.getInstance().getNodes().find(n => n.type === 'local')!.id;
    StackOpLockService.getInstance().tryAcquire(localNodeId, 'web', 'deploy', 'someone');
    try {
      const res = await request(app).post('/api/stacks/web/backup').set('Cookie', adminCookie);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('stack_op_in_progress');
      expect(mockBackupStackFiles).not.toHaveBeenCalled();
    } finally {
      StackOpLockService.getInstance().release(localNodeId, 'web');
    }
  });
});
