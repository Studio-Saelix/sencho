/**
 * Phase B: PilotTunnelBridge handles `tcp_open_reverse` from the agent.
 * Two paths:
 *   - target is the central's local node: dial via Dockerode container IP
 *     and splice bytes between the resulting `net.Socket` and the tunnel.
 *   - target is another pilot: open a forward `TcpStream` on the target
 *     pilot's bridge and relay.
 *
 * The local-dial path is the common case for small fleets. This file
 * exercises the validation gate (agent-id-range, stream cap) and the
 * local-dial outcome by intercepting `MeshService.resolveContainerIp`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import net from 'net';
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import {
    AGENT_REVERSE_ID_BASE,
    decodeJsonFrame,
    encodeJsonFrame,
} from '../pilot/protocol';

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

describe('PilotTunnelBridge handles tcp_open_reverse (Phase B)', () => {
    it('rejects frames whose s is below the agent-reverse range', async () => {
        const mockWs = makeMockTunnelWs();
        const bridge = new PilotTunnelBridge(1, mockWs as unknown as WebSocket);
        await bridge.start();

        // Drive the tunnel-message handler with a low-range id; the
        // validation gate must reject and emit a tcp_open_ack {ok: false}.
        mockWs.emit('message', encodeJsonFrame({
            t: 'tcp_open_reverse', s: 5,
            targetNodeId: 1, stack: 's', service: 'svc', port: 80,
        }), false);

        const ack = await waitFor(() => findAck(mockWs, 5));
        expect(ack.ok).toBe(false);
        expect(ack.err).toBe('agent_error');

        bridge.close();
    });

    it('local target with no Dockerode resolution returns ok:false err:no_target', async () => {
        const mockWs = makeMockTunnelWs();
        const bridge = new PilotTunnelBridge(1, mockWs as unknown as WebSocket);
        await bridge.start();

        // The default node id from the test DB. Force resolveContainerIp to
        // return null to simulate a stack that does not exist locally.
        const localNodeId = (await import('../services/NodeRegistry')).NodeRegistry.getInstance().getDefaultNodeId();
        const spy = vi.spyOn(MeshService.getInstance(), 'resolveContainerIp').mockResolvedValue(null);

        const s = AGENT_REVERSE_ID_BASE + 1;
        mockWs.emit('message', encodeJsonFrame({
            t: 'tcp_open_reverse', s,
            targetNodeId: localNodeId, stack: 'missing', service: 'svc', port: 80,
        }), false);

        const ack = await waitFor(() => findAck(mockWs, s));
        expect(ack.ok).toBe(false);
        expect(ack.err).toBe('no_target');
        expect(spy).toHaveBeenCalledTimes(1);

        bridge.close();
        vi.restoreAllMocks();
    });

    it('local target with a working dial sends ok:true and registers a reverse stream', async () => {
        const mockWs = makeMockTunnelWs();
        const bridge = new PilotTunnelBridge(1, mockWs as unknown as WebSocket);
        await bridge.start();

        // Spin up a real local server the bridge will dial as the target.
        const upstream = net.createServer((socket) => {
            socket.write('hello-upstream');
        });
        await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
        const addr = upstream.address();
        if (!addr || typeof addr === 'string') throw new Error('no address');
        const upstreamPort = addr.port;

        const localNodeId = (await import('../services/NodeRegistry')).NodeRegistry.getInstance().getDefaultNodeId();
        vi.spyOn(MeshService.getInstance(), 'resolveContainerIp').mockResolvedValue('127.0.0.1');

        const s = AGENT_REVERSE_ID_BASE + 2;
        mockWs.emit('message', encodeJsonFrame({
            t: 'tcp_open_reverse', s,
            targetNodeId: localNodeId, stack: 'real', service: 'svc', port: upstreamPort,
        }), false);

        const ack = await waitFor(() => findAck(mockWs, s));
        expect(ack.ok).toBe(true);

        // Stream is registered on the bridge.
        const streams = (bridge as unknown as { streams: Map<number, { kind: string }> }).streams;
        const state = streams.get(s);
        expect(state?.kind).toBe('reverse_local');

        upstream.close();
        bridge.close();
        vi.restoreAllMocks();
    });
});
