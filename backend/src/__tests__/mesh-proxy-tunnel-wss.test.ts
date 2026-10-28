/**
 * Proxy-mode mesh over a real TLS WebSocket.
 *
 * The two primary acceptance criteria of the feature are a successful dial
 * through an access gateway that demands its own credential and a successful
 * dial against a remote with a private CA. Parser-level assertions cannot
 * prove either, so these tests run the real `ensureBridge` path against an
 * HTTPS server that terminates the upgrade itself.
 *
 * The fixture certificate is issued by a CA Node does not trust, so a
 * successful connection proves `SENCHO_MESH_PROXY_CA_FILE` is applied, and a
 * failure without it proves certificate verification was not disabled.
 */
import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import './helpers/allowLoopbackTargets';

const FIXTURES_DIR = path.resolve(__dirname, '..', '..', '..', 'e2e', 'fixtures');
const PRIVATE_CA_FILE = path.join(FIXTURES_DIR, 'git-ca.pem');
const OTHER_CA_FILE = path.join(FIXTURES_DIR, 'git-private-ca.pem');
const SERVER_CERT = fs.readFileSync(path.join(FIXTURES_DIR, 'git-server.pem'));
const SERVER_KEY = fs.readFileSync(path.join(FIXTURES_DIR, 'git-server.key'));

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let MeshProxyTunnelDialer: typeof import('../services/MeshProxyTunnelDialer').MeshProxyTunnelDialer;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let PROXY_TIER_HEADER: string;

interface WssPeer {
    port: number;
    seen: http.IncomingHttpHeaders[];
    close: () => Promise<void>;
}

/**
 * HTTPS peer that completes the WebSocket upgrade itself. `require` models
 * an access gateway: a header that must carry the expected value or the
 * upgrade is refused with Sencho's rejection marker, as Cloudflare Access
 * would refuse before the request reaches Sencho.
 */
async function startPeer(options: { require?: Record<string, string> } = {}): Promise<WssPeer> {
    const seen: http.IncomingHttpHeaders[] = [];
    const wss = new WebSocketServer({ noServer: true });
    const sockets = new Set<WebSocket>();
    const server = https.createServer({ cert: SERVER_CERT, key: SERVER_KEY });
    server.on('upgrade', (req, socket, head) => {
        seen.push(req.headers);
        const missing = Object.entries(options.require ?? {})
            .find(([name, value]) => req.headers[name.toLowerCase()] !== value);
        if (missing) {
            socket.end('HTTP/1.1 401 Unauthorized\r\nX-Sencho-Mesh-Reject: unauthorized\r\nContent-Length: 0\r\n\r\n');
            return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            sockets.add(ws);
            ws.on('close', () => sockets.delete(ws));
            ws.on('error', () => { /* closed by the test */ });
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    return {
        port,
        seen,
        close: async () => {
            for (const ws of sockets) {
                try { ws.terminate(); } catch { /* ignore */ }
            }
            wss.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

function addProxyNode(name: string, port: number, token = 'test-token'): number {
    return DatabaseService.getInstance().addNode({
        name,
        type: 'remote',
        compose_dir: '',
        is_default: false,
        mode: 'proxy',
        api_url: `https://127.0.0.1:${port}`,
        api_token: token,
    });
}

describe('proxy-mode mesh WSS dial', () => {
    beforeAll(async () => {
        tmpDir = await setupTestDb();
        ({ DatabaseService } = await import('../services/DatabaseService'));
        ({ MeshProxyTunnelDialer } = await import('../services/MeshProxyTunnelDialer'));
        ({ LicenseService } = await import('../services/LicenseService'));
        ({ PROXY_TIER_HEADER } = await import('../services/license-headers'));
    });

    afterAll(() => {
        cleanupTestDb(tmpDir);
    });

    beforeEach(() => {
        DatabaseService.getInstance().getDb().prepare("DELETE FROM nodes WHERE name LIKE 'mesh-wss-%'").run();
    });

    afterEach(() => {
        delete process.env.SENCHO_MESH_PROXY_HEADERS;
        delete process.env.SENCHO_MESH_PROXY_CA_FILE;
        MeshProxyTunnelDialer.resetForTest(0);
    });

    it('establishes an authenticated bridge with configured gateway headers and a private CA', async () => {
        const peer = await startPeer({ require: { 'x-gateway-key': 'gateway-secret' } });
        process.env.SENCHO_MESH_PROXY_HEADERS = JSON.stringify({ 'X-Gateway-Key': 'gateway-secret' });
        process.env.SENCHO_MESH_PROXY_CA_FILE = PRIVATE_CA_FILE;
        const dialer = MeshProxyTunnelDialer.resetForTest(0);
        const nodeId = addProxyNode('mesh-wss-success', peer.port);
        try {
            const bridge = await dialer.ensureBridge(nodeId);

            expect(bridge).not.toBeNull();
            expect(dialer.hasBridge(nodeId)).toBe(true);
            const headers = peer.seen[0];
            expect(headers?.['x-gateway-key']).toBe('gateway-secret');
            expect(headers?.authorization).toBe('Bearer test-token');
            expect(headers?.[PROXY_TIER_HEADER]).toBe(LicenseService.getInstance().getProxyHeaders().tier);

            dialer.closeBridge(nodeId, 'test teardown');
            expect(dialer.hasBridge(nodeId)).toBe(false);
        } finally {
            await peer.close();
        }
    });

    it('selects the gateway credential and node token per node, with "*" as the fallback', async () => {
        const peer = await startPeer();
        process.env.SENCHO_MESH_PROXY_HEADERS = JSON.stringify({
            '*': { 'X-Gateway-Key': 'fallback' },
            'mesh-wss-edge': { 'X-Gateway-Key': 'edge-only' },
        });
        process.env.SENCHO_MESH_PROXY_CA_FILE = PRIVATE_CA_FILE;
        const dialer = MeshProxyTunnelDialer.resetForTest(0);
        const edgeId = addProxyNode('mesh-wss-edge', peer.port, 'edge-token');
        const otherId = addProxyNode('mesh-wss-other', peer.port, 'fallback-token');
        try {
            expect(await dialer.ensureBridge(edgeId)).not.toBeNull();
            expect(await dialer.ensureBridge(otherId)).not.toBeNull();
            expect(peer.seen.map((h) => h['x-gateway-key'])).toEqual(['edge-only', 'fallback']);
            expect(peer.seen.map((h) => h.authorization)).toEqual(['Bearer edge-token', 'Bearer fallback-token']);
        } finally {
            await peer.close();
        }
    });

    it('reports auth_failed when the gateway refuses because no credential was configured', async () => {
        const peer = await startPeer({ require: { 'x-gateway-key': 'needed' } });
        process.env.SENCHO_MESH_PROXY_CA_FILE = PRIVATE_CA_FILE;
        const dialer = MeshProxyTunnelDialer.resetForTest(0);
        const nodeId = addProxyNode('mesh-wss-no-header', peer.port);
        try {
            expect(await dialer.ensureBridge(nodeId)).toBeNull();
            expect(dialer.getRecentFailure(nodeId)?.code).toBe('auth_failed');
            // The refusal came from the gateway, so Sencho's request reached
            // it but did not carry the header it wanted.
            expect(peer.seen[0]?.['x-gateway-key']).toBeUndefined();
            expect(peer.seen[0]?.authorization).toBe('Bearer test-token');
        } finally {
            await peer.close();
        }
    });

    it('fails TLS verification without the private CA instead of disabling it', async () => {
        const peer = await startPeer();
        const dialer = MeshProxyTunnelDialer.resetForTest(0);
        const nodeId = addProxyNode('mesh-wss-no-ca', peer.port);
        try {
            expect(await dialer.ensureBridge(nodeId)).toBeNull();
            expect(dialer.getRecentFailure(nodeId)?.code).toBe('tls_failed');
            // Verification failed before the HTTP upgrade, so the gateway
            // never saw the request (and never saw the Bearer token).
            expect(peer.seen).toEqual([]);
        } finally {
            await peer.close();
        }
    });

    it('does not trust a certificate from a CA outside the configured bundle', async () => {
        const peer = await startPeer();
        process.env.SENCHO_MESH_PROXY_CA_FILE = OTHER_CA_FILE;
        const dialer = MeshProxyTunnelDialer.resetForTest(0);
        const nodeId = addProxyNode('mesh-wss-wrong-ca', peer.port);
        try {
            expect(await dialer.ensureBridge(nodeId)).toBeNull();
            expect(dialer.getRecentFailure(nodeId)?.code).toBe('tls_failed');
        } finally {
            await peer.close();
        }
    });

    it('accepts a bundle with several certificates, including the remote CA', async () => {
        const peer = await startPeer();
        const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-ca-'));
        const bundleFile = path.join(bundleDir, 'bundle.pem');
        fs.writeFileSync(bundleFile, `${fs.readFileSync(OTHER_CA_FILE, 'utf8')}\n${fs.readFileSync(PRIVATE_CA_FILE, 'utf8')}`);
        process.env.SENCHO_MESH_PROXY_CA_FILE = bundleFile;
        const dialer = MeshProxyTunnelDialer.resetForTest(0);
        const nodeId = addProxyNode('mesh-wss-bundle', peer.port);
        try {
            expect(await dialer.ensureBridge(nodeId)).not.toBeNull();
            expect(dialer.hasBridge(nodeId)).toBe(true);
        } finally {
            await peer.close();
            fs.rmSync(bundleDir, { recursive: true, force: true });
        }
    });
});
