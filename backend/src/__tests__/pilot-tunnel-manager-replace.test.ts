/**
 * PilotTunnelManager.replaceOrRegisterProxyBridge: peer-initiated proxy
 * bridges (Phase R1) need to be able to supersede a previous proxy bridge
 * for the same nodeId, but must never shadow a live pilot tunnel (which
 * always wins the bridge slot).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PilotTunnelManager } from '../services/PilotTunnelManager';
import type { PilotTunnelBridge } from '../services/PilotTunnelBridge';

type FakeBridge = PilotTunnelBridge & {
    close: ReturnType<typeof vi.fn<(code?: number, reason?: string) => void>>;
    getActiveStreamCount: ReturnType<typeof vi.fn<() => number>>;
};

function makeFakeBridge(): FakeBridge {
    const ee = new EventEmitter() as unknown as FakeBridge;
    ee.close = vi.fn<(code?: number, reason?: string) => void>();
    ee.getActiveStreamCount = vi.fn<() => number>().mockReturnValue(0);
    return ee;
}

describe('PilotTunnelManager.replaceOrRegisterProxyBridge', () => {
    beforeEach(() => PilotTunnelManager.resetForTest?.());

    it('registers when no existing bridge', () => {
        const mgr = PilotTunnelManager.getInstance();
        const bridge = makeFakeBridge();
        mgr.replaceOrRegisterProxyBridge(42, bridge);
        expect(mgr.getBridge(42)).toBe(bridge);
    });

    it('replaces when existing bridge is a proxy bridge (closes the old one)', () => {
        const mgr = PilotTunnelManager.getInstance();
        const oldBridge = makeFakeBridge();
        const newBridge = makeFakeBridge();
        mgr.injectBridgeForTest(42, oldBridge, 'proxy');
        mgr.replaceOrRegisterProxyBridge(42, newBridge);
        expect(oldBridge.close).toHaveBeenCalledWith(1000, 'replaced-by-newer-proxy');
        expect(mgr.getBridge(42)).toBe(newBridge);
    });

    it('throws when existing bridge is a pilot tunnel (preserves the pilot tunnel)', () => {
        const mgr = PilotTunnelManager.getInstance();
        const pilotBridge = makeFakeBridge();
        const proxyBridge = makeFakeBridge();
        mgr.injectBridgeForTest(42, pilotBridge, 'pilot');
        expect(() => mgr.replaceOrRegisterProxyBridge(42, proxyBridge))
            .toThrow(/pilot tunnel.*proxy bridge refused/);
        expect(mgr.getBridge(42)).toBe(pilotBridge);
        expect(pilotBridge.close).not.toHaveBeenCalled();
    });
});
