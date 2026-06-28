/**
 * Regression guard for WebSocket upgrade dispatch order.
 *
 * `websocket/upgradeHandler.ts` dispatches upgrades in a first-match-wins
 * ladder: pilot tunnel, then auth, then API-token scope gate, then
 * notifications (local-only), then remote forwarder, then stack logs, then
 * host console, then generic. Reordering the ladder silently breaks several
 * product paths. This test pins each position by observing behavior that
 * could only originate from the expected handler.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { generateApiToken } from '../utils/apiTokenFormat';
import { createTestApiToken } from './helpers/apiTokenTestHelper';

describe('WebSocket upgrade dispatch order', () => {
  let tmpDir: string;
  let server: import('http').Server;
  let port: number;
  let sessionCookie: string;
  let remoteNodeId: number;

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ server } = await import('../index'));

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    port = addr.port;

    const { DatabaseService } = await import('../services/DatabaseService');
    remoteNodeId = DatabaseService.getInstance().addNode({
      name: 'upgrade-order-remote',
      type: 'remote',
      compose_dir: '/tmp',
      is_default: false,
      api_url: 'http://127.0.0.1:1',
      api_token: 'upgrade-order-token',
    });

    const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
    sessionCookie = `sencho_token=${token}`;

    // Existing /api/mesh/proxy-tunnel scope tests assume the receiver
    // license clears the paid check. Set the license to active (paid) so
    // the credential-only assertions below still hold; the dedicated
    // license-gating describe block flips and restores per-test.
    DatabaseService.getInstance().setSystemState('license_status', 'active');
  });

  afterAll(async () => {
    // Clear the paid state beforeAll set so this file does not leak
    // license context into other tests sharing the same test DB.
    const { DatabaseService } = await import('../services/DatabaseService');
    DatabaseService.getInstance().setSystemState('license_status', 'community');
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    cleanupTestDb(tmpDir);
  });

  function connect(
    pathAndQuery: string,
    opts: { cookie?: string; bearer?: string; extraHeaders?: Record<string, string> } = {},
  ): WebSocket {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers['cookie'] = opts.cookie;
    if (opts.bearer) headers['authorization'] = `Bearer ${opts.bearer}`;
    if (opts.extraHeaders) Object.assign(headers, opts.extraHeaders);
    return new WebSocket(`ws://127.0.0.1:${port}${pathAndQuery}`, { headers });
  }

  /** Wait for an open or a failure; resolves with one of several outcomes. */
  function waitForOutcome(ws: WebSocket, timeoutMs = 3000): Promise<
    | { kind: 'open' }
    | { kind: 'unexpected'; status: number }
    | { kind: 'close'; code: number }
    | { kind: 'error' }
    | { kind: 'timeout' }
  > {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      const done = (outcome: Awaited<ReturnType<typeof waitForOutcome>>): void => {
        clearTimeout(timer);
        resolve(outcome);
      };
      ws.once('open', () => done({ kind: 'open' }));
      ws.once('unexpected-response', (_req, res) => done({ kind: 'unexpected', status: res.statusCode ?? 0 }));
      ws.once('close', (code: number) => done({ kind: 'close', code }));
      ws.once('error', () => done({ kind: 'error' }));
    });
  }

  async function waitForSubscriberCount(target: number, timeoutMs = 2000): Promise<number> {
    const { NotificationService } = await import('../services/NotificationService');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const count = NotificationService.getInstance().getSubscriberCount();
      if (count === target) return count;
      await new Promise((r) => setTimeout(r, 25));
    }
    return NotificationService.getInstance().getSubscriberCount();
  }

  it('rejects unauthenticated upgrades with HTTP 401 (default-deny)', async () => {
    const ws = connect('/ws');
    const outcome = await waitForOutcome(ws);
    expect(outcome.kind).toBe('unexpected');
    if (outcome.kind === 'unexpected') expect(outcome.status).toBe(401);
  });

  it('routes /ws/notifications (local, no nodeId) to the notifications handler', async () => {
    const { NotificationService } = await import('../services/NotificationService');
    const before = NotificationService.getInstance().getSubscriberCount();

    const ws = connect('/ws/notifications', { cookie: sessionCookie });
    const outcome = await waitForOutcome(ws);
    expect(outcome.kind).toBe('open');

    const afterOpen = NotificationService.getInstance().getSubscriberCount();
    expect(afterOpen).toBe(before + 1);

    ws.close();
    const afterClose = await waitForSubscriberCount(before);
    expect(afterClose).toBe(before);
  });

  it('routes /ws/notifications?nodeId=<remote> to the remote forwarder, not local notifications', async () => {
    const { NotificationService } = await import('../services/NotificationService');
    const before = NotificationService.getInstance().getSubscriberCount();

    const ws = connect(`/ws/notifications?nodeId=${remoteNodeId}`, { cookie: sessionCookie });
    await waitForOutcome(ws);

    // Whichever outcome arrives, the local subscriber count MUST NOT have
    // incremented. If it did, a remote-targeted upgrade is reaching the local
    // notifications handler, which is exactly the bug the dispatch order
    // prevents.
    await new Promise((r) => setTimeout(r, 50));
    expect(NotificationService.getInstance().getSubscriberCount()).toBe(before);
    try { ws.terminate(); } catch { /* ignore */ }
  });

  it('routes /api/stacks/<name>/logs to the logs handler (distinct error frame on invalid name)', async () => {
    const ws = connect('/api/stacks/%2Einvalid/logs', { cookie: sessionCookie });

    const firstMessage = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no frame received')), 2000);
      ws.once('message', (data: WebSocket.Data) => {
        clearTimeout(timer);
        resolve(data.toString());
      });
      ws.once('error', (e) => { clearTimeout(timer); reject(e); });
    });

    expect(firstMessage).toContain('Invalid stack name');
    try { ws.terminate(); } catch { /* ignore */ }
  });

  describe('/api/mesh/proxy-tunnel scope gating', () => {
    // The mesh proxy-tunnel ingress is machine-to-machine. The dispatch
    // ladder must accept the credentials that fleet enrollment produces
    // (node_proxy JWTs) AND the full-admin api_token scope, while rejecting
    // session cookies and restricted api_token scopes. These cases pin the
    // scope contract so a future re-tightening cannot silently regress to
    // the "full-admin only" behaviour that trapped operators following the
    // Add Remote Node dialog's Node Token instructions.

    it('accepts a node_proxy Bearer (fleet enrollment token) at the upgrade and reaches the handler', async () => {
      const nodeProxyToken = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
      const ws = connect('/api/mesh/proxy-tunnel', { bearer: nodeProxyToken });
      const outcome = await waitForOutcome(ws);
      // Pilot-mode rejection (404) or normal open both indicate the upgrade
      // passed the scope gate and was handed to handleMeshProxyTunnel.
      // The pre-fix behaviour was unequivocal: HTTP 403 from the dispatcher.
      expect(outcome.kind).not.toBe('unexpected');
      if (outcome.kind === 'unexpected') {
        expect(outcome.status).not.toBe(403);
      }
      try { ws.terminate(); } catch { /* ignore */ }
    });

    it('accepts a full-admin api_token at the upgrade and reaches the handler', async () => {
      const { DatabaseService } = await import('../services/DatabaseService');
      const rawToken = generateApiToken();
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const adminId = DatabaseService.getInstance().getUserByUsername(TEST_USERNAME)!.id;
      DatabaseService.getInstance().addApiToken({
        token_hash: tokenHash,
        name: `mesh-scope-gate-${Date.now()}`,
        scope: 'full-admin',
        user_id: adminId,
        created_at: Date.now(),
        expires_at: null,
      });
      const ws = connect('/api/mesh/proxy-tunnel', { bearer: rawToken });
      const outcome = await waitForOutcome(ws);
      expect(outcome.kind).not.toBe('unexpected');
      if (outcome.kind === 'unexpected') {
        expect(outcome.status).not.toBe(403);
      }
      try { ws.terminate(); } catch { /* ignore */ }
    });

    it('rejects a read-only api_token at the upgrade with HTTP 403', async () => {
      const { DatabaseService } = await import('../services/DatabaseService');
      const rawToken = generateApiToken();
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const adminId = DatabaseService.getInstance().getUserByUsername(TEST_USERNAME)!.id;
      DatabaseService.getInstance().addApiToken({
        token_hash: tokenHash,
        name: `mesh-scope-readonly-${Date.now()}`,
        scope: 'read-only',
        user_id: adminId,
        created_at: Date.now(),
        expires_at: null,
      });
      const ws = connect('/api/mesh/proxy-tunnel', { bearer: rawToken });
      const outcome = await waitForOutcome(ws);
      expect(outcome.kind).toBe('unexpected');
      if (outcome.kind === 'unexpected') expect(outcome.status).toBe(403);
    });

    it('rejects a session cookie at the upgrade with HTTP 403 (mesh is not a UI surface)', async () => {
      const ws = connect('/api/mesh/proxy-tunnel', { cookie: sessionCookie });
      const outcome = await waitForOutcome(ws);
      expect(outcome.kind).toBe('unexpected');
      if (outcome.kind === 'unexpected') expect(outcome.status).toBe(403);
    });
  });

  describe('/api/mesh/proxy-tunnel paid entitlement gating', () => {
    // Paid entitlement on the WS data plane is decided against the
    // *central's* asserted tier, matching the HTTP mesh routes
    // (requirePaid in routes/mesh.ts reads req.proxyTier from forwarded
    // headers off the node_proxy credential). The WS dispatcher trusts
    // x-sencho-tier only when the upgrade carries a node_proxy JWT; when no
    // header is present, or when the credential is a full-admin api_token
    // (no central is asserting tier), it falls back to the receiver's own
    // license. These tests pin both branches:
    // (a) the trusted-header path accepts a paid central even on a
    //     Community receiver, and rejects a Community central on a
    //     paid receiver;
    // (b) the local-fallback path keeps the receiver-license check intact
    //     for full-admin api_token upgrades and for header-less node_proxy
    //     upgrades.

    async function setLicense(status: string): Promise<void> {
      const { DatabaseService } = await import('../services/DatabaseService');
      DatabaseService.getInstance().setSystemState('license_status', status);
    }

    afterEach(async () => {
      // Restore the paid state beforeAll established so subsequent
      // tests in this file (and the proxy-tunnel scope block) keep passing.
      await setLicense('active');
    });

    it('rejects a node_proxy Bearer with HTTP 403 when no tier headers and the receiver license is community', async () => {
      await setLicense('community');
      const nodeProxyToken = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
      const ws = connect('/api/mesh/proxy-tunnel', { bearer: nodeProxyToken });
      const outcome = await waitForOutcome(ws);
      expect(outcome.kind).toBe('unexpected');
      if (outcome.kind === 'unexpected') expect(outcome.status).toBe(403);
    });

    it('rejects a full-admin api_token with HTTP 403 when the receiver license is community (forwarded headers ignored on api_token path)', async () => {
      await setLicense('community');
      const { DatabaseService } = await import('../services/DatabaseService');
      const adminId = DatabaseService.getInstance().getUserByUsername(TEST_USERNAME)!.id;
      const rawToken = createTestApiToken({
        db: DatabaseService,
        scope: 'full-admin',
        userId: adminId,
        name: `mesh-license-gate-${Date.now()}`,
      });
      // Header is set but must be ignored: the full-admin api_token is a
      // local-entitlement credential, not a node_proxy forwarder.
      const ws = connect('/api/mesh/proxy-tunnel', {
        bearer: rawToken,
        extraHeaders: { 'x-sencho-tier': 'paid' },
      });
      const outcome = await waitForOutcome(ws);
      expect(outcome.kind).toBe('unexpected');
      if (outcome.kind === 'unexpected') expect(outcome.status).toBe(403);
    });

    it('accepts a node_proxy Bearer asserting paid via forwarded headers even when the receiver license is community', async () => {
      await setLicense('community');
      const nodeProxyToken = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
      const ws = connect('/api/mesh/proxy-tunnel', {
        bearer: nodeProxyToken,
        extraHeaders: { 'x-sencho-tier': 'paid' },
      });
      const outcome = await waitForOutcome(ws);
      expect(outcome.kind).toBe('open');
      try { ws.terminate(); } catch { /* ignore */ }
    });

    it('rejects a node_proxy Bearer asserting community via forwarded headers even when the receiver license is paid', async () => {
      // Receiver state is already paid (set by beforeAll / afterEach).
      const nodeProxyToken = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });
      const ws = connect('/api/mesh/proxy-tunnel', {
        bearer: nodeProxyToken,
        extraHeaders: { 'x-sencho-tier': 'community' },
      });
      const outcome = await waitForOutcome(ws);
      expect(outcome.kind).toBe('unexpected');
      if (outcome.kind === 'unexpected') expect(outcome.status).toBe(403);
    });
  });

  describe('remote dispatch via NodeRegistry.getProxyTarget', () => {
    // Pilot-mode nodes carry empty `api_url` and `api_token` by design and
    // expose their API on a per-tunnel loopback bridge that
    // NodeRegistry.getProxyTarget resolves. The dispatch ladder must route
    // through that abstraction so pilot and proxy modes share one code
    // path, and must reject upgrades whose target is unresolvable rather
    // than serving gateway-local data for a request that named a remote
    // node.

    let pilotNodeId: number;

    beforeAll(async () => {
      const { DatabaseService } = await import('../services/DatabaseService');
      pilotNodeId = DatabaseService.getInstance().addNode({
        name: `upgrade-order-pilot-${Date.now()}`,
        type: 'remote',
        mode: 'pilot_agent',
        compose_dir: '/tmp/x',
        is_default: false,
        api_url: '',
        api_token: '',
      });
    });

    it('rejects a WS upgrade to a pilot-mode node with no active tunnel with HTTP 503 (not a fall-through to local handlers)', async () => {
      const ws = connect(`/api/stacks/anything/logs?nodeId=${pilotNodeId}`, { cookie: sessionCookie });
      const outcome = await waitForOutcome(ws);
      expect(outcome.kind).toBe('unexpected');
      if (outcome.kind === 'unexpected') expect(outcome.status).toBe(503);
    });

    it('rejects /ws?nodeId=<pilot-without-tunnel> with HTTP 503 instead of dispatching to the local generic handler', async () => {
      const ws = connect(`/ws?nodeId=${pilotNodeId}`, { cookie: sessionCookie });
      const outcome = await waitForOutcome(ws);
      expect(outcome.kind).toBe('unexpected');
      if (outcome.kind === 'unexpected') expect(outcome.status).toBe(503);
    });
  });

  describe('remote WebSocket actor authorization', () => {
    // The hub must enforce the originating user's role before forwarding a
    // remote upgrade: the forwarder authenticates the connection to the remote
    // as an admin-gated console_session, so a non-admin's remote container-exec
    // or host-console would otherwise open with admin rights on the remote. A
    // denied request is a clean 403 from the dispatcher; an allowed one is
    // forwarded and then fails against the unreachable test remote (not a 403).
    let viewerCookie: string;

    beforeAll(async () => {
      const { DatabaseService } = await import('../services/DatabaseService');
      const db = DatabaseService.getInstance();
      const hash = await bcrypt.hash('viewerpass', 1);
      db.addUser({ username: 'ws-authz-viewer', password_hash: hash, role: 'viewer' });
      const viewer = db.getUserByUsername('ws-authz-viewer')!;
      const viewerToken = jwt.sign(
        { username: 'ws-authz-viewer', role: 'viewer', tv: viewer.token_version },
        TEST_JWT_SECRET,
        { expiresIn: '1m' },
      );
      viewerCookie = `sencho_token=${viewerToken}`;
    });

    it('rejects a non-admin remote container-exec upgrade with 403 before forwarding', async () => {
      const ws = connect(`/ws?nodeId=${remoteNodeId}`, { cookie: viewerCookie });
      const outcome = await waitForOutcome(ws);
      expect(outcome.kind).toBe('unexpected');
      if (outcome.kind === 'unexpected') expect(outcome.status).toBe(403);
    });

    it('rejects a non-admin remote host-console upgrade with 403 before forwarding', async () => {
      const ws = connect(`/api/system/host-console?nodeId=${remoteNodeId}`, { cookie: viewerCookie });
      const outcome = await waitForOutcome(ws);
      expect(outcome.kind).toBe('unexpected');
      if (outcome.kind === 'unexpected') expect(outcome.status).toBe(403);
    });

    it('lets a non-admin remote logs upgrade past the gate (forwarding fails on the dead remote, not a 403)', async () => {
      const ws = connect(`/api/stacks/web/logs?nodeId=${remoteNodeId}`, { cookie: viewerCookie });
      const outcome = await waitForOutcome(ws);
      if (outcome.kind === 'unexpected') expect(outcome.status).not.toBe(403);
      try { ws.terminate(); } catch { /* ignore */ }
    });

    it('lets an admin remote container-exec upgrade past the gate (not a 403)', async () => {
      const ws = connect(`/ws?nodeId=${remoteNodeId}`, { cookie: sessionCookie });
      const outcome = await waitForOutcome(ws);
      if (outcome.kind === 'unexpected') expect(outcome.status).not.toBe(403);
      try { ws.terminate(); } catch { /* ignore */ }
    });

    it('rejects a non-admin remote exec to a pilot node with 403 before the missing-tunnel 503', async () => {
      // The gate runs before proxy-target resolution, so a viewer is denied with
      // 403 even when the pilot tunnel is down (which would otherwise be 503).
      // The forward path is shared with proxy mode, so this covers pilot agents.
      const { DatabaseService } = await import('../services/DatabaseService');
      const pilotId = DatabaseService.getInstance().addNode({
        name: `ws-authz-pilot-${Date.now()}`, type: 'remote', mode: 'pilot_agent',
        compose_dir: '/tmp/x', is_default: false, api_url: '', api_token: '',
      });
      const ws = connect(`/ws?nodeId=${pilotId}`, { cookie: viewerCookie });
      const outcome = await waitForOutcome(ws);
      expect(outcome.kind).toBe('unexpected');
      if (outcome.kind === 'unexpected') expect(outcome.status).toBe(403);
    });
  });

  it('dispatches /api/pilot/tunnel to the pilot handler (rejects non-pilot bearer before path-based dispatch)', async () => {
    // A plain session cookie is a valid *user* JWT but not a pilot JWT. The
    // pilot handler runs first (before the shared cookie/Bearer auth) and
    // does its own Bearer check. Because this request carries only a cookie
    // and no Bearer, pilotTunnel rejects with 401. Any other outcome means
    // the ladder has been reordered: either the shared auth ran first and
    // let the cookie through, or the unknown-path catch-all handled it.
    const ws = connect('/api/pilot/tunnel', { cookie: sessionCookie });
    const outcome = await waitForOutcome(ws);
    expect(outcome.kind).toBe('unexpected');
    if (outcome.kind === 'unexpected') expect(outcome.status).toBe(401);
  });
});
