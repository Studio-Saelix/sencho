/**
 * The hub only forwards forwarding headers it validated itself. A remote that
 * trusts the hub resolves the client from these headers, so a caller-supplied
 * X-Forwarded-For must not survive the hop. Uses the same capture-server shape
 * as proxy-pilot-agent-role-header.test.ts; the proxyReq handler is shared by
 * both proxy and pilot-agent targets.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { seedPersonas } from './fixtures/personas';
import { DatabaseService } from '../services/DatabaseService';
import { resetTrustedProxyBlockListCache } from '../helpers/trustedProxyCidrs';
import { HOST_USAGE_UNKNOWN_HEADER } from '../services/CapabilityRegistry';
import { createTestApiToken } from './helpers/apiTokenTestHelper';

describe('proxy hop forwarding headers', () => {
  let tmpDir: string;
  let app: import('express').Express;
  let server: http.Server;
  let captured: http.IncomingHttpHeaders | null = null;
  let nodeId: number;
  let proxyNodeId: number;
  let personas: ReturnType<typeof seedPersonas>;
  let apiToken: string;
  /** Headers of the last /api/system/stats hop, which the capture server shapes on. */
  let systemStatsHeaders: http.IncomingHttpHeaders | null = null;
  const NUMERIC_STATS = {
    cpu: { usage: '12.3', cores: 8 },
    memory: { total: 4 * 1024 ** 3, used: 2 * 1024 ** 3, free: 2 * 1024 ** 3, usagePercent: '50.0' },
  };
  const UNKNOWN_STATS = {
    cpu: { usage: null, cores: 2 },
    memory: { total: 4 * 1024 ** 3, used: null, free: null, usagePercent: null },
  };

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ app } = await import('../index'));
    personas = seedPersonas(DatabaseService.getInstance());

    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/api/meta')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ version: '0.96.0', capabilities: ['cross-node-rbac'] }));
        return;
      }
      if (req.url?.startsWith('/api/system/stats')) {
        // Mimic a newer nested remote: nullable usage only when the caller
        // advertises that it renders it.
        systemStatsHeaders = req.headers;
        const unknown = req.headers[HOST_USAGE_UNKNOWN_HEADER] === '1';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(unknown ? UNKNOWN_STATS : NUMERIC_STATS));
        return;
      }
      captured = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as import('net').AddressInfo).port;

    nodeId = DatabaseService.getInstance().addNode({
      name: 'proxy-forwarded-address-test',
      type: 'remote',
      mode: 'pilot_agent',
      compose_dir: '/tmp',
      is_default: false,
      api_url: '',
      api_token: '',
    });
    proxyNodeId = DatabaseService.getInstance().addNode({
      name: 'proxy-host-usage-test',
      type: 'remote',
      mode: 'proxy',
      compose_dir: '/tmp',
      is_default: false,
      api_url: `http://127.0.0.1:${port}`,
      api_token: 'remote-token',
    });

    const admin = DatabaseService.getInstance().getUserByUsername('persona-admin');
    if (!admin) throw new Error('expected the seeded admin persona');
    apiToken = createTestApiToken({
      db: DatabaseService,
      scope: 'read-only',
      userId: admin.id,
      name: 'qa-f4-proxy',
    });

    const { NodeRegistry } = await import('../services/NodeRegistry');
    const registry = NodeRegistry.getInstance();
    const orig = registry.getProxyTarget.bind(registry);
    vi.spyOn(registry, 'getProxyTarget').mockImplementation((nid: number) => {
      if (nid === nodeId) return { apiUrl: `http://127.0.0.1:${port}`, apiToken: '', trustedLoopback: true };
      if (nid === proxyNodeId) return { apiUrl: `http://127.0.0.1:${port}`, apiToken: 'remote-token', trustedLoopback: false };
      return orig(nid);
    });
  });

  beforeEach(() => {
    captured = null;
    systemStatsHeaders = null;
    delete process.env.SENCHO_TRUSTED_PROXY_CIDRS;
    resetTrustedProxyBlockListCache();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.SENCHO_TRUSTED_PROXY_CIDRS;
    delete process.env.SENCHO_E2E_ALLOW_LOOPBACK_OUTBOUND;
    resetTrustedProxyBlockListCache();
    cleanupTestDb(tmpDir);
  });

  it('replaces a caller-supplied forwarded address with the hub-resolved peer', async () => {
    const res = await request(app)
      .get('/api/stacks')
      .set('Authorization', personas.admin.bearer)
      .set('x-node-id', String(nodeId))
      .set('X-Forwarded-For', '4.4.4.4')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Real-IP', '4.4.4.4')
      .set('X-Forwarded-Host', 'spoofed.example.com')
      .set('Forwarded', 'for=4.4.4.4;proto=https');

    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    // The hub does not trust its direct peer, so the peer itself is the client.
    expect(captured?.['x-forwarded-for']).toMatch(/127\.0\.0\.1/);
    expect(captured?.['x-forwarded-for']).not.toContain('4.4.4.4');
    // Same rule for the scheme: the hub resolved http, so the caller's https
    // claim must not reach the remote.
    expect(captured?.['x-forwarded-proto']).toBe('http');
    expect(captured?.['x-real-ip']).toBeUndefined();
    expect(captured?.['x-forwarded-host']).toBeUndefined();
    expect(captured?.['forwarded']).toBeUndefined();
  });

  it('forwards the client address and scheme the hub validated', async () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '127.0.0.0/8';
    resetTrustedProxyBlockListCache();

    const res = await request(app)
      .get('/api/stacks')
      .set('Authorization', personas.admin.bearer)
      .set('x-node-id', String(nodeId))
      // The caller prepends a spoofed hop. The hub trusts loopback, so the
      // leftmost untrusted hop (203.0.113.7) is the client it validated, and
      // the spoofed entry must not survive.
      .set('X-Forwarded-For', '4.4.4.4, 203.0.113.7')
      .set('X-Forwarded-Proto', 'https');

    expect(res.status).toBe(200);
    expect(captured?.['x-forwarded-for']).toBe('203.0.113.7');
    expect(captured?.['x-forwarded-proto']).toBe('https');
  });

  it('advertises nullable host usage for a session and does not trust a caller-supplied value', async () => {
    const res = await request(app)
      .get('/api/stacks')
      .set('Authorization', personas.admin.bearer)
      .set('x-node-id', String(nodeId))
      .set(HOST_USAGE_UNKNOWN_HEADER, '0');

    expect(res.status).toBe(200);
    // A browser session runs this build and always renders null, so it cannot
    // opt out by sending `0`.
    expect(captured?.[HOST_USAGE_UNKNOWN_HEADER]).toBe('1');
  });

  it('gives a session the nullable host shape through a proxy-mode node', async () => {
    const res = await request(app)
      .get('/api/system/stats')
      .set('Authorization', personas.admin.bearer)
      .set('x-node-id', String(proxyNodeId));

    expect(res.status).toBe(200);
    expect(systemStatsHeaders?.[HOST_USAGE_UNKNOWN_HEADER]).toBe('1');
    expect(res.body.cpu).toEqual(UNKNOWN_STATS.cpu);
  });

  it('keeps the numeric host shape for an API token through a pilot tunnel', async () => {
    const res = await request(app)
      .get('/api/system/stats')
      .set('Authorization', `Bearer ${apiToken}`)
      .set('x-node-id', String(nodeId));

    expect(res.status).toBe(200);
    // The caller cannot render null and did not ask for it, so the hub must
    // not advertise the capability on its behalf.
    expect(systemStatsHeaders?.[HOST_USAGE_UNKNOWN_HEADER]).toBeUndefined();
    expect(res.body.cpu).toEqual(NUMERIC_STATS.cpu);
  });

  it('keeps the numeric host shape for an API token through a proxy-mode node', async () => {
    process.env.SENCHO_E2E_ALLOW_LOOPBACK_OUTBOUND = 'true';

    const res = await request(app)
      .get('/api/system/stats')
      .set('Authorization', `Bearer ${apiToken}`)
      .set('x-node-id', String(proxyNodeId));

    expect(res.status).toBe(200);
    expect(systemStatsHeaders?.[HOST_USAGE_UNKNOWN_HEADER]).toBeUndefined();
    expect(res.body.cpu).toEqual(NUMERIC_STATS.cpu);
  });

  it('keeps the numeric shape when an API token explicitly sends 0', async () => {
    const res = await request(app)
      .get('/api/system/stats')
      .set('Authorization', `Bearer ${apiToken}`)
      .set('x-node-id', String(nodeId))
      .set(HOST_USAGE_UNKNOWN_HEADER, '0');

    expect(res.status).toBe(200);
    expect(systemStatsHeaders?.[HOST_USAGE_UNKNOWN_HEADER]).toBeUndefined();
    expect(res.body.cpu).toEqual(NUMERIC_STATS.cpu);
  });

  it('passes an API token request for nullable usage through unchanged', async () => {
    const res = await request(app)
      .get('/api/system/stats')
      .set('Authorization', `Bearer ${apiToken}`)
      .set('x-node-id', String(nodeId))
      .set(HOST_USAGE_UNKNOWN_HEADER, '1');

    expect(res.status).toBe(200);
    expect(systemStatsHeaders?.[HOST_USAGE_UNKNOWN_HEADER]).toBe('1');
    expect(res.body.cpu).toEqual(UNKNOWN_STATS.cpu);
  });

  it('keeps the numeric shape for a hub that sends no host-usage header', async () => {
    const nodeProxyToken = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
    const res = await request(app)
      .get('/api/system/stats')
      .set('Authorization', `Bearer ${nodeProxyToken}`)
      .set('x-node-id', String(nodeId));

    expect(res.status).toBe(200);
    expect(systemStatsHeaders?.[HOST_USAGE_UNKNOWN_HEADER]).toBeUndefined();
    expect(res.body.cpu).toEqual(NUMERIC_STATS.cpu);
  });
});
