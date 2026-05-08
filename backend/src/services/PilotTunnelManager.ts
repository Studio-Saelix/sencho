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
 * PilotTunnelManager: singleton registry of active pilot tunnels.
 *
 * Each enrolled pilot-agent node holds one outbound WebSocket to the primary.
 * For every such tunnel we spin up a local loopback HTTP server that demuxes
 * requests into frames. Remote-proxy code paths (http-proxy-middleware and the
 * WebSocket upgrade handler) can then treat pilot nodes identically to standard
 * proxy nodes by pointing at the loopback URL.
 *
 * Events:
 *   - 'tunnel-up'   (nodeId: number) after a tunnel is accepted
 *   - 'tunnel-down' (nodeId: number) after a tunnel closes (for any reason)
 */
export class PilotTunnelManager extends EventEmitter {
    private static instance: PilotTunnelManager;
    private bridges: Map<number, PilotTunnelBridge> = new Map();
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
                DatabaseService.getInstance().updateNodeStatus(nodeId, 'offline');
                this.emit('tunnel-down', nodeId);
            }
        });
        await bridge.start();

        this.bridges.set(nodeId, bridge);
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
     * Force-close a tunnel (e.g., on node deletion).
     */
    public closeTunnel(nodeId: number, code = 1000, reason = 'closed by primary'): void {
        const bridge = this.bridges.get(nodeId);
        if (!bridge) return;
        bridge.close(code, reason);
        this.bridges.delete(nodeId);
    }

}
