/**
 * Integration tests for GET /api/file-explorer-metrics. Admin-only endpoint
 * surfacing the in-process snapshot from FileExplorerMetricsService.
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
  const { FileExplorerMetricsService } = await import('../services/FileExplorerMetricsService');
  FileExplorerMetricsService.resetForTests();
});

describe('GET /api/file-explorer-metrics', () => {
  it('returns 401 without an auth cookie', async () => {
    const res = await request(app).get('/api/file-explorer-metrics');
    expect(res.status).toBe(401);
  });

  it('returns an empty snapshot on a fresh process', async () => {
    const res = await request(app).get('/api/file-explorer-metrics').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries: [], uploadBytesByNode: [] });
  });

  it('returns recorded entries and upload bytes with the expected shape', async () => {
    const { FileExplorerMetricsService } = await import('../services/FileExplorerMetricsService');
    const svc = FileExplorerMetricsService.getInstance();
    svc.record(1, 'upload', 100, true);
    svc.record(1, 'upload', 200, false);
    svc.record(2, 'read', 50, true);
    svc.recordUploadBytes(1, 1024);
    svc.recordUploadBytes(2, 2048);

    const res = await request(app).get('/api/file-explorer-metrics').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries[0]).toMatchObject({
      nodeId: 1,
      op: 'upload',
      count: 2,
      successCount: 1,
      errorCount: 1,
      avgMs: 150,
    });
    expect(typeof res.body.entries[0].p50Ms).toBe('number');
    expect(typeof res.body.entries[0].p95Ms).toBe('number');
    expect(res.body.uploadBytesByNode).toEqual([
      { nodeId: 1, totalBytes: 1024 },
      { nodeId: 2, totalBytes: 2048 },
    ]);
  });
});
