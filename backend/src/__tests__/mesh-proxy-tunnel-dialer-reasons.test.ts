import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { MeshProxyTunnelDialer } from '../services/MeshProxyTunnelDialer';

type Reason = 'idle' | 'remote_closed' | 'network_error' | 'protocol_error' | 'auth_failed';

describe('MeshProxyTunnelDialer reason-tagged proxy-bridge-down', () => {
    beforeEach(() => MeshProxyTunnelDialer.resetForTest());

    it('emits reason="idle" when runIdleCheck closes a bridge', () => {
        const dialer = MeshProxyTunnelDialer.resetForTest(1);
        const reasons: Reason[] = [];
        dialer.on('proxy-bridge-down', (_id: number, reason: Reason) => reasons.push(reason));
        const fakeBridge = new EventEmitter() as unknown as { close: ReturnType<typeof vi.fn>; getActiveStreamCount: () => number };
        fakeBridge.close = vi.fn();
        fakeBridge.getActiveStreamCount = () => 0;
        (dialer as unknown as { bridges: Map<number, unknown>; idleSince: Map<number, number> }).bridges.set(7, fakeBridge);
        (dialer as unknown as { bridges: Map<number, unknown>; idleSince: Map<number, number> }).idleSince.set(7, Date.now() - 1000);
        (dialer as unknown as { runIdleCheck: () => void }).runIdleCheck();
        expect(reasons).toEqual(['idle']);
    });

    it('emits reason="remote_closed" when bridge fires "closed" with code 1000', () => {
        const dialer = MeshProxyTunnelDialer.resetForTest();
        const reasons: Reason[] = [];
        dialer.on('proxy-bridge-down', (_id: number, reason: Reason) => reasons.push(reason));
        const fakeBridge = new EventEmitter() as unknown as EventEmitter & { close: ReturnType<typeof vi.fn> };
        fakeBridge.close = vi.fn();
        (dialer as unknown as { bridges: Map<number, unknown> }).bridges.set(7, fakeBridge);
        // Attach the close listener via the dialer's private helper, mirroring
        // what `dial()` does when a real bridge is registered. This keeps the
        // test focused on the close-code classification + tearDownBridge path
        // without spinning up a real WebSocket.
        (dialer as unknown as { attachBridgeCloseListener: (id: number, b: EventEmitter) => void })
            .attachBridgeCloseListener(7, fakeBridge as unknown as EventEmitter);
        (fakeBridge as unknown as EventEmitter).emit('closed', { code: 1000, reason: 'normal' });
        expect(reasons).toEqual(['remote_closed']);
    });
});

describe('MeshProxyTunnelDialer reactive redial filter', () => {
    beforeEach(() => MeshProxyTunnelDialer.resetForTest());

    it('does NOT schedule redial after reason="idle"', () => {
        const dialer = MeshProxyTunnelDialer.resetForTest();
        const scheduleSpy = vi.spyOn(dialer as unknown as { scheduleReactiveRedial: (id: number) => void }, 'scheduleReactiveRedial').mockImplementation(() => {});
        dialer.emit('proxy-bridge-down', 7, 'idle');
        expect(scheduleSpy).not.toHaveBeenCalled();
    });

    it('does NOT schedule redial after reason="auth_failed"', () => {
        const dialer = MeshProxyTunnelDialer.resetForTest();
        const scheduleSpy = vi.spyOn(dialer as unknown as { scheduleReactiveRedial: (id: number) => void }, 'scheduleReactiveRedial').mockImplementation(() => {});
        dialer.emit('proxy-bridge-down', 7, 'auth_failed');
        expect(scheduleSpy).not.toHaveBeenCalled();
    });

    it('schedules redial after reason="remote_closed"', () => {
        const dialer = MeshProxyTunnelDialer.resetForTest();
        const scheduleSpy = vi.spyOn(dialer as unknown as { scheduleReactiveRedial: (id: number) => void }, 'scheduleReactiveRedial').mockImplementation(() => {});
        dialer.emit('proxy-bridge-down', 7, 'remote_closed');
        expect(scheduleSpy).toHaveBeenCalledWith(7);
    });
});
