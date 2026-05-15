/**
 * Reverse mesh streams: the switchboard's `openReverseStream` is the
 * outbound side of the protocol. Exercises wire-shape (the JSON
 * `tcp_open_reverse` frame and the binary `TcpData` envelope) and the
 * stream-handle lifecycle dispatchers (open / data / close).
 *
 * Both the pilot agent and the proxy-mode WS handler delegate to the
 * switchboard's `openReverseStream`; the lifecycle assertions here cover
 * the shared logic both callers depend on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import {
    AGENT_REVERSE_ID_BASE,
    BinaryFrameType,
    decodeBinaryFrame,
    decodeJsonFrame,
    encodeBinaryFrame,
} from '../pilot/protocol';

let tmpDir: string;
let attachTcpStreamSwitchboard: typeof import('../mesh/tcpStreamSwitchboard').attachTcpStreamSwitchboard;
let ReverseTcpStreamHandle: typeof import('../mesh/tcpStreamSwitchboard').ReverseTcpStreamHandle;

interface CapturedSend {
    raw: string | Buffer;
    binary: boolean;
}

function makeSwitchboard(): {
    switchboard: ReturnType<typeof attachTcpStreamSwitchboard>;
    sent: CapturedSend[];
    mockWs: { readyState: number; send: (data: unknown, opts?: { binary?: boolean }) => void };
} {
    const sent: CapturedSend[] = [];
    const mockWs = {
        readyState: 1, // WebSocket.OPEN
        send(data: unknown, opts?: { binary?: boolean }) {
            const isBinary = opts?.binary === true;
            sent.push({
                raw: isBinary ? (Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array)) : String(data),
                binary: isBinary,
            });
        },
    };
    // The switchboard accepts the `ws` type structurally; the cast is
    // narrow and only used in this test harness.
    const switchboard = attachTcpStreamSwitchboard({
        ws: mockWs as unknown as import('ws').WebSocket,
        resolveTarget: async () => ({ ok: false, err: 'no_target' }),
        logLabel: 'Test',
    });
    return { switchboard, sent, mockWs };
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ attachTcpStreamSwitchboard, ReverseTcpStreamHandle } = await import('../mesh/tcpStreamSwitchboard'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

describe('TcpStreamSwitchboard.openReverseStream', () => {
    it('allocates an id in the agent-reverse range and emits a tcp_open_reverse frame with the target', () => {
        const { switchboard, sent } = makeSwitchboard();
        const handle = switchboard.openReverseStream({
            nodeId: 12,
            stack: 'api',
            service: 'db',
            port: 5432,
        });
        expect(handle).toBeInstanceOf(ReverseTcpStreamHandle);
        expect(handle!.streamId).toBeGreaterThanOrEqual(AGENT_REVERSE_ID_BASE);

        const textFrames = sent.filter((s) => !s.binary);
        expect(textFrames.length).toBe(1);
        const decoded = decodeJsonFrame(textFrames[0].raw as string);
        expect(decoded.t).toBe('tcp_open_reverse');
        if (decoded.t !== 'tcp_open_reverse') throw new Error('narrowing');
        expect(decoded.s).toBe(handle!.streamId);
        expect(decoded.targetNodeId).toBe(12);
        expect(decoded.stack).toBe('api');
        expect(decoded.service).toBe('db');
        expect(decoded.port).toBe(5432);
    });

    it('returns null when the tunnel is not OPEN', () => {
        const { switchboard, mockWs } = makeSwitchboard();
        mockWs.readyState = 0; // CONNECTING
        const handle = switchboard.openReverseStream({ nodeId: 1, stack: 'a', service: 'b', port: 1 });
        expect(handle).toBeNull();
    });

    it('handle.write encodes a TcpData binary frame with the allocated streamId', () => {
        const { switchboard, sent } = makeSwitchboard();
        const handle = switchboard.openReverseStream({ nodeId: 2, stack: 's', service: 'svc', port: 80 });
        if (!handle) throw new Error('handle should exist');
        sent.length = 0; // clear the open frame

        const ok = handle.write(Buffer.from('hello'));
        expect(ok).toBe(true);
        expect(sent.length).toBe(1);
        expect(sent[0].binary).toBe(true);
        const decoded = decodeBinaryFrame(sent[0].raw as Buffer);
        expect(decoded.type).toBe(BinaryFrameType.TcpData);
        expect(decoded.streamId).toBe(handle.streamId);
        expect(decoded.payload.toString()).toBe('hello');
    });

    it('handle.end sends a tcp_close JSON frame and drops the stream count', () => {
        const { switchboard, sent } = makeSwitchboard();
        const handle = switchboard.openReverseStream({ nodeId: 3, stack: 's', service: 'svc', port: 80 });
        if (!handle) throw new Error('handle should exist');
        expect(switchboard.tcpStreamCount()).toBe(1);
        sent.length = 0;

        handle.end();

        const text = sent.find((s) => !s.binary);
        expect(text).toBeDefined();
        const decoded = decodeJsonFrame(text!.raw as string);
        expect(decoded.t).toBe('tcp_close');
        if (decoded.t !== 'tcp_close') throw new Error('narrowing');
        expect(decoded.s).toBe(handle.streamId);

        expect(switchboard.tcpStreamCount()).toBe(0);
    });

    it('inbound tcp_open_ack {ok: true} fires the open event on the matching handle', () => {
        const { switchboard } = makeSwitchboard();
        const handle = switchboard.openReverseStream({ nodeId: 4, stack: 's', service: 'svc', port: 80 });
        if (!handle) throw new Error('handle should exist');

        let opened = false;
        handle.on('open', () => { opened = true; });

        const consumed = switchboard.handleJsonFrame({ t: 'tcp_open_ack', s: handle.streamId, ok: true });
        expect(consumed).toBe(true);
        expect(opened).toBe(true);
    });

    it('inbound tcp_open_ack {ok: false} emits error and close, then drops the handle', () => {
        const { switchboard } = makeSwitchboard();
        const handle = switchboard.openReverseStream({ nodeId: 5, stack: 's', service: 'svc', port: 80 });
        if (!handle) throw new Error('handle should exist');

        let errMessage: string | undefined;
        let closed = false;
        handle.on('error', (err: Error) => { errMessage = err.message; });
        handle.on('close', () => { closed = true; });

        switchboard.handleJsonFrame({ t: 'tcp_open_ack', s: handle.streamId, ok: false, err: 'unreachable' });

        expect(errMessage).toBe('unreachable');
        expect(closed).toBe(true);
        expect(switchboard.tcpStreamCount()).toBe(0);
    });

    it('forward-direction tcp_open_ack ids (low half) are not consumed by the switchboard', () => {
        const { switchboard } = makeSwitchboard();
        const handle = switchboard.openReverseStream({ nodeId: 6, stack: 's', service: 'svc', port: 80 });
        if (!handle) throw new Error('handle should exist');

        let opened = false;
        handle.on('open', () => { opened = true; });

        const consumed = switchboard.handleJsonFrame({ t: 'tcp_open_ack', s: 5, ok: true });
        // Low-half ack is left for the caller to route (it's the
        // primary-allocated forward-stream ack, irrelevant to the
        // switchboard's reverse map).
        expect(consumed).toBe(false);
        expect(opened).toBe(false);
    });

    it('inbound TcpData binary frame (encoded against the wire) emits data on the handle', () => {
        const { switchboard } = makeSwitchboard();
        const handle = switchboard.openReverseStream({ nodeId: 7, stack: 's', service: 'svc', port: 80 });
        if (!handle) throw new Error('handle should exist');

        const received: Buffer[] = [];
        handle.on('data', (chunk: Buffer) => received.push(chunk));

        const buf = encodeBinaryFrame(BinaryFrameType.TcpData, handle.streamId, Buffer.from('echo!'));
        const decoded = decodeBinaryFrame(buf);
        const consumed = switchboard.handleBinaryFrame(decoded);
        expect(consumed).toBe(true);
        expect(Buffer.concat(received).toString()).toBe('echo!');
    });

    it('cleanup() emits error + close on every outstanding reverse handle and resets the count', () => {
        const { switchboard } = makeSwitchboard();
        const h1 = switchboard.openReverseStream({ nodeId: 8, stack: 's', service: 'a', port: 1 })!;
        const h2 = switchboard.openReverseStream({ nodeId: 9, stack: 's', service: 'b', port: 2 })!;
        const closed: number[] = [];
        const errors: string[] = [];
        h1.on('close', () => closed.push(h1.streamId));
        h2.on('close', () => closed.push(h2.streamId));
        h1.on('error', (e: Error) => errors.push(e.message));
        h2.on('error', (e: Error) => errors.push(e.message));

        switchboard.cleanup('mock disconnect');

        expect(closed).toContain(h1.streamId);
        expect(closed).toContain(h2.streamId);
        expect(errors).toEqual(expect.arrayContaining(['mock disconnect', 'mock disconnect']));
        expect(switchboard.tcpStreamCount()).toBe(0);
    });
});
