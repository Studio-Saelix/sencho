import path from 'path';
import YAML from 'yaml';
import { CronExpressionParser } from 'cron-parser';
import DockerController from './DockerController';
import { DatabaseService, type StackCheckStatus, type StackServiceStatus } from './DatabaseService';
import { FileSystemService } from './FileSystemService';
import { RegistryService } from './RegistryService';
import { NodeRegistry } from './NodeRegistry';
import { NotificationService } from './NotificationService';
import { sanitizeNotificationMessage } from '../utils/notificationMessage';
import { parseImageRef, selectLocalRepoDigests } from './registry-api';
import { detectImageUpdate, type PreviewImageCheckStatus } from './imageUpdateDetect';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';
import { buildEffectiveServiceModel } from './effectiveServiceModel';
import { invalidateFleetUpdateCache } from '../helpers/fleetUpdateCache';

const BACKFILL_KEY = 'image_update_notifications_backfilled';

/** Post-update scanner reconciliation outcome for a single stack. */
export type StackRecheckOutcome =
    | 'cleared'
    | 'still_present'
    | 'verification_incomplete'
    | 'verification_failed';

export interface StackRecheckResult {
    outcome: StackRecheckOutcome;
    /** Present when the update condition remains or could not be verified. */
    warning: string | null;
}

export const UPDATE_STILL_PRESENT_WARNING =
    'The update command completed, but Sencho still detects an available image update.';

export const UPDATE_VERIFICATION_INCOMPLETE_WARNING =
    'The update command completed, but Sencho could not fully verify whether an image update remains.';

// Mirrored verbatim in GENERIC_POST_UPDATE_WARNINGS in
// frontend/src/components/EditorLayout/hooks/useStackActions.ts; keep the copy in sync.
export const UPDATE_DIGEST_UNCHANGED_WARNING =
    'The update command completed, but the image digest was not updated. Your Docker daemon may cache older content through a registry mirror, or the container may still be pinned to the previous image. Check your daemon configuration or recreate the container with --force-recreate.';

export interface ImageCheckResult {
    hasUpdate: boolean;
    /** Same-tag registry digest drift; Compose pull can apply without pin change. */
    digestUpdate?: boolean;
    /** Higher semver tag exists; UI may show it but Compose auto-apply cannot pin it. */
    tagUpdate?: boolean;
    /** Detector authority; consumed by reduceServiceStatus / writeStackUpdateStatus. */
    checkStatus?: PreviewImageCheckStatus;
    error?: string;
    /**
     * The image is not registry-backed (locally built, or a bare digest ref
     * with no resolvable tag), so update status is not applicable. Distinct
     * from `error`: such an image must be excluded from a stack's pass/fail
     * tally rather than counted as a failed or up-to-date check.
     */
    notCheckable?: boolean;
}

/**
 * Normalize check authority for reduction. Test stubs / older callers may omit
 * checkStatus: error means failed, else ok.
 */
export function normalizeImageCheckStatus(r: ImageCheckResult): PreviewImageCheckStatus {
    if (r.notCheckable) return 'not_checkable';
    if (r.checkStatus) return r.checkStatus;
    if (r.error) return 'failed';
    return 'ok';
}

/**
 * Snapshot of the scanner returned by GET /api/image-updates/status.
 * Units differ by field: `intervalMinutes` / `manualCooldownMinutes` are
 * minutes, `manualCooldownRemainingMs` is milliseconds. `manualCooldownMinutes`
 * is the fixed cooldown ceiling; `manualCooldownRemainingMs` is the live
 * remaining time (0 when a manual refresh is allowed). `lastCheckedAt` /
 * `nextCheckAt` are epoch-ms or null ("never checked" / "not scheduled");
 * `nextCheckAt` is meaningless while `checking` is true.
 * `mode` is the active scheduling mode; `cronExpression` is the 5-field
 * expression when mode is 'cron', null otherwise or when unconfigured.
 * `enabled` is whether background image-update detection is armed; always
 * present on current nodes, optional on the wire for older remotes.
 */
export interface ImageUpdateStatus {
    checking: boolean;
    intervalMinutes: number;
    lastCheckedAt: number | null;
    nextCheckAt: number | null;
    manualCooldownMinutes: number;
    manualCooldownRemainingMs: number;
    mode: 'interval' | 'cron';
    cronExpression: string | null;
    sidebarIndicators: boolean;
    enabled: boolean;
}

// ─── Compose file helpers ────────────────────────────────────────────────────

export function loadDotEnv(content: string): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        vars[key] = val;
    }
    return vars;
}

export interface ComposeServiceImage {
    service: string;
    image: string;
}

export function extractServiceImagesFromCompose(
    yamlContent: string,
    envVars: Record<string, string>,
): ComposeServiceImage[] {
    let parsed: Record<string, unknown>;
    try {
        parsed = YAML.parse(yamlContent) as Record<string, unknown>;
    } catch {
        return [];
    }
    if (!parsed?.services || typeof parsed.services !== 'object') return [];

    const out: ComposeServiceImage[] = [];
    for (const [service, svc] of Object.entries(parsed.services as Record<string, unknown>)) {
        if (!svc || typeof svc !== 'object') continue;
        const raw = (svc as Record<string, unknown>).image;
        if (!raw || typeof raw !== 'string') continue;

        let ref = raw.replace(
            /\$\{([^}]+)\}/g,
            (_: string, expr: string) => {
                const defaultMatch = expr.match(/^([^:-]+)(?::?-)(.+)$/);
                if (defaultMatch) {
                    return envVars[defaultMatch[1]] ?? defaultMatch[2];
                }
                return envVars[expr] ?? '';
            }
        );

        ref = ref.trim();
        if (!ref || ref.includes('${') || ref.startsWith('sha256:')) continue;
        out.push({ service, image: ref });
    }
    return out;
}

export function extractImagesFromCompose(
    yamlContent: string,
    envVars: Record<string, string>,
): string[] {
    return extractServiceImagesFromCompose(yamlContent, envVars).map(e => e.image);
}

/**
 * Extract service images from a `docker compose config --format json` render.
 * The render is already merged + interpolated, so no env substitution is needed.
 */
export function extractServiceImagesFromRenderedConfig(renderedJson: string): ComposeServiceImage[] {
    let parsed: { services?: Record<string, { image?: unknown }> };
    try {
        parsed = JSON.parse(renderedJson);
    } catch {
        return [];
    }
    if (!parsed?.services || typeof parsed.services !== 'object') return [];
    const out: ComposeServiceImage[] = [];
    for (const [service, svc] of Object.entries(parsed.services)) {
        const raw = svc?.image;
        if (!raw || typeof raw !== 'string') continue;
        const ref = raw.trim();
        if (!ref || ref.startsWith('sha256:')) continue;
        out.push({ service, image: ref });
    }
    return out;
}

/**
 * Service-name -> image refs for a stack. For a Git stack with an applied
 * multi-file / context-dir spec, this comes from the effective merged model
 * (docker compose config), so a service/image declared only in an override file
 * is included. Returns null for single-file / non-git stacks (and on a render
 * failure) so the caller falls back to its existing single-file compose parse.
 */
export async function loadEffectiveServiceImages(nodeId: number, stackName: string): Promise<ComposeServiceImage[] | null> {
    const spec = DatabaseService.getInstance().getGitSource(stackName)?.applied_deploy_spec;
    if (!spec || spec.files.length === 0) return null;
    // Lazy import to avoid a static module cycle (ComposeService is a heavy hub).
    const { ComposeService } = await import('./ComposeService');
    const rendered = await ComposeService.getInstance(nodeId).renderConfig(stackName);
    if (!rendered.rendered) {
        // The effective render failed (unset var, bad include, timeout, output cap).
        // Falling back to the root-compose parse misses override-only images, so log
        // the reason; without this the degradation is invisible to the operator.
        console.warn(
            `[ImageUpdateService] effective image render failed for "${sanitizeForLog(stackName)}" (code=${rendered.code} timedOut=${rendered.timedOut}); falling back to root-compose parse: ${sanitizeForLog(rendered.stderr)}`,
        );
        return null;
    }
    return extractServiceImagesFromRenderedConfig(rendered.rendered);
}

/** True when a service declares a non-empty `build:` section (string path or object). */
function serviceHasBuild(build: unknown): boolean {
    if (build === undefined || build === null) return false;
    if (typeof build === 'string') return build.trim().length > 0;
    if (typeof build === 'object') return Object.keys(build as Record<string, unknown>).length > 0;
    return false;
}

/** Service names that declare `build:` in raw compose YAML (single-file path). */
export function extractBuildServicesFromCompose(yamlContent: string): string[] {
    let parsed: Record<string, unknown>;
    try {
        parsed = YAML.parse(yamlContent) as Record<string, unknown>;
    } catch {
        return [];
    }
    if (!parsed?.services || typeof parsed.services !== 'object') return [];

    const out: string[] = [];
    for (const [service, svc] of Object.entries(parsed.services as Record<string, unknown>)) {
        if (!svc || typeof svc !== 'object') continue;
        if (serviceHasBuild((svc as Record<string, unknown>).build)) {
            out.push(service);
        }
    }
    return out;
}

/**
 * Service names with a `build:` section from a `docker compose config --format json`
 * render (merged + interpolated; no env substitution needed).
 */
export function extractBuildServicesFromRenderedConfig(renderedJson: string): string[] {
    let parsed: { services?: Record<string, { build?: unknown }> };
    try {
        parsed = JSON.parse(renderedJson);
    } catch {
        return [];
    }
    if (!parsed?.services || typeof parsed.services !== 'object') return [];
    const out: string[] = [];
    for (const [service, svc] of Object.entries(parsed.services)) {
        if (serviceHasBuild(svc?.build)) out.push(service);
    }
    return out;
}

/**
 * Service names that use `build:` for a stack. For a Git stack with an applied
 * multi-file / context-dir spec, reads the effective merged model so override-only
 * build services are included. Returns null for single-file stacks (and on render
 * failure) so the caller falls back to the root-compose parse.
 */
export async function loadEffectiveBuildServices(nodeId: number, stackName: string): Promise<string[] | null> {
    const spec = DatabaseService.getInstance().getGitSource(stackName)?.applied_deploy_spec;
    if (!spec || spec.files.length === 0) return null;
    const { ComposeService } = await import('./ComposeService');
    const rendered = await ComposeService.getInstance(nodeId).renderConfig(stackName);
    if (!rendered.rendered) {
        console.warn(
            `[ImageUpdateService] effective build render failed for "${sanitizeForLog(stackName)}" (code=${rendered.code} timedOut=${rendered.timedOut}); falling back to root-compose parse: ${sanitizeForLog(rendered.stderr)}`,
        );
        return null;
    }
    return extractBuildServicesFromRenderedConfig(rendered.rendered);
}

/** Resolved build-service names for any stack (effective model or root compose). */
export async function loadStackBuildServices(nodeId: number, stackName: string): Promise<string[]> {
    const effective = await loadEffectiveBuildServices(nodeId, stackName);
    if (effective) return effective;

    const fs = FileSystemService.getInstance(nodeId);
    const composeContent = await fs.getStackContent(stackName);
    return extractBuildServicesFromCompose(composeContent);
}

// ─── Per-service reduction (model-based status) ─────────────────────────────

export interface ServiceReduction {
    status: StackServiceStatus;
    confirmedUpdateThisRun: boolean;
}

export function reduceServiceStatus(
    service: string,
    declaredImage: string | null,
    runtimeImages: string[],
    imageUpdateMap: Map<string, ImageCheckResult>,
    prior: StackServiceStatus | undefined,
): ServiceReduction {
    const dedupedRuntime = [...new Set(runtimeImages)].sort();
    const refs = new Set<string>();
    if (declaredImage) refs.add(declaredImage);
    for (const ref of dedupedRuntime) refs.add(ref);

    if (refs.size === 0) {
        return {
            status: { service, image: declaredImage, hasUpdate: false, checkStatus: 'not_checkable', lastError: null },
            confirmedUpdateThisRun: false,
        };
    }

    const checkableResults: ImageCheckResult[] = [];
    for (const ref of refs) {
        const result = imageUpdateMap.get(ref);
        if (!result) continue;
        if (normalizeImageCheckStatus(result) === 'not_checkable') continue;
        checkableResults.push(result);
    }

    if (checkableResults.length === 0) {
        return {
            status: { service, image: declaredImage, hasUpdate: false, checkStatus: 'not_checkable', lastError: null },
            confirmedUpdateThisRun: false,
        };
    }

    const statuses = checkableResults.map(normalizeImageCheckStatus);
    const failed = checkableResults.filter((_, i) => statuses[i] === 'failed');
    const partial = checkableResults.filter((_, i) => statuses[i] === 'partial');
    const confirmedUpdateThisRun = checkableResults.some(
        (r, i) => statuses[i] === 'ok' && r.hasUpdate === true,
    );

    if (failed.length === checkableResults.length) {
        const priorHasUpdate = prior?.hasUpdate ?? false;
        return {
            status: {
                service,
                image: declaredImage,
                ...(dedupedRuntime.length > 0 ? { runtimeImages: dedupedRuntime } : {}),
                hasUpdate: priorHasUpdate,
                checkStatus: 'failed',
                lastError: failed[0].error ?? 'Update check failed',
            },
            confirmedUpdateThisRun: false,
        };
    }

    const checkStatus: StackServiceStatus['checkStatus'] =
        failed.length > 0 || partial.length > 0 ? 'partial' : 'ok';
    const uncertain = [...partial, ...failed];
    const lastError = uncertain.length > 0 ? (uncertain[0].error ?? null) : null;
    const hasUpdate = checkStatus === 'partial'
        ? (confirmedUpdateThisRun || (prior?.hasUpdate ?? false))
        : confirmedUpdateThisRun;

    return {
        status: {
            service,
            image: declaredImage,
            ...(dedupedRuntime.length > 0 ? { runtimeImages: dedupedRuntime } : {}),
            hasUpdate,
            checkStatus,
            lastError,
        },
        confirmedUpdateThisRun,
    };
}

export function aggregateServiceCheckStatus(services: StackServiceStatus[]): StackCheckStatus {
    if (services.length === 0) return 'ok';
    const checkable = services.filter((s) => s.checkStatus !== 'not_checkable');
    if (checkable.length === 0) return 'ok';
    const failedCount = checkable.filter((s) => s.checkStatus === 'failed').length;
    if (failedCount === checkable.length) return 'failed';
    if (checkable.some((s) => s.checkStatus === 'partial')
        || checkable.some((s) => s.checkStatus === 'failed')) {
        return 'partial';
    }
    return 'ok';
}

export function buildAvailabilityNotifyMessage(stackName: string, services: StackServiceStatus[]): string {
    const named = services.filter((s) => s.hasUpdate).map((s) => s.service).sort();
    if (named.length === 0 || services.length <= 1) {
        return `Stack "${stackName}" has image updates available.`;
    }
    if (named.length === 1) {
        return `Stack "${stackName}" has image updates available for service: ${named[0]}.`;
    }
    return `Stack "${stackName}" has image updates available for services: ${named.join(', ')}.`;
}

function stackStatusLastError(services: StackServiceStatus[]): string | null {
    for (const svc of services) {
        if (svc.checkStatus !== 'not_checkable' && svc.lastError) return svc.lastError;
    }
    return null;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class ImageUpdateService {
    private static instance: ImageUpdateService;

    /** Per-stack write serialization and generation for stale-writer discard. */
    private stackWriteState = new Map<string, { chain: Promise<void>; generation: number }>();

    private static readonly MIN_INTERVAL_MINUTES = 15;
    private static readonly MAX_INTERVAL_MINUTES = 1440;          // 24 hours
    private static readonly DEFAULT_INTERVAL_MINUTES = 120;       // 2 hours
    private static readonly INTERVAL_SETTING_KEY = 'image_update_check_interval_minutes';
    private static readonly MODE_SETTING_KEY = 'image_update_check_mode';
    private static readonly CRON_SETTING_KEY = 'image_update_check_cron';
    private static readonly ENABLED_SETTING_KEY = 'image_update_checks_enabled';
    private static readonly JITTER_FRACTION = 0.1;                // ±10% so a fleet does not poll in lockstep
    private static readonly STARTUP_DELAY_MS = 2 * 60 * 1000;    // 2 min after boot

    // A single self-rescheduling timer (replacing the old setInterval): it lets
    // us know nextCheckAt precisely, apply per-run jitter, and reschedule on a
    // settings change without ever leaving two timers running.
    private timer: NodeJS.Timeout | null = null;
    private polling = false;
    // Bumped by stop()/restartPolling(); a tick whose captured generation no
    // longer matches must not re-arm. This is what stops a settings save that
    // lands mid-scan from racing the in-flight tick into a duplicate timer.
    private scheduleGeneration = 0;
    private isRunning = false;
    private checkStartedAt = 0;
    private lastManualRefreshAt = 0;
    // Per-stack recheck cooldown (key: `${nodeId}:${stackName}`). Enforces the
    // same MANUAL_COOLDOWN_MS as the node-wide triggerManualRefresh, and also
    // acts as an in-flight gate: the mark writes before the first await, so a
    // second synchronous check-and-mark on the same event-loop tick sees the
    // first entry and is denied.
    private perStackRecheckAt = new Map<string, number>();
    private lastCheckedAt: number | null = null;   // when the last scan body started
    private nextCheckAt: number | null = null;
    // Initialized at declaration so getStatus() never reports NaN before start()
    // or configureFromSettings() has run (e.g. route tests that skip startServer).
    private intervalMs = ImageUpdateService.DEFAULT_INTERVAL_MINUTES * 60 * 1000;
    private mode: 'interval' | 'cron' = 'interval';
    private cronExpression: string | null = null;
    private static readonly MANUAL_COOLDOWN_MS = 2 * 60 * 1000;  // 2 min between manual triggers
    private static readonly INTER_IMAGE_DELAY_MS = 300;           // be polite to registries
    private static readonly CHECK_TIMEOUT_MS = 5 * 60 * 1000;     // threshold for the "running long" skip warning
    private static readonly SOCKET_TIMEOUT_MS = 30 * 1000;        // per-call cap on Docker socket / filesystem reads

    public static get manualCooldownMinutes(): number {
        return ImageUpdateService.MANUAL_COOLDOWN_MS / (60 * 1000);
    }

    private constructor() { }

    public static getInstance(): ImageUpdateService {
        if (!ImageUpdateService.instance) {
            ImageUpdateService.instance = new ImageUpdateService();
        }
        return ImageUpdateService.instance;
    }

    public start() {
        if (this.timer) return;
        this.configureFromSettings();
        if (!ImageUpdateService.isChecksEnabled()) {
            // Detection opted out: stay stopped across restarts so a boot does
            // not re-arm registry polling until the setting is turned back on.
            this.polling = false;
            this.nextCheckAt = null;
            return;
        }
        this.polling = true;
        // Interval mode keeps the 2-minute post-boot delay before the first check.
        // Cron mode honors its schedule: arm at the next cron fire time so a restart
        // never triggers an out-of-cadence check (e.g. a weekly cron must not run on
        // every boot).
        this.armNext(this.mode === 'cron' ? this.nextDelayMs() : ImageUpdateService.STARTUP_DELAY_MS);
    }

    public stop() {
        this.scheduleGeneration++;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.polling = false;
        this.nextCheckAt = null;
    }

    /**
     * Re-read the configured interval and reschedule the next check at the new
     * cadence without restarting Sencho. Safe to call repeatedly: it always
     * clears the existing timer first and only arms a new one while polling, so
     * it never stacks timers and is a no-op (beyond reconfiguring intervalMs)
     * when the service is stopped or was never started. When checks are
     * disabled, clears nextCheckAt and does not arm.
     */
    public restartPolling(): void {
        this.scheduleGeneration++;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.configureFromSettings();
        if (this.polling && ImageUpdateService.isChecksEnabled()) {
            this.armNext(this.nextDelayMs());
        } else {
            this.nextCheckAt = null;
        }
    }

    /**
     * Whether background image-update detection is enabled. Missing or blank
     * keys default to enabled so upgrades and pre-seed races keep polling.
     */
    public static isChecksEnabled(): boolean {
        try {
            const raw = DatabaseService.getInstance().getGlobalSettings()[ImageUpdateService.ENABLED_SETTING_KEY];
            if (raw == null || String(raw).trim() === '') return true;
            return raw === '1';
        } catch (e) {
            console.warn('[ImageUpdateService] Could not read checks-enabled setting; treating as enabled:', getErrorMessage(e, String(e)));
            return true;
        }
    }

    /**
     * Persist the checks-enabled setting and apply the live transition: stop
     * + clear findings when turning off; start (or re-arm) when turning on.
     * Safe under repeated toggles (scheduleGeneration bump via stop/start).
     */
    public applyChecksEnabled(enabled: boolean): ImageUpdateStatus {
        const db = DatabaseService.getInstance();
        db.updateGlobalSetting(ImageUpdateService.ENABLED_SETTING_KEY, enabled ? '1' : '0');

        if (!enabled) {
            this.stop();
            // Scanner only writes rows for local nodes. Use the local default
            // node ID, not req.nodeId (which may be a remote active node).
            const localNodeId = NodeRegistry.getInstance().getDefaultNodeId();
            db.clearAllStackUpdateStatus(localNodeId);
            invalidateFleetUpdateCache();
            NotificationService.getInstance().broadcastEvent({
                type: 'state-invalidate',
                scope: 'image-updates',
                nodeId: localNodeId,
                action: 'checks-disabled',
                ts: Date.now(),
            });
            return this.getStatus();
        }

        // Re-enable: arm a fresh schedule. start() is a no-op if a timer already
        // exists; when we were fully stopped, start() arms. When somehow still
        // marked polling without a timer, restartPolling re-arms.
        if (!this.timer) {
            this.start();
        } else {
            this.restartPolling();
        }
        return this.getStatus();
    }

    /**
     * Reads image_update_check_interval_minutes into intervalMs, clamped to
     * [15, 1440], falling back to the 2-hour default on a missing, blank,
     * malformed, or unreadable value. Also reads mode and cron expression
     * from global_settings; falls back to interval mode when cron is
     * unconfigured or unparseable.
     */
    public configureFromSettings(): void {
        this.intervalMs = ImageUpdateService.resolveIntervalMinutes() * 60 * 1000;

        const settings = DatabaseService.getInstance().getGlobalSettings();
        const rawMode = settings[ImageUpdateService.MODE_SETTING_KEY];
        this.mode = (rawMode === 'cron') ? 'cron' : 'interval';

        if (this.mode === 'cron') {
            const rawCron = settings[ImageUpdateService.CRON_SETTING_KEY];
            if (typeof rawCron === 'string' && rawCron.trim()) {
                try {
                    const expr = CronExpressionParser.parse(rawCron);
                    expr.next(); // prove the expression can produce a next fire time
                    this.cronExpression = rawCron.trim();
                } catch {
                    console.warn(`[ImageUpdateService] Cron expression is invalid; falling back to interval mode. Expression: "${rawCron}"`);
                    this.mode = 'interval';
                    this.cronExpression = null;
                }
            } else {
                console.warn('[ImageUpdateService] Cron mode is active but no expression is set; falling back to interval mode.');
                this.mode = 'interval';
                this.cronExpression = null;
            }
        } else {
            this.cronExpression = null;
        }
    }

    private static resolveIntervalMinutes(): number {
        const fallback = ImageUpdateService.DEFAULT_INTERVAL_MINUTES;
        try {
            const raw = DatabaseService.getInstance().getGlobalSettings()[ImageUpdateService.INTERVAL_SETTING_KEY];
            // Treat missing/blank as unset; Number('') is 0, which would clamp to
            // the minimum rather than fall back to the default.
            if (raw == null || String(raw).trim() === '') return fallback;
            // Number() (not parseInt) so a malformed value like "15abc" is
            // rejected to the default rather than silently accepted as 15.
            const parsed = Number(raw);
            if (!Number.isInteger(parsed)) return fallback;
            return Math.min(
                ImageUpdateService.MAX_INTERVAL_MINUTES,
                Math.max(ImageUpdateService.MIN_INTERVAL_MINUTES, parsed),
            );
        } catch (e) {
            console.warn('[ImageUpdateService] Could not read interval setting; using default:', getErrorMessage(e, String(e)));
            return fallback;
        }
    }

    private armNext(delayMs: number): void {
        this.nextCheckAt = Date.now() + delayMs;
        const gen = this.scheduleGeneration;
        this.timer = setTimeout(() => { void this.tick(gen); }, delayMs);
    }

    private async tick(gen: number): Promise<void> {
        if (!this.polling || gen !== this.scheduleGeneration) return;
        try {
            await this.check();
        } finally {
            // Only the tick whose generation is still current re-arms. A
            // restartPolling()/stop() that landed during the await bumped the
            // generation and already rescheduled or cleared, so a stale tick
            // bailing here is what keeps exactly one timer alive.
            if (this.polling && gen === this.scheduleGeneration) {
                this.armNext(this.nextDelayMs());
            }
        }
    }

    /**
     * Compute the next check delay. In interval mode this is intervalMs with
     * ±10% jitter. In cron mode the delay is the gap between now and the next
     * cron fire time, with no jitter (the user chose a specific time). Falls
     * back to interval mode if the cron expression cannot be parsed at runtime.
     */
    private nextDelayMs(): number {
        if (this.mode === 'cron' && this.cronExpression) {
            try {
                const expr = CronExpressionParser.parse(this.cronExpression);
                const nextFire = expr.next().toDate().getTime();
                const delay = nextFire - Date.now();
                if (delay <= 0) {
                    // We just passed the fire time; retry in 30 s so the next
                    // .next() call moves to the following occurrence.
                    return 30_000;
                }
                return delay;
            } catch (e) {
                console.warn('[ImageUpdateService] Cron expression became invalid at runtime; falling back to interval mode:', getErrorMessage(e, String(e)));
                this.mode = 'interval';
                this.cronExpression = null;
                // Fall through to interval-based delay below.
            }
        }
        const jitter = this.intervalMs * ImageUpdateService.JITTER_FRACTION;
        return Math.round(this.intervalMs - jitter + Math.random() * 2 * jitter);
    }

    /**
     * Triggers a check immediately, unless detection is disabled, one is already
     * running, or the manual cooldown (MANUAL_COOLDOWN_MS) has not elapsed.
     * Returns false if rate-limited or disabled, true if a check was started.
     * Callers that need to distinguish disabled from rate-limited must check
     * isChecksEnabled() first.
     */
    public triggerManualRefresh(): boolean {
        if (!ImageUpdateService.isChecksEnabled()) {
            return false;
        }
        const now = Date.now();
        if (now - this.lastManualRefreshAt < ImageUpdateService.MANUAL_COOLDOWN_MS) {
            return false;
        }
        this.lastManualRefreshAt = now;
        this.check().catch(e => console.error('[ImageUpdateService] Manual refresh error:', e));
        return true;
    }

    public isChecking(): boolean {
        return this.isRunning;
    }

    /** Milliseconds left on the manual-refresh cooldown; 0 when a refresh is allowed. */
    public getManualCooldownRemainingMs(): number {
        return Math.max(0, this.lastManualRefreshAt + ImageUpdateService.MANUAL_COOLDOWN_MS - Date.now());
    }

    /**
     * Per-stack rate gate for explicit rechecks (idiomatic API calls and the
     * sidebar "Check updates" action). Reuses the same MANUAL_COOLDOWN_MS as the
     * node-wide manual trigger so both surfaces share one cooldown policy without
     * a new knob.
     *
     * Returns true when the recheck is allowed and atomically marks in-flight;
     * returns false when a recheck for this (nodeId, stackName) was started
     * within the cooldown window (including one that is still in-flight, whose
     * mark was written synchronously on the previous event-loop tick before the
     * first await).
     */
    public tryMarkStackRecheck(nodeId: number, stackName: string): boolean {
        const key = `${nodeId}:${stackName}`;
        const now = Date.now();
        const lastAt = this.perStackRecheckAt.get(key) ?? 0;
        if (now - lastAt < ImageUpdateService.MANUAL_COOLDOWN_MS) {
            return false;
        }
        this.perStackRecheckAt.set(key, now);
        return true;
    }

    /** Milliseconds left on the per-stack recheck cooldown; 0 when allowed. */
    public getStackRecheckCooldownRemainingMs(nodeId: number, stackName: string): number {
        const key = `${nodeId}:${stackName}`;
        const lastAt = this.perStackRecheckAt.get(key) ?? 0;
        return Math.max(0, lastAt + ImageUpdateService.MANUAL_COOLDOWN_MS - Date.now());
    }

    /** Clear every per-stack recheck cooldown (test-only). */
    public resetStackRecheckCooldowns(): void {
        this.perStackRecheckAt.clear();
    }

    public getStatus(): ImageUpdateStatus {
        const enabled = ImageUpdateService.isChecksEnabled();
        let sidebarIndicators = false;
        try {
            const settings = DatabaseService.getInstance().getGlobalSettings();
            sidebarIndicators = settings.image_update_sidebar_indicators === '1';
        } catch (e) {
            console.warn('[ImageUpdateService] Failed to read sidebar indicator setting:', e);
        }
        return {
            checking: enabled ? this.isRunning : false,
            intervalMinutes: Math.round(this.intervalMs / (60 * 1000)),
            lastCheckedAt: this.lastCheckedAt,
            nextCheckAt: enabled ? this.nextCheckAt : null,
            manualCooldownMinutes: ImageUpdateService.manualCooldownMinutes,
            manualCooldownRemainingMs: this.getManualCooldownRemainingMs(),
            mode: this.mode,
            cronExpression: this.cronExpression,
            sidebarIndicators,
            enabled,
        };
    }

    // ─── Core check ──────────────────────────────────────────────────────────

    private async check() {
        if (!ImageUpdateService.isChecksEnabled()) {
            if (isDebugEnabled()) {
                console.log('[ImageUpdateService:debug] Checks disabled; skipping scan.');
            }
            return;
        }
        // The finally block is the sole owner of isRunning, so a scan that
        // overruns can never have its lock released out from under it. A
        // previous fixed timer cleared the lock after CHECK_TIMEOUT_MS, which
        // let a manual refresh start a second concurrent check on a healthy but
        // slow scan, duplicating notifications and racing the status writes.
        // Registry calls are bounded (10s) and the Docker/filesystem reads are
        // wrapped in withTimeout, so the scan body always settles and the
        // finally releases the lock; the only thing the guard below protects
        // against is a concurrent trigger arriving mid-scan.
        if (this.isRunning) {
            const elapsedMs = Date.now() - this.checkStartedAt;
            if (elapsedMs >= ImageUpdateService.CHECK_TIMEOUT_MS) {
                console.warn(`[ImageUpdateService] A check has been running for ${Math.round(elapsedMs / 60_000)} minute(s); skipping this trigger. The Docker socket may be unresponsive.`);
            } else if (isDebugEnabled()) {
                console.log('[ImageUpdateService:debug] Check already in progress; skipping this trigger.');
            }
            return;
        }
        this.isRunning = true;
        this.checkStartedAt = Date.now();
        // Stamp last-checked here, in the shared scan path, so a manual Recheck
        // updates it too. A skipped concurrent trigger returns above this line,
        // so it never bumps the timestamp.
        this.lastCheckedAt = this.checkStartedAt;
        console.log('[ImageUpdateService] Starting image update check...');

        try {
            const db = DatabaseService.getInstance();
            // Only check local nodes - remote nodes run their own instance
            for (const node of db.getNodes()) {
                if (node.type !== 'local' || !node.id) continue;
                try {
                    await this.checkNode(node.id, db);
                } catch (e) {
                    console.error(`[ImageUpdateService] Error on node ${node.name}:`, e);
                }
            }
            console.log('[ImageUpdateService] Image update check complete.');
        } catch (e) {
            console.error('[ImageUpdateService] Check failed:', e);
        } finally {
            this.isRunning = false;
        }
    }

    private async checkNode(nodeId: number, db: DatabaseService) {
        const docker = DockerController.getInstance(nodeId);
        const fs = FileSystemService.getInstance(nodeId);
        const composeDir = path.resolve(NodeRegistry.getInstance().getComposeDir(nodeId));

        // Phase 1: Filesystem discovery (all stacks with compose files)
        const stacks = await withTimeout(fs.getStacks(), ImageUpdateService.SOCKET_TIMEOUT_MS, 'getStacks');
        const stackImages = new Map<string, Set<string>>();
        for (const name of stacks) stackImages.set(name, new Set());

        if (isDebugEnabled()) {
            console.log(`[ImageUpdateService:debug] Node ${nodeId}: Phase 1 complete - ${stacks.length} stack(s) found`);
        }

        // Phase 2: Parse compose files for image refs
        for (const stackName of stacks) {
            try {
                // Multi-file / context-dir Git stacks resolve images from the
                // effective merged model so override-only images are captured.
                const effective = await loadEffectiveServiceImages(nodeId, stackName);
                if (effective) {
                    for (const e of effective) stackImages.get(stackName)?.add(e.image);
                    continue;
                }

                const content = await withTimeout(fs.getStackContent(stackName), ImageUpdateService.SOCKET_TIMEOUT_MS, 'getStackContent');

                // Load .env for variable resolution (best-effort)
                let envVars: Record<string, string> = {};
                try {
                    const hasEnv = await withTimeout(fs.envExists(stackName), ImageUpdateService.SOCKET_TIMEOUT_MS, 'envExists');
                    if (hasEnv) {
                        const envContent = await withTimeout(fs.getEnvContent(stackName), ImageUpdateService.SOCKET_TIMEOUT_MS, 'getEnvContent');
                        envVars = loadDotEnv(envContent);
                    }
                } catch {
                    // .env file exists but unreadable; continue with process.env only
                }
                // Docker Compose precedence: host env overrides .env
                const merged: Record<string, string> = { ...envVars };
                for (const [k, v] of Object.entries(process.env)) {
                    if (v !== undefined) merged[k] = v;
                }

                for (const img of extractImagesFromCompose(content, merged)) {
                    stackImages.get(stackName)?.add(img);
                }
            } catch (e) {
                console.warn(`[ImageUpdateService] Could not parse compose for "${stackName}":`, e);
            }
        }

        if (isDebugEnabled()) {
            const composeImageCount = [...stackImages.values()].reduce((sum, s) => sum + s.size, 0);
            console.log(`[ImageUpdateService:debug] Node ${nodeId}: Phase 2 complete - ${composeImageCount} image(s) extracted from compose files`);
        }

        // Phase 3: Container augmentation (captures actual deployed image tags)
        let allContainers: Awaited<ReturnType<DockerController['getAllContainers']>> = [];
        try {
            allContainers = await withTimeout(docker.getAllContainers(), ImageUpdateService.SOCKET_TIMEOUT_MS, 'getAllContainers');
            for (const c of allContainers) {
                // Prefer the pinned project label (== stackName for Sencho-deployed
                // stacks, including multi-file / context-dir ones where
                // --project-directory would otherwise change the working-dir
                // basename). Fall back to the working-dir basename for legacy /
                // non-Sencho containers.
                const project: string | undefined = c.Labels?.['com.docker.compose.project'];
                let stackName: string | null = null;
                if (project && stackImages.has(project)) {
                    stackName = project;
                } else {
                    const workingDir: string | undefined = c.Labels?.['com.docker.compose.project.working_dir'];
                    if (workingDir) {
                        const resolved = path.resolve(workingDir);
                        if (resolved === composeDir || resolved.startsWith(composeDir + path.sep)) {
                            stackName = path.basename(resolved);
                        }
                    }
                }
                if (!stackName) continue;

                const imageRef: string = c.Image ?? '';
                if (!imageRef || imageRef.startsWith('sha256:')) continue;

                // Only augment stacks found on the filesystem
                if (stackImages.has(stackName)) {
                    stackImages.get(stackName)?.add(imageRef);
                }
            }
        } catch (e) {
            console.warn('[ImageUpdateService] Container augmentation failed:', e);
        }

        if (isDebugEnabled()) {
            const totalBeforeDedup = [...stackImages.values()].reduce((sum, s) => sum + s.size, 0);
            console.log(`[ImageUpdateService:debug] Node ${nodeId}: Phase 3 complete - ${totalBeforeDedup} image(s) across all stacks (pre-dedup)`);
        }

        // Phase 4: Deduplicate and check all unique images
        // Reserve write generations before the slow registry checks so a concurrent
        // recheckStack that finishes first keeps its write (stale full-scan commits
        // are dropped in withStackWriteLock).
        const writeGenerations = new Map<string, number>();
        for (const stackName of stackImages.keys()) {
            writeGenerations.set(stackName, this.reserveStackWriteGeneration(nodeId, stackName));
        }

        const allImages = new Set<string>();
        for (const imgs of stackImages.values()) for (const img of imgs) allImages.add(img);

        const imageUpdateMap = new Map<string, ImageCheckResult>();

        for (const imageRef of allImages) {
            try {
                imageUpdateMap.set(imageRef, await this.checkImage(docker, imageRef));
            } catch (e) {
                console.error(`[ImageUpdateService] Error checking ${sanitizeForLog(imageRef)}:`, sanitizeForLog((e as Error)?.message ?? String(e)));
                // getErrorMessage (not raw String(e)) because this value can surface
                // verbatim in the sidebar tooltip / readiness advisory as lastError.
                imageUpdateMap.set(imageRef, {
                    hasUpdate: false,
                    checkStatus: 'failed',
                    error: getErrorMessage(e, 'Update check failed'),
                });
            }
            await sleep(ImageUpdateService.INTER_IMAGE_DELAY_MS);
        }

        // Read previous state to detect new updates for notifications
        const previousState = db.getStackUpdateStatus(nodeId);

        // One-time backfill: pre-existing has_update rows predate the notification pipeline;
        // treat them as unnotified on first run so users get a catch-up entry per affected stack.
        const isBackfilled = db.getSystemState(BACKFILL_KEY) === '1';

        // Write status for ALL stacks (including those with no pullable images)
        const now = Date.now();
        let updatesFound = 0;
        const newlyUpdated: Array<{ stackName: string; message: string }> = [];
        for (const [stackName] of stackImages) {
            const outcome = await this.writeStackUpdateStatus(
                nodeId,
                stackName,
                stackImages.get(stackName) ?? new Set(),
                imageUpdateMap,
                previousState,
                now,
                allContainers,
                db,
                writeGenerations.get(stackName) ?? this.reserveStackWriteGeneration(nodeId, stackName),
            );
            if (outcome.committed && outcome.hasUpdate) {
                updatesFound++;
                if (!isBackfilled || !previousState[stackName]) {
                    newlyUpdated.push({ stackName, message: outcome.notifyMessage });
                }
            }
        }

        // Dispatch notifications for stacks that newly have updates
        if (newlyUpdated.length > 0) {
            const notifier = NotificationService.getInstance();
            for (const { stackName, message } of newlyUpdated) {
                try {
                    await notifier.dispatchAlert(
                        'info',
                        'image_update_available',
                        message,
                        { stackName, actor: 'system:image-update' },
                    );
                } catch (e) {
                    console.error(`[ImageUpdateService] Failed to dispatch update notification for "${stackName}":`, e);
                    // Direct DB write to avoid recursing through dispatchAlert if it is what failed.
                    // Key on the local default: the iterated `nodeId` may be a remote's id in the
                    // control plane's DB, and the UI never queries that row (it proxies instead).
                    try {
                        const localNodeId = NodeRegistry.getInstance().getDefaultNodeId();
                        db.addNotificationHistory(localNodeId, {
                            level: 'error',
                            category: 'system',
                            message: sanitizeNotificationMessage(
                                `Failed to notify about image updates for stack "${stackName}": ${getErrorMessage(e, String(e))}`,
                                { composeDir: NodeRegistry.getInstance().getComposeDir(localNodeId) },
                            ),
                            timestamp: Date.now(),
                            actor_username: 'system:image-update',
                        });
                    } catch (dbErr) {
                        console.error('[ImageUpdateService] Failed to record dispatch error:', dbErr);
                    }
                }
            }
        }

        // Mark the backfill flag after the first run so future checks use strict transitions.
        if (!isBackfilled) {
            db.setSystemState(BACKFILL_KEY, '1');
        }

        console.log(`[ImageUpdateService] Node ${nodeId}: checked ${allImages.size} image(s), ${updatesFound} stack(s) with updates`);

        // Prune stale entries for stacks no longer on disk (reuse previousState to avoid extra DB read)
        for (const staleStack of Object.keys(previousState)) {
            if (!stackImages.has(staleStack)) {
                db.clearStackUpdateStatus(nodeId, staleStack);
            }
        }
    }

    /**
     * Re-check a single stack after a service-scoped update or restore, or
     * after a manual full-stack update. On a render failure the prior row is
     * left untouched and a verification_failed result is returned.
     */
    public async recheckStack(nodeId: number, stackName: string): Promise<StackRecheckResult> {
        // While detection is off, skip registry probes and do not write
        // stack_update_status (avoids stale findings after re-enable).
        if (!ImageUpdateService.isChecksEnabled()) {
            return { outcome: 'cleared', warning: null };
        }
        const generation = this.reserveStackWriteGeneration(nodeId, stackName);
        const db = DatabaseService.getInstance();
        const docker = DockerController.getInstance(nodeId);
        const model = await buildEffectiveServiceModel(nodeId, stackName);
        if (!model.renderable) {
            return {
                outcome: 'verification_failed',
                warning: model.error || UPDATE_VERIFICATION_INCOMPLETE_WARNING,
            };
        }

        let containers: Array<{ Image?: string; Labels?: Record<string, string> }>;
        try {
            containers = await withTimeout(docker.getAllContainers(), ImageUpdateService.SOCKET_TIMEOUT_MS, 'getAllContainers');
        } catch (e) {
            console.warn(
                '[ImageUpdateService] recheckStack container read failed for %s: %s',
                sanitizeForLog(stackName),
                sanitizeForLog(getErrorMessage(e, 'unknown')),
            );
            // Do not clear or upsert from declared-image-only checks: runtime
            // digests were never observed, so "cleared" would be a false negative.
            return {
                outcome: 'verification_incomplete',
                warning: UPDATE_VERIFICATION_INCOMPLETE_WARNING,
            };
        }

        const refs = new Set<string>();
        const runtimeByService = this.runtimeImagesByService(stackName, containers);
        for (const spec of model.services) {
            if (spec.declaredImage) refs.add(spec.declaredImage);
            for (const ref of runtimeByService.get(spec.name) ?? []) refs.add(ref);
        }

        const imageUpdateMap = new Map<string, ImageCheckResult>();
        for (const imageRef of refs) {
            try {
                imageUpdateMap.set(imageRef, await this.checkImage(docker, imageRef));
            } catch (e) {
                imageUpdateMap.set(imageRef, {
                    hasUpdate: false,
                    checkStatus: 'failed',
                    error: getErrorMessage(e, 'Update check failed'),
                });
            }
            await sleep(ImageUpdateService.INTER_IMAGE_DELAY_MS);
        }

        const priorByService = new Map(db.getStackServicesJson(nodeId, stackName).map((s) => [s.service, s]));
        const reductions = model.services.map((spec) => reduceServiceStatus(
            spec.name,
            spec.declaredImage,
            runtimeByService.get(spec.name) ?? [],
            imageUpdateMap,
            priorByService.get(spec.name),
        ));
        const services = reductions.map((r) => r.status);
        const checkStatus = aggregateServiceCheckStatus(services);
        const hasUpdate = services.some((s) => s.hasUpdate);
        // Every still-present update being a same-tag digest rebuild (no higher
        // semver tag) signals the local content for that image did not move: the
        // daemon may serve a cached/mirrored manifest, or the container may still
        // run the previous image (or the last update targeted another service).
        // Surface both causes instead of the generic copy.
        const updatingEntries = [...imageUpdateMap.values()]
            .filter((r) => r.hasUpdate && normalizeImageCheckStatus(r) !== 'not_checkable');
        const allDigestOnly = hasUpdate && updatingEntries.length > 0
            && updatingEntries.every((r) => r.digestUpdate === true && r.tagUpdate !== true);
        const lastError = stackStatusLastError(services);
        const now = Date.now();

        const committed = await this.withStackWriteLock(nodeId, stackName, generation, async (gen) => {
            if (checkStatus === 'failed') {
                db.recordStackCheckFailure(nodeId, stackName, lastError ?? 'Update check failed', now, services, gen);
            } else {
                db.upsertStackUpdateStatus(nodeId, stackName, hasUpdate, now, checkStatus, lastError, services, gen);
            }
        });
        // A newer scanner reservation dropped this write; do not report cleared.
        if (!committed) {
            return {
                outcome: 'verification_incomplete',
                warning: UPDATE_VERIFICATION_INCOMPLETE_WARNING,
            };
        }

        if (checkStatus === 'partial' || checkStatus === 'failed') {
            return {
                outcome: 'verification_incomplete',
                warning: UPDATE_VERIFICATION_INCOMPLETE_WARNING,
            };
        }
        if (hasUpdate) {
            return {
                outcome: 'still_present',
                warning: allDigestOnly ? UPDATE_DIGEST_UNCHANGED_WARNING : UPDATE_STILL_PRESENT_WARNING,
            };
        }
        return { outcome: 'cleared', warning: null };
    }

    private stackWriteKey(nodeId: number, stackName: string): string {
        return `${nodeId}:${stackName}`;
    }

    /** Bump the per-stack write generation before async registry work so a later
     *  slower scan cannot commit after a newer recheck reserved a higher gen. */
    private reserveStackWriteGeneration(nodeId: number, stackName: string): number {
        const key = this.stackWriteKey(nodeId, stackName);
        let state = this.stackWriteState.get(key);
        if (!state) {
            state = { chain: Promise.resolve(), generation: 0 };
            this.stackWriteState.set(key, state);
        }
        state.generation += 1;
        return state.generation;
    }

    private async withStackWriteLock(
        nodeId: number,
        stackName: string,
        generation: number,
        write: (generation: number) => void | Promise<void>,
    ): Promise<boolean> {
        const key = this.stackWriteKey(nodeId, stackName);
        let state = this.stackWriteState.get(key);
        if (!state) {
            state = { chain: Promise.resolve(), generation };
            this.stackWriteState.set(key, state);
        }
        let committed = false;
        state.chain = state.chain.then(async () => {
            const current = this.stackWriteState.get(key);
            // A newer reservation supersedes this writer; drop the stale commit.
            if (!current || generation < current.generation) return;
            await write(generation);
            committed = true;
        });
        await state.chain;
        return committed;
    }

    /**
     * Current per-stack write-generation high-water mark (0 if never reserved).
     * Snapshot before a read-only update-preview so commitPreviewClear can
     * compare against writes that reserved or committed after observation.
     */
    public peekStackWriteGeneration(nodeId: number, stackName: string): number {
        return this.stackWriteState.get(this.stackWriteKey(nodeId, stackName))?.generation ?? 0;
    }

    /**
     * Clear persisted scanner update state after an authoritative-negative
     * update preview. `observedMemoryGeneration` and `observedRowGeneration`
     * are snapshotted before the preview.
     *
     * Ordering:
     * - If memory generation advanced after observation, abort (stale).
     * - If memory generation still equals the observation watermark, advance
     *   (tombstone) so an equal-generation writer reserved before observation
     *   cannot commit after the clear (SF-4).
     * - If the persisted row generation advanced after observation, keep the row.
     * - Otherwise delete partial, failed, and confirmed ok+true rows.
     *
     * Returns cleared | stale | absent.
     */
    public async commitPreviewClear(
        nodeId: number,
        stackName: string,
        observedMemoryGeneration: number,
        observedRowGeneration: number,
    ): Promise<'cleared' | 'stale' | 'absent'> {
        const key = this.stackWriteKey(nodeId, stackName);
        let state = this.stackWriteState.get(key);
        if (!state) {
            state = { chain: Promise.resolve(), generation: observedMemoryGeneration };
            this.stackWriteState.set(key, state);
        }

        // A reservation after observation already owns a higher generation.
        if (state.generation > observedMemoryGeneration) {
            return 'stale';
        }

        // Tombstone the equal watermark so pre-observation writers reserved at
        // this generation become stale when they later try to commit.
        if (state.generation === observedMemoryGeneration) {
            state.generation += 1;
        }
        const clearGeneration = state.generation;

        let deleted = 0;
        const committed = await this.withStackWriteLock(nodeId, stackName, clearGeneration, () => {
            const db = DatabaseService.getInstance();
            const detail = db.getStackUpdateDetail(nodeId)[stackName];
            if (!detail) return;
            // Compare DB-embedded generations only (same dimension as the
            // pre-preview snapshot). Memory peek resets on restart; SQLite does not.
            const rowGeneration = db.getStackUpdateWriteGeneration(nodeId, stackName);
            if (rowGeneration > observedRowGeneration) return;
            deleted = db.clearStackUpdateStatus(nodeId, stackName);
        });
        if (!committed) return 'stale';
        return deleted > 0 ? 'cleared' : 'absent';
    }

    private runtimeImagesByService(
        stackName: string,
        containers: Array<{ Image?: string; Labels?: Record<string, string> }>,
    ): Map<string, string[]> {
        const out = new Map<string, string[]>();
        for (const c of containers) {
            if (c.Labels?.['com.docker.compose.project'] !== stackName) continue;
            const service = c.Labels?.['com.docker.compose.service'];
            if (!service) continue;
            const imageRef = c.Image ?? '';
            if (!imageRef || imageRef.startsWith('sha256:')) continue;
            const list = out.get(service) ?? [];
            list.push(imageRef);
            out.set(service, list);
        }
        return out;
    }

    private async writeStackUpdateStatus(
        nodeId: number,
        stackName: string,
        images: Set<string>,
        imageUpdateMap: Map<string, ImageCheckResult>,
        previousState: Record<string, boolean>,
        checkedAt: number,
        containers: Array<{ Image?: string; Labels?: Record<string, string> }>,
        db: DatabaseService,
        generation: number,
    ): Promise<{ hasUpdate: boolean; notifyMessage: string; committed: boolean }> {
        const model = await buildEffectiveServiceModel(nodeId, stackName);
        if (model.renderable) {
            const priorByService = new Map(
                DatabaseService.getInstance().getStackServicesJson(nodeId, stackName).map((s) => [s.service, s]),
            );
            const runtimeByService = this.runtimeImagesByService(stackName, containers);
            const reductions = model.services.map((spec) => reduceServiceStatus(
                spec.name,
                spec.declaredImage,
                runtimeByService.get(spec.name) ?? [],
                imageUpdateMap,
                priorByService.get(spec.name),
            ));
            const services = reductions.map((r) => r.status);
            const checkStatus = aggregateServiceCheckStatus(services);
            const hasUpdate = services.some((s) => s.hasUpdate);
            const lastError = stackStatusLastError(services);
            const notifyMessage = buildAvailabilityNotifyMessage(stackName, services);

            const committed = await this.withStackWriteLock(nodeId, stackName, generation, async (gen) => {
                if (checkStatus === 'failed') {
                    db.recordStackCheckFailure(
                        nodeId, stackName, lastError ?? 'Update check failed', checkedAt, services, gen,
                    );
                } else {
                    db.upsertStackUpdateStatus(
                        nodeId, stackName, hasUpdate, checkedAt, checkStatus, lastError, services, gen,
                    );
                }
            });

            return { hasUpdate, notifyMessage, committed };
        }

        const checkable = Array.from(images)
            .map((img) => imageUpdateMap.get(img))
            .filter((r): r is ImageCheckResult => !!r && normalizeImageCheckStatus(r) !== 'not_checkable');
        const statuses = checkable.map(normalizeImageCheckStatus);
        const failed = checkable.filter((_, i) => statuses[i] === 'failed');
        const partial = checkable.filter((_, i) => statuses[i] === 'partial');
        const confirmedHasUpdate = checkable.some((r, i) => statuses[i] === 'ok' && r.hasUpdate === true);

        if (checkable.length > 0 && failed.length === checkable.length) {
            const committed = await this.withStackWriteLock(nodeId, stackName, generation, async () => {
                db.recordStackCheckFailure(
                    nodeId, stackName, failed[0].error ?? 'Update check failed', checkedAt,
                );
            });
            return {
                hasUpdate: previousState[stackName] === true,
                notifyMessage: buildAvailabilityNotifyMessage(stackName, []),
                committed,
            };
        }

        const checkStatus: StackCheckStatus =
            failed.length > 0 || partial.length > 0 ? 'partial' : 'ok';
        const uncertain = [...partial, ...failed];
        const lastError = uncertain.length > 0 ? (uncertain[0].error ?? null) : null;
        const hasUpdate = checkStatus === 'partial'
            ? (confirmedHasUpdate || previousState[stackName] === true)
            : confirmedHasUpdate;

        const committed = await this.withStackWriteLock(nodeId, stackName, generation, async () => {
            db.upsertStackUpdateStatus(nodeId, stackName, hasUpdate, checkedAt, checkStatus, lastError);
        });

        return {
            hasUpdate,
            notifyMessage: buildAvailabilityNotifyMessage(stackName, []),
            committed,
        };
    }

    public async checkImage(docker: DockerController, imageRef: string): Promise<ImageCheckResult> {
        const parsed = parseImageRef(imageRef);
        // A bare digest ref (sha256:...) has no tag to track upstream; not applicable.
        if (!parsed) {
            return { hasUpdate: false, checkStatus: 'not_checkable', notCheckable: true };
        }

        if (isDebugEnabled()) {
            console.log(`[ImageUpdateService] Checking ${imageRef}: registry=${parsed.registry} repo=${parsed.repo} tag=${parsed.tag}`);
        }

        const credentials = await RegistryService.getInstance().getAuthForRegistry(parsed.registry);
        if (isDebugEnabled()) {
            console.log(`[ImageUpdateService] ${imageRef}: credentials ${credentials ? 'found' : 'none'}`);
        }

        // Get local digests and platform from RepoDigests / Os+Architecture
        let localDigests: string[];
        let platform: { os: string; architecture: string };
        try {
            const inspect = await withTimeout(docker.getDocker().getImage(imageRef).inspect(), ImageUpdateService.SOCKET_TIMEOUT_MS, 'inspect');
            const repoDigests: string[] = inspect.RepoDigests ?? [];

            // No RepoDigests at all: locally built / not registry-backed, so update
            // status does not apply.
            if (repoDigests.length === 0) {
                return { hasUpdate: false, checkStatus: 'not_checkable', notCheckable: true };
            }

            localDigests = selectLocalRepoDigests(repoDigests, parsed);
            platform = { os: inspect.Os, architecture: inspect.Architecture };
        } catch {
            return {
                hasUpdate: false,
                checkStatus: 'failed',
                error: `Failed to inspect local image "${imageRef}"`,
            };
        }

        // RepoDigests were present but none resolved a usable digest: genuinely
        // ambiguous, so surface it rather than silently call the image up to date.
        if (localDigests.length === 0) {
            return {
                hasUpdate: false,
                checkStatus: 'failed',
                error: `Could not resolve a local registry digest for "${imageRef}"`,
            };
        }

        const detection = await detectImageUpdate({
            localDigests,
            platform,
            registry: parsed.registry,
            repo: parsed.repo,
            tag: parsed.tag,
            credentials,
        });

        const digestLabel = localDigests[0] ? `${localDigests[0].slice(0, 27)}...` : 'none';
        const nextSuffix = detection.nextTag ? ` next=${detection.nextTag}` : '';
        console.log(
            `[ImageUpdateService] ${imageRef}: local=${digestLabel} update=${detection.hasUpdate}`
            + ` digest=${detection.digestUpdate} tag=${detection.tagUpdate}`
            + ` status=${detection.checkStatus}${nextSuffix}`,
        );

        if (detection.checkStatus === 'not_checkable') {
            return { hasUpdate: false, checkStatus: 'not_checkable', notCheckable: true };
        }

        return {
            hasUpdate: detection.hasUpdate,
            digestUpdate: detection.digestUpdate,
            tagUpdate: detection.tagUpdate,
            checkStatus: detection.checkStatus,
            ...(detection.reason ? { error: detection.reason } : {}),
        };
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Reject after `ms` if `p` has not settled. Docker socket and filesystem reads
 * have no built-in timeout, so without this a wedged daemon would hang a scan
 * forever and hold the run lock until the process restarts. The rejecting await
 * lets the scan body unwind so the `finally` releases the lock and the next
 * interval can retry. Handlers are attached to `p` so a late settle does not
 * surface as an unhandled rejection.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        p.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (err) => { clearTimeout(timer); reject(err); },
        );
    });
}
