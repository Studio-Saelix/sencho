/**
 * Integration tests for /api/agents (notification-channel configuration).
 * Locks down auth, admin gating, and validation before extraction.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { PAYLOAD_TEMPLATE_MAX_LENGTH } from '../helpers/notificationPayloadTemplate';

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

describe('Apprise agents - redaction and preserve-on-write', () => {
  const keyedUrl = 'http://apprise.local/notify/key-secret-value';
  const serviceUrl = 'discord://webhook-id/webhook-token?token=query-secret';

  it('GET redacts keyed endpoint and never returns destination secrets', async () => {
    DatabaseService.getInstance().upsertAgent(1, {
      type: 'apprise',
      url: keyedUrl,
      enabled: true,
      config: JSON.stringify({ tags: 'ops' }),
    });

    const res = await request(app).get('/api/agents').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body[0].url).toBe('http://apprise.local/notify/<redacted>');
    expect(res.body[0].config).toMatchObject({ mode: 'keyed', tags: 'ops', has_urls: false });
    expect(res.body[0].secrets_redacted).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('key-secret-value');
  });

  it('GET for stateless mode exposes providers and url_count only', async () => {
    DatabaseService.getInstance().upsertAgent(1, {
      type: 'apprise',
      url: 'http://apprise.local/notify',
      enabled: true,
      config: JSON.stringify({ urls: serviceUrl }),
    });

    const res = await request(app).get('/api/agents').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body[0].url).toBe('http://apprise.local/notify');
    expect(res.body[0].config).toMatchObject({
      mode: 'stateless',
      has_urls: true,
      providers: ['discord'],
      url_count: 1,
    });
    expect(JSON.stringify(res.body)).not.toContain('webhook-token');
    expect(JSON.stringify(res.body)).not.toContain('query-secret');
  });

  it('rejects posting a redacted endpoint URL', async () => {
    DatabaseService.getInstance().upsertAgent(1, {
      type: 'apprise',
      url: keyedUrl,
      enabled: true,
      config: JSON.stringify({ tags: 'ops' }),
    });

    const res = await request(app).post('/api/agents').set('Cookie', adminCookie).send({
      type: 'apprise',
      url: 'http://apprise.local/notify/<redacted>',
      enabled: true,
      config: { tags: 'ops' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects public DTO config shapes on write', async () => {
    const res = await request(app).post('/api/agents').set('Cookie', adminCookie).send({
      type: 'apprise',
      url: 'http://apprise.local/notify',
      enabled: true,
      config: { mode: 'stateless', has_urls: true, providers: ['discord'], url_count: 1 },
    });
    expect(res.status).toBe(400);
  });

  it('preserves stored secrets when url and config are omitted', async () => {
    const db = DatabaseService.getInstance();
    db.upsertAgent(1, {
      type: 'apprise',
      url: keyedUrl,
      enabled: true,
      config: JSON.stringify({ tags: 'ops' }),
    });

    const res = await request(app).post('/api/agents').set('Cookie', adminCookie).send({
      type: 'apprise',
      enabled: false,
    });
    expect(res.status).toBe(200);

    const agents = db.getAgents(1);
    expect(agents[0].url).toBe(keyedUrl);
    expect(agents[0].config).toBe(JSON.stringify({ tags: 'ops' }));
    expect(Boolean(agents[0].enabled)).toBe(false);
  });

  it('creates a keyed agent with no config and persists {}', async () => {
    const res = await request(app).post('/api/agents').set('Cookie', adminCookie).send({
      type: 'apprise',
      url: 'http://apprise.local/notify/new-key',
      enabled: true,
    });
    expect(res.status).toBe(200);
    const agent = DatabaseService.getInstance().getAgents(1).find(a => a.type === 'apprise');
    expect(agent?.url).toBe('http://apprise.local/notify/new-key');
    expect(agent?.config).toBe('{}');
  });

  it('rejects preserve-on-write when stored Apprise config is malformed', async () => {
    DatabaseService.getInstance().upsertAgent(1, {
      type: 'apprise',
      url: keyedUrl,
      enabled: true,
      config: '{not-json',
    });

    const res = await request(app).post('/api/agents').set('Cookie', adminCookie).send({
      type: 'apprise',
      enabled: false,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
    expect(JSON.stringify(res.body)).not.toContain('key-secret-value');
  });
});

describe('payload templates', () => {
  it('stores and returns a valid payload template', async () => {
    const template = '{"title": "{{level}}", "body": "{{message}}"}';
    const res = await request(app).post('/api/agents').set('Cookie', adminCookie).send({
      type: 'discord',
      url: 'https://discord.com/api/webhooks/1/token',
      enabled: true,
      payload_template: template,
    });
    expect(res.status).toBe(200);

    const get = await request(app).get('/api/agents').set('Cookie', adminCookie);
    expect(get.status).toBe(200);
    expect(get.body[0].payload_template).toBe(template);
  });

  it('rejects unknown template variables with a named error', async () => {
    const res = await request(app).post('/api/agents').set('Cookie', adminCookie).send({
      type: 'discord',
      url: 'https://discord.com/api/webhooks/1/token',
      enabled: true,
      payload_template: '{"a": "{{foo}}"}',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown template variable: \{\{foo\}\}/);
  });

  it('rejects invalid JSON, non-strings, and over-length templates', async () => {
    const base = {
      type: 'discord',
      url: 'https://discord.com/api/webhooks/1/token',
      enabled: true,
    };
    const malformed = await request(app).post('/api/agents').set('Cookie', adminCookie).send({
      ...base, payload_template: '{',
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toContain('valid JSON');

    const nonString = await request(app).post('/api/agents').set('Cookie', adminCookie).send({
      ...base, payload_template: 42,
    });
    expect(nonString.status).toBe(400);
    expect(nonString.body.error).toContain('must be a string');

    const over = await request(app).post('/api/agents').set('Cookie', adminCookie).send({
      ...base, payload_template: `{"msg":"${'x'.repeat(PAYLOAD_TEMPLATE_MAX_LENGTH - 9)}"}`,
    });
    expect(over.status).toBe(400);
    expect(over.body.error).toContain('8000 characters or fewer');

    const atLimit = await request(app).post('/api/agents').set('Cookie', adminCookie).send({
      ...base, payload_template: `{"msg":"${'x'.repeat(PAYLOAD_TEMPLATE_MAX_LENGTH - 10)}"}`,
    });
    expect(atLimit.status).toBe(200);
  });

  it('preserves the stored template when payload_template is omitted', async () => {
    const db = DatabaseService.getInstance();
    db.upsertAgent(1, {
      type: 'slack',
      url: 'https://hooks.slack.com/services/T/B/X',
      enabled: true,
      payload_template: '{"text": "{{message}}"}',
    });

    const res = await request(app).post('/api/agents').set('Cookie', adminCookie).send({
      type: 'slack',
      url: 'https://hooks.slack.com/services/T/B/X',
      enabled: true,
    });
    expect(res.status).toBe(200);
    expect(db.getAgents(1).find(a => a.type === 'slack')?.payload_template).toBe('{"text": "{{message}}"}');
  });

  it('clears the stored template with an empty string or null', async () => {
    const db = DatabaseService.getInstance();
    db.upsertAgent(1, {
      type: 'slack',
      url: 'https://hooks.slack.com/services/T/B/X',
      enabled: true,
      payload_template: '{"text": "{{message}}"}',
    });

    const cleared = await request(app).post('/api/agents').set('Cookie', adminCookie).send({
      type: 'slack',
      url: 'https://hooks.slack.com/services/T/B/X',
      enabled: true,
      payload_template: '',
    });
    expect(cleared.status).toBe(200);
    expect(db.getAgents(1).find(a => a.type === 'slack')?.payload_template).toBeNull();
  });

  it('rejects a template write from a user without node:manage', async () => {
    const res = await request(app).post('/api/agents').set('Cookie', viewerCookie).send({
      type: 'discord',
      url: 'https://discord.com/api/webhooks/1/token',
      enabled: true,
      payload_template: '{"a": "{{level}}"}',
    });
    expect(res.status).toBe(403);
  });

  it('rejects Apprise templates that carry urls, tag, or a non-object body', async () => {
    const base = {
      type: 'apprise',
      url: 'http://apprise.local/notify',
      enabled: true,
    };
    const withUrls = await request(app).post('/api/agents').set('Cookie', adminCookie).send({
      ...base, config: { urls: 'discord://token@id' }, payload_template: '{"urls": "discord://token@id"}',
    });
    expect(withUrls.status).toBe(400);
    expect(withUrls.body.error).toContain('urls');

    const withTag = await request(app).post('/api/agents').set('Cookie', adminCookie).send({
      ...base, config: { tags: 'ops' }, payload_template: '{"tag": "ops"}',
    });
    expect(withTag.status).toBe(400);

    const scalar = await request(app).post('/api/agents').set('Cookie', adminCookie).send({
      ...base, config: { urls: 'discord://token@id' }, payload_template: '"{{message}}"',
    });
    expect(scalar.status).toBe(400);
    expect(scalar.body.error).toContain('render a JSON object');
  });

  it('never exposes Apprise destination credentials through a templated agent', async () => {
    const db = DatabaseService.getInstance();
    const serviceUrl = 'discord://webhook-id/webhook-token?token=query-secret';
    db.upsertAgent(1, {
      type: 'apprise',
      url: 'http://apprise.local/notify',
      enabled: true,
      config: JSON.stringify({ urls: serviceUrl }),
      payload_template: '{"title": "{{level}}"}',
    });

    const res = await request(app).get('/api/agents').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body[0].payload_template).toBe('{"title": "{{level}}"}');
    expect(JSON.stringify(res.body)).not.toContain('webhook-token');
    expect(JSON.stringify(res.body)).not.toContain('query-secret');
  });
});
