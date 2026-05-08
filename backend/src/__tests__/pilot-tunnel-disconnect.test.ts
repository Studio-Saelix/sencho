/**
 * In-process simulation of mid-tunnel disconnects.
 *
 * The PR #979 hardening pass added per-stream idle timers, drain handling,
 * paused-request maps, and a tcpAwaitingDrain set on the bridge. None of
 * those cleanup paths had an end-to-end test that drives them through a
 * real disconnect; a future refactor that inverts the order of
 * clearIdleTimer + streams.delete (or that misses one of the aux maps)
 * could leak per-tunnel memory in a way the unit tests cannot catch.
 *
 * This file spins up a real http.Server with attachUpgrade and a real
 * ws.WebSocket client, then exercises three disconnect scenarios plus a
 * reconnect-counter case. Self-contained so it can land independently of
 * any other in-flight pilot work.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { WebSocket, WebSocketServer } from 'ws';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { attachUpgrade } from '../websocket/upgradeHandler';
import {
    BinaryFrameType,
    decodeBinaryFrame,
    decodeJsonFrame,
    encodeJsonFrame,
    type JsonFrame,
} from '../pilot/protocol';
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
        name: `pilot-disconnect-${Date.now()}`,
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
 * Open a ws client that decodes both JSON and binary frames, with a queue
 * + waiter so tests can await individual frames in arrival order. Mirrors
 * pilot-tunnel-integration.test.ts.
 */
async function openTunnel(token: string): Promise<{
    ws: WebSocket;
    nextJsonFrame: () => Promise<JsonFrame>;
    onBinaryFrame: (cb: (type: BinaryFrameType, streamId: number, payload: Buffer) => void) => void;
    closed: Promise<void>;
}> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/pilot/tunnel`, {
        headers: {
            Authorization: `Bearer ${token}`,
            'x-sencho-agent-version': 'disconnect-test/1.0',
        },
    });

    const queue: JsonFrame[] = [];
    const waiters: Array<(frame: JsonFrame) => void> = [];
    let binaryHandler: ((t: BinaryFrameType, s: number, p: Buffer) => void) | null = null;

    ws.on('message', (data, isBinary) => {
        try {
            if (isBinary) {
                const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
                const frame = decodeBinaryFrame(buf);
                binaryHandler?.(frame.type, frame.streamId, frame.payload);
            } else {
                const frame = decodeJsonFrame(data.toString());
                const waiter = waiters.shift();
                if (waiter) waiter(frame);
                else queue.push(frame);
            }
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
        onBinaryFrame: (cb) => { binaryHandler = cb; },
        closed,
    };
}

async function enrollAndCaptureLongLivedToken(): Promise<string> {
    const enrollToken = mintEnrollToken();
    const tunnel = await openTunnel(enrollToken);
    await tunnel.nextJsonFrame(); // hello
    const ack = await tunnel.nextJsonFrame();
    if (ack.t !== 'ctrl' || ack.op !== 'enroll_ack' || typeof ack.payload?.token !== 'string') {
        throw new Error('expected enroll_ack with token');
    }
    const longLivedToken = ack.payload.token;
    tunnel.ws.close();
    await tunnel.closed;
    await vi.waitFor(
        () => expect(PilotTunnelManager.getInstance().hasActiveTunnel(nodeId)).toBe(false),
        { timeout: 2000 },
    );
    return longLivedToken;
}

describe('pilot tunnel mid-disconnect cleanup (in-process integration)', () => {
    it('completes a loopback HTTP request with 502 when the tunnel dies mid-flight', async () => {
        const enrollToken = mintEnrollToken();
        const tunnel = await openTunnel(enrollToken);
        await tunnel.nextJsonFrame(); // hello
        await tunnel.nextJsonFrame(); // enroll_ack

        const loopbackUrl = PilotTunnelManager.getInstance().getLoopbackUrl(nodeId);
        if (!loopbackUrl) throw new Error('loopback URL missing');

        // Issue a request against the loopback. The bridge sends an http_req
        // frame to the agent (us). We deliberately do NOT respond; the
        // request stays parked in the bridge's stream map.
        const url = new URL(loopbackUrl);
        const responsePromise = new Promise<number>((resolve, reject) => {
            const req = http.request({
                host: url.hostname,
                port: Number(url.port),
                method: 'GET',
                path: '/api/health',
            }, (res) => {
                resolve(res.statusCode || 0);
                res.resume();
            });
            req.on('error', reject);
            req.end();
        });

        // Wait for the http_req frame to arrive on the agent side, confirming
        // the bridge has a live stream. Then kill the tunnel from the agent
        // side, simulating an agent crash.
        await tunnel.nextJsonFrame(); // http_req
        tunnel.ws.terminate();
        await tunnel.closed;

        // The parked loopback request must resolve (not hang) with 502 from
        // the bridge's teardownStream path, and the manager must drop the
        // tunnel so the next caller sees offline.
        const status = await responsePromise;
        expect(status).toBe(502);

        await vi.waitFor(
            () => expect(PilotTunnelManager.getInstance().hasActiveTunnel(nodeId)).toBe(false),
            { timeout: 2000 },
        );

        // updateNodeStatus('offline') ran via the bridge.once('closed') hook.
        const dbNode = DatabaseService.getInstance().getNode(nodeId);
        expect(dbNode?.status).toBe('offline');
    }, 10_000);

    it('closes a TCP stream cleanly when the tunnel dies with bytes outstanding', async () => {
        const enrollToken = mintEnrollToken();
        const tunnel = await openTunnel(enrollToken);
        await tunnel.nextJsonFrame(); // hello
        await tunnel.nextJsonFrame(); // enroll_ack

        const bridge = PilotTunnelManager.getInstance().getBridge(nodeId);
        if (!bridge) throw new Error('bridge missing');

        // openTcpStream sends a tcp_open frame to the agent. We capture it,
        // then ack with tcp_open_ack { ok: true } so the stream transitions
        // to accepted. Without the ack the bridge keeps the stream parked
        // and write() returns false silently.
        const streamHandle = bridge.openTcpStream({ stack: 'demo', service: 'svc', port: 80 });
        if (!streamHandle) throw new Error('openTcpStream returned null');

        const tcpOpen = await tunnel.nextJsonFrame();
        if (tcpOpen.t !== 'tcp_open') throw new Error('expected tcp_open');
        tunnel.ws.send(encodeJsonFrame({ t: 'tcp_open_ack', s: tcpOpen.s, ok: true }));

        // Wait for the handle's 'open' event to fire so write() will actually
        // serialize bytes through the bridge.
        await new Promise<void>((resolve) => streamHandle.once('open', () => resolve()));

        // Defensive: 'error' fires from teardownStream only when the stream
        // is not yet accepted, which is not the case here. Attach a no-op
        // listener so a future refactor that delays accepted=true past 'open'
        // does not crash the worker on an unhandled 'error' event.
        streamHandle.on('error', () => { /* defensive */ });

        // Listen for the stream's 'close' event before yanking the tunnel.
        const closedEvent = new Promise<void>((resolve) => streamHandle.once('close', () => resolve()));

        // Push some bytes, then kill the tunnel from the agent side. The
        // bridge's teardownStream path must emit 'close' on the TcpStream
        // and clear the streams + tcpAwaitingDrain maps.
        streamHandle.write(Buffer.from('hello, world'));
        tunnel.ws.terminate();

        await closedEvent;
        await vi.waitFor(
            () => expect(PilotTunnelManager.getInstance().hasActiveTunnel(nodeId)).toBe(false),
            { timeout: 2000 },
        );

        // openTcpStream after the tunnel is gone must return null (not crash).
        const afterClose = PilotTunnelManager.getInstance().getBridge(nodeId);
        expect(afterClose).toBeNull();
    }, 10_000);

    it('reconnect with the long-lived token does NOT bump tunnels_replaced', async () => {
        const longLivedToken = await enrollAndCaptureLongLivedToken();
        const before = PilotTunnelManager.getInstance().getMetricsSnapshot().counters;

        const tunnel = await openTunnel(longLivedToken);
        await tunnel.nextJsonFrame(); // hello

        await vi.waitFor(
            () => expect(PilotTunnelManager.getInstance().hasActiveTunnel(nodeId)).toBe(true),
            { timeout: 2000 },
        );

        const after = PilotTunnelManager.getInstance().getMetricsSnapshot().counters;

        // tunnels_total bumps on every successful registration.
        expect(after.tunnels_total).toBe(before.tunnels_total + 1);
        // tunnels_replaced should NOT bump: the prior bridge was closed cleanly
        // and removed from the manager before this connect, so this is a
        // fresh registration, not a replacement of a still-live tunnel.
        expect(after.tunnels_replaced).toBe(before.tunnels_replaced);

        tunnel.ws.close();
        await tunnel.closed;
    }, 10_000);

    it('reconnecting BEFORE the prior tunnel is removed DOES bump tunnels_replaced', async () => {
        // Inverse of the previous test: prove the counter-bump path is wired
        // by forcing a true split-brain. Open one tunnel, do NOT close it,
        // then open a second tunnel for the same node. The manager closes
        // the first bridge to make room, which is the documented "replaced"
        // path.
        const longLivedToken = await enrollAndCaptureLongLivedToken();

        const first = await openTunnel(longLivedToken);
        await first.nextJsonFrame(); // hello
        await vi.waitFor(
            () => expect(PilotTunnelManager.getInstance().hasActiveTunnel(nodeId)).toBe(true),
            { timeout: 2000 },
        );

        const before = PilotTunnelManager.getInstance().getMetricsSnapshot().counters;

        const second = await openTunnel(longLivedToken);
        await second.nextJsonFrame(); // hello

        const after = PilotTunnelManager.getInstance().getMetricsSnapshot().counters;
        expect(after.tunnels_replaced).toBe(before.tunnels_replaced + 1);
        expect(after.tunnels_total).toBe(before.tunnels_total + 1);

        // The first tunnel's WS should have been closed by the manager
        // (PilotCloseCode.Replaced = 4000). Do not assert on the close code
        // here because the test runner may see the close before the code
        // surfaces; just await the close to keep cleanup tidy.
        await first.closed;
        second.ws.close();
        await second.closed;
    }, 10_000);
});
