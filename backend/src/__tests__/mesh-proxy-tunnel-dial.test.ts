/**
 * MeshProxyTunnelDialer: central-side dialer that opens an on-demand
 * `/api/mesh/proxy-tunnel` WebSocket to a Distributed API remote.
 *
 * These tests cover the deterministic surface: failure caching when no
 * proxy target is configured, idle-close behavior, and recent-failure
 * lookup. End-to-end TLS / handshake paths are covered by the manual
 * production verification recipe rather than by network-bound tests.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { withLoopbackTargetProtection } from './helpers/allowLoopbackTargets';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let MeshProxyTunnelDialer: typeof import('../services/MeshProxyTunnelDialer').MeshProxyTunnelDialer;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ MeshProxyTunnelDialer } = await import('../services/MeshProxyTunnelDialer'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    DatabaseService.getInstance().getDb().prepare("DELETE FROM nodes WHERE name LIKE 'proxy-test-%'").run();
});

describe('MeshProxyTunnelDialer', () => {
    it('returns null and caches a no_target failure when getProxyTarget yields no node', async () => {
        const dialer = MeshProxyTunnelDialer.resetForTest(0); // idle-close disabled
        const result = await dialer.ensureBridge(9999); // unknown nodeId
        expect(result).toBeNull();
        const failure = dialer.getRecentFailure(9999);
        expect(failure?.code).toBe('no_target');
    });

    it('returns null and caches no_target when the node has no api_token', async () => {
        const dialer = MeshProxyTunnelDialer.resetForTest(0);
        const db = DatabaseService.getInstance();
        const nodeId = db.addNode({
            name: 'proxy-test-no-token',
            type: 'remote',
            compose_dir: '',
            is_default: false,
            mode: 'proxy',
            api_url: 'https://proxy-test.invalid',
            api_token: '',
        });

        const result = await dialer.ensureBridge(nodeId);
        expect(result).toBeNull();
        const failure = dialer.getRecentFailure(nodeId);
        expect(failure?.code).toBe('no_target');
    });

    it('hasBridge reports false before the first successful dial', async () => {
        const dialer = MeshProxyTunnelDialer.resetForTest(0);
        const db = DatabaseService.getInstance();
        const nodeId = db.addNode({
            name: 'proxy-test-hasbridge',
            type: 'remote',
            compose_dir: '',
            is_default: false,
            mode: 'proxy',
            api_url: '',
            api_token: '',
        });

        expect(dialer.hasBridge(nodeId)).toBe(false);
        await dialer.ensureBridge(nodeId);
        expect(dialer.hasBridge(nodeId)).toBe(false);
    });

    /**
     * A Cloudflare-style 403 at the edge. Asserts the operator-facing label
     * and that Sencho's own credential is still on the upgrade.
     */
    it('labels an access-proxy refusal', async () => {
        const seen: http.IncomingHttpHeaders[] = [];
        const server = http.createServer();
        server.on('upgrade', (req, socket) => {
            seen.push(req.headers);
            // Mimic Cloudflare Access refusing the request at the edge.
            socket.end('HTTP/1.1 403 Forbidden\r\nServer: cloudflare\r\nCF-RAY: test\r\nContent-Length: 0\r\n\r\n');
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const { port } = server.address() as AddressInfo;
        try {
            const dialer = MeshProxyTunnelDialer.resetForTest(0);
            const nodeId = DatabaseService.getInstance().addNode({
                name: 'proxy-test-access-refusal',
                type: 'remote',
                compose_dir: '',
                is_default: false,
                mode: 'proxy',
                api_url: `http://127.0.0.1:${port}`,
                api_token: 'test-token',
            });

            expect(await dialer.ensureBridge(nodeId)).toBeNull();
            expect(seen[0]?.authorization).toBe('Bearer test-token');
            expect(dialer.getRecentFailure(nodeId)?.code).toBe('blocked_by_proxy');
        } finally {
            MeshProxyTunnelDialer.resetForTest(0);
            await new Promise<void>((r) => server.close(() => r()));
        }
    });

    it('refuses to put SENCHO_MESH_PROXY_HEADERS on a cleartext upgrade', async () => {
        // The configured headers exist to carry a gateway credential. On a
        // node URL of http:// the upgrade goes out as ws://, so sending them
        // would hand the secret to anything on the path. The dial has to stop
        // before the socket is opened, and the node has to be told why.
        const seen: http.IncomingHttpHeaders[] = [];
        const server = http.createServer();
        server.on('upgrade', (req, socket) => {
            seen.push(req.headers);
            socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const { port } = server.address() as AddressInfo;
        process.env.SENCHO_MESH_PROXY_HEADERS = JSON.stringify({ 'CF-Access-Client-Id': 'client-id' });
        try {
            const dialer = MeshProxyTunnelDialer.resetForTest(0);
            const nodeId = DatabaseService.getInstance().addNode({
                name: 'proxy-test-cleartext-headers',
                type: 'remote',
                compose_dir: '',
                is_default: false,
                mode: 'proxy',
                api_url: `http://127.0.0.1:${port}`,
                api_token: 'test-token',
            });

            expect(await dialer.ensureBridge(nodeId)).toBeNull();
            // No upgrade at all, so no header and no bearer token on the wire.
            expect(seen).toEqual([]);
            const failure = dialer.getRecentFailure(nodeId);
            expect(failure?.code).toBe('config_invalid');
            expect(failure?.message).toMatch(/only sent over a TLS node URL/);
        } finally {
            delete process.env.SENCHO_MESH_PROXY_HEADERS;
            MeshProxyTunnelDialer.resetForTest(0);
            await new Promise<void>((r) => server.close(() => r()));
        }
    });

    it('lets a TLS node URL through the configured-headers check', async () => {
        // The other half: the same config against an https:// node URL is not
        // refused for its own sake, so the failure is whatever the connection
        // itself produced. A plain-HTTP server on the far end makes that a
        // TLS protocol mismatch, which is itself the tls_failed case.
        const server = http.createServer();
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const { port } = server.address() as AddressInfo;
        process.env.SENCHO_MESH_PROXY_HEADERS = JSON.stringify({ 'CF-Access-Client-Id': 'client-id' });
        try {
            const dialer = MeshProxyTunnelDialer.resetForTest(0);
            const nodeId = DatabaseService.getInstance().addNode({
                name: 'proxy-test-tls-headers',
                type: 'remote',
                compose_dir: '',
                is_default: false,
                mode: 'proxy',
                api_url: `https://127.0.0.1:${port}`,
                api_token: 'test-token',
            });

            expect(await dialer.ensureBridge(nodeId)).toBeNull();
            const failure = dialer.getRecentFailure(nodeId);
            expect(failure?.code).not.toBe('config_invalid');
            expect(failure?.code).toBe('tls_failed');
        } finally {
            delete process.env.SENCHO_MESH_PROXY_HEADERS;
            MeshProxyTunnelDialer.resetForTest(0);
            await new Promise<void>((r) => server.close(() => r()));
        }
    });

    it('rejects an unsafe proxy target before opening a WebSocket', async () => {
        const dialer = MeshProxyTunnelDialer.resetForTest(0);
        const db = DatabaseService.getInstance();
        const nodeId = db.addNode({
            name: 'proxy-test-unsafe-target',
            type: 'remote',
            compose_dir: '',
            is_default: false,
            mode: 'proxy',
            api_url: 'http://127.0.0.1:1852',
            api_token: 'test-token',
        });

        const result = await withLoopbackTargetProtection(() => dialer.ensureBridge(nodeId));

        expect(result).toBeNull();
        expect(dialer.getRecentFailure(nodeId)).toMatchObject({
            code: 'blocked_address',
            message: 'remote resolves to a loopback, link-local or reserved address Sencho does not dial',
        });
    });

    it('expires the recent-failure cache entry after the cache TTL window', async () => {
        const dialer = MeshProxyTunnelDialer.resetForTest(0);
        const result = await dialer.ensureBridge(8888);
        expect(result).toBeNull();
        const cached = dialer.getRecentFailure(8888);
        expect(cached).not.toBeNull();
        type FailureMap = Map<number, { code: string; message?: string; ts: number }>;
        const cacheRef = (dialer as unknown as { recentFailures: FailureMap }).recentFailures;
        const entry = cacheRef.get(8888);
        if (!entry) throw new Error('cache entry missing');
        entry.ts = Date.now() - 90_000; // 90s old, well past the 60s TTL
        expect(dialer.getRecentFailure(8888)).toBeNull();
        expect(cacheRef.has(8888)).toBe(false);
    });

    it('stop() tears down the singleton and the idle-check timer', () => {
        const dialer = MeshProxyTunnelDialer.resetForTest(60_000);
        const timerRef = (dialer as unknown as { idleCheckTimer: NodeJS.Timeout | null }).idleCheckTimer;
        expect(timerRef).not.toBeNull();

        dialer.stop();
        const timerAfter = (dialer as unknown as { idleCheckTimer: NodeJS.Timeout | null }).idleCheckTimer;
        expect(timerAfter).toBeNull();
    });
});
