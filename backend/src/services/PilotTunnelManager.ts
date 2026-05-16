import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { PilotTunnelBridge, type MeshTunnelHandle } from './PilotTunnelBridge';
import { DatabaseService } from './DatabaseService';
import { PilotCloseCode } from '../pilot/protocol';
import { isDebugEnabled } from '../utils/debug';
import { PilotMetrics } from './PilotMetrics';

/**
 * Soft warning threshold: a single instance handling more than this many
 * concurrent pilot tunnels is unusual and likely indicates a reconnect storm
 * or operator misconfiguration. Logged at WARN.
 */
const PILOT_TUNNEL_SOFT_LIMIT = 128;

/**
 * Hard ceiling on concurrent pilot tunnels per primary. Beyond this the
 * gateway refuses to register new tunnels (the upgrade handler closes the
 * socket with 1013 try-again-later) so a runaway reconnect storm cannot
 * exhaust gateway memory.
 */
const PILOT_TUNNEL_HARD_LIMIT = 256;

/**
 * Thrown by registerTunnel when the system-wide cap is exceeded. The pilot
 * upgrade handler catches this and closes the WebSocket cleanly so the agent
 * backs off rather than tight-looping.
 */
export class PilotTunnelCapacityError extends Error {
    constructor(public readonly limit: number) {
        super(`pilot tunnel cap (${limit}) reached`);
        this.name = 'PilotTunnelCapacityError';
    }
}

/**
 * PilotTunnelManager: singleton registry of active mesh-capable bridges.
 *
 * Two flavors of bridge live in the same `bridges` map, keyed by nodeId:
 *
 *   - **Pilot-agent tunnels** (the original use case): long-lived,
 *     agent-initiated. The pilot dials central; `registerTunnel` accepts
 *     the WS, starts a loopback HTTP server, and emits `tunnel-up` so
 *     downstream observers (capability cache, status badges) refresh. A
 *     pilot-agent bridge stays open for the agent's lifetime and supports
 *     HTTP, WebSocket, and TCP multiplexing.
 *
 *   - **Proxy-mode tunnels** (Phase C): short-lived, central-initiated.
 *     `ensureBridge` delegates to `MeshProxyTunnelDialer`, which opens a
 *     WebSocket to the remote's `/api/mesh/proxy-tunnel` endpoint using
 *     the long-lived `api_token`. Carries only TCP mesh frames; the
 *     loopback HTTP server is left running on the bridge but unused
 *     because proxy-mode HTTP traffic flows through the existing
 *     `remoteNodeProxy`. Idle close after a configurable TTL.
 *
 * Mesh dispatch is mode-agnostic: `MeshService.dialMeshTcpStream` awaits
 * `ensureBridge(nodeId)` and consumes the resulting `MeshTunnelHandle`.
 *
 * Events:
 *   - 'tunnel-up'   (nodeId) when a pilot-agent tunnel is accepted (NOT
 *     emitted for proxy-mode bridges, which are opened on demand and
 *     should not trigger pilot-specific listeners like the F9 capability
 *     cache invalidation).
 *   - 'tunnel-down' (nodeId) when a pilot-agent tunnel closes.
 *   - 'proxy-bridge-up' / 'proxy-bridge-down' (nodeId) for observability
 *     on proxy-mode bridge lifecycle. No current consumer.
 */
export class PilotTunnelManager extends EventEmitter {
    private static instance: PilotTunnelManager;
    private bridges: Map<number, PilotTunnelBridge> = new Map();
    /**
     * Parallel kind index for the `bridges` map. `'pilot'` is set by
     * `registerTunnel` (agent-initiated long-lived tunnel); `'proxy'` is
     * set by `registerProxyBridge` and `replaceOrRegisterProxyBridge`
     * (central-initiated short-lived bridge). Used by
     * `replaceOrRegisterProxyBridge` so a peer-initiated dial can supersede
     * a previous proxy bridge but never shadow a live pilot tunnel.
     */
    private bridgeKinds: Map<number, 'pilot' | 'proxy'> = new Map();
    private softWarned = false;

    private constructor() {
        super();
        this.setMaxListeners(50);
    }

    public static getInstance(): PilotTunnelManager {
        if (!PilotTunnelManager.instance) {
            PilotTunnelManager.instance = new PilotTunnelManager();
        }
        return PilotTunnelManager.instance;
    }

    /**
     * Test-only: drop the singleton and any held bridges so every test
     * starts from a clean registry. Closes outstanding bridges best-effort.
     */
    public static resetForTest(): void {
        if (PilotTunnelManager.instance) {
            for (const [, b] of PilotTunnelManager.instance.bridges) {
                try { b.close(1000, 'test reset'); } catch { /* ignore */ }
            }
            PilotTunnelManager.instance.bridges.clear();
            PilotTunnelManager.instance.bridgeKinds.clear();
        }
        PilotTunnelManager.instance = undefined as unknown as PilotTunnelManager;
    }

    /**
     * Test-only: inject a pre-constructed bridge with an explicit kind.
     * Bypasses capacity / lifecycle hooks so unit tests can prime the
     * registry without owning a real WebSocket.
     */
    public injectBridgeForTest(nodeId: number, bridge: PilotTunnelBridge, kind: 'pilot' | 'proxy'): void {
        this.bridges.set(nodeId, bridge);
        this.bridgeKinds.set(nodeId, kind);
    }

    /**
     * Accept a newly handshaked pilot tunnel. Replaces any prior tunnel for the
     * same node (split-brain prevention): the previous bridge is closed
     * before the new one is installed.
     *
     * Resolves once the loopback HTTP server is listening.
     */
    public async registerTunnel(nodeId: number, ws: WebSocket, agentVersion?: string): Promise<void> {
        const existing = this.bridges.get(nodeId);
        const replaced = existing != null;
        if (existing) {
            existing.close(PilotCloseCode.Replaced, 'replaced by newer tunnel');
            this.bridges.delete(nodeId);
            this.bridgeKinds.delete(nodeId);
        }

        // Hard cap: only counts tunnels for *other* nodes since we just
        // released the matching slot above. A reconnect by the same node
        // does not consume new capacity.
        if (this.bridges.size >= PILOT_TUNNEL_HARD_LIMIT) {
            PilotMetrics.increment('tunnels_rejected_capacity');
            throw new PilotTunnelCapacityError(PILOT_TUNNEL_HARD_LIMIT);
        }

        // Bump the replaced counter only after the cap check passes, so a
        // rejection does not double-count as both a replacement and a
        // capacity rejection.
        if (replaced) PilotMetrics.increment('tunnels_replaced');
        if (this.bridges.size >= PILOT_TUNNEL_SOFT_LIMIT && !this.softWarned) {
            console.warn(`[Pilot] Active tunnel count at soft limit (${this.bridges.size}/${PILOT_TUNNEL_HARD_LIMIT}); reconnect storm or runaway enrollment likely.`);
            this.softWarned = true;
        } else if (this.bridges.size < PILOT_TUNNEL_SOFT_LIMIT) {
            this.softWarned = false;
        }

        const bridge = new PilotTunnelBridge(nodeId, ws);
        bridge.once('closed', () => {
            if (this.bridges.get(nodeId) === bridge) {
                this.bridges.delete(nodeId);
                this.bridgeKinds.delete(nodeId);
                DatabaseService.getInstance().updateNodeStatus(nodeId, 'offline');
                this.emit('tunnel-down', nodeId);
            }
        });
        await bridge.start();

        this.bridges.set(nodeId, bridge);
        this.bridgeKinds.set(nodeId, 'pilot');
        const db = DatabaseService.getInstance();
        db.updateNodeStatus(nodeId, 'online');
        db.updateNode(nodeId, {
            pilot_last_seen: Date.now(),
            pilot_agent_version: agentVersion ?? null,
        });
        PilotMetrics.increment('tunnels_total');
        if (isDebugEnabled()) {
            console.log('[PilotMgr:diag] Tunnel registered:', { nodeId, active: this.bridges.size });
        }
        this.emit('tunnel-up', nodeId);
    }

    /**
     * Per-tunnel breakdown for the metrics endpoint. Includes the
     * loopback-relative connectedAt and bufferedAmount so one-bad-node cases
     * stay visible (an aggregate hides a single tunnel sitting on a stuck
     * write buffer).
     */
    public getMetricsSnapshot(): {
        counters: ReturnType<typeof PilotMetrics.snapshot>;
        tunnels_open: number;
        per_node: Array<{ nodeId: number; connectedAt: number; bufferedAmount: number }>;
    } {
        return {
            counters: PilotMetrics.snapshot(),
            tunnels_open: this.bridges.size,
            per_node: Array.from(this.bridges.entries()).map(([nodeId, bridge]) => ({
                nodeId,
                connectedAt: bridge.getConnectedAt(),
                bufferedAmount: bridge.getBufferedAmount(),
            })),
        };
    }

    /**
     * Return the loopback base URL (http://127.0.0.1:PORT) for a node's active
     * tunnel, or null if no tunnel is currently registered.
     */
    public getLoopbackUrl(nodeId: number): string | null {
        const bridge = this.bridges.get(nodeId);
        return bridge ? bridge.getLoopbackUrl() : null;
    }

    /**
     * True if a tunnel for this node is registered and healthy.
     */
    public hasActiveTunnel(nodeId: number): boolean {
        return this.bridges.has(nodeId);
    }

    /**
     * Per-node tunnel handle, returned to MeshService. Returns the bridge
     * narrowed to the MeshTunnelHandle surface so callers cannot reach
     * into transport internals (loopback URL, per-stream maps, close API).
     */
    public getBridge(nodeId: number): MeshTunnelHandle | null {
        return this.bridges.get(nodeId) ?? null;
    }

    /**
     * Dial-if-needed: return the existing pilot or proxy bridge, or open
     * a new proxy-mode bridge on demand. Used by `MeshService` so cross-
     * node TCP dispatch works for both pilot-agent remotes (long-lived
     * tunnel) and proxy-mode remotes (on-demand tunnel) without any
     * mode-specific branching at the call site.
     *
     * Returns null if the node has no active pilot tunnel AND cannot be
     * dialed as a proxy-mode remote (missing api_url / api_token, scope
     * insufficient, remote offline, or remote pre-Phase-C).
     */
    public async ensureBridge(nodeId: number): Promise<MeshTunnelHandle | null> {
        const existing = this.bridges.get(nodeId);
        if (existing) return existing;
        // Lazy import to avoid a cycle: MeshProxyTunnelDialer imports
        // PilotTunnelBridge, which imports PilotTunnelManager via the
        // existing tcp_open_reverse relay path.
        const { MeshProxyTunnelDialer } = await import('./MeshProxyTunnelDialer');
        return MeshProxyTunnelDialer.getInstance().ensureBridge(nodeId);
    }

    /**
     * Register a central-initiated proxy-mode bridge for an existing
     * remote. Distinct from `registerTunnel`: skips the pilot-only side
     * effects (DB node-status update, `pilot_last_seen` write,
     * `tunnel-up` event, replacement of any prior pilot tunnel). Still
     * honors the hard tunnel cap so a dial storm cannot exhaust gateway
     * memory.
     *
     * Throws `PilotTunnelCapacityError` when the cap is reached.
     */
    public registerProxyBridge(nodeId: number, bridge: PilotTunnelBridge): void {
        const existing = this.bridges.get(nodeId);
        if (existing) {
            // A pilot tunnel for this node already exists. Proxy bridges
            // should not silently shadow them; refuse the registration so
            // the dialer can surface a clear error.
            throw new Error(`pilot tunnel already registered for node ${nodeId}; proxy bridge refused`);
        }
        if (this.bridges.size >= PILOT_TUNNEL_HARD_LIMIT) {
            PilotMetrics.increment('tunnels_rejected_capacity');
            throw new PilotTunnelCapacityError(PILOT_TUNNEL_HARD_LIMIT);
        }
        bridge.once('closed', () => {
            if (this.bridges.get(nodeId) === bridge) {
                this.bridges.delete(nodeId);
                this.bridgeKinds.delete(nodeId);
                this.emit('proxy-bridge-down', nodeId);
            }
        });
        this.bridges.set(nodeId, bridge);
        this.bridgeKinds.set(nodeId, 'proxy');
        PilotMetrics.increment('proxy_bridges_total');
        this.emit('proxy-bridge-up', nodeId);
    }

    /**
     * Register a peer-initiated proxy bridge for an existing remote. If a proxy
     * bridge already exists for this nodeId, close it (the new dial is the source
     * of truth) and replace. If a pilot tunnel exists, refuse: pilot tunnels
     * always win over peer-initiated proxy bridges.
     */
    public replaceOrRegisterProxyBridge(nodeId: number, bridge: PilotTunnelBridge): void {
        const existingKind = this.bridgeKinds.get(nodeId);
        if (existingKind === 'pilot') {
            throw new Error(`pilot tunnel already registered for node ${nodeId}; proxy bridge refused`);
        }
        if (existingKind === 'proxy') {
            const old = this.bridges.get(nodeId);
            this.bridges.delete(nodeId);
            this.bridgeKinds.delete(nodeId);
            try { old?.close(1000, 'replaced-by-newer-proxy'); } catch { /* best-effort cleanup */ }
        }
        if (this.bridges.size >= PILOT_TUNNEL_HARD_LIMIT) {
            PilotMetrics.increment('tunnels_rejected_capacity');
            throw new PilotTunnelCapacityError(PILOT_TUNNEL_HARD_LIMIT);
        }
        bridge.once('closed', () => {
            if (this.bridges.get(nodeId) === bridge) {
                this.bridges.delete(nodeId);
                this.bridgeKinds.delete(nodeId);
                this.emit('proxy-bridge-down', nodeId, 'remote_closed');
            }
        });
        this.bridges.set(nodeId, bridge);
        this.bridgeKinds.set(nodeId, 'proxy');
    }

    /**
     * Force-close a tunnel (e.g., on node deletion).
     */
    public closeTunnel(nodeId: number, code = 1000, reason = 'closed by primary'): void {
        const bridge = this.bridges.get(nodeId);
        if (!bridge) return;
        bridge.close(code, reason);
        this.bridges.delete(nodeId);
        this.bridgeKinds.delete(nodeId);
    }

}
