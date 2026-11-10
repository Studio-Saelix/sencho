/**
 * Pilot HTTP response flow control: the hub asks the agent to pause a
 * response when the client stops draining, the agent pauses on that request
 * and on its own tunnel send buffer, unknown frames are ignored on both
 * sides, and an http_err after the response headers aborts the client
 * response instead of ending it cleanly.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'http';
import net from 'net';
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import {
    BinaryFrameType,
    decodeBinaryFrame,
    decodeJsonFrame,
    encodeBinaryFrame,
    encodeJsonFrame,
    type JsonFrame,
} from '../pilot/protocol';
import { PilotTunnelBridge } from '../services/PilotTunnelBridge';
import { PilotAgent } from '../pilot/agent';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

type MockTunnelWs = EventEmitter & {
    sent: unknown[];
    readyState: number;
    bufferedAmount: number;
    send: (data: unknown) => void;
    ping: () => void;
    close: () => void;
};

function makeMockTunnelWs(): MockTunnelWs {
    const ws = new EventEmitter() as MockTunnelWs;
    ws.sent = [];
    ws.readyState = WebSocket.OPEN;
    ws.bufferedAmount = 0;
    ws.send = (data: unknown) => { ws.sent.push(data); };
    ws.ping = () => { /* no-op */ };
    ws.close = () => { ws.readyState = WebSocket.CLOSED; ws.emit('close'); };
    return ws;
}

function jsonFramesSent(mockWs: MockTunnelWs): JsonFrame[] {
    return mockWs.sent
        .filter((item): item is string => typeof item === 'string')
        .map((raw) => decodeJsonFrame(raw));
}

function bodyFramesSent(mockWs: MockTunnelWs, streamId: number): number {
    return mockWs.sent
        .filter((item): item is Buffer => Buffer.isBuffer(item))
        .map((buf) => decodeBinaryFrame(buf))
        .filter((f) => f.type === BinaryFrameType.HttpResBody && f.streamId === streamId)
        .length;
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
    const started = Date.now();
    while (!check()) {
        if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
        await new Promise((r) => setTimeout(r, 10));
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('PilotTunnelBridge response flow control', () => {
    let bridge: PilotTunnelBridge;
    let mockWs: MockTunnelWs;
    let loopback: URL;

    beforeAll(async () => {
        mockWs = makeMockTunnelWs();
        bridge = new PilotTunnelBridge(1, mockWs as unknown as WebSocket);
        await bridge.start();
        loopback = new URL(bridge.getLoopbackUrl());
    });

    afterAll(() => {
        bridge.close();
    });

    function agentSends(frame: JsonFrame): void {
        mockWs.emit('message', encodeJsonFrame(frame), false);
    }

    function agentSendsBody(streamId: number, payload: Buffer): void {
        mockWs.emit('message', encodeBinaryFrame(BinaryFrameType.HttpResBody, streamId, payload), true);
    }

    /**
     * Open a request on the bridge loopback over a raw socket so the test
     * controls when the client reads. Returns the socket and the stream id
     * the bridge allocated.
     */
    async function openRawRequest(path: string): Promise<{ socket: net.Socket; streamId: number }> {
        const before = jsonFramesSent(mockWs).filter((f) => f.t === 'http_req').length;
        const socket = net.connect(Number(loopback.port), loopback.hostname);
        socket.on('error', () => { /* destroyed by the test or the bridge */ });
        await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
        socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
        await waitFor(() => jsonFramesSent(mockWs).filter((f) => f.t === 'http_req').length > before);
        const reqFrame = jsonFramesSent(mockWs).filter((f) => f.t === 'http_req')[before];
        if (reqFrame.t !== 'http_req') throw new Error('expected http_req');
        return { socket, streamId: reqFrame.s };
    }

    it('sends http_res_pause when the client stops draining and http_res_resume on drain', async () => {
        const { socket, streamId } = await openRawRequest('/api/stacks/x/files/download');
        // Stop reading so the client side fills and res.write() returns false.
        socket.pause();
        agentSends({ t: 'http_res', s: streamId, status: 200, headers: { 'content-type': 'application/octet-stream' } });

        const flowFrames = () => jsonFramesSent(mockWs)
            .filter((f) => (f.t === 'http_res_pause' || f.t === 'http_res_resume') && f.s === streamId)
            .map((f) => f.t);
        const chunk = Buffer.alloc(256 * 1024, 0x61);
        for (let i = 0; i < 200 && !flowFrames().includes('http_res_pause'); i++) {
            agentSendsBody(streamId, chunk);
            await sleep(5);
        }
        expect(flowFrames()[0]).toBe('http_res_pause');

        // More chunks while the client is stalled. The kernel socket buffer
        // may absorb some and drain in between, so a later pause is legal
        // only after a resume: the frames must strictly alternate.
        for (let i = 0; i < 8; i++) agentSendsBody(streamId, chunk);
        await sleep(50);

        // Let the client read; the response drains and the bridge resumes the agent.
        socket.resume();
        await waitFor(() => flowFrames().at(-1) === 'http_res_resume');
        const frames = flowFrames();
        frames.forEach((t, i) => expect(t).toBe(i % 2 === 0 ? 'http_res_pause' : 'http_res_resume'));

        agentSends({ t: 'http_res_end', s: streamId });
        socket.destroy();
    }, 15_000);

    it('aborts the client response when http_err arrives after the headers', async () => {
        const reqFrames = () => jsonFramesSent(mockWs).filter((f) => f.t === 'http_req');
        const before = reqFrames().length;
        const outcome = new Promise<{ aborted: boolean; ended: boolean; body: string }>((resolve) => {
            const req = http.request({
                host: loopback.hostname,
                port: Number(loopback.port),
                method: 'GET',
                path: '/api/stacks/x/files/download',
            }, (res) => {
                let body = '';
                let aborted = false;
                res.on('data', (c: Buffer) => { body += c.toString(); });
                res.on('aborted', () => { aborted = true; });
                res.on('error', () => { aborted = true; });
                res.on('end', () => resolve({ aborted, ended: true, body }));
                res.on('close', () => resolve({ aborted: aborted || !res.complete, ended: false, body }));
            });
            req.on('error', () => resolve({ aborted: true, ended: false, body: '' }));
            req.end();
        });

        await waitFor(() => reqFrames().length > before);
        const s = reqFrames()[before].s;
        // Chunked (no content-length) so a clean end would look like a complete body.
        agentSends({ t: 'http_res', s, status: 200, headers: { 'content-type': 'application/octet-stream' } });
        agentSendsBody(s, Buffer.from('partial'));
        await sleep(30);
        agentSends({ t: 'http_err', s, code: 'bad_response', message: 'upstream error' });

        const result = await outcome;
        expect(result.aborted).toBe(true);
        expect(result.ended).toBe(false);
        expect(result.body).toBe('partial');
    }, 10_000);

    it('sends no resume when the client drains after the stream ended', async () => {
        const { socket, streamId } = await openRawRequest('/api/stacks/x/files/download');
        socket.pause();
        agentSends({ t: 'http_res', s: streamId, status: 200, headers: { 'content-type': 'application/octet-stream' } });
        const chunk = Buffer.alloc(256 * 1024, 0x63);
        const sawPause = () => jsonFramesSent(mockWs).some((f) => f.t === 'http_res_pause' && f.s === streamId);
        for (let i = 0; i < 200 && !sawPause(); i++) {
            agentSendsBody(streamId, chunk);
            await sleep(5);
        }
        expect(sawPause()).toBe(true);
        // The agent ends the stream while the hub may still wait for drain. A
        // resume the kernel's own drain caused before this point is legal; none
        // may follow the end.
        const resumes = () => jsonFramesSent(mockWs).filter((f) => f.t === 'http_res_resume' && f.s === streamId).length;
        const pauses = () => jsonFramesSent(mockWs).filter((f) => f.t === 'http_res_pause' && f.s === streamId).length;
        const waitingForDrain = pauses() > resumes();
        const before = resumes();
        agentSends({ t: 'http_res_end', s: streamId });
        socket.resume();
        await sleep(200);
        expect(resumes()).toBe(before);
        expect(waitingForDrain || before > 0).toBe(true);
        socket.destroy();
    }, 15_000);

    it('ignores unknown JSON frame types without closing the tunnel', () => {
        const closed = new Promise<boolean>((resolve) => {
            bridge.once('closed', () => resolve(true));
            setTimeout(() => resolve(false), 100);
        });
        mockWs.emit('message', JSON.stringify({ t: 'http_res_future_frame', s: 1 }), false);
        expect(mockWs.readyState).toBe(WebSocket.OPEN);
        return expect(closed).resolves.toBe(false);
    });
});

describe('PilotTunnelBridge teardown after headers', () => {
    it('aborts the client response when the tunnel closes mid-body', async () => {
        const ws = makeMockTunnelWs();
        const own = new PilotTunnelBridge(2, ws as unknown as WebSocket);
        await own.start();
        const url = new URL(own.getLoopbackUrl());
        const reqFrames = () => jsonFramesSent(ws).filter((f) => f.t === 'http_req');
        const outcome = new Promise<{ aborted: boolean; ended: boolean; body: string }>((resolve) => {
            const req = http.request({ host: url.hostname, port: Number(url.port), method: 'GET', path: '/api/stacks/x/files/download' }, (res) => {
                let body = '';
                let aborted = false;
                res.on('data', (c: Buffer) => { body += c.toString(); });
                res.on('aborted', () => { aborted = true; });
                res.on('error', () => { aborted = true; });
                res.on('end', () => resolve({ aborted, ended: true, body }));
                res.on('close', () => resolve({ aborted: aborted || !res.complete, ended: false, body }));
            });
            req.on('error', () => resolve({ aborted: true, ended: false, body: '' }));
            req.end();
        });
        await waitFor(() => reqFrames().length > 0);
        const s = reqFrames()[0].s;
        ws.emit('message', encodeJsonFrame({ t: 'http_res', s, status: 200, headers: { 'content-type': 'application/octet-stream' } }), false);
        ws.emit('message', encodeBinaryFrame(BinaryFrameType.HttpResBody, s, Buffer.from('partial')), true);
        await sleep(30);
        ws.close();
        const result = await outcome;
        expect(result.aborted).toBe(true);
        expect(result.ended).toBe(false);
        own.close();
    }, 10_000);
});

describe('PilotAgent response flow control', () => {
    let tmpDir: string;
    let upstream: http.Server;
    let upstreamPort: number;
    let agent: PilotAgent;
    let mockWs: MockTunnelWs;

    interface AgentInternals {
        ws: MockTunnelWs | null;
        handleFrame: (data: unknown, isBinary: boolean) => void;
        handleJsonFrame: (frame: JsonFrame) => void;
        httpStreams: Map<number, { res?: http.IncomingMessage; hubPaused: boolean; sendBufferPaused: boolean }>;
        responseDrainTimer?: NodeJS.Timeout;
        cleanupAfterDisconnect: () => void;
    }

    function internals(): AgentInternals {
        return agent as unknown as AgentInternals;
    }

    beforeAll(async () => {
        tmpDir = await setupTestDb();
        // Upstream that streams a 1 KiB chunk every 10 ms until the client goes away.
        upstream = http.createServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            const timer = setInterval(() => res.write(Buffer.alloc(1024, 0x62)), 10);
            res.on('close', () => clearInterval(timer));
        });
        await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
        upstreamPort = (upstream.address() as net.AddressInfo).port;
    });

    afterAll(async () => {
        upstream.closeAllConnections();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
        cleanupTestDb(tmpDir);
    });

    afterEach(() => {
        internals().cleanupAfterDisconnect();
    });

    async function startStream(streamId: number): Promise<void> {
        agent = new PilotAgent({
            primaryUrl: 'http://primary.invalid',
            loopbackPort: upstreamPort,
            initialToken: 'test-token',
            enrollToken: null,
            enrolling: false,
        });
        mockWs = makeMockTunnelWs();
        internals().ws = mockWs;
        internals().handleJsonFrame({ t: 'http_req', s: streamId, method: 'GET', path: '/download', headers: {} });
        internals().handleJsonFrame({ t: 'http_req_end', s: streamId });
        await waitFor(() => bodyFramesSent(mockWs, streamId) >= 2);
    }

    async function expectStalled(streamId: number): Promise<void> {
        await sleep(50);
        const count = bodyFramesSent(mockWs, streamId);
        await sleep(100);
        expect(bodyFramesSent(mockWs, streamId)).toBe(count);
    }

    async function expectFlowing(streamId: number): Promise<void> {
        const count = bodyFramesSent(mockWs, streamId);
        await waitFor(() => bodyFramesSent(mockWs, streamId) > count + 2);
    }

    it('pauses and resumes the loopback response on hub frames', async () => {
        await startStream(7);
        internals().handleFrame(encodeJsonFrame({ t: 'http_res_pause', s: 7 }), false);
        expect(internals().httpStreams.get(7)?.res?.isPaused()).toBe(true);
        await expectStalled(7);

        internals().handleFrame(encodeJsonFrame({ t: 'http_res_resume', s: 7 }), false);
        await expectFlowing(7);
    }, 10_000);

    it('pauses above the send-buffer mark and resumes once it drains', async () => {
        await startStream(8);
        mockWs.bufferedAmount = 2 * 1024 * 1024;
        await waitFor(() => internals().httpStreams.get(8)?.sendBufferPaused === true);
        await expectStalled(8);

        mockWs.bufferedAmount = 0;
        await expectFlowing(8);
        expect(internals().responseDrainTimer).toBeUndefined();
    }, 10_000);

    it('stays paused until both the hub pause and the send buffer clear', async () => {
        await startStream(9);
        mockWs.bufferedAmount = 2 * 1024 * 1024;
        await waitFor(() => internals().httpStreams.get(9)?.sendBufferPaused === true);
        internals().handleJsonFrame({ t: 'http_res_pause', s: 9 });

        // The hub lifts its pause, but the send buffer is still full.
        internals().handleJsonFrame({ t: 'http_res_resume', s: 9 });
        await expectStalled(9);

        // The hub pauses again and the buffer drains: the hub pause still holds.
        internals().handleJsonFrame({ t: 'http_res_pause', s: 9 });
        mockWs.bufferedAmount = 0;
        await waitFor(() => internals().responseDrainTimer === undefined);
        await expectStalled(9);

        internals().handleJsonFrame({ t: 'http_res_resume', s: 9 });
        await expectFlowing(9);
    }, 10_000);

    it('clears the drain timer when the tunnel closes while paused', async () => {
        await startStream(10);
        mockWs.bufferedAmount = 2 * 1024 * 1024;
        await waitFor(() => internals().responseDrainTimer !== undefined);
        internals().cleanupAfterDisconnect();
        expect(internals().responseDrainTimer).toBeUndefined();
        expect(internals().httpStreams.size).toBe(0);
    }, 10_000);

    it('holds a hub pause that arrived before the response did', async () => {
        agent = new PilotAgent({
            primaryUrl: 'http://primary.invalid',
            loopbackPort: upstreamPort,
            initialToken: 'test-token',
            enrollToken: null,
            enrolling: false,
        });
        mockWs = makeMockTunnelWs();
        internals().ws = mockWs;
        internals().handleJsonFrame({ t: 'http_req', s: 12, method: 'GET', path: '/download', headers: {} });
        internals().handleJsonFrame({ t: 'http_res_pause', s: 12 });
        internals().handleJsonFrame({ t: 'http_req_end', s: 12 });
        await waitFor(() => internals().httpStreams.get(12)?.res !== undefined);
        await sleep(100);
        expect(bodyFramesSent(mockWs, 12)).toBeLessThanOrEqual(1);
        expect(internals().httpStreams.get(12)?.res?.isPaused()).toBe(true);
        internals().handleJsonFrame({ t: 'http_res_resume', s: 12 });
        await expectFlowing(12);
    }, 10_000);

    it('ignores pause and resume frames for a stream it does not hold', async () => {
        await startStream(13);
        expect(() => internals().handleJsonFrame({ t: 'http_res_pause', s: 999 })).not.toThrow();
        expect(() => internals().handleJsonFrame({ t: 'http_res_resume', s: 998 })).not.toThrow();
        expect(internals().httpStreams.has(999)).toBe(false);
        await expectFlowing(13);
    }, 10_000);

    it('ignores unknown JSON frame types', async () => {
        await startStream(11);
        const sentBefore = jsonFramesSent(mockWs).length;
        expect(() => internals().handleFrame(JSON.stringify({ t: 'http_res_future_frame', s: 11 }), false)).not.toThrow();
        expect(jsonFramesSent(mockWs).length).toBe(sentBefore);
        expect(internals().httpStreams.get(11)?.res?.isPaused()).toBe(false);
        await expectFlowing(11);
    }, 10_000);
});
