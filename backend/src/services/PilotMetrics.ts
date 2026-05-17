/**
 * PilotMetrics: in-memory counters for the pilot-agent reverse-tunnel
 * subsystem. Strictly process-local — Sencho does not export metrics to any
 * external sink (privacy posture, see CLAUDE.md). Counters reset on process
 * restart by design; their purpose is operator support and debug, not
 * long-term trend analysis.
 *
 * No general in-process metrics facility exists in the backend today, so this
 * is a per-feature pattern. When a shared facility lands, this module should
 * be replaced by an instance of it rather than grown.
 */

interface Counters {
    tunnels_total: number;
    tunnels_replaced: number;
    tunnels_rejected_capacity: number;
    enroll_acks: number;
    frame_decode_errors: number;
    /** Successful Distributed API mesh proxy-tunnel registrations. Counterpart to `tunnels_total` for pilot-mode tunnels; the two together cover every mesh-capable bridge the manager ever accepted. */
    proxy_bridges_total: number;
    /** Failed proxy-tunnel dial attempts (all reasons). Pair with `proxy_bridges_total` for an attempt/success ratio; pair with `proxy_idle_closes` for retention. */
    proxy_dials_failed: number;
    /** Proxy-tunnel teardowns initiated by the dialer's idle sweep (zero active streams for the configured TTL). */
    proxy_idle_closes: number;
    /** Proxy bridges registered via the peer-initiated dial-back path (`/api/mesh/proxy-tunnel-from-peer`). Disjoint from `proxy_bridges_total`, which counts central-initiated dials. */
    proxy_bridges_peer_initiated_total: number;
    /** Successful peer-to-central dial-back sessions (counted on WS open + bridge start). Disjoint from `proxy_bridges_peer_initiated_total`, which is incremented by the central-side ingress at register time. Useful for operators investigating asymmetric counts (peer thinks it dialed, central never registered). */
    mesh_central_bootstraps_total: number;
    /** Peer-to-central dial-back attempts that did not complete a WS open. Covers transport errors, upgrade rejections, and bridge.start failures. */
    mesh_callback_dials_failed_total: number;
    /** Subset of `mesh_callback_dials_failed_total` where central responded 401 with a terminal reason code (stale, signature_invalid, ...) that caused the peer to clear its cached central material. */
    mesh_callback_auth_failures_total: number;
}

class PilotMetricsImpl {
    private counters: Counters = {
        tunnels_total: 0,
        tunnels_replaced: 0,
        tunnels_rejected_capacity: 0,
        enroll_acks: 0,
        frame_decode_errors: 0,
        proxy_bridges_total: 0,
        proxy_dials_failed: 0,
        proxy_idle_closes: 0,
        proxy_bridges_peer_initiated_total: 0,
        mesh_central_bootstraps_total: 0,
        mesh_callback_dials_failed_total: 0,
        mesh_callback_auth_failures_total: 0,
    };

    public increment<K extends keyof Counters>(name: K): void {
        this.counters[name] += 1;
    }

    public snapshot(): Counters {
        return { ...this.counters };
    }
}

export const PilotMetrics = new PilotMetricsImpl();
