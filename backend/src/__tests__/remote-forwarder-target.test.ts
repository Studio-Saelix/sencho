import { IncomingMessage } from 'http';
import { Socket } from 'net';
import { PassThrough } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wsProxyServer } from '../proxy/websocketProxy';
import { handleRemoteForwarder } from '../websocket/remoteForwarder';
import { withLoopbackTargetProtection } from './helpers/allowLoopbackTargets';

afterEach(() => vi.restoreAllMocks());

describe('remote WebSocket target validation', () => {
  it('rejects an unsafe target before invoking the WebSocket proxy', async () => {
    const req = new IncomingMessage(new Socket());
    req.url = '/api/containers/demo/logs?nodeId=2';
    req.headers.host = 'sencho.example';
    const socket = new PassThrough();
    socket.resume();
    const proxySpy = vi.spyOn(wsProxyServer, 'ws').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await withLoopbackTargetProtection(() => handleRemoteForwarder(
      req,
      socket,
      Buffer.alloc(0),
      {
        pathname: '/api/containers/demo/logs',
        target: {
          apiUrl: 'http://127.0.0.1:1852',
          apiToken: 'test-token',
          trustedLoopback: false,
        },
      },
    ));

    expect(proxySpy).not.toHaveBeenCalled();
  });
});
