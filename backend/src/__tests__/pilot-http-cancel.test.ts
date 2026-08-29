/**
 * Tests for Pilot http_cancel: bridge notifies agent on client disconnect,
 * agent destroys the in-flight loopback HTTP request.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { decodeJsonFrame } from '../pilot/protocol';
import { PilotTunnelBridge } from '../services/PilotTunnelBridge';
import { PilotAgent } from '../pilot/agent';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

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

describe('PilotTunnelBridge http_cancel on client disconnect', () => {
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

    it('sends http_cancel and http_err when the loopback client disconnects mid-flight', async () => {
        const url = new URL(loopbackUrl);
        const req = http.request({
            host: url.hostname,
            port: Number(url.port),
            method: 'POST',
            path: '/api/stacks/my-stack/deploy',
            headers: { 'content-type': 'application/json' },
        });
        req.on('error', () => { /* expected when the client disconnects mid-flight */ });
        req.end(JSON.stringify({}));

        await new Promise<void>((resolve) => {
            const check = () => {
                const frames = jsonFramesSent(mockWs);
                if (frames.some((f) => f.t === 'http_req')) {
                    resolve();
                    return;
                }
                setTimeout(check, 10);
            };
            check();
        });

        const httpReq = jsonFramesSent(mockWs).find((f) => f.t === 'http_req');
        expect(httpReq?.t).toBe('http_req');
        if (httpReq?.t !== 'http_req') throw new Error('expected http_req');

        req.destroy();

        await new Promise<void>((resolve) => {
            const check = () => {
                const frames = jsonFramesSent(mockWs);
                const cancel = frames.find((f) => f.t === 'http_cancel' && f.s === httpReq.s);
                const err = frames.find((f) => f.t === 'http_err' && f.s === httpReq.s);
                if (cancel && err) {
                    resolve();
                    return;
                }
                setTimeout(check, 10);
            };
            check();
        });

        const frames = jsonFramesSent(mockWs);
        expect(frames).toContainEqual({ t: 'http_cancel', s: httpReq.s });
        expect(frames).toContainEqual({
            t: 'http_err',
            s: httpReq.s,
            code: 'tunnel_down',
            message: 'client aborted',
        });
    }, 10_000);
});

describe('PilotAgent http_cancel handling', () => {
    let tmpDir: string;

    beforeAll(async () => {
        tmpDir = await setupTestDb();
        await import('../index');
    });

    afterAll(() => {
        cleanupTestDb(tmpDir);
    });

    it('destroys the loopback ClientRequest on http_cancel', () => {
        const destroySpy = vi.spyOn(http.ClientRequest.prototype, 'destroy');

        const agent = new PilotAgent({
            primaryUrl: 'http://primary.invalid',
            loopbackPort: 9,
            initialToken: 'test-token',
            enrollToken: null,
            enrolling: false,
        });

        const agentInternals = agent as unknown as {
            ws: { send: (data: string) => void; readyState: number } | null;
            handleJsonFrame: (frame: ReturnType<typeof decodeJsonFrame>) => void;
            httpStreams: Map<number, { req: http.ClientRequest; cancelled?: boolean }>;
        };
        agentInternals.ws = { send: () => { /* no-op */ }, readyState: WebSocket.OPEN };

        agentInternals.handleJsonFrame({
            t: 'http_req',
            s: 99,
            method: 'GET',
            path: '/api/health',
            headers: {},
        });
        expect(agentInternals.httpStreams.has(99)).toBe(true);

        agentInternals.handleJsonFrame({ t: 'http_cancel', s: 99 });

        expect(destroySpy).toHaveBeenCalled();
        expect(agentInternals.httpStreams.has(99)).toBe(false);

        // Idempotent: second cancel is ignored without throwing.
        agentInternals.handleJsonFrame({ t: 'http_cancel', s: 99 });

        destroySpy.mockRestore();
    });
});
