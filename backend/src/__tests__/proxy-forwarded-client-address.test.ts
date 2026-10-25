/**
 * The hub only forwards forwarding headers it validated itself. A remote that
 * trusts the hub resolves the client from these headers, so a caller-supplied
 * X-Forwarded-For must not survive the hop. Uses the same capture-server shape
 * as proxy-pilot-agent-role-header.test.ts; the proxyReq handler is shared by
 * both proxy and pilot-agent targets.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import http from 'http';
import request from 'supertest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { seedPersonas } from './fixtures/personas';
import { DatabaseService } from '../services/DatabaseService';
import { resetTrustedProxyBlockListCache } from '../helpers/trustedProxyCidrs';

describe('proxy hop forwarding headers', () => {
  let tmpDir: string;
  let app: import('express').Express;
  let server: http.Server;
  let captured: http.IncomingHttpHeaders | null = null;
  let nodeId: number;
  let personas: ReturnType<typeof seedPersonas>;

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

    const { NodeRegistry } = await import('../services/NodeRegistry');
    const registry = NodeRegistry.getInstance();
    const orig = registry.getProxyTarget.bind(registry);
    vi.spyOn(registry, 'getProxyTarget').mockImplementation((nid: number) => {
      if (nid === nodeId) return { apiUrl: `http://127.0.0.1:${port}`, apiToken: '', trustedLoopback: true };
      return orig(nid);
    });
  });

  beforeEach(() => {
    captured = null;
    delete process.env.SENCHO_TRUSTED_PROXY_CIDRS;
    resetTrustedProxyBlockListCache();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.SENCHO_TRUSTED_PROXY_CIDRS;
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
});
