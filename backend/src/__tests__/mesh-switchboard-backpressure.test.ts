/**
 * Backpressure on the agent/peer side of the mesh protocol: when the WS
 * send buffer is saturated (slow link, tunnel, VPN), reverse-stream writes
 * report it and the handle emits 'drain' once the buffer empties, so the
 * caller can pause its source instead of buffering without bound.
 */
import { describe, expect, it, vi } from 'vitest';
import { attachTcpStreamSwitchboard, TUNNEL_SEND_BUFFER_HIGH_WATER_MARK } from '../mesh/tcpStreamSwitchboard';

function makeWs() {
    return {
        readyState: 1,
        bufferedAmount: 0,
        send() { /* captured elsewhere */ },
    };
}

describe('TcpStreamSwitchboard backpressure', () => {
    it('reverse-stream write returns false while saturated and emits drain after the buffer empties', async () => {
        const ws = makeWs();
        const sb = attachTcpStreamSwitchboard({
            ws: ws as unknown as import('ws').WebSocket,
            resolveTarget: async () => ({ ok: false, err: 'no_target' }),
        });
        const handle = sb.openReverseStream({ nodeId: 2, stack: 's', service: 'db', port: 5432 });
        expect(handle).not.toBeNull();

        expect(handle!.write(Buffer.from('a'))).toBe(true);

        ws.bufferedAmount = TUNNEL_SEND_BUFFER_HIGH_WATER_MARK + 1;
        expect(handle!.write(Buffer.from('b'))).toBe(false);

        const drained = new Promise<void>((resolve) => handle!.once('drain', () => resolve()));
        ws.bufferedAmount = 0;
        await drained;
        sb.cleanup();
    });
});

describe('TcpStreamSwitchboard teardown while saturated', () => {
    /**
     * A closed tunnel can never drain, so a drain poll that finds the socket
     * shut has to release what it paused. Clearing the set without resuming
     * would strand those writers mid-transfer, which is worse than the
     * unbounded buffering the pause was added to prevent.
     */
    it('dispatches drain to paused reverse writers when the tunnel is already closed', async () => {
        vi.useFakeTimers();
        try {
            const ws = makeWs();
            const sb = attachTcpStreamSwitchboard({
                ws: ws as unknown as import('ws').WebSocket,
                resolveTarget: async () => ({ ok: false, err: 'no_target' }),
            });
            const handle = sb.openReverseStream({ nodeId: 2, stack: 's', service: 'db', port: 5432 });
            expect(handle).not.toBeNull();

            ws.bufferedAmount = TUNNEL_SEND_BUFFER_HIGH_WATER_MARK + 1;
            expect(handle!.write(Buffer.from('a'))).toBe(false);
            const drained = vi.fn();
            handle!.on('drain', drained);

            // The tunnel dies while the writer is still parked. Let the real
            // drain poll run; it has to notice the closed socket, release the
            // writer, and stop polling (nothing can drain from here).
            ws.readyState = 3;
            await vi.advanceTimersByTimeAsync(250);

            expect(drained).toHaveBeenCalledTimes(1);
            const internals = sb as unknown as {
                handlesAwaitingDrain: Set<unknown>;
                drainTimer: NodeJS.Timeout | null;
            };
            expect(internals.handlesAwaitingDrain.size).toBe(0);
            expect(internals.drainTimer).toBeNull();
            sb.cleanup();
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps polling without dispatching drain while the tunnel is still saturated', async () => {
        vi.useFakeTimers();
        try {
            const ws = makeWs();
            const sb = attachTcpStreamSwitchboard({
                ws: ws as unknown as import('ws').WebSocket,
                resolveTarget: async () => ({ ok: false, err: 'no_target' }),
            });
            const handle = sb.openReverseStream({ nodeId: 2, stack: 's', service: 'db', port: 5432 });
            expect(handle).not.toBeNull();

            ws.bufferedAmount = TUNNEL_SEND_BUFFER_HIGH_WATER_MARK + 1;
            expect(handle!.write(Buffer.from('a'))).toBe(false);
            const drained = vi.fn();
            handle!.on('drain', drained);

            await vi.advanceTimersByTimeAsync(250);
            expect(drained).not.toHaveBeenCalled();
            expect((sb as unknown as { handlesAwaitingDrain: Set<unknown> }).handlesAwaitingDrain.size).toBe(1);

            // Once the buffer empties the poll releases the writer.
            ws.bufferedAmount = 0;
            await vi.advanceTimersByTimeAsync(250);
            expect(drained).toHaveBeenCalledTimes(1);
            sb.cleanup();
        } finally {
            vi.useRealTimers();
        }
    });

    it('drops a closed reverse handle from the awaiting-drain bookkeeping', () => {
        const ws = makeWs();
        const sb = attachTcpStreamSwitchboard({
            ws: ws as unknown as import('ws').WebSocket,
            resolveTarget: async () => ({ ok: false, err: 'no_target' }),
        });
        const handle = sb.openReverseStream({ nodeId: 2, stack: 's', service: 'db', port: 5432 });

        ws.bufferedAmount = TUNNEL_SEND_BUFFER_HIGH_WATER_MARK + 1;
        expect(handle!.write(Buffer.from('a'))).toBe(false);
        const awaiting = (sb as unknown as { handlesAwaitingDrain: Set<unknown> }).handlesAwaitingDrain;
        expect(awaiting.size).toBe(1);

        // Terminal path: the peer closes the stream while it is still
        // paused. The handle must not linger, or churn under a saturated
        // tunnel would grow the set without bound.
        (handle as unknown as { _dispatchClose: () => void })._dispatchClose();
        expect(awaiting.size).toBe(0);
        sb.cleanup();
    });
});
