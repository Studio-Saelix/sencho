/**
 * Pilot-mode regression invariant: a pilot-agent tunnel always wins over a
 * peer-initiated proxy-mode bridge for the same nodeId.
 *
 * The two registration paths share the `PilotTunnelManager.bridges` map.
 * Without the `bridgeKinds` index, a peer-initiated dial-back could quietly
 * replace a live pilot tunnel and break the agent's reverse-stream relay.
 * `replaceOrRegisterProxyBridge` is the single point that has to refuse the
 * replacement; this test locks that contract in.
 *
 * Mirrors the `injectBridgeForTest` pattern used elsewhere in the suite so
 * we exercise the manager invariant without owning a real WebSocket.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PilotTunnelManager } from '../services/PilotTunnelManager';
import type { PilotTunnelBridge } from '../services/PilotTunnelBridge';

function makeFakeBridge(): EventEmitter & {
    close: ReturnType<typeof vi.fn>;
    getActiveStreamCount: () => number;
} {
    const ee = new EventEmitter() as EventEmitter & {
        close: ReturnType<typeof vi.fn>;
        getActiveStreamCount: () => number;
    };
    ee.close = vi.fn();
    ee.getActiveStreamCount = () => 0;
    return ee;
}

describe('Pilot-mode regression: pilot tunnel wins over peer-initiated proxy bridge', () => {
    beforeEach(() => {
        PilotTunnelManager.resetForTest();
    });

    it('refuses replaceOrRegisterProxyBridge when a pilot tunnel exists for the same nodeId', () => {
        const mgr = PilotTunnelManager.getInstance();
        const pilot = makeFakeBridge();
        const proxy = makeFakeBridge();
        mgr.injectBridgeForTest(7, pilot as unknown as PilotTunnelBridge, 'pilot');

        expect(() => mgr.replaceOrRegisterProxyBridge(7, proxy as unknown as PilotTunnelBridge))
            .toThrow(/pilot tunnel/);

        // Pilot bridge is still the resident bridge for nodeId 7.
        expect(mgr.getBridge(7)).toBe(pilot);
        // The pilot bridge must not be closed by the rejected replacement.
        expect(pilot.close).not.toHaveBeenCalled();
    });

    it('allows replaceOrRegisterProxyBridge to swap one proxy bridge for another', () => {
        const mgr = PilotTunnelManager.getInstance();
        const oldProxy = makeFakeBridge();
        const newProxy = makeFakeBridge();
        mgr.injectBridgeForTest(9, oldProxy as unknown as PilotTunnelBridge, 'proxy');

        mgr.replaceOrRegisterProxyBridge(9, newProxy as unknown as PilotTunnelBridge);

        // The new dial is the source of truth; old proxy is closed.
        expect(oldProxy.close).toHaveBeenCalledOnce();
        expect(mgr.getBridge(9)).toBe(newProxy);
    });

    it('replaceOrRegisterProxyBridge on an empty slot just registers (no refuse, no close)', () => {
        const mgr = PilotTunnelManager.getInstance();
        const proxy = makeFakeBridge();

        mgr.replaceOrRegisterProxyBridge(11, proxy as unknown as PilotTunnelBridge);

        expect(mgr.getBridge(11)).toBe(proxy);
        expect(proxy.close).not.toHaveBeenCalled();
    });
});
