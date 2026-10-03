/**
 * The remote WebSocket forwarder only sends forwarding headers the hub
 * validated. A remote that trusts the hub resolves the client from them, so a
 * caller-supplied X-Forwarded-For must not survive the hop. Asserted on
 * `req.headers` after the forwarder prepares the proxy call, which is exactly
 * what `wsProxyServer` receives.
 */
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wsProxyServer } from '../proxy/websocketProxy';
import { handleRemoteForwarder } from '../websocket/remoteForwarder';
import { resetTrustedProxyBlockListCache } from '../helpers/trustedProxyCidrs';

function makeUpgradeRequest(peer: string | undefined): IncomingMessage {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: peer, configurable: true });
  const req = new IncomingMessage(socket);
  req.url = '/api/stacks/web/logs?nodeId=2';
  req.headers.host = 'sencho.example';
  return req;
}

async function runForwarder(req: IncomingMessage): Promise<void> {
  const socket = new PassThrough();
  socket.resume();
  // The test setup's outbound-target mock allows loopback targets, which the
  // forwarder validates before proxying.
  await handleRemoteForwarder(
    req,
    socket,
    Buffer.alloc(0),
    {
      pathname: '/api/stacks/web/logs',
      target: { apiUrl: 'http://127.0.0.1:1852', apiToken: 'test-token', trustedLoopback: false },
    },
  );
}

describe('remote WebSocket forwarding headers', () => {
  beforeEach(() => {
    delete process.env.SENCHO_TRUSTED_PROXY_CIDRS;
    resetTrustedProxyBlockListCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SENCHO_TRUSTED_PROXY_CIDRS;
    resetTrustedProxyBlockListCache();
  });

  it('replaces caller-supplied forwarding headers with the hub-resolved peer', async () => {
    const proxySpy = vi.spyOn(wsProxyServer, 'ws').mockImplementation(() => {});
    const req = makeUpgradeRequest('198.51.100.7');
    req.headers['x-forwarded-for'] = '4.4.4.4';
    req.headers['x-forwarded-proto'] = 'https';
    req.headers['x-forwarded-port'] = '443';
    req.headers['x-real-ip'] = '4.4.4.4';
    req.headers['x-forwarded-host'] = 'spoofed.example';
    req.headers.forwarded = 'for=4.4.4.4;proto=https';

    await runForwarder(req);

    expect(proxySpy).toHaveBeenCalled();
    expect(req.headers['x-forwarded-for']).toBe('198.51.100.7');
    expect(req.headers['x-forwarded-proto']).toBe('http');
    expect(req.headers['x-forwarded-port']).toBeUndefined();
    expect(req.headers['x-real-ip']).toBeUndefined();
    expect(req.headers['x-forwarded-host']).toBeUndefined();
    expect(req.headers.forwarded).toBeUndefined();
  });

  it('forwards the client address and scheme the hub validated', async () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '198.51.100.0/24';
    resetTrustedProxyBlockListCache();
    const proxySpy = vi.spyOn(wsProxyServer, 'ws').mockImplementation(() => {});
    const req = makeUpgradeRequest('198.51.100.7');
    // The caller prepends a spoofed hop; the hub trusts the direct peer, so
    // the leftmost untrusted hop is the client it validated.
    req.headers['x-forwarded-for'] = '4.4.4.4, 203.0.113.7';
    req.headers['x-forwarded-proto'] = 'https';

    await runForwarder(req);

    expect(proxySpy).toHaveBeenCalled();
    expect(req.headers['x-forwarded-for']).toBe('203.0.113.7');
    expect(req.headers['x-forwarded-proto']).toBe('https');
  });
});
