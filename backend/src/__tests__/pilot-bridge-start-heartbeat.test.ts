/**
 * PilotTunnelBridge.start() lifecycle: it awaits the loopback listener before
 * installing the heartbeat, so the WebSocket can die inside that window. When
 * it does, close() has already run and there is no heartbeat handle left to
 * stop, so start() must not install one: a heartbeat nobody can stop ticks
 * for the life of the process.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { PilotTunnelBridge } from '../services/PilotTunnelBridge';

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

const bridges: PilotTunnelBridge[] = [];

afterEach(() => {
    while (bridges.length > 0) {
        try { bridges.pop()?.close(); } catch { /* ignore */ }
    }
});

describe('PilotTunnelBridge.start heartbeat lifecycle', () => {
    it('installs the heartbeat on a normal start', async () => {
        const bridge = new PilotTunnelBridge(1, makeMockTunnelWs() as unknown as WebSocket);
        bridges.push(bridge);
        await bridge.start();
        expect((bridge as unknown as { stopHeartbeat?: () => void }).stopHeartbeat).toBeDefined();
    });

    it('does not install a heartbeat when the tunnel closed before start() finished', async () => {
        const bridge = new PilotTunnelBridge(1, makeMockTunnelWs() as unknown as WebSocket);
        bridges.push(bridge);
        // The WebSocket can die while start() is still awaiting the loopback
        // bind, so the heartbeat it installs afterwards has no owner left to
        // stop it. Closing first reproduces that post-condition deterministically
        // (an interleaved close leaves start()'s loopback promise pending, which
        // is a separate pre-existing quirk).
        bridge.close();
        await bridge.start();

        expect(bridge.isOpen()).toBe(false);
        expect((bridge as unknown as { stopHeartbeat?: () => void }).stopHeartbeat).toBeUndefined();
    });
});
