import si from 'systeminformation';
import semver from 'semver';
import DockerController from './DockerController';
import { DatabaseService } from './DatabaseService';
import { NodeRegistry } from './NodeRegistry';
import { NotificationService } from './NotificationService';
import { isValidVersion, getSenchoVersion } from './CapabilityRegistry';
import { getLatestVersion } from '../utils/version-check';
import { isDebugEnabled } from '../utils/debug';

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

const STATS_TIMEOUT_MS = 10_000;
const FLOAT_EQ_EPSILON = 0.01;

class TimeoutError extends Error {
    constructor(label: string, ms: number) {
        super(`Timeout: ${label} after ${ms}ms`);
        this.name = 'TimeoutError';
    }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    // Note: JavaScript Promise.race does not cancel the losing promise.
    // A timed-out Docker API or systeminformation call continues in the
    // background until it resolves or the process exits. True cancellation
    // requires AbortController plumbing through DockerController and
    // systeminformation, which is a structural limitation of the codebase.
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class MonitorService {
    private static instance: MonitorService;
    private intervalId: NodeJS.Timeout | null = null;
    private isProcessing = false;

    // Track the duration a specific stack alert rule has been in breach state
    // key: rule_id, value: AlertState
    private activeBreaches = new Map<number, AlertState>();

    // Track previous network counters per container for rate calculation.
    // key: container_id, value: { rx bytes, tx bytes, sample timestamp }
    private previousNetworkStats = new Map<string, { rx: number; tx: number; ts: number }>();

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
        if (isDebugEnabled()) console.log('[Monitor:diag] Starting evaluation loop (30s interval)');

        // Run every 30 seconds
        this.intervalId = setInterval(() => {
            this.evaluate();
        }, 30000);

        // Run an initial evaluation slightly after boot
        setTimeout(() => this.evaluate(), 5000);
    }

    public stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            if (isDebugEnabled()) console.log('[Monitor:diag] Evaluation loop stopped');
        }
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

    private async evaluateGlobalSettings(settings: Record<string, string>) {
        const HOST_ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between repeat alerts

        // 1. Host Limits — fetch CPU, RAM, disk concurrently
        try {
            const [currentLoad, mem, fsSize] = await Promise.all([
                withTimeout(si.currentLoad(), STATS_TIMEOUT_MS, 'host CPU stats'),
                withTimeout(si.mem(), STATS_TIMEOUT_MS, 'host RAM stats'),
                withTimeout(si.fsSize(), STATS_TIMEOUT_MS, 'host disk stats'),
            ]);

            const cpuUsage = currentLoad.currentLoad;
            const cpuLimit = parseFloat(settings['host_cpu_limit']);
            if (!isNaN(cpuLimit) && cpuLimit > 0 && cpuUsage > cpuLimit) {
                await this.dispatchWithCooldown(HOST_ALERT_KEYS.cpu, HOST_ALERT_COOLDOWN_MS, 'warning', 'monitor_alert',
                    `Host CPU utilization is critically high: ${cpuUsage.toFixed(1)}% (Threshold: ${cpuLimit}%)`);
            }

            const ramUsage = (mem.used / mem.total) * 100;
            const ramLimit = parseFloat(settings['host_ram_limit']);
            if (!isNaN(ramLimit) && ramLimit > 0 && ramUsage > ramLimit) {
                await this.dispatchWithCooldown(HOST_ALERT_KEYS.ram, HOST_ALERT_COOLDOWN_MS, 'warning', 'monitor_alert',
                    `Host Memory utilization is critically high: ${ramUsage.toFixed(1)}% (Threshold: ${ramLimit}%)`);
            }

            const mainDisk = fsSize.find(fs => fs.mount === '/' || fs.mount === 'C:') || fsSize[0];
            if (mainDisk) {
                const diskLimit = parseFloat(settings['host_disk_limit']);
                if (!isNaN(diskLimit) && diskLimit > 0 && mainDisk.use > diskLimit) {
                    await this.dispatchWithCooldown(HOST_ALERT_KEYS.disk, HOST_ALERT_COOLDOWN_MS, 'warning', 'monitor_alert',
                        `Host Disk space utilization is critically high: ${mainDisk.use.toFixed(1)}% (Threshold: ${diskLimit}%)`);
                }
            }
        } catch (e) {
            console.error('Error checking host limits in watchdog', e);
        }

        // 2. (Removed) Container crash + healthcheck detection moved to
        //    DockerEventService: event-driven, causal, distinguishes
        //    intentional stops from real crashes, detects OOM kills.

        // 3. Docker Janitor Check
        try {
            const janitorLimitGb = parseFloat(settings['docker_janitor_gb']);
            if (!isNaN(janitorLimitGb) && janitorLimitGb > 0) {
                // Use the Docker Engine API directly via dockerode. The previous
                // shell-out parsed `docker system df --format "{{json .}}"` and
                // walked the human-readable "1.196GB" Reclaimable strings with
                // a regex; the API returns raw byte counts and saves a fork
                // every monitor tick (default 30 s).
                const usage = await withTimeout(
                    DockerController.getInstance().getDiskUsage(),
                    STATS_TIMEOUT_MS,
                    'docker disk usage',
                );
                const totalReclaimableBytes =
                    usage.reclaimableImages +
                    usage.reclaimableContainers +
                    usage.reclaimableVolumes +
                    usage.reclaimableBuildCache;

                const reclaimGb = totalReclaimableBytes / (1024 * 1024 * 1024);
                const JANITOR_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
                // Sanity floor: never alert on near-empty hosts even if the user
                // configured an aggressive threshold like 0.001 GB. 100 MB is the
                // smallest waste worth interrupting an operator over.
                const MIN_RECLAIMABLE_GB = 0.1;

                if (reclaimGb >= janitorLimitGb && reclaimGb >= MIN_RECLAIMABLE_GB) {
                    const registry = NodeRegistry.getInstance();
                    const localNode = registry.getNode(registry.getDefaultNodeId());
                    const nodeLabel = localNode?.name ?? 'this node';
                    await this.dispatchWithCooldown(HOST_ALERT_KEYS.janitor, JANITOR_COOLDOWN_MS, 'info', 'system',
                        `Node "${nodeLabel}" has accumulated ${reclaimGb.toFixed(1)} GB of unused Docker data. Consider using the Janitor tool.`);
                }
            }
        } catch (e) {
            console.error('Error checking docker janitor limits', e);
        }

        // 4. Sencho version update check (runs once per VERSION_CHECK_INTERVAL_MS)
        await this.checkSenchoVersion();
    }

    /**
     * Check GitHub/Docker Hub for a newer Sencho release and dispatch a
     * one-shot notification. Uses getLatestVersion() which wraps CacheService
     * (30 min TTL + inflight dedup + stale-on-error) so transient network
     * blips do not cause gaps, and the check stays consistent with the Fleet
     * update banner.
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

        const latest = await getLatestVersion();
        if (!isValidVersion(latest)) {
            // Network failure (GitHub + Docker Hub both down, no stale cache).
            // Do NOT advance the cooldown so the next eval retries.
            if (isDebugEnabled()) console.debug('[Monitor:diag] Latest Sencho version unresolvable; will retry next cycle');
            return;
        }

        this.lastVersionCheckAt = Date.now();

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
            await notifier.dispatchAlert('info', 'system',
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
                for (const container of containers) {
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
                                    // Duration met! Check cooldown
                                    const timeSinceLastFired = Date.now() - (rule.last_fired_at || 0);
                                    const requiredCooldownMs = rule.cooldown_mins * 60 * 1000;

                                    if (timeSinceLastFired >= requiredCooldownMs) {
                                        // Formatted Alert Message
                                        const { name: metricName, unit } = getMetricDetails(rule.metric);
                                        const operatorPhrase = getOperatorPhrase(rule.operator);

                                        const safeCurrent = typeof currentValue === 'number' ? Number(currentValue.toFixed(2)) : currentValue;
                                        const safeThreshold = typeof rule.threshold === 'number' ? Number(rule.threshold.toFixed(2)) : rule.threshold;

                                        const message = `[Node: ${node.name}] The **${metricName}** for **${rule.stack_name}** ${operatorPhrase} **${safeThreshold}${unit}** (Currently: ${safeCurrent}${unit}).`;

                                        console.log(`[MonitorService] Alert fired: rule ${ruleId} on stack "${rule.stack_name}" — ${metricName} ${operatorPhrase} ${safeThreshold}${unit}`);
                                        await NotificationService.getInstance().dispatchAlert(
                                            'warning',
                                            'monitor_alert',
                                            message,
                                            { stackName: rule.stack_name },
                                        );

                                        // Update last fired
                                        db.updateStackAlertLastFired(ruleId, Date.now());
                                    } else if (isDebugEnabled()) {
                                        console.log(`[Monitor:diag] Cooldown active for rule ${ruleId}: ${Math.round((requiredCooldownMs - timeSinceLastFired) / 1000)}s remaining`);
                                    }
                                }
                            } else {
                                // Rule isn't breaching anymore, reset tracker
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
                            continue;
                        }
                        if (e instanceof TimeoutError) {
                            console.warn(`Stats timeout for container ${container.Id} on node ${node.name}`);
                            continue;
                        }
                        console.error(`Error parsing stats for container ${container.Id} on node ${node.name}`, e);
                    }
                }

                // Clean up stale network stats for containers on this node that no longer run
                if (this.previousNetworkStats.size > containers.length * 2) {
                    const currentIds = new Set(containers.map(c => c.Id));
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
            db.cleanupOldNotifications(isNaN(retentionDays) ? 30 : retentionDays);
            const auditRetentionDays = parseInt(settings['audit_retention_days'] || '90', 10);
            db.cleanupOldAuditLogs(isNaN(auditRetentionDays) ? 90 : auditRetentionDays);
            if (isDebugEnabled()) console.log(`[Monitor:diag] Cleanup: metrics ${isNaN(retentionHours) ? 24 : retentionHours}h, notifications ${isNaN(retentionDays) ? 30 : retentionDays}d, audit ${isNaN(auditRetentionDays) ? 90 : auditRetentionDays}d`);
        } catch (e) {
            console.error('MonitorService: failed to cleanup old data', e);
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
            await NotificationService.getInstance().dispatchAlert(severity, category, message, { stackName: stack });
            db.setSystemState(stateKey, Date.now().toString());
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
