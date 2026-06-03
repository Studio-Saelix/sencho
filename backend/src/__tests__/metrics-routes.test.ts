/**
 * Integration tests for metrics and log endpoints.
 *
 * Covers the happy paths that don't require a live Docker daemon:
 *  - GET /api/stats is DOCKER-dependent; we assert it returns 200 or 500
 *    (depending on whether the test host has Docker) but never 4xx.
 *  - GET /api/metrics/historical returns a JSON array.
 *  - GET /api/system/stats returns CPU/memory/disk/network blocks.
 *  - GET /api/system/cache-stats requires admin.
 *  - GET /api/logs/global/stream sets SSE headers.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let adminCookie: string;
let viewerCookie: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));

  const { LicenseService } = await import('../services/LicenseService');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('admiral');
  vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: null, maxViewers: null });

  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);

  const viewerHash = await bcrypt.hash('viewerpass', 1);
  DatabaseService.getInstance().addUser({ username: 'metrics-viewer', password_hash: viewerHash, role: 'viewer' });
  const viewerRes = await request(app).post('/api/auth/login').send({ username: 'metrics-viewer', password: 'viewerpass' });
  const cookies = viewerRes.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => cleanupTestDb(tmpDir));

describe('GET /api/stats', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/stats');
    expect(res.status).toBe(401);
  });

  it('authenticated users get a non-4xx response', async () => {
    // The handler reaches the local Docker daemon; in CI without Docker
    // that surfaces as 500, which is acceptable — we only want to prove
    // auth + routing work.
    const res = await request(app).get('/api/stats').set('Cookie', adminCookie);
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body).toHaveProperty('active');
      expect(res.body).toHaveProperty('total');
      expect(res.body).toHaveProperty('managed');
    }
  });
});

describe('GET /api/metrics/historical', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/metrics/historical');
    expect(res.status).toBe(401);
  });

  it('returns an array for authenticated users', async () => {
    const res = await request(app).get('/api/metrics/historical').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('GET /api/system/stats', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/system/stats');
    expect(res.status).toBe(401);
  });

  it('returns system metrics for authenticated users', async () => {
    const res = await request(app).get('/api/system/stats').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('cpu');
    expect(res.body).toHaveProperty('memory');
    expect(res.body).toHaveProperty('network');
    expect(res.body.cpu).toHaveProperty('cores');
    expect(res.body.memory).toHaveProperty('total');
  });
});

describe('GET /api/system/cache-stats', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/system/cache-stats');
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users with 403', async () => {
    const res = await request(app).get('/api/system/cache-stats').set('Cookie', viewerCookie);
    expect(res.status).toBe(403);
  });

  it('returns cache statistics for admin', async () => {
    const res = await request(app).get('/api/system/cache-stats').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Object);
  });
});

describe('GET /api/logs/global (poll snapshot)', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/logs/global');
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users with 403', async () => {
    const res = await request(app).get('/api/logs/global').set('Cookie', viewerCookie);
    expect(res.status).toBe(403);
  });

  it('admin gets a non-4xx response', async () => {
    // Reaches the Docker daemon; 500 is acceptable in CI without Docker. We
    // only prove the admin gate + routing, not the daemon read.
    const res = await request(app).get('/api/logs/global').set('Cookie', adminCookie);
    expect([200, 500]).toContain(res.status);
    if (res.status === 200) expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('GET /api/system/log-stream-metrics', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/system/log-stream-metrics');
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users with 403', async () => {
    const res = await request(app).get('/api/system/log-stream-metrics').set('Cookie', viewerCookie);
    expect(res.status).toBe(403);
  });

  it('returns the counter snapshot for admin', async () => {
    const res = await request(app).get('/api/system/log-stream-metrics').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('active_sse_connections');
    expect(res.body).toHaveProperty('lines_streamed_total');
    expect(res.body).toHaveProperty('stream_attach_errors_total');
  });
});

describe('GET /api/logs/global/stream', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/logs/global/stream');
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users with 403 before opening the stream', async () => {
    // requireAdmin runs before flushHeaders, so a viewer gets a clean JSON 403
    // rather than a half-open event-stream.
    const res = await request(app).get('/api/logs/global/stream').set('Cookie', viewerCookie);
    expect(res.status).toBe(403);
  });

  it('sets SSE response headers for authenticated users', async () => {
    // The SSE handler writes headers immediately then keeps the connection
    // open. supertest .end() after we see the headers lets Express flush
    // the close listener cleanly.
    const req = request(app).get('/api/logs/global/stream').set('Cookie', adminCookie).buffer(false);
    const res = await new Promise<{ status: number; headers: Record<string, string> }>((resolve, reject) => {
      req.on('response', r => {
        resolve({ status: r.status, headers: r.headers as Record<string, string> });
        r.destroy();
      });
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toContain('no-cache');
    expect(res.headers['x-accel-buffering']).toBe('no');
  });
});
