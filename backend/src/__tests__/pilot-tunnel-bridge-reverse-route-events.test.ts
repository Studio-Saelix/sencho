/**
 * R1-B: PilotTunnelBridge.acceptReverseLocal emits MeshService activity events
 * for the reverse-direction dispatch (peer-to-central). Reuses the existing
 * `route.resolve.ok` / `route.resolve.fail` event types and discriminates by
 * `details.direction = 'reverse'` so the Routing tab can surface peer-side
 * mesh failures alongside central-side dispatch events.
 *
 * Covers three outcomes plus one negative assertion:
 *   1. resolveContainerIp returns null  -> route.resolve.fail / container_not_found
 *   2. socket emits 'error' pre-connect -> route.resolve.fail / connect_error
 *   3. socket emits 'connect'           -> route.resolve.ok
 *   4. post-connect close/error does NOT emit a second route.resolve.fail
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import net from 'net';
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { AGENT_REVERSE_ID_BASE, encodeJsonFrame, decodeJsonFrame } from '../pilot/protocol';
import type { MeshActivityEvent } from '../services/MeshService';

type LogActivityArgs = [Omit<MeshActivityEvent, 'ts'>];

let tmpDir: string;
let PilotTunnelBridge: typeof import('../services/PilotTunnelBridge').PilotTunnelBridge;
let MeshService: typeof import('../services/MeshService').MeshService;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ PilotTunnelBridge } = await import('../services/PilotTunnelBridge'));
    ({ MeshService } = await import('../services/MeshService'));
});

afterAll(() => {
    vi.restoreAllMocks();
    cleanupTestDb(tmpDir);
});

function makeMockTunnelWs(): EventEmitter & {
    sent: unknown[];
    readyState: number;
    bufferedAmount: number;
    send: (data: unknown) => void;
    ping: () => void;
    close: () => void;
} {
    const ws = new EventEmitter() as EventEmitter & {
        sent: unknown[]; readyState: number; bufferedAmount: number;
        send: (data: unknown) => void; ping: () => void; close: () => void;
    };
    ws.sent = [];
    ws.readyState = WebSocket.OPEN;
    ws.bufferedAmount = 0;
    ws.send = (data: unknown) => { ws.sent.push(data); };
    ws.ping = () => { /* no-op */ };
    ws.close = () => { ws.readyState = WebSocket.CLOSED; ws.emit('close'); };
    return ws;
}

function findAck(ws: { sent: unknown[] }, s: number): { ok: boolean; err?: string } | undefined {
    for (const item of ws.sent) {
        if (typeof item !== 'string') continue;
        try {
            const f = decodeJsonFrame(item);
            if (f.t === 'tcp_open_ack' && f.s === s) return { ok: f.ok, err: f.err };
        } catch { /* ignore */ }
    }
    return undefined;
}

async function waitFor<T>(check: () => T | undefined): Promise<T> {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
        const v = check();
        if (v !== undefined) return v;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('timeout');
}

describe('R1-B: PilotTunnelBridge.acceptReverseLocal route events', () => {
    let logSpy: ReturnType<typeof vi.fn<(event: Omit<MeshActivityEvent, 'ts'>) => void>>;

    beforeEach(() => {
        vi.restoreAllMocks();
        logSpy = vi.fn<(event: Omit<MeshActivityEvent, 'ts'>) => void>();
        vi.spyOn(MeshService.getInstance(), 'logActivity').mockImplementation(logSpy);
    });

    it('emits route.resolve.fail with direction=reverse + reason=container_not_found when IP is unresolved', async () => {
        const mockWs = makeMockTunnelWs();
        const peerNodeId = 42;
        const bridge = new PilotTunnelBridge(peerNodeId, mockWs as unknown as WebSocket);
        await bridge.start();

        const localNodeId = (await import('../services/NodeRegistry')).NodeRegistry.getInstance().getDefaultNodeId();
        vi.spyOn(MeshService.getInstance(), 'resolveContainerIp').mockResolvedValue(null);

        const s = AGENT_REVERSE_ID_BASE + 11;
        mockWs.emit('message', encodeJsonFrame({
            t: 'tcp_open_reverse', s,
            targetNodeId: localNodeId, stack: 'missing', service: 'svc', port: 80,
        }), false);

        const ack = await waitFor(() => findAck(mockWs, s));
        expect(ack.ok).toBe(false);

        const failCall = logSpy.mock.calls.find(
            (c: LogActivityArgs) => c[0].type === 'route.resolve.fail',
        );
        expect(failCall).toBeDefined();
        const payload = failCall![0] as {
            source: string;
            level: string;
            type: string;
            nodeId?: number;
            details?: Record<string, unknown>;
        };
        expect(payload.source).toBe('mesh');
        expect(payload.level).toBe('error');
        expect(payload.type).toBe('route.resolve.fail');
        expect(payload.nodeId).toBe(peerNodeId);
        expect(payload.details).toMatchObject({
            direction: 'reverse',
            reason: 'container_not_found',
            targetStack: 'missing',
            targetService: 'svc',
            targetPort: 80,
        });

        bridge.close();
    });

    it('emits route.resolve.fail with direction=reverse + reason=connect_error on socket pre-connect error', async () => {
        const mockWs = makeMockTunnelWs();
        const peerNodeId = 43;
        const bridge = new PilotTunnelBridge(peerNodeId, mockWs as unknown as WebSocket);
        await bridge.start();

        const localNodeId = (await import('../services/NodeRegistry')).NodeRegistry.getInstance().getDefaultNodeId();
        // Resolve to localhost on a port nothing is listening on so the dial
        // produces a synchronous ECONNREFUSED via the OS.
        vi.spyOn(MeshService.getInstance(), 'resolveContainerIp').mockResolvedValue('127.0.0.1');

        // Pick a port we know is closed by binding and immediately releasing.
        const probe = net.createServer();
        await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
        const addr = probe.address();
        if (!addr || typeof addr === 'string') throw new Error('no address');
        const closedPort = addr.port;
        await new Promise<void>((resolve) => probe.close(() => resolve()));

        const s = AGENT_REVERSE_ID_BASE + 12;
        mockWs.emit('message', encodeJsonFrame({
            t: 'tcp_open_reverse', s,
            targetNodeId: localNodeId, stack: 'real', service: 'svc', port: closedPort,
        }), false);

        const ack = await waitFor(() => findAck(mockWs, s));
        expect(ack.ok).toBe(false);
        expect(ack.err).toBe('unreachable');

        const failCall = logSpy.mock.calls.find(
            (c: LogActivityArgs) => c[0].type === 'route.resolve.fail',
        );
        expect(failCall).toBeDefined();
        const payload = failCall![0] as {
            type: string;
            nodeId?: number;
            details?: Record<string, unknown>;
        };
        expect(payload.type).toBe('route.resolve.fail');
        expect(payload.nodeId).toBe(peerNodeId);
        expect(payload.details).toMatchObject({
            direction: 'reverse',
            reason: 'connect_error',
            targetStack: 'real',
            targetService: 'svc',
            targetPort: closedPort,
        });

        bridge.close();
    });

    it('emits route.resolve.ok with direction=reverse on connect ack', async () => {
        const mockWs = makeMockTunnelWs();
        const peerNodeId = 44;
        const bridge = new PilotTunnelBridge(peerNodeId, mockWs as unknown as WebSocket);
        await bridge.start();

        // Real local server so the dial succeeds and 'connect' fires.
        const upstream = net.createServer((socket) => {
            socket.write('hello-upstream');
        });
        await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
        const addr = upstream.address();
        if (!addr || typeof addr === 'string') throw new Error('no address');
        const upstreamPort = addr.port;

        const localNodeId = (await import('../services/NodeRegistry')).NodeRegistry.getInstance().getDefaultNodeId();
        vi.spyOn(MeshService.getInstance(), 'resolveContainerIp').mockResolvedValue('127.0.0.1');

        const s = AGENT_REVERSE_ID_BASE + 13;
        mockWs.emit('message', encodeJsonFrame({
            t: 'tcp_open_reverse', s,
            targetNodeId: localNodeId, stack: 'real', service: 'svc', port: upstreamPort,
        }), false);

        const ack = await waitFor(() => findAck(mockWs, s));
        expect(ack.ok).toBe(true);

        // Wait for the ok event to land (logActivity is sync but the connect
        // callback is async relative to message handling).
        await waitFor(() => logSpy.mock.calls.find(
            (c: LogActivityArgs) => c[0].type === 'route.resolve.ok',
        ));

        const okCall = logSpy.mock.calls.find(
            (c: LogActivityArgs) => c[0].type === 'route.resolve.ok',
        );
        expect(okCall).toBeDefined();
        const payload = okCall![0] as {
            source: string;
            level: string;
            type: string;
            nodeId?: number;
            details?: Record<string, unknown>;
        };
        expect(payload.source).toBe('mesh');
        expect(payload.level).toBe('info');
        expect(payload.type).toBe('route.resolve.ok');
        expect(payload.nodeId).toBe(peerNodeId);
        expect(payload.details).toMatchObject({
            direction: 'reverse',
            targetStack: 'real',
            targetService: 'svc',
            targetPort: upstreamPort,
        });

        upstream.close();
        bridge.close();
    });

    it('does NOT emit route.resolve.fail when a connected socket closes post-handshake', async () => {
        const mockWs = makeMockTunnelWs();
        const peerNodeId = 45;
        const bridge = new PilotTunnelBridge(peerNodeId, mockWs as unknown as WebSocket);
        await bridge.start();

        // Real local server. Have it close the connection immediately after
        // accept so the bridge socket sees 'close' (and possibly 'error') on
        // an already-connected socket.
        const upstream = net.createServer((socket) => {
            socket.end();
        });
        await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
        const addr = upstream.address();
        if (!addr || typeof addr === 'string') throw new Error('no address');
        const upstreamPort = addr.port;

        const localNodeId = (await import('../services/NodeRegistry')).NodeRegistry.getInstance().getDefaultNodeId();
        vi.spyOn(MeshService.getInstance(), 'resolveContainerIp').mockResolvedValue('127.0.0.1');

        const s = AGENT_REVERSE_ID_BASE + 14;
        mockWs.emit('message', encodeJsonFrame({
            t: 'tcp_open_reverse', s,
            targetNodeId: localNodeId, stack: 'real', service: 'svc', port: upstreamPort,
        }), false);

        // Wait for connect (the success ack confirms onPreConnectError was removed).
        const ack = await waitFor(() => findAck(mockWs, s));
        expect(ack.ok).toBe(true);

        // Wait for the success event to confirm the ok path fired.
        await waitFor(() => logSpy.mock.calls.find(
            (c: LogActivityArgs) => c[0].type === 'route.resolve.ok',
        ));

        // Give the post-connect close a chance to fire teardown handlers.
        await new Promise((r) => setTimeout(r, 100));

        const failCalls = logSpy.mock.calls.filter(
            (c: LogActivityArgs) => c[0].type === 'route.resolve.fail',
        );
        expect(failCalls).toHaveLength(0);

        upstream.close();
        bridge.close();
    });
});
