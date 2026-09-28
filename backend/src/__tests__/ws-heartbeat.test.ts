import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { startWsHeartbeat } from '../utils/wsHeartbeat';

let cleanup: Array<() => void> = [];

afterEach(() => {
    for (const fn of cleanup) { try { fn(); } catch { /* ignore */ } }
    cleanup = [];
});

async function pair(clientOpts: WebSocket.ClientOptions = {}): Promise<{ serverSide: WebSocket; client: WebSocket }> {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    const serverSide = new Promise<WebSocket>((r) => wss.once('connection', (ws) => r(ws)));
    const client = new WebSocket(`ws://127.0.0.1:${port}`, clientOpts);
    await new Promise<void>((r, j) => { client.once('open', () => r()); client.once('error', j); });
    cleanup.push(() => { client.terminate(); wss.close(); server.close(); });
    return { serverSide: await serverSide, client };
}

describe('startWsHeartbeat', () => {
    it('terminates a peer that stops answering pings (half-open connection)', async () => {
        const { serverSide } = await pair({ autoPong: false });
        const closed = new Promise<number>((r) => serverSide.once('close', (code) => r(code)));
        startWsHeartbeat(serverSide, 20, 2);
        expect(await closed).toBe(1006);
    });

    it('keeps a responsive peer open', async () => {
        const { serverSide } = await pair();
        const stop = startWsHeartbeat(serverSide, 20, 2);
        await new Promise((r) => setTimeout(r, 200));
        expect(serverSide.readyState).toBe(WebSocket.OPEN);
        stop();
    });

    // A bulk upload over a slow link queues the pong behind megabytes of
    // data, so pongs stop arriving inside the miss window long before the link
    // is actually dead. A shrinking send buffer is the proof of life that
    // keeps the heartbeat from killing a healthy slow tunnel, and once the
    // shrink stops the peer is treated as dead again.
    it('keeps a peer open while its send buffer drains, and terminates it once the drain stops', async () => {
        const { serverSide } = await pair({ autoPong: false });
        let buffered = 4_000_000;
        Object.defineProperty(serverSide, 'bufferedAmount', {
            get: () => buffered, configurable: true,
        });
        let draining = true;
        const drain = setInterval(() => {
            if (draining) buffered = Math.max(0, buffered - 100_000);
        }, 5);
        cleanup.push(() => clearInterval(drain));

        const closed = new Promise<number>((r) => serverSide.once('close', (code) => r(code)));
        const stop = startWsHeartbeat(serverSide, 20, 2);
        try {
            // Still draining, and still no pong ever: the peer must survive.
            await new Promise((r) => setTimeout(r, 150));
            expect(serverSide.readyState).toBe(WebSocket.OPEN);

            // The peer stopped acknowledging. Nothing else counts as life.
            draining = false;
            expect(await closed).toBe(1006);
        } finally {
            stop();
        }
    });

    it('still terminates a peer whose send buffer never drains', async () => {
        const { serverSide } = await pair({ autoPong: false });
        // The peer stopped acknowledging: the buffer is stuck above the
        // high-water mark and never shrinks.
        const stuck = 4_000_000;
        Object.defineProperty(serverSide, 'bufferedAmount', {
            get: () => stuck, configurable: true,
        });
        const closed = new Promise<number>((r) => serverSide.once('close', (code) => r(code)));
        startWsHeartbeat(serverSide, 20, 2);

        expect(await closed).toBe(1006);
    });
});
