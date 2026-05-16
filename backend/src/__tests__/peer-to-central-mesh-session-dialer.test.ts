/**
 * `PeerToCentralMeshSessionDialer`: peer-side counterpart to the central
 * ingress at `/api/mesh/proxy-tunnel-from-peer` (Task 9). Reads cached
 * central material from `MeshCentralRegistry`, opens a WebSocket to
 * central carrying the bootstrapped JWT in the Authorization header, and
 * branches on the upgrade outcome:
 *
 *   - successful open: marks the cache row "used", arms the bridge.
 *   - 401 with a terminal reason code (stale, signature_invalid, ...):
 *     clears the cache so we stop dialing on a bad credential.
 *   - 401 with a transient reason (clock_skew, mode_mismatch, ...):
 *     keeps the cache, marks rejected so the operator can see why.
 *   - 404 endpoint_not_found: keeps the cache and arms a longer backoff
 *     so we do not hammer an older central that has not yet shipped the
 *     peer ingress endpoint.
 *
 * The dial logic is also rate-limited per dialer process (5 attempts /
 * 60s window) so a misbehaving central or a misconfigured peer cannot
 * flood either side with handshake traffic.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { WebSocketServer, type WebSocket as WsClient } from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let PeerToCentralMeshSessionDialer: typeof import('../services/PeerToCentralMeshSessionDialer').PeerToCentralMeshSessionDialer;
let MeshCentralRegistry: typeof import('../services/MeshCentralRegistry').MeshCentralRegistry;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let TcpStreamSwitchboardCtor: typeof import('../mesh/tcpStreamSwitchboard').TcpStreamSwitchboard;
let MeshService: typeof import('../services/MeshService').MeshService;

interface RejectingServer {
    server: http.Server;
    url: string;
    lastAuthHeader: string | null;
    lastPath: string | null;
    close: () => Promise<void>;
}

/**
 * Spins up a minimal HTTP server that intercepts WebSocket upgrades and
 * responds with a fixed status + JSON body, mimicking how the central
 * ingress rejects bad credentials. Records the auth header and path so
 * tests can assert the dialer is sending the right material.
 */
async function startRejectingServer(status: number, reason: string): Promise<RejectingServer> {
    const handle: RejectingServer = {
        server: http.createServer(),
        url: '',
        lastAuthHeader: null,
        lastPath: null,
        close: () => new Promise<void>((resolve) => handle.server.close(() => resolve())),
    };
    handle.server.on('upgrade', (req, socket) => {
        handle.lastAuthHeader = (req.headers['authorization'] as string | undefined) ?? null;
        handle.lastPath = req.url ?? null;
        const body = JSON.stringify({ reason });
        const statusText = status === 404 ? 'Not Found' : 'Unauthorized';
        const head = [
            `HTTP/1.1 ${status} ${statusText}`,
            'Content-Type: application/json',
            `Content-Length: ${Buffer.byteLength(body)}`,
            'Connection: close',
            '',
            body,
        ].join('\r\n');
        try { socket.write(head); } catch { /* ignore */ }
        try { socket.destroy(); } catch { /* ignore */ }
    });
    await new Promise<void>((resolve) => handle.server.listen(0, '127.0.0.1', () => resolve()));
    const port = (handle.server.address() as AddressInfo).port;
    handle.url = `http://127.0.0.1:${port}`;
    return handle;
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ PeerToCentralMeshSessionDialer } = await import('../services/PeerToCentralMeshSessionDialer'));
    ({ MeshCentralRegistry } = await import('../services/MeshCentralRegistry'));
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ TcpStreamSwitchboard: TcpStreamSwitchboardCtor } = await import('../mesh/tcpStreamSwitchboard'));
    ({ MeshService } = await import('../services/MeshService'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    MeshCentralRegistry.resetForTest();
    PeerToCentralMeshSessionDialer.resetForTest();
    DatabaseService.getInstance().getDb().prepare('DELETE FROM mesh_centrals').run();
});

afterEach(() => {
    PeerToCentralMeshSessionDialer.resetForTest();
    MeshCentralRegistry.resetForTest();
});

describe('PeerToCentralMeshSessionDialer', () => {
    it('returns null when no central material is cached', async () => {
        const result = await PeerToCentralMeshSessionDialer.getInstance().ensureSession();
        expect(result).toBeNull();
    });

    it('dials using the cached URL + JWT bearer (asserted by server-side recording)', async () => {
        const srv = await startRejectingServer(401, 'clock_skew');
        try {
            MeshCentralRegistry.getInstance().upsert({
                centralInstanceId: 'inst-a',
                centralApiUrl: srv.url,
                callbackJwt: 'fake.jwt.token',
                jwtIssuedAt: 1,
                jwtExpiresAt: Math.floor(Date.now() / 1000) + 3600,
            });
            const result = await PeerToCentralMeshSessionDialer.getInstance().ensureSession();
            expect(result).toBeNull();
            expect(srv.lastPath).toBe('/api/mesh/proxy-tunnel-from-peer');
            expect(srv.lastAuthHeader).toBe('Bearer fake.jwt.token');
        } finally {
            await srv.close();
        }
    });

    it('clears cache on 401 reason=stale', async () => {
        const srv = await startRejectingServer(401, 'stale');
        try {
            MeshCentralRegistry.getInstance().upsert({
                centralInstanceId: 'inst-b',
                centralApiUrl: srv.url,
                callbackJwt: 'jwt',
                jwtIssuedAt: 1,
                jwtExpiresAt: Math.floor(Date.now() / 1000) + 3600,
            });
            await PeerToCentralMeshSessionDialer.getInstance().ensureSession();
            expect(MeshCentralRegistry.getInstance().getActive()).toBeNull();
        } finally {
            await srv.close();
        }
    });

    it('keeps cache on 401 reason=clock_skew but records the rejection', async () => {
        const srv = await startRejectingServer(401, 'clock_skew');
        try {
            MeshCentralRegistry.getInstance().upsert({
                centralInstanceId: 'inst-c',
                centralApiUrl: srv.url,
                callbackJwt: 'jwt',
                jwtIssuedAt: 1,
                jwtExpiresAt: Math.floor(Date.now() / 1000) + 3600,
            });
            await PeerToCentralMeshSessionDialer.getInstance().ensureSession();
            const row = MeshCentralRegistry.getInstance().getActive();
            expect(row).not.toBeNull();
            expect(row?.lastRejectReason).toBe('clock_skew');
        } finally {
            await srv.close();
        }
    });

    it('keeps cache on HTTP 404 endpoint_not_found and rate-limits future dials', async () => {
        const srv = await startRejectingServer(404, 'whatever');
        try {
            MeshCentralRegistry.getInstance().upsert({
                centralInstanceId: 'inst-d',
                centralApiUrl: srv.url,
                callbackJwt: 'jwt',
                jwtIssuedAt: 1,
                jwtExpiresAt: Math.floor(Date.now() / 1000) + 3600,
            });
            const dialer = PeerToCentralMeshSessionDialer.getInstance();
            await dialer.ensureSession();
            // Cache must survive a 404 (older central, transient infra).
            expect(MeshCentralRegistry.getInstance().getActive()).not.toBeNull();
            // The second call must not even hit the server: the endpoint
            // backoff blocks new dials for the configured window.
            srv.lastAuthHeader = null;
            const second = await dialer.ensureSession();
            expect(second).toBeNull();
            expect(srv.lastAuthHeader).toBeNull();
        } finally {
            await srv.close();
        }
    });

    it('rate-limits dials after the configured attempt cap', async () => {
        const srv = await startRejectingServer(401, 'clock_skew');
        try {
            MeshCentralRegistry.getInstance().upsert({
                centralInstanceId: 'inst-e',
                centralApiUrl: srv.url,
                callbackJwt: 'jwt',
                jwtIssuedAt: 1,
                jwtExpiresAt: Math.floor(Date.now() / 1000) + 3600,
            });
            const dialer = PeerToCentralMeshSessionDialer.getInstance();
            // 5 dials should land; the 6th must be suppressed by the limiter.
            for (let i = 0; i < 5; i++) {
                await dialer.ensureSession();
            }
            srv.lastAuthHeader = null;
            const sixth = await dialer.ensureSession();
            expect(sixth).toBeNull();
            expect(srv.lastAuthHeader).toBeNull();
        } finally {
            await srv.close();
        }
    });

    it('marks the row used on successful WS open and installs a reverseDialer', async () => {
        const wss = new WebSocketServer({ noServer: true });
        const srv = http.createServer();
        srv.on('upgrade', (req, socket, head) => {
            if (req.url?.startsWith('/api/mesh/proxy-tunnel-from-peer')) {
                wss.handleUpgrade(req, socket, head, () => { /* accept */ });
            } else {
                socket.destroy();
            }
        });
        await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
        const port = (srv.address() as AddressInfo).port;
        const url = `http://127.0.0.1:${port}`;
        // Start with a clean reverseDialer slot on the local MeshService so
        // setReverseDialer's CAS swap succeeds inside attachSwitchboard.
        MeshService.getInstance().setReverseDialer(null);
        let switchboard: InstanceType<typeof TcpStreamSwitchboardCtor> | null = null;
        try {
            MeshCentralRegistry.getInstance().upsert({
                centralInstanceId: 'inst-success',
                centralApiUrl: url,
                callbackJwt: 'fake.jwt',
                jwtIssuedAt: 1,
                jwtExpiresAt: 9999999999,
            });
            switchboard = await PeerToCentralMeshSessionDialer.getInstance().ensureSession();
            expect(switchboard).not.toBeNull();
            expect(PeerToCentralMeshSessionDialer.getInstance().hasSession()).toBe(true);
            // markUsed is called synchronously inside attachSwitchboard before
            // ensureSession resolves, so the DB row reflects it immediately.
            expect(MeshCentralRegistry.getInstance().getActive()?.lastUsedAt ?? 0).toBeGreaterThan(0);
            // The R1-A2 wiring under test: MeshService.reverseDialer must be
            // populated so MeshService.dialMeshTcpStream routes peer-side
            // cross-fleet traffic through this callback bridge instead of
            // falling through to PilotTunnelManager.ensureBridge(centralId),
            // which has no record for central on a proxy peer.
            const meshSvc = MeshService.getInstance() as unknown as { reverseDialer: unknown };
            expect(meshSvc.reverseDialer).not.toBeNull();
        } finally {
            try { switchboard?.cleanup('test done'); } catch { /* ignore */ }
            // The dialer owns the client-side WS and the switchboard doesn't
            // close it on cleanup; tear it down explicitly so wss.close can
            // resolve (it waits for all client connections to disconnect).
            try {
                const inst = PeerToCentralMeshSessionDialer.getInstance() as unknown as { currentWs: WsClient | null };
                inst.currentWs?.close(1000, 'test done');
            } catch { /* ignore */ }
            MeshService.getInstance().setReverseDialer(null);
            await new Promise<void>((resolve) => wss.close(() => resolve()));
            await new Promise<void>((resolve) => srv.close(() => resolve()));
        }
    });

    it('singleton returns the same instance', () => {
        const a = PeerToCentralMeshSessionDialer.getInstance();
        const b = PeerToCentralMeshSessionDialer.getInstance();
        expect(a).toBe(b);
    });
});
