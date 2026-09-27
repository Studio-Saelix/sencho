import WebSocket from 'ws';

/** Missed pong intervals tolerated before a peer is declared dead. */
export const WS_HEARTBEAT_MAX_MISSED = 2;

/**
 * Ping `ws` every `intervalMs` and terminate it once `maxMissed` consecutive
 * intervals pass without any pong, inbound message, or drop in the send
 * buffer. Terminating emits a `close` (code 1006), so the owner's normal
 * disconnect path runs and the dialer or agent reconnects.
 *
 * Without this a half-open connection (tunnel or VPN restart, NAT rebind,
 * reverse proxy dropping the upstream silently) stays "open" until the
 * kernel gives up on retransmits, which can take many minutes.
 *
 * Returns a function that stops the heartbeat; call it on close.
 */
export function startWsHeartbeat(
    ws: WebSocket,
    intervalMs: number,
    maxMissed: number = WS_HEARTBEAT_MAX_MISSED,
): () => void {
    let missed = 0;
    let lastBufferedAmount = ws.bufferedAmount;
    const markAlive = (): void => { missed = 0; };
    ws.on('pong', markAlive);
    ws.on('message', markAlive);
    const timer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        // A shrinking send buffer is proof of life on its own. It means the
        // peer's TCP stack is still acknowledging, which is exactly the
        // situation where the pong is useless as a signal: on a slow link a
        // bulk upload queues megabytes ahead of the pong, so the pong (and
        // the only reset) arrives long after the interval that produced it.
        // Counting those intervals would kill a healthy but slow tunnel every
        // few intervals. A buffer that is flat or growing is the real dead
        // peer signal, and still counts.
        const bufferedAmount = ws.bufferedAmount;
        if (bufferedAmount < lastBufferedAmount) missed = 0;
        lastBufferedAmount = bufferedAmount;
        if (missed >= maxMissed) {
            stop();
            try { ws.terminate(); } catch { /* surfaced via close */ }
            return;
        }
        missed += 1;
        try { ws.ping(); } catch { /* surfaced via error */ }
    }, intervalMs);
    timer.unref?.();
    function stop(): void {
        clearInterval(timer);
        ws.off('pong', markAlive);
        ws.off('message', markAlive);
    }
    return stop;
}
