/**
 * PilotMetrics: process-local counters for the pilot-agent reverse-tunnel
 * subsystem and the proxy-mode mesh dialer. Strictly process-local. Sencho
 * does not export metrics to any external sink (privacy posture, see
 * CLAUDE.md). Their purpose is operator support and debug, surfaced via
 * GET /api/system/pilot-tunnels (admin only).
 *
 * Counters are hydrated from SQLite on startup via load() and persisted via
 * a buffered flush that mirrors the audit-log buffer pattern in
 * DatabaseService: one flush per PILOT_METRICS_FLUSH_INTERVAL_MS or
 * PILOT_METRICS_FLUSH_THRESHOLD increments, whichever comes first, plus an
 * explicit flush() in the shutdown handler before the DB closes.
 *
 * No general in-process metrics facility exists in the backend today, so
 * this is a per-feature pattern. When a shared facility lands, this module
 * should be replaced by an instance of it rather than grown.
 */

import type { DatabaseService } from './DatabaseService';

export interface Counters {
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

const ZERO_COUNTERS: Counters = {
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

export const PILOT_METRICS_FLUSH_INTERVAL_MS = 1_000;
export const PILOT_METRICS_FLUSH_THRESHOLD = 100;

export interface PilotMetricsTestOverrides {
    intervalMs?: number;
    threshold?: number;
}

class PilotMetricsImpl {
    private counters: Counters = { ...ZERO_COUNTERS };
    private db: DatabaseService | null = null;
    private pendingWrites = 0;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private intervalMs: number = PILOT_METRICS_FLUSH_INTERVAL_MS;
    private threshold: number = PILOT_METRICS_FLUSH_THRESHOLD;

    /**
     * Hydrate counters from persisted JSON (if any) and wire periodic flush
     * to disk. Idempotent: a second call rebinds the DB reference and
     * re-hydrates from it but does not double-schedule the timer.
     */
    public load(db: DatabaseService, overrides?: PilotMetricsTestOverrides): void {
        this.db = db;
        if (overrides?.intervalMs !== undefined) this.intervalMs = overrides.intervalMs;
        if (overrides?.threshold !== undefined) this.threshold = overrides.threshold;
        const persisted = db.getPilotMetricsCounters();
        const next: Counters = { ...ZERO_COUNTERS };
        if (persisted) {
            for (const key of Object.keys(next) as Array<keyof Counters>) {
                const value = persisted[key];
                if (typeof value === 'number' && Number.isFinite(value)) {
                    next[key] = value;
                }
            }
        }
        this.counters = next;
        this.pendingWrites = 0;
    }

    public increment<K extends keyof Counters>(name: K): void {
        this.counters[name] += 1;
        if (!this.db) return;
        this.pendingWrites += 1;
        if (this.pendingWrites >= this.threshold) {
            this.flush();
            return;
        }
        if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => {
                this.flushTimer = null;
                this.flush();
            }, this.intervalMs);
            // Allow process exit even when this timer is pending; shutdown
            // calls flush() explicitly and a stuck DB write must not block
            // SIGTERM.
            if (typeof this.flushTimer.unref === 'function') {
                this.flushTimer.unref();
            }
        }
    }

    public snapshot(): Counters {
        return { ...this.counters };
    }

    /**
     * Persist the current counter snapshot to SQLite. Safe to call from any
     * path; the shutdown handler invokes this before closing the DB. A flush
     * with no pending writes is a no-op (avoids writing on every shutdown
     * even when nothing changed since load).
     */
    public flush(): void {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (!this.db || this.pendingWrites === 0) return;
        try {
            this.db.setPilotMetricsCounters({ ...this.counters });
            this.pendingWrites = 0;
        } catch (err) {
            // Keep counters in memory so the next flush retries with the
            // accumulated value. Do NOT zero pendingWrites here.
            console.error('[PilotMetrics] Failed to persist counters:', (err as Error).message);
        }
    }

    /**
     * Cancel any pending interval flush without writing. Intended for tests;
     * the production shutdown path uses flush() instead so in-memory writes
     * survive the restart.
     */
    public stop(): void {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
    }

    /**
     * Reset all in-memory state. Tests only.
     */
    public resetForTests(): void {
        this.stop();
        this.counters = { ...ZERO_COUNTERS };
        this.db = null;
        this.pendingWrites = 0;
        this.intervalMs = PILOT_METRICS_FLUSH_INTERVAL_MS;
        this.threshold = PILOT_METRICS_FLUSH_THRESHOLD;
    }
}

export const PilotMetrics = new PilotMetricsImpl();
