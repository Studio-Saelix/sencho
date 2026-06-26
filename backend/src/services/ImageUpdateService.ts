import path from 'path';
import YAML from 'yaml';
import { CronExpressionParser } from 'cron-parser';
import DockerController from './DockerController';
import { DatabaseService } from './DatabaseService';
import { FileSystemService } from './FileSystemService';
import { RegistryService } from './RegistryService';
import { NodeRegistry } from './NodeRegistry';
import { NotificationService } from './NotificationService';
import { sanitizeNotificationMessage } from '../utils/notificationMessage';
import { parseImageRef, getRemoteDigest, repoDigestMatchesRef } from './registry-api';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';

const BACKFILL_KEY = 'image_update_notifications_backfilled';

export interface ImageCheckResult {
    hasUpdate: boolean;
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
 * Snapshot of the scanner returned by GET /api/image-updates/status.
 * Units differ by field: `intervalMinutes` / `manualCooldownMinutes` are
 * minutes, `manualCooldownRemainingMs` is milliseconds. `manualCooldownMinutes`
 * is the fixed cooldown ceiling; `manualCooldownRemainingMs` is the live
 * remaining time (0 when a manual refresh is allowed). `lastCheckedAt` /
 * `nextCheckAt` are epoch-ms or null ("never checked" / "not scheduled");
 * `nextCheckAt` is meaningless while `checking` is true.
 * `mode` is the active scheduling mode; `cronExpression` is the 5-field
 * expression when mode is 'cron', null otherwise or when unconfigured.
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

// ─── Service ──────────────────────────────────────────────────────────────────

export class ImageUpdateService {
    private static instance: ImageUpdateService;

    private static readonly MIN_INTERVAL_MINUTES = 15;
    private static readonly MAX_INTERVAL_MINUTES = 1440;          // 24 hours
    private static readonly DEFAULT_INTERVAL_MINUTES = 120;       // 2 hours
    private static readonly INTERVAL_SETTING_KEY = 'image_update_check_interval_minutes';
    private static readonly MODE_SETTING_KEY = 'image_update_check_mode';
    private static readonly CRON_SETTING_KEY = 'image_update_check_cron';
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
        this.polling = true;
        this.configureFromSettings();
        // Preserve the existing 2-minute post-boot delay before the first check.
        this.armNext(ImageUpdateService.STARTUP_DELAY_MS);
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
     * when the service is stopped or was never started.
     */
    public restartPolling(): void {
        this.scheduleGeneration++;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.configureFromSettings();
        if (this.polling) {
            this.armNext(this.nextDelayMs());
        } else {
            this.nextCheckAt = null;
        }
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
     * Triggers a check immediately, unless one is already running or the
     * manual cooldown (MANUAL_COOLDOWN_MS) has not elapsed.
     * Returns false if rate-limited, true if a check was started.
     */
    public triggerManualRefresh(): boolean {
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

    public getStatus(): ImageUpdateStatus {
        return {
            checking: this.isRunning,
            intervalMinutes: Math.round(this.intervalMs / (60 * 1000)),
            lastCheckedAt: this.lastCheckedAt,
            nextCheckAt: this.nextCheckAt,
            manualCooldownMinutes: ImageUpdateService.manualCooldownMinutes,
            manualCooldownRemainingMs: this.getManualCooldownRemainingMs(),
            mode: this.mode,
            cronExpression: this.cronExpression,
        };
    }

    // ─── Core check ──────────────────────────────────────────────────────────

    private async check() {
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
                    await this.checkNode(node.id, node.name, db);
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

    private async checkNode(nodeId: number, nodeName: string, db: DatabaseService) {
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
        try {
            const containers = await withTimeout(docker.getAllContainers(), ImageUpdateService.SOCKET_TIMEOUT_MS, 'getAllContainers');
            for (const c of containers) {
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
                imageUpdateMap.set(imageRef, { hasUpdate: false, error: getErrorMessage(e, 'Update check failed') });
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
        const newlyUpdated: string[] = [];
        for (const [stackName, images] of stackImages) {
            // Tally only checkable images: a not-checkable image (locally built,
            // or a bare digest ref) is neither a pass nor a failure.
            const checkable = Array.from(images)
                .map(img => imageUpdateMap.get(img))
                .filter((r): r is ImageCheckResult => !!r && !r.notCheckable);
            const errored = checkable.filter(r => r.error !== undefined);
            const confirmedHasUpdate = checkable.some(r => r.error === undefined && r.hasUpdate === true);

            // Every checkable image failed: status is undeterminable. Preserve the
            // last-known has_update so a transient registry outage neither erases a
            // real update nor flaps the notification state.
            if (checkable.length > 0 && errored.length === checkable.length) {
                db.recordStackCheckFailure(nodeId, stackName, errored[0].error ?? 'Update check failed', now);
                continue;
            }

            const checkStatus = errored.length > 0 ? 'partial' : 'ok';
            const lastError = errored.length > 0 ? (errored[0].error ?? null) : null;
            // Only a fully-ok check is authoritative enough to lower has_update to
            // false. On a partial check some image could not be reached, so a
            // previously confirmed update is preserved rather than erased (which
            // would also re-fire the notification when that image recovers).
            const hasUpdate = checkStatus === 'partial'
                ? (confirmedHasUpdate || previousState[stackName] === true)
                : confirmedHasUpdate;

            if (hasUpdate) {
                updatesFound++;
                // Notify only on state transition: was false/absent, now true
                if (!isBackfilled || !previousState[stackName]) {
                    newlyUpdated.push(stackName);
                }
            }
            db.upsertStackUpdateStatus(nodeId, stackName, hasUpdate, now, checkStatus, lastError);
        }

        // Dispatch notifications for stacks that newly have updates
        if (newlyUpdated.length > 0) {
            const notifier = NotificationService.getInstance();
            for (const stackName of newlyUpdated) {
                try {
                    await notifier.dispatchAlert(
                        'info',
                        'image_update_available',
                        `[Node: ${nodeName}] Stack "${stackName}" has image updates available.`,
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
                                `[Node: ${nodeName}] Failed to notify about image updates for stack "${stackName}": ${getErrorMessage(e, String(e))}`,
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

    public async checkImage(docker: DockerController, imageRef: string): Promise<ImageCheckResult> {
        const parsed = parseImageRef(imageRef);
        // A bare digest ref (sha256:...) has no tag to track upstream; not applicable.
        if (!parsed) return { hasUpdate: false, notCheckable: true };

        if (isDebugEnabled()) {
            console.log(`[ImageUpdateService] Checking ${imageRef}: registry=${parsed.registry} repo=${parsed.repo} tag=${parsed.tag}`);
        }

        // Look up stored credentials for this registry
        const credentials = await RegistryService.getInstance().getAuthForRegistry(parsed.registry);
        if (isDebugEnabled()) {
            console.log(`[ImageUpdateService] ${imageRef}: credentials ${credentials ? 'found' : 'none'}`);
        }

        // Get local digest from RepoDigests
        let localDigest: string | null = null;
        try {
            const inspect = await withTimeout(docker.getDocker().getImage(imageRef).inspect(), ImageUpdateService.SOCKET_TIMEOUT_MS, 'inspect');
            const repoDigests: string[] = inspect.RepoDigests ?? [];

            // No RepoDigests at all: locally built / not registry-backed, so update
            // status does not apply.
            if (repoDigests.length === 0) return { hasUpdate: false, notCheckable: true };

            for (const rd of repoDigests) {
                if (!rd.includes('@sha256:')) continue;
                const [, digest] = rd.split('@');

                if (repoDigestMatchesRef(rd, parsed) || repoDigests.length === 1) {
                    localDigest = digest;
                    break;
                }
            }
        } catch {
            return { hasUpdate: false, error: `Failed to inspect local image "${imageRef}"` };
        }

        // RepoDigests were present but none resolved a usable digest: genuinely
        // ambiguous, so surface it rather than silently call the image up to date.
        if (!localDigest) {
            return { hasUpdate: false, error: `Could not resolve a local registry digest for "${imageRef}"` };
        }

        const remoteDigest = await getRemoteDigest(parsed.registry, parsed.repo, parsed.tag, credentials);
        if (!remoteDigest) {
            return { hasUpdate: false, error: `Registry unreachable for ${parsed.registry}/${parsed.repo}:${parsed.tag}` };
        }

        const hasUpdate = localDigest !== remoteDigest;
        console.log(
            `[ImageUpdateService] ${imageRef}: ` +
            `local=${localDigest.slice(0, 27)}... remote=${remoteDigest.slice(0, 27)}... update=${hasUpdate}`
        );
        return { hasUpdate };
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
