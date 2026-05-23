/**
 * F-6 regression: fleet routes that call estimateSystemReclaim on local
 * nodes must also bound the slow `docker system df` call (8s) and surface
 * a recognizable timeout message to the operator, matching the
 * /api/system/prune/estimate behavior.
 *
 * Covers:
 *  - POST /api/fleet/labels/fleet-prune  with dryRun: true
 *  - POST /api/fleet/prune/estimate
 *
 * Uses real timers because supertest dispatches lazily and the in-route
 * `withTimeout` setTimeout cannot be advanced via vi.useFakeTimers from
 * outside the request lifecycle.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let DockerController: typeof import('../services/DockerController').default;
let FileSystemService: typeof import('../services/FileSystemService').FileSystemService;
let activeBulkActions: typeof import('../routes/labels').activeBulkActions;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ default: DockerController } = await import('../services/DockerController'));
  ({ FileSystemService } = await import('../services/FileSystemService'));
  ({ activeBulkActions } = await import('../routes/labels'));
  // 10-minute expiry survives the file even with two ~8s timeout tests.
  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '10m' });
  authHeader = `Bearer ${token}`;
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => {
  vi.restoreAllMocks();
  activeBulkActions.clear();
});

function stubLocalEstimate(impl: () => Promise<{ reclaimableBytes: number }>) {
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    estimateSystemReclaim: vi.fn().mockImplementation(impl),
    estimateManagedReclaim: vi.fn().mockResolvedValue({ reclaimableBytes: 0 }),
  } as unknown as ReturnType<typeof DockerController.getInstance>);
  vi.spyOn(FileSystemService.prototype, 'getStacks').mockResolvedValue([]);
}

describe('Fleet prune routes bound docker df at 8s on local nodes (F-6)', () => {
  it('POST /api/fleet/labels/fleet-prune dry-run surfaces a busy-daemon error on local timeout', async () => {
    stubLocalEstimate(() => new Promise(() => { /* never resolves */ }));

    const t0 = Date.now();
    const res = await request(app)
      .post('/api/fleet/labels/fleet-prune')
      .set('Authorization', authHeader)
      .send({ targets: ['volumes'], scope: 'all', dryRun: true });
    const elapsed = Date.now() - t0;

    expect(res.status).toBe(200);
    const local = res.body.results[0];
    expect(local.reachable).toBe(true);
    expect(local.targets[0].success).toBe(false);
    expect(local.targets[0].error).toMatch(/Docker daemon is busy/);
    expect(elapsed).toBeGreaterThanOrEqual(7_500);
    expect(elapsed).toBeLessThan(15_000);
  }, 20_000);

  it('POST /api/fleet/prune/estimate marks the local node unreachable with a busy-daemon error on timeout', async () => {
    stubLocalEstimate(() => new Promise(() => { /* never resolves */ }));

    const res = await request(app)
      .post('/api/fleet/prune/estimate')
      .set('Authorization', authHeader)
      .send({ targets: ['volumes'], scope: 'all' });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.perNode)).toBe(true);
    const local = res.body.perNode[0];
    expect(local.reachable).toBe(false);
    expect(local.error).toMatch(/Docker daemon is busy/);
  }, 20_000);

  it('fleet-prune dry-run succeeds normally when estimateSystemReclaim resolves quickly', async () => {
    stubLocalEstimate(() => Promise.resolve({ reclaimableBytes: 256 }));

    const res = await request(app)
      .post('/api/fleet/labels/fleet-prune')
      .set('Authorization', authHeader)
      .send({ targets: ['volumes'], scope: 'all', dryRun: true });

    expect(res.status).toBe(200);
    const local = res.body.results[0];
    expect(local.targets[0]).toMatchObject({ target: 'volumes', success: true, reclaimedBytes: 256, dryRun: true });
  });
});
