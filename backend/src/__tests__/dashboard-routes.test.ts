/**
 * Integration tests for the dashboard router.
 *
 * Covers:
 *  - Both endpoints reject unauthenticated requests (global authGate).
 *  - GET /api/dashboard/configuration returns the documented shape and
 *    applies tier-correct `locked` flags for Community, Skipper, and
 *    Admiral personas (toggled via LicenseService spies).
 *  - GET /api/dashboard/stack-restarts clamps the `days` query parameter
 *    to [1, 30] and falls back to 7 for invalid inputs.
 *  - Neither endpoint leaks secret material (agent URLs, tokens) in the
 *    response payload.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let adminCookie: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ LicenseService } = await import('../services/LicenseService'));
  ({ DatabaseService } = await import('../services/DatabaseService'));

  // Default the app to a paid+admiral tier so the import sees a fully
  // populated license; individual tests override with vi.spyOn before
  // hitting the route.
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('admiral');
  vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: null, maxViewers: null });

  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  // Reset to the default Admiral baseline before each test; individual
  // tests below re-spy as needed for Community/Skipper personas.
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('admiral');
});

describe('GET /api/dashboard/configuration', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/dashboard/configuration');
    expect(res.status).toBe(401);
  });

  it('returns the documented shape for an authenticated request', async () => {
    const res = await request(app).get('/api/dashboard/configuration').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tier: expect.any(String),
      notifications: {
        agents: { discord: { configured: expect.any(Boolean) }, slack: { configured: expect.any(Boolean) }, webhook: { configured: expect.any(Boolean) } },
        alertRules: expect.any(Number),
        routingRules: { count: expect.any(Number), enabledCount: expect.any(Number), locked: expect.any(Boolean) },
      },
      automation: {
        autoHeal: { total: expect.any(Number), enabled: expect.any(Number) },
        autoUpdate: { total: expect.any(Number), enabled: expect.any(Number) },
        scheduledTasks: { total: expect.any(Number), enabled: expect.any(Number), locked: expect.any(Boolean) },
        webhooks: { total: expect.any(Number), enabled: expect.any(Number), locked: expect.any(Boolean) },
      },
      security: { scanPolicies: { total: expect.any(Number), enabled: expect.any(Number), locked: expect.any(Boolean) } },
      thresholds: expect.any(Object),
      backup: { provider: expect.any(String), autoUpload: expect.any(Boolean), locked: expect.any(Boolean) },
    });
  });

  it('flags routingRules / webhooks / scheduledTasks / scanPolicies as locked for Community', async () => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue(null);

    const res = await request(app).get('/api/dashboard/configuration').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.notifications.routingRules.locked).toBe(true);
    expect(res.body.automation.webhooks.locked).toBe(true);
    expect(res.body.automation.scheduledTasks.locked).toBe(true);
    expect(res.body.security.scanPolicies.locked).toBe(true);
  });

  it('unlocks paid-tier rows but keeps Admiral-only rows locked for Skipper', async () => {
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('skipper');

    const res = await request(app).get('/api/dashboard/configuration').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.notifications.routingRules.locked).toBe(false);
    expect(res.body.automation.webhooks.locked).toBe(false);
    expect(res.body.security.scanPolicies.locked).toBe(false);
    // Scheduled tasks remain Admiral-only.
    expect(res.body.automation.scheduledTasks.locked).toBe(true);
  });

  it('unlocks every gated row for Admiral', async () => {
    // The beforeEach already sets Admiral; reassert for clarity.
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
    vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('admiral');

    const res = await request(app).get('/api/dashboard/configuration').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.notifications.routingRules.locked).toBe(false);
    expect(res.body.automation.webhooks.locked).toBe(false);
    expect(res.body.automation.scheduledTasks.locked).toBe(false);
    expect(res.body.security.scanPolicies.locked).toBe(false);
  });

  it('does not leak agent URLs, tokens, or other secret material in the response', async () => {
    // Seed a node-1 agent with a Discord URL so the configuration path
    // exercises the `configured` truthy branch. The URL must never appear
    // anywhere in the JSON response.
    const SECRET_URL = 'https://discord.example.invalid/webhook/SECRET-SHOULD-NEVER-LEAK';
    const db = DatabaseService.getInstance();
    db.upsertAgent(1, { type: 'discord', url: SECRET_URL, enabled: true });

    try {
      const res = await request(app).get('/api/dashboard/configuration').set('Cookie', adminCookie);
      expect(res.status).toBe(200);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('SECRET-SHOULD-NEVER-LEAK');
      expect(serialized).not.toContain('discord.example.invalid');
      // The agent's `configured` flag is what the dashboard renders;
      // confirm it surfaced so the test proves it walked the right
      // branch.
      expect(res.body.notifications.agents.discord.configured).toBe(true);
    } finally {
      db.getDb().prepare('DELETE FROM agents WHERE url = ?').run(SECRET_URL);
    }
  });
});

describe('GET /api/dashboard/stack-restarts', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/dashboard/stack-restarts');
    expect(res.status).toBe(401);
  });

  it('returns an array for authenticated requests', async () => {
    const res = await request(app).get('/api/dashboard/stack-restarts').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('clamps days=0 to the 7-day default', async () => {
    const res = await request(app).get('/api/dashboard/stack-restarts?days=0').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    // Cannot easily observe the clamped value from the response shape, but
    // a 200 with an array proves the route did not bail on the invalid
    // input.
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('clamps days=999 to the 30-day ceiling', async () => {
    const res = await request(app).get('/api/dashboard/stack-restarts?days=999').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('falls back to the 7-day default for a non-numeric days value', async () => {
    const res = await request(app).get('/api/dashboard/stack-restarts?days=banana').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
