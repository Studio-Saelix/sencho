import http from 'http';
import https from 'https';
import type { Express } from 'express';
import { WebSocketServer } from 'ws';
import { MAX_FRAME_SIZE_BYTES } from './pilot/protocol';
import { loadNativeTlsMaterial, nativeTlsServerOptions } from './helpers/nativeTls';

export interface SenchoServer {
  server: http.Server;
  /** Main WebSocket server for container exec and stats streams. */
  wss: WebSocketServer;
  /** Dedicated WebSocket server for pilot-agent tunnel ingress. */
  pilotTunnelWss: WebSocketServer;
}

/**
 * Wrap the Express app in an `http.Server` (or `https.Server` when native TLS
 * cert material is configured) and create the two `noServer` WSS instances
 * used by `attachUpgrade`. Every WebSocket path dispatches out of the
 * server's `upgrade` event; the `WebSocketServer` instances only negotiate
 * the WS handshake, so they are created in `noServer: true` mode.
 *
 * https.Server extends http.Server, so attachUpgrade and startServer keep
 * the same types. Native TLS sets `socket.encrypted` on upgrades; that is
 * one input to the registry-delivery confidentiality check. The reverse-proxy
 * path still uses forwarded proto from a trusted CIDR.
 */
export function createServer(app: Express): SenchoServer {
  const tls = loadNativeTlsMaterial();
  const server = tls
    ? https.createServer(nativeTlsServerOptions(tls), app)
    : http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  // Agents dial /api/pilot/tunnel; the handshake verifies a pilot_enroll or
  // pilot_tunnel JWT, then hands the socket off to PilotTunnelManager. The
  // pilot tunnel multiplexes every HTTP / WS / Mesh-TCP byte for a remote
  // node, so a single oversized frame from a buggy or malicious agent can
  // bloat the gateway's decode buffer; cap the payload at the protocol-level
  // ceiling rather than relying on the ws default (100 MB).
  const pilotTunnelWss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_SIZE_BYTES });

  return { server, wss, pilotTunnelWss };
}
