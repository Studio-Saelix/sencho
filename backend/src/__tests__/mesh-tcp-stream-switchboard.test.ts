/**
 * TcpStreamSwitchboard forward path: `tcp_open` → resolveTarget → dial
 * a local TCP target → splice bytes through `TcpData` frames. The
 * reverse path is covered by `pilot-agent-reverse-stream.test.ts`; this
 * file exercises the inbound side both the pilot agent and the proxy-
 * mode WS handler share.
 *
 * Critical because forward `tcp_open` is the trust boundary on every
 * mesh-receiving Sencho: the WS upgrade authenticates the credential,
 * but every per-stream dial must resolve via Compose labels and never
 * touch a non-mesh-opted target. Resolution policy lives in the
 * caller's `resolveTarget` callback; the switchboard's job is to honor
 * it without leaking on errors.
 */
import net from 'net';
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

interface CapturedSend {
    raw: string | Buffer;
    binary: boolean;
}

function makeSwitchboard(opts: {
    resolve?: typeof import('../mesh/tcpStreamSwitchboard').resolveByComposeLabels;
    extraStreamCount?: () => number;
} = {}): {
    switchboard: ReturnType<typeof attachTcpStreamSwitchboard>;
    sent: CapturedSend[];
    mockWs: { readyState: number; send: (data: unknown, opts?: { binary?: boolean }) => void };
} {
    const sent: CapturedSend[] = [];
    const mockWs = {
        readyState: 1,
        send(data: unknown, sendOpts?: { binary?: boolean }) {
            const isBinary = sendOpts?.binary === true;
            sent.push({
                raw: isBinary ? (Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array)) : String(data),
                binary: isBinary,
            });
        },
    };
    const switchboard = attachTcpStreamSwitchboard({
        ws: mockWs as unknown as import('ws').WebSocket,
        resolveTarget: opts.resolve ?? (async () => ({ ok: false, err: 'no_target' })),
        extraStreamCount: opts.extraStreamCount,
        logLabel: 'Test',
    });
    return { switchboard, sent, mockWs };
}

/** Spin up a one-shot localhost TCP server to serve as a dial target. */
function startEchoServer(): Promise<{ port: number; server: net.Server; firstConn: Promise<net.Socket> }> {
    return new Promise((resolve) => {
        let resolveFirst!: (s: net.Socket) => void;
        const firstConn = new Promise<net.Socket>((r) => { resolveFirst = r; });
        const server = net.createServer((sock) => {
            resolveFirst(sock);
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') throw new Error('no addr');
            resolve({ port: addr.port, server, firstConn });
        });
    });
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ attachTcpStreamSwitchboard } = await import('../mesh/tcpStreamSwitchboard'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

describe('TcpStreamSwitchboard.onTcpOpen (forward path)', () => {
    it('rejects with no_target when resolveTarget returns no_target, and never opens a socket', async () => {
        const { switchboard, sent } = makeSwitchboard({
            resolve: async () => ({ ok: false, err: 'no_target' }),
        });
        switchboard.handleJsonFrame({ t: 'tcp_open', s: 1, stack: 'api', service: 'db', port: 5432 });
        await new Promise((r) => setImmediate(r));
        const text = sent.find((s) => !s.binary);
        expect(text).toBeDefined();
        const decoded = decodeJsonFrame(text!.raw as string);
        if (decoded.t !== 'tcp_open_ack') throw new Error('expected ack');
        expect(decoded.s).toBe(1);
        expect(decoded.ok).toBe(false);
        expect(decoded.err).toBe('no_target');
        expect(switchboard.tcpStreamCount()).toBe(0);
    });

    it('rejects with the resolver-supplied err code (denied) without dialing', async () => {
        const { switchboard, sent } = makeSwitchboard({
            resolve: async () => ({ ok: false, err: 'denied' }),
        });
        switchboard.handleJsonFrame({ t: 'tcp_open', s: 7, stack: 'api', service: 'db', port: 5432 });
        await new Promise((r) => setImmediate(r));
        const ack = decodeJsonFrame(sent.find((s) => !s.binary)!.raw as string);
        if (ack.t !== 'tcp_open_ack') throw new Error('expected ack');
        expect(ack.err).toBe('denied');
    });

    it('happy path: resolves, dials a local TCP target, acks ok=true, splices echoed bytes back as TcpData frames', async () => {
        const { port, server, firstConn } = await startEchoServer();
        try {
            const { switchboard, sent } = makeSwitchboard({
                resolve: async () => ({ ok: true, host: '127.0.0.1', port }),
            });
            switchboard.handleJsonFrame({ t: 'tcp_open', s: 42, stack: 'api', service: 'db', port: 5432 });

            const targetSocket = await firstConn;
            // Wait for the ack frame to land in `sent`.
            await new Promise((r) => setTimeout(r, 25));
            const ack = sent.map((s) => s.binary ? null : decodeJsonFrame(s.raw as string)).find((d) => d?.t === 'tcp_open_ack');
            if (!ack || ack.t !== 'tcp_open_ack') throw new Error('no ack');
            expect(ack.ok).toBe(true);
            expect(ack.s).toBe(42);
            expect(switchboard.tcpStreamCount()).toBe(1);

            // Server writes some bytes; switchboard should encode them as a
            // TcpData binary frame on the WS keyed on the same streamId.
            targetSocket.write('pong');
            await new Promise((r) => setTimeout(r, 25));
            const dataFrame = sent
                .filter((s) => s.binary)
                .map((s) => decodeBinaryFrame(s.raw as Buffer))
                .find((d) => d.type === BinaryFrameType.TcpData && d.streamId === 42);
            expect(dataFrame).toBeDefined();
            expect(dataFrame!.payload.toString()).toBe('pong');

            // Inbound TcpData should land on the target socket.
            const echoed = new Promise<Buffer>((r) => targetSocket.once('data', r));
            const buf = encodeBinaryFrame(BinaryFrameType.TcpData, 42, Buffer.from('ping'));
            switchboard.handleBinaryFrame(decodeBinaryFrame(buf));
            const received = await echoed;
            expect(received.toString()).toBe('ping');

            switchboard.cleanup('test');
        } finally {
            server.close();
        }
    });

    it('refuses to dial when the per-tunnel cap (with extraStreamCount) is already saturated', async () => {
        const { switchboard, sent } = makeSwitchboard({
            resolve: async () => ({ ok: true, host: '127.0.0.1', port: 1 }),
            // Pretend we already have MAX_STREAMS_PER_TUNNEL non-mesh streams.
            extraStreamCount: () => 1024,
        });
        switchboard.handleJsonFrame({ t: 'tcp_open', s: 99, stack: 's', service: 'svc', port: 80 });
        await new Promise((r) => setImmediate(r));
        const ack = decodeJsonFrame(sent.find((s) => !s.binary)!.raw as string);
        if (ack.t !== 'tcp_open_ack') throw new Error('expected ack');
        expect(ack.ok).toBe(false);
        expect(ack.err).toBe('agent_error');
        expect(switchboard.tcpStreamCount()).toBe(0);
    });

    it('returns false from handleJsonFrame for non-TCP frame types so the outer dispatcher can route them', () => {
        const { switchboard } = makeSwitchboard();
        const consumed = switchboard.handleJsonFrame({ t: 'http_req', s: 1, method: 'GET', path: '/', headers: {} });
        expect(consumed).toBe(false);
    });

    it('returns false for tcp_open_ack with a forward-range id (low half) so the caller routes it elsewhere', () => {
        const { switchboard } = makeSwitchboard();
        const consumed = switchboard.handleJsonFrame({ t: 'tcp_open_ack', s: 5, ok: true });
        expect(consumed).toBe(false);
    });

    it('consumes tcp_open_ack with a reverse-range id (high half) even when no matching handle exists', () => {
        const { switchboard } = makeSwitchboard();
        const consumed = switchboard.handleJsonFrame({ t: 'tcp_open_ack', s: AGENT_REVERSE_ID_BASE + 1, ok: true });
        // Owned id-space; switchboard signals it consumed the frame even when
        // the matching reverse handle was already torn down (race-safe).
        expect(consumed).toBe(true);
    });

    it('tcp_close on a forward stream destroys the socket and drops the entry', async () => {
        const { port, server, firstConn } = await startEchoServer();
        try {
            const { switchboard } = makeSwitchboard({
                resolve: async () => ({ ok: true, host: '127.0.0.1', port }),
            });
            switchboard.handleJsonFrame({ t: 'tcp_open', s: 11, stack: 's', service: 'svc', port: 80 });
            const sock = await firstConn;
            await new Promise((r) => setTimeout(r, 25));
            expect(switchboard.tcpStreamCount()).toBe(1);

            const closed = new Promise<void>((r) => sock.once('close', () => r()));
            switchboard.handleJsonFrame({ t: 'tcp_close', s: 11 });
            await closed;
            expect(switchboard.tcpStreamCount()).toBe(0);
        } finally {
            server.close();
        }
    });
});
