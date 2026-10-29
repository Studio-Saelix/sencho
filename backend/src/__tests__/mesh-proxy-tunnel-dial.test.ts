/**
 * MeshProxyTunnelDialer: central-side dialer that opens an on-demand
 * `/api/mesh/proxy-tunnel` WebSocket to a Distributed API remote.
 *
 * These tests cover the deterministic surface: failure caching when no
 * proxy target is configured, idle-close behavior, recent-failure lookup,
 * and the pre-connection configuration refusals. The successful WSS path
 * with gateway headers and a private CA is covered by
 * `mesh-proxy-tunnel-wss.test.ts`.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import tls from 'tls';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { withLoopbackTargetProtection } from './helpers/allowLoopbackTargets';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let MeshProxyTunnelDialer: typeof import('../services/MeshProxyTunnelDialer').MeshProxyTunnelDialer;
let MeshService: typeof import('../services/MeshService').MeshService;
let meshReachableReason: typeof import('../services/MeshService').meshReachableReason;

/** Answer every WebSocket upgrade with one fixed HTTP response. */
async function startUpgradeRefusal(response: string): Promise<{
    port: number;
    seen: http.IncomingHttpHeaders[];
    close: () => Promise<void>;
}> {
    const seen: http.IncomingHttpHeaders[] = [];
    const server = http.createServer();
    server.on('upgrade', (req, socket) => {
        seen.push(req.headers);
        socket.end(response);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    return {
        port,
        seen,
        close: () => new Promise<void>((r) => server.close(() => r())),
    };
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ MeshProxyTunnelDialer } = await import('../services/MeshProxyTunnelDialer'));
    ({ MeshService, meshReachableReason } = await import('../services/MeshService'));
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
     * A gateway refusal that identifies itself: Cloudflare Access redirects a
     * request with no service token to its login host. Asserts the
     * operator-facing gateway label and that Sencho's own credential is still
     * on the upgrade.
     */
    it('labels an access-gateway refusal that identifies itself', async () => {
        const peer = await startUpgradeRefusal(
            'HTTP/1.1 302 Found\r\nLocation: https://team.cloudflareaccess.com/cdn-cgi/access/login\r\nContent-Length: 0\r\n\r\n',
        );
        try {
            const dialer = MeshProxyTunnelDialer.resetForTest(0);
            const nodeId = DatabaseService.getInstance().addNode({
                name: 'proxy-test-access-refusal',
                type: 'remote',
                compose_dir: '',
                is_default: false,
                mode: 'proxy',
                api_url: `http://127.0.0.1:${peer.port}`,
                api_token: 'test-token',
            });

            expect(await dialer.ensureBridge(nodeId)).toBeNull();
            expect(peer.seen[0]?.authorization).toBe('Bearer test-token');
            const failure = dialer.getRecentFailure(nodeId);
            expect(failure?.code).toBe('blocked_by_proxy');
            expect(meshReachableReason(failure!.code)).toMatch(/access proxy/);
            const status = (await MeshService.getInstance().getStatus()).find((s) => s.nodeId === nodeId);
            expect(status?.reachableMode).toBe('unreachable');
            expect(status?.reachableReason).toMatch(/access proxy/);
        } finally {
            MeshProxyTunnelDialer.resetForTest(0);
            await peer.close();
        }
    });

    /**
     * The mixed-version shape: an older remote rejects a stale token with an
     * unmarked 403 and Cloudflare forwards that response with the ordinary
     * edge headers every proxied response carries. Edge headers identify
     * transit, not the hop that refused, so the dial must not blame a
     * gateway and send the operator after the gateway credential.
     */
    it('keeps a forwarded origin refusal unclassified', async () => {
        const peer = await startUpgradeRefusal(
            'HTTP/1.1 403 Forbidden\r\nServer: cloudflare\r\nCF-RAY: test\r\nContent-Length: 0\r\n\r\n',
        );
        try {
            const dialer = MeshProxyTunnelDialer.resetForTest(0);
            const nodeId = DatabaseService.getInstance().addNode({
                name: 'proxy-test-forwarded-refusal',
                type: 'remote',
                compose_dir: '',
                is_default: false,
                mode: 'proxy',
                api_url: `http://127.0.0.1:${peer.port}`,
                api_token: 'stale-token',
            });

            expect(await dialer.ensureBridge(nodeId)).toBeNull();
            expect(peer.seen[0]?.authorization).toBe('Bearer stale-token');
            const failure = dialer.getRecentFailure(nodeId);
            expect(failure?.code).toBe('refused_unverified');
            expect(meshReachableReason(failure!.code)).toMatch(/refused or redirected/);
            expect(meshReachableReason(failure!.code)).not.toMatch(/access proxy/);
            // Mesh status is where the node card and topology read the
            // explanation, so the cached code has to reach it unchanged.
            const status = (await MeshService.getInstance().getStatus()).find((s) => s.nodeId === nodeId);
            expect(status?.reachableMode).toBe('unreachable');
            expect(status?.reachableReason).toMatch(/refused or redirected/);
            expect(status?.reachableReason).not.toMatch(/access proxy/);
        } finally {
            MeshProxyTunnelDialer.resetForTest(0);
            await peer.close();
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

    it.each([
        ['SENCHO_MESH_PROXY_HEADERS with a value above U+00FF', 'headers'],
        ['SENCHO_MESH_PROXY_CA_FILE with an invalid certificate', 'ca'],
    ])('reports %s as config_invalid before opening a socket', async (_label, kind) => {
        // Both are configuration errors, not network failures: the dial must
        // stop before any upgrade so the node card names the real problem.
        const seen: http.IncomingHttpHeaders[] = [];
        const server = http.createServer();
        server.on('upgrade', (req) => { seen.push(req.headers); });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const { port } = server.address() as AddressInfo;
        let dir: string | undefined;
        try {
            if (kind === 'headers') {
                process.env.SENCHO_MESH_PROXY_HEADERS = JSON.stringify({ 'X-Test': 'hello世界' });
            } else {
                dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-ca-'));
                const file = path.join(dir, 'ca.pem');
                fs.writeFileSync(file, '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----');
                process.env.SENCHO_MESH_PROXY_CA_FILE = file;
            }
            const dialer = MeshProxyTunnelDialer.resetForTest(0);
            const nodeId = DatabaseService.getInstance().addNode({
                name: `proxy-test-bad-config-${kind}`,
                type: 'remote',
                compose_dir: '',
                is_default: false,
                mode: 'proxy',
                api_url: `https://127.0.0.1:${port}`,
                api_token: 'test-token',
            });

            expect(await dialer.ensureBridge(nodeId)).toBeNull();
            expect(seen).toEqual([]);
            const failure = dialer.getRecentFailure(nodeId);
            expect(failure?.code).toBe('config_invalid');
            expect(failure?.message).toMatch(kind === 'headers' ? /characters above U\+00FF/ : /valid X\.509/);
        } finally {
            delete process.env.SENCHO_MESH_PROXY_HEADERS;
            delete process.env.SENCHO_MESH_PROXY_CA_FILE;
            MeshProxyTunnelDialer.resetForTest(0);
            if (dir) fs.rmSync(dir, { recursive: true, force: true });
            await new Promise<void>((r) => server.close(() => r()));
        }
    });

    it('reads the CA file on the first dial and keeps the parsed config for the process', async () => {
        // The configuration docs say NODE_EXTRA_CA_CERTS is read at process
        // start while SENCHO_MESH_PROXY_CA_FILE is read when the dial
        // configuration is first loaded, on the first proxy-mode dial, and
        // kept once it parses. Pin both halves: the file is not opened before
        // a dial, a failed parse is retried on the next dial, and a loaded
        // config is not re-read afterwards.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-ca-lazy-'));
        const file = path.join(dir, 'ca.pem');
        const server = await startUpgradeRefusal('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        const caReads = vi.spyOn(fs, 'readFileSync');
        try {
            process.env.SENCHO_MESH_PROXY_CA_FILE = file;
            fs.writeFileSync(file, 'not a cert');
            const reads = (): number => caReads.mock.calls.filter((args) => String(args[0]) === file).length;

            // Constructed with the corrupt file already configured: creation
            // must not open it, the first dial must.
            const dialer = MeshProxyTunnelDialer.resetForTest(0);
            expect(reads()).toBe(0);
            const db = DatabaseService.getInstance();
            const addNode = (name: string): number => db.addNode({
                name,
                type: 'remote',
                compose_dir: '',
                is_default: false,
                mode: 'proxy',
                api_url: `http://127.0.0.1:${server.port}`,
                api_token: 'test-token',
            });

            const corruptId = addNode('proxy-test-lazy-ca-corrupt');
            expect(await dialer.ensureBridge(corruptId)).toBeNull();
            const corruptFailure = dialer.getRecentFailure(corruptId);
            expect(corruptFailure?.code).toBe('config_invalid');
            expect(corruptFailure?.message).toContain('SENCHO_MESH_PROXY_CA_FILE');
            expect(corruptFailure?.message).toContain('does not contain a PEM certificate');
            expect(reads()).toBe(1);
            expect(server.seen).toHaveLength(0);

            // A failed load is not a loaded config: repairing the file lets
            // the next dial read and keep it. The node has no gateway
            // credential, so the dial reaches the upgrade and is refused.
            fs.writeFileSync(file, tls.rootCertificates[0]);
            const repairedId = addNode('proxy-test-lazy-ca-repaired');
            expect(await dialer.ensureBridge(repairedId)).toBeNull();
            expect(dialer.getRecentFailure(repairedId)?.code).toBe('upgrade_rejected');
            expect(reads()).toBe(2);
            expect(server.seen).toHaveLength(1);

            // The parsed bundle is cached now: corrupting the file does not
            // change later dials until central restarts.
            fs.writeFileSync(file, 'not a cert');
            const cachedId = addNode('proxy-test-lazy-ca-cached');
            expect(await dialer.ensureBridge(cachedId)).toBeNull();
            expect(dialer.getRecentFailure(cachedId)?.code).toBe('upgrade_rejected');
            expect(reads()).toBe(2);
            expect(server.seen).toHaveLength(2);
        } finally {
            delete process.env.SENCHO_MESH_PROXY_CA_FILE;
            MeshProxyTunnelDialer.resetForTest(0);
            caReads.mockRestore();
            fs.rmSync(dir, { recursive: true, force: true });
            await server.close();
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
