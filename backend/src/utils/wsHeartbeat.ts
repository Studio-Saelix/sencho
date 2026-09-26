import WebSocket from 'ws';

/** Missed pong intervals tolerated before a peer is declared dead. */
export const WS_HEARTBEAT_MAX_MISSED = 2;

/**
 * Ping `ws` every `intervalMs` and terminate it once `maxMissed` consecutive
 * intervals pass without any pong or inbound message. Terminating emits a
 * `close` (code 1006), so the owner's normal disconnect path runs and the
 * dialer or agent reconnects.
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
    const markAlive = (): void => { missed = 0; };
    ws.on('pong', markAlive);
    ws.on('message', markAlive);
    const timer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
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
