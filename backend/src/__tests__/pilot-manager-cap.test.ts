/**
 * Tests for PilotTunnelManager system-wide cap (M3) and the metrics
 * snapshot exposed via /api/system/pilot-tunnels (M2).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { PilotTunnelManager, PilotTunnelCapacityError } from '../services/PilotTunnelManager';
import { PilotMetrics } from '../services/PilotMetrics';

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

describe('PilotTunnelCapacityError', () => {
    it('carries the limit that triggered the rejection', () => {
        const err = new PilotTunnelCapacityError(256);
        expect(err.name).toBe('PilotTunnelCapacityError');
        expect(err.limit).toBe(256);
        expect(err.message).toContain('256');
    });
});

describe('PilotMetrics counters', () => {
    beforeEach(() => {
        // Counters are process-singleton; we verify deltas rather than
        // absolute values so the test is order-independent.
    });

    it('increment then snapshot returns the bumped value', () => {
        const before = PilotMetrics.snapshot();
        PilotMetrics.increment('enroll_acks');
        const after = PilotMetrics.snapshot();
        expect(after.enroll_acks).toBe(before.enroll_acks + 1);
    });

    it('snapshot returns a copy, not the live object', () => {
        const snap = PilotMetrics.snapshot();
        const original = snap.tunnels_total;
        PilotMetrics.increment('tunnels_total');
        // The earlier snapshot must remain unchanged.
        expect(snap.tunnels_total).toBe(original);
    });
});

describe('PilotTunnelManager.getMetricsSnapshot', () => {
    it('returns the current open count and counter set', () => {
        const mgr = PilotTunnelManager.getInstance();
        const snap = mgr.getMetricsSnapshot();

        expect(snap).toHaveProperty('counters');
        expect(snap).toHaveProperty('tunnels_open');
        expect(snap).toHaveProperty('per_node');
        expect(Array.isArray(snap.per_node)).toBe(true);
        expect(snap.tunnels_open).toBe(snap.per_node.length);
    });

    it('reflects per-tunnel breakdown after registerTunnel succeeds', async () => {
        const mgr = PilotTunnelManager.getInstance();
        const before = mgr.getMetricsSnapshot();

        // Seed a real pilot-mode node so updateNode does not throw.
        const nodeId = DatabaseService.getInstance().addNode({
            name: `pilot-mgr-${Date.now()}`,
            type: 'remote',
            mode: 'pilot_agent',
            compose_dir: '/tmp/x',
            is_default: false,
            api_url: '',
            api_token: '',
        });

        const ws = makeMockTunnelWs();
        await mgr.registerTunnel(nodeId, ws as unknown as WebSocket, 'test-1.0.0');

        const after = mgr.getMetricsSnapshot();
        expect(after.tunnels_open).toBe(before.tunnels_open + 1);
        expect(after.per_node.some((p) => p.nodeId === nodeId)).toBe(true);
        expect(after.counters.tunnels_total).toBe(before.counters.tunnels_total + 1);

        // Cleanup so this test does not leak a tunnel into the next.
        mgr.closeTunnel(nodeId);
    });
});
