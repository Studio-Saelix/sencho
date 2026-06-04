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
import { LicenseService } from './LicenseService';
import { PROXY_TIER_HEADER } from './license-headers';

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
 *   - The bridge is a persistent bidirectional control-plane channel:
 *     central → peer `tcp_open` frames and peer → central `tcp_open_reverse`
 *     frames flow over the same WS. The default idle TTL is 0 (no idle
 *     close); `SENCHO_MESH_PROXY_TUNNEL_IDLE_MS` overrides the default for
 *     operators who still want stream-scoped tunnels.
 *   - Recent failures are cached for 60 seconds so a misconfigured remote
 *     does not cause a continuous redial storm; `MeshService.getStatus`
 *     consults the cache to surface a `reachableReason` to the UI.
 */
const DEFAULT_IDLE_TTL_MS = 0;
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
 * Reason union for `proxy-bridge-down` events. Centralizes the categories
 * the dialer emits so subscribers (reactive redial, metrics, UI) can branch
 * deterministically without parsing free-form strings.
 *   - `idle`: idle sweeper closed the bridge after no streams for `idleTtlMs`.
 *   - `remote_closed`: peer closed the WS cleanly (1000/1001) or with an
 *     unclassified non-error code.
 *   - `network_error`: WS dropped abnormally (1006).
 *   - `protocol_error`: WS closed for protocol/policy reasons (1007/1008/1009).
 *   - `auth_failed`: dial-time auth rejection (terminal, no redial).
 */
export type BridgeDownReason =
    | 'idle'
    | 'remote_closed'
    | 'network_error'
    | 'protocol_error'
    | 'auth_failed';

function classifyCloseCode(code?: number): BridgeDownReason {
    if (code === 1000 || code === 1001) return 'remote_closed';
    if (code === 1006) return 'network_error';
    if (code === 1007 || code === 1008 || code === 1009) return 'protocol_error';
    return 'remote_closed';
}

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
    private readonly redialAttempts = new Map<number, number>();
    private readonly redialTimers = new Map<number, NodeJS.Timeout>();
    private readonly idleTtlMs: number;
    private idleCheckTimer: NodeJS.Timeout | null = null;
    private stopped = false;

    private constructor(idleTtlOverrideMs?: number) {
        super();
        // Reactive redial: any non-terminal teardown triggers a backoff redial.
        // `idle` is intentional and `auth_failed` is terminal, so both skip.
        this.on('proxy-bridge-down', (nodeId: number, reason: BridgeDownReason) => {
            if (reason === 'idle' || reason === 'auth_failed') return;
            this.scheduleReactiveRedial(nodeId);
        });
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

    /** True when a dial for this node is currently in flight. */
    public isDialing(nodeId: number): boolean {
        return this.inflight.has(nodeId);
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
        for (const t of this.redialTimers.values()) clearTimeout(t);
        this.redialTimers.clear();
        this.redialAttempts.clear();
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
            console.log(`[MeshProxyDialer:diag] dialing node=${nodeId} url=${sanitizeForLog(target.apiUrl)}`.replace(/[\n\r]/g, ''));
        }

        // Pass the peer's nodeId in central's namespace as a query param so
        // the remote MeshService can dispatch its own `handleAccept` correctly:
        // overlay aliases carry central-namespace nodeIds, and without this
        // the peer falls back to its local DB default (always 1) and treats
        // cross-node aliases as same-node.
        const wsUrl = httpUrlToWs(target.apiUrl) + `/api/mesh/proxy-tunnel?nodeId=${nodeId}`;
        // Forward central's tier so the receiver enforces the paid gate
        // against the *central's* license (matching the HTTP mesh routes,
        // which all gate on `requirePaid` against `req.proxyTier`). Without
        // this the receiver falls back to its own local license, which would
        // both reject paid centrals talking to Community remotes and let
        // Community centrals dial locally-paid remotes. The header is trusted
        // on the receiver only when the WS carries a node_proxy / pilot_tunnel
        // credential (see middleware/auth.ts).
        const proxyHeaders = LicenseService.getInstance().getProxyHeaders();
        let ws: WebSocket;
        try {
            ws = new WebSocket(wsUrl, {
                headers: {
                    Authorization: `Bearer ${target.apiToken}`,
                    [PROXY_TIER_HEADER]: proxyHeaders.tier,
                },
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
        this.bridges.set(nodeId, bridge);
        this.attachBridgeCloseListener(nodeId, bridge);
        this.idleSince.set(nodeId, Date.now());
        this.recentFailures.delete(nodeId);
        // A successful open clears any prior reactive-redial backoff so the
        // next failure starts fresh from attempt #1.
        this.redialAttempts.delete(nodeId);
        void this.logActivity(nodeId, 'open.ok', {});
        this.emit('proxy-bridge-up', nodeId);
        if (isDebugEnabled()) {
            console.log(`[MeshProxyDialer:diag] dial ok node=${nodeId} elapsedMs=${Date.now() - dialStartedAt}`.replace(/[\n\r]/g, ''));
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
            console.warn(`[MeshProxyDialer:diag] dial failure node=${nodeId} code=${code} reason=${reason}${message ? ` message=${message}` : ''}`.replace(/[\n\r]/g, ''));
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
                this.tearDownBridge(nodeId, 'idle', { code: 1000, message: 'idle timeout' });
                if (isDebugEnabled()) {
                    console.log(`[MeshProxyDialer:diag] idle close node=${nodeId} idleMs=${now - last}`);
                }
            }
        }
    }

    /**
     * Single teardown path for any bridge close. Removes the bridge from
     * the map, optionally invokes `bridge.close()` (skipped when the close
     * originated from the bridge itself), records the activity log entry,
     * bumps the idle-close metric when applicable, and emits a reason-tagged
     * `proxy-bridge-down`. The self-listener installed in the constructor
     * decides whether to schedule a reactive redial.
     */
    private tearDownBridge(
        nodeId: number,
        reason: BridgeDownReason,
        closeArgs?: { code: number; message: string },
    ): void {
        const bridge = this.bridges.get(nodeId);
        if (!bridge) return;
        this.bridges.delete(nodeId);
        this.idleSince.delete(nodeId);
        if (closeArgs) {
            // Best-effort: closing an already-closed WS is idempotent and
            // can throw on edge states; we never want teardown to propagate.
            try { bridge.close(closeArgs.code, closeArgs.message); } catch { /* best-effort */ }
        }
        if (reason === 'idle') PilotMetrics.increment('proxy_idle_closes');
        void this.logActivity(nodeId, 'close', { reason });
        this.emit('proxy-bridge-down', nodeId, reason);
    }

    /**
     * Wire the `closed` listener that classifies the WS close code and
     * routes through `tearDownBridge` without re-closing the bridge. Called
     * from `dial()` after registration; also reachable from tests via a
     * private cast so they can exercise the close-code mapping without
     * spinning up a real WebSocket.
     */
    private attachBridgeCloseListener(nodeId: number, bridge: EventEmitter): void {
        bridge.once('closed', (info?: { code?: number }) => {
            if (this.bridges.get(nodeId) !== bridge) return;
            const reason = classifyCloseCode(info?.code);
            this.tearDownBridge(nodeId, reason);
        });
    }

    /**
     * Schedule a reactive redial with exponential backoff + jitter. Caps at
     * 8 attempts (~5 minutes between the last few). A successful `dial()`
     * clears `redialAttempts[nodeId]`, so the counter only grows during a
     * sustained outage.
     */
    private scheduleReactiveRedial(nodeId: number): void {
        if (this.stopped) return;
        const attempt = (this.redialAttempts.get(nodeId) ?? 0) + 1;
        if (attempt > 8) {
            this.redialAttempts.delete(nodeId);
            void this.logActivity(nodeId, 'open.fail', { reason: 'redial_exhausted', attempts: 8 });
            return;
        }
        this.redialAttempts.set(nodeId, attempt);
        const baseMs = Math.min(5_000 * 2 ** (attempt - 1), 5 * 60_000);
        const jitter = Math.floor(Math.random() * baseMs * 0.3);
        const delay = baseMs + jitter;
        const existing = this.redialTimers.get(nodeId);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
            this.redialTimers.delete(nodeId);
            void this.ensureBridge(nodeId);
        }, delay);
        timer.unref?.();
        this.redialTimers.set(nodeId, timer);
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
