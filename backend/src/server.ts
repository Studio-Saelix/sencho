import http from 'http';
import type { Express } from 'express';
import { WebSocketServer } from 'ws';
import { MAX_FRAME_SIZE_BYTES } from './pilot/protocol';

export interface SenchoServer {
  server: http.Server;
  /** Main WebSocket server for container exec and stats streams. */
  wss: WebSocketServer;
  /** Dedicated WebSocket server for pilot-agent tunnel ingress. */
  pilotTunnelWss: WebSocketServer;
}

/**
 * Wrap the Express app in an `http.Server` and create the two `noServer` WSS
 * instances used by `attachUpgrade`. Every WebSocket path dispatches out of
 * the HTTP server's `upgrade` event; the `WebSocketServer` instances only
 * negotiate the WS handshake, so they are created in `noServer: true` mode.
 */
export function createServer(app: Express): SenchoServer {
  const server = http.createServer(app);
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
