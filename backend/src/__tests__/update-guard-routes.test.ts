/**
 * Route-level tests for the update guard endpoints: the readiness GETs on the
 * stacks router and the fleet snapshot coverage lookup. UpdateGuardService and
 * FileSystemService are mocked; the focus is auth, validation, route
 * placement, and response shape.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

const {
  mockComputeUpdateReadiness,
  mockComputeRollbackReadiness,
} = vi.hoisted(() => ({
  mockComputeUpdateReadiness: vi.fn(),
  mockComputeRollbackReadiness: vi.fn(),
}));

vi.mock('../services/UpdateGuardService', () => ({
  UpdateGuardService: {
    getInstance: () => ({
      computeUpdateReadiness: mockComputeUpdateReadiness,
      computeRollbackReadiness: mockComputeRollbackReadiness,
    }),
  },
}));

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: () => ({
      getStacks: vi.fn().mockResolvedValue([]),
      getBaseDir: () => '/tmp/compose',
      hasComposeFile: vi.fn().mockResolvedValue(true),
    }),
  },
}));

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;
let viewerCookie: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);

  const { DatabaseService } = await import('../services/DatabaseService');
  const viewerHash = await bcrypt.hash('viewerpass', 1);
  DatabaseService.getInstance().addUser({ username: 'guard-viewer', password_hash: viewerHash, role: 'viewer' });
  const viewerRes = await request(app).post('/api/auth/login').send({ username: 'guard-viewer', password: 'viewerpass' });
  const cookies = viewerRes.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  mockComputeUpdateReadiness.mockReset();
  mockComputeRollbackReadiness.mockReset();
});

describe('GET /api/stacks/:stackName/update-readiness', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/stacks/web/update-readiness');
    expect(res.status).toBe(401);
    expect(mockComputeUpdateReadiness).not.toHaveBeenCalled();
  });

  it('returns the computed report', async () => {
    const report = { stack: 'web', computedAt: 1, verdict: 'ready', signals: [] };
    mockComputeUpdateReadiness.mockResolvedValue(report);
    const res = await request(app).get('/api/stacks/web/update-readiness').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(report);
  });

  it('returns a clean 500 when the computation fails', async () => {
    mockComputeUpdateReadiness.mockRejectedValue(new Error('docker exploded'));
    const res = await request(app).get('/api/stacks/web/update-readiness').set('Cookie', authCookie);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to compute update readiness' });
  });
});

describe('GET /api/stacks/:stackName/rollback-readiness', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/stacks/web/rollback-readiness');
    expect(res.status).toBe(401);
    expect(mockComputeRollbackReadiness).not.toHaveBeenCalled();
  });

  it('returns the computed report', async () => {
    const report = { stack: 'web', computedAt: 1, overall: 'partial', items: [] };
    mockComputeRollbackReadiness.mockResolvedValue(report);
    const res = await request(app).get('/api/stacks/web/rollback-readiness').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(report);
  });

  it('returns a clean 500 when the computation fails', async () => {
    mockComputeRollbackReadiness.mockRejectedValue(new Error('boom'));
    const res = await request(app).get('/api/stacks/web/rollback-readiness').set('Cookie', authCookie);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to compute rollback readiness' });
  });
});

describe('GET /api/fleet/snapshots/coverage', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/fleet/snapshots/coverage?nodeId=0&stackName=web');
    expect(res.status).toBe(401);
  });

  it('hits the coverage handler, not the /snapshots/:id route', async () => {
    const res = await request(app)
      .get('/api/fleet/snapshots/coverage?nodeId=0&stackName=web')
      .set('Cookie', authCookie);
    // The /:id handler would have rejected "coverage" as a bad snapshot ID;
    // the coverage handler returns the latestAt shape instead.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ latestAt: null });
  });

  it('scopes coverage to the requested node and stack', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    const matching = db.createSnapshot('covers web on node 0', 'tester', 1, 1, '[]');
    db.insertSnapshotFiles(matching, [
      { nodeId: 0, nodeName: 'local', stackName: 'web', filename: 'compose.yaml', content: 'services: {}' },
    ]);
    const decoy = db.createSnapshot('covers other things', 'tester', 2, 2, '[]');
    db.insertSnapshotFiles(decoy, [
      { nodeId: 1, nodeName: 'remote', stackName: 'web', filename: 'compose.yaml', content: 'services: {}' },
      { nodeId: 0, nodeName: 'local', stackName: 'other', filename: 'compose.yaml', content: 'services: {}' },
    ]);
    const matchingCreatedAt = db.getSnapshots().find(s => s.id === matching)!.created_at;

    const res = await request(app)
      .get('/api/fleet/snapshots/coverage?nodeId=0&stackName=web')
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ latestAt: matchingCreatedAt });
  });

  it('rejects non-admin users', async () => {
    const res = await request(app)
      .get('/api/fleet/snapshots/coverage?nodeId=0&stackName=web')
      .set('Cookie', viewerCookie);
    expect(res.status).toBe(403);
  });

  it('validates nodeId and stackName', async () => {
    const missingNode = await request(app)
      .get('/api/fleet/snapshots/coverage?stackName=web')
      .set('Cookie', authCookie);
    expect(missingNode.status).toBe(400);

    const badNode = await request(app)
      .get('/api/fleet/snapshots/coverage?nodeId=-2&stackName=web')
      .set('Cookie', authCookie);
    expect(badNode.status).toBe(400);

    const badStack = await request(app)
      .get('/api/fleet/snapshots/coverage?nodeId=0&stackName=..%2Fetc')
      .set('Cookie', authCookie);
    expect(badStack.status).toBe(400);
  });
});
