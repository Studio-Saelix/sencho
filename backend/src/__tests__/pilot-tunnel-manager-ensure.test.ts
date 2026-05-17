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
    // Both maps must clear together: every production write path keeps
    // `bridges` and `bridgeKinds` in lockstep, and a stale kind entry
    // would mislead the kind-discriminator in registerProxyBridge.
    type BridgeMap = Map<number, unknown>;
    const inst = PilotTunnelManager.getInstance() as unknown as { bridges: BridgeMap; bridgeKinds: BridgeMap };
    inst.bridges.clear();
    inst.bridgeKinds.clear();
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

    it('registerProxyBridge rejection names the existing bridge kind (proxy vs pilot)', () => {
        const mgr = PilotTunnelManager.getInstance();

        // Existing peer-initiated proxy bridge: rejection must say "proxy bridge",
        // not "pilot tunnel". Locks in the F-R-2 discriminator.
        const { bridge: existingProxy, close: closeProxy } = makeFakeBridge(404);
        const { bridge: rejected, close: closeRejected } = makeFakeBridge(404);
        try {
            mgr.registerProxyBridge(404, existingProxy);
            expect(() => mgr.registerProxyBridge(404, rejected))
                .toThrow(/proxy bridge already registered for node 404/);
            expect(mgr.getBridge(404)).toBe(existingProxy);
        } finally {
            closeProxy();
            closeRejected();
        }

        // Existing pilot-agent tunnel: rejection keeps the original "pilot tunnel"
        // wording so log filters and the sister regex in pilot-tunnel-manager-replace
        // still match the pilot case.
        const { bridge: pilot, close: closePilot } = makeFakeBridge(505);
        const { bridge: rejectedProxy, close: closeRejectedProxy } = makeFakeBridge(505);
        try {
            mgr.injectBridgeForTest(505, pilot, 'pilot');
            expect(() => mgr.registerProxyBridge(505, rejectedProxy))
                .toThrow(/pilot tunnel already registered for node 505/);
            expect(mgr.getBridge(505)).toBe(pilot);
        } finally {
            closePilot();
            closeRejectedProxy();
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
