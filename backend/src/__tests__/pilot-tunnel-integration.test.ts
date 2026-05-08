/**
 * In-process integration test for the pilot reverse-tunnel handshake.
 *
 * Layered unit tests already cover the protocol decoder, the bridge cap,
 * the manager, and the DB-layer enrollment lifecycle. None of them exercise
 * the *glue*: the WebSocket dispatch order, the agent-side connect path,
 * the actual hello / enroll_ack round-trip, the long-lived token swap. A
 * regression that breaks the dispatch order in upgradeHandler.ts (e.g. a
 * future refactor that puts /api/pilot/tunnel below the auth gate), or a
 * change that breaks the enroll_ack frame ordering, would not be caught by
 * any other test today.
 *
 * This test spins up a real http.Server with attachUpgrade wired up and a
 * real ws.WebSocket client. It intentionally does NOT mock the agent side
 * of the tunnel beyond the framing protocol; the goal is to confirm the
 * wires connect end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { WebSocket, WebSocketServer } from 'ws';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { attachUpgrade } from '../websocket/upgradeHandler';
import { decodeJsonFrame, type JsonFrame, PROTOCOL_VERSION } from '../pilot/protocol';
import { PilotTunnelManager } from '../services/PilotTunnelManager';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

let server: http.Server;
let port: number;
let pilotTunnelWss: WebSocketServer;
let mainWss: WebSocketServer;
let nodeId: number;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));

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
        name: `pilot-integration-${Date.now()}`,
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
    // The manager is a process-singleton; any tunnel-up / tunnel-down
    // listeners attached during this file's run survive into other test
    // files in the same Vitest worker. Clear them so a sibling test that
    // asserts listener counts or counts emissions is not polluted.
    mgr.removeAllListeners('tunnel-up');
    mgr.removeAllListeners('tunnel-down');
    pilotTunnelWss.close();
    mainWss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanupTestDb(tmpDir);
});

afterEach(() => {
    // Belt-and-braces: any test that left a tunnel open shouldn't leak into
    // the next one. closeTunnel is a no-op if nothing is registered.
    PilotTunnelManager.getInstance().closeTunnel(nodeId);
});

function mintEnrollToken(): string {
    const db = DatabaseService.getInstance();
    const jwtSecret = db.getGlobalSettings().auth_jwt_secret;
    if (!jwtSecret) throw new Error('test DB has no auth_jwt_secret');
    const ttlSeconds = 15 * 60;
    const token = jwt.sign(
        { scope: 'pilot_enroll', nodeId, enrollNonce: crypto.randomUUID() },
        jwtSecret,
        { expiresIn: ttlSeconds },
    );
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    db.createPilotEnrollment(nodeId, hash, Date.now() + ttlSeconds * 1000);
    return token;
}

/**
 * Open a real ws client to the test server's pilot tunnel endpoint and
 * return a reader that surfaces decoded JSON frames in arrival order.
 */
async function openTunnel(token: string): Promise<{
    ws: WebSocket;
    nextJsonFrame: () => Promise<JsonFrame>;
    closed: Promise<void>;
}> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/pilot/tunnel`, {
        headers: {
            Authorization: `Bearer ${token}`,
            'x-sencho-agent-version': 'integration-test/1.0',
        },
    });

    const queue: JsonFrame[] = [];
    const waiters: Array<(frame: JsonFrame) => void> = [];
    ws.on('message', (data, isBinary) => {
        if (isBinary) return; // binary frames not exercised by this test
        try {
            const frame = decodeJsonFrame(data.toString());
            const waiter = waiters.shift();
            if (waiter) waiter(frame);
            else queue.push(frame);
        } catch {
            // ignore malformed frames in tests
        }
    });

    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));

    await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
    });

    return {
        ws,
        nextJsonFrame: () =>
            new Promise<JsonFrame>((resolve, reject) => {
                if (queue.length) { resolve(queue.shift()!); return; }
                const t = setTimeout(() => reject(new Error('timed out waiting for frame')), 5000);
                waiters.push((f) => { clearTimeout(t); resolve(f); });
            }),
        closed,
    };
}

describe('pilot tunnel handshake (in-process integration)', () => {
    it('completes the enroll-ack token swap and registers the tunnel', async () => {
        const enrollToken = mintEnrollToken();

        const tunnel = await openTunnel(enrollToken);

        // First frame: hello from primary.
        const hello = await tunnel.nextJsonFrame();
        expect(hello.t).toBe('hello');
        if (hello.t !== 'hello') throw new Error('narrowing');
        expect(hello.version).toBe(PROTOCOL_VERSION);
        expect(hello.role).toBe('primary');

        // Second frame: ctrl enroll_ack carrying the long-lived tunnel token.
        const ack = await tunnel.nextJsonFrame();
        expect(ack.t).toBe('ctrl');
        if (ack.t !== 'ctrl') throw new Error('narrowing');
        expect(ack.op).toBe('enroll_ack');
        expect(ack.payload?.token).toBeTypeOf('string');
        expect(ack.payload?.nodeId).toBe(nodeId);

        // The manager records the tunnel as active.
        // registerTunnel awaits bridge.start() before returning, so by the
        // time we have the enroll_ack frame the registration has landed.
        expect(PilotTunnelManager.getInstance().hasActiveTunnel(nodeId)).toBe(true);

        tunnel.ws.close();
        await tunnel.closed;
    }, 10_000);

    it('rejects a second connect with the now-consumed enrollment token', async () => {
        const enrollToken = mintEnrollToken();

        // First connect succeeds and consumes the row.
        const first = await openTunnel(enrollToken);
        await first.nextJsonFrame(); // hello
        await first.nextJsonFrame(); // enroll_ack
        first.ws.close();
        await first.closed;
        // Poll for the manager to actually drop the tunnel rather than
        // sleeping a fixed window. The chain (ws close -> bridge
        // onTunnelClose -> bridge.close -> 'closed' event -> manager
        // delete) hops through several event-loop ticks.
        await vi.waitFor(
            () => expect(PilotTunnelManager.getInstance().hasActiveTunnel(nodeId)).toBe(false),
            { timeout: 2000 },
        );

        // Second connect with the same enrollment token must fail at the
        // upgrade handshake (HTTP 401 is sent before the WS upgrade).
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/pilot/tunnel`, {
            headers: {
                Authorization: `Bearer ${enrollToken}`,
                'x-sencho-agent-version': 'integration-test/1.0',
            },
        });
        const result = await new Promise<{ kind: 'error' | 'open'; status?: number; error?: Error }>((resolve) => {
            ws.on('unexpected-response', (_req, res) => {
                resolve({ kind: 'error', status: res.statusCode });
                res.destroy();
            });
            ws.on('open', () => resolve({ kind: 'open' }));
            ws.on('error', (err) => {
                // Reject-path triggers both 'unexpected-response' and 'error'
                // ("Unexpected server response: 401"). We resolve from the
                // unexpected-response handler; only escalate here if the
                // message shape does not match the expected reject path,
                // which would indicate a different failure (ECONNREFUSED, etc.).
                if (!/Unexpected server response/.test(err.message)) {
                    resolve({ kind: 'error', error: err });
                }
            });
        });

        expect(result.kind).toBe('error');
        expect(result.status).toBe(401);
    }, 10_000);

    it('accepts a reconnect with the long-lived pilot_tunnel token', async () => {
        // First flow: enroll and capture the long-lived token.
        const enrollToken = mintEnrollToken();
        const first = await openTunnel(enrollToken);
        await first.nextJsonFrame(); // hello
        const ack = await first.nextJsonFrame();
        if (ack.t !== 'ctrl' || ack.op !== 'enroll_ack' || typeof ack.payload?.token !== 'string') {
            throw new Error('expected enroll_ack with token');
        }
        const longLivedToken = ack.payload.token;
        first.ws.close();
        await first.closed;
        await vi.waitFor(
            () => expect(PilotTunnelManager.getInstance().hasActiveTunnel(nodeId)).toBe(false),
            { timeout: 2000 },
        );

        // Reconnect with the long-lived token: no enrollment row needed,
        // the upgrade handler accepts the pilot_tunnel scope directly.
        const second = await openTunnel(longLivedToken);
        const hello = await second.nextJsonFrame();
        expect(hello.t).toBe('hello');

        // No enroll_ack on a pilot_tunnel reconnect. Wait briefly to confirm
        // no surprise frame arrives, then assert the tunnel is registered.
        const surprise = Promise.race([
            second.nextJsonFrame(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
        ]);
        await expect(surprise).resolves.toBeNull();

        expect(PilotTunnelManager.getInstance().hasActiveTunnel(nodeId)).toBe(true);

        second.ws.close();
        await second.closed;
    }, 10_000);
});
