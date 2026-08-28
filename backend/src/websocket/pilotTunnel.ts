import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import type { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { DatabaseService } from '../services/DatabaseService';
import { PilotTunnelCapacityError, PilotTunnelManager } from '../services/PilotTunnelManager';
import { PilotMetrics } from '../services/PilotMetrics';
import { encodeJsonFrame as encodePilotJsonFrame, PROTOCOL_VERSION as PILOT_PROTOCOL_VERSION } from '../pilot/protocol';
import { getErrorMessage } from '../utils/errors';
import { rejectUpgrade as rejectSocket } from './reject';
import { RegistryDeliveryService } from '../services/RegistryDeliveryService';

/** Diagnostic reject reason for Pilot agents (never required for enroll fallback). */
type PilotRejectReason =
  | 'missing_token'
  | 'invalid_token'
  | 'bad_scope'
  | 'bad_node'
  | 'unknown_node'
  | 'enrollment_used'
  | 'server_error';

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function rejectPilot(
  socket: Duplex,
  status: number,
  message: string,
  reason: PilotRejectReason,
): void {
  rejectSocket(socket, status, message, {
    'X-Sencho-Pilot-Reject': reason,
    Connection: 'close',
  });
}

/**
 * Handle an inbound pilot-agent tunnel upgrade. Accepts either:
 *   - pilot_enroll (15m, one-time): consume the enrollment row, mint a
 *     long-lived pilot_tunnel token, send it back in a ctrl enroll_ack frame.
 *   - pilot_tunnel (365d): accept the socket directly.
 *
 * In both cases the accepted WebSocket is handed to `PilotTunnelManager`.
 * Handled independently of user/session auth because these are machine
 * credentials and carry no cookies.
 */
export async function handlePilotTunnel(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  pilotTunnelWss: WebSocketServer,
): Promise<void> {
  const authHeader = firstHeader(req.headers['authorization']);
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return rejectPilot(socket, 401, 'Unauthorized', 'missing_token');

  const db = DatabaseService.getInstance();
  const jwtSecret = db.getGlobalSettings().auth_jwt_secret;
  if (!jwtSecret) return rejectPilot(socket, 500, 'Internal Server Error', 'server_error');

  let decoded: { scope?: string; nodeId?: number; enrollNonce?: string };
  try {
    decoded = jwt.verify(token, jwtSecret) as typeof decoded;
  } catch {
    return rejectPilot(socket, 401, 'Unauthorized', 'invalid_token');
  }

  if (decoded.scope !== 'pilot_enroll' && decoded.scope !== 'pilot_tunnel') {
    return rejectPilot(socket, 403, 'Forbidden', 'bad_scope');
  }
  if (typeof decoded.nodeId !== 'number') return rejectPilot(socket, 400, 'Bad Request', 'bad_node');

  const node = db.getNode(decoded.nodeId);
  if (!node || node.type !== 'remote' || node.mode !== 'pilot_agent') {
    return rejectPilot(socket, 404, 'Not Found', 'unknown_node');
  }

  let mintedTunnelToken: string | null = null;
  if (decoded.scope === 'pilot_enroll') {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const row = db.consumePilotEnrollment(tokenHash);
    if (!row || row.node_id !== decoded.nodeId) {
      return rejectPilot(socket, 401, 'Unauthorized', 'enrollment_used');
    }
    mintedTunnelToken = jwt.sign(
      { scope: 'pilot_tunnel', nodeId: decoded.nodeId },
      jwtSecret,
      { expiresIn: '365d' },
    );
    PilotMetrics.increment('enroll_acks');
  }

  const agentVersion = firstHeader(req.headers['x-sencho-agent-version']);

  const socketEncrypted = (req.socket as { encrypted?: boolean }).encrypted === true;
  const forwardedProto = firstHeader(req.headers['x-forwarded-proto']);
  const peerAddress = req.socket.remoteAddress ?? undefined;
  const tunnelConfidential = RegistryDeliveryService.getInstance().isPilotTransportConfidential(
    socketEncrypted,
    forwardedProto,
    peerAddress,
  );

  pilotTunnelWss.handleUpgrade(req, socket, head, async (ws) => {
    try {
      ws.send(encodePilotJsonFrame({
        t: 'hello',
        version: PILOT_PROTOCOL_VERSION,
        role: 'primary',
      }));
      if (mintedTunnelToken) {
        ws.send(encodePilotJsonFrame({
          t: 'ctrl',
          op: 'enroll_ack',
          payload: { token: mintedTunnelToken, nodeId: decoded.nodeId },
        }));
      }
    } catch {
      try { ws.close(1011, 'hello failed'); } catch { /* ignore */ }
      return;
    }

    try {
      await PilotTunnelManager.getInstance().registerTunnel(
        decoded.nodeId!,
        ws,
        agentVersion,
        tunnelConfidential,
      );
    } catch (err) {
      if (err instanceof PilotTunnelCapacityError) {
        // 1013 (Try Again Later) signals the agent to back off rather than
        // tight-loop reconnect on a saturated gateway.
        try { ws.close(1013, 'pilot tunnel cap reached'); } catch { /* ignore */ }
        return;
      }
      console.error('[Pilot] Failed to register tunnel:', getErrorMessage(err, 'unknown'));
      try { ws.close(1011, 'registration failed'); } catch { /* ignore */ }
    }
  });
}
