/**
 * Regression guard for `createRemoteProxyMiddleware` mount order.
 *
 * `index.ts` mounts every local `/api/<group>` router before the remote proxy
 * at step 15 of the canonical middleware order. A remote-`nodeId` request
 * must short-circuit into the proxy rather than match a local router. If the
 * order were reversed, a GET `/api/stacks` for a remote node would return the
 * control instance's local stack list instead of the remote's.
 *
 * The test seeds a remote node whose `api_url` points at a closed loopback
 * port. The proxy forwards, the connection fails, and the middleware
 * responds with a 502. A local handler on the same path would return 200
 * (or 404 / 400) with a JSON body, never 502. That distinguishing response
 * proves the proxy intercepted first.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';

describe('remote proxy mount order', () => {
  let tmpDir: string;
  let app: import('express').Express;
  let authHeader: string;
  let remoteNodeId: number;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ app } = await import('../index'));

    const { DatabaseService } = await import('../services/DatabaseService');
    // 127.0.0.1:1 is a reserved port that no process binds; TCP connect
    // fails immediately with ECONNREFUSED. The proxy surfaces that as 502.
    remoteNodeId = DatabaseService.getInstance().addNode({
      name: 'mount-order-remote',
      type: 'remote',
      compose_dir: '/tmp',
      is_default: false,
      api_url: 'http://127.0.0.1:1',
      api_token: 'mount-order-token',
    });

    const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
    authHeader = `Bearer ${token}`;
  });

  afterAll(() => {
    cleanupTestDb(tmpDir);
  });

  it('short-circuits remote-nodeId requests into the proxy before local routers match', async () => {
    const res = await request(app)
      .get('/api/stacks')
      .set('Authorization', authHeader)
      .set('x-node-id', String(remoteNodeId));

    // 502: the proxy caught the request and the unreachable upstream reported
    // the connection refusal. If a local router had matched first, we would
    // have seen a 200 with a JSON array of local stacks.
    expect(res.status).toBe(502);
    // `x-sencho-proxy` is attached by the proxy's proxyRes callback, which
    // only fires when the upstream produced a response. The unreachable
    // upstream never does; absence here is consistent with a proxy error.
    expect(res.headers['x-sencho-proxy']).toBeUndefined();
    expect(res.body?.error).toMatch(/unreachable/i);
  });

  it('routes local requests (no x-node-id) to the local handler', async () => {
    const res = await request(app)
      .get('/api/stacks')
      .set('Authorization', authHeader);

    // Local handler responds with a stack list (200) or, in CI without docker,
    // a 500 from DockerController. Anything other than 502 proves the local
    // router matched instead of the proxy.
    expect(res.status).not.toBe(502);
  });

  it('short-circuits /api/stacks/statuses (the sidebar status poll) for remote nodes', async () => {
    // The sidebar polls /api/stacks/statuses every few seconds; if a future
    // refactor accidentally mounted a local fast-path before the proxy, every
    // operator viewing a remote node would silently see the central instance's
    // own statuses. Asserts the same 502 short-circuit as /api/stacks.
    const res = await request(app)
      .get('/api/stacks/statuses')
      .set('Authorization', authHeader)
      .set('x-node-id', String(remoteNodeId));

    expect(res.status).toBe(502);
    expect(res.headers['x-sencho-proxy']).toBeUndefined();
    expect(res.body?.error).toMatch(/unreachable/i);
  });

  it('handles proxy-exempt paths locally even when x-node-id targets a remote', async () => {
    // /api/nodes/:id is in PROXY_EXEMPT_PREFIXES. The proxy must never catch
    // gateway-level concerns; otherwise a user whose default node is remote
    // could never manage the node registry itself.
    const res = await request(app)
      .get(`/api/nodes/${remoteNodeId}`)
      .set('Authorization', authHeader)
      .set('x-node-id', String(remoteNodeId));

    expect(res.status).not.toBe(502);
    expect([200, 404]).toContain(res.status);
  });
});
