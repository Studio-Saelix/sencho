import type { MeshProbeResult, MeshRoutePillState } from '@/types/mesh';

const SLOW_PROBE_THRESHOLD_MS = 500;
const RECENT_ERROR_WINDOW_MS = 60_000;

export interface MeshRouteSignals {
    optedIn: boolean;
    pilotConnected: boolean;
    lastErrorAt?: number | null;
    lastProbeMs?: number | null;
    now?: number;
}

/**
 * Pure function mapping the four observable signals to a single pill state.
 * Centralizes the priority order so every UI surface (route row, node card,
 * detail sheet, activity log) renders the same word for the same situation.
 */
export function meshRouteStateFor(signals: MeshRouteSignals): MeshRoutePillState {
    if (!signals.optedIn) return 'not-authorized';
    if (!signals.pilotConnected) return 'tunnel-down';
    const now = signals.now ?? Date.now();
    if (signals.lastErrorAt && now - signals.lastErrorAt < RECENT_ERROR_WINDOW_MS) return 'unreachable';
    if (signals.lastProbeMs != null && signals.lastProbeMs > SLOW_PROBE_THRESHOLD_MS) return 'degraded';
    return 'healthy';
}

/**
 * The pill once a probe has run. A probe is newer than the diagnostic the
 * sheet fetched when it opened, so a failed one must not sit beside a stale
 * healthy chip, and a passing one must not sit beside a stale outage chip.
 */
export function meshRouteStateAfterProbe(
    base: MeshRoutePillState,
    probe: Pick<MeshProbeResult, 'ok' | 'where' | 'latencyMs'> | null,
): MeshRoutePillState {
    if (!probe) return base;
    if (!probe.ok) return probe.where === 'pilot_tunnel' ? 'tunnel-down' : 'unreachable';
    if (base === 'unreachable' || base === 'tunnel-down') {
        return probe.latencyMs != null && probe.latencyMs > SLOW_PROBE_THRESHOLD_MS ? 'degraded' : 'healthy';
    }
    return base;
}

const TONE_TOKENS: Record<MeshRoutePillState, { token: string; label: string; toneClass: string }> = {
    'healthy':         { token: 'success',     label: 'healthy',         toneClass: 'text-success bg-success/10 border-success/30' },
    'degraded':        { token: 'warning',     label: 'degraded',        toneClass: 'text-warning bg-warning/10 border-warning/30' },
    'unreachable':     { token: 'destructive', label: 'unreachable',     toneClass: 'text-destructive bg-destructive/10 border-destructive/30' },
    'tunnel-down':     { token: 'destructive', label: 'tunnel down',     toneClass: 'text-destructive bg-destructive/10 border-destructive/30' },
    'not-authorized':  { token: 'muted',       label: 'not authorized',  toneClass: 'text-ink-3 bg-ink-3/10 border-ink-3/30' },
};

export function meshRouteStateTokens(state: MeshRoutePillState) {
    return TONE_TOKENS[state];
}

/** Convert the backend's diagnostic state string to the pill key. */
export function meshRouteStateFromBackend(state: string): MeshRoutePillState {
    if (state === 'healthy') return 'healthy';
    if (state === 'degraded') return 'degraded';
    if (state === 'unreachable') return 'unreachable';
    if (state === 'tunnel down') return 'tunnel-down';
    return 'not-authorized';
}
