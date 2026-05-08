import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import type { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { DatabaseService } from '../services/DatabaseService';
import { PilotTunnelCapacityError, PilotTunnelManager } from '../services/PilotTunnelManager';
import { encodeJsonFrame as encodePilotJsonFrame, PROTOCOL_VERSION as PILOT_PROTOCOL_VERSION } from '../pilot/protocol';
import { getErrorMessage } from '../utils/errors';
import { rejectUpgrade as rejectSocket } from './reject';

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
  const authHeader = req.headers['authorization'];
  const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return rejectSocket(socket, 401, 'Unauthorized');

  const db = DatabaseService.getInstance();
  const jwtSecret = db.getGlobalSettings().auth_jwt_secret;
  if (!jwtSecret) return rejectSocket(socket, 500, 'Internal Server Error');

  let decoded: { scope?: string; nodeId?: number; enrollNonce?: string };
  try {
    decoded = jwt.verify(token, jwtSecret) as typeof decoded;
  } catch {
    return rejectSocket(socket, 401, 'Unauthorized');
  }

  if (decoded.scope !== 'pilot_enroll' && decoded.scope !== 'pilot_tunnel') {
    return rejectSocket(socket, 403, 'Forbidden');
  }
  if (typeof decoded.nodeId !== 'number') return rejectSocket(socket, 400, 'Bad Request');

  const node = db.getNode(decoded.nodeId);
  if (!node || node.type !== 'remote' || node.mode !== 'pilot_agent') {
    return rejectSocket(socket, 404, 'Not Found');
  }

  let mintedTunnelToken: string | null = null;
  if (decoded.scope === 'pilot_enroll') {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const row = db.consumePilotEnrollment(tokenHash);
    if (!row || row.node_id !== decoded.nodeId) {
      return rejectSocket(socket, 401, 'Unauthorized');
    }
    mintedTunnelToken = jwt.sign(
      { scope: 'pilot_tunnel', nodeId: decoded.nodeId },
      jwtSecret,
      { expiresIn: '365d' },
    );
  }

  const agentVersionHeader = req.headers['x-sencho-agent-version'];
  const agentVersion = Array.isArray(agentVersionHeader) ? agentVersionHeader[0] : agentVersionHeader;

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
      await PilotTunnelManager.getInstance().registerTunnel(decoded.nodeId!, ws, agentVersion);
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
