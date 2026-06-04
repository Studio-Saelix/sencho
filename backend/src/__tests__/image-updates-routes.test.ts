/**
 * Integration tests for /api/image-updates and /api/auto-update/execute.
 * Locks down auth, admin gating, rate limiting, and input validation
 * before extraction.
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

  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);

  const viewerHash = await bcrypt.hash('viewerpass', 1);
  DatabaseService.getInstance().addUser({ username: 'iu-viewer', password_hash: viewerHash, role: 'viewer' });
  const viewerRes = await request(app).post('/api/auth/login').send({ username: 'iu-viewer', password: 'viewerpass' });
  const cookies = viewerRes.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => cleanupTestDb(tmpDir));

describe('GET /api/image-updates', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/image-updates');
    expect(res.status).toBe(401);
  });

  it('returns the current stack update status map for authenticated users', async () => {
    const res = await request(app).get('/api/image-updates').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Object);
  });
});

describe('POST /api/image-updates/refresh', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).post('/api/image-updates/refresh');
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users with 403', async () => {
    const res = await request(app).post('/api/image-updates/refresh').set('Cookie', viewerCookie);
    expect(res.status).toBe(403);
  });

  it('returns 200 or 429 when admin hits it (cooldown-aware)', async () => {
    // Running first: expect 200 unless the service is already mid-refresh
    // or a previous manual trigger set the cooldown. Either way, only 200
    // or 429 are acceptable; 4xx/5xx would indicate a regression.
    const res = await request(app).post('/api/image-updates/refresh').set('Cookie', adminCookie);
    expect([200, 429]).toContain(res.status);
  });
});

describe('GET /api/image-updates/status', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/image-updates/status');
    expect(res.status).toBe(401);
  });

  it('returns a checking flag', async () => {
    const res = await request(app).get('/api/image-updates/status').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(typeof res.body.checking).toBe('boolean');
  });
});

describe('GET /api/image-updates/fleet', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/image-updates/fleet');
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users with 403', async () => {
    // The cross-node aggregation is part of the admin-only readiness surface;
    // the single-node GET / endpoint stays open for the sidebar update dot.
    const res = await request(app).get('/api/image-updates/fleet').set('Cookie', viewerCookie);
    expect(res.status).toBe(403);
  });

  it('returns the fleet-wide aggregation map', async () => {
    const res = await request(app).get('/api/image-updates/fleet').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Object);
  });
});

describe('POST /api/image-updates/fleet/refresh', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).post('/api/image-updates/fleet/refresh');
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users with 403', async () => {
    const res = await request(app).post('/api/image-updates/fleet/refresh').set('Cookie', viewerCookie);
    expect(res.status).toBe(403);
  });

  it('returns triggered/rateLimited/failed arrays for admin caller', async () => {
    const res = await request(app).post('/api/image-updates/fleet/refresh').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.triggered)).toBe(true);
    expect(Array.isArray(res.body.rateLimited)).toBe(true);
    expect(Array.isArray(res.body.failed)).toBe(true);
    // The single local node should land in either triggered (first hit) or
    // rateLimited (cooldown from a prior /refresh in this suite).
    const localNodeBuckets = res.body.triggered.length + res.body.rateLimited.length;
    expect(localNodeBuckets).toBeGreaterThanOrEqual(1);
  });

  it('invalidates the fleet aggregation cache', async () => {
    const { CacheService } = await import('../services/CacheService');
    // Prime the cache by hitting the GET endpoint, then refresh, then
    // confirm the cache key was wiped.
    await request(app).get('/api/image-updates/fleet').set('Cookie', adminCookie);
    expect(CacheService.getInstance().get('fleet-updates')).toBeDefined();
    await request(app).post('/api/image-updates/fleet/refresh').set('Cookie', adminCookie);
    expect(CacheService.getInstance().get('fleet-updates')).toBeUndefined();
  });

  it('still serves a community-licensed admin (no paid gate)', async () => {
    const { LicenseService } = await import('../services/LicenseService');
    const tierSpy = vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    try {
      const res = await request(app).post('/api/image-updates/fleet/refresh').set('Cookie', adminCookie);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.triggered)).toBe(true);
    } finally {
      tierSpy.mockRestore();
      vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    }
  });
});

describe('POST /api/auto-update/execute', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).post('/api/auto-update/execute').send({ target: '*' });
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users with 403', async () => {
    const res = await request(app)
      .post('/api/auto-update/execute')
      .set('Cookie', viewerCookie)
      .send({ target: '*' });
    expect(res.status).toBe(403);
  });

  it('serves a community-licensed admin (no paid gate)', async () => {
    // Auto-update execution is free; an admin on a Community license drives it
    // directly through the API. With no stacks on the fresh instance the handler
    // returns the "no stacks found" summary rather than a 403.
    const { LicenseService } = await import('../services/LicenseService');
    const tierSpy = vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    try {
      const res = await request(app)
        .post('/api/auto-update/execute')
        .set('Cookie', adminCookie)
        .send({ target: '*' });
      expect(res.status).toBe(200);
      expect(typeof res.body.result).toBe('string');
    } finally {
      tierSpy.mockRestore();
      vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    }
  });

  it('rejects missing target with 400', async () => {
    const res = await request(app)
      .post('/api/auto-update/execute')
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing "target"/);
  });

  it('rejects invalid stack name with 400', async () => {
    const res = await request(app)
      .post('/api/auto-update/execute')
      .set('Cookie', adminCookie)
      .send({ target: '../etc/passwd' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid stack name/);
  });

  it('returns a summary string when no stacks exist (target="*")', async () => {
    // On a fresh test instance there are no stacks on disk, so the handler
    // short-circuits with the "no stacks found" branch.
    const res = await request(app)
      .post('/api/auto-update/execute')
      .set('Cookie', adminCookie)
      .send({ target: '*' });
    expect(res.status).toBe(200);
    expect(typeof res.body.result).toBe('string');
  });
});
