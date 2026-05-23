/**
 * Route-level test for F-6: when `docker system df` is slow, the prune
 * estimate endpoints must return 503 with code `docker_df_slow` instead
 * of hanging the admin's tab. Mirrors the pattern from
 * system-maintenance-self-protect.test.ts.
 *
 * Uses real timers because supertest dispatches lazily and vi.useFakeTimers
 * does not compose cleanly with that pattern. Each timeout test waits the
 * full 8s `withTimeout` budget, so two such tests add ~17s to the file.
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

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ default: DockerController } = await import('../services/DockerController'));
  ({ FileSystemService } = await import('../services/FileSystemService'));
  // 10-minute expiry survives the full file even when two timeout tests
  // burn ~8.5s each in real-timer mode.
  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '10m' });
  authHeader = `Bearer ${token}`;
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => {
  vi.restoreAllMocks();
});

function stubFsStacks() {
  vi.spyOn(FileSystemService, 'getInstance').mockReturnValue({
    getStacks: vi.fn().mockResolvedValue([]),
  } as unknown as ReturnType<typeof FileSystemService.getInstance>);
}

function stubEstimate(impl: () => Promise<{ reclaimableBytes: number }>) {
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    estimateSystemReclaim: vi.fn().mockImplementation(impl),
  } as unknown as ReturnType<typeof DockerController.getInstance>);
}

describe('Prune estimate endpoints return 503 on slow docker df (F-6)', () => {
  it('POST /api/system/prune/estimate returns 503 docker_df_slow when estimateSystemReclaim never settles', async () => {
    stubFsStacks();
    stubEstimate(() => new Promise(() => { /* never resolves */ }));

    const t0 = Date.now();
    const res = await request(app)
      .post('/api/system/prune/estimate')
      .set('Authorization', authHeader)
      .send({ target: 'volumes', scope: 'all' });
    const elapsed = Date.now() - t0;

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('docker_df_slow');
    expect(res.body.error).toMatch(/Docker daemon is busy/);
    // Confirm the timeout actually fired (~8s), not an unrelated early
    // 5xx that happened to look right.
    expect(elapsed).toBeGreaterThanOrEqual(7_500);
    expect(elapsed).toBeLessThan(15_000);
  }, 20_000);

  it('POST /api/system/prune/system dry-run returns 503 docker_df_slow when estimateSystemReclaim never settles', async () => {
    stubFsStacks();
    stubEstimate(() => new Promise(() => { /* never resolves */ }));

    const res = await request(app)
      .post('/api/system/prune/system')
      .set('Authorization', authHeader)
      .send({ target: 'volumes', scope: 'all', dryRun: true });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('docker_df_slow');
  }, 20_000);

  it('estimate route succeeds normally when estimateSystemReclaim resolves quickly', async () => {
    stubFsStacks();
    stubEstimate(() => Promise.resolve({ reclaimableBytes: 42 }));

    const res = await request(app)
      .post('/api/system/prune/estimate')
      .set('Authorization', authHeader)
      .send({ target: 'volumes', scope: 'all' });

    expect(res.status).toBe(200);
    expect(res.body.reclaimableBytes).toBe(42);
  });

  it('estimate route returns 5xx (not 503 docker_df_slow) on unrelated daemon error', async () => {
    stubFsStacks();
    stubEstimate(() => Promise.reject(new Error('daemon unreachable')));

    const res = await request(app)
      .post('/api/system/prune/estimate')
      .set('Authorization', authHeader)
      .send({ target: 'volumes', scope: 'all' });

    expect(res.status).toBe(500);
    expect(res.body.code).not.toBe('docker_df_slow');
  });
});
