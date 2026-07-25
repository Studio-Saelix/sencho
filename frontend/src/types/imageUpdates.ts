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
    /** Whether sidebar update-status indicators are enabled. Optional for older-node compatibility. */
    sidebarIndicators?: boolean;
}

/**
 * Per-stack image-update check outcome. 'ok' = every checkable image was
 * reached; 'partial' = some checkable images errored; 'failed' = no checkable
 * image could be reached, so update status is undeterminable (distinct from a
 * confirmed "up to date").
 */
export type CheckStatus = 'ok' | 'partial' | 'failed';

/**
 * Per-service check outcome, as returned in `StackUpdateInfo.services`.
 * Mirrors the backend's `StackServiceStatus`. Distinct from `CheckStatus`:
 * a service with no checkable image (build-only, no declared image) is
 * `not_checkable`, which never counts as a check failure at the stack level.
 */
export type ServiceCheckStatus = 'ok' | 'partial' | 'failed' | 'not_checkable';

export interface StackServiceUpdateStatus {
    service: string;
    image: string | null;
    runtimeImages?: string[];
    hasUpdate: boolean;
    checkStatus: ServiceCheckStatus;
    lastError: string | null;
}

/**
 * Rich per-stack update status from `GET /api/image-updates/detail`. `lastError`
 * carries the failure reason when `checkStatus` is 'failed' or 'partial'.
 */
export interface StackUpdateInfo {
    hasUpdate: boolean;
    checkStatus: CheckStatus;
    lastError: string | null;
    checkedAt: number;
    /** Per-service breakdown; absent when the stack has no persisted per-service data yet. */
    services?: StackServiceUpdateStatus[];
}

/**
 * Confirmed update for sidebar / Updates filter / dashboard / Fleet.
 * Missing checkStatus is treated as 'ok' for older-node /detail fallbacks.
 * Partial or failed rows with hasUpdate=true are NOT confirmed.
 */
export function isConfirmedImageUpdate(info: { hasUpdate: boolean; checkStatus?: CheckStatus }): boolean {
    return info.hasUpdate && (info.checkStatus ?? 'ok') === 'ok';
}

/** Confirmed per-service update for editor Update badges. */
export function isConfirmedServiceUpdate(info: {
    hasUpdate: boolean;
    checkStatus?: ServiceCheckStatus;
}): boolean {
    return info.hasUpdate && (info.checkStatus ?? 'ok') === 'ok';
}

/**
 * True when a live update-preview is safe to treat as "no update" for Fleet
 * card drops and similar UI reconcile. Mirrors backend
 * UpdatePreviewService.isAuthoritativeNegativePreview: every image must be
 * explicitly ok, and !has_update. Empty / mixed not_checkable previews never clear.
 */
export function isAuthoritativeNegativePreview(preview: {
    images: Array<{ check_status?: string | null }>;
    summary: { has_update: boolean; check_status?: string | null };
} | null | undefined): boolean {
    if (!preview) return false;
    return preview.images.length > 0
        && preview.images.every((i) => i.check_status === 'ok')
        && preview.summary.has_update === false;
}
