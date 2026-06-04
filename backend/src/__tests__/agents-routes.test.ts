/**
 * Integration tests for /api/agents (notification-channel configuration).
 * Locks down auth, admin gating, and validation before extraction.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
  DatabaseService.getInstance().addUser({ username: 'agents-viewer', password_hash: viewerHash, role: 'viewer' });
  const viewerRes = await request(app).post('/api/auth/login').send({ username: 'agents-viewer', password: 'viewerpass' });
  const cookies = viewerRes.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(() => {
  const db = DatabaseService.getInstance().getDb();
  db.prepare('DELETE FROM agents').run();
});

describe('GET /api/agents', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/agents');
    expect(res.status).toBe(401);
  });

  it('returns empty array when no agents configured', async () => {
    const res = await request(app).get('/api/agents').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('lists configured agents for authenticated users', async () => {
    const db = DatabaseService.getInstance();
    db.upsertAgent(1, { type: 'discord', url: 'https://discord.com/api/webhooks/abc/def', enabled: true });
    const res = await request(app).get('/api/agents').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].type).toBe('discord');
  });
});

describe('POST /api/agents', () => {
  const validPayload = {
    type: 'discord',
    url: 'https://discord.com/api/webhooks/1/token',
    enabled: true,
  };

  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).post('/api/agents').send(validPayload);
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users with 403', async () => {
    const res = await request(app).post('/api/agents').set('Cookie', viewerCookie).send(validPayload);
    expect(res.status).toBe(403);
  });

  it('rejects unsupported channel types with 400', async () => {
    const res = await request(app).post('/api/agents').set('Cookie', adminCookie).send({
      ...validPayload, type: 'carrier-pigeon',
    });
    expect(res.status).toBe(400);
  });

  it('rejects non-HTTPS urls with 400', async () => {
    const res = await request(app).post('/api/agents').set('Cookie', adminCookie).send({
      ...validPayload, url: 'http://example.com/hook',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/url/);
  });

  it('rejects non-boolean enabled with 400', async () => {
    const res = await request(app).post('/api/agents').set('Cookie', adminCookie).send({
      ...validPayload, enabled: 'yes',
    });
    expect(res.status).toBe(400);
  });

  it('upserts a valid agent', async () => {
    const res = await request(app).post('/api/agents').set('Cookie', adminCookie).send(validPayload);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const agents = DatabaseService.getInstance().getAgents(1);
    expect(agents.length).toBe(1);
    expect(agents[0].type).toBe('discord');
    expect(Boolean(agents[0].enabled)).toBe(true);
  });

  it('replaces an existing agent of the same type (upsert)', async () => {
    const db = DatabaseService.getInstance();
    db.upsertAgent(1, { type: 'slack', url: 'https://hooks.slack.com/old', enabled: false });

    const res = await request(app).post('/api/agents').set('Cookie', adminCookie).send({
      type: 'slack', url: 'https://hooks.slack.com/new', enabled: true,
    });
    expect(res.status).toBe(200);

    const agents = db.getAgents(1);
    expect(agents.length).toBe(1);
    expect(agents[0].url).toBe('https://hooks.slack.com/new');
    expect(Boolean(agents[0].enabled)).toBe(true);
  });
});
