/**
 * The pilot tunnel hop drops forwarding headers before framing a request to
 * the agent. The agent's loopback listener would otherwise see `X-Forwarded-*`
 * from its own loopback peer: it would warn about an untrusted proxy, and an
 * operator who followed that advice would make the agent trust a client
 * address it cannot verify.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import net from 'net';
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { decodeJsonFrame } from '../pilot/protocol';
import { PilotTunnelBridge } from '../services/PilotTunnelBridge';

function makeMockTunnelWs(): EventEmitter & {
    sent: unknown[];
    readyState: number;
    bufferedAmount: number;
    send: (data: unknown) => void;
    ping: () => void;
    close: () => void;
} {
    const ws = new EventEmitter() as EventEmitter & {
        sent: unknown[];
        readyState: number;
        bufferedAmount: number;
        send: (data: unknown) => void;
        ping: () => void;
        close: () => void;
    };
    ws.sent = [];
    ws.readyState = WebSocket.OPEN;
    ws.bufferedAmount = 0;
    ws.send = (data: unknown) => { ws.sent.push(data); };
    ws.ping = () => { /* no-op */ };
    ws.close = () => { ws.readyState = WebSocket.CLOSED; ws.emit('close'); };
    return ws;
}

function jsonFramesSent(mockWs: ReturnType<typeof makeMockTunnelWs>) {
    return mockWs.sent
        .filter((item): item is string => typeof item === 'string')
        .map((raw) => decodeJsonFrame(raw));
}

async function waitForFrame(mockWs: ReturnType<typeof makeMockTunnelWs>, type: 'http_req' | 'ws_open') {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const frame = jsonFramesSent(mockWs).find((candidate) => candidate.t === type);
        if (frame) return frame;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`tunnel frame ${type} was not sent`);
}

const FORWARDING_HEADERS = ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip'];
const STRIPPED_HEADERS = [...FORWARDING_HEADERS, 'forwarded'];

describe('PilotTunnelBridge forwarding headers', () => {
    let bridge: PilotTunnelBridge;
    let mockWs: ReturnType<typeof makeMockTunnelWs>;
    let loopbackUrl: string;

    beforeAll(async () => {
        mockWs = makeMockTunnelWs();
        bridge = new PilotTunnelBridge(1, mockWs as unknown as WebSocket);
        await bridge.start();
        loopbackUrl = bridge.getLoopbackUrl();
    });

    afterAll(() => {
        bridge.close();
    });

    it('drops forwarding headers from the http_req frame', async () => {
        const url = new URL(loopbackUrl);
        const req = http.request({
            host: url.hostname,
            port: Number(url.port),
            method: 'GET',
            path: '/api/health',
            headers: {
                'x-forwarded-for': '203.0.113.7',
                'x-forwarded-proto': 'https',
                'x-forwarded-host': 'sencho.example.com',
                'x-real-ip': '203.0.113.7',
                'forwarded': 'for=203.0.113.7;proto=https',
                'x-custom': 'kept',
            },
        });
        req.on('error', () => { /* the client is destroyed after the frame is captured */ });
        req.end();

        const frame = await waitForFrame(mockWs, 'http_req');
        req.destroy();
        if (frame.t !== 'http_req') throw new Error('expected http_req');

        expect(frame.headers['x-custom']).toBe('kept');
        for (const name of STRIPPED_HEADERS) {
            expect(frame.headers[name]).toBeUndefined();
        }
    }, 10_000);

    it('drops forwarding headers from the ws_open frame', async () => {
        const url = new URL(loopbackUrl);
        const socket = net.connect(Number(url.port), url.hostname, () => {
            socket.write([
                'GET /ws/test HTTP/1.1',
                `Host: ${url.hostname}:${url.port}`,
                'Upgrade: websocket',
                'Connection: Upgrade',
                'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
                'Sec-WebSocket-Version: 13',
                'X-Forwarded-For: 203.0.113.7',
                'X-Forwarded-Proto: https',
                'X-Forwarded-Host: sencho.example.com',
                'X-Real-IP: 203.0.113.7',
                'Forwarded: for=203.0.113.7;proto=https',
                'X-Custom: kept',
                '',
                '',
            ].join('\r\n'));
        });
        socket.on('error', () => { /* the socket is destroyed after the frame is captured */ });

        const frame = await waitForFrame(mockWs, 'ws_open');
        socket.destroy();
        if (frame.t !== 'ws_open') throw new Error('expected ws_open');

        expect(frame.headers['x-custom']).toBe('kept');
        for (const name of STRIPPED_HEADERS) {
            expect(frame.headers[name]).toBeUndefined();
        }
    }, 10_000);
});
