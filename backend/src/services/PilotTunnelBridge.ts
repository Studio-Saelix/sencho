import http, { IncomingMessage, Server as HttpServer, ServerResponse } from 'http';
import { Socket } from 'net';
import { EventEmitter } from 'events';
import { WebSocket, WebSocketServer } from 'ws';
import {
    BinaryFrameType,
    DecodedBinaryFrame,
    MAX_STREAMS_PER_TUNNEL,
    STREAM_IDLE_TIMEOUT_MS,
    StreamIdAllocator,
    decodeBinaryFrame,
    decodeJsonFrame,
    encodeBinaryFrame,
    encodeJsonFrame,
    wsDataToBuffer,
    wsDataToString,
} from '../pilot/protocol';
import { isDebugEnabled } from '../utils/debug';
import { sanitizeForLog } from '../utils/safeLog';
import { PilotMetrics } from './PilotMetrics';

const BUFFER_HIGH_WATER_MARK = 4 * 1024 * 1024;
const PING_INTERVAL_MS = 30_000;
/**
 * Poll cadence for the backpressure drain check. The `ws` WebSocket does not
 * surface a usable 'drain' event, so when at least one stream is paused we
 * sample `bufferedAmount` at this rate and resume / fan out 'drain' as soon
 * as the buffer drops below the high-water mark. Dormant when nothing is
 * paused, so steady-state cost is zero.
 */
const DRAIN_CHECK_INTERVAL_MS = 100;

interface StreamMeta {
    idleTimer?: NodeJS.Timeout;
}

interface HttpStreamState extends StreamMeta {
    kind: 'http';
    res: ServerResponse;
    headersWritten: boolean;
}

interface WsStreamState extends StreamMeta {
    kind: 'ws';
    rawSocket?: Socket;
    rawHead?: Buffer;
    upgradeRequest: IncomingMessage;
    clientWs?: WebSocket;
}

interface TcpStreamState extends StreamMeta {
    kind: 'tcp';
    handle: TcpStream;
    bytesIn: number;
    bytesOut: number;
    openedAt: number;
    accepted: boolean;
}

type StreamState = HttpStreamState | WsStreamState | TcpStreamState;

export interface TcpStreamSummary {
    streamId: number;
    bytesIn: number;
    bytesOut: number;
    openedAt: number;
}

/**
 * Sencho Mesh TCP stream handle. EventEmitter-based duplex-like surface that
 * MeshService consumes to bridge a local socket to a Compose service on the
 * remote node behind this pilot tunnel.
 *
 * Events:
 *   'open'         tcp_open_ack ok received; safe to write/read
 *   'data' (Buffer) bytes from the remote socket
 *   'drain'        send buffer below high-water mark
 *   'error' (err)  open rejected or mid-stream tunnel error
 *   'close'        stream closed (graceful or otherwise)
 */
export class TcpStream extends EventEmitter {
    public readonly streamId: number;
    private readonly bridge: PilotTunnelBridge;

    constructor(streamId: number, bridge: PilotTunnelBridge) {
        super();
        this.streamId = streamId;
        this.bridge = bridge;
    }

    /**
     * Returns false when the underlying tunnel buffer is above the high-water
     * mark; caller should pause its source until 'drain' fires.
     */
    public write(chunk: Buffer): boolean {
        return this.bridge._writeTcpData(this.streamId, chunk);
    }

    public end(): void {
        this.bridge._closeTcpStream(this.streamId);
    }

    public destroy(): void {
        this.end();
    }
}

/**
 * Per-tunnel bridge: hosts a loopback HTTP server that demuxes requests into
 * wire frames sent over the pilot WebSocket, and remuxes response frames back
 * to the loopback caller.
 *
 * The primary's existing http-proxy-middleware setup treats the loopback URL
 * as just another remote target, so HTTP and WebSocket proxy logic, header
 * stripping/injection, and license-tier propagation all work unchanged.
 */
export class PilotTunnelBridge extends EventEmitter {
    private readonly tunnelWs: WebSocket;
    private readonly loopback: HttpServer;
    private readonly wsUpgradeServer: WebSocketServer;
    private readonly streamIds = new StreamIdAllocator();
    private readonly streams = new Map<number, StreamState>();
    private readonly connectedAt = Date.now();
    private readonly pausedReqs = new Map<number, IncomingMessage>();
    private loopbackUrl = '';
    private pingTimer?: NodeJS.Timeout;
    private drainTimer?: NodeJS.Timeout;
    private closed = false;

    constructor(_nodeId: number, tunnelWs: WebSocket) {
        super();
        this.tunnelWs = tunnelWs;
        this.loopback = http.createServer();
        this.wsUpgradeServer = new WebSocketServer({ noServer: true });

        this.loopback.on('request', (req, res) => this.handleLoopbackRequest(req, res));
        this.loopback.on('upgrade', (req, socket, head) => this.handleLoopbackUpgrade(req, socket as Socket, head));
        this.loopback.on('clientError', (_err, socket) => {
            try { socket.destroy(); } catch { /* ignore */ }
        });

        this.tunnelWs.on('message', (data, isBinary) => this.handleTunnelMessage(data, isBinary));
        this.tunnelWs.on('close', () => this.onTunnelClose());
        this.tunnelWs.on('error', () => this.onTunnelClose());
    }

    public async start(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const onError = (err: Error) => reject(err);
            this.loopback.once('error', onError);
            this.loopback.listen(0, '127.0.0.1', () => {
                const addr = this.loopback.address();
                if (!addr || typeof addr === 'string') {
                    reject(new Error('loopback server returned unexpected address'));
                    return;
                }
                this.loopbackUrl = `http://127.0.0.1:${addr.port}`;
                this.loopback.removeListener('error', onError);
                resolve();
            });
        });
        this.pingTimer = setInterval(() => {
            if (this.tunnelWs.readyState !== WebSocket.OPEN) return;
            try { this.tunnelWs.ping(); } catch { /* surfaced via 'error' */ }
        }, PING_INTERVAL_MS);
    }

    public getLoopbackUrl(): string { return this.loopbackUrl; }
    public getConnectedAt(): number { return this.connectedAt; }
    public getBufferedAmount(): number { return this.tunnelWs.bufferedAmount; }
    public isOpen(): boolean { return !this.closed && this.tunnelWs.readyState === WebSocket.OPEN; }

    /**
     * Open a TCP stream to a Compose service on the remote node. Caller listens
     * on the returned TcpStream for 'open' (when the remote agent has accepted),
     * 'data', 'error', and 'close'. Returns null if the tunnel is not open.
     */
    public openTcpStream(target: { stack: string; service: string; port: number }): TcpStream | null {
        if (!this.isOpen()) return null;
        if (this.streams.size >= MAX_STREAMS_PER_TUNNEL) return null;
        const streamId = this.streamIds.allocate();
        const handle = new TcpStream(streamId, this);
        const state: TcpStreamState = {
            kind: 'tcp',
            handle,
            bytesIn: 0,
            bytesOut: 0,
            openedAt: Date.now(),
            accepted: false,
        };
        this.streams.set(streamId, state);
        this.refreshIdleTimer(streamId, state);
        this.sendJson({
            t: 'tcp_open',
            s: streamId,
            stack: target.stack,
            service: target.service,
            port: target.port,
        });
        return handle;
    }

    /**
     * @internal Called only by TcpStream.write; applies the same 4 MB
     * backpressure rule used by HTTP request bodies. Public for cross-class
     * access only; not part of the bridge's outward API.
     */
    public _writeTcpData(streamId: number, payload: Buffer): boolean {
        const s = this.streams.get(streamId);
        if (!s || s.kind !== 'tcp') return false;
        if (!this.isOpen()) return false;
        this.sendBinary(BinaryFrameType.TcpData, streamId, payload);
        s.bytesOut += payload.length;
        this.refreshIdleTimer(streamId, s);
        return this.tunnelWs.bufferedAmount <= BUFFER_HIGH_WATER_MARK;
    }

    /** @internal Called only by TcpStream.end / .destroy. */
    public _closeTcpStream(streamId: number): void {
        const s = this.streams.get(streamId);
        if (!s) return;
        this.clearIdleTimer(s);
        this.streams.delete(streamId);
        this.sendJson({ t: 'tcp_close', s: streamId });
    }

    /**
     * Snapshot of active TCP streams for the diagnostics sheet. Cheap; called
     * on demand by MeshService.
     */
    public listTcpStreams(): TcpStreamSummary[] {
        const out: TcpStreamSummary[] = [];
        for (const [streamId, s] of this.streams) {
            if (s.kind === 'tcp') {
                out.push({ streamId, bytesIn: s.bytesIn, bytesOut: s.bytesOut, openedAt: s.openedAt });
            }
        }
        return out;
    }

    public close(code = 1000, reason = 'closed by primary'): void {
        if (this.closed) return;
        this.closed = true;
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = undefined; }
        this.stopDrainTimer();
        this.pausedReqs.clear();

        for (const [, state] of this.streams) {
            this.clearIdleTimer(state);
            this.teardownStream(state);
        }
        this.streams.clear();

        try { this.tunnelWs.close(code, reason); } catch { /* ignore */ }
        try { this.loopback.close(); } catch { /* ignore */ }
        try { this.wsUpgradeServer.close(); } catch { /* ignore */ }
        this.emit('closed');
    }

    // --- Loopback HTTP ingress ---

    private handleLoopbackRequest(req: IncomingMessage, res: ServerResponse): void {
        if (this.closed || this.tunnelWs.readyState !== WebSocket.OPEN) {
            res.statusCode = 502;
            res.end('pilot tunnel not ready');
            return;
        }
        if (this.streams.size >= MAX_STREAMS_PER_TUNNEL) {
            res.statusCode = 503;
            res.setHeader('content-type', 'text/plain');
            res.end('pilot tunnel: stream cap reached');
            return;
        }

        const streamId = this.streamIds.allocate();
        const state: HttpStreamState = { kind: 'http', res, headersWritten: false };
        this.streams.set(streamId, state);
        this.refreshIdleTimer(streamId, state);

        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === 'string') headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(', ');
        }

        this.sendJson({
            t: 'http_req',
            s: streamId,
            method: req.method || 'GET',
            path: req.url || '/',
            headers,
        });

        req.on('data', (chunk: Buffer) => {
            const s = this.streams.get(streamId);
            if (!s) return;
            this.sendBinary(BinaryFrameType.HttpReqBody, streamId, chunk);
            this.refreshIdleTimer(streamId, s);
            if (this.tunnelWs.bufferedAmount > BUFFER_HIGH_WATER_MARK) {
                this.pauseRequest(streamId, req);
            }
        });
        req.on('end', () => {
            if (!this.streams.has(streamId)) return;
            this.sendJson({ t: 'http_req_end', s: streamId });
        });
        req.on('error', () => {
            const s = this.streams.get(streamId);
            if (s) this.teardownStream(s);
            this.streams.delete(streamId);
        });

        res.on('close', () => {
            // Client disconnected before response finished.
            const s = this.streams.get(streamId);
            if (s) {
                this.clearIdleTimer(s);
                this.streams.delete(streamId);
                this.sendJson({ t: 'http_err', s: streamId, code: 'tunnel_down', message: 'client aborted' });
            }
        });
    }

    private handleLoopbackUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
        if (this.closed || this.tunnelWs.readyState !== WebSocket.OPEN) {
            socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            socket.destroy();
            return;
        }
        if (this.streams.size >= MAX_STREAMS_PER_TUNNEL) {
            socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
            socket.destroy();
            return;
        }

        const streamId = this.streamIds.allocate();
        const state: WsStreamState = {
            kind: 'ws',
            rawSocket: socket,
            rawHead: head,
            upgradeRequest: req,
        };
        this.streams.set(streamId, state);
        this.refreshIdleTimer(streamId, state);

        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === 'string') headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(', ');
        }

        this.sendJson({
            t: 'ws_open',
            s: streamId,
            path: req.url || '/',
            headers,
        });

        socket.on('error', () => {
            const s = this.streams.get(streamId);
            if (s) this.teardownStream(s);
            this.streams.delete(streamId);
        });
        socket.on('close', () => {
            const s = this.streams.get(streamId);
            if (s) {
                this.clearIdleTimer(s);
                this.sendJson({ t: 'ws_close', s: streamId, code: 1006, reason: 'client closed' });
                this.streams.delete(streamId);
            }
        });
    }

    // --- Tunnel ingress (frames from agent) ---

    private handleTunnelMessage(data: unknown, isBinary: boolean): void {
        if (this.closed) return;
        try {
            if (isBinary) {
                const buf = wsDataToBuffer(data);
                if (!buf) return;
                this.handleBinaryFrame(decodeBinaryFrame(buf));
            } else {
                const text = wsDataToString(data);
                if (text == null) return;
                const frame = decodeJsonFrame(text);
                this.handleJsonFrame(frame);
            }
        } catch (err) {
            // Malformed frame: kill the tunnel to force re-sync. Diag-gated
            // so a flood of malformed frames cannot drown the log; the
            // tunnel close itself is the loud signal.
            PilotMetrics.increment('frame_decode_errors');
            if (isDebugEnabled()) {
                console.warn('[PilotBridge:diag] Malformed frame from agent:', sanitizeForLog((err as Error).message));
            }
            this.close(1002, 'protocol error');
        }
    }

    private handleJsonFrame(frame: ReturnType<typeof decodeJsonFrame>): void {
        switch (frame.t) {
            case 'http_res': {
                const s = this.streams.get(frame.s);
                if (!s || s.kind !== 'http') return;
                if (!s.headersWritten) {
                    try {
                        s.res.writeHead(frame.status, frame.headers);
                    } catch { /* headers already sent or invalid */ }
                    s.headersWritten = true;
                }
                this.refreshIdleTimer(frame.s, s);
                break;
            }
            case 'http_res_end': {
                const s = this.streams.get(frame.s);
                if (!s || s.kind !== 'http') return;
                try { s.res.end(); } catch { /* ignore */ }
                this.removeStream(frame.s);
                break;
            }
            case 'http_err': {
                const s = this.streams.get(frame.s);
                if (!s) return;
                if (s.kind === 'http' && !s.headersWritten) {
                    try {
                        s.res.writeHead(502, { 'content-type': 'text/plain' });
                        s.res.end(`pilot tunnel error: ${frame.code} ${frame.message}`);
                    } catch { /* ignore */ }
                } else {
                    this.teardownStream(s);
                }
                this.removeStream(frame.s);
                break;
            }
            case 'ws_accept': {
                const s = this.streams.get(frame.s);
                if (!s || s.kind !== 'ws' || !s.rawSocket || !s.rawHead) return;
                this.wsUpgradeServer.handleUpgrade(s.upgradeRequest, s.rawSocket, s.rawHead, (ws) => {
                    s.clientWs = ws;
                    s.rawSocket = undefined;
                    s.rawHead = undefined;
                    this.refreshIdleTimer(frame.s, s);
                    ws.on('message', (msg, isBin) => {
                        const cur = this.streams.get(frame.s);
                        if (cur) this.refreshIdleTimer(frame.s, cur);
                        if (isBin) {
                            this.sendBinary(BinaryFrameType.WsMessageBinary, frame.s, wsDataToBuffer(msg) ?? Buffer.alloc(0));
                        } else {
                            this.sendJson({ t: 'ws_msg_text', s: frame.s, data: wsDataToString(msg) ?? '' });
                        }
                    });
                    ws.on('close', (code, reason) => {
                        if (this.streams.has(frame.s)) {
                            this.sendJson({ t: 'ws_close', s: frame.s, code, reason: reason?.toString?.() });
                            this.removeStream(frame.s);
                        }
                    });
                    ws.on('error', () => {
                        if (this.streams.has(frame.s)) this.removeStream(frame.s);
                    });
                });
                break;
            }
            case 'ws_reject': {
                const s = this.streams.get(frame.s);
                if (!s || s.kind !== 'ws' || !s.rawSocket) return;
                try {
                    s.rawSocket.write(`HTTP/1.1 ${frame.status} ${frame.message}\r\n\r\n`);
                    s.rawSocket.destroy();
                } catch { /* ignore */ }
                this.removeStream(frame.s);
                break;
            }
            case 'ws_msg_text': {
                const s = this.streams.get(frame.s);
                if (!s || s.kind !== 'ws' || !s.clientWs) return;
                try { s.clientWs.send(frame.data); } catch { /* ignore */ }
                this.refreshIdleTimer(frame.s, s);
                break;
            }
            case 'ws_close': {
                const s = this.streams.get(frame.s);
                if (!s || s.kind !== 'ws') return;
                if (s.clientWs) {
                    try { s.clientWs.close(frame.code, frame.reason); } catch { /* ignore */ }
                } else if (s.rawSocket) {
                    try { s.rawSocket.destroy(); } catch { /* ignore */ }
                }
                this.removeStream(frame.s);
                break;
            }
            case 'ctrl': {
                // Primary-side bridge does not act on control ops today; the
                // upgrade handler consumes enroll_ack before registerTunnel is
                // called, and ping/pong are handled by the WS layer.
                break;
            }
            case 'tcp_open_ack': {
                const s = this.streams.get(frame.s);
                if (!s || s.kind !== 'tcp') return;
                if (frame.ok) {
                    s.accepted = true;
                    this.refreshIdleTimer(frame.s, s);
                    s.handle.emit('open');
                } else {
                    this.removeStream(frame.s);
                    s.handle.emit('error', new Error(frame.err ?? 'tcp_open rejected'));
                    s.handle.emit('close');
                }
                break;
            }
            case 'tcp_close': {
                const s = this.streams.get(frame.s);
                if (!s || s.kind !== 'tcp') return;
                this.removeStream(frame.s);
                s.handle.emit('close');
                break;
            }
            default:
                // Ignore unknown JSON frame types for forward compatibility.
                break;
        }
    }

    private handleBinaryFrame(frame: DecodedBinaryFrame): void {
        const s = this.streams.get(frame.streamId);
        if (!s) return;
        switch (frame.type) {
            case BinaryFrameType.HttpResBody: {
                if (s.kind !== 'http') return;
                if (!s.headersWritten) {
                    // Agent sent body before headers; synthesize 200 so we don't drop data.
                    try { s.res.writeHead(200); } catch { /* ignore */ }
                    s.headersWritten = true;
                }
                try { s.res.write(frame.payload); } catch { /* ignore */ }
                this.refreshIdleTimer(frame.streamId, s);
                break;
            }
            case BinaryFrameType.WsMessageBinary: {
                if (s.kind !== 'ws' || !s.clientWs) return;
                try { s.clientWs.send(frame.payload, { binary: true }); } catch { /* ignore */ }
                this.refreshIdleTimer(frame.streamId, s);
                break;
            }
            case BinaryFrameType.HttpReqBody:
                // Agent never originates request bodies; ignore for defense-in-depth.
                break;
            case BinaryFrameType.TcpData: {
                if (s.kind !== 'tcp') return;
                s.bytesIn += frame.payload.length;
                this.refreshIdleTimer(frame.streamId, s);
                s.handle.emit('data', frame.payload);
                break;
            }
            default:
                break;
        }
    }

    private onTunnelClose(): void {
        if (this.closed) return;
        this.close(1006, 'tunnel closed');
    }

    // --- Helpers ---

    private pauseRequest(streamId: number, req: IncomingMessage): void {
        if (this.pausedReqs.has(streamId)) return;
        try { req.pause(); } catch { /* ignore */ }
        this.pausedReqs.set(streamId, req);
        if (!this.drainTimer) {
            this.drainTimer = setInterval(() => this.checkDrain(), DRAIN_CHECK_INTERVAL_MS);
        }
    }

    private checkDrain(): void {
        if (this.closed) {
            this.stopDrainTimer();
            return;
        }
        if (this.tunnelWs.bufferedAmount > BUFFER_HIGH_WATER_MARK) return;
        for (const [, req] of this.pausedReqs) {
            try { req.resume(); } catch { /* ignore */ }
        }
        this.pausedReqs.clear();
        // Also let any TCP-stream caller waiting on backpressure proceed.
        for (const s of this.streams.values()) {
            if (s.kind === 'tcp' && s.accepted) s.handle.emit('drain');
        }
        this.stopDrainTimer();
    }

    private stopDrainTimer(): void {
        if (this.drainTimer) {
            clearInterval(this.drainTimer);
            this.drainTimer = undefined;
        }
    }

    private refreshIdleTimer(streamId: number, state: StreamState): void {
        if (state.idleTimer) clearTimeout(state.idleTimer);
        state.idleTimer = setTimeout(() => this.onStreamIdle(streamId), STREAM_IDLE_TIMEOUT_MS);
    }

    private clearIdleTimer(state: StreamState): void {
        if (state.idleTimer) {
            clearTimeout(state.idleTimer);
            state.idleTimer = undefined;
        }
    }

    private removeStream(streamId: number): void {
        const s = this.streams.get(streamId);
        if (!s) return;
        this.clearIdleTimer(s);
        this.streams.delete(streamId);
    }

    private onStreamIdle(streamId: number): void {
        const s = this.streams.get(streamId);
        if (!s) return;
        // Tear down the loopback side and tell the agent to release its half.
        this.teardownStream(s);
        this.streams.delete(streamId);
        if (s.kind === 'tcp') {
            this.sendJson({ t: 'tcp_close', s: streamId });
        } else if (s.kind === 'ws') {
            this.sendJson({ t: 'ws_close', s: streamId, code: 1001, reason: 'idle' });
        } else {
            this.sendJson({ t: 'http_err', s: streamId, code: 'timeout', message: 'stream idle timeout' });
        }
    }

    private sendJson(frame: Parameters<typeof encodeJsonFrame>[0]): void {
        if (this.tunnelWs.readyState !== WebSocket.OPEN) return;
        try { this.tunnelWs.send(encodeJsonFrame(frame)); } catch { /* ignore */ }
    }

    private sendBinary(type: BinaryFrameType, streamId: number, payload: Buffer): void {
        if (this.tunnelWs.readyState !== WebSocket.OPEN) return;
        try { this.tunnelWs.send(encodeBinaryFrame(type, streamId, payload), { binary: true }); } catch { /* ignore */ }
    }

    private teardownStream(state: StreamState): void {
        if (state.kind === 'http') {
            try {
                if (!state.headersWritten) {
                    state.res.writeHead(502, { 'content-type': 'text/plain' });
                    state.res.end('pilot tunnel closed');
                } else {
                    state.res.end();
                }
            } catch { /* ignore */ }
        } else if (state.kind === 'ws') {
            if (state.clientWs) {
                try { state.clientWs.close(1011, 'tunnel closed'); } catch { /* ignore */ }
            } else if (state.rawSocket) {
                try { state.rawSocket.destroy(); } catch { /* ignore */ }
            }
        } else {
            try {
                if (!state.accepted) state.handle.emit('error', new Error('tunnel closed before accept'));
                state.handle.emit('close');
            } catch { /* ignore */ }
        }
    }
}
