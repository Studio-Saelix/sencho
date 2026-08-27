/**
 * Integration tests for GET /api/gitops-metrics: the Admin-only snapshot of
 * in-process GitOps transition counters.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let adminCookie: string;
let viewerCookie: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  const { DatabaseService } = await import('../services/DatabaseService');
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);

  const viewerHash = await bcrypt.hash('viewerpass', 1);
  DatabaseService.getInstance().addUser({
    username: 'gitops-metrics-viewer',
    password_hash: viewerHash,
    role: 'viewer',
  });
  const viewerRes = await request(app)
    .post('/api/auth/login')
    .send({ username: 'gitops-metrics-viewer', password: 'viewerpass' });
  const cookies = viewerRes.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

beforeEach(async () => {
  const { GitOpsMetricsService } = await import('../services/GitOpsMetricsService');
  GitOpsMetricsService.resetForTests();
});

describe('GET /api/gitops-metrics', () => {
  it('returns 401 without an auth cookie', async () => {
    const res = await request(app).get('/api/gitops-metrics');
    expect(res.status).toBe(401);
  });

  it('refuses a signed-in non-admin', async () => {
    const res = await request(app).get('/api/gitops-metrics').set('Cookie', viewerCookie);
    expect(res.status).toBe(403);
  });

  it('returns an empty list on a fresh process', async () => {
    const res = await request(app).get('/api/gitops-metrics').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries: [] });
  });

  it('returns one entry per stage and outcome pair', async () => {
    const { GitOpsMetricsService } = await import('../services/GitOpsMetricsService');
    const metrics = GitOpsMetricsService.getInstance();
    metrics.record('fetched', 'committed');
    metrics.record('fetched', 'committed');
    metrics.record('apply_failed', 'failed');

    const res = await request(app).get('/api/gitops-metrics').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([
      { stage: 'apply_failed', outcome: 'failed', count: 1 },
      { stage: 'fetched', outcome: 'committed', count: 2 },
    ]);
  });

  it('names no stack, node, repository or actor', async () => {
    // The counters are process diagnostics, not an audit trail. Anything
    // identifying would be one with no retention policy and no per-row
    // authorization, which is what the history API exists to provide.
    const { GitOpsMetricsService } = await import('../services/GitOpsMetricsService');
    GitOpsMetricsService.getInstance().record('deploy_started', 'committed');

    const res = await request(app).get('/api/gitops-metrics').set('Cookie', adminCookie);
    expect(Object.keys(res.body.entries[0]).sort()).toEqual(['count', 'outcome', 'stage']);
  });
});
