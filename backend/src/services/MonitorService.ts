import si from 'systeminformation';
import semver from 'semver';
import DockerController from './DockerController';
import { DatabaseService, Node, StackAlert } from './DatabaseService';
import { NodeRegistry } from './NodeRegistry';
import { FileSystemService } from './FileSystemService';
import { normalizeImageRef } from './DriftDetectionService';
import { NotificationService } from './NotificationService';
import { FleetUpdateTrackerService } from './FleetUpdateTrackerService';
import { isValidVersion, getSenchoVersion } from './CapabilityRegistry';
import { getLatestVersionInfo } from '../utils/version-check';
import { getHostMemory } from '../helpers/hostMemory';
import { isDebugEnabled } from '../utils/debug';
import { withTimeout, TimeoutError } from '../utils/withTimeout';

const getMetricDetails = (metric: string): { name: string, unit: string } => {
    switch (metric) {
        case 'cpu_percent': return { name: 'CPU usage', unit: '%' };
        case 'memory_percent': return { name: 'Memory usage', unit: '%' };
        case 'memory_mb': return { name: 'Memory allocation', unit: ' MB' };
        case 'net_rx': return { name: 'Inbound network traffic', unit: ' MB/s' };
        case 'net_tx': return { name: 'Outbound network traffic', unit: ' MB/s' };
        case 'restart_count': return { name: 'Restart count', unit: ' restarts' };
        default: return { name: metric, unit: '' };
    }
};

const getOperatorPhrase = (operator: string): string => {
    if (['>', '>='].includes(operator)) return 'has exceeded your threshold of';
    if (['<', '<='].includes(operator)) return 'has dropped below your threshold of';
    if (operator === '==') return 'has reached your threshold of';
    return `triggered the operator ${operator}`;
};

/** Shape of the JSON returned by Docker container stats (stream: false). */
interface DockerContainerStats {
    cpu_stats?: {
        cpu_usage?: { total_usage: number; percpu_usage?: number[] };
        system_cpu_usage?: number;
        online_cpus?: number;
    };
    precpu_stats?: {
        cpu_usage?: { total_usage: number };
        system_cpu_usage?: number;
    };
    memory_stats?: {
        usage?: number;
        limit?: number;
        stats?: { cache?: number };
    };
    networks?: Record<string, { rx_bytes: number; tx_bytes: number }>;
}

interface AlertState {
    breachStartedAt: number; // timestamp when the rule first breached
}

const HOST_ALERT_KEYS = {
    cpu: 'last_host_cpu_alert_ts',
    ram: 'last_host_ram_alert_ts',
    disk: 'last_host_disk_alert_ts',
    janitor: 'last_janitor_alert_timestamp',
} as const;

type HostMetricKey = 'cpu' | 'ram' | 'disk';

interface HostAlertSuppressionState {
    firstFiredAt: number;
    lastFiredAt: number;
    suppressedCount: number;
}

// F-11 dedup for host-metric notifications (CPU, RAM, disk). The previous
// 5-minute cooldown produced 7+ identical messages over a 35-minute window
// when a host stayed over threshold, flooding Discord/Slack routes. State is
// per-metric and module-scope so a singleton-replacement (only happens in
// tests) does not lose tracking. Cleared on process restart; the persisted
// system_state row keeps post-restart re-fires bounded.
const hostAlertSuppressionState = new Map<HostMetricKey, HostAlertSuppressionState>();
const DEFAULT_HOST_ALERT_SUPPRESSION_MIN = 60;
// Mirror the zod schema upper bound in `routes/settings.ts` so the single-key
// POST path (which lacks zod re-validation) cannot push the consumer past
// the validated range.
const MAX_HOST_ALERT_SUPPRESSION_MIN = 1440;

export function _resetHostAlertSuppressionStateForTests(): void {
    hostAlertSuppressionState.clear();
}

const STATS_TIMEOUT_MS = 10_000;
const FLOAT_EQ_EPSILON = 0.01;

// Janitor cadence and circuit-breaker. The disk-usage call (`docker system df`)
// can take 30+ seconds on Docker Desktop Windows when the daemon has many
// volumes; running it on the 30s evaluate cycle compounded with stats fan-out
// produced 140s+ stalls (F-6). Decoupling onto a slow cadence + tight timeout
// keeps the monitor cycle bounded and prevents the cycle from re-entering on
// a sick daemon.
const JANITOR_INTERVAL_MS = 15 * 60 * 1000;
const JANITOR_TIMEOUT_MS = 8_000;
const JANITOR_BREAKER_THRESHOLD = 3;
const JANITOR_BREAKER_COOLDOWN_MS = 60 * 60 * 1000;
const JANITOR_FIRST_TICK_DELAY_MS = 45_000;

// Cap on simultaneous Docker socket requests when fanning out per-container
// work. Mirrors the implicit safety profile of updateGlobalDockerNetwork in
// DockerController.ts (which fans out unbounded every 5 s on typical nodes);
// the explicit cap protects pathological hosts running 100+ containers.
const MAX_CONTAINER_CONCURRENCY = 10;

/**
 * Run an async task across `items` with at most `limit` workers in flight.
 * Each task is responsible for handling its own errors. An unexpected throw
 * from a task is logged and swallowed so siblings continue running.
 */
async function runWithConcurrency<T>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<void>,
): Promise<void> {
    if (items.length === 0) return;
    let cursor = 0;
    const worker = async () => {
        while (cursor < items.length) {
            const i = cursor++;
            try {
                await fn(items[i]);
            } catch (e) {
                // Defensive net: per-task code is expected to handle its own
                // errors. Logging here surfaces logic bugs in the task body.
                console.error('[Monitor] Unexpected error in container worker:', e);
            }
        }
    };
    const workerCount = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
}

export class MonitorService {
    private static instance: MonitorService;
    private intervalId: NodeJS.Timeout | null = null;
    private firstTickTimeoutId: NodeJS.Timeout | null = null;
    private janitorIntervalId: NodeJS.Timeout | null = null;
    private janitorFirstTickTimeoutId: NodeJS.Timeout | null = null;
    private isProcessing = false;
    private isJanitorProcessing = false;

    // Circuit-breaker state for the janitor disk-usage check. When
    // getDiskUsage() times out JANITOR_BREAKER_THRESHOLD times in a row the
    // breaker opens for JANITOR_BREAKER_COOLDOWN_MS so a sick daemon stops
    // pinning Dockerode sockets every cycle. Counter resets on success or
    // when the cooldown elapses.
    private janitorConsecutiveTimeouts = 0;
    private janitorBreakerUntil = 0;

    // Track the duration a specific stack alert rule has been in breach state
    // key: rule_id, value: AlertState
    private activeBreaches = new Map<number, AlertState>();

    // Track previous network counters per container for rate calculation.
    // key: container_id, value: { rx bytes, tx bytes, sample timestamp }
    private previousNetworkStats = new Map<string, { rx: number; tx: number; ts: number }>();

    // Per-cycle dispatch dedup. Stack rules are shared across every container
    // in the stack, so parallel processContainer calls can race past the
    // cooldown check (DB write happens after the awaited dispatch) and fire
    // the same alert N times on first breach. The synchronous check-and-add
    // below is atomic in JS between awaits, so only the first worker wins.
    // Reset at the start of each evaluateStackAlerts call.
    private firedThisCycle = new Set<number>();

    // Crash and healthcheck detection live in DockerEventService (event-driven,
    // causal classification). MonitorService no longer polls for container
    // exits; see backend/src/services/DockerEventService.ts.

    // Sencho version check cooldown (6 hours between external API calls)
    private lastVersionCheckAt = 0;
    private static readonly VERSION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
    private static readonly SENCHO_UPDATE_NOTIFIED_KEY = 'last_sencho_update_notified_version';

    private constructor() { }

    public static getInstance(): MonitorService {
        if (!MonitorService.instance) {
            MonitorService.instance = new MonitorService();
        }
        return MonitorService.instance;
    }

    public start() {
        if (this.intervalId) return;
        if (isDebugEnabled()) console.log('[Monitor:diag] Starting evaluation loop (30s interval) + janitor loop (15m interval)');

        // 30s monitor cycle: host stats, container stats, version check.
        // Does NOT include the janitor disk-usage check (F-6); that runs on
        // its own slow cadence so a hung df() cannot compound the cycle.
        this.intervalId = setInterval(() => {
            this.evaluate();
        }, 30000);
        this.firstTickTimeoutId = setTimeout(() => this.evaluate(), 5000);

        // 15m janitor cycle: disk-usage check with tight timeout + breaker.
        // First tick is deferred past the initial monitor tick's stats
        // fan-out so the two don't share daemon head-of-line latency.
        this.janitorIntervalId = setInterval(() => {
            this.evaluateJanitor();
        }, JANITOR_INTERVAL_MS);
        this.janitorFirstTickTimeoutId = setTimeout(() => this.evaluateJanitor(), JANITOR_FIRST_TICK_DELAY_MS);
    }

    public stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        if (this.firstTickTimeoutId) {
            clearTimeout(this.firstTickTimeoutId);
            this.firstTickTimeoutId = null;
        }
        if (this.janitorIntervalId) {
            clearInterval(this.janitorIntervalId);
            this.janitorIntervalId = null;
        }
        if (this.janitorFirstTickTimeoutId) {
            clearTimeout(this.janitorFirstTickTimeoutId);
            this.janitorFirstTickTimeoutId = null;
        }
        if (isDebugEnabled()) console.log('[Monitor:diag] Evaluation + janitor loops stopped');
    }

    private async evaluate() {
        if (this.isProcessing) return; // Prevent overlap if slow
        this.isProcessing = true;

        const cycleStart = Date.now();
        try {
            const db = DatabaseService.getInstance();
            const settings = db.getGlobalSettings();

            await this.evaluateGlobalSettings(settings);
            await this.evaluateStackAlerts(db);
            this.sweepStaleUpdateTrackers();

            const elapsed = Date.now() - cycleStart;
            if (elapsed > 25_000) {
                console.warn(`MonitorService evaluation cycle took ${elapsed}ms (threshold: 25s)`);
            }
            if (isDebugEnabled()) {
                console.log(`[Monitor:diag] Cycle completed in ${elapsed}ms, ${this.activeBreaches.size} active breach(es)`);
            }
        } catch (error) {
            console.error('MonitorService Evaluation Error:', error);
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Safety net for the in-memory fleet update trackers. The
     * /api/fleet/update-status poll is the primary resolver, but it only runs
     * while a client is watching; this sweep bounds in-flight trackers (to
     * timeout) and reaps stale completed badges even when nothing is polling.
     * Cheap, synchronous, in-memory.
     */
    private sweepStaleUpdateTrackers(): void {
        const { timedOut, reaped } = FleetUpdateTrackerService.getInstance().sweepStale();
        if (timedOut > 0) {
            console.warn(`[Monitor] Timed out ${timedOut} stale fleet update tracker(s) (no status poll within the update window)`);
        }
        if (isDebugEnabled() && reaped > 0) {
            console.debug(`[Monitor:diag] Reaped ${reaped} resolved fleet update tracker(s)`);
        }
    }

    private async evaluateGlobalSettings(settings: Record<string, string>) {
        // F-11 suppression window. Default 60 min; configurable via global
        // settings. NaN / non-positive values fall back to the default so a
        // misconfigured row never disables the dedup entirely. Cap at 24h
        // to defend against the single-key POST /api/settings path (which
        // stores allowlisted keys without zod re-validation): an accidental
        // 999999999-minute value must not silence host alerts for centuries.
        const suppressionMinRaw = parseInt(settings['host_alert_suppression_mins'] || '', 10);
        const suppressionMin = isNaN(suppressionMinRaw) || suppressionMinRaw <= 0
            ? DEFAULT_HOST_ALERT_SUPPRESSION_MIN
            : Math.min(suppressionMinRaw, MAX_HOST_ALERT_SUPPRESSION_MIN);
        const suppressionMs = suppressionMin * 60 * 1000;

        // 1. Host Limits — fetch CPU, RAM, disk concurrently
        if (settings['host_alerts_enabled'] !== '0') {
            try {
                const [currentLoad, hostMem, fsSize] = await Promise.all([
                    withTimeout(si.currentLoad(), STATS_TIMEOUT_MS, 'host CPU stats'),
                    withTimeout(getHostMemory(), STATS_TIMEOUT_MS, 'host RAM stats'),
                    withTimeout(si.fsSize(), STATS_TIMEOUT_MS, 'host disk stats'),
                ]);

                const cpuUsage = currentLoad.currentLoad;
                const cpuLimit = parseFloat(settings['host_cpu_limit']);
                if (!isNaN(cpuLimit) && cpuLimit > 0 && cpuUsage > cpuLimit) {
                    await this.dispatchHostMetricAlert('cpu', 'warning', suppressionMs,
                        `Host CPU utilization is critically high: ${cpuUsage.toFixed(1)}% (Threshold: ${cpuLimit}%)`);
                } else {
                    this.clearHostMetricSuppression('cpu');
                }

                // ZFS ARC aware: reclaimable ARC is added back into available so a large ARC
                // cache does not fire spurious host-memory alerts. See helpers/hostMemory.ts.
                const ramUsage = hostMem.usagePercent;
                const ramLimit = parseFloat(settings['host_ram_limit']);
                if (!isNaN(ramLimit) && ramLimit > 0 && ramUsage > ramLimit) {
                    await this.dispatchHostMetricAlert('ram', 'warning', suppressionMs,
                        `Host Memory utilization is critically high: ${ramUsage.toFixed(1)}% (Threshold: ${ramLimit}%)`);
                } else {
                    this.clearHostMetricSuppression('ram');
                }

                const mainDisk = fsSize.find(fs => fs.mount === '/' || fs.mount === 'C:') || fsSize[0];
                if (mainDisk) {
                    const diskLimit = parseFloat(settings['host_disk_limit']);
                    if (!isNaN(diskLimit) && diskLimit > 0 && mainDisk.use > diskLimit) {
                        await this.dispatchHostMetricAlert('disk', 'warning', suppressionMs,
                            `Host Disk space utilization is critically high: ${mainDisk.use.toFixed(1)}% (Threshold: ${diskLimit}%)`);
                    } else {
                        this.clearHostMetricSuppression('disk');
                    }
                }
            } catch (e) {
                console.error('Error checking host limits in watchdog', e);
            }
        } else {
            // Host threshold alerts are disabled: clear any stale suppression
            // state so re-enabling starts fresh (no "Suppressed N" carryover).
            this.clearHostMetricSuppression('cpu');
            this.clearHostMetricSuppression('ram');
            this.clearHostMetricSuppression('disk');
        }

        // 2. (Removed) Container crash + healthcheck detection moved to
        //    DockerEventService: event-driven, causal, distinguishes
        //    intentional stops from real crashes, detects OOM kills.

        // 3. (Decoupled) Docker janitor disk-usage check runs on its own
        //    slow cadence in evaluateJanitor(); see start() and F-6.

        // 4. Sencho version update check (runs once per VERSION_CHECK_INTERVAL_MS)
        await this.checkSenchoVersion();
    }

    /**
     * Slow-cadence janitor disk-usage check, decoupled from the 30s monitor
     * cycle (F-6). A hung `docker system df` would otherwise compound with
     * the per-container stats fan-out and produce 140s+ stalls.
     *
     * Failure handling:
     * - TimeoutError increments a counter; at JANITOR_BREAKER_THRESHOLD the
     *   breaker opens for JANITOR_BREAKER_COOLDOWN_MS, after which the
     *   counter resets and the next tick attempts again.
     * - Other errors (daemon unreachable, parse errors) are logged but do
     *   not advance the breaker, because they are not the failure mode the
     *   breaker exists to mitigate.
     * - Re-entrancy is guarded; this matters because the 8s timeout still
     *   may leave the previous in-flight `df()` resolving in the background.
     */
    private async evaluateJanitor(): Promise<void> {
        if (this.isJanitorProcessing) return;

        if (Date.now() < this.janitorBreakerUntil) {
            if (isDebugEnabled()) {
                const remainingMin = Math.round((this.janitorBreakerUntil - Date.now()) / 60000);
                console.debug(`[Monitor:diag] Janitor breaker open; next attempt in ~${remainingMin}m`);
            }
            return;
        }

        this.isJanitorProcessing = true;
        try {
            const db = DatabaseService.getInstance();
            const settings = db.getGlobalSettings();

            // Prune scans for artifacts that no longer exist (own try/catch so a
            // reconcile failure never aborts the disk-usage check below). Lives
            // here because it is Docker-heavy and the 15-min janitor cadence is
            // the right throttle; it runs even when the disk alert is disabled.
            try {
                await this.reconcileOrphanedScans(db, settings);
            } catch (e) {
                console.error('[Monitor] Orphaned-scan reconcile failed', e);
            }

            const janitorLimitGb = parseFloat(settings['docker_janitor_gb']);
            if (isNaN(janitorLimitGb) || janitorLimitGb <= 0) return;

            let usage: Awaited<ReturnType<DockerController['getDiskUsage']>>;
            try {
                usage = await withTimeout(
                    DockerController.getInstance().getDiskUsage(),
                    JANITOR_TIMEOUT_MS,
                    'docker disk usage',
                );
            } catch (e) {
                if (e instanceof TimeoutError) {
                    this.janitorConsecutiveTimeouts += 1;
                    if (this.janitorConsecutiveTimeouts >= JANITOR_BREAKER_THRESHOLD) {
                        this.janitorBreakerUntil = Date.now() + JANITOR_BREAKER_COOLDOWN_MS;
                        const cooldownMin = Math.round(JANITOR_BREAKER_COOLDOWN_MS / 60000);
                        console.warn(
                            `[Monitor] Janitor disk-usage check circuit breaker opened after ${this.janitorConsecutiveTimeouts} consecutive timeouts (next attempt in ${cooldownMin}m)`,
                        );
                        this.janitorConsecutiveTimeouts = 0;
                    } else if (isDebugEnabled()) {
                        console.debug(`[Monitor:diag] Janitor disk-usage timeout ${this.janitorConsecutiveTimeouts}/${JANITOR_BREAKER_THRESHOLD}`);
                    }
                    return;
                }
                console.error('Error checking docker janitor limits', e);
                return;
            }

            // Recovery covers both partial-failure recovery (counter > 0,
            // breaker still closed) and post-cooldown recovery (counter
            // zeroed on open, breaker now elapsed). janitorBreakerUntil
            // remains set to its past timestamp until the next success
            // clears it; that flag is what distinguishes "always healthy"
            // from "was sick, now recovered" once the cooldown has passed.
            if (this.janitorConsecutiveTimeouts > 0 || this.janitorBreakerUntil > 0) {
                console.log('[Monitor] Janitor disk-usage check recovered');
                this.janitorConsecutiveTimeouts = 0;
                this.janitorBreakerUntil = 0;
            }

            const totalReclaimableBytes =
                usage.reclaimableImages +
                usage.reclaimableContainers +
                usage.reclaimableVolumes +
                usage.reclaimableBuildCache;

            const reclaimGb = totalReclaimableBytes / (1024 * 1024 * 1024);
            const JANITOR_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h between repeat alerts
            // Sanity floor: never alert on near-empty hosts even if the user
            // configured an aggressive threshold like 0.001 GB. 100 MB is the
            // smallest waste worth interrupting an operator over.
            const MIN_RECLAIMABLE_GB = 0.1;

            if (reclaimGb >= janitorLimitGb && reclaimGb >= MIN_RECLAIMABLE_GB) {
                const registry = NodeRegistry.getInstance();
                const localNode = registry.getNode(registry.getDefaultNodeId());
                const nodeLabel = localNode?.name ?? 'this node';
                await this.dispatchWithCooldown(
                    HOST_ALERT_KEYS.janitor,
                    JANITOR_COOLDOWN_MS,
                    'info',
                    'system',
                    `Node "${nodeLabel}" has accumulated ${reclaimGb.toFixed(1)} GB of unused Docker data. Open Resources to reclaim space, or set up a Prune Node Resources schedule.`,
                );
            }
        } finally {
            this.isJanitorProcessing = false;
        }
    }

    /**
     * Remove scans whose artifact no longer exists, so the Security Overview
     * reflects what is still on the host. Per-instance: only the local node's
     * scans are reconciled against the local Docker image list and stack dirs.
     *
     * Fail-safe by construction: a scan is only purged when we positively know
     * its artifact is gone. If the image list cannot be read, the whole pass is
     * skipped (we never delete on an unread list). Stack scans are reconciled
     * only when getStacks() returns a non-empty list, because it returns [] on
     * both an empty dir and an FS error and we cannot tell them apart.
     *
     * Image refs are compared after normalizeImageRef so equivalent forms match
     * (untagged `alpine` vs Docker's `alpine:latest`, `docker.io/library/`
     * prefixes), and both RepoTags and RepoDigests feed the live set so a
     * digest-pinned scan ref still matches a present image. Erring toward
     * "matches, keep" is the safe direction: the cost of a miss is a stale scan,
     * not a wrongly deleted one.
     */
    private async reconcileOrphanedScans(
        db: DatabaseService,
        settings: Readonly<Record<string, string>>,
    ): Promise<void> {
        // Destructive cleanup: enabled only on an explicit '1'. A missing key or
        // a read failure leaves it off, the safe default.
        if (settings['prune_orphaned_scans'] !== '1') return;

        const nodeId = NodeRegistry.getInstance().getDefaultNodeId();

        let liveImageRefs: Set<string>;
        try {
            const images = (await withTimeout(
                DockerController.getInstance(nodeId).getImages(),
                JANITOR_TIMEOUT_MS,
                'docker images (scan reconcile)',
            )) as Array<{ RepoTags?: string[]; RepoDigests?: string[] }>;
            liveImageRefs = new Set<string>();
            for (const img of images) {
                for (const ref of [...(img.RepoTags ?? []), ...(img.RepoDigests ?? [])]) {
                    if (ref && !ref.startsWith('<none>')) liveImageRefs.add(normalizeImageRef(ref));
                }
            }
        } catch (e) {
            if (isDebugEnabled()) {
                console.debug('[Monitor:diag] Scan reconcile skipped: image list unavailable', e);
            }
            return;
        }

        // getStacks() never throws (it swallows FS errors and returns []), so an
        // empty list is ambiguous (empty dir vs failed read); reconcileStacks
        // gates stack purging on a non-empty list to avoid deleting on a failure.
        const liveStacks = await FileSystemService.getInstance(nodeId).getStacks();
        const reconcileStacks = liveStacks.length > 0;
        const liveStackSet = new Set(liveStacks);

        let purgedImageScans = 0;
        let purgedStackScans = 0;
        for (const ref of db.getDistinctScanImageRefs(nodeId)) {
            if (ref.startsWith('stack:')) {
                if (!reconcileStacks) continue;
                if (!liveStackSet.has(ref.slice('stack:'.length))) {
                    purgedStackScans += db.deleteScansByImageRef(nodeId, ref);
                }
            } else if (!liveImageRefs.has(normalizeImageRef(ref))) {
                purgedImageScans += db.deleteScansByImageRef(nodeId, ref);
            }
        }

        if (isDebugEnabled() && (purgedImageScans > 0 || purgedStackScans > 0)) {
            console.debug(
                `[Monitor:diag] Scan reconcile: purged ${purgedImageScans} image scan(s) `
                + `(${liveImageRefs.size} live image refs), ${purgedStackScans} stack scan(s)`
                + (reconcileStacks ? '' : ' (stack reconcile skipped: empty stack list)'),
            );
        }
    }

    /**
     * Check GitHub/Docker Hub for a newer Sencho release and dispatch a
     * one-shot notification. Uses getLatestVersionInfo() which wraps CacheService
     * (30 min TTL when published, shorter while a GitHub release awaits registry
     * publish + inflight dedup) so transient network blips do not cause gaps,
     * and the check stays consistent with the Fleet update banner.
     *
     * The 6-hour cooldown gate prevents bell spam: it is only advanced on a
     * SUCCESSFUL lookup. A failed lookup retries on the next eval cycle
     * (30 seconds) instead of locking for 6 hours.
     */
    private async checkSenchoVersion(): Promise<void> {
        const sinceLast = Date.now() - this.lastVersionCheckAt;
        if (sinceLast <= MonitorService.VERSION_CHECK_INTERVAL_MS) {
            if (isDebugEnabled()) {
                const nextInMs = MonitorService.VERSION_CHECK_INTERVAL_MS - sinceLast;
                console.debug(`[Monitor:diag] Sencho version check in cooldown (next in ~${Math.round(nextInMs / 60000)}m)`);
            }
            return;
        }

        // Resolve from the packaged manifest: process.env.npm_package_version is
        // only set by npm scripts, so it is undefined in Docker (node dist/index.js).
        const currentVersion = getSenchoVersion();
        if (!isValidVersion(currentVersion)) {
            if (isDebugEnabled()) console.debug('[Monitor:diag] Sencho version unresolvable; skipping update notification');
            return;
        }

        const versionInfo = await getLatestVersionInfo();
        if (!versionInfo || !isValidVersion(versionInfo.version)) {
            // Network failure (GitHub + Docker Hub both down, no stale cache).
            // Do NOT advance the cooldown so the next eval retries.
            if (isDebugEnabled()) console.debug('[Monitor:diag] Latest Sencho version unresolvable; will retry next cycle');
            return;
        }

        if (versionInfo.publishPending) {
            // GitHub announced a release before the image is pullable. Retry on
            // the next eval cycle without advancing the 6-hour cooldown.
            if (isDebugEnabled()) console.debug('[Monitor:diag] Sencho release pending registry publish; will retry next cycle');
            return;
        }

        this.lastVersionCheckAt = Date.now();
        const latest = versionInfo.version;

        const db = DatabaseService.getInstance();
        const stateKey = MonitorService.SENCHO_UPDATE_NOTIFIED_KEY;
        const storedLastNotified = db.getSystemState(stateKey) || '';

        // Self-heal: if the user has reached the previously-notified version,
        // clear the dedup so future releases always trigger a fresh notification.
        // This also recovers from stale state left over by the pre-586 "0.0.0" bug.
        let effectiveLastNotified = storedLastNotified;
        if (storedLastNotified && isValidVersion(storedLastNotified) && semver.gte(currentVersion, storedLastNotified)) {
            if (isDebugEnabled()) console.debug(`[Monitor:diag] Clearing stale dedup key (running ${currentVersion} >= last notified ${storedLastNotified})`);
            db.setSystemState(stateKey, '');
            effectiveLastNotified = '';
        }

        if (!semver.gt(latest, currentVersion)) {
            if (isDebugEnabled()) console.debug(`[Monitor:diag] Running ${currentVersion} is up-to-date with latest ${latest}`);
            return;
        }

        if (effectiveLastNotified === latest) {
            if (isDebugEnabled()) console.debug(`[Monitor:diag] Already notified for Sencho ${latest}`);
            return;
        }

        try {
            const notifier = NotificationService.getInstance();
            await notifier.dispatchAlert('info', 'node_update_available',
                `Sencho ${latest} is available (currently running ${currentVersion}). Visit the Fleet dashboard to update.`);
            db.setSystemState(stateKey, latest);
            if (isDebugEnabled()) console.debug(`[Monitor:diag] Dispatched version notification: ${currentVersion} -> ${latest}`);
        } catch (e) {
            // dispatchAlert normally catches channel errors internally, but the
            // history insert or WebSocket broadcast can throw on an unhealthy DB.
            console.error('[MonitorService] Failed to dispatch Sencho version notification:', e);
        }
    }

    private async evaluateStackAlerts(db: DatabaseService) {
        const alerts = db.getStackAlerts();
        const nodes = db.getNodes();
        this.firedThisCycle.clear();

        // Pre-group alerts by stack name to avoid O(containers * alerts) scanning
        const alertsByStack = new Map<string, typeof alerts>();
        for (const a of alerts) {
            const list = alertsByStack.get(a.stack_name);
            if (list) list.push(a);
            else alertsByStack.set(a.stack_name, [a]);
        }

        for (const node of nodes) {
            if (!node.id) continue;
            // Remote nodes are self-monitoring - skip direct Docker access
            if (node.type === 'remote') continue;
            try {
                const docker = DockerController.getInstance(node.id);
                const containers = await docker.getRunningContainers();

                // Per-container work runs in parallel with bounded concurrency.
                // Each Docker stats call inherently waits ~1 s for the engine
                // to produce a sample, so a serial loop scales linearly with
                // container count; fanning out collapses the cycle to roughly
                // max(per-container time) plus the start-up stagger.
                await runWithConcurrency(
                    containers,
                    MAX_CONTAINER_CONCURRENCY,
                    (container) => this.processContainer(node, container, alertsByStack, docker, db),
                );

                // Clean up stale network stats for containers on this node that no longer run
                if (this.previousNetworkStats.size > containers.length * 2) {
                    const currentIds = new Set(containers.map((c: { Id: string }) => c.Id));
                    for (const key of this.previousNetworkStats.keys()) {
                        if (!currentIds.has(key)) this.previousNetworkStats.delete(key);
                    }
                }
            } catch (err) {
                console.error(`Error fetching containers for node ${node.name}`, err);
            }
        }

        // Clean up stale breach trackers for rules that have been deleted
        const activeRuleIds = new Set(alerts.map(a => a.id!));
        for (const key of this.activeBreaches.keys()) {
            if (!activeRuleIds.has(key)) {
                this.activeBreaches.delete(key);
            }
        }

        try {
            const settings = db.getGlobalSettings();
            const retentionHours = parseInt(settings['metrics_retention_hours'] || '24', 10);
            db.cleanupOldMetrics(isNaN(retentionHours) ? 24 : retentionHours);
            const retentionDays = parseInt(settings['log_retention_days'] || '30', 10);
            const notifSummary = db.cleanupOldNotifications(isNaN(retentionDays) ? 30 : retentionDays);
            const auditRetentionDays = parseInt(settings['audit_retention_days'] || '90', 10);
            db.cleanupOldAuditLogs(isNaN(auditRetentionDays) ? 90 : auditRetentionDays);
            const scanPerImage = parseInt(settings['scan_history_per_image_limit'] || '50', 10);
            const scanPruned = db.pruneScanHistoryPerImage(isNaN(scanPerImage) ? 50 : scanPerImage);
            if (isDebugEnabled()) console.log(`[Monitor:diag] Cleanup: metrics ${isNaN(retentionHours) ? 24 : retentionHours}h, notifications ${isNaN(retentionDays) ? 30 : retentionDays}d (ttl=${notifSummary.ttl} perStack=${notifSummary.perStack} perNode=${notifSummary.perNode}), audit ${isNaN(auditRetentionDays) ? 90 : auditRetentionDays}d, scans pruned ${scanPruned}`);
        } catch (e) {
            console.error('MonitorService: failed to cleanup old data', e);
        }
    }

    /**
     * Evaluate one container's metrics against the alert rules for its stack.
     * Owns its own try/catch so per-container failures (404 churn, stats
     * timeouts) do not abort sibling work in the parallel fan-out.
     */
    private async processContainer(
        node: Node,
        container: { Id: string; Labels?: Record<string, string> },
        alertsByStack: Map<string, StackAlert[]>,
        docker: DockerController,
        db: DatabaseService,
    ): Promise<void> {
        const stackName = container.Labels?.['com.docker.compose.project'] || 'system';

        try {
            const rawStats = await withTimeout(
                docker.getContainerStatsStream(container.Id),
                STATS_TIMEOUT_MS,
                `stats for ${container.Id}`,
            );
            const stats: DockerContainerStats = JSON.parse(rawStats);

            const usedMemory = (stats.memory_stats?.usage || 0) - (stats.memory_stats?.stats?.cache || 0);

            // Only fetch restart count when at least one rule for this stack uses it
            const stackAlerts = alertsByStack.get(stackName) || [];
            const needsRestartCount = stackAlerts.some(a => a.metric === 'restart_count');
            const restartCount = needsRestartCount
                ? await docker.getContainerRestartCount(container.Id)
                : 0;

            // Network rate calculation: compute delta from previous sample
            // to produce MB/s instead of meaningless cumulative totals.
            const rawRxMb = this.calculateNetwork(stats, 'rx');
            const rawTxMb = this.calculateNetwork(stats, 'tx');
            const now = Date.now();
            const prevNet = this.previousNetworkStats.get(container.Id);
            let netRxRate = 0;
            let netTxRate = 0;
            if (prevNet) {
                const elapsedSec = (now - prevNet.ts) / 1000;
                if (elapsedSec > 0) {
                    netRxRate = Math.max(0, (rawRxMb - prevNet.rx) / elapsedSec);
                    netTxRate = Math.max(0, (rawTxMb - prevNet.tx) / elapsedSec);
                }
            }
            this.previousNetworkStats.set(container.Id, { rx: rawRxMb, tx: rawTxMb, ts: now });

            const metrics = {
                cpu_percent: this.calculateCpuPercent(stats),
                memory_percent: this.calculateMemoryPercent(stats),
                memory_mb: Math.max(0, usedMemory) / (1024 * 1024),
                net_rx: netRxRate,
                net_tx: netTxRate,
                restart_count: restartCount,
            };

            db.addContainerMetric({
                container_id: container.Id,
                stack_name: stackName,
                cpu_percent: metrics.cpu_percent || 0,
                memory_mb: metrics.memory_mb || 0,
                net_rx_mb: netRxRate || 0,
                net_tx_mb: netTxRate || 0,
                timestamp: now,
            });

            for (const rule of stackAlerts) {
                const ruleId = rule.id!;
                const currentValue = metrics[rule.metric as keyof typeof metrics];

                if (currentValue === undefined) continue;

                const isBreaching = this.evaluateCondition(currentValue, rule.operator, rule.threshold);

                if (isBreaching) {
                    if (!this.activeBreaches.has(ruleId)) {
                        this.activeBreaches.set(ruleId, { breachStartedAt: Date.now() });
                        if (isDebugEnabled()) console.log(`[Monitor:diag] Breach entered: rule ${ruleId} (${rule.metric} ${rule.operator} ${rule.threshold}) on stack "${rule.stack_name}"`);
                    }

                    const breachState = this.activeBreaches.get(ruleId)!;
                    const durationMs = Date.now() - breachState.breachStartedAt;
                    const requiredDurationMs = rule.duration_mins * 60 * 1000;

                    if (durationMs >= requiredDurationMs) {
                        const timeSinceLastFired = Date.now() - (rule.last_fired_at || 0);
                        const requiredCooldownMs = rule.cooldown_mins * 60 * 1000;

                        if (timeSinceLastFired >= requiredCooldownMs) {
                            // Claim this rule for the cycle before awaiting
                            // dispatch. The check-and-add is synchronous, so
                            // sibling workers evaluating the same shared rule
                            // see the claim and skip — preventing N-fire when
                            // multiple containers in one stack all breach.
                            if (this.firedThisCycle.has(ruleId)) {
                                if (isDebugEnabled()) console.log(`[Monitor:diag] Skipping duplicate dispatch for rule ${ruleId} (already fired this cycle by sibling container)`);
                            } else {
                                this.firedThisCycle.add(ruleId);

                                const { name: metricName, unit } = getMetricDetails(rule.metric);
                                const operatorPhrase = getOperatorPhrase(rule.operator);

                                const safeCurrent = typeof currentValue === 'number' ? Number(currentValue.toFixed(2)) : currentValue;
                                const safeThreshold = typeof rule.threshold === 'number' ? Number(rule.threshold.toFixed(2)) : rule.threshold;

                                const message = `[Node: ${node.name}] The **${metricName}** for **${rule.stack_name}** ${operatorPhrase} **${safeThreshold}${unit}** (Currently: ${safeCurrent}${unit}).`;

                                console.log(`[MonitorService] Alert fired: rule ${ruleId} on stack "${rule.stack_name}": ${metricName} ${operatorPhrase} ${safeThreshold}${unit}`);
                                await NotificationService.getInstance().dispatchAlert(
                                    'warning',
                                    'monitor_alert',
                                    message,
                                    { stackName: rule.stack_name, actor: 'system:monitor' },
                                );

                                db.updateStackAlertLastFired(ruleId, Date.now());
                            }
                        } else if (isDebugEnabled()) {
                            console.log(`[Monitor:diag] Cooldown active for rule ${ruleId}: ${Math.round((requiredCooldownMs - timeSinceLastFired) / 1000)}s remaining`);
                        }
                    }
                } else {
                    if (this.activeBreaches.has(ruleId)) {
                        if (isDebugEnabled()) console.log(`[Monitor:diag] Breach cleared: rule ${ruleId} on stack "${rule.stack_name}"`);
                        this.activeBreaches.delete(ruleId);
                    }
                }
            }
        } catch (e) {
            // Containers can be removed between getRunningContainers() and the
            // per-container stats call (e.g., during a stack update). Dockerode
            // throws a 404 in that case. That's expected churn, not a real
            // error, so skip silently rather than flooding the logs.
            const err = e as { statusCode?: number; reason?: string };
            if (err?.statusCode === 404 || err?.reason === 'no such container') {
                return;
            }
            if (e instanceof TimeoutError) {
                console.warn(`Stats timeout for container ${container.Id} on node ${node.name}`);
                return;
            }
            console.error(`Error parsing stats for container ${container.Id} on node ${node.name}`, e);
        }
    }

    private evaluateCondition(actual: number, operator: string, threshold: number): boolean {
        switch (operator) {
            case '>': return actual > threshold;
            case '<': return actual < threshold;
            case '>=': return actual >= threshold;
            case '<=': return actual <= threshold;
            case '==': return Math.abs(actual - threshold) < FLOAT_EQ_EPSILON;
            default: return false;
        }
    }

    /** Dispatch an alert only if the cooldown period has elapsed since the last alert for this key. */
    private async dispatchWithCooldown(
        stateKey: string, cooldownMs: number,
        severity: 'info' | 'warning' | 'error', category: import('./NotificationService').NotificationCategory,
        message: string, stack?: string,
    ): Promise<void> {
        const db = DatabaseService.getInstance();
        const last = parseInt(db.getSystemState(stateKey) || '0', 10);
        if (Date.now() - last > cooldownMs) {
            await NotificationService.getInstance().dispatchAlert(severity, category, message, { stackName: stack, actor: 'system:monitor' });
            db.setSystemState(stateKey, Date.now().toString());
        }
    }

    /**
     * F-11 host-metric dispatch with per-key suppression window + count
     * summary. Replaces the old 5-minute hardcoded cooldown for CPU/RAM/disk.
     *
     * Behaviour:
     *  - First breach (no in-memory state, no recent persisted timestamp) →
     *    dispatch immediately and seed in-memory state.
     *  - Restart on a still-breaching host (no in-memory state, but persisted
     *    timestamp falls inside the window) → silently re-seed from the
     *    persisted timestamp so post-restart cycles do not re-fire.
     *  - Breach within an open suppression window → silently increment
     *    suppressedCount; no dispatch, no broadcast.
     *  - Breach after window elapses → fire one follow-up with the suffix
     *    `Suppressed N alerts in the last Xm; first over threshold at HH:MM UTC.`
     *
     * Recovery is handled by the caller via clearHostMetricSuppression(): when
     * the metric drops below threshold, in-memory state and the persisted
     * timestamp are cleared so the next breach fires fresh.
     */
    private async dispatchHostMetricAlert(
        key: HostMetricKey,
        severity: 'info' | 'warning' | 'error',
        suppressionMs: number,
        baseMessage: string,
    ): Promise<void> {
        const db = DatabaseService.getInstance();
        const stateKey = HOST_ALERT_KEYS[key];
        const now = Date.now();
        const state = hostAlertSuppressionState.get(key);

        if (!state) {
            const persistedLast = parseInt(db.getSystemState(stateKey) || '0', 10);
            if (persistedLast > 0 && now - persistedLast < suppressionMs) {
                // Post-restart on a still-breaching host: respect the
                // persisted cooldown so we do not re-fire immediately. Seed
                // in-memory state from the persisted timestamp; count this
                // cycle as suppressed for an honest follow-up summary.
                hostAlertSuppressionState.set(key, {
                    firstFiredAt: persistedLast,
                    lastFiredAt: persistedLast,
                    suppressedCount: 1,
                });
                return;
            }
            // First-ever fire (fresh process, or post-recovery re-breach).
            await NotificationService.getInstance().dispatchAlert(severity, 'monitor_alert', baseMessage);
            hostAlertSuppressionState.set(key, {
                firstFiredAt: now,
                lastFiredAt: now,
                suppressedCount: 0,
            });
            db.setSystemState(stateKey, now.toString());
            return;
        }

        if (now - state.lastFiredAt < suppressionMs) {
            state.suppressedCount += 1;
            return;
        }

        const windowMin = Math.max(1, Math.round((now - state.lastFiredAt) / 60000));
        const firstAt = new Date(state.firstFiredAt).toISOString().slice(11, 16);
        const plural = state.suppressedCount === 1 ? '' : 's';
        const suffix = ` Suppressed ${state.suppressedCount} alert${plural} in the last ${windowMin}m; first over threshold at ${firstAt} UTC.`;
        await NotificationService.getInstance().dispatchAlert(severity, 'monitor_alert', baseMessage + suffix);
        state.lastFiredAt = now;
        state.suppressedCount = 0;
        db.setSystemState(stateKey, now.toString());
    }

    /**
     * Clear in-memory + persisted suppression state for a host metric. Called
     * when the metric drops below threshold so the next breach fires fresh
     * (no "Suppressed N" suffix). Resetting the persisted row to '0' is
     * essential: a stale persisted timestamp inside the window would silently
     * absorb the next breach via the restart-survivability path.
     *
     * The persisted reset must run independently of in-memory state because
     * the two halves can drift after a process restart: the in-memory Map is
     * empty on a fresh process, but the system_state row from the previous
     * process still points at the old fire timestamp. If recovery happens
     * before another evaluate cycle re-seeds in-memory state, an early-return
     * on the in-memory check alone would leave the persisted row alive, and
     * the next re-breach within the original window would be silently
     * suppressed instead of firing fresh (Codex audit on PR #1175).
     */
    private clearHostMetricSuppression(key: HostMetricKey): void {
        const stateKey = HOST_ALERT_KEYS[key];
        const db = DatabaseService.getInstance();
        const hadInMemory = hostAlertSuppressionState.delete(key);
        const persisted = db.getSystemState(stateKey);
        const needsPersistedReset = persisted !== null && persisted !== '0';
        if (!hadInMemory && !needsPersistedReset) return;
        if (needsPersistedReset) {
            db.setSystemState(stateKey, '0');
        }
    }

    private calculateCpuPercent(stats: DockerContainerStats): number {
        let cpuPercent = 0.0;
        if (!stats?.cpu_stats?.cpu_usage || !stats?.precpu_stats?.cpu_usage) return 0.0;

        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
        const systemDelta = (stats.cpu_stats.system_cpu_usage || 0) - (stats.precpu_stats.system_cpu_usage || 0);
        const numCpus = stats.cpu_stats.online_cpus || (stats.cpu_stats.cpu_usage.percpu_usage ? stats.cpu_stats.cpu_usage.percpu_usage.length : 1);

        if (systemDelta > 0.0 && cpuDelta > 0.0) {
            cpuPercent = (cpuDelta / systemDelta) * numCpus * 100.0;
        }
        return cpuPercent;
    }

    private calculateMemoryPercent(stats: DockerContainerStats): number {
        if (!stats?.memory_stats?.usage || !stats?.memory_stats?.limit) return 0.0;

        const used_memory = stats.memory_stats.usage - (stats.memory_stats.stats?.cache || 0);
        const available_memory = stats.memory_stats.limit;
        if (available_memory > 0) {
            return (used_memory / available_memory) * 100.0;
        }
        return 0.0;
    }

    private calculateNetwork(stats: DockerContainerStats, direction: 'rx' | 'tx'): number {
        let bytes = 0;
        if (stats.networks) {
            const key = direction === 'rx' ? 'rx_bytes' : 'tx_bytes';
            for (const iface in stats.networks) {
                bytes += stats.networks[iface][key];
            }
        }
        return bytes / (1024 * 1024); // Return in MB
    }
}
