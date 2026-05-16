/**
 * `meshProxyTunnel.ts` first-frame state machine.
 *
 * The PEER side of a proxy-mode mesh tunnel optionally consumes a
 * `mesh_handshake` JSON frame as the FIRST text frame from central,
 * persists the bootstrap material via MeshCentralRegistry, then yields
 * control to the existing TcpStreamSwitchboard. Out-of-order or
 * malformed handshake frames close the WS with code 1008.
 */
import http from 'http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'net';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let handleMeshProxyTunnel: typeof import('../websocket/meshProxyTunnel').handleMeshProxyTunnel;
let MeshService: typeof import('../services/MeshService').MeshService;
let MeshCentralRegistry: typeof import('../services/MeshCentralRegistry').MeshCentralRegistry;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

interface ServerHandle {
    server: http.Server;
    port: number;
    close: () => Promise<void>;
}

async function startServer(): Promise<ServerHandle> {
    const server = http.createServer();
    server.on('upgrade', (req, socket, head) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (pathname === '/api/mesh/proxy-tunnel') {
            void handleMeshProxyTunnel(req, socket, head);
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

function dialTunnel(port: number, query: string = ''): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/mesh/proxy-tunnel${query}`);
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}

function makeHandshakeFrame(overrides: Partial<{
    centralInstanceId: string;
    centralApiUrl: string;
    meshTunnelJwt: string;
    jwtExpiresAt: number;
    peerNodeId: number;
}> = {}): string {
    return JSON.stringify({
        t: 'mesh_handshake',
        v: 1,
        peerNodeId: overrides.peerNodeId ?? 7,
        centralInstanceId: overrides.centralInstanceId ?? 'central-instance-abc',
        centralApiUrl: overrides.centralApiUrl ?? 'https://central.example.test',
        meshTunnelJwt: overrides.meshTunnelJwt ?? 'jwt.token.body',
        jwtExpiresAt: overrides.jwtExpiresAt ?? Math.floor(Date.now() / 1000) + 3600,
    });
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ handleMeshProxyTunnel } = await import('../websocket/meshProxyTunnel'));
    ({ MeshService } = await import('../services/MeshService'));
    ({ MeshCentralRegistry } = await import('../services/MeshCentralRegistry'));
    ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    delete process.env.SENCHO_MODE;
    MeshService.getInstance().setReverseDialer(null);
    MeshService.getInstance().setProxyTunnelSelfCentralNodeId(null);
    MeshCentralRegistry.resetForTest();
    DatabaseService.getInstance().getDb().prepare('DELETE FROM mesh_centrals').run();
});

describe('meshProxyTunnel first-frame state machine', () => {
    it('consumes a mesh_handshake first frame and persists material via MeshCentralRegistry', async () => {
        const srv = await startServer();
        try {
            const ws = await dialTunnel(srv.port, '?nodeId=7');
            await new Promise((r) => setTimeout(r, 20));

            const expiresAt = Math.floor(Date.now() / 1000) + 7200;
            ws.send(makeHandshakeFrame({
                centralInstanceId: 'central-instance-xyz',
                centralApiUrl: 'https://central.example.test/',
                meshTunnelJwt: 'callback.jwt.value',
                jwtExpiresAt: expiresAt,
            }));
            await new Promise((r) => setTimeout(r, 30));

            const row = MeshCentralRegistry.getInstance().getActive();
            expect(row).not.toBeNull();
            expect(row?.centralInstanceId).toBe('central-instance-xyz');
            // Trailing slash should be stripped to keep the persisted URL canonical.
            expect(row?.centralApiUrl).toBe('https://central.example.test');
            expect(row?.callbackJwt).toBe('callback.jwt.value');
            expect(row?.jwtExpiresAt).toBe(expiresAt);

            ws.close(1000, 'test cleanup');
            await new Promise((r) => setTimeout(r, 30));
        } finally {
            await srv.close();
        }
    });

    it('passes through if first frame is not a mesh_handshake (delegates to switchboard)', async () => {
        const srv = await startServer();
        try {
            const ws = await dialTunnel(srv.port, '?nodeId=7');
            await new Promise((r) => setTimeout(r, 20));

            // Send a known non-handshake JSON frame (tcp_close for a non-existent
            // stream is a no-op the switchboard accepts without side effects).
            ws.send(JSON.stringify({ t: 'tcp_close', s: 999999 }));
            await new Promise((r) => setTimeout(r, 30));

            // No handshake material should have been persisted.
            expect(MeshCentralRegistry.getInstance().getActive()).toBeNull();
            // WS should still be open (no protocol error close).
            expect(ws.readyState).toBe(WebSocket.OPEN);

            ws.close(1000, 'test cleanup');
            await new Promise((r) => setTimeout(r, 30));
        } finally {
            await srv.close();
        }
    });

    it('closes the WS as protocol error when mesh_handshake arrives after a non-handshake frame', async () => {
        const srv = await startServer();
        try {
            const ws = await dialTunnel(srv.port, '?nodeId=7');
            await new Promise((r) => setTimeout(r, 20));

            // First a non-handshake frame, then the handshake.
            ws.send(JSON.stringify({ t: 'tcp_close', s: 999999 }));
            await new Promise((r) => setTimeout(r, 10));

            const closeInfo = new Promise<{ code: number; reason: string }>((resolve) => {
                ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
            });
            ws.send(makeHandshakeFrame());
            const info = await closeInfo;
            expect(info.code).toBe(1008);
            expect(MeshCentralRegistry.getInstance().getActive()).toBeNull();
        } finally {
            await srv.close();
        }
    });

    it('rejects malformed mesh_handshake (missing required fields) and closes WS as protocol error', async () => {
        const srv = await startServer();
        try {
            const ws = await dialTunnel(srv.port, '?nodeId=7');
            await new Promise((r) => setTimeout(r, 20));

            const closeInfo = new Promise<{ code: number; reason: string }>((resolve) => {
                ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
            });
            // Recognized 't' discriminator but missing required fields.
            ws.send(JSON.stringify({ t: 'mesh_handshake', v: 1 }));
            const info = await closeInfo;
            expect(info.code).toBe(1008);
            expect(MeshCentralRegistry.getInstance().getActive()).toBeNull();
        } finally {
            await srv.close();
        }
    });
});
