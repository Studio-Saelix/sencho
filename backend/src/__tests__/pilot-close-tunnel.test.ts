/**
 * Regression for PilotTunnelManager.closeTunnel lifecycle parity.
 *
 * The natural-disconnect path (bridge's `'closed'` event) writes
 * `nodes.status='offline'` and emits `tunnel-down` for pilot bridges, or
 * emits `proxy-bridge-down` for proxy bridges. Explicit `closeTunnel` calls
 * (enrollment regenerate, node deletion) must run the same cleanup so the
 * UI does not keep showing a Pilot node as Online after the operator has
 * intentionally torn its session down.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { PilotTunnelManager } from '../services/PilotTunnelManager';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => cleanupTestDb(tmpDir));

function makeMockTunnelWs(): EventEmitter & {
    sent: unknown[];
    readyState: number;
    bufferedAmount: number;
    send: (data: unknown) => void;
    ping: () => void;
    close: () => void;
} {
    const ws = new EventEmitter() as EventEmitter & {
        sent: unknown[];
        readyState: number;
        bufferedAmount: number;
        send: (data: unknown) => void;
        ping: () => void;
        close: () => void;
    };
    ws.sent = [];
    ws.readyState = WebSocket.OPEN;
    ws.bufferedAmount = 0;
    ws.send = (data: unknown) => { ws.sent.push(data); };
    ws.ping = () => { /* no-op */ };
    ws.close = () => { ws.readyState = WebSocket.CLOSED; ws.emit('close'); };
    return ws;
}

describe('PilotTunnelManager.closeTunnel lifecycle parity', () => {
    it('marks the node offline and emits tunnel-down when closing a pilot bridge', async () => {
        const mgr = PilotTunnelManager.getInstance();
        const nodeId = DatabaseService.getInstance().addNode({
            name: `pilot-close-${Date.now()}`,
            type: 'remote',
            mode: 'pilot_agent',
            compose_dir: '/tmp/x',
            is_default: false,
            api_url: '',
            api_token: '',
        });

        const ws = makeMockTunnelWs();
        await mgr.registerTunnel(nodeId, ws as unknown as WebSocket, 'test-1.0.0');

        // Confirm the registration write actually landed before we measure
        // the close-side delta; otherwise the assertion would pass for the
        // wrong reason on a fresh node that defaulted to status=null.
        expect(DatabaseService.getInstance().getNode(nodeId)?.status).toBe('online');

        let tunnelDownNodeId: number | null = null;
        const onTunnelDown = (id: number): void => { tunnelDownNodeId = id; };
        mgr.once('tunnel-down', onTunnelDown);

        mgr.closeTunnel(nodeId);

        expect(DatabaseService.getInstance().getNode(nodeId)?.status).toBe('offline');
        expect(tunnelDownNodeId).toBe(nodeId);
        expect(mgr.hasActiveTunnel(nodeId)).toBe(false);
    });

    it('does not double-emit tunnel-down when the bridge close fires after closeTunnel', async () => {
        const mgr = PilotTunnelManager.getInstance();
        const nodeId = DatabaseService.getInstance().addNode({
            name: `pilot-no-double-${Date.now()}`,
            type: 'remote',
            mode: 'pilot_agent',
            compose_dir: '/tmp/x',
            is_default: false,
            api_url: '',
            api_token: '',
        });

        const ws = makeMockTunnelWs();
        await mgr.registerTunnel(nodeId, ws as unknown as WebSocket, 'test-1.0.0');

        let emitCount = 0;
        const onTunnelDown = (id: number): void => {
            if (id === nodeId) emitCount += 1;
        };
        mgr.on('tunnel-down', onTunnelDown);

        // closeTunnel deletes the map entry, then calls bridge.close() which
        // synchronously emits 'closed' on the mock ws. The bridge's
        // `bridges.get(nodeId) === bridge` check inside its 'closed' handler
        // must short-circuit because we already deleted the entry, so this
        // produces exactly one tunnel-down emission.
        mgr.closeTunnel(nodeId);
        // Yield a tick for any deferred listeners.
        await new Promise((r) => setTimeout(r, 10));

        mgr.off('tunnel-down', onTunnelDown);
        expect(emitCount).toBe(1);
    });
});
