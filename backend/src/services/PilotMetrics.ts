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
}

class PilotMetricsImpl {
    private counters: Counters = {
        tunnels_total: 0,
        tunnels_replaced: 0,
        tunnels_rejected_capacity: 0,
        enroll_acks: 0,
        frame_decode_errors: 0,
    };

    public increment<K extends keyof Counters>(name: K): void {
        this.counters[name] += 1;
    }

    public snapshot(): Counters {
        return { ...this.counters };
    }
}

export const PilotMetrics = new PilotMetricsImpl();
