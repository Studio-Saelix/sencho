/**
 * Status of a node's image-update scanner, as returned by
 * `GET /api/image-updates/status`. Shared by the Settings cadence section and
 * the Auto-Update readiness strip so the wire shape lives in one place.
 *
 * Units differ by field: `intervalMinutes` and `manualCooldownMinutes` are
 * minutes; `manualCooldownRemainingMs` is milliseconds (the UI needs ms to tick
 * a 1-second countdown). `manualCooldownMinutes` is a fixed ceiling (the
 * cooldown window), while `manualCooldownRemainingMs` is the live remaining
 * time (0 when a manual refresh is allowed). `lastCheckedAt` / `nextCheckAt`
 * are epoch-ms or null ("never checked" / "not scheduled"); `nextCheckAt` is
 * ignored while `checking` is true.
 */
export interface ImageUpdateStatus {
    checking: boolean;
    intervalMinutes: number;
    lastCheckedAt: number | null;
    nextCheckAt: number | null;
    manualCooldownMinutes: number;
    manualCooldownRemainingMs: number;
    /** Active scheduling mode. */
    mode: 'interval' | 'cron';
    /** 5-field cron expression when mode is 'cron', null otherwise. */
    cronExpression: string | null;
}
