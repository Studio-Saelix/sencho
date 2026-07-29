/**
 * Route-level tests for prune estimate timeouts (F-6) and the fingerprinted
 * prune plan / stale-409 path used by Resources.
 *
 * Uses real timers because supertest dispatches lazily and vi.useFakeTimers
 * does not compose cleanly with that pattern. Each timeout test waits the
 * full 8s withTimeout budget, so two such tests add ~17s to the file.
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
let CacheService: typeof import('../services/CacheService').CacheService;
let activeBulkActions: typeof import('../helpers/bulkActionLocks').activeBulkActions;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ default: DockerController } = await import('../services/DockerController'));
  ({ FileSystemService } = await import('../services/FileSystemService'));
  ({ CacheService } = await import('../services/CacheService'));
  ({ activeBulkActions } = await import('../helpers/bulkActionLocks'));
  // 10-minute expiry survives the full file even when two timeout tests
  // burn ~8.5s each in real-timer mode.
  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '10m' });
  authHeader = `Bearer ${token}`;
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => {
  activeBulkActions.clear();
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

function samplePlan(fingerprint = 'abc123') {
  return {
    scope: 'managed' as const,
    targets: ['volumes' as const],
    items: [{ target: 'volumes' as const, id: 'v1', name: 'v1', sizeBytes: 42 }],
    reclaimableBytes: 42,
    fingerprint,
    createdAt: Date.now(),
    nodeId: 1,
  };
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
    expect(elapsed).toBeGreaterThanOrEqual(7_500);
    expect(elapsed).toBeLessThan(15_000);
  }, 20_000);

  it('POST /api/system/prune/system dry-run returns 503 docker_df_slow when buildPrunePlan never settles', async () => {
    stubFsStacks();
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      buildPrunePlan: vi.fn().mockImplementation(() => new Promise(() => { /* never resolves */ })),
    } as unknown as ReturnType<typeof DockerController.getInstance>);

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

describe('Prune plan routes', () => {
  it('POST /api/system/prune/plan returns an itemized plan', async () => {
    stubFsStacks();
    const plan = samplePlan('fp-plan');
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      buildPrunePlan: vi.fn().mockResolvedValue(plan),
    } as unknown as ReturnType<typeof DockerController.getInstance>);

    const res = await request(app)
      .post('/api/system/prune/plan')
      .set('Authorization', authHeader)
      .send({ target: 'volumes', scope: 'managed' });

    expect(res.status).toBe(200);
    expect(res.body.fingerprint).toBe('fp-plan');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.reclaimableBytes).toBe(42);
  });

  it('POST /api/system/prune/system with a matching fingerprint executes the plan', async () => {
    stubFsStacks();
    const plan = samplePlan('fp-ok');
    const executePrunePlan = vi.fn().mockResolvedValue({
      outcomes: [{ id: 'v1', target: 'volumes', status: 'removed', sizeBytes: 42 }],
      reclaimedBytes: 42,
      success: true,
    });
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      buildPrunePlan: vi.fn().mockResolvedValue(plan),
      executePrunePlan,
    } as unknown as ReturnType<typeof DockerController.getInstance>);
    const invalidate = vi.spyOn(CacheService.getInstance(), 'invalidate');

    const res = await request(app)
      .post('/api/system/prune/system')
      .set('Authorization', authHeader)
      .send({ target: 'volumes', scope: 'managed', planFingerprint: 'fp-ok' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.reclaimedBytes).toBe(42);
    expect(res.body.outcomes).toHaveLength(1);
    expect(executePrunePlan).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith('stats:1');
    expect(invalidate).toHaveBeenCalledWith('stack-statuses:1');
  });

  it('rejects an overlapping destructive prune on the same node', async () => {
    stubFsStacks();
    const plan = samplePlan('fp-lock');
    let releaseExecution!: () => void;
    const executionBlocked = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const executePrunePlan = vi.fn().mockImplementation(async () => {
      await executionBlocked;
      return { outcomes: [], reclaimedBytes: 0, success: true };
    });
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      buildPrunePlan: vi.fn().mockResolvedValue(plan),
      executePrunePlan,
    } as unknown as ReturnType<typeof DockerController.getInstance>);

    const firstRequest = request(app)
      .post('/api/system/prune/system')
      .set('Authorization', authHeader)
      .send({ target: 'volumes', scope: 'managed', planFingerprint: 'fp-lock' });
    const firstResponse = firstRequest.then((response) => response);
    await vi.waitFor(() => expect(executePrunePlan).toHaveBeenCalledTimes(1));

    const overlapping = await request(app)
      .post('/api/system/prune/system')
      .set('Authorization', authHeader)
      .send({ target: 'volumes', scope: 'managed', planFingerprint: 'fp-lock' });

    expect(overlapping.status).toBe(409);
    expect(overlapping.body.code).toBe('PRUNE_ALREADY_RUNNING');
    expect(executePrunePlan).toHaveBeenCalledTimes(1);

    releaseExecution();
    expect((await firstResponse).status).toBe(200);
    expect(activeBulkActions.size).toBe(0);
  });

  it('POST /api/system/prune/system returns 409 PRUNE_PLAN_STALE on fingerprint mismatch', async () => {
    stubFsStacks();
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      buildPrunePlan: vi.fn().mockResolvedValue(samplePlan('fp-current')),
      executePrunePlan: vi.fn(),
    } as unknown as ReturnType<typeof DockerController.getInstance>);

    const res = await request(app)
      .post('/api/system/prune/system')
      .set('Authorization', authHeader)
      .send({ target: 'volumes', scope: 'managed', planFingerprint: 'fp-stale' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PRUNE_PLAN_STALE');
  });

  it('dry-run returns plan fields without executing deletes', async () => {
    stubFsStacks();
    const plan = samplePlan('fp-dry');
    const executePrunePlan = vi.fn();
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      buildPrunePlan: vi.fn().mockResolvedValue(plan),
      executePrunePlan,
    } as unknown as ReturnType<typeof DockerController.getInstance>);

    const res = await request(app)
      .post('/api/system/prune/system')
      .set('Authorization', authHeader)
      .send({ target: 'volumes', scope: 'managed', dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.fingerprint).toBe('fp-dry');
    expect(res.body.items).toHaveLength(1);
    expect(executePrunePlan).not.toHaveBeenCalled();
  });
});
