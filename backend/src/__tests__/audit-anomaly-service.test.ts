import { describe, it, expect } from 'vitest';
import {
    annotateEntries,
    computeAuditStats,
    isUnusualHour,
} from '../services/AuditAnomalyService';
import type { AuditLogEntry } from '../services/DatabaseService';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function entry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
    return {
        id: 0,
        timestamp: Date.now(),
        username: 'alice',
        method: 'POST',
        path: '/api/stacks/deploy',
        status_code: 200,
        node_id: null,
        ip_address: '10.0.0.1',
        summary: 'Deployed stack web',
        ...overrides,
    };
}

describe('AuditAnomalyService - isUnusualHour', () => {
    it('returns false when baseline is too small to trust', () => {
        expect(isUnusualHour(3, [9, 10, 11])).toBe(false);
    });

    it('returns false when hour is inside the actor typical range', () => {
        const baseline = [9, 10, 10, 11, 11, 12, 13, 14, 15, 16];
        expect(isUnusualHour(11, baseline)).toBe(false);
    });

    it('returns true when hour is well outside the baseline', () => {
        const baseline = [9, 10, 10, 11, 11, 12, 13, 14, 15, 16];
        expect(isUnusualHour(3, baseline)).toBe(true);
    });
});

describe('AuditAnomalyService - annotateEntries', () => {
    it('flags first_seen_actor when the actor has no prior history', () => {
        const now = Date.now();
        const current = [entry({ id: 1, timestamp: now, username: 'newbie' })];
        const result = annotateEntries(current, [], now);
        expect(result[0].flags).toContain('first_seen_actor');
    });

    it('does not flag first_seen_actor when actor appears in history', () => {
        const now = Date.now();
        const history = [entry({ id: 1, timestamp: now - DAY, username: 'alice' })];
        const current = [entry({ id: 2, timestamp: now, username: 'alice' })];
        const result = annotateEntries(current, history, now);
        expect(result[0].flags).not.toContain('first_seen_actor');
    });

    it('flags new_ip when actor has history but not from this ip', () => {
        const now = Date.now();
        const history = Array.from({ length: 6 }, (_, i) =>
            entry({ id: i + 1, timestamp: now - (i + 1) * HOUR, ip_address: '10.0.0.1' })
        );
        const current = [entry({ id: 99, timestamp: now, ip_address: '45.76.1.2' })];
        const result = annotateEntries(current, history, now);
        expect(result[0].flags).toContain('new_ip');
    });

    it('does not flag new_ip when ip matches historical value', () => {
        const now = Date.now();
        const history = [entry({ id: 1, timestamp: now - HOUR, ip_address: '10.0.0.1' })];
        const current = [entry({ id: 2, timestamp: now, ip_address: '10.0.0.1' })];
        const result = annotateEntries(current, history, now);
        expect(result[0].flags).not.toContain('new_ip');
    });

    it('ignores ips older than the 30-day window when scoring new_ip', () => {
        const now = Date.now();
        const history = [
            entry({ id: 1, timestamp: now - 45 * DAY, ip_address: '10.0.0.9' }),
            entry({ id: 2, timestamp: now - 2 * DAY, ip_address: '10.0.0.1' }),
        ];
        const current = [entry({ id: 3, timestamp: now, ip_address: '10.0.0.9' })];
        const result = annotateEntries(current, history, now);
        expect(result[0].flags).toContain('new_ip');
    });

    it('flags unusual_hour when entry falls outside the 7-day hour distribution', () => {
        const now = new Date('2026-04-18T03:15:00Z').getTime();
        const history = Array.from({ length: 10 }, (_, i) => {
            const ts = new Date('2026-04-15T10:00:00Z').getTime() + i * HOUR * 0.5;
            return entry({ id: i + 1, timestamp: ts, ip_address: '10.0.0.1' });
        });
        const current = [entry({ id: 99, timestamp: now })];
        const result = annotateEntries(current, history, now);
        expect(result[0].flags).toContain('unusual_hour');
    });

    it('does not flag unusual_hour when baseline is smaller than the minimum', () => {
        const now = Date.now();
        const history = [entry({ id: 1, timestamp: now - HOUR })];
        const current = [entry({ id: 2, timestamp: now })];
        const result = annotateEntries(current, history, now);
        expect(result[0].flags).not.toContain('unusual_hour');
    });

    it('returns empty flags for entries without a username', () => {
        const now = Date.now();
        const current = [entry({ id: 1, username: '' })];
        const result = annotateEntries(current, [], now);
        expect(result[0].flags).toEqual([]);
    });
});

describe('AuditAnomalyService - computeAuditStats', () => {
    const baseInput = (over: Partial<Parameters<typeof computeAuditStats>[0]> = {}) => ({
        events24: 0,
        events7d: 0,
        actors24: 0,
        failures24: 0,
        activityByHour: Array.from({ length: 24 }, () => 0),
        failuresByHour: Array.from({ length: 24 }, () => 0),
        newIpCount: 0,
        sampleNewIpActor: null as string | null,
        ...over,
    });

    it('summarizes events, actors, and failure rate from exact aggregates', () => {
        const activityByHour = Array.from({ length: 24 }, () => 0);
        activityByHour[12] = 20;
        const stats = computeAuditStats(baseInput({
            events24: 20,
            events7d: 20,
            actors24: 1,
            failures24: 3,
            activityByHour,
        }));
        expect(stats.events_24h.value).toBe(20);
        expect(stats.actors_24h.value).toBe(1);
        expect(stats.failure_rate.value).toBe(15);
        expect(stats.failure_rate.detail).toBe('3 of 20 requests');
        expect(stats.activity_by_hour).toHaveLength(24);
    });

    it('flags the new_ip detail when the aggregate reports a new pair', () => {
        const stats = computeAuditStats(baseInput({
            events24: 5,
            events7d: 5,
            actors24: 1,
            newIpCount: 2,
            sampleNewIpActor: 'admin',
        }));
        expect(stats.actors_24h.detail).toMatch(/2 new ips/);
        expect(stats.actors_24h.detail).toMatch(/admin/);
        expect(stats.actors_24h.severity).toBe('warn');
    });

    it('surfaces peak hour when it falls outside working hours', () => {
        const activityByHour = Array.from({ length: 24 }, () => 0);
        activityByHour[3] = 10;
        const stats = computeAuditStats(baseInput({
            events24: 10,
            events7d: 10,
            actors24: 1,
            activityByHour,
        }));
        expect(stats.unusual_hour.severity).toBe('warn');
        expect(stats.unusual_hour.value).toBe(3);
    });

    it('keeps peak hour blank inside working hours', () => {
        const activityByHour = Array.from({ length: 24 }, () => 0);
        activityByHour[14] = 8;
        const stats = computeAuditStats(baseInput({ events24: 8, events7d: 8, actors24: 1, activityByHour }));
        expect(stats.unusual_hour.value).toBeNull();
    });
});
