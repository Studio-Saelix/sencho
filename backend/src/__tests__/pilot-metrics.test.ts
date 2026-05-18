/**
 * PilotMetrics persistence behavior. Verifies the F-R-4 contract:
 *
 *   - cold start: zero counters, no DB row
 *   - cold start with a persisted blob: snapshot reflects persisted values
 *   - increments queue writes that drain on the threshold or interval
 *   - explicit flush() persists the current snapshot
 *   - malformed JSON in the DB row degrades gracefully (warn, zero state)
 *   - persisted blob missing a counter back-fills that field with zero
 *     (schema-drift scenario for releases that add a new counter)
 *   - stop() cancels a pending interval flush without writing
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let PilotMetrics: typeof import('../services/PilotMetrics').PilotMetrics;
let PILOT_METRICS_COUNTERS_KEY: string;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService, PILOT_METRICS_COUNTERS_KEY } = await import('../services/DatabaseService'));
    ({ PilotMetrics } = await import('../services/PilotMetrics'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    // Clear any persisted blob from a prior test and reset the singleton.
    const db = DatabaseService.getInstance();
    db.getDb().prepare('DELETE FROM system_state WHERE key = ?').run(PILOT_METRICS_COUNTERS_KEY);
    PilotMetrics.resetForTests();
});

afterEach(() => {
    PilotMetrics.stop();
    vi.useRealTimers();
});

describe('PilotMetrics persistence', () => {
    it('cold start: load with no row returns zeros and writes nothing', () => {
        const db = DatabaseService.getInstance();
        const setSpy = vi.spyOn(db, 'setPilotMetricsCounters');
        PilotMetrics.load(db);
        const snap = PilotMetrics.snapshot();
        expect(snap.proxy_dials_failed).toBe(0);
        expect(snap.proxy_bridges_total).toBe(0);
        expect(snap.proxy_idle_closes).toBe(0);
        expect(snap.tunnels_total).toBe(0);
        PilotMetrics.flush();
        expect(setSpy).not.toHaveBeenCalled();
        setSpy.mockRestore();
    });

    it('cold start with persisted blob: snapshot reflects persisted values', () => {
        const db = DatabaseService.getInstance();
        db.setPilotMetricsCounters({
            tunnels_total: 11,
            tunnels_replaced: 1,
            tunnels_rejected_capacity: 0,
            enroll_acks: 0,
            frame_decode_errors: 0,
            proxy_bridges_total: 7,
            proxy_dials_failed: 5,
            proxy_idle_closes: 2,
        });
        PilotMetrics.load(db);
        const snap = PilotMetrics.snapshot();
        expect(snap.tunnels_total).toBe(11);
        expect(snap.proxy_dials_failed).toBe(5);
        expect(snap.proxy_bridges_total).toBe(7);
    });

    it('threshold flush: increments past the threshold trigger a single persist', () => {
        const db = DatabaseService.getInstance();
        const setSpy = vi.spyOn(db, 'setPilotMetricsCounters');
        PilotMetrics.load(db, { threshold: 3, intervalMs: 60_000 });
        PilotMetrics.increment('proxy_dials_failed');
        PilotMetrics.increment('proxy_dials_failed');
        expect(setSpy).not.toHaveBeenCalled();
        PilotMetrics.increment('proxy_dials_failed');
        expect(setSpy).toHaveBeenCalledTimes(1);
        const written = setSpy.mock.calls[0][0];
        expect(written.proxy_dials_failed).toBe(3);
        setSpy.mockRestore();
    });

    it('interval flush: a single increment persists after the interval fires', () => {
        vi.useFakeTimers();
        const db = DatabaseService.getInstance();
        const setSpy = vi.spyOn(db, 'setPilotMetricsCounters');
        PilotMetrics.load(db, { threshold: 1000, intervalMs: 1_000 });
        PilotMetrics.increment('proxy_bridges_total');
        expect(setSpy).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1_000);
        expect(setSpy).toHaveBeenCalledTimes(1);
        expect(setSpy.mock.calls[0][0].proxy_bridges_total).toBe(1);
        setSpy.mockRestore();
    });

    it('explicit flush with no pending writes is a no-op', () => {
        const db = DatabaseService.getInstance();
        const setSpy = vi.spyOn(db, 'setPilotMetricsCounters');
        PilotMetrics.load(db);
        PilotMetrics.flush();
        expect(setSpy).not.toHaveBeenCalled();
        setSpy.mockRestore();
    });

    it('explicit flush after one increment persists immediately', () => {
        const db = DatabaseService.getInstance();
        const setSpy = vi.spyOn(db, 'setPilotMetricsCounters');
        PilotMetrics.load(db, { threshold: 1000, intervalMs: 60_000 });
        PilotMetrics.increment('proxy_idle_closes');
        PilotMetrics.flush();
        expect(setSpy).toHaveBeenCalledTimes(1);
        expect(setSpy.mock.calls[0][0].proxy_idle_closes).toBe(1);
        setSpy.mockRestore();
    });

    it('malformed JSON in the persisted row degrades to zero state', () => {
        const db = DatabaseService.getInstance();
        db.setSystemState(PILOT_METRICS_COUNTERS_KEY, '{not json');
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        PilotMetrics.load(db);
        const snap = PilotMetrics.snapshot();
        expect(snap.proxy_dials_failed).toBe(0);
        expect(warnSpy).toHaveBeenCalled();
        PilotMetrics.increment('proxy_dials_failed');
        expect(PilotMetrics.snapshot().proxy_dials_failed).toBe(1);
        warnSpy.mockRestore();
    });

    it('schema drift: persisted blob missing a counter back-fills with zero', () => {
        const db = DatabaseService.getInstance();
        db.setSystemState(
            PILOT_METRICS_COUNTERS_KEY,
            JSON.stringify({ proxy_dials_failed: 9 }),
        );
        PilotMetrics.load(db);
        const snap = PilotMetrics.snapshot();
        expect(snap.proxy_dials_failed).toBe(9);
        expect(snap.proxy_bridges_total).toBe(0);
        expect(snap.tunnels_total).toBe(0);
        expect(snap.proxy_idle_closes).toBe(0);
    });

    it('stop() cancels a pending interval flush without persisting', () => {
        vi.useFakeTimers();
        const db = DatabaseService.getInstance();
        const setSpy = vi.spyOn(db, 'setPilotMetricsCounters');
        PilotMetrics.load(db, { threshold: 1000, intervalMs: 1_000 });
        PilotMetrics.increment('proxy_dials_failed');
        PilotMetrics.stop();
        vi.advanceTimersByTime(5_000);
        expect(setSpy).not.toHaveBeenCalled();
        setSpy.mockRestore();
    });

    it('flush() catches DB write errors without losing pending count', () => {
        const db = DatabaseService.getInstance();
        const setSpy = vi
            .spyOn(db, 'setPilotMetricsCounters')
            .mockImplementationOnce(() => { throw new Error('disk full'); })
            .mockImplementationOnce(() => undefined);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        PilotMetrics.load(db, { threshold: 1000, intervalMs: 60_000 });
        PilotMetrics.increment('proxy_dials_failed');
        PilotMetrics.flush();
        expect(setSpy).toHaveBeenCalledTimes(1);
        expect(errSpy).toHaveBeenCalled();
        // Counter still in memory; next successful flush persists the value.
        PilotMetrics.flush();
        expect(setSpy).toHaveBeenCalledTimes(2);
        expect(setSpy.mock.calls[1][0].proxy_dials_failed).toBe(1);
        setSpy.mockRestore();
        errSpy.mockRestore();
    });
});
