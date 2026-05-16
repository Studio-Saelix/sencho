/**
 * Central-side ingress for peer-initiated proxy-mode mesh tunnels.
 *
 * After the bootstrap exchange in `meshProxyTunnel.ts` (Task 7/8), a peer
 * with the central's `mesh_tunnel` JWT can dial *back* to central at this
 * endpoint. The validation chain enforces every claim the bootstrap mint
 * produced and confirms the peer's stored fingerprint still matches its
 * current api_token. Each failure path returns HTTP 401 with a stable
 * machine-readable `reason` code in the JSON body, so the dialer side
 * (PeerToCentralMeshSessionDialer, Task 10) can act on the reason without
 * scraping prose.
 *
 * Auth runs MANUALLY in this handler. Express middleware does not run on
 * WebSocket upgrades, and the credential here is a Bearer JWT minted by
 * the central itself, not a user session.
 */
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import jwt, { type Algorithm, type JwtPayload } from 'jsonwebtoken';
import { createHash } from 'crypto';
import { WebSocketServer } from 'ws';
import { DatabaseService } from '../services/DatabaseService';
import { PilotTunnelBridge } from '../services/PilotTunnelBridge';
import { PilotTunnelManager } from '../services/PilotTunnelManager';
import { PilotMetrics } from '../services/PilotMetrics';
import { sanitizeForLog } from '../utils/safeLog';

const wss = new WebSocketServer({ noServer: true });
const CLOCK_SKEW_SEC = 60;

type RejectReason =
    | 'algorithm_mismatch' | 'signature_invalid'
    | 'scope_mismatch' | 'audience_mismatch' | 'instance_mismatch'
    | 'stale' | 'clock_skew' | 'node_deleted' | 'mode_mismatch'
    | 'token_fingerprint_mismatch' | 'malformed';

function rejectUpgrade(socket: Duplex, reason: RejectReason): void {
    const body = JSON.stringify({ reason });
    const headers = [
        'HTTP/1.1 401 Unauthorized',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        body,
    ].join('\r\n');
    try { socket.write(headers); } catch { /* socket already gone */ }
    try { socket.destroy(); } catch { /* socket already gone */ }
}

function extractBearer(req: IncomingMessage): string | null {
    const h = req.headers['authorization'];
    if (typeof h !== 'string' || !h.startsWith('Bearer ')) return null;
    return h.slice('Bearer '.length).trim() || null;
}

export function handleMeshProxyTunnelFromPeerUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
): void {
    const token = extractBearer(req);
    if (!token) { rejectUpgrade(socket, 'malformed'); return; }

    let header: { alg?: string; kid?: string } = {};
    try {
        const decoded = jwt.decode(token, { complete: true });
        header = (decoded?.header ?? {}) as typeof header;
    } catch { rejectUpgrade(socket, 'malformed'); return; }
    if (header.alg !== 'HS256') { rejectUpgrade(socket, 'algorithm_mismatch'); return; }

    const settings = DatabaseService.getInstance().getGlobalSettings();
    const secret = settings.auth_jwt_secret;
    if (!secret) { rejectUpgrade(socket, 'malformed'); return; }

    let payload: JwtPayload;
    try {
        payload = jwt.verify(token, secret, { algorithms: ['HS256' as Algorithm] }) as JwtPayload;
    } catch { rejectUpgrade(socket, 'signature_invalid'); return; }

    if (payload.scope !== 'mesh_tunnel') { rejectUpgrade(socket, 'scope_mismatch'); return; }

    // SENCHO_PRIMARY_URL must be set on central for peer-initiated dial-back
    // to operate. The Task 8 bootstrap-mint side already skips when it's
    // unset; this is the matching fail-safe on the verify side. Reject all
    // peer dials with audience_mismatch when central has no canonical
    // origin to validate against.
    const canonicalOrigin = (process.env.SENCHO_PRIMARY_URL ?? '').replace(/\/+$/, '');
    if (!canonicalOrigin) { rejectUpgrade(socket, 'audience_mismatch'); return; }
    if (payload.aud !== canonicalOrigin) { rejectUpgrade(socket, 'audience_mismatch'); return; }

    // instance_id is operational state, not user-defined config, so it
    // lives in system_state rather than global_settings.
    const instanceId = DatabaseService.getInstance().getSystemState('instance_id');
    if (payload.iss !== instanceId) { rejectUpgrade(socket, 'instance_mismatch'); return; }

    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
        rejectUpgrade(socket, 'stale'); return;
    }
    if (typeof payload.iat !== 'number' || payload.iat > nowSec + CLOCK_SKEW_SEC) {
        rejectUpgrade(socket, 'clock_skew'); return;
    }

    const peerNodeId = Number(payload.sub);
    if (!Number.isInteger(peerNodeId) || peerNodeId <= 0) {
        rejectUpgrade(socket, 'malformed'); return;
    }
    const node = DatabaseService.getInstance().getNode(peerNodeId);
    if (!node) { rejectUpgrade(socket, 'node_deleted'); return; }
    if (node.type !== 'remote' || node.mode !== 'proxy') {
        rejectUpgrade(socket, 'mode_mismatch'); return;
    }

    if (!node.api_token) { rejectUpgrade(socket, 'token_fingerprint_mismatch'); return; }
    const expectedFp = createHash('sha256').update(node.api_token).digest('hex').slice(0, 16);
    const claimedFp = payload['peer_token_fp'];
    if (typeof claimedFp !== 'string' || claimedFp !== expectedFp) {
        rejectUpgrade(socket, 'token_fingerprint_mismatch'); return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
        try {
            const bridge = new PilotTunnelBridge(peerNodeId, ws);
            bridge.start().then(() => {
                try {
                    PilotTunnelManager.getInstance().replaceOrRegisterProxyBridge(peerNodeId, bridge);
                    PilotMetrics.increment('proxy_bridges_peer_initiated_total');
                } catch (err) {
                    try { bridge.close(1013, 'manager rejected'); } catch { /* ignore */ }
                    console.warn(`[meshProxyTunnelFromPeer] register failed: ${sanitizeForLog((err as Error).message)}`);
                }
            }).catch((err) => {
                try { bridge.close(1011, 'bridge start failed'); } catch { /* ignore */ }
                console.warn(`[meshProxyTunnelFromPeer] bridge start failed: ${sanitizeForLog((err as Error).message)}`);
            });
        } catch (err) {
            console.warn(`[meshProxyTunnelFromPeer] bridge construct failed: ${sanitizeForLog((err as Error).message)}`);
            try { ws.close(1011, 'bridge init failed'); } catch { /* ignore */ }
        }
    });
}
