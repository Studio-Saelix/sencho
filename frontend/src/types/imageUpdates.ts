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
    /**
     * Whether background image-update detection is armed. Optional for older
     * remotes; absence means the node does not support the opt-out yet.
     */
    enabled?: boolean;
}

/** Hub-only scanner status selected by targetNodeId, with epoch-ms timestamps. */
export interface ImageUpdateOverlayStatus {
    enabled: boolean;
    checking: boolean;
    cooldownEndsAt: number | null;
    lastCheckedAt: number | null;
    nextRunAt: number | null;
    mode: string | null;
    cronExpression: string | null;
    intervalMinutes: number;
    intervalUnit: 'minutes';
    scannerOwner: 'hub' | 'target';
    capability: 'remote-image-inspect-v1' | null;
    sidebarIndicators: boolean;
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
    /**
     * What the service's update detection labels did on the last check: `off`
     * when `io.sencho.update.check` is false, `ignored` when every pending
     * update was skipped by `io.sencho.update.ignore`. Absent otherwise, and on
     * an older node.
     */
    detection?: 'off' | 'ignored';
}

/**
 * What an unattended image refresh (scheduled, automatic, webhook, bulk) would
 * do for a stack, as the node's one policy evaluator decided. Absent on an
 * older node, which shows no policy note rather than an allowed update.
 */
export interface StackUnattendedPolicy {
    decision: 'allow' | 'skip';
    /** Services the label keeps out of an unattended refresh, with their declared policy. */
    ineligible: Array<{ service: string; policy: string }>;
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
    /** The unattended decision, when the node recorded one. */
    unattendedPolicy?: StackUnattendedPolicy;
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

export type SemverBump = 'none' | 'patch' | 'minor' | 'major' | 'unknown';
export type UpdateKind = 'tag' | 'digest' | 'none';

/**
 * One image of `GET /stacks/:name/update-preview`, per service. Shared by the
 * Updates view and the stack's Anatomy update banner. Optional fields are
 * absent on older nodes.
 */
export interface UpdatePreviewImage {
    service: string;
    image: string;
    current_tag: string;
    next_tag: string | null;
    has_update: boolean;
    digest_update?: boolean;
    tag_update?: boolean;
    semver_bump: SemverBump;
    /** Absent on older remotes; backend uses !== 'not_checkable' for checkability. */
    check_status?: 'ok' | 'partial' | 'failed' | 'not_checkable';
    check_error?: string | null;
    /** This image's own digest-comparison failure; not masked by a confirmed tag update. */
    digest_error?: string | null;
    /**
     * What the service's update detection labels did: `off` when its checks are
     * off, `ignored` when every pending update was skipped.
     */
    detection?: 'off' | 'ignored';
    /** The registry's current digest for the tag on a same-tag rebuild: the entry that skips it. */
    candidate_digest?: string | null;
    /** The service's `io.sencho.update.changelog` link, on a pending update only. */
    changelog_url?: string | null;
}

export interface UpdatePreviewSummary {
    has_update: boolean;
    primary_image: string | null;
    current_tag: string | null;
    next_tag: string | null;
    semver_bump: SemverBump;
    update_kind?: UpdateKind;
    blocked: boolean;
    blocked_reason: string | null;
    has_build_services?: boolean;
    rebuild_available?: boolean;
    /** Absent on older remotes; treat missing as non-authoritative. */
    check_status?: 'ok' | 'partial' | 'failed';
    verification_failed?: boolean;
    verification_error?: string | null;
}

export interface UpdatePreview {
    stack_name?: string;
    images: UpdatePreviewImage[];
    summary: UpdatePreviewSummary;
    build_services?: string[];
    rollback_target?: string | null;
}
