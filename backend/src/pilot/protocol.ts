/**
 * Pilot Tunnel wire protocol.
 *
 * A single WebSocket between primary and pilot agent carries many multiplexed
 * HTTP requests and nested WebSocket streams. Each stream is identified by a
 * monotonically increasing streamId allocated by the primary (the originator
 * of every request).
 *
 * Wire format is hybrid:
 *   - Text frames: JSON envelopes for metadata (open/close/headers/control)
 *   - Binary frames: raw payload bytes with a 5-byte prefix
 *         [ 1 byte: BinaryFrameType ][ 4 bytes: streamId (big-endian) ][ bytes... ]
 *
 * JSON is inspectable and low-overhead for small control messages; binary
 * avoids base64 bloat on body chunks and WS message payloads.
 */

export const PROTOCOL_VERSION = 1;

/**
 * Hard ceiling on a single tunnel WebSocket frame, in bytes. Authoritative
 * enforcement is at the WebSocket layer: `maxPayload` on the gateway-side
 * `WebSocketServer` and the agent-side `WebSocket` client both reject
 * oversized frames before they reach the decoder. The decoder also enforces
 * the same cap for two narrow cases: (1) tests that build Buffers locally
 * and skip the WebSocket layer, and (2) defense-in-depth if a future
 * codepath ever passes user-controlled bytes to the decoder directly.
 *
 * 8 MB comfortably accommodates compose YAML, image-list responses, and
 * exec stream chunks while bounding the decode buffer a buggy or malicious
 * peer can force the other side to allocate.
 */
export const MAX_FRAME_SIZE_BYTES = 8 * 1024 * 1024;

/**
 * Maximum concurrent multiplexed streams on a single tunnel. Beyond this the
 * bridge refuses new loopback requests with 503 and the agent rejects new
 * incoming streams with the appropriate error frame. Sized for normal Sencho
 * fanout (UI tabs polling stats, logs, stack lifecycle) with substantial
 * headroom; the realistic ceiling under load is closer to single digits per
 * tunnel.
 */
export const MAX_STREAMS_PER_TUNNEL = 1024;

/**
 * Per-stream idle timeout. A stream that sees no inbound or outbound activity
 * for this long is closed and removed from the stream map. Protects against
 * leaked streams (one side crashed, peer never noticed) leaking memory over
 * long uptimes.
 */
export const STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Per-stream cap on inbound `TcpData` bytes that a receiver buffers while
 * waiting for its local socket to connect. `tcp_open` and `tcp_open_reverse`
 * both trigger an async dial (resolveTarget + TCP handshake), and the
 * protocol allows the peer to send data immediately. Anything received in
 * that window is held in `pendingData` until the socket is ready; over
 * this cap the stream is dropped and a `tcp_close` is sent back so a
 * misbehaving (or compromised) peer cannot OOM the receiver.
 */
export const STREAM_PENDING_DATA_MAX_BYTES = 1024 * 1024;

// --- Binary frame types (first byte of a binary WS frame) ---

export enum BinaryFrameType {
    HttpReqBody = 0x01,
    HttpResBody = 0x02,
    WsMessageBinary = 0x03,
    TcpData = 0x04,
}

// --- JSON envelope types ---

export type JsonFrame =
    | HelloFrame
    | HttpReqFrame
    | HttpReqEndFrame
    | HttpResFrame
    | HttpResEndFrame
    | HttpErrorFrame
    | WsOpenFrame
    | WsAcceptFrame
    | WsRejectFrame
    | WsMessageTextFrame
    | WsCloseFrame
    | ControlFrame
    | TcpOpenFrame
    | TcpOpenReverseFrame
    | TcpOpenAckFrame
    | TcpCloseFrame;

export interface HelloFrame {
    t: 'hello';
    version: number;
    role: 'primary' | 'agent';
    agentVersion?: string;
}

export interface HttpReqFrame {
    t: 'http_req';
    s: number;
    method: string;
    path: string;
    headers: Record<string, string>;
}

export interface HttpReqEndFrame {
    t: 'http_req_end';
    s: number;
}

export interface HttpResFrame {
    t: 'http_res';
    s: number;
    status: number;
    headers: Record<string, string>;
}

export interface HttpResEndFrame {
    t: 'http_res_end';
    s: number;
}

export interface HttpErrorFrame {
    t: 'http_err';
    s: number;
    code: 'timeout' | 'tunnel_down' | 'bad_response' | 'agent_error';
    message: string;
}

export interface WsOpenFrame {
    t: 'ws_open';
    s: number;
    path: string;
    headers: Record<string, string>;
}

export interface WsAcceptFrame {
    t: 'ws_accept';
    s: number;
    headers: Record<string, string>;
}

export interface WsRejectFrame {
    t: 'ws_reject';
    s: number;
    status: number;
    message: string;
}

export interface WsMessageTextFrame {
    t: 'ws_msg_text';
    s: number;
    data: string;
}

export interface WsCloseFrame {
    t: 'ws_close';
    s: number;
    code: number;
    reason?: string;
}

export interface ControlFrame {
    t: 'ctrl';
    op: 'enroll_ack' | 'node_info' | 'ping' | 'pong';
    payload?: Record<string, unknown>;
}

/**
 * Sencho Mesh TCP frames. Two directions:
 *
 *   - `tcp_open` (primary -> agent): primary asks the agent to open a TCP
 *     connection to a Compose service on the agent's local Docker host.
 *     Stream id is allocated by the primary's `StreamIdAllocator` (low
 *     range, starts at 1).
 *
 *   - `tcp_open_reverse` (agent -> primary): the agent's mesh forwarder
 *     accepted a connection destined for another node and asks the primary
 *     to dial that node. If `targetNodeId` matches the primary's own node,
 *     the primary dials a local container directly. Otherwise the primary
 *     relays via its bridge to the target pilot. Stream id is allocated by
 *     the agent and uses the upper half of the 32-bit space
 *     (>= 0x40000001) so it cannot collide with primary-allocated ids on
 *     the same tunnel; the wrap distance (~2^30 vs the 1024 stream cap)
 *     makes collisions statistically unreachable.
 *
 * In both directions, `tcp_open_ack` confirms acceptance, bytes flow as
 * `BinaryFrameType.TcpData`, and `tcp_close` ends the stream.
 */
export interface TcpOpenFrame {
    t: 'tcp_open';
    s: number;
    stack: string;
    service: string;
    port: number;
}

export interface TcpOpenReverseFrame {
    t: 'tcp_open_reverse';
    s: number;
    targetNodeId: number;
    stack: string;
    service: string;
    port: number;
}

export type MeshErrCode = 'mesh_not_enabled' | 'denied' | 'no_target' | 'unreachable' | 'agent_error';

export interface TcpOpenAckFrame {
    t: 'tcp_open_ack';
    s: number;
    ok: boolean;
    err?: MeshErrCode;
}

export interface TcpCloseFrame {
    t: 'tcp_close';
    s: number;
}

/**
 * Stream id space split for `tcp_open` (primary-allocated) vs
 * `tcp_open_reverse` (agent-allocated). Used by the agent's reverse
 * allocator and by the primary's `tcp_open_reverse` handler to verify
 * incoming ids are in the agent half.
 */
export const AGENT_REVERSE_ID_BASE = 0x40000001;

// --- Serialize / parse ---

export function encodeJsonFrame(frame: JsonFrame): string {
    return JSON.stringify(frame);
}

export function decodeJsonFrame(raw: string): JsonFrame {
    // Compare against UTF-8 byte length, not the string's UTF-16 code-unit
    // count: multi-byte payloads can otherwise sneak ~3x the byte budget
    // through a `raw.length` check. Cheap because Buffer.byteLength does
    // not allocate.
    const byteLen = Buffer.byteLength(raw, 'utf8');
    if (byteLen > MAX_FRAME_SIZE_BYTES) {
        throw new Error(`json frame too large: ${byteLen} bytes`);
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.t !== 'string') {
        throw new Error('invalid frame: missing type discriminator');
    }
    return parsed as JsonFrame;
}

/**
 * Build a binary frame: [type][streamId BE][payload].
 * Returns a fresh Buffer owned by the caller.
 */
export function encodeBinaryFrame(type: BinaryFrameType, streamId: number, payload: Buffer): Buffer {
    if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffffff) {
        throw new Error(`invalid streamId: ${streamId}`);
    }
    const out = Buffer.allocUnsafe(5 + payload.length);
    out.writeUInt8(type, 0);
    out.writeUInt32BE(streamId, 1);
    payload.copy(out, 5);
    return out;
}

export interface DecodedBinaryFrame {
    type: BinaryFrameType;
    streamId: number;
    payload: Buffer;
}

export function decodeBinaryFrame(buf: Buffer): DecodedBinaryFrame {
    if (buf.length < 5) {
        throw new Error(`binary frame too short: ${buf.length} bytes`);
    }
    if (buf.length > MAX_FRAME_SIZE_BYTES) {
        throw new Error(`binary frame too large: ${buf.length} bytes`);
    }
    const type = buf.readUInt8(0) as BinaryFrameType;
    if (type !== BinaryFrameType.HttpReqBody &&
        type !== BinaryFrameType.HttpResBody &&
        type !== BinaryFrameType.WsMessageBinary &&
        type !== BinaryFrameType.TcpData) {
        throw new Error(`unknown binary frame type: ${type}`);
    }
    const streamId = buf.readUInt32BE(1);
    const payload = buf.subarray(5);
    return { type, streamId, payload };
}

// --- WS payload normalization ---

export function wsDataToBuffer(data: unknown): Buffer | null {
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (Array.isArray(data)) return Buffer.concat(data.map((d) => Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer)));
    return null;
}

export function wsDataToString(data: unknown): string | null {
    if (typeof data === 'string') return data;
    const buf = wsDataToBuffer(data);
    return buf ? buf.toString('utf8') : null;
}

// --- Close codes ---

export const PilotCloseCode = {
    Replaced: 4000,
    EnrollmentRegenerated: 4001,
    ProtocolError: 1002,
} as const;

// --- Stream id allocation ---

/**
 * Monotonic stream id generator.
 *
 * Wraps at 2^31 back to the configured `start` value (not back to `1`),
 * so allocators initialized with `AGENT_REVERSE_ID_BASE` stay in the
 * agent half of the id space across the wrap. With
 * MAX_STREAMS_PER_TUNNEL = 1024 the allocator cannot collide with a
 * still-live stream during a single tunnel lifetime: the wrap distance
 * (~2.1 billion) is more than six orders of magnitude larger than the
 * cap. A new tunnel restarts the sequence at `start`, so cross-tunnel
 * reuse is also harmless.
 */
export class StreamIdAllocator {
    private readonly start: number;
    private next: number;

    constructor(start = 1) {
        this.start = start;
        this.next = start;
    }

    allocate(): number {
        const id = this.next;
        this.next = this.next >= 0x7fffffff ? this.start : this.next + 1;
        return id;
    }
}
