import { describe, expect, it } from 'vitest';
import { meshRouteStateFor, meshRouteStateFromBackend, meshRouteStateAfterProbe, meshRouteStateTokens } from './meshRouteState';

describe('meshRouteStateFor', () => {
    const FROZEN_NOW = 1_700_000_000_000;

    it('returns not-authorized when the route is not opted in', () => {
        expect(meshRouteStateFor({ optedIn: false, pilotConnected: true, now: FROZEN_NOW })).toBe('not-authorized');
    });

    it('returns tunnel-down when opted in but pilot is offline', () => {
        expect(meshRouteStateFor({ optedIn: true, pilotConnected: false, now: FROZEN_NOW })).toBe('tunnel-down');
    });

    it('returns unreachable when a recent error is recorded', () => {
        const lastErrorAt = FROZEN_NOW - 5_000;
        expect(meshRouteStateFor({
            optedIn: true, pilotConnected: true, lastErrorAt, now: FROZEN_NOW,
        })).toBe('unreachable');
    });

    it('does NOT return unreachable when the error is older than the window', () => {
        const lastErrorAt = FROZEN_NOW - 90_000;
        expect(meshRouteStateFor({
            optedIn: true, pilotConnected: true, lastErrorAt, now: FROZEN_NOW,
        })).toBe('healthy');
    });

    it('returns degraded when the last probe was slow', () => {
        expect(meshRouteStateFor({
            optedIn: true, pilotConnected: true, lastProbeMs: 750, now: FROZEN_NOW,
        })).toBe('degraded');
    });

    it('returns healthy in the happy path', () => {
        expect(meshRouteStateFor({
            optedIn: true, pilotConnected: true, lastProbeMs: 12, now: FROZEN_NOW,
        })).toBe('healthy');
    });
});

describe('meshRouteStateFromBackend', () => {
    it('maps each backend label to its pill key', () => {
        expect(meshRouteStateFromBackend('healthy')).toBe('healthy');
        expect(meshRouteStateFromBackend('degraded')).toBe('degraded');
        expect(meshRouteStateFromBackend('unreachable')).toBe('unreachable');
        expect(meshRouteStateFromBackend('tunnel down')).toBe('tunnel-down');
        expect(meshRouteStateFromBackend('not authorized')).toBe('not-authorized');
        expect(meshRouteStateFromBackend('anything-else')).toBe('not-authorized');
    });
});

describe('meshRouteStateTokens', () => {
    it('produces a token + label + toneClass for every pill state', () => {
        for (const s of ['healthy', 'degraded', 'unreachable', 'tunnel-down', 'not-authorized'] as const) {
            const tk = meshRouteStateTokens(s);
            expect(tk.label.length).toBeGreaterThan(0);
            expect(tk.toneClass.length).toBeGreaterThan(0);
            expect(tk.token.length).toBeGreaterThan(0);
        }
    });
});

describe('meshRouteStateAfterProbe', () => {
    it('keeps the diagnostic state when no probe has run or the probe passed', () => {
        for (const base of ['healthy', 'degraded', 'unreachable', 'tunnel-down', 'not-authorized'] as const) {
            expect(meshRouteStateAfterProbe(base, null)).toBe(base);
            expect(meshRouteStateAfterProbe(base, { ok: true })).toBe(base);
        }
    });

    it('never leaves a healthy or degraded chip beside a failed probe', () => {
        for (const base of ['healthy', 'degraded'] as const) {
            expect(meshRouteStateAfterProbe(base, { ok: false, where: 'no_route' })).toBe('not-authorized');
            expect(meshRouteStateAfterProbe(base, { ok: false, where: 'agent_resolve' })).toBe('not-authorized');
            expect(meshRouteStateAfterProbe(base, { ok: false, where: 'pilot_tunnel' })).toBe('tunnel-down');
            expect(meshRouteStateAfterProbe(base, { ok: false, where: 'agent_dial' })).toBe('unreachable');
            expect(meshRouteStateAfterProbe(base, { ok: false, where: 'target_port' })).toBe('unreachable');
            expect(meshRouteStateAfterProbe(base, { ok: false })).toBe('unreachable');
        }
    });

    it('ignores a response that is not a probe result', () => {
        // An error body has no `ok`, so it says nothing about the route.
        expect(meshRouteStateAfterProbe('healthy', {} as { ok: boolean })).toBe('healthy');
    });
});
