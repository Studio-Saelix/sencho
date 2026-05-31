/**
 * Unit tests for AutoHealService.shouldHeal decision logic.
 *
 * shouldHeal is private; accessed via type cast (service as any) to avoid
 * exposing it in production API surface. All tests are pure (no I/O, no
 * timers) - they exercise the decision function directly against a normalized
 * HealSignal.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { INTENTIONAL_KILL_WINDOW_MS } from '../services/ContainerLifecycleClassifier';
import { AutoHealService } from '../services/AutoHealService';

describe('AutoHealService.shouldHeal', () => {
    let service: any;

    beforeEach(() => {
        // Reset singleton so each test starts with a clean restartTimestamps map
        (AutoHealService as any).instance = undefined;
        service = AutoHealService.getInstance();
    });

    const basePolicy = {
        id: 1,
        node_id: 1,
        proxy_entitled_until: 0,
        stack_name: 'mystack',
        service_name: null,
        unhealthy_duration_mins: 5,
        cooldown_mins: 10,
        max_restarts_per_hour: 3,
        auto_disable_after_failures: 5,
        enabled: 1,
        consecutive_failures: 0,
        last_fired_at: 0,
        created_at: Date.now(),
        updated_at: Date.now(),
    };

    // Unhealthy past the 5-min threshold, no recent kill.
    const baseSignal = {
        reason: 'unhealthy' as const,
        downSince: Date.now() - 6 * 60_000,
        lastKillAt: undefined,
    };

    it('returns heal:true when all conditions are met', () => {
        const result = service.shouldHeal(baseSignal, basePolicy, 'container123', Date.now());
        expect(result.heal).toBe(true);
        expect(result.reason).toBe('unhealthy');
    });

    it('returns heal:true with reason "crashed" for a crashed trigger', () => {
        const result = service.shouldHeal(
            { reason: 'crashed', downSince: Date.now() - 6 * 60_000, lastKillAt: undefined },
            basePolicy,
            'container123',
            Date.now(),
        );
        expect(result.heal).toBe(true);
        expect(result.reason).toBe('crashed');
    });

    it('returns heal:false when there is no heal-worthy reason', () => {
        const result = service.shouldHeal(
            { reason: undefined, downSince: undefined },
            basePolicy,
            'container123',
            Date.now(),
        );
        expect(result.heal).toBe(false);
        expect(result.skipReason).toBe('not_unhealthy');
    });

    it('returns heal:false when downSince is undefined', () => {
        const result = service.shouldHeal(
            { ...baseSignal, downSince: undefined },
            basePolicy,
            'container123',
            Date.now(),
        );
        expect(result.heal).toBe(false);
        expect(result.skipReason).toBe('not_unhealthy');
    });

    it('returns heal:false when duration threshold is not yet met', () => {
        // Only 2 minutes, threshold is 5
        const signal = { ...baseSignal, downSince: Date.now() - 2 * 60_000 };
        const result = service.shouldHeal(signal, basePolicy, 'container123', Date.now());
        expect(result.heal).toBe(false);
        expect(result.skipReason).toBe('duration_not_met');
    });

    it('returns skipped_user_action when lastKillAt is within the window', () => {
        // 30s ago, well within the 60s INTENTIONAL_KILL_WINDOW_MS
        const signal = { ...baseSignal, lastKillAt: Date.now() - 30_000 };
        const result = service.shouldHeal(signal, basePolicy, 'container123', Date.now());
        expect(result.heal).toBe(false);
        expect(result.skipReason).toBe('skipped_user_action');
    });

    it('suppresses a crashed trigger when lastKillAt is within the window', () => {
        // An operator stop that Docker reports with a non-zero exit must not be
        // resurrected: the kill-window is the backstop behind the crash classifier.
        const signal = {
            reason: 'crashed' as const,
            downSince: Date.now() - 6 * 60_000,
            lastKillAt: Date.now() - 30_000,
        };
        const result = service.shouldHeal(signal, basePolicy, 'container123', Date.now());
        expect(result.heal).toBe(false);
        expect(result.skipReason).toBe('skipped_user_action');
    });

    it('does not suppress when lastKillAt is outside the intentional kill window', () => {
        const signal = {
            ...baseSignal,
            lastKillAt: Date.now() - (INTENTIONAL_KILL_WINDOW_MS + 5_000),
        };
        const result = service.shouldHeal(signal, basePolicy, 'container123', Date.now());
        expect(result.heal).toBe(true);
    });

    it('returns skipped_cooldown when last_fired_at is within cooldown period', () => {
        // Fired 5 min ago, cooldown is 10 min
        const policy = { ...basePolicy, last_fired_at: Date.now() - 5 * 60_000, cooldown_mins: 10 };
        const result = service.shouldHeal(baseSignal, policy, 'container123', Date.now());
        expect(result.heal).toBe(false);
        expect(result.skipReason).toBe('skipped_cooldown');
    });

    it('does not apply cooldown when last_fired_at is 0', () => {
        const policy = { ...basePolicy, last_fired_at: 0 };
        const result = service.shouldHeal(baseSignal, policy, 'container123', Date.now());
        expect(result.heal).toBe(true);
    });

    it('does not apply cooldown when last_fired_at exceeds the cooldown window', () => {
        // Fired 15 min ago, cooldown is 10 min
        const policy = { ...basePolicy, last_fired_at: Date.now() - 15 * 60_000, cooldown_mins: 10 };
        const result = service.shouldHeal(baseSignal, policy, 'container123', Date.now());
        expect(result.heal).toBe(true);
    });

    it('returns skipped_rate_limit when hourly restart count is at the configured max', () => {
        const now = Date.now();
        // Pre-populate with 3 entries within the last hour (policy max is 3)
        const map = (service as any).restartTimestamps as Map<string, number[]>;
        map.set('container123', [now - 10_000, now - 20_000, now - 30_000]);
        const result = service.shouldHeal(baseSignal, basePolicy, 'container123', now);
        expect(result.heal).toBe(false);
        expect(result.skipReason).toBe('skipped_rate_limit');
    });

    it('does not rate-limit when all timestamps are older than one hour', () => {
        const now = Date.now();
        const map = (service as any).restartTimestamps as Map<string, number[]>;
        // All entries are >1 hour old, so they fall outside the rate-limit window
        map.set('container123', [now - 70 * 60_000, now - 80 * 60_000, now - 90 * 60_000]);
        const result = service.shouldHeal(baseSignal, basePolicy, 'container123', now);
        expect(result.heal).toBe(true);
    });

    it('counts only recent timestamps toward the rate limit', () => {
        const now = Date.now();
        const map = (service as any).restartTimestamps as Map<string, number[]>;
        // 2 old (outside window) + 1 recent = 1 active restart; max is 3, so still allowed
        map.set('container123', [now - 70 * 60_000, now - 80 * 60_000, now - 5_000]);
        const result = service.shouldHeal(baseSignal, basePolicy, 'container123', now);
        expect(result.heal).toBe(true);
    });
});
