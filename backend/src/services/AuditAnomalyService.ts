import type { AuditLogEntry } from './DatabaseService';

export type AnomalyFlag = 'unusual_hour' | 'new_ip' | 'first_seen_actor';

export const HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const HOUR_BASELINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_HOURS_FOR_BASELINE = 5;

/**
 * Returns true when `hour` sits outside the central 90% of the actor's
 * typical activity window. Requires a minimum baseline to avoid flagging
 * actors whose first few logins happen to be during off-hours.
 */
export function isUnusualHour(hour: number, baselineHours: number[]): boolean {
    if (baselineHours.length < MIN_HOURS_FOR_BASELINE) return false;
    const sorted = [...baselineHours].sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.05)];
    const hi = sorted[Math.floor(sorted.length * 0.95)];
    return hour < lo || hour > hi;
}

interface ActorBaseline {
    hoursLast7d: number[];
    ipsLast30d: Set<string>;
}

function buildBaselines(history: AuditLogEntry[], now: number): Map<string, ActorBaseline> {
    const baselines = new Map<string, ActorBaseline>();
    const hourCutoff = now - HOUR_BASELINE_WINDOW_MS;
    const ipCutoff = now - HISTORY_WINDOW_MS;

    for (const entry of history) {
        if (!entry.username) continue;
        let b = baselines.get(entry.username);
        if (!b) {
            b = { hoursLast7d: [], ipsLast30d: new Set() };
            baselines.set(entry.username, b);
        }
        if (entry.timestamp >= hourCutoff) {
            b.hoursLast7d.push(new Date(entry.timestamp).getHours());
        }
        if (entry.timestamp >= ipCutoff && entry.ip_address) {
            b.ipsLast30d.add(entry.ip_address);
        }
    }
    return baselines;
}

/**
 * Annotate a page of entries with anomaly flags computed against strictly
 * prior history. The caller is responsible for supplying history entries
 * that do NOT overlap with the entries being annotated; typically pull
 * entries where `timestamp < min(entries.timestamp)` from the last 30 days.
 */
export interface AuditStatTile {
    value: number | null;
    label: string;
    detail: string | null;
    severity: 'ok' | 'warn' | 'alert';
}

export interface AuditStats {
    events_24h: AuditStatTile;
    actors_24h: AuditStatTile;
    failure_rate: AuditStatTile;
    unusual_hour: AuditStatTile;
    activity_by_hour: number[];
    failures_by_hour: number[];
}

/**
 * Format the signal-rail stats from exact aggregate inputs (see
 * DatabaseService.getAuditStatsInputs). This is pure presentation: counts,
 * hourly series, and new-ip detection are computed exactly upstream in SQL so
 * the tiles never undercount on a large window.
 */
export interface AuditStatsInput {
    events24: number;
    events7d: number;
    actors24: number;
    failures24: number;
    activityByHour: number[];
    failuresByHour: number[];
    newIpCount: number;
    sampleNewIpActor: string | null;
}

export function computeAuditStats(input: AuditStatsInput): AuditStats {
    const { events24, events7d, actors24, failures24, activityByHour, failuresByHour, newIpCount, sampleNewIpActor } = input;
    const prior7d = events7d - events24;
    const avg7dPerDay = Math.max(0, prior7d) / 6;
    const deltaPct = avg7dPerDay > 0 ? Math.round(((events24 - avg7dPerDay) / avg7dPerDay) * 100) : null;

    const failureRate = events24 > 0 ? failures24 / events24 : 0;
    const failurePct = Math.round(failureRate * 100);

    const peakHour = activityByHour.reduce(
        (best, count, hour) => (count > best.count ? { count, hour } : best),
        { count: -1, hour: 0 }
    );
    const peakIsOffHours = peakHour.count > 0 && (peakHour.hour < 8 || peakHour.hour >= 18);

    return {
        events_24h: {
            value: events24,
            label: 'events · 24h',
            detail: deltaPct === null ? 'no 7d baseline yet' : `${deltaPct >= 0 ? '+' : ''}${deltaPct}% vs 7d avg`,
            severity: deltaPct !== null && deltaPct > 150 ? 'warn' : 'ok',
        },
        actors_24h: {
            value: actors24,
            label: 'actors',
            detail: newIpCount > 0
                ? `${newIpCount} new ip${newIpCount === 1 ? '' : 's'}${sampleNewIpActor ? ` · ${sampleNewIpActor}` : ''}`
                : null,
            severity: newIpCount > 0 ? 'warn' : 'ok',
        },
        failure_rate: {
            value: failurePct,
            label: 'failure rate',
            detail: `${failures24} of ${events24} request${events24 === 1 ? '' : 's'}`,
            severity: failurePct >= 20 ? 'alert' : failurePct >= 5 ? 'warn' : 'ok',
        },
        unusual_hour: {
            value: peakIsOffHours ? peakHour.hour : null,
            label: 'peak hour',
            detail: peakIsOffHours
                ? `${peakHour.count} event${peakHour.count === 1 ? '' : 's'} at ${String(peakHour.hour).padStart(2, '0')}:00`
                : 'inside working hours',
            severity: peakIsOffHours ? 'warn' : 'ok',
        },
        activity_by_hour: activityByHour,
        failures_by_hour: failuresByHour,
    };
}

export function annotateEntries(
    entries: AuditLogEntry[],
    history: AuditLogEntry[],
    now: number = Date.now()
): (AuditLogEntry & { flags: AnomalyFlag[] })[] {
    const baselines = buildBaselines(history, now);

    return entries.map(entry => {
        const flags: AnomalyFlag[] = [];
        if (!entry.username) return { ...entry, flags };

        const baseline = baselines.get(entry.username);
        if (!baseline) {
            flags.push('first_seen_actor');
        } else {
            const entryHour = new Date(entry.timestamp).getHours();
            if (isUnusualHour(entryHour, baseline.hoursLast7d)) {
                flags.push('unusual_hour');
            }
            if (entry.ip_address && baseline.ipsLast30d.size > 0 && !baseline.ipsLast30d.has(entry.ip_address)) {
                flags.push('new_ip');
            }
        }

        return { ...entry, flags };
    });
}
