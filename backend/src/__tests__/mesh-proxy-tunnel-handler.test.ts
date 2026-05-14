/**
 * `meshProxyTunnel.ts` is the server-side ingress for Distributed API
 * (proxy-mode) mesh tunnels. Auth + scope gating live one layer up in
 * `upgradeHandler.ts`; this file covers the handler's own invariants:
 *
 *   - It refuses to serve in pilot-mode deployments (returns 404).
 *   - On a successful upgrade it installs the shared switchboard AND
 *     CAS-installs itself as the local MeshService reverse dialer.
 *   - On WS close the reverse dialer slot is cleared so a subsequent
 *     dialer can install.
 *   - A concurrent second upgrade is rejected (1013) while the slot is
 *     held — this prevents two central instances from racing for the
 *     same remote's reverse-dial slot.
 */
import http from 'http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'net';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let handleMeshProxyTunnel: typeof import('../websocket/meshProxyTunnel').handleMeshProxyTunnel;
let MeshService: typeof import('../services/MeshService').MeshService;

interface ServerHandle {
    server: http.Server;
    port: number;
    close: () => Promise<void>;
}

/**
 * Stand up a bare http.Server that routes `/api/mesh/proxy-tunnel`
 * upgrades through the handler. Skips the `upgradeHandler.ts` auth
 * pipeline because that path is exercised by other integration tests;
 * here the contract being verified is what the handler does AFTER
 * auth has already accepted the upgrade.
 */
async function startServer(): Promise<ServerHandle> {
    const server = http.createServer();
    server.on('upgrade', (req, socket, head) => {
        if (req.url === '/api/mesh/proxy-tunnel') {
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

function dialTunnel(port: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/mesh/proxy-tunnel`);
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ handleMeshProxyTunnel } = await import('../websocket/meshProxyTunnel'));
    ({ MeshService } = await import('../services/MeshService'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    delete process.env.SENCHO_MODE;
    // Defensive: clear any reverse dialer left over from a prior test.
    MeshService.getInstance().setReverseDialer(null);
});

describe('handleMeshProxyTunnel', () => {
    it('rejects with 404 when SENCHO_MODE=pilot (pilot-mode Sencho receives mesh via the pilot tunnel only)', async () => {
        process.env.SENCHO_MODE = 'pilot';
        const srv = await startServer();
        try {
            await new Promise<void>((resolve, reject) => {
                const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/mesh/proxy-tunnel`);
                ws.once('open', () => reject(new Error('upgrade should not have succeeded')));
                ws.once('unexpected-response', (_req, res) => {
                    expect(res.statusCode).toBe(404);
                    res.resume();
                    resolve();
                });
                ws.once('error', () => { /* expected */ });
            });
        } finally {
            await srv.close();
        }
    });

    it('on successful upgrade, installs a reverse dialer that exposes openMeshTcpStream', async () => {
        const srv = await startServer();
        try {
            const ws = await dialTunnel(srv.port);
            // setReverseDialer is the load-bearing post-upgrade side effect; the
            // mesh service's dispatch path consults it on every cross-node TCP
            // open. The exact dialer instance is internal, but the presence of
            // `openMeshTcpStream` is the contract MeshService.dialMeshTcpStream
            // depends on.
            // Allow the handler's microtasks to install the dialer.
            await new Promise((r) => setTimeout(r, 20));
            const dialer = (MeshService.getInstance() as unknown as { reverseDialer: { openMeshTcpStream?: unknown } | null }).reverseDialer;
            expect(dialer).not.toBeNull();
            expect(typeof dialer?.openMeshTcpStream).toBe('function');

            ws.close(1000, 'test cleanup');
            // Wait for the close handler's CAS-uninstall.
            await new Promise((r) => setTimeout(r, 30));
            const after = (MeshService.getInstance() as unknown as { reverseDialer: unknown }).reverseDialer;
            expect(after).toBeNull();
        } finally {
            await srv.close();
        }
    });

    it('a concurrent second upgrade is closed (the reverse dialer slot is single-tenant)', async () => {
        const srv = await startServer();
        try {
            const wsA = await dialTunnel(srv.port);
            await new Promise((r) => setTimeout(r, 20));

            // The second upgrade succeeds at the WS layer (the handler
            // accepted the upgrade before discovering the slot was taken)
            // but the handler then closes the socket with code 1013.
            const wsB = new WebSocket(`ws://127.0.0.1:${srv.port}/api/mesh/proxy-tunnel`);
            const closeInfo = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
                wsB.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
                wsB.once('error', reject);
            });
            expect(closeInfo.code).toBe(1013);

            // The first tunnel's dialer is still installed.
            const dialer = (MeshService.getInstance() as unknown as { reverseDialer: unknown }).reverseDialer;
            expect(dialer).not.toBeNull();

            wsA.close(1000, 'test cleanup');
            await new Promise((r) => setTimeout(r, 30));
        } finally {
            await srv.close();
        }
    });

    it('on WS error the reverse dialer slot is cleared (defensive: matches close-path teardown)', async () => {
        const srv = await startServer();
        try {
            const ws = await dialTunnel(srv.port);
            await new Promise((r) => setTimeout(r, 20));

            // Force-terminate without a clean close; the handler's `error`
            // listener (line 133-138) should still run teardown.
            ws.terminate();
            await new Promise((r) => setTimeout(r, 30));
            const after = (MeshService.getInstance() as unknown as { reverseDialer: unknown }).reverseDialer;
            expect(after).toBeNull();
        } finally {
            await srv.close();
        }
    });
});
