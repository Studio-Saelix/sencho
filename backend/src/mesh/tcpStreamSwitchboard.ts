import net from 'net';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import {
    AGENT_REVERSE_ID_BASE,
    BinaryFrameType,
    DecodedBinaryFrame,
    JsonFrame,
    MAX_STREAMS_PER_TUNNEL,
    MeshErrCode,
    STREAM_IDLE_TIMEOUT_MS,
    StreamIdAllocator,
    encodeBinaryFrame,
    encodeJsonFrame,
} from '../pilot/protocol';
import { sanitizeForLog } from '../utils/safeLog';

/**
 * Sencho Mesh TCP stream switchboard.
 *
 * Owns the "agent side" of the mesh frame protocol: accept `tcp_open`,
 * resolve a target by Compose labels, dial a local container, and splice
 * bytes via `TcpData` frames in both directions. Also owns the outbound
 * `tcp_open_reverse` allocator so the local MeshForwarder can emit reverse
 * streams when its meshed containers dial cross-node aliases.
 *
 * Single source of truth for the protocol's "agent" behavior. Two callers:
 *
 *   - `backend/src/pilot/agent.ts` — pilot-mode WS client. Mesh ws is the
 *     long-lived pilot tunnel; the agent threads its HTTP and WebSocket
 *     stream count into `extraStreamCount` so the per-tunnel cap is shared.
 *
 *   - `backend/src/websocket/meshProxyTunnel.ts` — proxy-mode WS server.
 *     Mesh ws is a short-lived central-initiated tunnel that only carries
 *     TCP frames; `extraStreamCount` defaults to 0.
 *
 * The switchboard does not touch authentication or lifecycle; callers
 * authenticate the WS upgrade themselves and decide when to call
 * `cleanup()` on disconnect. State held here (`tcpStreams`,
 * `reverseTcpStreams`, `reverseStreamIds`, per-stream idle timers) is
 * scoped to a single WS instance — recreate the switchboard on reconnect.
 */
export const MESH_CONNECT_TIMEOUT_MS = 10_000;

export type MeshResolveResult =
    | { ok: true; host: string; port: number }
    | { ok: false; err: MeshErrCode };

export type ResolveTarget = (stack: string, service: string, port: number) => Promise<MeshResolveResult>;

export interface SwitchboardCtx {
    /** Per-connection WebSocket. The switchboard sends frames on this and never reassigns it; recreate the switchboard on reconnect. */
    ws: WebSocket;
    /** Resolve `stack`+`service`+`port` to a TCP target. Implementations typically query Dockerode by Compose labels. */
    resolveTarget: ResolveTarget;
    /** Non-mesh streams sharing the per-tunnel cap (e.g., the pilot's HTTP + WS multiplex). 0 for pure-TCP tunnels. */
    extraStreamCount?: () => number;
    /** Diagnostic prefix for log lines emitted from this switchboard. */
    logLabel?: string;
}

interface ForwardTcpStream {
    socket: net.Socket;
    accepted: boolean;
}

/**
 * Handle returned by `openReverseStream` to MeshService. Mirrors the
 * surface of `PilotTunnelBridge.TcpStream` (write/end/destroy +
 * 'open'/'data'/'error'/'close' events) so MeshService.openCrossNode can
 * splice bytes against it without caring whether the underlying tunnel is
 * a pilot tunnel or a proxy-mode tunnel.
 */
export class ReverseTcpStreamHandle extends EventEmitter {
    public readonly streamId: number;
    private readonly sendData: (streamId: number, payload: Buffer) => void;
    private readonly sendClose: (streamId: number) => void;
    private closed = false;

    constructor(
        streamId: number,
        sendData: (streamId: number, payload: Buffer) => void,
        sendClose: (streamId: number) => void,
    ) {
        super();
        this.streamId = streamId;
        this.sendData = sendData;
        this.sendClose = sendClose;
    }

    public write(chunk: Buffer): boolean {
        if (this.closed) return false;
        this.sendData(this.streamId, chunk);
        return true;
    }

    public end(): void {
        if (this.closed) return;
        this.closed = true;
        this.sendClose(this.streamId);
    }

    public destroy(): void { this.end(); }

    /** @internal Called by the switchboard on inbound `tcp_open_ack { ok: true }`. */
    public _dispatchOpen(): void { this.emit('open'); }
    /** @internal Called by the switchboard on inbound `TcpData` for this stream. */
    public _dispatchData(chunk: Buffer): void { this.emit('data', chunk); }
    /** @internal Called by the switchboard on tunnel-side error or rejection. */
    public _dispatchError(err: Error): void { this.emit('error', err); }
    /** @internal Called by the switchboard on tunnel-side close. */
    public _dispatchClose(): void {
        if (this.closed) return;
        this.closed = true;
        this.emit('close');
    }
}

export class TcpStreamSwitchboard {
    private readonly ctx: SwitchboardCtx;
    private readonly logLabel: string;
    private readonly tcpStreams = new Map<number, ForwardTcpStream>();
    private readonly reverseTcpStreams = new Map<number, ReverseTcpStreamHandle>();
    private reverseStreamIds = new StreamIdAllocator(AGENT_REVERSE_ID_BASE);
    private readonly idleTimers = new Map<number, NodeJS.Timeout>();

    constructor(ctx: SwitchboardCtx) {
        this.ctx = ctx;
        this.logLabel = ctx.logLabel || 'Mesh';
    }

    /** Active mesh stream count (forward + reverse) owned by this switchboard. */
    public tcpStreamCount(): number {
        return this.tcpStreams.size + this.reverseTcpStreams.size;
    }

    private totalStreamCount(): number {
        return this.tcpStreamCount() + (this.ctx.extraStreamCount?.() ?? 0);
    }

    private refreshIdleTimer(streamId: number): void {
        const existing = this.idleTimers.get(streamId);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => this.onStreamIdle(streamId), STREAM_IDLE_TIMEOUT_MS);
        this.idleTimers.set(streamId, timer);
    }

    private clearIdleTimer(streamId: number): void {
        const timer = this.idleTimers.get(streamId);
        if (timer) {
            clearTimeout(timer);
            this.idleTimers.delete(streamId);
        }
    }

    private onStreamIdle(streamId: number): void {
        this.idleTimers.delete(streamId);
        const ws = this.ctx.ws;
        const fwd = this.tcpStreams.get(streamId);
        if (fwd) {
            try { fwd.socket.destroy(); } catch { /* ignore */ }
            this.tcpStreams.delete(streamId);
            try { ws.send(encodeJsonFrame({ t: 'tcp_close', s: streamId })); } catch { /* ignore */ }
            return;
        }
        const reverse = this.reverseTcpStreams.get(streamId);
        if (reverse) {
            this.reverseTcpStreams.delete(streamId);
            reverse._dispatchError(new Error('mesh idle timeout'));
            reverse._dispatchClose();
            try { ws.send(encodeJsonFrame({ t: 'tcp_close', s: streamId })); } catch { /* ignore */ }
        }
    }

    /**
     * Dispatch a JSON frame. Returns true when the frame matched one of the
     * TCP-related types and was handled; false otherwise so the caller's
     * outer dispatcher can route HTTP / WS / control frames.
     */
    public handleJsonFrame(frame: JsonFrame): boolean {
        switch (frame.t) {
            case 'tcp_open':
                void this.onTcpOpen(frame);
                return true;
            case 'tcp_open_ack':
                if (frame.s < AGENT_REVERSE_ID_BASE) return false;
                this.onTcpOpenAckReverse(frame);
                return true;
            case 'tcp_close':
                this.onTcpClose(frame.s);
                return true;
            default:
                return false;
        }
    }

    /**
     * Dispatch a binary frame. Returns true iff the frame is `TcpData` (the
     * only binary type owned by the switchboard).
     */
    public handleBinaryFrame(frame: DecodedBinaryFrame): boolean {
        if (frame.type !== BinaryFrameType.TcpData) return false;
        if (frame.streamId >= AGENT_REVERSE_ID_BASE) {
            const reverse = this.reverseTcpStreams.get(frame.streamId);
            if (!reverse) return true;
            reverse._dispatchData(frame.payload);
            this.refreshIdleTimer(frame.streamId);
            return true;
        }
        const fwd = this.tcpStreams.get(frame.streamId);
        if (!fwd) return true;
        try { fwd.socket.write(frame.payload); } catch { /* ignore */ }
        this.refreshIdleTimer(frame.streamId);
        return true;
    }

    private async onTcpOpen(frame: { s: number; stack: string; service: string; port: number }): Promise<void> {
        const ws = this.ctx.ws;
        if (this.totalStreamCount() >= MAX_STREAMS_PER_TUNNEL) {
            try {
                ws.send(encodeJsonFrame({ t: 'tcp_open_ack', s: frame.s, ok: false, err: 'agent_error' }));
            } catch { /* ignore */ }
            return;
        }

        const target = await this.ctx.resolveTarget(frame.stack, frame.service, frame.port);
        if (!target.ok) {
            try {
                ws.send(encodeJsonFrame({ t: 'tcp_open_ack', s: frame.s, ok: false, err: target.err }));
            } catch { /* ignore */ }
            return;
        }

        const socket = net.createConnection({ host: target.host, port: target.port });
        socket.setTimeout(MESH_CONNECT_TIMEOUT_MS);
        const entry: ForwardTcpStream = { socket, accepted: false };
        this.tcpStreams.set(frame.s, entry);
        this.refreshIdleTimer(frame.s);

        const sendAck = (ok: boolean, err?: MeshErrCode) => {
            try { ws.send(encodeJsonFrame({ t: 'tcp_open_ack', s: frame.s, ok, err })); } catch { /* ignore */ }
        };

        socket.once('connect', () => {
            entry.accepted = true;
            socket.setTimeout(0);
            sendAck(true);
            this.refreshIdleTimer(frame.s);
        });
        socket.on('data', (chunk: Buffer) => {
            try {
                ws.send(encodeBinaryFrame(BinaryFrameType.TcpData, frame.s, chunk), { binary: true });
            } catch { /* ignore */ }
            this.refreshIdleTimer(frame.s);
        });
        socket.on('timeout', () => {
            if (entry.accepted) return;
            entry.accepted = true;
            sendAck(false, 'unreachable');
            this.tcpStreams.delete(frame.s);
            this.clearIdleTimer(frame.s);
            try { socket.destroy(); } catch { /* ignore */ }
        });
        socket.on('error', (err) => {
            if (!entry.accepted) {
                entry.accepted = true;
                sendAck(false, 'unreachable');
                this.tcpStreams.delete(frame.s);
                this.clearIdleTimer(frame.s);
                return;
            }
            console.warn(`[${this.logLabel}] tcp stream error:`, sanitizeForLog(err.message));
            if (this.tcpStreams.delete(frame.s)) {
                this.clearIdleTimer(frame.s);
                try { ws.send(encodeJsonFrame({ t: 'tcp_close', s: frame.s })); } catch { /* ignore */ }
            }
        });
        socket.on('close', () => {
            if (this.tcpStreams.delete(frame.s)) {
                this.clearIdleTimer(frame.s);
                try { ws.send(encodeJsonFrame({ t: 'tcp_close', s: frame.s })); } catch { /* ignore */ }
            }
        });
    }

    private onTcpClose(streamId: number): void {
        if (streamId >= AGENT_REVERSE_ID_BASE) {
            const handle = this.reverseTcpStreams.get(streamId);
            if (!handle) return;
            this.reverseTcpStreams.delete(streamId);
            this.clearIdleTimer(streamId);
            handle._dispatchClose();
            return;
        }
        const entry = this.tcpStreams.get(streamId);
        if (!entry) return;
        this.tcpStreams.delete(streamId);
        this.clearIdleTimer(streamId);
        try { entry.socket.destroy(); } catch { /* ignore */ }
    }

    private onTcpOpenAckReverse(frame: { s: number; ok: boolean; err?: MeshErrCode }): void {
        const handle = this.reverseTcpStreams.get(frame.s);
        if (!handle) return;
        if (frame.ok) {
            handle._dispatchOpen();
            this.refreshIdleTimer(frame.s);
        } else {
            this.reverseTcpStreams.delete(frame.s);
            this.clearIdleTimer(frame.s);
            handle._dispatchError(new Error(frame.err ?? 'tcp_open_reverse rejected'));
            handle._dispatchClose();
        }
    }

    /**
     * Allocate a reverse stream id, send `tcp_open_reverse`, and return a
     * handle MeshService can splice bytes through. Returns null if the WS
     * is not OPEN or the per-tunnel cap is reached.
     */
    public openReverseStream(target: { nodeId: number; stack: string; service: string; port: number }): ReverseTcpStreamHandle | null {
        const ws = this.ctx.ws;
        if (ws.readyState !== WebSocket.OPEN) return null;
        if (this.totalStreamCount() >= MAX_STREAMS_PER_TUNNEL) return null;
        const streamId = this.reverseStreamIds.allocate();
        const handle = new ReverseTcpStreamHandle(
            streamId,
            (sid, payload) => {
                if (ws.readyState !== WebSocket.OPEN) return;
                try { ws.send(encodeBinaryFrame(BinaryFrameType.TcpData, sid, payload), { binary: true }); } catch { /* ignore */ }
                this.refreshIdleTimer(sid);
            },
            (sid) => {
                if (!this.reverseTcpStreams.has(sid)) return;
                this.reverseTcpStreams.delete(sid);
                this.clearIdleTimer(sid);
                if (ws.readyState !== WebSocket.OPEN) return;
                try { ws.send(encodeJsonFrame({ t: 'tcp_close', s: sid })); } catch { /* ignore */ }
            },
        );
        this.reverseTcpStreams.set(streamId, handle);
        this.refreshIdleTimer(streamId);
        try {
            ws.send(encodeJsonFrame({
                t: 'tcp_open_reverse',
                s: streamId,
                targetNodeId: target.nodeId,
                stack: target.stack,
                service: target.service,
                port: target.port,
            }));
        } catch (err) {
            this.reverseTcpStreams.delete(streamId);
            this.clearIdleTimer(streamId);
            handle._dispatchError(err as Error);
            handle._dispatchClose();
            return null;
        }
        return handle;
    }

    /**
     * Tear down all stream state. Call on WS disconnect; the next
     * connection should construct a fresh switchboard.
     */
    public cleanup(reason = 'mesh tunnel closed'): void {
        for (const [, entry] of this.tcpStreams) {
            try { entry.socket.destroy(); } catch { /* ignore */ }
        }
        this.tcpStreams.clear();
        for (const [, handle] of this.reverseTcpStreams) {
            try {
                handle._dispatchError(new Error(reason));
                handle._dispatchClose();
            } catch { /* ignore */ }
        }
        this.reverseTcpStreams.clear();
        // Reset the allocator so a long-lived caller that reconnects many
        // times doesn't drift up the id range and approach the wrap point.
        this.reverseStreamIds = new StreamIdAllocator(AGENT_REVERSE_ID_BASE);
        for (const [, timer] of this.idleTimers) clearTimeout(timer);
        this.idleTimers.clear();
    }
}

export function attachTcpStreamSwitchboard(ctx: SwitchboardCtx): TcpStreamSwitchboard {
    return new TcpStreamSwitchboard(ctx);
}

/**
 * Resolve a Compose-managed container's IP address by stack name + service
 * name. Returns the first usable IP found on any Docker network the
 * container is attached to. Used by both the pilot agent and the
 * proxy-mode WS handler.
 */
export async function resolveByComposeLabels(stack: string, service: string, port: number): Promise<MeshResolveResult> {
    try {
        const dockerodeMod = await import('dockerode');
        const Docker = (dockerodeMod as { default: new (opts?: unknown) => { listContainers: (opts?: unknown) => Promise<unknown[]> } }).default;
        const docker = new Docker();
        const containers = (await docker.listContainers({
            filters: { label: [`com.docker.compose.project=${stack}`, `com.docker.compose.service=${service}`] },
        })) as Array<{ NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> } }>;
        for (const c of containers) {
            const networks = c.NetworkSettings?.Networks ?? {};
            for (const n of Object.values(networks)) {
                if (n.IPAddress) return { ok: true, host: n.IPAddress, port };
            }
        }
        return { ok: false, err: 'no_target' };
    } catch (err) {
        console.warn('[Mesh] resolveByComposeLabels failed:', sanitizeForLog((err as Error).message));
        return { ok: false, err: 'agent_error' };
    }
}
