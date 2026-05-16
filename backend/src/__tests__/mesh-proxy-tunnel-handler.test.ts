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
    MeshService.getInstance().setProxyTunnelSelfCentralNodeId(null);
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

    it('installs the central-namespace nodeId from the ?nodeId= query param', async () => {
        const srv = await startServer();
        try {
            const ws = await dialTunnel(srv.port, '?nodeId=14');
            await new Promise((r) => setTimeout(r, 20));
            expect((MeshService.getInstance() as unknown as { proxyTunnelSelfCentralNodeId: number | null }).proxyTunnelSelfCentralNodeId).toBe(14);
            ws.close(1000, 'test cleanup');
            await new Promise((r) => setTimeout(r, 30));
        } finally {
            await srv.close();
        }
    });

    it('the install persists across WS close (enrollment-stable, not per-bridge)', async () => {
        // Null-clearing on teardown previously caused handleAccept to fall
        // back to getDefaultNodeId() after idle close, misdispatching
        // cross-fleet aliases to the same-node path.
        const srv = await startServer();
        try {
            const ws = await dialTunnel(srv.port, '?nodeId=14');
            await new Promise((r) => setTimeout(r, 20));
            ws.close(1000, 'test cleanup');
            await new Promise((r) => setTimeout(r, 30));
            expect((MeshService.getInstance() as unknown as { proxyTunnelSelfCentralNodeId: number | null }).proxyTunnelSelfCentralNodeId).toBe(14);
        } finally {
            await srv.close();
        }
    });

    it('re-opening the tunnel with the same nodeId is idempotent (no second identify event)', async () => {
        const srv = await startServer();
        const svc = MeshService.getInstance();
        const identifyCount = () => svc.getActivity({ limit: 200 })
            .filter((e) => e.type === 'mesh.proxy_tunnel.identify').length;
        const waitForCount = async (atLeast: number, timeoutMs = 500): Promise<void> => {
            const start = Date.now();
            while (Date.now() - start < timeoutMs && identifyCount() < atLeast) {
                await new Promise((r) => setTimeout(r, 5));
            }
        };
        try {
            const wsA = await dialTunnel(srv.port, '?nodeId=14');
            // Snapshot after the first identify event has deterministically
            // landed, so the race window between WS-open and async install
            // can't make beforeCount=0 on a slow CI.
            await waitForCount(1);
            const beforeCount = identifyCount();
            expect(beforeCount).toBeGreaterThanOrEqual(1);

            wsA.close(1000, 'test cleanup');
            await new Promise((r) => setTimeout(r, 30));

            const wsB = await dialTunnel(srv.port, '?nodeId=14');
            // Settle window for any (incorrect) second identify; small but
            // deterministic because the assertion below is "no new event"
            // and a longer wait wouldn't change the answer.
            await new Promise((r) => setTimeout(r, 50));
            expect((svc as unknown as { proxyTunnelSelfCentralNodeId: number | null }).proxyTunnelSelfCentralNodeId).toBe(14);
            expect(identifyCount()).toBe(beforeCount);

            wsB.close(1000, 'test cleanup');
            await new Promise((r) => setTimeout(r, 30));
        } finally {
            await srv.close();
        }
    });

    it('re-opening the tunnel with a different nodeId emits the overwrite warn (re-enrollment signal)', async () => {
        const srv = await startServer();
        const warns: string[] = [];
        const origWarn = console.warn;
        console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };
        try {
            const wsA = await dialTunnel(srv.port, '?nodeId=14');
            await new Promise((r) => setTimeout(r, 20));
            wsA.close(1000, 'test cleanup');
            await new Promise((r) => setTimeout(r, 30));

            const wsB = await dialTunnel(srv.port, '?nodeId=15');
            await new Promise((r) => setTimeout(r, 20));
            const svc = MeshService.getInstance();
            expect((svc as unknown as { proxyTunnelSelfCentralNodeId: number | null }).proxyTunnelSelfCentralNodeId).toBe(15);

            const overwriteWarns = warns.filter((w) => w.includes('proxyTunnelSelfCentralNodeId overwritten'));
            expect(overwriteWarns.length).toBeGreaterThanOrEqual(1);
            expect(overwriteWarns[overwriteWarns.length - 1]).toContain('14 -> 15');

            wsB.close(1000, 'test cleanup');
            await new Promise((r) => setTimeout(r, 30));
        } finally {
            console.warn = origWarn;
            await srv.close();
        }
    });

    it('does not install or reject when the nodeId query param is missing (warns and proceeds)', async () => {
        const srv = await startServer();
        try {
            const ws = await dialTunnel(srv.port);
            await new Promise((r) => setTimeout(r, 20));
            // Upgrade succeeded (reverse dialer installed), but no nodeId
            // is recorded because central did not pass it.
            const dialer = (MeshService.getInstance() as unknown as { reverseDialer: unknown }).reverseDialer;
            expect(dialer).not.toBeNull();
            expect((MeshService.getInstance() as unknown as { proxyTunnelSelfCentralNodeId: number | null }).proxyTunnelSelfCentralNodeId).toBeNull();

            ws.close(1000, 'test cleanup');
            await new Promise((r) => setTimeout(r, 30));
        } finally {
            await srv.close();
        }
    });

    it('ignores malformed nodeId query params (non-numeric, zero, negative, decimal, leading zeros, exponent, whitespace)', async () => {
        const srv = await startServer();
        try {
            // Strict regex rejects everything that is not a positive
            // decimal integer with no leading zero. parseInt would have
            // silently truncated `14.5` to `14`, accepted `00014`, etc.
            const cases = [
                '?nodeId=abc', '?nodeId=0', '?nodeId=-3',
                '?nodeId=14.5', '?nodeId=00014', '?nodeId=1e2',
                '?nodeId=%2014', '?nodeId=14abc', '?nodeId=',
            ];
            for (const bogus of cases) {
                const ws = await dialTunnel(srv.port, bogus);
                await new Promise((r) => setTimeout(r, 20));
                expect((MeshService.getInstance() as unknown as { proxyTunnelSelfCentralNodeId: number | null }).proxyTunnelSelfCentralNodeId).toBeNull();
                ws.close(1000, 'test cleanup');
                await new Promise((r) => setTimeout(r, 30));
            }
        } finally {
            await srv.close();
        }
    });

    it('setProxyTunnelSelfCentralNodeId warns on a non-null overwrite to a different value', () => {
        const svc = MeshService.getInstance();
        const warns: string[] = [];
        const origWarn = console.warn;
        console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };
        try {
            svc.setProxyTunnelSelfCentralNodeId(14);
            svc.setProxyTunnelSelfCentralNodeId(14); // same value: no warn
            svc.setProxyTunnelSelfCentralNodeId(15); // different value: warn
            svc.setProxyTunnelSelfCentralNodeId(null); // clear: no warn
            svc.setProxyTunnelSelfCentralNodeId(20); // install after clear: no warn
        } finally {
            console.warn = origWarn;
        }
        const overwriteWarns = warns.filter((w) => w.includes('proxyTunnelSelfCentralNodeId overwritten'));
        expect(overwriteWarns).toHaveLength(1);
        expect(overwriteWarns[0]).toContain('14 -> 15');
    });

    it('a CAS-rejected reverse-dialer install does not leak the nodeId into MeshService', async () => {
        const svc = MeshService.getInstance();
        // Pre-seed the reverse-dialer slot so the handler's CAS install
        // fails. The contract: the nodeId installer runs ONLY after the
        // CAS install succeeds; a rejected upgrade must leave the
        // identity slot unchanged.
        const blockingDialer = { openMeshTcpStream: () => null };
        svc.setReverseDialer(blockingDialer as unknown as Parameters<typeof svc.setReverseDialer>[0]);
        try {
            const srv = await startServer();
            try {
                const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/mesh/proxy-tunnel?nodeId=14`);
                const closeInfo = await new Promise<{ code: number }>((resolve, reject) => {
                    ws.once('close', (code) => resolve({ code }));
                    ws.once('error', reject);
                });
                expect(closeInfo.code).toBe(1013);
                expect((svc as unknown as { proxyTunnelSelfCentralNodeId: number | null }).proxyTunnelSelfCentralNodeId).toBeNull();
            } finally {
                await srv.close();
            }
        } finally {
            svc.setReverseDialer(null);
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
