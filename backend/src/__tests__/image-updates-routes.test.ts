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

  it('returns the enriched status payload', async () => {
    const res = await request(app).get('/api/image-updates/status').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(typeof res.body.checking).toBe('boolean');
    // start() never runs in route tests, so the interval reflects the seeded
    // default (120) via the field initializer rather than NaN.
    expect(res.body.intervalMinutes).toBe(120);
    expect(res.body.manualCooldownMinutes).toBe(2);
    expect(typeof res.body.manualCooldownRemainingMs).toBe('number');
    expect('lastCheckedAt' in res.body).toBe(true);
    expect('nextCheckAt' in res.body).toBe(true);
  });
});

describe('PUT /api/image-updates/interval', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).put('/api/image-updates/interval').send({ minutes: 30 });
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users with 403', async () => {
    const res = await request(app).put('/api/image-updates/interval').set('Cookie', viewerCookie).send({ minutes: 30 });
    expect(res.status).toBe(403);
  });

  it('rejects an interval below the minimum', async () => {
    const res = await request(app).put('/api/image-updates/interval').set('Cookie', adminCookie).send({ minutes: 5 });
    expect(res.status).toBe(400);
  });

  it('rejects an interval above the maximum', async () => {
    const res = await request(app).put('/api/image-updates/interval').set('Cookie', adminCookie).send({ minutes: 5000 });
    expect(res.status).toBe(400);
  });

  it('rejects a non-integer interval', async () => {
    const res = await request(app).put('/api/image-updates/interval').set('Cookie', adminCookie).send({ minutes: 'soon' });
    expect(res.status).toBe(400);
  });

  it('persists a valid interval and returns the enriched status', async () => {
    const res = await request(app).put('/api/image-updates/interval').set('Cookie', adminCookie).send({ minutes: 30 });
    expect(res.status).toBe(200);
    expect(res.body.intervalMinutes).toBe(30);
    // The value is persisted to global_settings...
    expect(DatabaseService.getInstance().getGlobalSettings().image_update_check_interval_minutes).toBe('30');
    // ...and a follow-up status read reflects the rescheduled cadence.
    const statusRes = await request(app).get('/api/image-updates/status').set('Cookie', adminCookie);
    expect(statusRes.body.intervalMinutes).toBe(30);
  });

  // ── Cron mode ──────────────────────────────────────────────────────────

  it('persists a valid cron expression and returns the enriched status', async () => {
    const res = await request(app).put('/api/image-updates/interval')
      .set('Cookie', adminCookie)
      .send({ minutes: 120, mode: 'cron', cron: '0 3 * * 1' });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('cron');
    expect(res.body.cronExpression).toBe('0 3 * * 1');
    const settings = DatabaseService.getInstance().getGlobalSettings();
    expect(settings.image_update_check_mode).toBe('cron');
    expect(settings.image_update_check_cron).toBe('0 3 * * 1');
  });

  it('accepts a cron nickname like @daily', async () => {
    const res = await request(app).put('/api/image-updates/interval')
      .set('Cookie', adminCookie)
      .send({ minutes: 120, mode: 'cron', cron: '@daily' });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('cron');
    expect(res.body.cronExpression).toBe('@daily');
  });

  it('rejects a 6-field cron expression', async () => {
    const res = await request(app).put('/api/image-updates/interval')
      .set('Cookie', adminCookie)
      .send({ minutes: 120, mode: 'cron', cron: '0 0 3 * * 1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/5 fields/);
  });

  it('rejects a blank cron expression when mode is cron', async () => {
    const res = await request(app).put('/api/image-updates/interval')
      .set('Cookie', adminCookie)
      .send({ minutes: 120, mode: 'cron', cron: '   ' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid cron expression (backend-authoritative)', async () => {
    const res = await request(app).put('/api/image-updates/interval')
      .set('Cookie', adminCookie)
      .send({ minutes: 120, mode: 'cron', cron: '0 0 31 2 *' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid cron/);
  });

  it('rejects cron mode without a cron field', async () => {
    const res = await request(app).put('/api/image-updates/interval')
      .set('Cookie', adminCookie)
      .send({ minutes: 120, mode: 'cron' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Cron expression/);
  });

  it('clears cron when switching back to interval mode', async () => {
    // First set cron mode.
    await request(app).put('/api/image-updates/interval')
      .set('Cookie', adminCookie)
      .send({ minutes: 120, mode: 'cron', cron: '0 3 * * 1' });
    // Then switch to interval.
    const res = await request(app).put('/api/image-updates/interval')
      .set('Cookie', adminCookie)
      .send({ minutes: 60, mode: 'interval' });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('interval');
    expect(res.body.cronExpression).toBeNull();
    const settings = DatabaseService.getInstance().getGlobalSettings();
    expect(settings.image_update_check_mode).toBe('interval');
    expect(settings.image_update_check_cron).toBe('');
  });

  it('old-client { minutes } only does not change mode (backward compat)', async () => {
    // First set cron mode.
    await request(app).put('/api/image-updates/interval')
      .set('Cookie', adminCookie)
      .send({ minutes: 120, mode: 'cron', cron: '0 3 * * 1' });
    // Then send old-client payload.
    const res = await request(app).put('/api/image-updates/interval')
      .set('Cookie', adminCookie)
      .send({ minutes: 30 });
    expect(res.status).toBe(200);
    // Mode and cron are unchanged.
    expect(res.body.mode).toBe('cron');
    expect(res.body.cronExpression).toBe('0 3 * * 1');
    // Interval was updated (the fallback value).
    expect(res.body.intervalMinutes).toBe(30);
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

  it('reports a reason-aware block message when the policy gate blocks auto-update', async () => {
    // The Codex QA flagged this surface: a KEV- or fixable-driven block must
    // name the matched input, never "exceed <max_severity>" (a ceiling the
    // policy did not enforce). Force the gate to block on KEV and assert the
    // per-stack result string names the reason and skips the update.
    const DockerController = (await import('../services/DockerController')).default;
    const { ImageUpdateService } = await import('../services/ImageUpdateService');
    const { ComposeService } = await import('../services/ComposeService');
    const PolicyEnforcement = await import('../services/PolicyEnforcement');

    const containersSpy = vi.spyOn(DockerController.prototype, 'getContainersByStack')
      .mockResolvedValue([{ Id: 'c1', Image: 'nginx:latest' }] as never);
    const checkSpy = vi.spyOn(ImageUpdateService.getInstance(), 'checkImage')
      .mockResolvedValue({ hasUpdate: true } as never);
    const updateSpy = vi.spyOn(ComposeService.prototype, 'updateStack').mockResolvedValue();
    const gateSpy = vi.spyOn(PolicyEnforcement, 'enforcePolicyPreDeploy').mockResolvedValue({
      ok: false,
      bypassed: false,
      policy: { id: 1, name: 'kev-gate', max_severity: 'HIGH' },
      violations: [{
        imageRef: 'nginx:latest', severity: 'MEDIUM',
        criticalCount: 0, highCount: 0, kevCount: 1, fixableCount: 0,
        scanId: 9, reasons: ['kev'],
      }],
    } as never);
    try {
      const res = await request(app)
        .post('/api/auto-update/execute')
        .set('Cookie', adminCookie)
        .send({ target: 'auto-upd-blocked' });
      expect(res.status).toBe(200);
      expect(res.body.result).toContain('blocked auto-update');
      expect(res.body.result).toContain('matched known-exploited CVE (KEV)');
      expect(res.body.result).not.toContain('exceed');
      expect(res.body.result).not.toContain('HIGH');
      // Blocked stacks are skipped, not updated.
      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      containersSpy.mockRestore();
      checkSpy.mockRestore();
      updateSpy.mockRestore();
      gateSpy.mockRestore();
    }
  });

  it('begins an update health gate after an auto-update applies', async () => {
    // Target a single stack; the route works off the running containers, so
    // stub the container probe, the update check, and the compose update, then
    // assert the gate begins for the applied stack.
    const { TEST_USERNAME } = await import('./helpers/setupTestDb');
    const DockerController = (await import('../services/DockerController')).default;
    const { ImageUpdateService } = await import('../services/ImageUpdateService');
    const { ComposeService } = await import('../services/ComposeService');
    const { HealthGateService } = await import('../services/HealthGateService');
    const nodeId = DatabaseService.getInstance().getDefaultNode()!.id!;

    const containersSpy = vi.spyOn(DockerController.prototype, 'getContainersByStack')
      .mockResolvedValue([{ Id: 'c1', Image: 'nginx:latest' }] as never);
    const checkSpy = vi.spyOn(ImageUpdateService.getInstance(), 'checkImage')
      .mockResolvedValue({ hasUpdate: true } as never);
    const updateSpy = vi.spyOn(ComposeService.prototype, 'updateStack').mockResolvedValue();
    const beginSpy = vi.spyOn(HealthGateService.getInstance(), 'begin').mockReturnValue('gate-au');
    try {
      const res = await request(app)
        .post('/api/auto-update/execute')
        .set('Cookie', adminCookie)
        .send({ target: 'auto-upd-gate' });
      expect(res.status).toBe(200);
      expect(updateSpy).toHaveBeenCalledWith('auto-upd-gate', undefined, true);
      expect(beginSpy).toHaveBeenCalledWith(nodeId, 'auto-upd-gate', 'update', `auto-update:${TEST_USERNAME}`);
    } finally {
      containersSpy.mockRestore();
      checkSpy.mockRestore();
      updateSpy.mockRestore();
      beginSpy.mockRestore();
    }
  });
});
