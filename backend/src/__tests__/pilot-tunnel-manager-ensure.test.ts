/**
 * PilotTunnelManager.ensureBridge: dispatcher used by MeshService to
 * resolve a mesh-capable bridge for any nodeId without caring whether the
 * node runs in pilot-agent mode (long-lived tunnel) or Distributed API
 * mode (Phase C on-demand proxy tunnel).
 *
 * Covers:
 *   - returns the existing bridge when one is registered.
 *   - delegates to MeshProxyTunnelDialer.ensureBridge when none exists.
 *   - registerProxyBridge refuses to shadow a pre-existing bridge.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let PilotTunnelManager: typeof import('../services/PilotTunnelManager').PilotTunnelManager;
let MeshProxyTunnelDialer: typeof import('../services/MeshProxyTunnelDialer').MeshProxyTunnelDialer;
let PilotTunnelBridge: typeof import('../services/PilotTunnelBridge').PilotTunnelBridge;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ PilotTunnelManager } = await import('../services/PilotTunnelManager'));
    ({ MeshProxyTunnelDialer } = await import('../services/MeshProxyTunnelDialer'));
    ({ PilotTunnelBridge } = await import('../services/PilotTunnelBridge'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    DatabaseService.getInstance().getDb().prepare("DELETE FROM nodes WHERE name LIKE 'pilot-mgr-test-%'").run();
    MeshProxyTunnelDialer.resetForTest(0); // idle-close disabled; clears any prior bridges
    // Drop any bridges held over from a prior test in the same file.
    type BridgeMap = Map<number, unknown>;
    const bridges = (PilotTunnelManager.getInstance() as unknown as { bridges: BridgeMap }).bridges;
    bridges.clear();
});

function makeFakeBridge(nodeId: number): { bridge: import('../services/PilotTunnelBridge').PilotTunnelBridge; close: () => void } {
    // Bridges hold a WS reference but only the surface we touch in this
    // test (openTcpStream, getBufferedAmount, close emission) ever runs.
    const mockWs = {
        readyState: 1,
        bufferedAmount: 0,
        on() { return this; },
        off() { return this; },
        once() { return this; },
        send() { /* ignore */ },
        close() { /* ignore */ },
    } as unknown as import('ws').WebSocket;
    const bridge = new PilotTunnelBridge(nodeId, mockWs);
    return { bridge, close: () => bridge.close(1000, 'test cleanup') };
}

describe('PilotTunnelManager.ensureBridge', () => {
    it('returns the existing bridge when one is registered for the node', async () => {
        const mgr = PilotTunnelManager.getInstance();
        const { bridge, close } = makeFakeBridge(101);
        try {
            mgr.registerProxyBridge(101, bridge);
            const handle = await mgr.ensureBridge(101);
            expect(handle).toBe(bridge);
        } finally {
            close();
        }
    });

    it('delegates to MeshProxyTunnelDialer when no bridge is registered', async () => {
        const mgr = PilotTunnelManager.getInstance();
        // No bridge, no node configured -> dialer returns null and caches no_target.
        const handle = await mgr.ensureBridge(404);
        expect(handle).toBeNull();
        const cached = MeshProxyTunnelDialer.getInstance().getRecentFailure(404);
        expect(cached?.code).toBe('no_target');
    });

    it('registerProxyBridge refuses to shadow a node that already has a bridge', () => {
        const mgr = PilotTunnelManager.getInstance();
        const { bridge: bridgeA, close: closeA } = makeFakeBridge(202);
        const { bridge: bridgeB, close: closeB } = makeFakeBridge(202);
        try {
            mgr.registerProxyBridge(202, bridgeA);
            expect(() => mgr.registerProxyBridge(202, bridgeB)).toThrow(/already registered/);
            expect(mgr.getBridge(202)).toBe(bridgeA);
        } finally {
            closeA();
            closeB();
        }
    });

    it('registerProxyBridge emits proxy-bridge-up and proxy-bridge-down on lifecycle', async () => {
        const mgr = PilotTunnelManager.getInstance();
        const up: number[] = [];
        const down: number[] = [];
        mgr.on('proxy-bridge-up', (id: number) => up.push(id));
        mgr.on('proxy-bridge-down', (id: number) => down.push(id));

        const { bridge } = makeFakeBridge(303);
        mgr.registerProxyBridge(303, bridge);
        expect(up).toContain(303);

        bridge.close(1000, 'test teardown');
        await new Promise((resolve) => setImmediate(resolve));
        expect(down).toContain(303);

        mgr.off('proxy-bridge-up', () => {});
        mgr.off('proxy-bridge-down', () => {});
    });
});
