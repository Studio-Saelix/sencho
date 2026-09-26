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
});
