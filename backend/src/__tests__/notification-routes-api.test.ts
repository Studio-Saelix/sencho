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

  // Mock LicenseService; notification routes are free, so the suite runs at
  // the Community tier to prove they work without a paid license.
  const { LicenseService } = await import('../services/LicenseService');
  licenseService = LicenseService.getInstance();
  vi.spyOn(licenseService, 'getTier').mockReturnValue('community');

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

// --- No tier gate (notification routing is free) ---
//
// Notification routing is available on every tier. These tests prove a
// Community admin reaches each endpoint (the gate that rejects is the admin
// role, not the tier). The suite default is the Community tier.

describe('Notification Routes - available on the Community tier', () => {
  it('GET /api/notification-routes returns 200 on the Community tier', async () => {
    const res = await request(app).get('/api/notification-routes').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/notification-routes returns 201 on the Community tier', async () => {
    const res = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({ name: 'community-positive', stack_patterns: ['app'], channel_type: 'discord', channel_url: 'https://discord.com/api/webhooks/123/abc' });
    expect(res.status).toBe(201);
    if (typeof res.body?.id === 'number') {
      DatabaseService.getInstance().deleteNotificationRoute(res.body.id);
    }
  });

  it('PUT /api/notification-routes/:id returns 404 (gate passed) on the Community tier', async () => {
    const res = await request(app).put('/api/notification-routes/99999').set('Cookie', authCookie).send({ name: 'x' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/notification-routes/:id returns 404 (gate passed) on the Community tier', async () => {
    const res = await request(app).delete('/api/notification-routes/99999').set('Cookie', authCookie);
    expect(res.status).toBe(404);
  });

  it('POST /api/notification-routes/:id/test returns 404 (gate passed) on the Community tier', async () => {
    const res = await request(app).post('/api/notification-routes/99999/test').set('Cookie', authCookie);
    expect(res.status).toBe(404);
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
    expect(res.body.error).toContain('discord, slack, webhook, apprise, ntfy');
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
    expect(res.body.error).toContain('discord, slack, webhook, apprise, ntfy');
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

describe('Apprise notification routes - redaction and preserve-on-write', () => {
  const keyedUrl = 'http://apprise.local/notify/route-key-secret';
  const serviceUrl = 'mailto://user:pass@smtp.example.com?to=ops@example.com';
  let routeId: number;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({
        name: 'Apprise route',
        stack_patterns: ['app'],
        channel_type: 'apprise',
        channel_url: keyedUrl,
        config: { tags: 'ops' },
        enabled: true,
      });
    expect(res.status).toBe(201);
    routeId = res.body.id;
  });

  it('POST 201 and GET redact the keyed endpoint path', async () => {
    const created = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({
        name: 'Apprise create redact',
        stack_patterns: [],
        channel_type: 'apprise',
        channel_url: keyedUrl,
        config: { tags: 'night' },
      });
    expect(created.status).toBe(201);
    expect(created.body.channel_url).toBe('http://apprise.local/notify/<redacted>');
    expect(created.body.config).toMatchObject({ mode: 'keyed', tags: 'night', has_urls: false });
    expect(JSON.stringify(created.body)).not.toContain('route-key-secret');

    const listed = await request(app).get('/api/notification-routes').set('Cookie', authCookie);
    const row = listed.body.find((r: { id: number }) => r.id === created.body.id);
    expect(row.channel_url).toBe('http://apprise.local/notify/<redacted>');
    expect(JSON.stringify(row)).not.toContain('route-key-secret');

    await request(app).delete(`/api/notification-routes/${created.body.id}`).set('Cookie', authCookie);
  });

  it('POST 201 for stateless mode returns providers and url_count only', async () => {
    const res = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({
        name: 'Apprise stateless',
        stack_patterns: [],
        channel_type: 'apprise',
        channel_url: 'http://apprise.local/notify',
        config: { urls: serviceUrl },
      });
    expect(res.status).toBe(201);
    expect(res.body.channel_url).toBe('http://apprise.local/notify');
    expect(res.body.config).toMatchObject({
      mode: 'stateless',
      has_urls: true,
      providers: ['mailto'],
      url_count: 1,
    });
    expect(JSON.stringify(res.body)).not.toContain('pass@');
    expect(JSON.stringify(res.body)).not.toContain('ops@example.com');

    const stored = DatabaseService.getInstance().getNotificationRoute(res.body.id);
    expect(stored?.channel_url).toBe('http://apprise.local/notify');
    expect(stored?.config).toContain(serviceUrl);

    await request(app).delete(`/api/notification-routes/${res.body.id}`).set('Cookie', authCookie);
  });

  it('PUT preserves secrets when channel_url and config are omitted', async () => {
    const res = await request(app)
      .put(`/api/notification-routes/${routeId}`)
      .set('Cookie', authCookie)
      .send({ name: 'Apprise route renamed', enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Apprise route renamed');
    expect(res.body.channel_url).toBe('http://apprise.local/notify/<redacted>');
    expect(JSON.stringify(res.body)).not.toContain('route-key-secret');

    const stored = DatabaseService.getInstance().getNotificationRoute(routeId);
    expect(stored?.channel_url).toBe(keyedUrl);
    expect(stored?.config).toBe(JSON.stringify({ tags: 'ops' }));
  });

  it('PUT rejects channel_type change without a new channel_url and leaves the row unchanged', async () => {
    const before = DatabaseService.getInstance().getDb()
      .prepare('SELECT channel_type, channel_url, config FROM notification_routes WHERE id = ?')
      .get(routeId) as { channel_type: string; channel_url: string; config: string | null };
    expect(before.channel_type).toBe('apprise');
    expect(before.channel_url.startsWith('enc:')).toBe(true);

    const res = await request(app)
      .put(`/api/notification-routes/${routeId}`)
      .set('Cookie', authCookie)
      .send({ channel_type: 'discord' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/channel_url is required when changing channel_type/i);

    const after = DatabaseService.getInstance().getDb()
      .prepare('SELECT channel_type, channel_url, config FROM notification_routes WHERE id = ?')
      .get(routeId) as { channel_type: string; channel_url: string; config: string | null };
    expect(after).toEqual(before);
  });

  it('PUT Apprise-to-Discord with a raw URL stores plaintext Discord credentials', async () => {
    const created = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({
        name: 'Apprise leave',
        stack_patterns: [],
        channel_type: 'apprise',
        channel_url: 'http://apprise.local/notify/leave-key',
        config: { tags: 'ops' },
      });
    expect(created.status).toBe(201);
    const id = created.body.id as number;

    const discordUrl = 'https://discord.com/api/webhooks/1/token-secret';
    const res = await request(app)
      .put(`/api/notification-routes/${id}`)
      .set('Cookie', authCookie)
      .send({ channel_type: 'discord', channel_url: discordUrl });
    expect(res.status).toBe(200);
    expect(res.body.channel_type).toBe('discord');

    const raw = DatabaseService.getInstance().getDb()
      .prepare('SELECT channel_type, channel_url, config FROM notification_routes WHERE id = ?')
      .get(id) as { channel_type: string; channel_url: string; config: string | null };
    expect(raw.channel_type).toBe('discord');
    expect(raw.channel_url).toBe(discordUrl);
    expect(raw.channel_url.startsWith('enc:')).toBe(false);
    expect(raw.config).toBeNull();

    await request(app).delete(`/api/notification-routes/${id}`).set('Cookie', authCookie);
  });

  it('PUT webhook-to-Apprise seals both channel_url and config as enc: ciphertext', async () => {
    const notifyUrl = 'https://apprise.example/notify/promote-key';
    const created = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({
        name: 'Webhook promote',
        stack_patterns: [],
        channel_type: 'webhook',
        channel_url: notifyUrl,
      });
    expect(created.status).toBe(201);
    const id = created.body.id as number;

    const before = DatabaseService.getInstance().getDb()
      .prepare('SELECT channel_url FROM notification_routes WHERE id = ?')
      .get(id) as { channel_url: string };
    expect(before.channel_url).toBe(notifyUrl);

    const res = await request(app)
      .put(`/api/notification-routes/${id}`)
      .set('Cookie', authCookie)
      .send({
        channel_type: 'apprise',
        channel_url: notifyUrl,
        config: { tags: 'fleet' },
      });
    expect(res.status).toBe(200);
    expect(res.body.channel_type).toBe('apprise');
    expect(res.body.channel_url).toBe('https://apprise.example/notify/<redacted>');

    const raw = DatabaseService.getInstance().getDb()
      .prepare('SELECT channel_type, channel_url, config FROM notification_routes WHERE id = ?')
      .get(id) as { channel_type: string; channel_url: string; config: string | null };
    expect(raw.channel_type).toBe('apprise');
    expect(raw.channel_url.startsWith('enc:')).toBe(true);
    expect(raw.channel_url).not.toContain('promote-key');
    expect(raw.config?.startsWith('enc:')).toBe(true);
    expect(raw.config).not.toContain('fleet');

    const stored = DatabaseService.getInstance().getNotificationRoute(id);
    expect(stored?.channel_url).toBe(notifyUrl);
    expect(stored?.config).toBe(JSON.stringify({ tags: 'fleet' }));

    await request(app).delete(`/api/notification-routes/${id}`).set('Cookie', authCookie);
  });

  it('PUT rejects a redacted channel_url', async () => {
    const res = await request(app)
      .put(`/api/notification-routes/${routeId}`)
      .set('Cookie', authCookie)
      .send({ channel_url: 'http://apprise.local/notify/<redacted>' });
    expect(res.status).toBe(400);
  });

  it('PUT rejects public DTO config shapes', async () => {
    const res = await request(app)
      .put(`/api/notification-routes/${routeId}`)
      .set('Cookie', authCookie)
      .send({
        channel_url: keyedUrl,
        config: { mode: 'keyed', has_urls: false, providers: [] },
      });
    expect(res.status).toBe(400);
  });

  it('stored-route test uses raw config and returns sanitized 204 errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const ok = await request(app)
        .post(`/api/notification-routes/${routeId}/test`)
        .set('Cookie', authCookie);
      expect(ok.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        keyedUrl,
        expect.objectContaining({
          body: JSON.stringify({
            title: 'Sencho Alert [INFO]',
            body: '🔌 Test Notification from Sencho!',
            type: 'info',
            tag: 'ops',
          }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204 }));
    try {
      const fail = await request(app)
        .post(`/api/notification-routes/${routeId}/test`)
        .set('Cookie', authCookie);
      expect(fail.status).toBe(500);
      expect(JSON.stringify(fail.body)).toContain('HTTP 204');
      expect(JSON.stringify(fail.body)).not.toContain('route-key-secret');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stored-route test fails closed on malformed config without fetch', async () => {
    const broken = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({
        name: 'Broken Apprise',
        stack_patterns: [],
        channel_type: 'apprise',
        channel_url: 'http://apprise.local/notify/broken-key',
        config: { tags: 'x' },
      });
    expect(broken.status).toBe(201);
    const id = broken.body.id as number;
    DatabaseService.getInstance().updateNotificationRoute(id, { config: '{not-json' });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const res = await request(app)
        .post(`/api/notification-routes/${id}/test`)
        .set('Cookie', authCookie);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid/i);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(JSON.stringify(res.body)).not.toContain('broken-key');
    } finally {
      vi.unstubAllGlobals();
      await request(app).delete(`/api/notification-routes/${id}`).set('Cookie', authCookie);
    }
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

// --- Notification history endpoints ---

describe('GET /api/notifications - history', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // Restore the license spy the suite relies on after a full mock reset.
    vi.spyOn(licenseService, 'getTier').mockReturnValue('community');
  });

  it('returns 200 with an array for an authenticated user', async () => {
    const res = await request(app).get('/api/notifications').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/api/notifications');
    expect(res.status).toBe(401);
  });

  it('returns 500 and logs the error when the history read throws', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(DatabaseService.getInstance(), 'getNotificationHistory').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });

    const res = await request(app).get('/api/notifications').set('Cookie', authCookie);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to fetch notifications');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to fetch notifications:', expect.any(Error));
  });

  it('POST /read returns 500 and logs the error when the mark-read write throws', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(DatabaseService.getInstance(), 'markAllNotificationsRead').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });

    const res = await request(app).post('/api/notifications/read').set('Cookie', authCookie);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to mark notifications read');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to mark notifications read:', expect.any(Error));
  });

  it('DELETE /:id returns 500 and logs the error when the delete throws', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(DatabaseService.getInstance(), 'deleteNotification').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });

    const res = await request(app).delete('/api/notifications/1').set('Cookie', authCookie);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to delete notification');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to delete notification:', expect.any(Error));
  });

  it('DELETE / returns 500 and logs the error when the clear-all write throws', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(DatabaseService.getInstance(), 'deleteAllNotifications').mockImplementationOnce(() => {
      throw new Error('database is locked');
    });

    const res = await request(app).delete('/api/notifications').set('Cookie', authCookie);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to clear notifications');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to clear notifications:', expect.any(Error));
  });
});

describe('notification routes - glob patterns and levels', () => {
  it('POST omits stack_patterns and levels to defaults', async () => {
    const res = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({
        name: 'defaults',
        channel_type: 'discord',
        channel_url: 'https://discord.com/api/webhooks/1/abc',
      });
    expect(res.status).toBe(201);
    expect(res.body.stack_patterns).toEqual([]);
    expect(res.body.levels).toBeNull();
    DatabaseService.getInstance().deleteNotificationRoute(res.body.id);
  });

  it('POST rejects null stack_patterns and ReDoS patterns', async () => {
    const nullRes = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({
        name: 'bad-null',
        stack_patterns: null,
        channel_type: 'discord',
        channel_url: 'https://discord.com/api/webhooks/1/abc',
      });
    expect(nullRes.status).toBe(400);

    const redos = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({
        name: 'bad-redos',
        stack_patterns: ['****'],
        channel_type: 'discord',
        channel_url: 'https://discord.com/api/webhooks/1/abc',
      });
    expect(redos.status).toBe(400);
  });

  it('POST/GET/PUT levels round-trip; invalid levels 400', async () => {
    const created = await request(app)
      .post('/api/notification-routes')
      .set('Cookie', authCookie)
      .send({
        name: 'level-route',
        stack_patterns: ['prod-*'],
        levels: ['error'],
        channel_type: 'discord',
        channel_url: 'https://discord.com/api/webhooks/1/abc',
      });
    expect(created.status).toBe(201);
    expect(created.body.levels).toEqual(['error']);
    expect(created.body.stack_patterns).toEqual(['prod-*']);
    const id = created.body.id as number;

    const bad = await request(app)
      .put(`/api/notification-routes/${id}`)
      .set('Cookie', authCookie)
      .send({ levels: ['critical'] });
    expect(bad.status).toBe(400);

    const partial = await request(app)
      .put(`/api/notification-routes/${id}`)
      .set('Cookie', authCookie)
      .send({ name: 'level-route-renamed' });
    expect(partial.status).toBe(200);
    expect(partial.body.levels).toEqual(['error']);
    expect(partial.body.stack_patterns).toEqual(['prod-*']);

    const cleared = await request(app)
      .put(`/api/notification-routes/${id}`)
      .set('Cookie', authCookie)
      .send({ levels: null, stack_patterns: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.levels).toBeNull();
    expect(cleared.body.stack_patterns).toEqual([]);

    DatabaseService.getInstance().deleteNotificationRoute(id);
  });
});
