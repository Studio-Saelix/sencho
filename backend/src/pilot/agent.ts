import fs from 'fs';
import net from 'net';
import path from 'path';
import http from 'http';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import { getSenchoVersion } from '../services/CapabilityRegistry';
import { DatabaseService } from '../services/DatabaseService';
import { NodeRegistry } from '../services/NodeRegistry';
import {
    BinaryFrameType,
    MAX_FRAME_SIZE_BYTES,
    MAX_STREAMS_PER_TUNNEL,
    MeshErrCode,
    PROTOCOL_VERSION,
    STREAM_IDLE_TIMEOUT_MS,
    decodeBinaryFrame,
    decodeJsonFrame,
    encodeBinaryFrame,
    encodeJsonFrame,
    wsDataToBuffer,
    wsDataToString,
} from './protocol';
import { sanitizeForLog } from '../utils/safeLog';
import { isDebugEnabled } from '../utils/debug';

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const LOOPBACK_TOKEN_TTL_SECONDS = 300;
const LOOPBACK_TOKEN_REFRESH_SECONDS = 240;
const PING_INTERVAL_MS = 30_000;
const TOKEN_PATH = path.join(process.env.DATA_DIR || '/app/data', 'pilot.jwt');

/**
 * Pilot agent: dials the primary via outbound WebSocket and tunnels every
 * inbound frame to the agent's own loopback HTTP server (the fully-booted
 * Sencho app). Because the tunnel is the only ingress, the agent needs no
 * open port, no TLS certificate, and no reachable address.
 */
export function startPilotAgent(loopbackPort: number): void {
    const primaryUrl = process.env.SENCHO_PRIMARY_URL;
    if (!primaryUrl) {
        console.error('[Pilot] SENCHO_PRIMARY_URL is required when SENCHO_MODE=pilot');
        process.exit(1);
    }

    const enrollToken = process.env.SENCHO_ENROLL_TOKEN;
    const persistedToken = readPersistedToken();

    if (!enrollToken && !persistedToken) {
        console.error('[Pilot] SENCHO_ENROLL_TOKEN is required on first boot');
        process.exit(1);
    }

    const agent = new PilotAgent({
        primaryUrl,
        loopbackPort,
        initialToken: persistedToken || enrollToken!,
        enrolling: !persistedToken,
    });
    agent.start();
}

interface AgentOptions {
    primaryUrl: string;
    loopbackPort: number;
    initialToken: string;
    enrolling: boolean;
}

export class PilotAgent {
    private readonly options: AgentOptions;
    private token: string;
    private backoff = RECONNECT_MIN_MS;
    private ws: WebSocket | null = null;
    private pingTimer?: NodeJS.Timeout;
    private reconnectTimer?: NodeJS.Timeout;
    private readonly httpStreams = new Map<number, { req: http.ClientRequest }>();
    private readonly wsStreams = new Map<number, WebSocket>();
    private readonly tcpStreams = new Map<number, MeshTcpStream>();
    private readonly idleTimers = new Map<number, NodeJS.Timeout>();
    private shuttingDown = false;
    private readonly agentVersion: string;
    /**
     * Optional CA bundle read once at agent construction. Cached so that a
     * later rotation (file renamed, secret rotated) does not surprise the
     * agent with a process exit on the next reconnect; container restart is
     * the documented way to pick up a new CA bundle.
     */
    private readonly customCa: Buffer | null;

    /** Cached pilot_tunnel-scoped token signed by the LOCAL Sencho's `auth_jwt_secret`, used to authenticate forwarded HTTP and WS requests against the local loopback Sencho. */
    private loopbackToken: string | null = null;
    private loopbackTokenIssuedAt = 0;

    constructor(options: AgentOptions) {
        this.options = options;
        this.token = options.initialToken;
        this.agentVersion = getSenchoVersion() || '0.0.0';
        this.customCa = readPilotCaBundle();
    }

    /**
     * Mint or reuse a `pilot_tunnel`-scoped JWT signed by the AGENT's local
     * `auth_jwt_secret`. The central proxy strips browser cookies before it
     * forwards a request through the tunnel; without an inline auth header on
     * the loopback request, the agent's local `authMiddleware` would 401 every
     * proxied call. The token's claim shape mirrors what the central mints at
     * enrollment, so the loopback `authMiddleware` accepts it via the existing
     * `pilot_tunnel` branch with no special-case bypass.
     */
    private getLoopbackAuthHeader(): string | null {
        const now = Math.floor(Date.now() / 1000);
        if (this.loopbackToken && now - this.loopbackTokenIssuedAt < LOOPBACK_TOKEN_REFRESH_SECONDS) {
            return `Bearer ${this.loopbackToken}`;
        }
        try {
            const secret = DatabaseService.getInstance().getGlobalSettings().auth_jwt_secret;
            if (!secret) return null;
            const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
            this.loopbackToken = jwt.sign({ scope: 'pilot_tunnel', nodeId }, secret, { expiresIn: LOOPBACK_TOKEN_TTL_SECONDS });
            this.loopbackTokenIssuedAt = now;
            return `Bearer ${this.loopbackToken}`;
        } catch (err) {
            if (isDebugEnabled()) console.warn('[Pilot:diag] loopback token mint failed:', sanitizeForLog((err as Error).message));
            return null;
        }
    }

    private buildLoopbackHeaders(frameHeaders: Record<string, string>): Record<string, string> {
        const auth = this.getLoopbackAuthHeader();
        const headers: Record<string, string> = {
            ...frameHeaders,
            host: `127.0.0.1:${this.options.loopbackPort}`,
        };
        if (auth) headers.authorization = auth;
        return headers;
    }

    public start(): void {
        this.connect();
        process.on('SIGTERM', () => this.shutdown());
        process.on('SIGINT', () => this.shutdown());
    }

    private shutdown(): void {
        this.shuttingDown = true;
        if (this.pingTimer) clearInterval(this.pingTimer);
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }
        try { this.ws?.close(1000, 'agent shutdown'); } catch { /* ignore */ }
    }

    private connect(): void {
        if (this.shuttingDown) return;

        const wsUrl = this.options.primaryUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/api/pilot/tunnel';
        const ws = new WebSocket(wsUrl, {
            headers: {
                Authorization: `Bearer ${this.token}`,
                'x-sencho-agent-version': this.agentVersion,
            },
            handshakeTimeout: 15_000,
            maxPayload: MAX_FRAME_SIZE_BYTES,
            // Self-signed deployments can supply an internal CA bundle via
            // SENCHO_PILOT_CA_FILE; rejectUnauthorized stays true. There is
            // intentionally no env var to disable TLS verification — that
            // would defeat the entire trust model of the tunnel credential.
            // The bundle is read once at agent construction (this.customCa);
            // rotate by restarting the container.
            ...(this.customCa ? { ca: this.customCa } : {}),
        });
        this.ws = ws;

        ws.on('open', () => {
            // Backoff intentionally NOT reset here: a TCP-level connect that
            // immediately fails the protocol handshake (incompatible version,
            // bad token consumed at upgrade) would otherwise reset the
            // backoff and tight-loop reconnects. The reset moves to the
            // handleJsonFrame 'hello' case once we have a clean handshake.
            console.log('[Pilot] Tunnel connected to', sanitizeForLog(this.options.primaryUrl));
            try {
                ws.send(encodeJsonFrame({
                    t: 'hello',
                    version: PROTOCOL_VERSION,
                    role: 'agent',
                    agentVersion: this.agentVersion,
                }));
            } catch (err) {
                console.error('[Pilot] Failed to send hello:', (err as Error).message);
            }
            this.pingTimer = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    try { ws.ping(); } catch { /* surfaced via error */ }
                }
            }, PING_INTERVAL_MS);
        });

        ws.on('message', (data, isBinary) => this.handleFrame(data, isBinary));
        ws.on('close', (code, reason) => {
            console.log('[Pilot] Tunnel closed:', code, reason?.toString?.() ?? '');
            this.cleanupAfterDisconnect();
            this.scheduleReconnect();
        });
        ws.on('error', (err) => {
            console.warn('[Pilot] Tunnel error:', err.message);
            // 'close' will follow; reconnect is scheduled there.
        });
    }

    private cleanupAfterDisconnect(): void {
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = undefined; }
        for (const [, entry] of this.httpStreams) {
            try { entry.req.destroy(); } catch { /* ignore */ }
        }
        this.httpStreams.clear();
        for (const [, ws] of this.wsStreams) {
            try { ws.close(1006, 'tunnel closed'); } catch { /* ignore */ }
        }
        this.wsStreams.clear();
        for (const [, stream] of this.tcpStreams) {
            try { stream.socket.destroy(); } catch { /* ignore */ }
        }
        this.tcpStreams.clear();
        for (const [, timer] of this.idleTimers) clearTimeout(timer);
        this.idleTimers.clear();
    }

    private streamCount(): number {
        return this.httpStreams.size + this.wsStreams.size + this.tcpStreams.size;
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
        const ws = this.ws;
        const httpEntry = this.httpStreams.get(streamId);
        if (httpEntry) {
            try { httpEntry.req.destroy(); } catch { /* ignore */ }
            this.httpStreams.delete(streamId);
            if (ws) {
                try { ws.send(encodeJsonFrame({ t: 'http_err', s: streamId, code: 'timeout', message: 'agent idle timeout' })); } catch { /* ignore */ }
            }
            return;
        }
        const wsEntry = this.wsStreams.get(streamId);
        if (wsEntry) {
            try { wsEntry.close(1001, 'idle'); } catch { /* ignore */ }
            this.wsStreams.delete(streamId);
            if (ws) {
                try { ws.send(encodeJsonFrame({ t: 'ws_close', s: streamId, code: 1001, reason: 'idle' })); } catch { /* ignore */ }
            }
            return;
        }
        const tcpEntry = this.tcpStreams.get(streamId);
        if (tcpEntry) {
            try { tcpEntry.socket.destroy(); } catch { /* ignore */ }
            this.tcpStreams.delete(streamId);
            if (ws) {
                try { ws.send(encodeJsonFrame({ t: 'tcp_close', s: streamId })); } catch { /* ignore */ }
            }
        }
    }

    private scheduleReconnect(): void {
        if (this.shuttingDown) return;
        const jitter = Math.floor(Math.random() * 500);
        const delay = this.backoff + jitter;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.connect();
        }, delay);
        this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
    }

    private handleFrame(data: unknown, isBinary: boolean): void {
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
            // Per-frame; diag-gated to avoid log floods from a misbehaving
            // primary or a malformed frame arriving in a tight loop.
            if (isDebugEnabled()) console.warn('[Pilot:diag] Malformed frame from primary:', sanitizeForLog((err as Error).message));
        }
    }

    private handleJsonFrame(frame: ReturnType<typeof decodeJsonFrame>): void {
        const ws = this.ws;
        if (!ws) return;
        switch (frame.t) {
            case 'hello': {
                if (frame.version !== PROTOCOL_VERSION) {
                    console.error(`[Pilot] Protocol version ${sanitizeForLog(frame.version)} from primary is incompatible with agent (${PROTOCOL_VERSION}); exiting.`);
                    this.shuttingDown = true;
                    try { ws.close(1002, 'incompatible version'); } catch { /* ignore */ }
                    process.exit(1);
                }
                // Clean handshake: it is now safe to reset the reconnect
                // backoff. Doing this earlier (in 'open') would let a peer
                // that always rejects the handshake drive us into a tight
                // reconnect loop.
                this.backoff = RECONNECT_MIN_MS;
                break;
            }
            case 'ctrl': {
                if (frame.op === 'enroll_ack' && frame.payload && typeof frame.payload.token === 'string') {
                    this.token = frame.payload.token;
                    persistToken(this.token);
                    console.log('[Pilot] Enrollment complete; long-lived token persisted.');
                }
                break;
            }
            case 'http_req': this.onHttpReq(frame); break;
            case 'http_req_end': this.onHttpReqEnd(frame.s); break;
            case 'ws_open': this.onWsOpen(frame); break;
            case 'ws_msg_text': this.onWsMsgText(frame.s, frame.data); break;
            case 'ws_close': this.onWsClose(frame.s, frame.code, frame.reason); break;
            case 'tcp_open': this.onTcpOpen(frame); break;
            case 'tcp_close': this.onTcpClose(frame.s); break;
            default:
                // Other frame types are primary-bound only; agent ignores.
                break;
        }
    }

    private handleBinaryFrame(frame: ReturnType<typeof decodeBinaryFrame>): void {
        switch (frame.type) {
            case BinaryFrameType.HttpReqBody: {
                const entry = this.httpStreams.get(frame.streamId);
                if (!entry) return;
                try { entry.req.write(frame.payload); } catch { /* ignore */ }
                this.refreshIdleTimer(frame.streamId);
                break;
            }
            case BinaryFrameType.WsMessageBinary: {
                const ws = this.wsStreams.get(frame.streamId);
                if (!ws) return;
                try { ws.send(frame.payload, { binary: true }); } catch { /* ignore */ }
                this.refreshIdleTimer(frame.streamId);
                break;
            }
            case BinaryFrameType.TcpData: {
                const stream = this.tcpStreams.get(frame.streamId);
                if (!stream) return;
                try { stream.socket.write(frame.payload); } catch { /* ignore */ }
                this.refreshIdleTimer(frame.streamId);
                break;
            }
            default:
                break;
        }
    }

    // --- HTTP dispatch (tunnel -> loopback) ---

    private onHttpReq(frame: Extract<ReturnType<typeof decodeJsonFrame>, { t: 'http_req' }>): void {
        const ws = this.ws;
        if (!ws) return;
        if (this.streamCount() >= MAX_STREAMS_PER_TUNNEL) {
            try {
                ws.send(encodeJsonFrame({
                    t: 'http_err',
                    s: frame.s,
                    code: 'agent_error',
                    message: 'agent stream cap reached',
                }));
            } catch { /* ignore */ }
            return;
        }

        const req = http.request({
            host: '127.0.0.1',
            port: this.options.loopbackPort,
            method: frame.method,
            path: frame.path,
            headers: this.buildLoopbackHeaders(frame.headers),
        }, (res) => {
            const outHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
                if (typeof v === 'string') outHeaders[k] = v;
                else if (Array.isArray(v)) outHeaders[k] = v.join(', ');
            }
            try {
                ws.send(encodeJsonFrame({
                    t: 'http_res',
                    s: frame.s,
                    status: res.statusCode || 200,
                    headers: outHeaders,
                }));
            } catch { /* ignore */ }
            this.refreshIdleTimer(frame.s);

            res.on('data', (chunk: Buffer) => {
                try { ws.send(encodeBinaryFrame(BinaryFrameType.HttpResBody, frame.s, chunk), { binary: true }); } catch { /* ignore */ }
                this.refreshIdleTimer(frame.s);
            });
            res.on('end', () => {
                try { ws.send(encodeJsonFrame({ t: 'http_res_end', s: frame.s })); } catch { /* ignore */ }
                this.httpStreams.delete(frame.s);
                this.clearIdleTimer(frame.s);
            });
            res.on('error', () => {
                try { ws.send(encodeJsonFrame({ t: 'http_err', s: frame.s, code: 'bad_response', message: 'upstream error' })); } catch { /* ignore */ }
                this.httpStreams.delete(frame.s);
                this.clearIdleTimer(frame.s);
            });
        });

        req.on('error', (err) => {
            try {
                ws.send(encodeJsonFrame({
                    t: 'http_err',
                    s: frame.s,
                    code: 'agent_error',
                    message: err.message || 'agent request failed',
                }));
            } catch { /* ignore */ }
            this.httpStreams.delete(frame.s);
            this.clearIdleTimer(frame.s);
        });

        this.httpStreams.set(frame.s, { req });
        this.refreshIdleTimer(frame.s);
    }

    private onHttpReqEnd(streamId: number): void {
        const entry = this.httpStreams.get(streamId);
        if (!entry) return;
        try { entry.req.end(); } catch { /* ignore */ }
        this.refreshIdleTimer(streamId);
    }

    // --- WebSocket dispatch (tunnel -> loopback) ---

    private onWsOpen(frame: Extract<ReturnType<typeof decodeJsonFrame>, { t: 'ws_open' }>): void {
        const ws = this.ws;
        if (!ws) return;
        if (this.streamCount() >= MAX_STREAMS_PER_TUNNEL) {
            try {
                ws.send(encodeJsonFrame({
                    t: 'ws_reject',
                    s: frame.s,
                    status: 503,
                    message: 'agent stream cap reached',
                }));
            } catch { /* ignore */ }
            return;
        }

        const target = `ws://127.0.0.1:${this.options.loopbackPort}${frame.path}`;
        const client = new WebSocket(target, {
            headers: this.buildLoopbackHeaders(frame.headers),
            maxPayload: MAX_FRAME_SIZE_BYTES,
        });

        client.on('open', () => {
            try { ws.send(encodeJsonFrame({ t: 'ws_accept', s: frame.s, headers: {} })); } catch { /* ignore */ }
            this.wsStreams.set(frame.s, client);
            this.refreshIdleTimer(frame.s);
        });
        client.on('message', (data, isBinary) => {
            if (isBinary) {
                try { ws.send(encodeBinaryFrame(BinaryFrameType.WsMessageBinary, frame.s, wsDataToBuffer(data) ?? Buffer.alloc(0)), { binary: true }); } catch { /* ignore */ }
            } else {
                try { ws.send(encodeJsonFrame({ t: 'ws_msg_text', s: frame.s, data: wsDataToString(data) ?? '' })); } catch { /* ignore */ }
            }
            this.refreshIdleTimer(frame.s);
        });
        client.on('close', (code, reason) => {
            try { ws.send(encodeJsonFrame({ t: 'ws_close', s: frame.s, code, reason: reason?.toString?.() })); } catch { /* ignore */ }
            this.wsStreams.delete(frame.s);
            this.clearIdleTimer(frame.s);
        });
        client.on('error', () => {
            try { ws.send(encodeJsonFrame({ t: 'ws_reject', s: frame.s, status: 502, message: 'agent websocket failed' })); } catch { /* ignore */ }
            this.wsStreams.delete(frame.s);
            this.clearIdleTimer(frame.s);
        });
    }

    private onWsMsgText(streamId: number, data: string): void {
        const ws = this.wsStreams.get(streamId);
        if (!ws) return;
        try { ws.send(data); } catch { /* ignore */ }
        this.refreshIdleTimer(streamId);
    }

    private onWsClose(streamId: number, code: number, reason?: string): void {
        const ws = this.wsStreams.get(streamId);
        if (!ws) return;
        try { ws.close(code, reason); } catch { /* ignore */ }
        this.wsStreams.delete(streamId);
        this.clearIdleTimer(streamId);
    }

    // --- Sencho Mesh TCP dispatch (tunnel -> Compose service container) ---
    //
    // PR 1 rejects every tcp_open with mesh_not_enabled; the dial path is
    // exercised by tests via setMeshResolver but never lit in production until
    // PR 2 wires Dockerode resolution gated by the local mesh_stacks table.

    private async onTcpOpen(frame: Extract<ReturnType<typeof decodeJsonFrame>, { t: 'tcp_open' }>): Promise<void> {
        const ws = this.ws;
        if (!ws) return;
        if (this.streamCount() >= MAX_STREAMS_PER_TUNNEL) {
            try {
                ws.send(encodeJsonFrame({ t: 'tcp_open_ack', s: frame.s, ok: false, err: 'agent_error' }));
            } catch { /* ignore */ }
            return;
        }

        const target = await this.resolveMeshTarget(frame.stack, frame.service, frame.port);
        if (!target.ok) {
            try {
                ws.send(encodeJsonFrame({ t: 'tcp_open_ack', s: frame.s, ok: false, err: target.err }));
            } catch { /* ignore */ }
            return;
        }

        const socket = net.createConnection({ host: target.host, port: target.port });
        socket.setTimeout(MESH_CONNECT_TIMEOUT_MS);
        const entry: MeshTcpStream = { socket, accepted: false };
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
            console.warn('[Pilot] tcp stream error:', sanitizeForLog(err.message));
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
        const entry = this.tcpStreams.get(streamId);
        if (!entry) return;
        this.tcpStreams.delete(streamId);
        this.clearIdleTimer(streamId);
        try { entry.socket.destroy(); } catch { /* ignore */ }
    }

    /**
     * Resolves a mesh target by consulting the local mesh_stacks opt-in table
     * and Compose container labels. Refuses if the target stack is not opted
     * in on this node (defense-in-depth: the primary is trusted, but we also
     * gate at the agent so a leaked tunnel token cannot reach unauthorized
     * services).
     */
    private async resolveMeshTarget(
        stack: string,
        service: string,
        port: number,
    ): Promise<MeshResolveResult> {
        try {
            const { DatabaseService } = await import('../services/DatabaseService');
            const { NodeRegistry } = await import('../services/NodeRegistry');
            const dockerodeMod = await import('dockerode');
            const Docker = (dockerodeMod as { default: new (opts?: unknown) => { listContainers: (opts?: unknown) => Promise<unknown[]> } }).default;
            const db = DatabaseService.getInstance();
            const localNodeId = NodeRegistry.getInstance().getDefaultNodeId();
            if (!db.isMeshStackEnabled(localNodeId, stack)) {
                return { ok: false, err: 'denied' };
            }
            const docker = new Docker();
            const containers = (await docker.listContainers({
                filters: { label: [`com.docker.compose.project=${stack}`, `com.docker.compose.service=${service}`] },
            })) as Array<{ NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> } }>;
            for (const c of containers) {
                const networks = c.NetworkSettings?.Networks ?? {};
                for (const net of Object.values(networks)) {
                    if (net.IPAddress) return { ok: true, host: net.IPAddress, port };
                }
            }
            return { ok: false, err: 'no_target' };
        } catch (err) {
            console.warn('[Pilot] resolveMeshTarget failed:', sanitizeForLog((err as Error).message));
            return { ok: false, err: 'agent_error' };
        }
    }
}

const MESH_CONNECT_TIMEOUT_MS = 10_000;

interface MeshTcpStream {
    socket: net.Socket;
    accepted: boolean;
}

type MeshResolveResult =
    | { ok: true; host: string; port: number }
    | { ok: false; err: MeshErrCode };

/**
 * Read the persisted long-lived tunnel token from disk if present. ENOENT is
 * the normal first-boot case and stays silent. Any other error class
 * (EACCES, EIO, EISDIR, etc.) almost certainly means the volume is
 * misconfigured or corrupt; log at ERROR with the path and the errno so the
 * operator has an actionable signal, then return null. Returning null here
 * lets the caller fall back to SENCHO_ENROLL_TOKEN if one is set, or exit
 * with a clear "no credentials" message if not.
 *
 * Calls readFileSync directly rather than racing existsSync + readFileSync
 * to avoid TOCTOU and to surface the actual errno on real failures.
 *
 * Exposed for unit tests.
 */
export function readPersistedToken(): string | null {
    try {
        return fs.readFileSync(TOKEN_PATH, 'utf8').trim() || null;
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return null;
        console.error(
            `[Pilot] Failed to read persisted tunnel token at ${sanitizeForLog(TOKEN_PATH)}: ${sanitizeForLog(code ?? 'unknown')} - ${sanitizeForLog((err as Error).message)}`,
        );
        return null;
    }
}

/**
 * Load the optional CA bundle pointed at by SENCHO_PILOT_CA_FILE so a pilot
 * agent can verify a self-signed primary cert without disabling TLS
 * verification globally. Returns the file contents or null if the var is
 * unset; surfaces a clear error and exits if the file cannot be read so the
 * operator does not silently fall back to the default trust store.
 */
function readPilotCaBundle(): Buffer | null {
    const caFile = process.env.SENCHO_PILOT_CA_FILE;
    if (!caFile) return null;
    try {
        return fs.readFileSync(caFile);
    } catch (err) {
        console.error('[Pilot] Failed to read SENCHO_PILOT_CA_FILE:', sanitizeForLog((err as Error).message));
        process.exit(1);
    }
}

/**
 * Persist the long-lived tunnel token so the agent can reconnect after a
 * container restart without re-enrolling. On failure we log at ERROR (not
 * WARN) with an explicit "next agent restart will require re-enrollment"
 * message: a silent warning here meant the operator saw the next-boot
 * re-enrollment loop with no signal pointing at the disk. The current
 * tunnel session continues with the in-memory token regardless.
 *
 * mkdirSync with recursive:true is idempotent on existing directories, so
 * the prior existsSync guard was redundant and added a TOCTOU window.
 *
 * Exposed for unit tests.
 */
export function persistToken(token: string): void {
    try {
        fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
        fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        console.error(
            `[Pilot] Failed to persist tunnel token at ${sanitizeForLog(TOKEN_PATH)} (${sanitizeForLog(code ?? 'unknown')}: ${sanitizeForLog((err as Error).message)}). Continuing with the in-memory token; the next agent restart will require re-enrollment until the volume is writable.`,
        );
    }
}

