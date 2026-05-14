import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { MAX_FRAME_SIZE_BYTES } from '../pilot/protocol';
import { PilotTunnelBridge, type MeshTunnelHandle } from './PilotTunnelBridge';
import { PilotTunnelManager } from './PilotTunnelManager';
import { NodeRegistry } from './NodeRegistry';
import { redactSensitiveText, sanitizeForLog } from '../utils/safeLog';
import { httpUrlToWs } from '../utils/wsUrl';
import { isDebugEnabled } from '../utils/debug';
import { PilotMetrics } from './PilotMetrics';
import type { MeshActivityType } from './MeshService';

/**
 * Central-side dialer for proxy-mode mesh tunnels.
 *
 * Today's pilot tunnels are agent-initiated: the pilot dials central and
 * the resulting WS is registered in `PilotTunnelManager`. Proxy-mode
 * remotes do not dial; central reaches them via the existing HTTP proxy
 * using the long-lived `api_token`. To carry streaming TCP mesh traffic to
 * a proxy-mode remote, central opens a WebSocket to the remote's new
 * `/api/mesh/proxy-tunnel` endpoint on demand and registers the resulting
 * `PilotTunnelBridge` in the manager under the same nodeId. The rest of
 * the mesh code path (alias dispatch, openTcpStream, reverse-stream relay)
 * is mode-agnostic from there.
 *
 * Lifecycle:
 *   - `ensureBridge(nodeId)` dials if not connected; concurrent callers
 *     dedupe through an in-flight promise map.
 *   - A periodic check tears down bridges that have seen no active streams
 *     for `SENCHO_MESH_PROXY_TUNNEL_IDLE_MS` (default 5 minutes). Setting
 *     the env var to `0` disables idle close (tunnel persists until the
 *     remote drops it or central shuts down).
 *   - Recent failures are cached for 60 seconds so a misconfigured remote
 *     does not cause a continuous redial storm; `MeshService.getStatus`
 *     consults the cache to surface a `reachableReason` to the UI.
 */
const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const FAILURE_CACHE_TTL_MS = 60 * 1000;

export type DialFailureCode =
    | 'no_target'
    | 'endpoint_not_found'
    | 'auth_failed'
    | 'tls_failed'
    | 'network_error';

/**
 * Activity-log reason. Wider than `DialFailureCode` because some failures
 * share a wire-level code (e.g., `network_error`) but deserve a more
 * specific label in the operator-facing log to distinguish a network-
 * layer failure from a post-handshake bridge failure or a manager
 * rejection.
 */
type DialFailureReason = DialFailureCode | 'bridge_start_failed' | 'manager_rejected';

type ProxyTunnelEvent = 'open.ok' | 'open.fail' | 'close';

const ACTIVITY_TYPE: Record<ProxyTunnelEvent, MeshActivityType> = {
    'open.ok': 'proxy-tunnel.open.ok',
    'open.fail': 'proxy-tunnel.open.fail',
    'close': 'proxy-tunnel.close',
};

export interface DialFailure {
    code: DialFailureCode;
    message?: string;
    ts: number;
}

export class MeshProxyTunnelDialer extends EventEmitter {
    private static instance: MeshProxyTunnelDialer | null = null;

    private readonly bridges = new Map<number, PilotTunnelBridge>();
    private readonly inflight = new Map<number, Promise<MeshTunnelHandle | null>>();
    private readonly idleSince = new Map<number, number>();
    private readonly recentFailures = new Map<number, DialFailure>();
    private readonly idleTtlMs: number;
    private idleCheckTimer: NodeJS.Timeout | null = null;
    private stopped = false;

    private constructor(idleTtlOverrideMs?: number) {
        super();
        if (typeof idleTtlOverrideMs === 'number') {
            this.idleTtlMs = idleTtlOverrideMs;
        } else {
            const raw = process.env.SENCHO_MESH_PROXY_TUNNEL_IDLE_MS;
            const parsed = raw === undefined ? Number.NaN : Number(raw);
            this.idleTtlMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_IDLE_TTL_MS;
        }
        this.startIdleCheck();
    }

    public static getInstance(): MeshProxyTunnelDialer {
        if (!this.instance) this.instance = new MeshProxyTunnelDialer();
        return this.instance;
    }

    /** Test hook: reset the singleton with an optional idle-TTL override. */
    public static resetForTest(idleTtlOverrideMs?: number): MeshProxyTunnelDialer {
        if (this.instance) this.instance.stop();
        this.instance = new MeshProxyTunnelDialer(idleTtlOverrideMs);
        return this.instance;
    }

    public hasBridge(nodeId: number): boolean {
        return this.bridges.has(nodeId);
    }

    public getBridge(nodeId: number): MeshTunnelHandle | null {
        return this.bridges.get(nodeId) ?? null;
    }

    public getRecentFailure(nodeId: number): DialFailure | null {
        const entry = this.recentFailures.get(nodeId);
        if (!entry) return null;
        if (Date.now() - entry.ts > FAILURE_CACHE_TTL_MS) {
            this.recentFailures.delete(nodeId);
            return null;
        }
        return entry;
    }

    /**
     * Dial-if-needed. Concurrent callers dedupe through `inflight`; a
     * cached recent failure short-circuits the dial so a misconfigured
     * remote does not see one upgrade attempt per cross-node TCP open.
     */
    public async ensureBridge(nodeId: number): Promise<MeshTunnelHandle | null> {
        const existing = this.bridges.get(nodeId);
        if (existing) {
            this.idleSince.set(nodeId, Date.now());
            return existing;
        }
        if (this.getRecentFailure(nodeId)) return null;
        const inflight = this.inflight.get(nodeId);
        if (inflight) return inflight;
        const dial = this.dial(nodeId).finally(() => {
            this.inflight.delete(nodeId);
        });
        this.inflight.set(nodeId, dial);
        return dial;
    }

    /** Force-close a bridge (e.g., on node deletion or scope change). */
    public closeBridge(nodeId: number, reason = 'closed by dialer'): void {
        const bridge = this.bridges.get(nodeId);
        if (!bridge) return;
        this.bridges.delete(nodeId);
        this.idleSince.delete(nodeId);
        try { bridge.close(1000, reason); } catch { /* ignore */ }
    }

    /** Stop the idle-check timer and tear down every open bridge. */
    public stop(): void {
        this.stopped = true;
        if (this.idleCheckTimer) {
            clearInterval(this.idleCheckTimer);
            this.idleCheckTimer = null;
        }
        for (const [nodeId, bridge] of this.bridges) {
            this.bridges.delete(nodeId);
            try { bridge.close(1000, 'dialer shutdown'); } catch { /* ignore */ }
        }
        this.idleSince.clear();
        this.recentFailures.clear();
        this.inflight.clear();
    }

    /** Test hook: count active bridges. */
    public get activeBridgeCount(): number {
        return this.bridges.size;
    }

    private async dial(nodeId: number): Promise<MeshTunnelHandle | null> {
        const target = NodeRegistry.getInstance().getProxyTarget(nodeId);
        if (!target || !target.apiToken) {
            this.recordFailure(nodeId, 'no_target', 'no proxy target configured');
            return null;
        }

        if (this.stopped) return null;
        const dialStartedAt = Date.now();
        if (isDebugEnabled()) {
            console.log(`[MeshProxyDialer:diag] dialing node=${nodeId} url=${sanitizeForLog(target.apiUrl)}`);
        }

        const wsUrl = httpUrlToWs(target.apiUrl) + '/api/mesh/proxy-tunnel';
        let ws: WebSocket;
        try {
            ws = new WebSocket(wsUrl, {
                headers: { Authorization: `Bearer ${target.apiToken}` },
                handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
                maxPayload: MAX_FRAME_SIZE_BYTES,
            });
        } catch (err) {
            this.recordFailure(nodeId, 'network_error', (err as Error).message);
            return null;
        }

        try {
            await this.awaitOpen(ws);
        } catch (err) {
            // `awaitOpen` removes the 'error' listener on reject; calling
            // `close()` on a still-CONNECTING socket emits a tail 'error'
            // ('WebSocket was closed before the connection was established')
            // that would otherwise propagate as an unhandled exception.
            ws.on('error', () => { /* swallow tail error */ });
            try { ws.close(); } catch { /* ignore */ }
            const failure = classifyDialError(err);
            this.recordFailure(nodeId, failure.code, failure.message);
            return null;
        }

        if (this.stopped) {
            try { ws.close(1001, 'dialer shutdown'); } catch { /* ignore */ }
            return null;
        }

        const bridge = new PilotTunnelBridge(nodeId, ws);
        try {
            await bridge.start();
        } catch (err) {
            this.recordFailure(nodeId, 'network_error', (err as Error).message, 'bridge_start_failed');
            try { bridge.close(1011, 'bridge start failed'); } catch { /* ignore */ }
            return null;
        }

        if (this.stopped) {
            try { bridge.close(1001, 'dialer shutdown'); } catch { /* ignore */ }
            return null;
        }

        try {
            PilotTunnelManager.getInstance().registerProxyBridge(nodeId, bridge);
        } catch (err) {
            // Cap hit or a pilot tunnel concurrently claimed this nodeId.
            this.recordFailure(nodeId, 'network_error', (err as Error).message, 'manager_rejected');
            try { bridge.close(1013, 'manager rejected'); } catch { /* ignore */ }
            return null;
        }

        // Mirror the registration in the dialer's own map so the idle
        // sweeper can call `getActiveStreamCount()` (not on the narrow
        // MeshTunnelHandle interface) without poking into the manager.
        bridge.once('closed', () => {
            if (this.bridges.get(nodeId) === bridge) {
                this.bridges.delete(nodeId);
                this.idleSince.delete(nodeId);
                void this.logActivity(nodeId, 'close', { reason: 'remote-closed' });
                this.emit('proxy-bridge-down', nodeId);
            }
        });
        this.bridges.set(nodeId, bridge);
        this.idleSince.set(nodeId, Date.now());
        this.recentFailures.delete(nodeId);
        void this.logActivity(nodeId, 'open.ok', {});
        this.emit('proxy-bridge-up', nodeId);
        if (isDebugEnabled()) {
            console.log(`[MeshProxyDialer:diag] dial ok node=${nodeId} elapsedMs=${Date.now() - dialStartedAt}`);
        }
        return bridge;
    }

    private awaitOpen(ws: WebSocket): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                ws.removeAllListeners('open');
                ws.removeAllListeners('error');
                ws.removeAllListeners('unexpected-response');
            };
            ws.once('open', () => { cleanup(); resolve(); });
            ws.once('error', (err) => { cleanup(); reject(err); });
            ws.once('unexpected-response', (_req, res) => {
                cleanup();
                const err = new Error(`upgrade failed: HTTP ${res.statusCode}`) as Error & { httpStatus?: number };
                err.httpStatus = res.statusCode ?? 0;
                try { res.resume(); } catch { /* ignore */ }
                reject(err);
            });
        });
    }

    /**
     * Cache a dial failure and emit at most one activity-log entry per
     * cache window per `(nodeId, code)`. The dedupe bounds operator log
     * noise when a meshed container retries cross-node TCP opens against
     * a misconfigured remote.
     */
    private recordFailure(nodeId: number, code: DialFailureCode, rawMessage?: string, reasonOverride?: DialFailureReason): void {
        const message = rawMessage ? sanitizeForLog(redactSensitiveText(rawMessage)) : undefined;
        const previous = this.recentFailures.get(nodeId);
        const reason = reasonOverride ?? code;
        const isFresh = !previous
            || Date.now() - previous.ts > FAILURE_CACHE_TTL_MS
            || previous.code !== code;
        this.recentFailures.set(nodeId, { code, message, ts: Date.now() });
        PilotMetrics.increment('proxy_dials_failed');
        if (isFresh) {
            void this.logActivity(nodeId, 'open.fail', message ? { reason, message } : { reason });
        }
        if (isDebugEnabled()) {
            console.warn(`[MeshProxyDialer:diag] dial failure node=${nodeId} code=${code} reason=${reason}${message ? ` message=${message}` : ''}`);
        }
    }

    private startIdleCheck(): void {
        if (this.idleCheckTimer || this.stopped) return;
        if (this.idleTtlMs <= 0) return; // 0 disables idle close
        this.idleCheckTimer = setInterval(() => this.runIdleCheck(), IDLE_CHECK_INTERVAL_MS);
        this.idleCheckTimer.unref?.();
    }

    private runIdleCheck(): void {
        const now = Date.now();
        for (const [nodeId, bridge] of this.bridges) {
            if (bridge.getActiveStreamCount() > 0) {
                this.idleSince.set(nodeId, now);
                continue;
            }
            const last = this.idleSince.get(nodeId) ?? now;
            if (now - last >= this.idleTtlMs) {
                this.bridges.delete(nodeId);
                this.idleSince.delete(nodeId);
                try { bridge.close(1000, 'idle timeout'); } catch { /* ignore */ }
                PilotMetrics.increment('proxy_idle_closes');
                void this.logActivity(nodeId, 'close', { reason: 'idle' });
                this.emit('proxy-bridge-down', nodeId);
                if (isDebugEnabled()) {
                    console.log(`[MeshProxyDialer:diag] idle close node=${nodeId} idleMs=${now - last}`);
                }
            }
        }
    }

    private async logActivity(
        nodeId: number,
        event: ProxyTunnelEvent,
        details: Record<string, unknown>,
    ): Promise<void> {
        try {
            // Lazy import to avoid a circular dependency with MeshService.
            const { MeshService } = await import('./MeshService');
            const message = typeof details.message === 'string'
                ? details.message
                : `proxy tunnel ${event} for node ${nodeId}`;
            MeshService.getInstance().logActivity({
                source: 'mesh',
                level: event === 'open.fail' ? 'error' : 'info',
                type: ACTIVITY_TYPE[event],
                nodeId,
                message,
                details,
            });
        } catch {
            // Activity logging is best-effort; never let it propagate.
        }
    }
}

function classifyDialError(err: unknown): { code: DialFailureCode; message: string } {
    const message = sanitizeForLog((err as Error).message || String(err));
    const httpStatus = (err as Error & { httpStatus?: number }).httpStatus;
    if (httpStatus === 404) return { code: 'endpoint_not_found', message: 'remote does not expose /api/mesh/proxy-tunnel' };
    if (httpStatus === 401 || httpStatus === 403) return { code: 'auth_failed', message: 'api token rejected by remote' };
    const tlsCodes = new Set(['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN']);
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno && tlsCodes.has(errno)) return { code: 'tls_failed', message };
    return { code: 'network_error', message };
}
