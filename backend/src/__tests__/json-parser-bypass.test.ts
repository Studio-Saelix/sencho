/**
 * Regression guard for the `conditionalJsonParser` remote-proxy bypass.
 *
 * When a request targets a remote node via `x-node-id` and the path is NOT in
 * `PROXY_EXEMPT_PREFIXES`, the JSON parser must leave the request stream
 * untouched so `http-proxy` can pipe the raw body to the upstream Sencho
 * instance. If the parser runs, `req.pipe(proxyReq)` errors with
 * `ERR_HTTP_STREAM_WRITE_AFTER_END` and the remote never sees the body.
 *
 * This test spins up a tiny HTTP echo server, seeds a remote node pointing at
 * it, and POSTs a JSON body through the proxy. The echo server asserts the
 * bytes arrived intact. A second case confirms that exempt paths are handled
 * locally (upstream receives nothing).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import http from 'http';
import type { AddressInfo } from 'net';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

describe('conditionalJsonParser remote-proxy bypass', () => {
  let tmpDir: string;
  let app: import('express').Express;
  let upstream: http.Server;
  let upstreamUrl: string;
  let lastUpstreamBody: Buffer | null = null;
  let lastUpstreamAuth: string | null = null;
  let authHeader: string;
  let remoteNodeId: number;

  beforeAll(async () => {
    tmpDir = await setupTestDb();

    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        lastUpstreamBody = Buffer.concat(chunks);
        lastUpstreamAuth = (req.headers['authorization'] as string | undefined) ?? null;
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      });
      req.on('error', () => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const addr = upstream.address() as AddressInfo;
    upstreamUrl = `http://127.0.0.1:${addr.port}`;

    ({ app } = await import('../index'));

    const { DatabaseService } = await import('../services/DatabaseService');
    remoteNodeId = DatabaseService.getInstance().addNode({
      name: 'bypass-test-remote',
      type: 'remote',
      compose_dir: '/tmp',
      is_default: false,
      api_url: upstreamUrl,
      api_token: 'bypass-test-token',
    });

    const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
    authHeader = `Bearer ${token}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    cleanupTestDb(tmpDir);
  });

  it('forwards the raw request body to the remote for proxy-eligible paths', async () => {
    lastUpstreamBody = null;
    lastUpstreamAuth = null;

    const payload = { name: 'parser-bypass-stack', content: 'services:\n  web:\n    image: nginx' };

    const res = await request(app)
      .post('/api/stacks')
      .set('Authorization', authHeader)
      .set('x-node-id', String(remoteNodeId))
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(200);
    expect(lastUpstreamBody).not.toBeNull();
    expect(lastUpstreamBody!.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lastUpstreamBody!.toString('utf-8'));
    expect(parsed).toEqual(payload);
    expect(lastUpstreamAuth).toBe('Bearer bypass-test-token');
  });

  it('handles proxy-exempt paths locally (upstream receives nothing)', async () => {
    lastUpstreamBody = null;
    lastUpstreamAuth = null;

    const res = await request(app)
      .get(`/api/nodes/${remoteNodeId}`)
      .set('Authorization', authHeader)
      .set('x-node-id', String(remoteNodeId));

    expect(lastUpstreamBody).toBeNull();
    expect(lastUpstreamAuth).toBeNull();
    expect([200, 404]).toContain(res.status);
  });

  it('forwards Apprise agent config bodies intact to the remote', async () => {
    lastUpstreamBody = null;
    lastUpstreamAuth = null;

    const payload = {
      type: 'apprise',
      url: 'http://apprise.local/notify',
      enabled: true,
      config: { urls: 'discord://webhook-id/webhook-token?token=query-secret' },
    };

    const res = await request(app)
      .post('/api/agents')
      .set('Authorization', authHeader)
      .set('x-node-id', String(remoteNodeId))
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(200);
    expect(lastUpstreamBody).not.toBeNull();
    expect(JSON.parse(lastUpstreamBody!.toString('utf-8'))).toEqual(payload);
    expect(lastUpstreamAuth).toBe('Bearer bypass-test-token');
    expect(JSON.stringify(res.body)).not.toContain('query-secret');
  });
});
