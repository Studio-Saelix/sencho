/**
 * Integration tests for Notification Routes CRUD endpoints,
 * auth enforcement, input validation, and test dispatch.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let licenseService: import('../services/LicenseService').LicenseService;
let authCookie: string;
let viewerCookie: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));

  // Mock LicenseService so Admiral-gated routes are accessible
  const { LicenseService } = await import('../services/LicenseService');
  licenseService = LicenseService.getInstance();
  vi.spyOn(licenseService, 'getTier').mockReturnValue('paid');
  vi.spyOn(licenseService, 'getVariant').mockReturnValue('admiral');
  vi.spyOn(licenseService, 'getSeatLimits').mockReturnValue({ maxAdmins: null, maxViewers: null });

  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);

  // Create a viewer user for non-admin tests
  const viewerHash = await bcrypt.hash('viewerpass', 1);
  DatabaseService.getInstance().addUser({ username: 'viewer', password_hash: viewerHash, role: 'viewer' });
  const viewerRes = await request(app)
    .post('/api/auth/login')
    .send({ username: 'viewer', password: 'viewerpass' });
  const cookies = viewerRes.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

// --- Auth Enforcement ---

describe('Notification Routes - auth enforcement', () => {
  it('GET /api/notification-routes returns 401 without auth', async () => {
    const res = await request(app).get('/api/notification-routes');
    expect(res.status).toBe(401);
  });

  it('POST /api/notification-routes returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/notification-routes')
      .send({ name: 'test', stack_patterns: ['app'], channel_type: 'discord', channel_url: 'https://discord.com/api/webhooks/123/abc' });
    expect(res.status).toBe(401);
  });

  it('PUT /api/notification-routes/1 returns 401 without auth', async () => {
    const res = await request(app)
      .put('/api/notification-routes/1')
      .send({ name: 'updated' });
    expect(res.status).toBe(401);
  });

  it('DELETE /api/notification-routes/1 returns 401 without auth', async () => {
    const res = await request(app).delete('/api/notification-routes/1');
    expect(res.status).toBe(401);
  });

  it('POST /api/notification-routes/1/test returns 401 without auth', async () => {
    const res = await request(app).post('/api/notification-routes/1/test');
    expect(res.status).toBe(401);
  });

  it('GET /api/notification-routes returns 403 for viewer', async () => {
    const res = await request(app)
      .get('/api/notification-routes')
      .set('Cookie', viewerCookie);
    expect(res.status).toBe(403);
  });

  it('POST /api/notification-routes returns 403 for viewer', async () => {
    const res = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', viewerCookie)
      .send({ name: 'test', stack_patterns: ['app'], channel_type: 'discord', channel_url: 'https://discord.com/api/webhooks/123/abc' });
    expect(res.status).toBe(403);
  });
});

// --- Tier enforcement (Skipper or Admiral) ---
//
// Skipper-positive tests exist per endpoint so that a future regression
// reverting any single handler to `requireAdmiral` is caught: with the
// default mock returning `admiral`, a stray `requireAdmiral` would still
// pass the Community-negative tests below (Community fails on tier
// before variant is checked), so only Skipper-positive coverage proves
// the gate is `requirePaid`. `afterEach` restores the suite defaults so
// per-test mock overrides cannot leak across tests.

describe('Notification Routes - tier enforcement', () => {
  afterEach(() => {
    vi.spyOn(licenseService, 'getTier').mockReturnValue('paid');
    vi.spyOn(licenseService, 'getVariant').mockReturnValue('admiral');
  });

  it('GET /api/notification-routes returns 200 when the variant is Skipper', async () => {
    vi.spyOn(licenseService, 'getVariant').mockReturnValue('skipper');
    const res = await request(app).get('/api/notification-routes').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/notification-routes returns 201 when the variant is Skipper', async () => {
    vi.spyOn(licenseService, 'getVariant').mockReturnValue('skipper');
    const res = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({ name: 'skipper-positive', stack_patterns: ['app'], channel_type: 'discord', channel_url: 'https://discord.com/api/webhooks/123/abc' });
    expect(res.status).toBe(201);
    if (typeof res.body?.id === 'number') {
      DatabaseService.getInstance().deleteNotificationRoute(res.body.id);
    }
  });

  it('PUT /api/notification-routes/:id returns 404 (gate passed) when the variant is Skipper', async () => {
    vi.spyOn(licenseService, 'getVariant').mockReturnValue('skipper');
    const res = await request(app).put('/api/notification-routes/99999').set('Cookie', authCookie).send({ name: 'x' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/notification-routes/:id returns 404 (gate passed) when the variant is Skipper', async () => {
    vi.spyOn(licenseService, 'getVariant').mockReturnValue('skipper');
    const res = await request(app).delete('/api/notification-routes/99999').set('Cookie', authCookie);
    expect(res.status).toBe(404);
  });

  it('POST /api/notification-routes/:id/test returns 404 (gate passed) when the variant is Skipper', async () => {
    vi.spyOn(licenseService, 'getVariant').mockReturnValue('skipper');
    const res = await request(app).post('/api/notification-routes/99999/test').set('Cookie', authCookie);
    expect(res.status).toBe(404);
  });

  it('GET /api/notification-routes returns 403 PAID_REQUIRED on Community', async () => {
    vi.spyOn(licenseService, 'getTier').mockReturnValue('community');
    const res = await request(app).get('/api/notification-routes').set('Cookie', authCookie);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PAID_REQUIRED');
  });

  it('POST /api/notification-routes returns 403 PAID_REQUIRED on Community', async () => {
    vi.spyOn(licenseService, 'getTier').mockReturnValue('community');
    const res = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({ name: 'x', stack_patterns: ['app'], channel_type: 'discord', channel_url: 'https://discord.com/api/webhooks/123/abc' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PAID_REQUIRED');
  });

  it('PUT /api/notification-routes/:id returns 403 PAID_REQUIRED on Community', async () => {
    vi.spyOn(licenseService, 'getTier').mockReturnValue('community');
    const res = await request(app).put('/api/notification-routes/1').set('Cookie', authCookie).send({ name: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PAID_REQUIRED');
  });

  it('DELETE /api/notification-routes/:id returns 403 PAID_REQUIRED on Community', async () => {
    vi.spyOn(licenseService, 'getTier').mockReturnValue('community');
    const res = await request(app).delete('/api/notification-routes/1').set('Cookie', authCookie);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PAID_REQUIRED');
  });

  it('POST /api/notification-routes/:id/test returns 403 PAID_REQUIRED on Community', async () => {
    vi.spyOn(licenseService, 'getTier').mockReturnValue('community');
    const res = await request(app).post('/api/notification-routes/1/test').set('Cookie', authCookie);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PAID_REQUIRED');
  });
});

// --- Agents Auth (now requires authMiddleware) ---

describe('Agents endpoints - auth enforcement', () => {
  it('GET /api/agents returns 401 without auth', async () => {
    const res = await request(app).get('/api/agents');
    expect(res.status).toBe(401);
  });

  it('POST /api/agents returns 401 without auth', async () => {
    const res = await request(app)
      .post('/api/agents')
      .send({ type: 'discord', url: 'https://discord.com/api/webhooks/123/abc', enabled: true });
    expect(res.status).toBe(401);
  });

  it('POST /api/agents returns 403 for viewer', async () => {
    const res = await request(app)
      .post('/api/agents')
      .set('Cookie', viewerCookie)
      .send({ type: 'discord', url: 'https://discord.com/api/webhooks/123/abc', enabled: true });
    expect(res.status).toBe(403);
  });

  it('GET /api/agents returns 200 with auth', async () => {
    const res = await request(app)
      .get('/api/agents')
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// --- Agents Validation ---

describe('POST /api/agents - validation', () => {
  it('rejects invalid type', async () => {
    const res = await request(app)
      .post('/api/agents')
      .set('Cookie', authCookie)
      .send({ type: 'telegram', url: 'https://example.com/hook', enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('discord, slack, webhook');
  });

  it('rejects non-HTTPS url', async () => {
    const res = await request(app)
      .post('/api/agents')
      .set('Cookie', authCookie)
      .send({ type: 'discord', url: 'http://example.com', enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('HTTPS');
  });

  it('rejects malformed url', async () => {
    const res = await request(app)
      .post('/api/agents')
      .set('Cookie', authCookie)
      .send({ type: 'discord', url: 'https://', enabled: true });
    expect(res.status).toBe(400);
  });

  it('rejects non-boolean enabled', async () => {
    const res = await request(app)
      .post('/api/agents')
      .set('Cookie', authCookie)
      .send({ type: 'discord', url: 'https://discord.com/api/webhooks/123/abc', enabled: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('boolean');
  });

  it('accepts valid agent and returns success', async () => {
    const res = await request(app)
      .post('/api/agents')
      .set('Cookie', authCookie)
      .send({ type: 'webhook', url: 'https://example.com/hook', enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// --- CRUD Operations ---

describe('Notification Routes - CRUD', () => {
  it('GET returns empty array initially', async () => {
    const res = await request(app)
      .get('/api/notification-routes')
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  let createdId: number;

  it('POST creates a route and returns 201', async () => {
    const res = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({
        name: 'Prod Discord',
        stack_patterns: ['prod-api', 'prod-web'],
        channel_type: 'discord',
        channel_url: 'https://discord.com/api/webhooks/123/abc',
        priority: 5,
        enabled: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe('Prod Discord');
    expect(res.body.stack_patterns).toEqual(['prod-api', 'prod-web']);
    expect(res.body.channel_type).toBe('discord');
    expect(res.body.priority).toBe(5);
    expect(res.body.enabled).toBe(true);
    createdId = res.body.id;
  });

  it('GET returns created routes sorted by priority', async () => {
    // Create a second route with lower priority (higher importance)
    await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({
        name: 'Staging Slack',
        stack_patterns: ['staging-api'],
        channel_type: 'slack',
        channel_url: 'https://hooks.slack.com/services/T00/B00/xyz',
        priority: 0,
      });

    const res = await request(app)
      .get('/api/notification-routes')
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    // First route should have lower priority number
    expect(res.body[0].priority).toBeLessThanOrEqual(res.body[1].priority);
  });

  it('PUT updates specific fields', async () => {
    const res = await request(app)
      .put(`/api/notification-routes/${createdId}`)
      .set('Cookie', authCookie)
      .send({ name: 'Prod Discord Updated', priority: 10 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Prod Discord Updated');
    expect(res.body.priority).toBe(10);
    // Unchanged fields preserved
    expect(res.body.channel_type).toBe('discord');
  });

  it('PUT returns 404 for non-existent route', async () => {
    const res = await request(app)
      .put('/api/notification-routes/99999')
      .set('Cookie', authCookie)
      .send({ name: 'Ghost' });
    expect(res.status).toBe(404);
  });

  it('DELETE removes the route', async () => {
    const res = await request(app)
      .delete(`/api/notification-routes/${createdId}`)
      .set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('DELETE returns 404 for non-existent route', async () => {
    const res = await request(app)
      .delete('/api/notification-routes/99999')
      .set('Cookie', authCookie);
    expect(res.status).toBe(404);
  });
});

// --- Validation ---

describe('POST /api/notification-routes - validation', () => {
  it('rejects empty name', async () => {
    const res = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({ name: '', stack_patterns: ['app'], channel_type: 'discord', channel_url: 'https://discord.com/api/webhooks/123/abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Name');
  });

  it('rejects name exceeding 100 characters', async () => {
    const res = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({ name: 'a'.repeat(101), stack_patterns: ['app'], channel_type: 'discord', channel_url: 'https://discord.com/api/webhooks/123/abc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('100');
  });

  it('accepts empty stack_patterns array', async () => {
    const res = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({ name: 'test', stack_patterns: [], channel_type: 'discord', channel_url: 'https://discord.com/api/webhooks/123/abc' });
    expect(res.status).toBe(201);
  });

  it('accepts whitespace-only stack patterns, cleaning them to an empty array', async () => {
    const res = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({ name: 'test', stack_patterns: ['  ', ''], channel_type: 'discord', channel_url: 'https://discord.com/api/webhooks/123/abc' });
    expect(res.status).toBe(201);
    expect(res.body.stack_patterns).toEqual([]);
  });

  it('rejects invalid channel_type', async () => {
    const res = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({ name: 'test', stack_patterns: ['app'], channel_type: 'telegram', channel_url: 'https://example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('discord, slack, webhook');
  });

  it('rejects non-HTTPS channel_url', async () => {
    const res = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({ name: 'test', stack_patterns: ['app'], channel_type: 'discord', channel_url: 'http://example.com' });
    expect(res.status).toBe(400);
  });

  it('rejects malformed channel_url (no host)', async () => {
    const res = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({ name: 'test', stack_patterns: ['app'], channel_type: 'discord', channel_url: 'https://' });
    expect(res.status).toBe(400);
  });

  it('rejects non-numeric priority', async () => {
    const res = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({ name: 'test', stack_patterns: ['app'], channel_type: 'discord', channel_url: 'https://discord.com/api/webhooks/123/abc', priority: 'high' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('priority');
  });

  it('deduplicates stack patterns', async () => {
    const res = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({ name: 'dedup test', stack_patterns: ['app', 'app', 'web'], channel_type: 'discord', channel_url: 'https://discord.com/api/webhooks/123/abc' });
    expect(res.status).toBe(201);
    expect(res.body.stack_patterns).toEqual(['app', 'web']);

    // Clean up
    await request(app)
      .delete(`/api/notification-routes/${res.body.id}`)
      .set('Cookie', authCookie);
  });
});

// --- PUT Validation ---

describe('PUT /api/notification-routes/:id - validation', () => {
  let routeId: number;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({ name: 'PUT test', stack_patterns: ['app'], channel_type: 'discord', channel_url: 'https://discord.com/api/webhooks/123/abc' });
    routeId = res.body.id;
  });

  it('rejects invalid route ID (NaN)', async () => {
    const res = await request(app)
      .put('/api/notification-routes/abc')
      .set('Cookie', authCookie)
      .send({ name: 'updated' });
    expect(res.status).toBe(400);
  });

  it('rejects non-boolean enabled', async () => {
    const res = await request(app)
      .put(`/api/notification-routes/${routeId}`)
      .set('Cookie', authCookie)
      .send({ enabled: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('boolean');
  });

  it('rejects non-numeric priority', async () => {
    const res = await request(app)
      .put(`/api/notification-routes/${routeId}`)
      .set('Cookie', authCookie)
      .send({ priority: 'high' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('priority');
  });

  it('rejects malformed channel_url', async () => {
    const res = await request(app)
      .put(`/api/notification-routes/${routeId}`)
      .set('Cookie', authCookie)
      .send({ channel_url: 'https://' });
    expect(res.status).toBe(400);
  });

  it('rejects name exceeding 100 characters', async () => {
    const res = await request(app)
      .put(`/api/notification-routes/${routeId}`)
      .set('Cookie', authCookie)
      .send({ name: 'x'.repeat(101) });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('100');
  });
});

// --- Test Dispatch ---

describe('POST /api/notification-routes/:id/test', () => {
  it('returns 404 for non-existent route', async () => {
    const res = await request(app)
      .post('/api/notification-routes/99999/test')
      .set('Cookie', authCookie);
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid route ID', async () => {
    const res = await request(app)
      .post('/api/notification-routes/abc/test')
      .set('Cookie', authCookie);
    expect(res.status).toBe(400);
  });
});

// --- DELETE /api/notifications/:id NaN guard ---

describe('DELETE /api/notifications/:id - validation', () => {
  it('rejects NaN notification ID with 400', async () => {
    const res = await request(app)
      .delete('/api/notifications/abc')
      .set('Cookie', authCookie);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid');
  });
});
