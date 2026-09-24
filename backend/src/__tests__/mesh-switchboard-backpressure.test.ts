/**
 * Backpressure on the agent/peer side of the mesh protocol: when the WS
 * send buffer is saturated (slow link, tunnel, VPN), reverse-stream writes
 * report it and the handle emits 'drain' once the buffer empties, so the
 * caller can pause its source instead of buffering without bound.
 */
import { describe, expect, it } from 'vitest';
import { attachTcpStreamSwitchboard, SWITCHBOARD_BUFFER_HIGH_WATER_MARK } from '../mesh/tcpStreamSwitchboard';

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

        ws.bufferedAmount = SWITCHBOARD_BUFFER_HIGH_WATER_MARK + 1;
        expect(handle!.write(Buffer.from('b'))).toBe(false);

        const drained = new Promise<void>((resolve) => handle!.once('drain', () => resolve()));
        ws.bufferedAmount = 0;
        await drained;
        sb.cleanup();
    });
});
