/**
 * Regression tests for pilot agent auth fallback when a persisted tunnel
 * token is rejected at WebSocket upgrade (401 invalid JWT, 404 unknown node).
 *
 * Preserves pilot.jwt until a successful enroll_ack; enroll fallback requires
 * upgrade 401/404 plus a still-fresh SENCHO_ENROLL_TOKEN.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { attachUpgrade } from '../websocket/upgradeHandler';
import { PilotTunnelManager } from '../services/PilotTunnelManager';
import { WebSocket } from 'ws';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

let readPersistedToken: typeof import('../pilot/agent').readPersistedToken;
let persistToken: typeof import('../pilot/agent').persistToken;
let clearPersistedToken: typeof import('../pilot/agent').clearPersistedToken;
let PilotAgent: typeof import('../pilot/agent').PilotAgent;

let server: http.Server;
let port: number;
let pilotTunnelWss: WebSocketServer;
let mainWss: WebSocketServer;
let nodeId: number;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ readPersistedToken, persistToken, clearPersistedToken, PilotAgent } = await import('../pilot/agent'));

    server = http.createServer();
    mainWss = new WebSocketServer({ noServer: true });
    pilotTunnelWss = new WebSocketServer({ noServer: true });
    attachUpgrade(server, { wss: mainWss, pilotTunnelWss });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                reject(new Error('listen returned unexpected address'));
                return;
            }
            port = addr.port;
            resolve();
        });
    });

    nodeId = DatabaseService.getInstance().addNode({
        name: `pilot-auth-fallback-${Date.now()}`,
        type: 'remote',
        mode: 'pilot_agent',
        compose_dir: '/tmp/x',
        is_default: false,
        api_url: '',
        api_token: '',
    });
});

afterAll(async () => {
    const mgr = PilotTunnelManager.getInstance();
    mgr.closeTunnel(nodeId);
    mgr.removeAllListeners('tunnel-up');
    mgr.removeAllListeners('tunnel-down');
    pilotTunnelWss.close();
    mainWss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanupTestDb(tmpDir);
});

afterEach(() => {
    PilotTunnelManager.getInstance().closeTunnel(nodeId);
    clearPersistedToken();
    vi.useRealTimers();
});

function mintStaleTunnelTokenWrongSecret(): string {
    return jwt.sign(
        { scope: 'pilot_tunnel', nodeId },
        'wrong-secret-not-the-control-instance',
        { expiresIn: '365d' },
    );
}

function mintStaleTunnelTokenWrongNode(): string {
    return jwt.sign(
        { scope: 'pilot_tunnel', nodeId: 99_999_999 },
        TEST_JWT_SECRET,
        { expiresIn: '365d' },
    );
}

function mintFreshEnrollForNode(): string {
    const expiresAt = Date.now() + 15 * 60 * 1000;
    const token = jwt.sign(
        { scope: 'pilot_enroll', nodeId, enrollNonce: crypto.randomUUID() },
        TEST_JWT_SECRET,
        { expiresIn: '15m' },
    );
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    DatabaseService.getInstance().createPilotEnrollment(nodeId, tokenHash, expiresAt);
    return token;
}

function mintExpiredEnroll(): string {
    return jwt.sign(
        {
            scope: 'pilot_enroll',
            nodeId,
            enrollNonce: crypto.randomUUID(),
            exp: Math.floor(Date.now() / 1000) - 120,
        },
        TEST_JWT_SECRET,
    );
}

function stopAgent(agent: InstanceType<typeof PilotAgent>): void {
    (agent as unknown as { shuttingDown: boolean }).shuttingDown = true;
    const timer = (agent as unknown as { reconnectTimer?: NodeJS.Timeout }).reconnectTimer;
    if (timer) clearTimeout(timer);
    (agent as unknown as { reconnectTimer?: NodeJS.Timeout }).reconnectTimer = undefined;
    try { (agent as unknown as { ws: WebSocket | null }).ws?.terminate(); } catch { /* ignore */ }
}

function enrollmentRowUsed(): boolean {
    const row = DatabaseService.getInstance().getDb()
        .prepare('SELECT used_at FROM pilot_enrollments WHERE node_id = ?')
        .get(nodeId) as { used_at: number | null } | undefined;
    return row?.used_at != null;
}

function waitForToken(
    agent: InstanceType<typeof PilotAgent>,
    predicate: (token: string) => boolean,
    timeoutMs = 3_000,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            const token = (agent as unknown as { token: string }).token;
            if (predicate(token)) {
                resolve(token);
                return;
            }
            if (Date.now() - started > timeoutMs) {
                reject(new Error(`timed out waiting for token change; still ${token.slice(0, 24)}…`));
                return;
            }
            setTimeout(tick, 25);
        };
        tick();
    });
}

describe('clearPersistedToken', () => {
    it('removes an existing pilot.jwt file', () => {
        persistToken('stale-token');
        expect(readPersistedToken()).toBe('stale-token');
        clearPersistedToken();
        expect(readPersistedToken()).toBeNull();
    });

    it('does not throw when the file is already absent', () => {
        clearPersistedToken();
        expect(() => clearPersistedToken()).not.toThrow();
        expect(readPersistedToken()).toBeNull();
    });
});

describe('pilot tunnel upgrade rejection (in-process integration)', () => {
    it('rejects a stale tunnel JWT signed with the wrong secret at upgrade with reject header', async () => {
        const staleToken = mintStaleTunnelTokenWrongSecret();
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/pilot/tunnel`, {
            headers: {
                Authorization: `Bearer ${staleToken}`,
                'x-sencho-agent-version': 'auth-fallback-test/1.0',
            },
        });
        const result = await new Promise<{ status?: number; reason?: string }>((resolve) => {
            ws.on('unexpected-response', (_req, res) => {
                const reasonHeader = res.headers['x-sencho-pilot-reject'];
                resolve({
                    status: res.statusCode,
                    reason: Array.isArray(reasonHeader) ? reasonHeader[0] : reasonHeader,
                });
                res.destroy();
            });
            ws.on('error', () => { /* close follows */ });
        });
        expect(result.status).toBe(401);
        expect(result.reason).toBe('invalid_token');
    });

    it('rejects a tunnel JWT for an unknown node with HTTP 404 at upgrade', async () => {
        const staleToken = mintStaleTunnelTokenWrongNode();
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/pilot/tunnel`, {
            headers: {
                Authorization: `Bearer ${staleToken}`,
                'x-sencho-agent-version': 'auth-fallback-test/1.0',
            },
        });
        const result = await new Promise<{ status?: number; reason?: string }>((resolve) => {
            ws.on('unexpected-response', (_req, res) => {
                const reasonHeader = res.headers['x-sencho-pilot-reject'];
                resolve({
                    status: res.statusCode,
                    reason: Array.isArray(reasonHeader) ? reasonHeader[0] : reasonHeader,
                });
                res.destroy();
            });
            ws.on('error', () => { /* close follows */ });
        });
        expect(result.status).toBe(404);
        expect(result.reason).toBe('unknown_node');
    });
});

describe('PilotAgent reconnect recovery (real hub)', () => {
    it('swaps to a fresh enroll token on hub 401 and leaves pilot.jwt unchanged until enroll_ack', async () => {
        const diskToken = mintStaleTunnelTokenWrongSecret();
        persistToken(diskToken);
        const enroll = mintFreshEnrollForNode();

        const agent = new PilotAgent({
            primaryUrl: `http://127.0.0.1:${port}`,
            loopbackPort: 1,
            initialToken: diskToken,
            enrollToken: enroll,
            enrolling: false,
        });

        (agent as unknown as { connect: () => void }).connect();
        await waitForToken(agent, (t) => t === enroll);

        expect(readPersistedToken()).toBe(diskToken);
        expect(enrollmentRowUsed()).toBe(false);

        // Next reconnect should complete enrollment and overwrite disk.
        await waitForToken(agent, (t) => t !== enroll && t !== diskToken, 5_000);
        // Allow persistToken + any in-flight sibling dial to settle.
        await new Promise((r) => setTimeout(r, 100));
        const finalToken = (agent as unknown as { token: string }).token;
        expect(finalToken).not.toBe(diskToken);
        expect(finalToken).not.toBe(enroll);
        expect(readPersistedToken()).toBe(finalToken);
        expect(enrollmentRowUsed()).toBe(true);

        stopAgent(agent);
    });

    it('keeps pilot.jwt and dial token when enroll is expired', async () => {
        const diskToken = mintStaleTunnelTokenWrongSecret();
        persistToken(diskToken);
        const agent = new PilotAgent({
            primaryUrl: `http://127.0.0.1:${port}`,
            loopbackPort: 1,
            initialToken: diskToken,
            enrollToken: mintExpiredEnroll(),
            enrolling: false,
        });

        (agent as unknown as { connect: () => void }).connect();
        await new Promise((r) => setTimeout(r, 400));

        expect(readPersistedToken()).toBe(diskToken);
        expect((agent as unknown as { token: string }).token).toBe(diskToken);

        stopAgent(agent);
    });

    it('does not consume enrollment or swap on a post-handshake capacity close (1013)', async () => {
        const goodTunnel = jwt.sign(
            { scope: 'pilot_tunnel', nodeId },
            TEST_JWT_SECRET,
            { expiresIn: '365d' },
        );
        persistToken(goodTunnel);
        const enroll = mintFreshEnrollForNode();

        const agent = new PilotAgent({
            primaryUrl: `http://127.0.0.1:${port}`,
            loopbackPort: 1,
            initialToken: goodTunnel,
            enrollToken: enroll,
            enrolling: false,
        });

        const up = new Promise<void>((resolve) => {
            PilotTunnelManager.getInstance().once('tunnel-up', () => resolve());
        });
        (agent as unknown as { connect: () => void }).connect();
        await up;

        // Force a post-handshake close that mimics capacity (1013).
        PilotTunnelManager.getInstance().closeTunnel(nodeId);
        await new Promise((r) => setTimeout(r, 300));

        expect((agent as unknown as { token: string }).token).toBe(goodTunnel);
        expect(readPersistedToken()).toBe(goodTunnel);
        expect(enrollmentRowUsed()).toBe(false);

        stopAgent(agent);
    });

    it('schedules exactly one reconnect per rejected upgrade', async () => {
        const diskToken = mintStaleTunnelTokenWrongSecret();
        persistToken(diskToken);

        const agent = new PilotAgent({
            primaryUrl: `http://127.0.0.1:${port}`,
            loopbackPort: 1,
            initialToken: diskToken,
            enrollToken: mintExpiredEnroll(),
            enrolling: false,
        });

        const connectSpy = vi.spyOn(agent as unknown as { connect: () => void }, 'connect');
        (agent as unknown as { connect: () => void }).connect();
        // Initial call + wait for one scheduled reconnect.
        await new Promise((r) => setTimeout(r, 1_600));

        // connect() was invoked once by us and once by scheduleReconnect.
        expect(connectSpy.mock.calls.length).toBe(2);

        stopAgent(agent);
        connectSpy.mockRestore();
    });
});

describe('PilotAgent opaque proxy 401 (no Sencho reject header)', () => {
    it('still attempts enroll fallback when a fresh enroll token is present', async () => {
        const opaque = http.createServer((_req, res) => {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('Unauthorized');
        });
        const opaquePort = await new Promise<number>((resolve, reject) => {
            opaque.listen(0, '127.0.0.1', () => {
                const addr = opaque.address();
                if (!addr || typeof addr === 'string') {
                    reject(new Error('listen failed'));
                    return;
                }
                resolve(addr.port);
            });
        });

        const diskToken = 'opaque-disk-token';
        persistToken(diskToken);
        const enroll = jwt.sign(
            { scope: 'pilot_enroll', nodeId: 1, enrollNonce: crypto.randomUUID() },
            'irrelevant',
            { expiresIn: '15m' },
        );

        const agent = new PilotAgent({
            primaryUrl: `http://127.0.0.1:${opaquePort}`,
            loopbackPort: 1,
            initialToken: diskToken,
            enrollToken: enroll,
            enrolling: false,
        });

        (agent as unknown as { connect: () => void }).connect();
        await waitForToken(agent, (t) => t === enroll);

        expect(readPersistedToken()).toBe(diskToken);

        stopAgent(agent);
        await new Promise<void>((resolve) => opaque.close(() => resolve()));
    });
});
