/**
 * Pilot-agent-mode header parity: the createRemoteProxyMiddleware code path
 * for pilot_agent remotes is identical to proxy mode (the only difference is
 * an empty apiToken from NodeRegistry.getProxyTarget). Stub the singleton so
 * a pilot_agent node routes through a loopback capture server and assert the
 * same PROXY_ROLE_HEADER is forwarded.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import request from 'supertest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { PROXY_ROLE_HEADER } from '../services/license-headers';
import { seedPersonas } from './fixtures/personas';
import { DatabaseService } from '../services/DatabaseService';

describe('pilot-agent-mode proxy role header parity', () => {
  let tmpDir: string;
  let app: import('express').Express;
  let server: http.Server;
  let captured: http.IncomingHttpHeaders | null = null;
  let pilotNodeId: number;
  let personas: ReturnType<typeof seedPersonas>;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ app } = await import('../index'));
    personas = seedPersonas(DatabaseService.getInstance());

    // Loopback capture server that advertises cross-node-rbac.
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

    pilotNodeId = DatabaseService.getInstance().addNode({
      name: 'pilot-header-test',
      type: 'remote',
      mode: 'pilot_agent',
      compose_dir: '/tmp',
      is_default: false,
      api_url: '',
      api_token: '',
    });

    // getProxyTarget returns null for pilot_agent without a live bridge.
    // Stub it to return the capture-server URL with an empty apiToken — the
    // exact shape a real PilotTunnelBridge produces at runtime.
    const { NodeRegistry } = await import('../services/NodeRegistry');
    const registry = NodeRegistry.getInstance();
    const orig = registry.getProxyTarget.bind(registry);
    vi.spyOn(registry, 'getProxyTarget').mockImplementation((nid: number) => {
      if (nid === pilotNodeId) return { apiUrl: `http://127.0.0.1:${port}`, apiToken: '', trustedLoopback: true };
      return orig(nid);
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanupTestDb(tmpDir);
  });

  it('forwards the deployer session role through the pilot-agent proxy path', async () => {
    captured = null;
    const res = await request(app)
      .get('/api/stacks')
      .set('Authorization', personas.deployer.bearer)
      .set('x-node-id', String(pilotNodeId));
    expect(res.status).toBe(200);
    // The capture server must have received the request.
    expect(captured).not.toBeNull();
    expect(captured?.[PROXY_ROLE_HEADER]).toBe('deployer');
  });

  it('strips conditional request headers on the gitops identity hop', async () => {
    captured = null;
    const res = await request(app)
      .get('/api/git-sources')
      .set('Authorization', personas.deployer.bearer)
      .set('x-node-id', String(pilotNodeId))
      // A remote answering this with 304 would let the client keep a cached
      // page the hub never re-filtered, so the revalidation question must
      // never reach the remote.
      .set('If-None-Match', 'W/"cached-upstream"')
      .set('Accept', 'application/json');
    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured?.['if-none-match']).toBeUndefined();
    // Unrelated headers still travel.
    expect(captured?.['accept']).toBe('application/json');
    // The answer itself must not be cacheable under any validator.
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('overwrites a smuggled admin header with the real deployer role on pilot path', async () => {
    captured = null;
    const res = await request(app)
      .get('/api/stacks')
      .set('Authorization', personas.deployer.bearer)
      .set('x-node-id', String(pilotNodeId))
      .set(PROXY_ROLE_HEADER, 'admin'); // smuggled
    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured?.[PROXY_ROLE_HEADER]).toBe('deployer');
  });

  it('forwards the admin session role through the pilot-agent proxy path', async () => {
    captured = null;
    const res = await request(app)
      .get('/api/stacks')
      .set('Authorization', personas.admin.bearer)
      .set('x-node-id', String(pilotNodeId));
    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured?.[PROXY_ROLE_HEADER]).toBe('admin');
  });
});
