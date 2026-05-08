/**
 * Phase B: PilotAgent's outbound reverse mesh stream. The agent's
 * MeshForwarder hands off cross-node connections to PilotAgent via
 * `openMeshTcpStream`, which sends a `tcp_open_reverse` frame and returns
 * a stream handle. The test exercises the wire shape and the lifecycle
 * dispatchers (open / data / close) without needing a real WebSocket or
 * the full Sencho boot.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import {
    AGENT_REVERSE_ID_BASE,
    BinaryFrameType,
    decodeBinaryFrame,
    decodeJsonFrame,
    encodeBinaryFrame,
    encodeJsonFrame,
} from '../pilot/protocol';

let tmpDir: string;
let PilotAgent: typeof import('../pilot/agent').PilotAgent;
let ReverseTcpStreamHandle: typeof import('../pilot/agent').ReverseTcpStreamHandle;

interface CapturedSend {
    raw: string | Buffer;
    binary: boolean;
}

function makeMockAgent(): { agent: import('../pilot/agent').PilotAgent; sent: CapturedSend[]; mockWs: { readyState: number; send: (data: unknown, opts?: { binary?: boolean }) => void } } {
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
    const agent = new PilotAgent({
        primaryUrl: 'http://primary.invalid',
        loopbackPort: 1,
        initialToken: 'irrelevant',
        enrolling: false,
    });
    // Inject the mock ws into the private slot. The agent's
    // openMeshTcpStream checks readyState and calls send(); the mock
    // captures both for assertions without needing real connect/handshake.
    (agent as unknown as { ws: typeof mockWs }).ws = mockWs;
    return { agent, sent, mockWs };
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ PilotAgent, ReverseTcpStreamHandle } = await import('../pilot/agent'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

describe('PilotAgent.openMeshTcpStream (Phase B)', () => {
    it('allocates an id in the agent-reverse range and emits a tcp_open_reverse frame with the target', () => {
        const { agent, sent } = makeMockAgent();
        const handle = agent.openMeshTcpStream({
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
        const { agent, mockWs } = makeMockAgent();
        mockWs.readyState = 0; // CONNECTING
        const handle = agent.openMeshTcpStream({ nodeId: 1, stack: 'a', service: 'b', port: 1 });
        expect(handle).toBeNull();
    });

    it('handle.write encodes a TcpData binary frame with the agent-allocated streamId', () => {
        const { agent, sent } = makeMockAgent();
        const handle = agent.openMeshTcpStream({ nodeId: 2, stack: 's', service: 'svc', port: 80 });
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

    it('handle.end sends a tcp_close JSON frame and removes the stream from the agent map', () => {
        const { agent, sent } = makeMockAgent();
        const handle = agent.openMeshTcpStream({ nodeId: 3, stack: 's', service: 'svc', port: 80 });
        if (!handle) throw new Error('handle should exist');
        sent.length = 0;

        handle.end();

        const text = sent.find((s) => !s.binary);
        expect(text).toBeDefined();
        const decoded = decodeJsonFrame(text!.raw as string);
        expect(decoded.t).toBe('tcp_close');
        if (decoded.t !== 'tcp_close') throw new Error('narrowing');
        expect(decoded.s).toBe(handle.streamId);

        const internalMap = (agent as unknown as { reverseTcpStreams: Map<number, unknown> }).reverseTcpStreams;
        expect(internalMap.has(handle.streamId)).toBe(false);
    });

    it('inbound tcp_open_ack {ok: true} fires the open event on the matching handle', () => {
        const { agent, mockWs } = makeMockAgent();
        const handle = agent.openMeshTcpStream({ nodeId: 4, stack: 's', service: 'svc', port: 80 });
        if (!handle) throw new Error('handle should exist');

        let opened = false;
        handle.on('open', () => { opened = true; });

        // Simulate an inbound ack frame: invoke the agent's private json-
        // dispatch path with a synthetic frame.
        const onTcpOpenAckReverse = (agent as unknown as { onTcpOpenAckReverse: (frame: unknown) => void }).onTcpOpenAckReverse.bind(agent);
        onTcpOpenAckReverse({ t: 'tcp_open_ack', s: handle.streamId, ok: true });

        expect(opened).toBe(true);
        // Sanity: mockWs's readyState wasn't touched.
        expect(mockWs.readyState).toBe(1);
    });

    it('inbound tcp_open_ack {ok: false} emits error and close, then drops the handle', () => {
        const { agent } = makeMockAgent();
        const handle = agent.openMeshTcpStream({ nodeId: 5, stack: 's', service: 'svc', port: 80 });
        if (!handle) throw new Error('handle should exist');

        let errMessage: string | undefined;
        let closed = false;
        handle.on('error', (err: Error) => { errMessage = err.message; });
        handle.on('close', () => { closed = true; });

        const onTcpOpenAckReverse = (agent as unknown as { onTcpOpenAckReverse: (frame: unknown) => void }).onTcpOpenAckReverse.bind(agent);
        onTcpOpenAckReverse({ t: 'tcp_open_ack', s: handle.streamId, ok: false, err: 'unreachable' });

        expect(errMessage).toBe('unreachable');
        expect(closed).toBe(true);
        const internalMap = (agent as unknown as { reverseTcpStreams: Map<number, unknown> }).reverseTcpStreams;
        expect(internalMap.has(handle.streamId)).toBe(false);
    });

    it('forward-direction tcp_open_ack ids (low half) do not match reverse handles', () => {
        const { agent } = makeMockAgent();
        const handle = agent.openMeshTcpStream({ nodeId: 6, stack: 's', service: 'svc', port: 80 });
        if (!handle) throw new Error('handle should exist');

        let opened = false;
        handle.on('open', () => { opened = true; });

        // Primary-direction id (< AGENT_REVERSE_ID_BASE) must not bleed into
        // the reverse map.
        const onTcpOpenAckReverse = (agent as unknown as { onTcpOpenAckReverse: (frame: unknown) => void }).onTcpOpenAckReverse.bind(agent);
        onTcpOpenAckReverse({ t: 'tcp_open_ack', s: 5, ok: true });

        expect(opened).toBe(false);
    });

    it('inbound TcpData binary frame (encoded against the wire) emits data on the handle', () => {
        const { agent } = makeMockAgent();
        const handle = agent.openMeshTcpStream({ nodeId: 7, stack: 's', service: 'svc', port: 80 });
        if (!handle) throw new Error('handle should exist');

        const received: Buffer[] = [];
        handle.on('data', (chunk: Buffer) => received.push(chunk));

        // Drive the agent's binary-frame handler with a wire-encoded TcpData
        // frame to also exercise the routing branch added in Phase B.
        const buf = encodeBinaryFrame(BinaryFrameType.TcpData, handle.streamId, Buffer.from('echo!'));
        const decoded = decodeBinaryFrame(buf);
        const handleBinaryFrame = (agent as unknown as { handleBinaryFrame: (frame: unknown) => void }).handleBinaryFrame.bind(agent);
        handleBinaryFrame(decoded);

        expect(Buffer.concat(received).toString()).toBe('echo!');
    });
});
