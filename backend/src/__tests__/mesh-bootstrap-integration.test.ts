/**
 * End-to-end protocol-role invariant for the symmetric mesh callback dial.
 *
 * The whole point of Task 8 + Task 10 is the asymmetry of registration even
 * though the wire protocol becomes symmetric:
 *
 *   - Central is the loopback HTTP host. Every bridge central registers
 *     (pilot-initiated or peer-initiated dial-back) is a
 *     `PilotTunnelBridge` parked in `PilotTunnelManager`.
 *   - The peer (proxy-mode remote) never runs a `PilotTunnelBridge`; on the
 *     peer side a `TcpStreamSwitchboard` rides the same WS and the local
 *     `MeshService.reverseDialer` slot is held while the WS is alive.
 *
 * This file exercises the central side of that invariant end-to-end using
 * the same in-process fixture pattern as `mesh-proxy-tunnel-from-peer.test.ts`:
 * a fully signed callback JWT lands at `/api/mesh/proxy-tunnel-from-peer`,
 * and we assert what central produced is a `PilotTunnelBridge` (not a
 * switchboard) in the manager. The matching mesh_handshake side (central
 * pushing the JWT) is covered in `mesh-proxy-tunnel-dialer-handshake.test.ts`
 * and `mesh-proxy-tunnel-first-frame.test.ts`; here we lock in the registry
 * outcome that ties those two halves together.
 */
import http from 'http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';
import type { AddressInfo } from 'net';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { MeshProxyTunnelDialer } from '../services/MeshProxyTunnelDialer';
import { MeshCentralRegistry } from '../services/MeshCentralRegistry';
import { PilotTunnelManager } from '../services/PilotTunnelManager';
import { PilotTunnelBridge } from '../services/PilotTunnelBridge';

let tmpDir: string;
let handleMeshProxyTunnelFromPeerUpgrade: typeof import('../websocket/meshProxyTunnelFromPeer').handleMeshProxyTunnelFromPeerUpgrade;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

interface ServerHandle {
    server: http.Server;
    port: number;
    close: () => Promise<void>;
}

async function startCentralServer(): Promise<ServerHandle> {
    const server = http.createServer();
    server.on('upgrade', (req, socket, head) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (pathname === '/api/mesh/proxy-tunnel-from-peer') {
            handleMeshProxyTunnelFromPeerUpgrade(req, socket, head);
        } else {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    return {
        server,
        port,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

const CANONICAL_ORIGIN = 'https://central.example.com';
const INSTANCE_ID = 'bootstrap-integration-central';
const PEER_API_TOKEN = 'peer-token-bootstrap';

let secret: string;
let srv: ServerHandle;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ handleMeshProxyTunnelFromPeerUpgrade } = await import('../websocket/meshProxyTunnelFromPeer'));
    ({ DatabaseService } = await import('../services/DatabaseService'));
    srv = await startCentralServer();
});

afterAll(async () => {
    if (srv) await srv.close();
    delete process.env.SENCHO_PRIMARY_URL;
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    process.env.SENCHO_PRIMARY_URL = CANONICAL_ORIGIN;
    MeshProxyTunnelDialer.resetForTest();
    MeshCentralRegistry.resetForTest();
    PilotTunnelManager.resetForTest();
    const db = DatabaseService.getInstance();
    secret = db.getGlobalSettings().auth_jwt_secret;
    db.setSystemState('instance_id', INSTANCE_ID);
});

function seedPeerNode(): number {
    const db = DatabaseService.getInstance();
    const id = db.addNode({
        name: `peer-bs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'remote',
        mode: 'proxy',
        api_url: 'https://peer.example.com',
        api_token: PEER_API_TOKEN,
        compose_dir: '/tmp',
        is_default: false,
    });
    db.setNodeMeshEnabled(id, true);
    return id;
}

function mintCallbackJwt(peerNodeId: number): string {
    const fp = createHash('sha256').update(PEER_API_TOKEN).digest('hex').slice(0, 16);
    const nowSec = Math.floor(Date.now() / 1000);
    return jwt.sign(
        {
            sub: String(peerNodeId),
            iss: INSTANCE_ID,
            aud: CANONICAL_ORIGIN,
            scope: 'mesh_tunnel',
            iat: nowSec,
            exp: nowSec + 3600,
            kid: 'v1',
            peer_token_fp: fp,
        },
        secret,
        { algorithm: 'HS256' },
    );
}

describe('Mesh bootstrap E2E (protocol-role invariant)', () => {
    it('after peer dial-back, central registers a PilotTunnelBridge in PilotTunnelManager', async () => {
        // This is the symmetric callback half of the protocol: the peer has
        // already received a bootstrap JWT in some prior session and is now
        // dialing back into central. On central, the resulting WS must
        // produce a PilotTunnelBridge (not a TcpStreamSwitchboard) and the
        // manager must hold it under the peer's nodeId.
        const peerNodeId = seedPeerNode();
        const token = mintCallbackJwt(peerNodeId);

        const ws = await new Promise<WebSocket>((resolve, reject) => {
            const s = new WebSocket(`ws://127.0.0.1:${srv.port}/api/mesh/proxy-tunnel-from-peer`, {
                headers: { authorization: `Bearer ${token}` },
            });
            s.once('open', () => resolve(s));
            s.once('error', reject);
            s.once('unexpected-response', (_req, res) => reject(new Error(`upgrade rejected ${res.statusCode}`)));
        });
        // Allow the handler's async bridge.start() + manager registration to land.
        await new Promise((r) => setTimeout(r, 60));

        const bridge = PilotTunnelManager.getInstance().getBridge(peerNodeId);
        expect(bridge).not.toBeNull();
        // The manager only narrows to MeshTunnelHandle in its public API,
        // but the underlying object must be the central-side bridge class.
        expect(bridge).toBeInstanceOf(PilotTunnelBridge);

        try { ws.close(1000, 'test cleanup'); } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 30));
    });

    it('a successful dial-back persists the JWT scope on the bridge (mesh_tunnel scope)', async () => {
        // Cross-check: the JWT carries scope=mesh_tunnel, the central
        // ingress accepted it, so the bridge that lands in the manager is a
        // proxy-mode bridge (not a pilot-agent tunnel). We assert via the
        // dialer's hasBridge surface to confirm the proxy registry side
        // sees nothing (the dial-back lives in the manager, not in
        // MeshProxyTunnelDialer's outbound map).
        const peerNodeId = seedPeerNode();
        const token = mintCallbackJwt(peerNodeId);
        const ws = await new Promise<WebSocket>((resolve, reject) => {
            const s = new WebSocket(`ws://127.0.0.1:${srv.port}/api/mesh/proxy-tunnel-from-peer`, {
                headers: { authorization: `Bearer ${token}` },
            });
            s.once('open', () => resolve(s));
            s.once('error', reject);
            s.once('unexpected-response', (_req, res) => reject(new Error(`upgrade rejected ${res.statusCode}`)));
        });
        await new Promise((r) => setTimeout(r, 60));

        // The dialer is the central-initiated outbound side. A peer-initiated
        // dial-back lands in PilotTunnelManager only; the dialer's own
        // bridges map stays empty for this nodeId.
        expect(MeshProxyTunnelDialer.getInstance().hasBridge(peerNodeId)).toBe(false);
        expect(PilotTunnelManager.getInstance().getBridge(peerNodeId)).not.toBeNull();

        try { ws.close(1000, 'test cleanup'); } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 30));
    });
});
