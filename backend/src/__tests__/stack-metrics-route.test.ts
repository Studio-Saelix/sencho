/**
 * Integration tests for GET /api/stack-metrics. Admin-only endpoint
 * surfacing the in-process snapshot from StackOpMetricsService.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

beforeEach(async () => {
  const { StackOpMetricsService } = await import('../services/StackOpMetricsService');
  StackOpMetricsService.resetForTests();
});

describe('GET /api/stack-metrics', () => {
  it('returns 401 without an auth cookie', async () => {
    const res = await request(app).get('/api/stack-metrics');
    expect(res.status).toBe(401);
  });

  it('returns an empty array on a fresh process', async () => {
    const res = await request(app).get('/api/stack-metrics').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries: [] });
  });

  it('returns recorded entries with the expected shape', async () => {
    const { StackOpMetricsService } = await import('../services/StackOpMetricsService');
    const svc = StackOpMetricsService.getInstance();
    svc.record(1, 'deploy', 100, true);
    svc.record(1, 'deploy', 200, false);
    svc.record(2, 'restart', 50, true);

    const res = await request(app).get('/api/stack-metrics').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries[0]).toMatchObject({
      nodeId: 1,
      action: 'deploy',
      count: 2,
      successCount: 1,
      errorCount: 1,
      avgMs: 150,
    });
    expect(typeof res.body.entries[0].p50Ms).toBe('number');
    expect(typeof res.body.entries[0].p95Ms).toBe('number');
  });
});
