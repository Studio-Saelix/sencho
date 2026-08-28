/**
 * Integration tests for /api/image-updates and /api/auto-update/execute.
 * Locks down auth, admin gating, rate limiting, and input validation
 * before extraction.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin, TEST_JWT_SECRET } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let adminCookie: string;
let viewerCookie: string;

/** Sign a JWT for an already-seeded user, using their live token_version. */
function userToken(username: string): string {
  const user = DatabaseService.getInstance().getUserByUsername(username);
  if (!user) throw new Error(`missing test user ${username}`);
  return jwt.sign({ username, role: user.role, tv: user.token_version }, TEST_JWT_SECRET, { expiresIn: '5m' });
}

/** Write a minimal on-disk stack so FileSystemService.getStacks() resolves it. */
function makeOnDiskStack(name: string): void {
  const composeDir = process.env.COMPOSE_DIR as string;
  fs.mkdirSync(path.join(composeDir, name), { recursive: true });
  fs.writeFileSync(path.join(composeDir, name, 'docker-compose.yml'), 'services: {}\n');
}

function removeOnDiskStack(name: string): void {
  fs.rmSync(path.join(process.env.COMPOSE_DIR as string, name), { recursive: true, force: true });
}

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

  const deployerHash = await bcrypt.hash('deployerpass', 1);
  DatabaseService.getInstance().addUser({ username: 'iu-deployer', password_hash: deployerHash, role: 'deployer' });

  const nodeAdminHash = await bcrypt.hash('nodeadminpass', 1);
  DatabaseService.getInstance().addUser({ username: 'iu-node-admin', password_hash: nodeAdminHash, role: 'node-admin' });
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

  it('excludes partial and failed retained rows from the confirmed boolean map', async () => {
    const nodeId = DatabaseService.getInstance().getDefaultNode()!.id!;
    DatabaseService.getInstance().upsertStackUpdateStatus(nodeId, 'ok-stack', true, 1000, 'ok', null);
    DatabaseService.getInstance().upsertStackUpdateStatus(nodeId, 'partial-stack', true, 1000, 'partial', 'half');
    DatabaseService.getInstance().upsertStackUpdateStatus(nodeId, 'failed-stack', true, 1000, 'failed', 'boom');
    const res = await request(app).get('/api/image-updates').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body['ok-stack']).toBe(true);
    expect(res.body['partial-stack']).toBe(false);
    expect(res.body['failed-stack']).toBe(false);
  });
});

describe('GET /api/image-updates/detail', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/image-updates/detail');
    expect(res.status).toBe(401);
  });

  it('returns the rich per-stack detail shape for authenticated users', async () => {
    const nodeId = DatabaseService.getInstance().getDefaultNode()!.id!;
    DatabaseService.getInstance().upsertStackUpdateStatus(nodeId, 'detail-web', true, 1000, 'partial', 'Registry unreachable for ghcr.io/acme/api:v1');
    const res = await request(app).get('/api/image-updates/detail').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body['detail-web']).toEqual({
      hasUpdate: true,
      checkStatus: 'partial',
      lastError: 'Registry unreachable for ghcr.io/acme/api:v1',
      checkedAt: 1000,
    });
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

describe('POST /api/image-updates/refresh/:stackName', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).post('/api/image-updates/refresh/some-stack');
    expect(res.status).toBe(401);
  });

  it('rejects an invalid stack name with 400', async () => {
    const res = await request(app)
      .post(`/api/image-updates/refresh/${encodeURIComponent('bad name')}`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid stack name/);
  });

  it('rejects a role without stack:deploy with 403 PERMISSION_DENIED', async () => {
    const res = await request(app)
      .post('/api/image-updates/refresh/per-stack-refresh')
      .set('Cookie', viewerCookie);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('allows a Deployer to trigger a per-stack recheck', async () => {
    const { ImageUpdateService } = await import('../services/ImageUpdateService');
    const nodeId = DatabaseService.getInstance().getDefaultNode()!.id!;
    const recheckSpy = vi.spyOn(ImageUpdateService.getInstance(), 'recheckStack')
      .mockResolvedValue({ outcome: 'cleared', warning: null });
    try {
      const res = await request(app)
        .post('/api/image-updates/refresh/per-stack-refresh')
        .set('Authorization', `Bearer ${userToken('iu-deployer')}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ outcome: 'cleared', warning: null });
      expect(recheckSpy).toHaveBeenCalledWith(nodeId, 'per-stack-refresh');
    } finally {
      recheckSpy.mockRestore();
    }
  });

  it('returns 409 with enabled false when checks are disabled', async () => {
    DatabaseService.getInstance().updateGlobalSetting('image_update_checks_enabled', '0');
    const res = await request(app)
      .post('/api/image-updates/refresh/per-stack-refresh')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(409);
    expect(res.body.enabled).toBe(false);
    expect(res.body.error).toMatch(/disabled/i);
    DatabaseService.getInstance().updateGlobalSetting('image_update_checks_enabled', '1');
  });

  describe('rate limit', () => {
    beforeEach(async () => {
      const { ImageUpdateService } = await import('../services/ImageUpdateService');
      ImageUpdateService.getInstance().resetStackRecheckCooldowns();
      vi.useFakeTimers().setSystemTime(Date.now());
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('rejects a second recheck within the cooldown window with 429', async () => {
      const { ImageUpdateService } = await import('../services/ImageUpdateService');
      const recheckSpy = vi.spyOn(ImageUpdateService.getInstance(), 'recheckStack')
        .mockResolvedValue({ outcome: 'cleared', warning: null });
      try {
        const first = await request(app)
          .post('/api/image-updates/refresh/per-stack-refresh')
          .set('Cookie', adminCookie);
        expect(first.status).toBe(200);

        // Within the same cooldown window (2 min), a second call is denied.
        vi.advanceTimersByTime(1_000);
        const second = await request(app)
          .post('/api/image-updates/refresh/per-stack-refresh')
          .set('Cookie', adminCookie);
        expect(second.status).toBe(429);
        expect(second.body.error).toMatch(/too recently/i);
        expect(recheckSpy).toHaveBeenCalledTimes(1);
      } finally {
        recheckSpy.mockRestore();
      }
    });

    it('allows a recheck after the cooldown window expires', async () => {
      const { ImageUpdateService } = await import('../services/ImageUpdateService');
      const recheckSpy = vi.spyOn(ImageUpdateService.getInstance(), 'recheckStack')
        .mockResolvedValue({ outcome: 'cleared', warning: null });
      try {
        const first = await request(app)
          .post('/api/image-updates/refresh/per-stack-refresh')
          .set('Cookie', adminCookie);
        expect(first.status).toBe(200);

        // Advance past the 2-minute cooldown.
        vi.advanceTimersByTime(2 * 60 * 1000 + 1);
        const second = await request(app)
          .post('/api/image-updates/refresh/per-stack-refresh')
          .set('Cookie', adminCookie);
        expect(second.status).toBe(200);
        expect(recheckSpy).toHaveBeenCalledTimes(2);
      } finally {
        recheckSpy.mockRestore();
      }
    });

    it('enforces the rate limit independently per-stack', async () => {
      const { ImageUpdateService } = await import('../services/ImageUpdateService');
      const recheckSpy = vi.spyOn(ImageUpdateService.getInstance(), 'recheckStack')
        .mockResolvedValue({ outcome: 'cleared', warning: null });
      try {
        const a1 = await request(app)
          .post('/api/image-updates/refresh/per-stack-refresh')
          .set('Cookie', adminCookie);
        expect(a1.status).toBe(200);

        // A different stack should not be rate-limited by the first.
        const b1 = await request(app)
          .post('/api/image-updates/refresh/other-stack')
          .set('Cookie', adminCookie);
        expect(b1.status).toBe(200);
        expect(recheckSpy).toHaveBeenCalledTimes(2);
      } finally {
        recheckSpy.mockRestore();
      }
    });
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
    expect(res.body.enabled).toBe(true);
  });
});

describe('PUT /api/image-updates/enabled', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).put('/api/image-updates/enabled').send({ enabled: false });
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users with 403', async () => {
    const res = await request(app).put('/api/image-updates/enabled').set('Cookie', viewerCookie).send({ enabled: false });
    expect(res.status).toBe(403);
  });

  it('disables checks, clears local findings, and returns enabled false', async () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    db.upsertStackUpdateStatus(nodeId, 'pending-stack', true, Date.now(), 'ok', null);
    expect(Object.keys(db.getStackUpdateDetail(nodeId)).length).toBeGreaterThan(0);

    const res = await request(app).put('/api/image-updates/enabled').set('Cookie', adminCookie).send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.nextCheckAt).toBeNull();
    expect(db.getGlobalSettings().image_update_checks_enabled).toBe('0');
    expect(db.getStackUpdateDetail(nodeId)).toEqual({});
  });

  it('re-enables checks and returns enabled true', async () => {
    DatabaseService.getInstance().updateGlobalSetting('image_update_checks_enabled', '0');
    const res = await request(app).put('/api/image-updates/enabled').set('Cookie', adminCookie).send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(DatabaseService.getInstance().getGlobalSettings().image_update_checks_enabled).toBe('1');
  });
});

describe('POST /api/image-updates/refresh when disabled', () => {
  it('returns 409 with enabled false instead of rate-limit 429', async () => {
    DatabaseService.getInstance().updateGlobalSetting('image_update_checks_enabled', '0');
    const res = await request(app).post('/api/image-updates/refresh').set('Cookie', adminCookie);
    expect(res.status).toBe(409);
    expect(res.body.enabled).toBe(false);
    expect(res.body.error).toMatch(/disabled/i);
    DatabaseService.getInstance().updateGlobalSetting('image_update_checks_enabled', '1');
  });
});

describe('POST /api/image-updates/fleet/refresh when disabled', () => {
  it('lists the local node in disabled rather than triggered or rateLimited', async () => {
    DatabaseService.getInstance().updateGlobalSetting('image_update_checks_enabled', '0');
    const localId = DatabaseService.getInstance().getDefaultNode()!.id!;
    const res = await request(app).post('/api/image-updates/fleet/refresh').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.disabled).toContain(localId);
    expect(res.body.triggered).not.toContain(localId);
    expect(res.body.rateLimited).not.toContain(localId);
    DatabaseService.getInstance().updateGlobalSetting('image_update_checks_enabled', '1');
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

  it('allows a non-admin authenticated user (auth-only, matching GET / and /detail)', async () => {
    // The cross-node aggregation used to be admin-only; it now matches the
    // auth-only read model shared with GET /, /detail, and /status.
    const res = await request(app).get('/api/image-updates/fleet').set('Cookie', viewerCookie);
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Object);
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

  it('rejects a Deployer with 403 PERMISSION_DENIED (requires node:manage)', async () => {
    const res = await request(app)
      .post('/api/image-updates/fleet/refresh')
      .set('Authorization', `Bearer ${userToken('iu-deployer')}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('allows a Node Admin (holds node:manage)', async () => {
    const res = await request(app)
      .post('/api/image-updates/fleet/refresh')
      .set('Authorization', `Bearer ${userToken('iu-node-admin')}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.triggered)).toBe(true);
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

  it('rejects a role without stack:deploy with 403 PERMISSION_DENIED', async () => {
    const res = await request(app)
      .post('/api/auto-update/execute')
      .set('Cookie', viewerCookie)
      .send({ target: 'execute-authz-stack' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('rejects a role without stack:deploy on target="*" even when the node has no stacks', async () => {
    // On a fresh test instance the "*" expansion resolves to zero stacks, which
    // would otherwise short-circuit into a "no stacks found" 200 before any
    // per-stack permission check has anything to iterate over. The wildcard
    // case requires global stack:deploy up front specifically to close that gap.
    const res = await request(app)
      .post('/api/auto-update/execute')
      .set('Cookie', viewerCookie)
      .send({ target: '*' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('allows a Deployer to execute a single-stack target', async () => {
    const res = await request(app)
      .post('/api/auto-update/execute')
      .set('Authorization', `Bearer ${userToken('iu-deployer')}`)
      .send({ target: 'deployer-exec-stack' });
    expect(res.status).toBe(200);
    expect(typeof res.body.result).toBe('string');
  });

  it('denies a Deployer stripped of stack:deploy with 403 PERMISSION_DENIED', async () => {
    const { ROLE_PERMISSIONS } = await import('../middleware/permissions');
    const original = ROLE_PERMISSIONS.deployer;
    ROLE_PERMISSIONS.deployer = original.filter((p) => p !== 'stack:deploy');
    try {
      const res = await request(app)
        .post('/api/auto-update/execute')
        .set('Authorization', `Bearer ${userToken('iu-deployer')}`)
        .send({ target: 'deployer-exec-stack' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
    } finally {
      ROLE_PERMISSIONS.deployer = original;
    }
  });

  it('denies the whole bulk request when one target is unauthorized, with no partial execution', async () => {
    // Scoped user: global viewer role (no stack:deploy anywhere) plus a
    // deployer role assignment scoped to "bulk-allowed" only. Requesting
    // ["bulk-allowed", "bulk-denied"] must deny the entire call on the second
    // stack and never touch either stack's containers.
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    const hash = await bcrypt.hash('scopedpass', 1);
    const scopedUserId = db.addUser({ username: 'iu-bulk-scoped', password_hash: hash, role: 'viewer' });
    db.addRoleAssignment({ user_id: scopedUserId, role: 'deployer', resource_type: 'stack', resource_id: 'bulk-allowed', node_id: nodeId });

    const DockerController = (await import('../services/DockerController')).default;
    const containersSpy = vi.spyOn(DockerController.prototype, 'getContainersByStack');

    try {
      const res = await request(app)
        .post('/api/auto-update/execute')
        .set('Authorization', `Bearer ${userToken('iu-bulk-scoped')}`)
        .send({ targets: ['bulk-allowed', 'bulk-denied'] });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
      expect(containersSpy).not.toHaveBeenCalled();
    } finally {
      containersSpy.mockRestore();
      db.deleteRoleAssignmentsByUser(scopedUserId);
      db.deleteUser(scopedUserId);
    }
  });

  it('rejects a role without stack:deploy with 403 even when checks are disabled node-wide', async () => {
    // Permission must be evaluated before the checks-enabled setting is
    // consulted: a disabled node must not let an unauthorized caller through
    // to the "disabled; skipped" 200 that a legitimate caller would see.
    DatabaseService.getInstance().updateGlobalSetting('image_update_checks_enabled', '0');
    try {
      const res = await request(app)
        .post('/api/auto-update/execute')
        .set('Cookie', viewerCookie)
        .send({ target: 'checks-disabled-authz-stack' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
    } finally {
      DatabaseService.getInstance().updateGlobalSetting('image_update_checks_enabled', '1');
    }
  });

  it('denies target="*" for a scoped-only user even when their grant covers every stack on the node', async () => {
    // A user with ONLY a scoped stack:deploy role_assignment (no global
    // stack:deploy role) is denied the wildcard outright, even though the
    // same grant would pass requireExactStacks if the caller enumerated the
    // stack explicitly via targets instead of relying on "*" to expand it.
    // This is the brief-sanctioned "deny without global deploy" tradeoff for
    // the wildcard case.
    makeOnDiskStack('wildcard-scoped-stack');
    const db = DatabaseService.getInstance();
    const nodeId = db.getDefaultNode()!.id!;
    const hash = await bcrypt.hash('scopedpass', 1);
    const scopedUserId = db.addUser({ username: 'iu-wildcard-scoped', password_hash: hash, role: 'viewer' });
    db.addRoleAssignment({ user_id: scopedUserId, role: 'deployer', resource_type: 'stack', resource_id: 'wildcard-scoped-stack', node_id: nodeId });

    try {
      const res = await request(app)
        .post('/api/auto-update/execute')
        .set('Authorization', `Bearer ${userToken('iu-wildcard-scoped')}`)
        .send({ target: '*' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
    } finally {
      db.deleteRoleAssignmentsByUser(scopedUserId);
      db.deleteUser(scopedUserId);
      removeOnDiskStack('wildcard-scoped-stack');
    }
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

  it('rejects an empty targets array with 400', async () => {
    const res = await request(app)
      .post('/api/auto-update/execute')
      .set('Cookie', adminCookie)
      .send({ targets: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/non-empty array/);
  });

  it('rejects invalid names in targets with 400', async () => {
    const res = await request(app)
      .post('/api/auto-update/execute')
      .set('Cookie', adminCookie)
      .send({ targets: ['ok-stack', '../bad'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid stack name/);
  });

  it('accepts targets[] and returns a per-stack summary string', async () => {
    const res = await request(app)
      .post('/api/auto-update/execute')
      .set('Cookie', adminCookie)
      .send({ targets: ['missing-a', 'missing-b'] });
    expect(res.status).toBe(200);
    expect(typeof res.body.result).toBe('string');
    expect(res.body.result).toMatch(/missing-a/);
    expect(res.body.result).toMatch(/missing-b/);
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
      .mockResolvedValue({ hasUpdate: true, digestUpdate: true } as never);
    const updateSpy = vi.spyOn(ComposeService.prototype, 'updateStack').mockResolvedValue({ recoveryId: null, deployedGenerationId: null });
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
    const callOrder: string[] = [];

    const containersSpy = vi.spyOn(DockerController.prototype, 'getContainersByStack')
      .mockResolvedValue([{ Id: 'c1', Image: 'nginx:latest' }] as never);
    const checkSpy = vi.spyOn(ImageUpdateService.getInstance(), 'checkImage')
      .mockResolvedValue({ hasUpdate: true, digestUpdate: true } as never);
    const updateSpy = vi.spyOn(ComposeService.prototype, 'updateStack').mockResolvedValue({ recoveryId: null, deployedGenerationId: null });
    const recheckSpy = vi.spyOn(ImageUpdateService.getInstance(), 'recheckStack')
      .mockImplementation(async () => {
        callOrder.push('recheckStack');
        return { outcome: 'cleared', warning: null } as never;
      });
    const beginSpy = vi.spyOn(HealthGateService.getInstance(), 'beginStack').mockImplementation(() => {
      callOrder.push('beginStack');
      return 'gate-au';
    });
    try {
      const res = await request(app)
        .post('/api/auto-update/execute')
        .set('Cookie', adminCookie)
        .send({ target: 'auto-upd-gate' });
      expect(res.status).toBe(200);
      expect(updateSpy).toHaveBeenCalledWith('auto-upd-gate', undefined, true);
      expect(recheckSpy).toHaveBeenCalledWith(nodeId, 'auto-upd-gate');
      expect(beginSpy).toHaveBeenCalledWith(nodeId, 'auto-upd-gate', 'update', `auto-update:${TEST_USERNAME}`, { deployedGenerationId: null });
      expect(callOrder.indexOf('beginStack')).toBeLessThan(callOrder.indexOf('recheckStack'));
    } finally {
      containersSpy.mockRestore();
      checkSpy.mockRestore();
      updateSpy.mockRestore();
      recheckSpy.mockRestore();
      beginSpy.mockRestore();
    }
  });

  it('skips Compose apply for tag-only availability without clearing status', async () => {
    const DockerController = (await import('../services/DockerController')).default;
    const { ImageUpdateService } = await import('../services/ImageUpdateService');
    const { ComposeService } = await import('../services/ComposeService');
    const { DatabaseService } = await import('../services/DatabaseService');
    const nodeId = DatabaseService.getInstance().getDefaultNode()!.id!;

    const containersSpy = vi.spyOn(DockerController.prototype, 'getContainersByStack')
      .mockResolvedValue([{ Id: 'c1', Image: 'nginx:1.2.3' }] as never);
    const checkSpy = vi.spyOn(ImageUpdateService.getInstance(), 'checkImage')
      .mockResolvedValue({ hasUpdate: true, digestUpdate: false, tagUpdate: true } as never);
    const updateSpy = vi.spyOn(ComposeService.prototype, 'updateStack').mockResolvedValue({ recoveryId: null, deployedGenerationId: null });
    const recheckSpy = vi.spyOn(ImageUpdateService.getInstance(), 'recheckStack');
    const clearSpy = vi.spyOn(DatabaseService.getInstance(), 'clearStackUpdateStatus');
    try {
      const res = await request(app)
        .post('/api/auto-update/execute')
        .set('Cookie', adminCookie)
        .send({ target: 'auto-upd-tag-only' });
      expect(res.status).toBe(200);
      expect(res.body.result).toContain('Compose pin unchanged');
      expect(updateSpy).not.toHaveBeenCalled();
      expect(recheckSpy).not.toHaveBeenCalled();
      expect(clearSpy).not.toHaveBeenCalledWith(nodeId, 'auto-upd-tag-only');
    } finally {
      containersSpy.mockRestore();
      checkSpy.mockRestore();
      updateSpy.mockRestore();
      recheckSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it('skips digest apply when a sibling image check failed', async () => {
    const DockerController = (await import('../services/DockerController')).default;
    const { ImageUpdateService } = await import('../services/ImageUpdateService');
    const { ComposeService } = await import('../services/ComposeService');

    const containersSpy = vi.spyOn(DockerController.prototype, 'getContainersByStack')
      .mockResolvedValue([
        { Id: 'c1', Image: 'nginx:latest' },
        { Id: 'c2', Image: 'redis:latest' },
      ] as never);
    const checkSpy = vi.spyOn(ImageUpdateService.getInstance(), 'checkImage')
      .mockResolvedValueOnce({ hasUpdate: true, digestUpdate: true, tagUpdate: false } as never)
      .mockResolvedValueOnce({ hasUpdate: false, error: 'registry timeout', checkStatus: 'failed' } as never);
    const updateSpy = vi.spyOn(ComposeService.prototype, 'updateStack').mockResolvedValue({ recoveryId: null, deployedGenerationId: null });
    const recheckSpy = vi.spyOn(ImageUpdateService.getInstance(), 'recheckStack');
    try {
      const res = await request(app)
        .post('/api/auto-update/execute')
        .set('Cookie', adminCookie)
        .send({ target: 'auto-upd-check-err' });
      expect(res.status).toBe(200);
      expect(res.body.result).toContain('image check(s) failed');
      expect(updateSpy).not.toHaveBeenCalled();
      expect(recheckSpy).not.toHaveBeenCalled();
    } finally {
      containersSpy.mockRestore();
      checkSpy.mockRestore();
      updateSpy.mockRestore();
      recheckSpy.mockRestore();
    }
  });

  it('still applies when checkImage reports same-tag digestUpdate', async () => {
    const DockerController = (await import('../services/DockerController')).default;
    const { ImageUpdateService } = await import('../services/ImageUpdateService');
    const { ComposeService } = await import('../services/ComposeService');
    const { DatabaseService } = await import('../services/DatabaseService');
    const nodeId = DatabaseService.getInstance().getDefaultNode()!.id!;

    const containersSpy = vi.spyOn(DockerController.prototype, 'getContainersByStack')
      .mockResolvedValue([{ Id: 'c1', Image: 'nginx:latest' }] as never);
    const checkSpy = vi.spyOn(ImageUpdateService.getInstance(), 'checkImage')
      .mockResolvedValue({ hasUpdate: true, digestUpdate: true, tagUpdate: false } as never);
    const updateSpy = vi.spyOn(ComposeService.prototype, 'updateStack').mockResolvedValue({ recoveryId: null, deployedGenerationId: null });
    const recheckSpy = vi.spyOn(ImageUpdateService.getInstance(), 'recheckStack')
      .mockResolvedValue({ outcome: 'still_present', warning: null } as never);
    const clearSpy = vi.spyOn(DatabaseService.getInstance(), 'clearStackUpdateStatus');
    try {
      const res = await request(app)
        .post('/api/auto-update/execute')
        .set('Cookie', adminCookie)
        .send({ target: 'auto-upd-digest' });
      expect(res.status).toBe(200);
      expect(updateSpy).toHaveBeenCalledWith('auto-upd-digest', undefined, true);
      expect(recheckSpy).toHaveBeenCalledWith(nodeId, 'auto-upd-digest');
      expect(clearSpy).not.toHaveBeenCalledWith(nodeId, 'auto-upd-digest');
    } finally {
      containersSpy.mockRestore();
      checkSpy.mockRestore();
      updateSpy.mockRestore();
      recheckSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});
